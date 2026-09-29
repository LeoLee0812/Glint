// Joy-Con 触感词汇表：同一类事件永远是同一种手感，不用看屏幕就知道发生了什么
// （眼睛本身就是输入设备，弹窗、闪一下的高亮会把视线拉走，震动不占眼睛）
// 每段 [毫秒, 低频, 高频, 振幅, 结束低频?, 结束高频?, 结束振幅?]，原生助手按 15ms 一帧展开（蓝牙每 ~15ms 只送得出一包）；
// 频率按对数插值：往上扬 = 开始，往下沉 = 发出去了；振幅 0~1，0 = 停顿。
// 优先级高的不会被低的打断；手柄放在桌上时原生助手直接丢掉（找手柄除外），免得在硬桌面上嗡嗡响。
// 这里不引用 appState 等模块：appState.rumble() 反过来用这里，避免循环依赖

type Seg = number[]
type Side = 'L' | 'R'

const gap = (ms: number): Seg => [ms, 0, 0, 0]

export const HAPTICS = {
  // 原来的五种：按键确认 / 切换 / 答完 / 提醒 / 拍照快门
  tick: { prio: 1, seq: [[45, 160, 320, 0.32]] },
  soft: { prio: 1, seq: [[60, 120, 240, 0.2]] },
  done: { prio: 2, seq: [[90, 180, 360, 0.45], gap(60), [45, 160, 320, 0.32]] },
  alert: { prio: 3, seq: [[225, 140, 280, 0.7]] },
  strong: { prio: 4, seq: [[315, 130, 260, 1]] },
  // 焦点刻度：逐词一下极短的「咔」，跨句「咔咔」，跨段一下低沉的「咚」，走到头「撞墙」
  detent: { prio: 1, seq: [[15, 180, 360, 0.3]] },
  sentence: { prio: 1, seq: [[15, 180, 360, 0.3], gap(30), [15, 180, 360, 0.3]] },
  block: { prio: 1, seq: [[30, 90, 180, 0.45]] },
  wall: { prio: 1, seq: [[45, 60, 120, 0.6]] },
  // 信号：上扬 = AI 开始出字，下沉 = 语音发出去了，心跳 = 有事在等你，三连 = 危险，长-短 = 眼动丢了
  start: { prio: 2, seq: [[90, 120, 240, 0.2, 240, 480, 0.34]] },
  send: { prio: 2, seq: [[90, 240, 480, 0.32, 110, 220, 0.18]] },
  heartbeat: { prio: 3, seq: [[60, 80, 160, 0.55], gap(105), [75, 80, 160, 0.4]] },
  danger: { prio: 4, seq: [[60, 150, 300, 0.75], gap(60), [60, 150, 300, 0.75], gap(60), [60, 150, 300, 0.75]] },
  lost: { prio: 3, seq: [[180, 110, 220, 0.45], gap(90), [60, 110, 220, 0.45]] }
} satisfies Record<string, { prio: number; seq: Seg[] }>

export type Haptic = keyof typeof HAPTICS

function send(cmd: Record<string, unknown>): void {
  window.lookask.bridge.send(cmd)
}

/** 整体调轻重：只乘振幅（第 4、7 个数），夹在 1 以内 */
function scaled(seq: Seg[], k: number): Seg[] {
  if (k === 1) return seq
  return seq.map((s) => s.map((v, i) => (i === 3 || i === 6 ? Math.min(1, v * k) : v)))
}

/** 震一下：side 不传 = 两只一起；scale 调轻重（比如摇杆按住连发时越走越轻） */
export function haptic(name: Haptic, side?: Side, opts: { scale?: number } = {}): void {
  const p = HAPTICS[name]
  send({ cmd: 'rumble_seq', side, prio: p.prio, seq: scaled(p.seq, opts.scale ?? 1) })
}

/** 连着「咔」n 下：切粒度时用，词 1 下、句 2 下、段 3 下、节 4 下 */
export function hapticCount(n: number, side?: Side): void {
  const seq: Seg[] = []
  for (let i = 0; i < n; i++) seq.push([15, 200, 400, 0.32], gap(60))
  seq.pop()
  send({ cmd: 'rumble_seq', side, prio: 1, seq })
}

/** 右手柄 HOME 键那圈灯：breathe 呼吸（AI 在想 / 在出字）、off 关、blink 快闪、on 常亮 */
export function homeLight(mode: 'breathe' | 'off' | 'blink' | 'on'): void {
  send({ cmd: 'home_led', side: 'R', mode })
}

/** 找手柄：两只一起「哔哔」响几秒（放在桌上也响），玩家灯和 HOME 灯跟着闪 */
export function findJoyCons(seconds = 3): void {
  send({ cmd: 'joy_find', seconds })
}
