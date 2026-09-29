// 摄像头眼动的头动补偿：不用再死板地坐回校准时的位置
//
// 岭回归学的是「校准时那个坐姿下，眼睛长什么样 → 看屏幕哪儿」。眼睛小图基本只反映眼珠在眼眶里的转角，
// 头一挪、一转，同样的眼珠转角其实看的是另一个地方，老办法就会整体偏掉，只能靠小人提醒你坐回去。
// 这里把岭回归的输出当成「校准坐姿下的一条视线」：
//   1. 校准时记下两眼中点的位置 E0 和头的朝向 R0（MediaPipe 的人脸变换矩阵，厘米）
//   2. 预测时：落点 g → 屏幕上的三维点 G；视线方向 d0 = G − E0；换到头的坐标里 dh = R0ᵀ·d0（这就是眼珠相对头的朝向）
//   3. 用现在的头：d = R·dh，从现在的眼睛位置 E 射出去，和屏幕平面求交 → 新落点
// 头平移、前后挪、转头都按几何补回来；不动时输出和原来一模一样。
// 相机坐标用 MediaPipe 的约定：x 朝画面右、y 朝上、人在 z < 0 那边；屏幕平面近似就是 z = 0（摄像头嵌在屏幕上沿）。

export type V3 = [number, number, number]

/** 一帧的头：两眼中点位置（厘米，相机坐标）+ 脸 → 相机的旋转（行优先 3×3） */
export interface Head3D {
  e: V3
  r: number[]
}

/** 屏幕和摄像头的相对位置：摄像头在屏幕坐标里的位置（点）、每厘米多少点 */
export interface ScreenGeo {
  cx: number
  cy: number
  k: number
}

/** MediaPipe 算头的位置时假设的相机竖直视角 */
const MP_VFOV = (63 * Math.PI) / 180
/**
 * MediaPipe 按假想的相机算出来的「离镜头多远」比实际近（Mac 内置摄像头视角更窄）：左右上下的位移是准的，只有远近要放大。
 * 这个数只影响「转头」那部分补偿的幅度，平移和前后挪的补偿与它无关
 */
const DEPTH_K = 1.4
/** 摄像头在屏幕可视区上沿往上多少厘米 */
const CAM_ABOVE_CM = 0.4

/**
 * RealEye 转出来的变换矩阵（4 行，其实是列优先矩阵的 4 列）+ 两眼虹膜中心（画面像素）→ Head3D
 * 眼睛位置：按 MediaPipe 同一台假想相机把两眼中点的像素反投影到脸的深度上
 */
export function head3dOf(tm: number[][] | undefined, eyeU: number, eyeV: number, vw: number, vh: number): Head3D | null {
  if (!tm || tm.length !== 4) return null
  const m = tm.flat()
  const tz = m[14]
  if (!(tz < -5)) return null
  const f = vh / 2 / Math.tan(MP_VFOV / 2)
  const d = -tz
  return {
    e: [((eyeU - vw / 2) / f) * d, (-(eyeV - vh / 2) / f) * d, -d * DEPTH_K],
    r: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
  }
}

/** 3×3 矩阵按列做 Gram–Schmidt，拉回最近的旋转矩阵（平均、插值之后会有一点点不正交） */
function orthonormal(r: number[]): number[] {
  const unit = (v: V3): V3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  const c0 = unit([r[0], r[3], r[6]])
  const c1raw: V3 = [r[1], r[4], r[7]]
  const p = c0[0] * c1raw[0] + c0[1] * c1raw[1] + c0[2] * c1raw[2]
  const c1 = unit([c1raw[0] - p * c0[0], c1raw[1] - p * c0[1], c1raw[2] - p * c0[2]])
  const c2: V3 = [c0[1] * c1[2] - c0[2] * c1[1], c0[2] * c1[0] - c0[0] * c1[2], c0[0] * c1[1] - c0[1] * c1[0]]
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]]
}

/** 校准时的平均坐姿：位置取平均，旋转矩阵取平均后重新正交化 */
export function meanHead3D(list: Head3D[]): Head3D | null {
  if (list.length < 5) return null
  const n = list.length
  const e: V3 = [0, 0, 0]
  const r = new Array(9).fill(0)
  for (const h of list) {
    for (let i = 0; i < 3; i++) e[i] += h.e[i] / n
    for (let i = 0; i < 9; i++) r[i] += h.r[i] / n
  }
  return { e, r: orthonormal(r) }
}

/**
 * 头姿平滑：MediaPipe 的头姿每帧有抖动（转角约 ±0.5°，到屏幕上就是几十个点），头又比眼珠慢得多，
 * 所以只把头姿抹平（眼珠那部分照样跟得上扫视）。k = 这一帧的权重
 */
export function smoothHead(prev: Head3D | null, cur: Head3D, k: number): Head3D {
  if (!prev) return cur
  const e: V3 = [prev.e[0] + (cur.e[0] - prev.e[0]) * k, prev.e[1] + (cur.e[1] - prev.e[1]) * k, prev.e[2] + (cur.e[2] - prev.e[2]) * k]
  return { e, r: orthonormal(prev.r.map((v, i) => v + (cur.r[i] - v) * k)) }
}

/** 屏幕几何：摄像头在这块屏幕上沿正中（Mac 内置摄像头的位置）；mm/pt 是这块屏幕的物理宽度和点数 */
export function screenGeo(display: { x: number; y: number; width: number }, mmW: number, ptW: number): ScreenGeo {
  const k = ptW / (mmW / 10)
  return { cx: display.x + display.width / 2, cy: display.y - CAM_ABOVE_CM * k, k }
}

/** 校准坐姿下的落点 g，换成现在这个头的落点；算不出来（视线几乎平行屏幕）就原样返回 */
export function reproject(g: { x: number; y: number }, ref: Head3D, cur: Head3D, geo: ScreenGeo): { x: number; y: number } {
  const G: V3 = [-(g.x - geo.cx) / geo.k, -(g.y - geo.cy) / geo.k, 0]
  const d0: V3 = [G[0] - ref.e[0], G[1] - ref.e[1], G[2] - ref.e[2]]
  const R0 = ref.r
  const R = cur.r
  // dh = R0ᵀ · d0
  const dh: V3 = [
    R0[0] * d0[0] + R0[3] * d0[1] + R0[6] * d0[2],
    R0[1] * d0[0] + R0[4] * d0[1] + R0[7] * d0[2],
    R0[2] * d0[0] + R0[5] * d0[1] + R0[8] * d0[2]
  ]
  const d: V3 = [R[0] * dh[0] + R[1] * dh[1] + R[2] * dh[2], R[3] * dh[0] + R[4] * dh[1] + R[5] * dh[2], R[6] * dh[0] + R[7] * dh[1] + R[8] * dh[2]]
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  if (d[2] / len < 0.05) return g
  const t = -cur.e[2] / d[2]
  const hx = cur.e[0] + t * d[0]
  const hy = cur.e[1] + t * d[1]
  return { x: geo.cx - hx * geo.k, y: geo.cy - hy * geo.k }
}
