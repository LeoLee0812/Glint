import { F } from './geometry'

// 原深感校准模型（几何法）：
//   视线 = 从两眼中点出发、沿「校正后的眼睛转角」经头部旋转后的方向；和屏幕平面（D 的 z = z0）求交得到 P（米）
//   屏幕坐标 = S·R·P + T
// - S：屏幕每米多少点（显示器物理尺寸算出来的，固定不拟合）
// - R：D 的 (x, y) 到屏幕 (x, y) 的方向，先用线性拟合的「方向部分」定下来（顺便兜住 ARKit 坐标约定和假设不一致的情况）
// - T：手机镜头在屏幕上的位置（手机放哪儿不知道，校准时解出来）
// - 眼睛转角校正 th = [gy, cy, by, gp, cp, qp, bp]：
//     yaw'   = gy·yaw + cy·pitch + by
//     pitch' = gp·pitch + cp·yaw + qp·pitch² + bp
//   ARKit 的眼睛转角通常偏小、上下方向还带点非线性，校正放在「眼睛相对头」的坐标里做，头怎么转都成立
// 因为头的位置和转角是按真实几何算进去的，校准完头挪、歪、前后动，视线点都不该跟着跑。
// 拟合：Levenberg–Marquardt，眼睛参数带先验（别被噪声带飞），留一个校准点交叉验证挑模型、报误差。

export interface TdModel {
  kind: 'td'
  v: 1
  S: number
  R: [number, number, number, number]
  T: [number, number]
  th: number[]
  z0: number
  /** D 的 x 和屏幕左右是反的（R 是反射）：头位置显示也要翻 */
  mirrorX: boolean
  variant: 'simple' | 'full'
  cvErrorPx: number | null
  /** 眼睛转角的等效增益（左右、上下），正常在 0.6～1.8 */
  gain: [number, number]
  nSamples: number
  nPoints: number
  createdAt: number
  screenW: number
  screenH: number
}

export interface TdFitInput {
  rows: Float64Array[]
  tx: number[]
  ty: number[]
  groups: number[]
  /** 屏幕每米多少点 */
  S: number
  /** 屏幕平面在 D 里的 z（米） */
  z0: number
  screenW: number
  screenH: number
}

const TH0 = [1, 0, 0, 1, 0, 0, 0]
/** 先验宽度：增益 ±0.5、交叉项 ±0.15、二次项 ±0.6、偏置 ±3.4° */
const TH_SIGMA = [0.5, 0.15, 0.06, 0.5, 0.15, 0.6, 0.06]
/** 每个校准点的误差量级（点），用来和先验配平 */
const SIGMA_PX = 40
const FREE_SIMPLE = [0, 2, 3, 6]
const FREE_FULL = [0, 1, 2, 3, 4, 5, 6]

/** 一行特征按眼睛参数 th 求视线和屏幕平面的交点（米，D 坐标）；视线几乎平行屏幕时返回 null */
export function planeHit(row: ArrayLike<number>, th: ArrayLike<number>, z0: number): [number, number] | null {
  const yaw = row[F.yaw]
  const pitch = row[F.pitch]
  const yc = th[0] * yaw + th[1] * pitch + th[2]
  const pc = th[3] * pitch + th[4] * yaw + th[5] * pitch * pitch + th[6]
  const cp = Math.cos(pc)
  const v0 = Math.sin(yc) * cp
  const v1 = Math.sin(pc)
  const v2 = Math.cos(yc) * cp
  const r = F.rot
  const dx = row[r] * v0 + row[r + 1] * v1 + row[r + 2] * v2
  const dy = row[r + 3] * v0 + row[r + 4] * v1 + row[r + 5] * v2
  const dz = row[r + 6] * v0 + row[r + 7] * v1 + row[r + 8] * v2
  if (dz > -0.08) return null
  const t = (z0 - row[F.ez]) / dz
  return [row[F.ex] + t * dx, row[F.ey] + t * dy]
}

export function predictTd(m: Pick<TdModel, 'S' | 'R' | 'T' | 'th' | 'z0'>, row: ArrayLike<number>): { x: number; y: number } | null {
  const p = planeHit(row, m.th, m.z0)
  if (!p) return null
  return {
    x: m.S * (m.R[0] * p[0] + m.R[1] * p[1]) + m.T[0],
    y: m.S * (m.R[2] * p[0] + m.R[3] * p[1]) + m.T[1]
  }
}

