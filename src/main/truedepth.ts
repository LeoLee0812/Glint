import { app, screen, type BrowserWindow } from 'electron'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeEvent, DisplayInfo, TdDeviceInfo, TdFrame, TdStatus } from '../shared/types'
import { onBridge, sendBridge, requestBridge } from './bridge'
import { displayMillimeters } from './displayWin'

// iPhone 原深感：原生助手收 UDP 数据报 → 这里验签名、配对、按 seq 丢乱序旧帧 → 推给渲染进程
// 配对：手机上显示 4 位码，Mac 上输入一次。码只用来算签名密钥，存在 userData/truedepth-devices.json（权限 600）
// 局限：4 位码挡得住局域网里别人的手机误连、随手伪造，挡不住有心人抓包后暴力试码（本来就是明文 UDP）

interface Paired {
  dev: string
  name: string
  code: string
  at: number
}

interface Seen {
  dev: string
  name: string
  model?: string
  /** 原生助手里这台手机对应的 UDP 流，回 ack 用 */
  ep: string
  lastAt: number
  lastFrameAt: number
  /** 最近一个验签通过的包（Date.now），换会话时用 */
  lastOkAt: number
  /** 最近一个包的原文，配对时拿用户输入的码来验 */
  lastRaw: { mac: string; json: string } | null
  sid: number
  lastSeq: number
  tracked: boolean
  therm?: number
  sendFps?: number
  badCode: boolean
  rxTimes: number[]
  /** 最近 3 秒收到的所有包的 seq，估丢包率 */
  seqWin: Array<{ at: number; seq: number }>
}

type Reason = 'source' | 'pairing'
type Send = (channel: string, payload: unknown) => void

const PAIR_FILE = 'truedepth-devices.json'
/** 旧会话多久没动静才允许换新会话（手机 App 重启后 sid 会变） */
const SESSION_IDLE_MS = 1500

let sendToRenderer: Send = () => undefined
const paired = new Map<string, Paired>()
const seen = new Map<string, Seen>()
const reasons = new Set<Reason>()
let listening = false
let listenPort = 0
let listenName = ''
let listenError: string | undefined
let active: string | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null
let statusDirty = false
/** 回包带 Mac 这次启动的会话号和递增序号：手机按它丢掉乱序到达的旧 ack */
const ackSid = Math.floor(Math.random() * 2_000_000_000) + 1
let ackSeq = 0

function pairFile(): string {
  return join(app.getPath('userData'), PAIR_FILE)
}

function loadPaired(): void {
  paired.clear()
  try {
    if (!existsSync(pairFile())) return
    const list = JSON.parse(readFileSync(pairFile(), 'utf8')) as Paired[]
    for (const p of list) if (p?.dev && /^\d{4}$/.test(p.code)) paired.set(p.dev, p)
  } catch (e) {
    console.warn('[td] 读配对列表失败', e)
  }
}

function savePaired(): void {
  try {
    writeFileSync(pairFile(), JSON.stringify([...paired.values()], null, 2), 'utf8')
    chmodSync(pairFile(), 0o600)
  } catch (e) {
    console.warn('[td] 存配对列表失败', e)
  }
}

/** 签名密钥 = SHA256("lookask-td|设备ID|配对码") */
export function tdKey(dev: string, code: string): Buffer {
  return createHash('sha256').update(`lookask-td|${dev}|${code}`, 'utf8').digest()
}

/** 数据报签名 = HMAC-SHA256(密钥, JSON 原文) 前 16 字节的十六进制 */
export function tdSign(key: Buffer, json: string): string {
  return createHmac('sha256', key).update(json, 'utf8').digest().subarray(0, 16).toString('hex')
}

