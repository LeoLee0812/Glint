import type { TdFrame, Vec3 } from '../../../../shared/types'
import type { FaceExpr, HeadPos } from '../pose'

// 原深感几何：把手机相机坐标系里的头、眼数据换到「屏幕对齐坐标系」D，再拆成校准要用的特征
// D 的原点在手机前置镜头，x 朝用户的右手边、y 朝上、z 从屏幕指向用户（右手系）。
// - z：脸在镜头哪一侧就是「朝用户」——不依赖 ARKit 相机坐标轴的具体约定
// - y：重力的反方向投影到镜头平面上（手机竖放、横放、放歪一点都行）
// - x = y × z
// 屏幕平面近似就是 D 的 z = 0 平面（手机贴着屏幕放，前后差一两厘米用 z0 补）

export type V3 = [number, number, number]
/** 3×3 矩阵，行优先 */
export type M3 = [number, number, number, number, number, number, number, number, number]

export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export function unit(a: V3): V3 {
  const n = norm(a)
  return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]
}

/** 四元数 [x, y, z, w] → 旋转矩阵（把局部坐标转到父坐标） */
export function quatToMat(q: ArrayLike<number>): M3 {
  let [x, y, z, w] = [q[0], q[1], q[2], q[3]]
  const n = Math.hypot(x, y, z, w) || 1
  x /= n
  y /= n
  z /= n
  w /= n
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ]
}