/** 2×2 矩阵最接近的正交阵（旋转或反射） */
export function polar2(a: ArrayLike<number>): [number, number, number, number] {
  const det = a[0] * a[3] - a[1] * a[2]
  if (det >= 0) {
    const ang = Math.atan2(a[2] - a[1], a[0] + a[3])
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    return [c, -s, s, c]
  }
  // 反射：右乘 diag(1, -1) 变成旋转求角度，再乘回去
  const ang = Math.atan2(a[2] + a[1], a[0] - a[3])
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  return [c, s, s, -c]
}

/** 小矩阵线性方程组（高斯消元，部分主元） */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-12) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = M[r][c] / M[c][c]
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]
    }
  }
  return M.map((r, i) => r[n] / r[i])
}

/** 最小二乘：target ≈ a·px + b·py + c */
function lsq3(px: number[], py: number[], t: number[]): number[] | null {
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ]
  const b = [0, 0, 0]
  for (let i = 0; i < t.length; i++) {
    const v = [px[i], py[i], 1]
    for (let r = 0; r < 3; r++) {
      b[r] += v[r] * t[i]
      for (let c = 0; c < 3; c++) A[r][c] += v[r] * v[c]
    }
  }
  return solve(A, b)
}

interface Problem {
  rows: Float64Array[]
  tx: number[]
  ty: number[]
  w: number[]
  S: number
  R: [number, number, number, number]
  z0: number
}

/** 参数 p = [th0..th6, T0, T1]；free = 参与拟合的眼睛参数下标 */
function residuals(pb: Problem, p: number[], idx: number[], free: number[]): number[] {
  const out: number[] = []
  const th = p.slice(0, 7)
  const [T0, T1] = [p[7], p[8]]
  const { S, R } = pb
  for (const i of idx) {
    const hit = planeHit(pb.rows[i], th, pb.z0)
    const w = pb.w[i] / SIGMA_PX
    if (!hit) {
      out.push(600 * w, 600 * w)
      continue
    }
    out.push((S * (R[0] * hit[0] + R[1] * hit[1]) + T0 - pb.tx[i]) * w)
    out.push((S * (R[2] * hit[0] + R[3] * hit[1]) + T1 - pb.ty[i]) * w)
  }
  for (const k of free) out.push((p[k] - TH0[k]) / TH_SIGMA[k])
  return out
}

function cost(r: number[]): number {
  let s = 0
  for (const v of r) s += v * v
  return s
}

/** Levenberg–Marquardt：只动 free 里的眼睛参数和 T */
function levmar(pb: Problem, p0: number[], idx: number[], free: number[], iters: number): number[] {
  const vars = [...free, 7, 8]
  let p = [...p0]
  let r = residuals(pb, p, idx, free)
  let c = cost(r)
  let lambda = 1e-3
  for (let it = 0; it < iters; it++) {
    const J: number[][] = []
    for (const k of vars) {
      const h = k >= 7 ? 0.5 : 1e-5
      const q = [...p]
      q[k] += h
      const rq = residuals(pb, q, idx, free)
      J.push(rq.map((v, j) => (v - r[j]) / h))
    }
    const n = vars.length
    const JTJ = Array.from({ length: n }, () => new Array(n).fill(0))
    const JTr = new Array(n).fill(0)
    for (let a = 0; a < n; a++) {
      const ja = J[a]
      for (let j = 0; j < r.length; j++) JTr[a] += ja[j] * r[j]
      for (let b = 0; b <= a; b++) {
        const jb = J[b]
        let s = 0
        for (let j = 0; j < r.length; j++) s += ja[j] * jb[j]
        JTJ[a][b] = JTJ[b][a] = s
      }
    }
    let improved = false
    for (let tries = 0; tries < 6; tries++) {
      const A = JTJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) + 1e-9 : v)))
      const d = solve(
        A,
        JTr.map((v) => -v)
      )
      if (!d) {
        lambda *= 10
        continue
      }
      const q = [...p]
      vars.forEach((k, a) => (q[k] += d[a]))
      const rq = residuals(pb, q, idx, free)
      const cq = cost(rq)
      if (cq < c) {
        const rel = (c - cq) / Math.max(c, 1e-12)
        p = q
        r = rq
        c = cq
        lambda = Math.max(1e-7, lambda / 3)
        improved = true
        if (rel < 1e-7) return p
        break
      }
      lambda *= 4
    }
    if (!improved) break
  }
  return p
}

