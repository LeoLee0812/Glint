import * as HID from 'node-hid'
import { emit, logMsg } from './io'

// Joy-Con 原生读取（Windows）：node-hid（hidapi）直接读写蓝牙 HID 原始报告，逐段移植自 Mac 版 native/LookAskBridge/JoyCon.swift。
// 不用 Chromium 的 Gamepad API：它把单只 Joy-Con 当成横握小手柄，拿不到 R/ZR/摇杆按下，也没有模拟摇杆。
// 协议参考 dekuNukem/Nintendo_Switch_Reverse_Engineering：切到 0x30 全量模式后 Windows 上实测 15ms 一包。
// 输出（子命令、震动、灯）每只手柄走一个 15ms 节拍：Windows 的写是进驱动队列就返回（实测 0.2ms），
// 发得比蓝牙快就在驱动里越堆越多、震动越来越滞后，所以和 Mac 一样每拍最多发一包。
// Windows 默认时钟粒度 15.6ms，setInterval(15) 实测平均 20ms 一拍、一成多拖到 30ms（震动花样被拉长三成）；
// 改成 1ms 定时器（实际跟着系统时钟中断醒）+ 距上一包满 13ms 才发，实测平均 15.7ms 一拍。
// 0x30 报告里还带 6 轴 IMU（每包 3 组，约 200Hz）：用来判断手柄是不是放在桌上，以及「按住右摇杆拧手腕」精调焦点。
// Windows 没有设备插拔回调，每 1.5 秒枚举一次；读写出错也当断开处理。

const NINTENDO_VID = 0x057e
/** 一帧「不震」（振幅 0） */
const QUIET_FRAME = [0x00, 0x01, 0x40, 0x40]
/** 输出节拍（毫秒）：蓝牙每 ~15ms 一个空档，震动也按 15ms 一帧展开 */
const OUT_TICK = 15
/** 输出定时器多久醒一次（毫秒），和两包之间至少隔多久 */
const OUT_POLL = 1
const OUT_GAP = 13
/** 子命令之间至少隔 60ms，Joy-Con 连发太快会丢 */
const SUB_GAP = 60
/** IMU 两组样本之间的间隔（秒，200Hz） */
const IMU_DT = 0.005
/** 多久枚举一次设备（毫秒） */
const SCAN_EVERY = 1500

export type JoySide = 'L' | 'R' | 'P'

const SIDE_OF_PID: Record<number, JoySide> = { 0x2006: 'L', 0x2007: 'R', 0x2009: 'P' }
/** Windows 报的产品名一律是「Wireless Gamepad」，按 PID 起名，和 Mac 上系统给的名字一致 */
const NAME_OF_SIDE: Record<JoySide, string> = { L: 'Joy-Con (L)', R: 'Joy-Con (R)', P: 'Pro Controller' }

/** 单调时钟（毫秒） */
const uptime = (): number => performance.now()

/** Swift 的 .rounded()：四舍五入，.5 远离 0（Math.round 在负数上是往 +∞ 进） */
function roundAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x))
}

function s16(d: ArrayLike<number>, i: number): number {
  return ((d[i] | (d[i + 1] << 8)) << 16) >> 16
}