function verify(key: Buffer, json: string, mac: string): boolean {
  const want = Buffer.from(tdSign(key, json), 'hex')
  const got = Buffer.from(mac, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

function macName(): string {
  return listenName || 'Mac'
}

function reply(s: Seen, state: 'paired' | 'need_pair'): void {
  const fps = s.rxTimes.filter((t) => Date.now() - t < 1000).length
  const ack = { t: 'ack', v: 1, sid: ackSid, seq: ++ackSeq, state, mac: macName(), fps, use: reasons.has('source') }
  sendBridge({ cmd: 'td_send', ep: s.ep, d: JSON.stringify(ack) })
}

function markStatus(): void {
  statusDirty = true
}

function onPacket(ep: string, d: string): void {
  const m = /^([0-9a-f]{32})(\{[\s\S]*\})$/.exec(d)
  if (!m) return
  let msg: any
  try {
    msg = JSON.parse(m[2])
  } catch {
    return
  }
  const dev = typeof msg?.dev === 'string' ? msg.dev : ''
  if (!dev || dev.length > 64) return
  const now = Date.now()
  let s = seen.get(dev)
  if (!s) {
    s = {
      dev,
      name: 'iPhone',
      ep,
      lastAt: now,
      lastFrameAt: 0,
      lastOkAt: 0,
      lastRaw: null,
      sid: 0,
      lastSeq: -1,
      tracked: false,
      badCode: false,
      rxTimes: [],
      seqWin: []
    }
    seen.set(dev, s)
    markStatus()
  }
  s.ep = ep
  s.lastAt = now
  s.lastRaw = { mac: m[1], json: m[2] }
  if (msg.t === 'hb') {
    if (typeof msg.name === 'string' && msg.name) s.name = msg.name.slice(0, 60)
    if (typeof msg.model === 'string') s.model = msg.model.slice(0, 40)
    if (typeof msg.therm === 'number') s.therm = msg.therm
    if (typeof msg.fps === 'number') s.sendFps = msg.fps
  }
  const p = paired.get(dev)
  const ok = !!p && verify(tdKey(dev, p.code), m[2], m[1])
  if (p && s.badCode !== !ok) {
    s.badCode = !ok
    markStatus()
  }
  if (!ok) {
    if (msg.t === 'hb') reply(s, 'need_pair')
    return
  }
  const sid = Number(msg.sid) || 0
  const seq = Number(msg.seq)
  if (!Number.isFinite(seq)) return
  if (sid !== s.sid) {
    // 同一台手机冒出新会话：旧会话还在发的话多半是重放或者开了两个 App，丢掉
    if (s.sid && now - s.lastOkAt < SESSION_IDLE_MS) return
    s.sid = sid
    s.lastSeq = -1
    s.seqWin = []
  }
  s.lastOkAt = now
  s.seqWin.push({ at: now, seq })
  while (s.seqWin.length && now - s.seqWin[0].at > 3000) s.seqWin.shift()
  if (msg.t === 'hb') {
    reply(s, 'paired')
    return
  }
  if (msg.t !== 'f') return
  // UDP 可能乱序：比上一帧旧的直接丢，下一帧马上就来
  if (seq <= s.lastSeq) return
  s.lastSeq = seq
  if (s.tracked !== !!msg.tracked) markStatus()
  s.tracked = !!msg.tracked
  s.lastFrameAt = now
  s.rxTimes.push(now)
  while (s.rxTimes.length && now - s.rxTimes[0] > 1000) s.rxTimes.shift()
  // 同时有几台配过对的手机在发：用正在用的那台，它断了 1 秒再换
  if (active !== dev) {
    const a = active ? seen.get(active) : undefined
    if (!a || now - a.lastFrameAt > 1000) {
      active = dev
      markStatus()
    }
  }
  if (active === dev && reasons.has('source')) {
    const frame: TdFrame = { ...msg, rx: now }
    sendToRenderer('td:frame', frame)
  }
}

function lossOf(s: Seen): number {
  const w = s.seqWin
  if (w.length < 5) return 0
  let lo = Infinity
  let hi = -Infinity
  for (const x of w) {
    lo = Math.min(lo, x.seq)
    hi = Math.max(hi, x.seq)
  }
  const span = hi - lo + 1
  return span > 0 ? Math.max(0, Math.min(1, 1 - w.length / span)) : 0
}

export function tdStatus(): TdStatus {
  const now = Date.now()
  const devices: TdDeviceInfo[] = []
  for (const s of seen.values()) {
    // 1 分钟没动静的就不列了
    if (now - s.lastAt > 60_000) continue
    devices.push({
      dev: s.dev,
      name: paired.get(s.dev)?.name || s.name,
      model: s.model,
      paired: paired.has(s.dev) && !s.badCode,
      badCode: s.badCode || undefined,
      ago: now - s.lastAt,
      fps: s.rxTimes.filter((t) => now - t < 1000).length,
      loss: Math.round(lossOf(s) * 1000) / 1000,
      tracked: now - s.lastFrameAt < 1000 ? s.tracked : false,
      therm: s.therm,
      sendFps: s.sendFps
    })
  }
  return {
    listening,
    port: listenPort,
    name: listenName,
    error: listenError,
    active,
    devices,
    paired: [...paired.values()].map((p) => ({ dev: p.dev, name: p.name, at: p.at }))
  }
}

function pushStatus(): void {
  statusDirty = false
  sendToRenderer('td:status', tdStatus())
}

function startListening(): void {
  const port = Number(process.env.LOOKASK_TD_PORT) || undefined
  const name = process.env.LOOKASK_TD_NAME || undefined
  sendBridge({ cmd: 'td_start', port, name })
  if (!statusTimer) {
    statusTimer = setInterval(() => {
      // 在收数据时每秒推一次（帧率、丢包在变），平时只在有变化时推
      if (statusDirty || seen.size) pushStatus()
    }, 1000)
  }
}

function stopListening(): void {
  sendBridge({ cmd: 'td_stop' })
  listening = false
  if (statusTimer) {
    clearInterval(statusTimer)
    statusTimer = null
  }
  seen.clear()
  active = null
  pushStatus()
}

/** 渲染进程要不要收：选了原深感输入源（source），或者设置里正在配对（pairing） */
export function tdEnable(reason: Reason, on: boolean): TdStatus {
  const before = reasons.size > 0
  if (on) reasons.add(reason)
  else reasons.delete(reason)
  const after = reasons.size > 0
  if (!before && after) startListening()
  else if (before && !after) stopListening()
  return tdStatus()
}

export function tdPair(dev: string, code: string): { ok: boolean; error?: string; name?: string } {
  const c = String(code || '').trim()
  if (!/^\d{4}$/.test(c)) return { ok: false, error: '配对码是 4 位数字' }
  const s = seen.get(dev)
  if (!s?.lastRaw) return { ok: false, error: '还没收到这台手机的数据，看看 Glint Eye 开着没' }
  if (!verify(tdKey(dev, c), s.lastRaw.json, s.lastRaw.mac)) return { ok: false, error: '配对码不对，再看一眼手机' }
  paired.set(dev, { dev, name: s.name, code: c, at: Date.now() })
  savePaired()
  s.badCode = false
  s.sid = 0
  s.lastSeq = -1
  reply(s, 'paired')
  pushStatus()
  return { ok: true, name: s.name }
}

export function tdUnpair(dev: string): void {
  paired.delete(dev)
  savePaired()
  if (active === dev) active = null
  pushStatus()
}

/** 窗口所在显示器的物理尺寸：原深感的几何换算要知道「每米多少点」 */
export async function displayInfo(win: BrowserWindow | null): Promise<DisplayInfo> {
  const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay()
  const ptW = d.bounds.width
  const ptH = d.bounds.height
  if (process.platform === 'win32') {
    // Windows：主进程自己读 EDID（原生助手只管手柄）；拿不到就按 100% 缩放 = 96 点/英寸猜
    const mm = await displayMillimeters(d)
    if (mm) return { id: d.id, mmW: mm.w, mmH: mm.h, ptW, ptH, measured: true }
    return { id: d.id, mmW: (ptW * 25.4) / 96, mmH: (ptH * 25.4) / 96, ptW, ptH, measured: false }
  }
  const r = await requestBridge<{ w: number; h: number }>({ cmd: 'display_mm', display: d.id }, 2000)
  if (r && r.w > 50 && r.h > 30) return { id: d.id, mmW: r.w, mmH: r.h, ptW, ptH, measured: true }
  // 拿不到就按 Mac 常见密度猜（约 4.8 点/毫米）
  return { id: d.id, mmW: ptW / 4.8, mmH: ptH / 4.8, ptW, ptH, measured: false }
}

export function initTrueDepth(send: Send): void {
  sendToRenderer = send
  loadPaired()
  onBridge((e: BridgeEvent) => {
    if (e.t === 'td_pkt') onPacket(e.ep, e.d)
    else if (e.t === 'td_listen') {
      if (e.stopped) return
      listening = e.ok
      listenError = e.ok ? undefined : e.error
      if (e.ok) {
        listenPort = e.port ?? 0
        if (e.name) listenName = e.name
      }
      pushStatus()
    } else if (e.t === 'td_service') {
      listenName = e.name
      pushStatus()
    } else if (e.t === 'ready') {
      // 原生助手重启过：要收的话重新开监听
      if (reasons.size) startListening()
    } else if (e.t === 'bridge_exit') {
      listening = false
      pushStatus()
    }
  })
}