function heldOutError(pb: Problem, p: number[], idx: number[]): { sum: number; n: number } {
  let sum = 0
  let n = 0
  const m = { S: pb.S, R: pb.R, T: [p[7], p[8]] as [number, number], th: p.slice(0, 7), z0: pb.z0 }
  for (const i of idx) {
    const q = predictTd(m, pb.rows[i])
    sum += q ? Math.hypot(q.x - pb.tx[i], q.y - pb.ty[i]) : 600
    n++
  }
  return { sum, n }
}

export function fitTd(inp: TdFitInput): TdModel {
  const N = inp.rows.length
  if (N < 30) throw new Error('看到脸的时间太短，再校准一次')
  // 每个校准点总权重一样（点里的帧高度相关，按帧数算权重会偏向帧多的点）
  const count = new Map<number, number>()
  for (const g of inp.groups) count.set(g, (count.get(g) ?? 0) + 1)
  const w = inp.groups.map((g) => 1 / Math.sqrt(count.get(g)!))

  // 1) 不做眼睛校正先求交点，线性拟合屏幕 ≈ A·P + c，取 A 的方向部分当 R
  const px: number[] = []
  const py: number[] = []
  const tx: number[] = []
  const ty: number[] = []
  for (let i = 0; i < N; i++) {
    const h = planeHit(inp.rows[i], TH0, inp.z0)
    if (!h) continue
    px.push(h[0])
    py.push(h[1])
    tx.push(inp.tx[i])
    ty.push(inp.ty[i])
  }
  if (px.length < 30) throw new Error('视线大多没落在屏幕上，检查一下手机摆放再来')
  const ax = lsq3(px, py, tx)
  const ay = lsq3(px, py, ty)
  if (!ax || !ay) throw new Error('眼睛几乎没动，校准时要跟着圆点看')
  const A = [ax[0], ax[1], ay[0], ay[1]]
  const R = polar2(A)
  const pb: Problem = { rows: inp.rows, tx: inp.tx, ty: inp.ty, w, S: inp.S, R, z0: inp.z0 }

  // T 的初值：不校正眼睛时，屏幕点和 S·R·P 的平均差
  let t0 = 0
  let t1 = 0
  let tn = 0
  for (let i = 0; i < px.length; i++) {
    t0 += tx[i] - inp.S * (R[0] * px[i] + R[1] * py[i])
    t1 += ty[i] - inp.S * (R[2] * px[i] + R[3] * py[i])
    tn++
  }
  const start = [...TH0, t0 / tn, t1 / tn]
  const all = [...Array(N).keys()]
  const groups = [...count.keys()]

  // 2) 简单模型（增益 + 偏置）和完整模型（再加交叉项、上下二次项）各拟合一遍，留一点交叉验证挑误差小的
  const variants: Array<{ name: 'simple' | 'full'; free: number[] }> = [
    { name: 'simple', free: FREE_SIMPLE },
    { name: 'full', free: FREE_FULL }
  ]
  let best: { name: 'simple' | 'full'; p: number[]; cv: number | null } | null = null
  for (const v of variants) {
    const p = levmar(pb, start, all, v.free, 40)
    let cv: number | null = null
    if (groups.length >= 5) {
      let sum = 0
      let n = 0
      for (const g of groups) {
        const train = all.filter((i) => inp.groups[i] !== g)
        const test = all.filter((i) => inp.groups[i] === g)
        const pg = levmar(pb, p, train, v.free, 10)
        const e = heldOutError(pb, pg, test)
        sum += e.sum
        n += e.n
      }
      cv = n ? sum / n : null
    }
    if (!best || (cv != null && best.cv != null && cv < best.cv * 0.97) || (best.cv == null && cv != null)) best = { name: v.name, p, cv }
  }
  const p = best!.p
  const th = p.slice(0, 7)
  return {
    kind: 'td',
    v: 1,
    S: inp.S,
    R,
    T: [p[7], p[8]],
    th,
    z0: inp.z0,
    // 期望 R ≈ diag(1, -1)（D 的 y 朝上、屏幕 y 朝下）；R 是旋转而不是反射，说明左右反了
    mirrorX: R[0] * R[3] - R[1] * R[2] > 0,
    variant: best!.name,
    cvErrorPx: best!.cv,
    gain: [th[0], th[3]],
    nSamples: N,
    nPoints: groups.length,
    createdAt: Date.now(),
    screenW: inp.screenW,
    screenH: inp.screenH
  }
}