function sameFrame(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** 摇杆出厂校准：中心值与向两侧的最大行程（12 位原始值） */
export class StickCal {
  xCenter = 2048
  yCenter = 2048
  xMinBelow = 1400
  xMaxAbove = 1400
  yMinBelow = 1400
  yMaxAbove = 1400

  /** 左摇杆的 9 字节校准数据排列：上方最大值、中心、下方最小值 */
  static decodeLeft(d: number[]): StickCal | null {
    if (d.length < 9 || d.every((b) => b === 0xff)) return null
    const c = new StickCal()
    c.xMaxAbove = ((d[1] << 8) & 0xf00) | d[0]
    c.yMaxAbove = (d[2] << 4) | (d[1] >> 4)
    c.xCenter = ((d[4] << 8) & 0xf00) | d[3]
    c.yCenter = (d[5] << 4) | (d[4] >> 4)
    c.xMinBelow = ((d[7] << 8) & 0xf00) | d[6]
    c.yMinBelow = (d[8] << 4) | (d[7] >> 4)
    return c.isSane() ? c : null
  }

  /** 右摇杆的排列顺序不同：中心、下方最小值、上方最大值 */
  static decodeRight(d: number[]): StickCal | null {
    if (d.length < 9 || d.every((b) => b === 0xff)) return null
    const c = new StickCal()
    c.xCenter = ((d[1] << 8) & 0xf00) | d[0]
    c.yCenter = (d[2] << 4) | (d[1] >> 4)
    c.xMinBelow = ((d[4] << 8) & 0xf00) | d[3]
    c.yMinBelow = (d[5] << 4) | (d[4] >> 4)
    c.xMaxAbove = ((d[7] << 8) & 0xf00) | d[6]
    c.yMaxAbove = (d[8] << 4) | (d[7] >> 4)
    return c.isSane() ? c : null
  }

  private isSane(): boolean {
    return (
      this.xCenter > 1000 && this.xCenter < 3100 && this.yCenter > 1000 && this.yCenter < 3100 &&
      this.xMinBelow > 300 && this.xMaxAbove > 300 && this.yMinBelow > 300 && this.yMaxAbove > 300
    )
  }

  /** 原始值 → [-1, 1]，上/右为正，带死区（Joy-Con 摇杆漂移很常见） */
  normalize(rawX: number, rawY: number, deadzone = 0.14): [number, number] {
    const dx = rawX - this.xCenter
    const dy = rawY - this.yCenter
    let x = dx >= 0 ? dx / this.xMaxAbove : dx / this.xMinBelow
    let y = dy >= 0 ? dy / this.yMaxAbove : dy / this.yMinBelow
    x = Math.max(-1, Math.min(1, x))
    y = Math.max(-1, Math.min(1, y))
    const mag = Math.hypot(x, y)
    if (mag < deadzone) return [0, 0]
    // 死区外重新拉伸到 0~1，推一点点也有细腻的起步
    const scale = Math.min(1, (mag - deadzone) / (1 - deadzone)) / mag
    return [x * scale, y * scale]
  }
}

/**
 * IMU 校准：SPI 0x6020 出厂 24 字节（加速度零点 / 灵敏度、陀螺零点 / 灵敏度，各 3 个 int16）；
 * 0x8026 是用户校准，魔数 B2 A1 之后只覆盖两个零点（和 SDL 的做法一致）
 */
export class ImuCal {
  accOrigin = [0, 0, 0]
  accSens = [16384, 16384, 16384]
  gyroOrigin = [0, 0, 0]
  gyroSens = [13371, 13371, 13371]

  static decode(d: number[]): ImuCal | null {
    if (d.length < 24 || d.every((b) => b === 0xff)) return null
    const c = new ImuCal()
    c.accOrigin = [s16(d, 0), s16(d, 2), s16(d, 4)]
    c.accSens = [s16(d, 6), s16(d, 8), s16(d, 10)]
    c.gyroOrigin = [s16(d, 12), s16(d, 14), s16(d, 16)]
    c.gyroSens = [s16(d, 18), s16(d, 20), s16(d, 22)]
    return c.isSane() ? c : null
  }

  applyUser(d: number[]): void {
    if (d.length < 18) return
    this.accOrigin = [s16(d, 0), s16(d, 2), s16(d, 4)]
    this.gyroOrigin = [s16(d, 12), s16(d, 14), s16(d, 16)]
  }

  private isSane(): boolean {
    return [0, 1, 2].every((i) => this.gyroSens[i] - this.gyroOrigin[i] > 4000 && this.accSens[i] - this.accOrigin[i] > 4000)
  }

  /** 陀螺原始值 → 度/秒：936 / (灵敏度 − 零点)（SDL 同款） */
  gyroScale(i: number): number {
    return 936 / (this.gyroSens[i] - this.gyroOrigin[i])
  }

  /** 加速度原始值 → g：4 / (灵敏度 − 零点) */
  accScale(i: number): number {
    return 4 / (this.accSens[i] - this.accOrigin[i])
  }
}

/** HD 震动编码，移植自 tomayac/joy-con-webhid（经 Swift 版转手，取整规则跟 Swift 一致）；振幅夹在 0~1（再大伤马达） */
export function encodeRumble(lowFreq: number, highFreq: number, amplitude: number): number[] {
  const lf0 = Math.min(Math.max(lowFreq, 40.875885), 626.286133)
  const hf0 = Math.min(Math.max(highFreq, 81.75177), 1252.572266)
  const hf = (roundAway(32 * Math.log2(hf0 * 0.1)) - 0x60) * 4
  const lf = roundAway(32 * Math.log2(lf0 * 0.1)) - 0x40
  const amp = Math.min(Math.max(amplitude, 0), 1)
  let hfAmp: number
  if (amp === 0) hfAmp = 0
  else if (amp < 0.117) hfAmp = (Math.log2(amp * 1000) * 32 - 0x60) / (5 - amp * amp) - 1
  else if (amp < 0.23) hfAmp = Math.log2(amp * 1000) * 32 - 0x60 - 0x5c
  else hfAmp = (Math.log2(amp * 1000) * 32 - 0x60) * 2 - 0xf6
  const hfAmpI = roundAway(hfAmp)
  let lfAmp = Math.trunc(hfAmpI * 0.5)
  const parity = lfAmp % 2
  if (parity > 0) lfAmp -= 1
  lfAmp = lfAmp >> 1
  lfAmp += 0x40
  if (parity > 0) lfAmp |= 0x8000
  return [hf & 0xff, (hfAmpI + ((hf >> 8) & 0xff)) & 0xff, (lf + ((lfAmp >> 8) & 0xff)) & 0xff, lfAmp & 0xff]
}

/**
 * 震动分段展开成 15ms 一帧。每段 [毫秒, 低频, 高频, 振幅, 结束低频?, 结束高频?, 结束振幅?]：
 * 频率按对数插值（听感上均匀的上扬 / 下沉），振幅线性插值；振幅 0 = 停顿。最长 12 秒
 */
export function rumbleFrames(segs: number[][]): number[][] {
  const out: number[][] = []
  for (const s of segs) {
    if (s.length < 4) continue
    const n = Math.max(1, roundAway(s[0] / OUT_TICK))
    const lo2 = s.length > 4 ? s[4] : s[1]
    const hi2 = s.length > 5 ? s[5] : s[2]
    const amp2 = s.length > 6 ? s[6] : s[3]
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0
      const amp = s[3] + (amp2 - s[3]) * t
      if (amp <= 0.001 || s[1] <= 0 || s[2] <= 0 || lo2 <= 0 || hi2 <= 0) {
        out.push(QUIET_FRAME)
        continue
      }
      out.push(encodeRumble(s[1] * Math.pow(lo2 / s[1], t), s[2] * Math.pow(hi2 / s[2], t), amp))
    }
    if (out.length >= 800) break
  }
  return out.slice(0, 800)
}

