import type { DisplayInfo, TdFrame, TdMount, TdStatus } from '../../../../shared/types'
import { la, toast, uiStore } from '../../appState'
import { deriveFrame, displayBasis, tdDistanceCm, tdExpr, tdHeadPos, unit, type M3, type V3 } from '../td/geometry'
import { planeOffset, pointsPerMeter } from '../td/mount'
import type { SourceHooks, TdLink } from '../types'

// 输入源二：iPhone 原深感。手机上的 LookAskEye 用 ARKit 人脸追踪拿头的三维位姿、双眼朝向、表情系数，
// UDP 发到 Mac（原生助手收、主进程验签配对），这里把每帧换成屏幕对齐坐标系里的特征交给引擎。
// 连接状态：等手机 → 待配对 → 收帧中；3 秒收不到帧算断开，恢复后自动续上

const LOST_MS = 3000

export interface TdSourceOpts {
  /** 校准模型发现左右反了：头位置显示也跟着翻 */
  mirrorX: () => boolean
  mount: () => TdMount
}

export class TrueDepthSource {
  running = false
  /** 最近一帧（调试 / 测试用） */
  lastFrame: TdFrame | null = null
  display: DisplayInfo | null = null
  status: TdStatus | null = null

  private offs: Array<() => void> = []
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0
  private everLive = false
  private link: TdLink = { state: 'waiting', device: '', mac: '', loss: 0, unpaired: [], distanceCm: null }
  private grav: V3 | null = null
  private basis: M3 | null = null
  private fpsN = 0
  private fpsT0 = performance.now()
  /** 手机时钟 → 本机 performance.now 的偏移（取最小延迟那一帧，网络抖动不带进平滑滤波） */
  private clockOffset: number | null = null
  private lastSid = 0
  private lastT = 0
  private toastedUnpaired = new Set<string>()
  private lostToast: string | null = null

  constructor(
    private hooks: SourceHooks,
    private opts: TdSourceOpts
  ) {}

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.everLive = false
    this.lastFrameAt = 0
    this.clockOffset = null
    this.link = { state: 'waiting', device: '', mac: '', loss: 0, unpaired: [], distanceCm: null }
    this.hooks.status({ state: 'loading', error: undefined, cameraLabel: 'iPhone 原深感', face: false, fps: 0, dark: false, link: { ...this.link } })
    this.offs.push(la.truedepth.onFrame((f) => this.onFrame(f)))
    this.offs.push(la.truedepth.onStatus((s) => this.onStatus(s)))
    this.watchdog = setInterval(() => this.tick(), 500)
    try {
      this.onStatus(await la.truedepth.enable('source', true))
      await this.refreshDisplay()
    } catch (e: any) {
      this.hooks.status({ state: 'error', error: e?.message || String(e) })
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    for (const off of this.offs) off()
    this.offs = []
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    la.truedepth.enable('source', false).catch(() => undefined)
    this.hooks.status({ state: 'off', face: false, fps: 0, link: null })
  }

  async refreshDisplay(): Promise<DisplayInfo | null> {
    try {
      this.display = await la.truedepth.display()
    } catch {
      /* 拿不到就用猜的 */
    }
    return this.display
  }

  /** 屏幕每米多少点（显示器物理尺寸算的） */
  pointsPerMeter(): number {
    return this.display ? pointsPerMeter(this.display) : 4800
  }

  planeOffset(): number {
    return planeOffset(this.opts.mount())
  }

  private setLink(p: Partial<TdLink>): void {
    this.link = { ...this.link, ...p }
    this.hooks.status({ link: { ...this.link } })
  }