export function mulMV(m: ArrayLike<number>, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

export function mulMM(a: ArrayLike<number>, b: ArrayLike<number>): M3 {
  const o = new Array(9).fill(0) as M3
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}

/**
 * 相机坐标系 → 屏幕对齐坐标系 D 的旋转（三行分别是 D 的 x、y、z 轴在相机坐标系里的方向）
 * grav：相机坐标系里的重力方向；facePos：脸的位置（只用来判断哪一侧是用户）
 * 重力几乎沿着镜头方向（手机平躺）时没法定「上」，退回相机自己的 y 轴
 */
export function displayBasis(grav: V3 | null | undefined, facePos: V3): M3 {
  const toward: V3 = facePos[2] >= 0 ? [0, 0, 1] : [0, 0, -1]
  let up: V3 | null = null
  if (grav && norm(grav) > 0.1) {
    const g = unit(grav)
    const u = sub(scale(g, -1), scale(toward, -dot(g, toward)))
    if (norm(u) > 0.25) up = unit(u)
  }
  if (!up) up = [0, 1, 0]
  const right = unit(cross(up, toward))
  up = cross(toward, right)
  return [right[0], right[1], right[2], up[0], up[1], up[2], toward[0], toward[1], toward[2]]
}

/** 眼睛朝向（相对脸）→ 视线在脸坐标系里的单位向量；ARKit 的眼睛 +z 轴就是视线方向 */
export function eyeGaze(q: ArrayLike<number>): V3 {
  const m = quatToMat(q)
  let v: V3 = [m[2], m[5], m[8]]
  // 视线不可能朝脑后：轴向约定万一反了就翻过来
  if (v[2] < 0) v = scale(v, -1)
  return v
}

/** 特征向量的布局（校准模型按这个下标取） */
export const F = {
  ex: 0,
  ey: 1,
  ez: 2,
  yaw: 3,
  pitch: 4,
  /** 5..13：脸坐标系 → D 的旋转矩阵（行优先） */
  rot: 5,
  len: 14
} as const

export interface TdDerived {
  /** 校准 / 预测用的特征（布局见 F） */
  features: Float64Array
  /** 头（脸原点）在 D 里的位置，米 */
  head: V3
  /** 脸坐标系 → D 的旋转 */
  rotD: M3
  /** 两眼视线相对脸的平均偏角（弧度）：yaw 正 = 往脸自己的左边看，pitch 正 = 往上看 */
  eyeYaw: number
  eyePitch: number
  blink: number
  jaw: number
  /** 挑眉 0~1 */
  brow: number
}

/** 一帧 → 特征。basis 是相机 → D 的旋转（外面做过重力平滑） */
export function deriveFrame(f: TdFrame, basis: M3): TdDerived | null {
  if (!f.tracked || !f.head || !f.eyeL || !f.eyeR) return null
  const rh = quatToMat(f.head.quat)
  const rotD = mulMM(basis, rh)
  const hp = f.head.pos as V3
  const head = mulMV(basis, hp)
  const eL = mulMV(basis, add(hp, mulMV(rh, f.eyeL.pos as V3)))
  const eR = mulMV(basis, add(hp, mulMV(rh, f.eyeR.pos as V3)))
  const e = scale(add(eL, eR), 0.5)
  // 人在屏幕前面：眼睛到屏幕平面的距离必须是正的、而且在合理范围
  if (!(e[2] > 0.12 && e[2] < 2)) return null
  const vL = eyeGaze(f.eyeL.quat)
  const vR = eyeGaze(f.eyeR.quat)
  const yaw = (Math.atan2(vL[0], vL[2]) + Math.atan2(vR[0], vR[2])) / 2
  const pitch = (Math.asin(Math.max(-1, Math.min(1, vL[1]))) + Math.asin(Math.max(-1, Math.min(1, vR[1])))) / 2
  const features = new Float64Array(F.len)
  features[F.ex] = e[0]
  features[F.ey] = e[1]
  features[F.ez] = e[2]
  features[F.yaw] = yaw
  features[F.pitch] = pitch
  for (let i = 0; i < 9; i++) features[F.rot + i] = rotD[i]
  const bs = f.bs || {}
  const blink = Math.max(bs.eyeBlinkLeft ?? 0, bs.eyeBlinkRight ?? 0)
  const brow = Math.min(1, (bs.browInnerUp ?? 0) * 0.6 + ((bs.browOuterUpLeft ?? 0) + (bs.browOuterUpRight ?? 0)) * 0.3)
  return { features, head, rotD, eyeYaw: yaw, eyePitch: pitch, blink, jaw: bs.jawOpen ?? 0, brow }
}

// ---------- 给实时小人的头位置 / 表情 ----------
// 小人原来是按摄像头画面（镜像、0~1）设计的：这里假想一台在手机位置、水平视角 60°、16:9 的相机，
// 把三维头位置投影成同样的 cx / cy / w，转角换成和摄像头版同样的量纲

const TAN_HALF_H = Math.tan((30 * Math.PI) / 180)
const VIEW_W = 2 * TAN_HALF_H
const VIEW_H = (VIEW_W * 9) / 16
const FACE_W = 0.15

/** mirrorX：校准时发现 D 的 x 和屏幕左右是反的（ARKit 坐标约定和假设不一致），头位置也跟着翻 */
export function tdHeadPos(d: TdDerived, mirrorX: boolean): HeadPos {
  const sx = mirrorX ? -1 : 1
  const [x, y, z] = d.head
  const zz = Math.max(0.15, z)
  const up: V3 = [d.rotD[1], d.rotD[4], d.rotD[7]]
  const fwd: V3 = [d.rotD[2], d.rotD[5], d.rotD[8]]
  const roll = Math.atan2(sx * up[0], up[1])
  const yawAng = Math.atan2(sx * fwd[0], Math.max(1e-3, -fwd[2]))
  const downAng = Math.atan2(-fwd[1], Math.max(1e-3, -fwd[2]))
  return {
    cx: 0.5 + (sx * x) / (VIEW_W * zz),
    cy: 0.5 - y / (VIEW_H * zz),
    w: FACE_W / (VIEW_W * zz),
    roll,
    yaw: 1.4 * Math.tan(Math.max(-1.2, Math.min(1.2, yawAng))),
    pitch: 0.5 + (downAng * 180) / Math.PI / 150,
    rot: { yaw: yawAng, pitch: -downAng, roll }
  }
}

export function tdExpr(d: TdDerived, mirrorX: boolean): FaceExpr {
  const sx = mirrorX ? -1 : 1
  const clamp1 = (v: number) => Math.max(-1, Math.min(1, v))
  return {
    blink: d.blink,
    mouth: Math.min(1, d.jaw * 1.6),
    brow: d.brow,
    // eyeYaw 正 = 往脸自己的左边看 = 镜子里往左
    lookX: clamp1((-sx * d.eyeYaw) / 0.35),
    lookY: clamp1(-d.eyePitch / 0.3)
  }
}

/** 眼睛到屏幕的距离（厘米），给摆位提示用 */
export function tdDistanceCm(d: TdDerived): number {
  return d.features[F.ez] * 100
}