/** HOME 键那圈灯（子命令 0x38）：[mini cycle 数 | 全局时长, 起始亮度 | 循环次数(0 = 一直), 各 mini cycle 亮度, 渐变 | 保持倍数…] */
export function homePattern(mode: string): number[] {
  switch (mode) {
    case 'breathe':
      // 亮度 C ↔ 1 来回，渐变 ×4、保持 ×1 / ×2，一个来回约 2 秒
      return [0x2f, 0x10, 0xc1, 0x41, 0x42]
    case 'blink':
      // 快闪：全亮 ↔ 全灭
      return [0x28, 0xf0, 0xf0, 0x01, 0x01]
    case 'on':
      return [0x01, 0xf0, 0xf0, 0x00]
    default:
      // 关（同 SDL 亮度 0）
      return [0x01, 0x00, 0x00, 0x00]
  }
}

function spiRead(addr: number, len: number): number[] {
  return [addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, (addr >>> 24) & 0xff, len]
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const round4 = (v: number): number => Math.round(v * 10000) / 10000

export class JoyConDevice {
  private packet = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastReport = uptime()
  private closed = false
  /** 还没写完的包数：上一包没写完这一拍就让出去，不往驱动里堆 */
  private inflight = 0

  // 输出：子命令队列和震动帧队列共用一个 15ms 节拍，每拍最多发一包
  private commandQueue: Array<[number, number[]]> = []
  private frames: number[][] = []
  private framesPrio = 0
  private rumbling = false
  private lastSubAt = -Infinity
  private lastSendAt = -Infinity
  private outTimer: ReturnType<typeof setInterval> | null = null
  private homeMode = 'off'

  private leftCal = new StickCal()
  private rightCal = new StickCal()

  // IMU：校准、陀螺零偏（静止时自动学）、低通后的重力方向、放下检测、手腕精调推流
  private imuCal = new ImuCal()
  private gyroBias = [0, 0, 0]
  private biasLearned = false
  private biasSum = [0, 0, 0]
  private biasN = 0
  private grav: number[] | null = null
  private motion = 0
  private stillSince: number | null = null
  private imuRetryAt = uptime()
  resting = false
  private streamUntil = 0

  buttons = 0
  private lx = 0
  private ly = 0
  private rx = 0
  private ry = 0
  private battery = -1
  private charging = false

  private sentButtons = -1
  private sentSticks = [0, 0, 0, 0]
  private sentBattery = -2

  constructor(
    private readonly dev: HID.HIDAsync,
    readonly side: JoySide,
    readonly id: string,
    readonly name: string,
    readonly playerIndex: number,
    /** 读写出错（多半是蓝牙断了）：交给管理器摘掉 */
    private readonly onFail: (why: string) => void
  ) {}

  start(): void {
    this.dev.on('data', (b: Buffer) => this.handleReport(b))
    this.dev.on('error', (e: unknown) => this.fail(`读取出错：${(e as Error)?.message || e}`))
    this.initialize()
    // 看门狗：3 秒没收到全量报告就重发初始化（手柄休眠唤醒后会回到简单模式）
    this.watchdog = setInterval(() => {
      if (uptime() - this.lastReport > 3000) this.initialize()
    }, 3000)
  }

  private initialize(): void {
    this.enqueue(0x03, [0x30]) // 输入报告切到 0x30 全量模式
    this.enqueue(0x10, spiRead(0x603d, 0x12)) // 读出厂摇杆校准（左 9 字节 + 右 9 字节连续存放）
    this.enqueue(0x10, spiRead(0x8010, 0x16)) // 读用户校准（有魔数才生效）
    this.enqueue(0x30, [1 << (this.playerIndex % 4)]) // 点亮玩家灯，告诉用户已被 Glint 接管
    this.enqueue(0x48, [0x01]) // 允许震动
    this.enqueue(0x40, [0x01]) // 开 IMU（6 轴）
    this.enqueue(0x10, spiRead(0x6020, 0x18)) // IMU 出厂校准
    this.enqueue(0x10, spiRead(0x8026, 0x1a)) // IMU 用户校准（B2 A1 魔数）
    // HOME 灯：休眠重连后会被重置；刚启动时顺手关掉上次异常退出留下的呼吸灯
    if (this.side !== 'L') this.enqueue(0x38, homePattern(this.homeMode))
  }

  // ---------- 输出：15ms 节拍 ----------

  private enqueue(sub: number, args: number[]): void {
    this.commandQueue.push([sub, args])
    this.startOut()
  }

  private startOut(): void {
    if (this.outTimer || this.closed) return
    this.outTimer = setInterval(() => this.outStep(), OUT_POLL)
    setImmediate(() => this.outStep())
  }

  private stopOut(): void {
    if (this.outTimer) clearInterval(this.outTimer)
    this.outTimer = null
  }

  /** 每拍最多一包：有到点的子命令就发 0x01（顺带这一格的震动），否则只发震动 0x10；震完补一个停止帧 */
  private outStep(): void {
    if (this.closed || this.inflight > 0) return
    const now = uptime()
    // 距上一包不满一拍就等下一次醒
    if (now - this.lastSendAt < OUT_GAP) return
    let four: number[] | null = null
    if (this.frames.length) {
      const f = this.frames.shift()!
      four = f
      this.rumbling = !sameFrame(f, QUIET_FRAME)
      if (!this.frames.length) this.framesPrio = 0
    } else if (this.rumbling) {
      four = QUIET_FRAME
      this.rumbling = false
    }
    if (this.commandQueue.length && now - this.lastSubAt >= SUB_GAP) {
      const [sub, args] = this.commandQueue.shift()!
      this.write(this.subcommandReport(sub, args, four ?? QUIET_FRAME))
      this.lastSubAt = now
      this.lastSendAt = now
    } else if (four) {
      this.write(this.rumbleReport(four))
      this.lastSendAt = now
    }
    if (!this.frames.length && !this.rumbling && !this.commandQueue.length) this.stopOut()
  }

  private nextPacket(): number {
    const p = this.packet & 0x0f
    this.packet = (this.packet + 1) & 0xff
    return p
  }

  /** 0x01 子命令报告：49 字节（hidapi 在 Windows 上会补齐到手柄声明的输出报告长度） */
  private subcommandReport(sub: number, args: number[], four: number[]): number[] {
    const r = new Array<number>(49).fill(0)
    r[0] = 0x01
    r[1] = this.nextPacket()
    for (let i = 0; i < 4; i++) {
      r[2 + i] = four[i]
      r[6 + i] = four[i]
    }
    r[10] = sub
    args.forEach((a, i) => {
      if (11 + i < r.length) r[11 + i] = a & 0xff
    })
    return r
  }

  /** 0x10 只震动报告 */
  private rumbleReport(four: number[]): number[] {
    const r = new Array<number>(10).fill(0)
    r[0] = 0x10
    r[1] = this.nextPacket()
    for (let i = 0; i < 4; i++) {
      r[2 + i] = four[i]
      r[6 + i] = four[i]
    }
    return r
  }

  private write(report: number[]): void {
    this.inflight++
    this.dev
      .write(report)
      .catch((e: unknown) => this.fail(`写入出错：${(e as Error)?.message || e}`))
      .finally(() => {
        this.inflight--
      })
  }

  /** 播一段震动帧：正在播更重要的（优先级更高）就不打断；放在桌上时除非 force 否则不震（硬桌面一震嗡嗡响） */
  play(seq: number[][], prio: number, force = false): void {
    if (!seq.length || (!force && this.resting)) return
    if (this.frames.length && prio < this.framesPrio) return
    this.frames = seq.slice()
    this.framesPrio = prio
    this.startOut()
  }

  /** 老接口：单一频率震 ms 毫秒（长震动每拍续帧，不会中途停） */
  rumble(lowFreq = 160, highFreq = 320, amplitude = 0.5, ms = 80): void {
    this.play(rumbleFrames([[ms, lowFreq, highFreq, amplitude]]), 1)
  }

  setLights(mask: number): void {
    this.enqueue(0x30, [mask])
  }

  /** HOME 键那圈灯（只有右手柄 / Pro 手柄有）：breathe 呼吸、blink 快闪、on 常亮、off 关 */
  setHome(mode: string): void {
    if (this.side === 'L') return
    this.homeMode = mode
    this.enqueue(0x38, homePattern(mode))
  }

  /** 找手柄：高频大振幅「哔哔」响几秒（放在桌上也响），玩家灯和 HOME 灯一起闪，结束后恢复原样 */
  locate(seconds: number): void {
    const beeps = Math.max(1, Math.min(30, roundAway(seconds / 0.3)))
    const segs: number[][] = []
    for (let i = 0; i < beeps; i++) {
      segs.push([180, 600, 1200, 1.0])
      segs.push([120, 0, 0, 0])
    }
    this.play(rumbleFrames(segs), 9, true)
    this.enqueue(0x30, [0xf0])
    if (this.side !== 'L') this.enqueue(0x38, homePattern('blink'))
    setTimeout(() => {
      if (this.closed) return
      this.enqueue(0x30, [1 << (this.playerIndex % 4)])
      if (this.side !== 'L') this.enqueue(0x38, homePattern(this.homeMode))
    }, beeps * 300 + 100)
  }

  /** 手腕精调：接下来 seconds 秒内每个 0x30 包推一次角度增量（joy_gyro）；0 = 停 */
  stream(seconds: number): void {
    this.streamUntil = seconds > 0 ? uptime() + seconds * 1000 : 0
  }

  /** 退出前收尾：停震动、关 HOME 灯（不然会一直呼吸到手柄休眠）；等这一包真写出去 */
  async shutdown(): Promise<void> {
    this.stopOut()
    this.frames = []
    this.commandQueue = []
    if (this.closed) return
    try {
      if (this.side !== 'L') await this.dev.write(this.subcommandReport(0x38, homePattern('off'), QUIET_FRAME))
      else await this.dev.write(this.rumbleReport(QUIET_FRAME))
    } catch {
      /* 已经断了 */
    }
  }

  /** 摘掉这只手柄：停节拍、停看门狗、关句柄 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopOut()
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.dev.close().catch(() => undefined)
  }

  private fail(why: string): void {
    if (this.closed) return
    this.onFail(why)
  }

  // ---------- 输入 ----------

  private handleReport(r: Buffer): void {
    const n = r.length
    switch (r[0]) {
      case 0x30:
      case 0x21:
        if (n < 13) return
        this.lastReport = uptime()
        this.parseStandard(r)
        if (r[0] === 0x30 && n >= 49) this.parseIMU(r)
        if (r[0] === 0x21 && n >= 20) this.parseSubcommandReply(r, n)
        this.publishIfChanged()
        break
      case 0x3f:
        // 简单模式说明手柄刚醒或被别的程序重置了，重新切回全量模式
        this.enqueue(0x03, [0x30])
        break
      default:
        break
    }
  }

  private parseStandard(r: Buffer): void {
    const batt = r[2] >> 4
    this.battery = (batt >> 1) & 0x07 // 0~4 档
    this.charging = (batt & 0x01) === 1
    this.buttons = r[3] | (r[4] << 8) | (r[5] << 16)
    const lxRaw = r[6] | ((r[7] & 0x0f) << 8)
    const lyRaw = (r[7] >> 4) | (r[8] << 4)
    const rxRaw = r[9] | ((r[10] & 0x0f) << 8)
    const ryRaw = (r[10] >> 4) | (r[11] << 4)
    if (this.side !== 'R') [this.lx, this.ly] = this.leftCal.normalize(lxRaw, lyRaw)
    if (this.side !== 'L') [this.rx, this.ry] = this.rightCal.normalize(rxRaw, ryRaw)
  }

  /** Joy-Con 原始轴 → 竖握标准坐标（同 SDL 竖握模式：X 朝右、Y 朝上（按键面）、Z 朝自己）；右手柄芯片装反了，要多翻两个轴 */
  private toStd(v: number[]): number[] {
    return this.side === 'R' ? [v[1], -v[2], -v[0]] : [-v[1], v[2], -v[0]]
  }

  /** 0x30 报告 13~48 字节：3 组 [加速度 xyz, 陀螺 xyz]（int16 小端，约 5ms 一组） */
  private parseIMU(r: Buffer): void {
    const gSum = [0, 0, 0]
    const aSum = [0, 0, 0]
    const rawSum = [0, 0, 0]
    let yaw = 0
    let pitch = 0
    let count = 0
    for (let k = 0; k < 3; k++) {
      const o = 13 + 12 * k
      const rawA = [s16(r, o), s16(r, o + 2), s16(r, o + 4)]
      if (rawA[0] === 0 && rawA[1] === 0 && rawA[2] === 0) continue
      const rawG = [s16(r, o + 6), s16(r, o + 8), s16(r, o + 10)]
      count++
      const acc = this.toStd([0, 1, 2].map((i) => rawA[i] * this.imuCal.accScale(i)))
      const gyr = this.toStd([0, 1, 2].map((i) => (rawG[i] - this.gyroBias[i]) * this.imuCal.gyroScale(i)))
      for (let i = 0; i < 3; i++) {
        gSum[i] += gyr[i]
        aSum[i] += acc[i]
        rawSum[i] += rawG[i]
      }
      // 重力方向低通（时间常数约 0.12 秒）：手在动时加速度计里会混进线加速度
      const g = this.grav ?? acc.slice()
      for (let i = 0; i < 3; i++) g[i] += (acc[i] - g[i]) * 0.04
      this.grav = g
      const gn = Math.hypot(g[0], g[1], g[2])
      if (gn <= 0.3) continue
      // 「玩家空间」陀螺（Jibb Smart 的做法）：左右 = 绕真实的竖直方向转，怎么握都一样；上下 = 绕手柄自己的横轴点头
      const world = (gyr[1] * g[1] + gyr[2] * g[2]) / gn
      const yz = Math.hypot(gyr[1], gyr[2])
      const ccw = (world < 0 ? -1 : 1) * Math.min(Math.abs(world) * 1.41, yz)
      yaw -= ccw * IMU_DT // 逆时针 = 往左转；取反后往右为正
      pitch += gyr[0] * IMU_DT // 手柄头抬起为正
    }
    const now = uptime()
    if (count === 0) {
      // IMU 被关了（手柄休眠唤醒 / 别的程序重置）：隔 2 秒重开一次
      if (now - this.imuRetryAt > 2000) {
        this.imuRetryAt = now
        this.enqueue(0x40, [0x01])
      }
      return
    }
    this.imuRetryAt = now
    const w = Math.hypot(gSum[0], gSum[1], gSum[2]) / count
    const a = Math.hypot(aSum[0], aSum[1], aSum[2]) / count
    this.motion += (w - this.motion) * 0.25
    this.updateRest(now, this.motion < 1.5 && Math.abs(a - 1) < 0.06, this.motion > 5 || Math.abs(a - 1) > 0.15, rawSum, count)
    if (now < this.streamUntil) {
      emit({ t: 'joy_gyro', side: this.side, id: this.id, yaw: round4(yaw), pitch: round4(pitch) })
    }
  }

  /** 放下 / 拿起：几乎不转、只受重力，连续 3 秒 = 放在桌上（握在手里总有抖动和慢漂）；一动或一按键 = 拿起来了 */
  private updateRest(now: number, calm: boolean, woke: boolean, rawSum: number[], count: number): void {
    if (!calm) {
      this.stillSince = null
      this.biasSum = [0, 0, 0]
      this.biasN = 0
      if (this.resting && woke) this.setResting(false)
      return
    }
    const since = this.stillSince ?? now
    this.stillSince = since
    const still = now - since
    // 稳稳不动 2 秒以上才学陀螺零偏（手里的慢漂不能当零偏）
    if (still >= 2000) {
      for (let i = 0; i < 3; i++) this.biasSum[i] += rawSum[i]
      this.biasN += count
      if (this.biasN >= 200) {
        for (let i = 0; i < 3; i++) this.gyroBias[i] = this.gyroBias[i] * 0.5 + (this.biasSum[i] / this.biasN) * 0.5
        this.biasSum = [0, 0, 0]
        this.biasN = 0
        this.biasLearned = true
      }
    }
    if (!this.resting && still >= 3000) this.setResting(true)
  }

  private setResting(v: boolean): void {
    if (this.resting === v) return
    this.resting = v
    emit({ t: 'joy_motion', side: this.side, id: this.id, resting: v })
  }

  /** 按键 / 摇杆有动静 = 手柄在手里 */
  private noteActivity(): void {
    this.stillSince = null
    if (this.resting) this.setResting(false)
  }

  private parseSubcommandReply(r: Buffer, n: number): void {
    const subID = r[14]
    if (subID !== 0x10 || n < 20) return
    const addr = (r[15] | (r[16] << 8) | (r[17] << 16) | (r[18] << 24)) >>> 0
    const size = r[19]
    if (20 + size > n) return
    const data = Array.from(r.subarray(20, 20 + size))
    if (addr === 0x603d && size >= 18) {
      const l = StickCal.decodeLeft(data.slice(0, 9))
      if (l) this.leftCal = l
      const rc = StickCal.decodeRight(data.slice(9, 18))
      if (rc) this.rightCal = rc
    } else if (addr === 0x8010 && size >= 22) {
      // 用户校准：0x8010 处魔数 B2 A1 表示左摇杆有用户校准，0x801B 处表示右摇杆
      if (data[0] === 0xb2 && data[1] === 0xa1) {
        const l = StickCal.decodeLeft(data.slice(2, 11))
        if (l) this.leftCal = l
      }
      if (data[11] === 0xb2 && data[12] === 0xa1) {
        const rc = StickCal.decodeRight(data.slice(13, 22))
        if (rc) this.rightCal = rc
      }
    } else if (addr === 0x6020 && size >= 24) {
      const c = ImuCal.decode(data)
      if (c) {
        this.imuCal = c
        if (!this.biasLearned) this.gyroBias = c.gyroOrigin.slice()
      }
    } else if (addr === 0x8026 && size >= 26 && data[0] === 0xb2 && data[1] === 0xa1) {
      this.imuCal.applyUser(data.slice(2, 26))
      if (!this.biasLearned) this.gyroBias = this.imuCal.gyroOrigin.slice()
    }
  }

  private publishIfChanged(): void {
    const sticks = [this.lx, this.ly, this.rx, this.ry]
    const sent = this.sentSticks
    const moved = sticks.some((v, i) => Math.abs(v - sent[i]) > 0.02)
    // 摇杆回中必须发出去，否则前端会以为还在推
    const returnedToCenter =
      (sticks[0] === 0 && sticks[1] === 0 && (sent[0] !== 0 || sent[1] !== 0)) ||
      (sticks[2] === 0 && sticks[3] === 0 && (sent[2] !== 0 || sent[3] !== 0))
    const input = this.buttons !== this.sentButtons || moved || returnedToCenter
    if (!input && this.battery === this.sentBattery) return
    if (input) this.noteActivity()
    this.sentButtons = this.buttons
    this.sentSticks = sticks
    this.sentBattery = this.battery
    emit({
      t: 'joy',
      side: this.side,
      id: this.id,
      b: this.buttons,
      lx: round3(this.lx),
      ly: round3(this.ly),
      rx: round3(this.rx),
      ry: round3(this.ry),
      bat: this.battery,
      chg: this.charging
    })
  }
}

export class JoyConManager {
  private devices = new Map<string, JoyConDevice>()
  private opening = new Set<string>()
  /** 刚出过错 / 刚断开的设备，这个时间点之前不重连，免得坏句柄反复连上又断 */
  private cooldown = new Map<string, number>()
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private scanning = false
  private ignored = new Set<number>()

  start(): void {
    void this.scan()
    this.scanTimer = setInterval(() => void this.scan(), SCAN_EVERY)
  }

  /** 枚举一遍：新出现的接上，不见了的摘掉（Windows 没有插拔回调，蓝牙断开后设备就从枚举里消失） */
  private async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const list = await HID.devicesAsync()
      const present = new Set<string>()
      for (const d of list) {
        if (d.vendorId !== NINTENDO_VID || !d.path) continue
        const side = SIDE_OF_PID[d.productId]
        if (!side) {
          if (!this.ignored.has(d.productId)) {
            this.ignored.add(d.productId)
            logMsg(`忽略未知任天堂设备 pid=0x${d.productId.toString(16)} ${d.product || ''}`)
          }
          continue
        }
        // 只要游戏手柄那个集合（Usage Page 1 / Usage 5）
        if (d.usagePage !== undefined && d.usagePage !== 1) continue
        const id = d.serialNumber || d.path
        present.add(id)
        if (this.devices.has(id) || this.opening.has(id)) continue
        if ((this.cooldown.get(id) ?? 0) > uptime()) continue
        void this.attach(d.path, side, id)
      }
      for (const id of [...this.devices.keys()]) if (!present.has(id)) this.detach(id, '蓝牙断开了')
    } catch (e) {
      logMsg(`枚举 HID 设备失败：${(e as Error)?.message || e}`)
    } finally {
      this.scanning = false
    }
  }

  private async attach(path: string, side: JoySide, id: string): Promise<void> {
    this.opening.add(id)
    const name = NAME_OF_SIDE[side]
    try {
      const dev = await HID.HIDAsync.open(path)
      const player = side === 'R' ? 1 : 0
      const joy = new JoyConDevice(dev, side, id, name, player, (why) => this.detach(id, why))
      this.devices.set(id, joy)
      joy.start()
      emit({ t: 'joy_conn', side, id, name, connected: true })
    } catch (e) {
      logMsg(`打开 ${name} 失败：${(e as Error)?.message || e}`)
      this.cooldown.set(id, uptime() + 5000)
    } finally {
      this.opening.delete(id)
    }
  }

  private detach(id: string, why: string): void {
    const joy = this.devices.get(id)
    if (!joy) return
    this.devices.delete(id)
    this.cooldown.set(id, uptime() + 3000)
    joy.close()
    logMsg(`${joy.name} 断开：${why}`)
    emit({ t: 'joy_conn', side: joy.side, id, name: joy.name, connected: false })
  }

  /** 按侧别找手柄：L/R 找对应单只，找不到就用 Pro 手柄兜底 */
  private find(side?: string | null): JoyConDevice[] {
    const all = [...this.devices.values()]
    if (!side) return all
    const hit = all.filter((d) => d.side === side)
    return hit.length ? hit : all.filter((d) => d.side === 'P')
  }

  rumble(side: string | undefined, amplitude: number, ms: number, low: number, high: number): void {
    for (const d of this.find(side)) d.rumble(low, high, amplitude, ms)
  }

  /** 播一段震动：segs 见 rumbleFrames；prio 高的不会被低的打断；force = 放在桌上也震 */
  play(side: string | undefined, segs: number[][], prio: number, force: boolean): void {
    const seq = rumbleFrames(segs)
    for (const d of this.find(side)) d.play(seq, prio, force)
  }

  setLights(side: string | undefined, mask: number): void {
    for (const d of this.find(side)) d.setLights(mask)
  }

  setHome(side: string | undefined, mode: string): void {
    for (const d of this.find(side ?? 'R')) d.setHome(mode)
  }

  locate(seconds: number): void {
    for (const d of this.devices.values()) d.locate(seconds)
  }

  stream(side: string | undefined, seconds: number): void {
    for (const d of this.find(side)) d.stream(seconds)
  }

  /** 退出前收尾：停扫描，每只手柄关灯停震，最多等 400ms */
  async shutdown(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
    const all = [...this.devices.values()]
    await Promise.race([Promise.all(all.map((d) => d.shutdown())), new Promise((r) => setTimeout(r, 400))])
    for (const d of all) d.close()
  }

  listConnected(): void {
    for (const d of this.devices.values()) {
      emit({ t: 'joy_conn', side: d.side, id: d.id, name: d.name, connected: true })
      if (d.resting) emit({ t: 'joy_motion', side: d.side, id: d.id, resting: true })
    }
  }
}