  private onStatus(s: TdStatus): void {
    if (!this.running) return
    this.status = s
    const act = s.devices.find((d) => d.dev === s.active)
    const unpaired = s.devices.filter((d) => !d.paired).map((d) => ({ dev: d.dev, name: d.name, badCode: d.badCode }))
    const live = performance.now() - this.lastFrameAt < LOST_MS
    let state: TdLink['state']
    if (!s.listening && s.error) state = 'error'
    else if (live && this.everLive) state = 'live'
    else if (this.everLive) state = 'lost'
    else if (unpaired.length) state = 'unpaired'
    else state = 'waiting'
    this.setLink({
      state,
      device: act?.name || this.link.device,
      mac: s.name,
      msg: s.error,
      loss: act?.loss ?? 0,
      therm: act?.therm,
      unpaired
    })
    if (state === 'error') this.hooks.status({ state: 'error', error: `收不了 iPhone 数据：${s.error}` })
    // 新发现一台没配对的手机：提示去输配对码
    for (const u of unpaired) {
      if (this.toastedUnpaired.has(u.dev)) continue
      this.toastedUnpaired.add(u.dev)
      toast(u.badCode ? `「${u.name}」换过配对码，要重新输入` : `发现 iPhone「${u.name}」：输入手机上显示的 4 位配对码就能用`, 'info', {
        ttl: 9000,
        action: { label: '去配对', run: () => uiStore.patch({ showSettings: true, settingsTab: 'gaze' }) }
      })
    }
  }

  private onFrame(f: TdFrame): void {
    if (!this.running) return
    const now = performance.now()
    this.lastFrame = f
    this.lastFrameAt = now
    // 手机时间戳换成本机时间：偏移取「收到时间 − 手机时间」的最小值，慢慢放宽以跟上两边时钟漂移
    // 手机 App 重启（换会话）或者两边时间对不上了（断线很久）就重新对表
    const phoneMs = f.ts * 1000
    const off = now - phoneMs
    if (this.clockOffset == null || f.sid !== this.lastSid || Math.abs(off - this.clockOffset) > 500) this.clockOffset = off
    else this.clockOffset = off < this.clockOffset ? off : this.clockOffset + 0.02
    this.lastSid = f.sid
    let t = Math.min(now, phoneMs + this.clockOffset)
    if (t <= this.lastT) t = this.lastT + 0.1
    this.lastT = t

    if (!this.everLive || this.link.state !== 'live') {
      const wasLost = this.link.state === 'lost'
      this.everLive = true
      this.setLink({ state: 'live' })
      this.hooks.status({ state: 'running', error: undefined })
      if (this.lostToast) {
        this.lostToast = null
        if (wasLost) toast('iPhone 重新连上了', 'ok')
      }
    }
    this.fpsN++
    if (now - this.fpsT0 > 1000) {
      this.hooks.status({ fps: Math.round((this.fpsN * 1000) / (now - this.fpsT0)) })
      this.fpsN = 0
      this.fpsT0 = now
    }

    // 「上」来自重力，慢慢平滑（手机不动的话它就是定的）
    if (f.head && f.grav) {
      const g = f.grav as V3
      this.grav = this.grav ? unit([this.grav[0] * 0.95 + g[0] * 0.05, this.grav[1] * 0.95 + g[1] * 0.05, this.grav[2] * 0.95 + g[2] * 0.05]) : unit(g)
    }
    if (f.head) this.basis = displayBasis(this.grav, f.head.pos as V3)
    const d = this.basis ? deriveFrame(f, this.basis) : null
    if (!d) {
      this.hooks.frame({ t, features: null, face: false, blink: 0, headZ: null, faceBox: null, pose: null, expr: null })
      return
    }
    const mirror = this.opts.mirrorX()
    const dist = tdDistanceCm(d)
    if (this.link.distanceCm == null || Math.abs(dist - this.link.distanceCm) > 1) this.setLink({ distanceCm: Math.round(dist) })
    this.hooks.frame({
      t,
      features: d.features,
      face: true,
      blink: d.blink,
      headZ: dist / 100,
      faceBox: null,
      pose: tdHeadPos(d, mirror),
      expr: tdExpr(d, mirror)
    })
  }

  /** 看门狗：3 秒没帧 = 断开；断开期间也给引擎发「没有脸」，让视线圈和小人停下来 */
  private tick(): void {
    if (!this.running || !this.everLive) return
    const now = performance.now()
    if (now - this.lastFrameAt < LOST_MS) return
    if (this.link.state !== 'lost') {
      this.setLink({ state: 'lost', distanceCm: null })
      this.hooks.status({ state: 'error', error: 'iPhone 已断开', face: false, fps: 0 })
      this.lostToast = toast('iPhone 已断开：看看手机上的 LookAskEye 还开着吗、Wi‑Fi 还连着吗', 'warn', { ttl: 8000 })
    }
    this.lastT = Math.max(this.lastT, now)
    this.hooks.frame({ t: now, features: null, face: false, blink: 0, headZ: null, faceBox: null, pose: null, expr: null })
  }
}
