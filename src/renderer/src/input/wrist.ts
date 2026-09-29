import { la } from '../appState'
import { focus } from '../focus/focus'
import { gaze } from '../gaze/engine'
import { input } from './joycon'

// 手腕精调：按下右摇杆 = 焦点先跳到视线处；按住不放拧手腕 = 焦点从那里跟着手走（左右转逐词、上下点逐行）；松开 = 落定。
// 眼睛负责跳到附近、手负责最后那一点（MAGIC pointing）：摇杆是一格一格推（速度控制），手腕是转多少走多少（位置控制），短距离快得多。
// 做法像棘轮：陀螺仪角度累加，够一格走一步（focus.step 每步自己会「咔」一下），多出来的留着下一格用。
// 松手时「按下那一刻的视线预测 → 最后落点」的差就是一条校准残差，喂给漂移校正，越用越准。

/** 转多少度走一个词 / 一行（手感参数） */
const DEG_PER_WORD = 2.6
const DEG_PER_LINE = 3.8
/** 方向：真机上觉得反了就改成 -1 */
const SIGN = { x: 1, y: 1 }
/** 一包（约 15ms）里最多走几步：猛甩一下不至于飞出去半页 */
const MAX_STEPS = 3

let active = false
let accX = 0
let accY = 0
let steps = 0
let t0 = 0
let pred0: { x: number; y: number } | null = null

export function wristActive(): boolean {
  return active
}

/** 右摇杆按下时调用（焦点已经跳到视线处之后）：打开右手柄的陀螺仪流 */
export function wristStart(): void {
  if (active || !input.connected().R) return
  active = true
  accX = accY = 0
  steps = 0
  t0 = performance.now()
  pred0 = gaze.isCalibrated() ? gaze.recentPrediction(450) : null
  la.bridge.send({ cmd: 'imu_stream', side: 'R', on: true })
}

/** 右摇杆松开：关流；真拧过的话，把这次修正记成一条校准残差 */
export function wristEnd(): void {
  if (!active) return
  active = false
  la.bridge.send({ cmd: 'imu_stream', side: 'R', on: false })
  // 按下那一刻人正看着目标，落点就是「真实视线」；拖太久（可能已经在读别处了）或挪太远的不算
  if (!steps || !pred0 || performance.now() - t0 > 6000 || focus.state.get().mode !== 'hard') return
  const target = focus.focusCenterScreen()
  if (target && Math.hypot(target.x - pred0.x, target.y - pred0.y) < 320) gaze.addResidual(target, pred0, 0.6)
}

la.bridge.onEvent((e) => {
  if (e.t === 'joy_gyro' && e.side !== 'L') feed(e.yaw, e.pitch)
})

/** 喂一包角度增量（度）：yaw 往右为正，pitch 手柄头抬起为正；导出来方便自动化测试直接喂数 */
export function feed(yaw: number, pitch: number): void {
  if (!active) return
  let dx = yaw * SIGN.x
  let dy = pitch * SIGN.y
  // 左右转手腕难免带一点点头，反过来也一样：明显在往一个方向走时把另一个方向压小，免得斜着跳行
  if (Math.abs(dx) > 2 * Math.abs(dy)) dy *= 0.3
  else if (Math.abs(dy) > 2 * Math.abs(dx)) dx *= 0.3
  accX += dx
  accY += dy
  let n = 0
  while (Math.abs(accX) >= DEG_PER_WORD && n < MAX_STEPS) {
    const right = accX > 0
    focus.step(right ? 'right' : 'left')
    accX -= right ? DEG_PER_WORD : -DEG_PER_WORD
    n++
  }
  while (Math.abs(accY) >= DEG_PER_LINE && n < MAX_STEPS) {
    const up = accY > 0
    focus.step(up ? 'up' : 'down')
    accY -= up ? DEG_PER_LINE : -DEG_PER_LINE
    n++
  }
  // 这一包没走完的（猛甩）直接扔掉；留在满格上的话，下一包一点点抖动就会多走一步
  if (Math.abs(accX) >= DEG_PER_WORD) accX = 0
  if (Math.abs(accY) >= DEG_PER_LINE) accY = 0
  steps += n
}
