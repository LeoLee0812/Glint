// 论文用的合成实验：直接调用项目里的 ridge.ts / filters.ts，数据全部是合成的（不是真人数据）
// 运行（在仓库根目录）：node docs/算法论文/experiments/build.mjs，结果写到 experiments/results.json
import { fitRidge, predictRidge } from '../../../src/renderer/src/gaze/ridge'
import { OneEuro } from '../../../src/renderer/src/gaze/filters'
import { writeFileSync } from 'node:fs'

// ---------- 可复现的随机数 ----------
let seed = 20260928
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}
function randn(): number {
  const u = Math.max(1e-12, rand())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const W = 1440
const H = 900
const D = 1650
const FRAMES = 24

// 与 Calibration.tsx 相同的 17 点布局
function calibPoints(): Array<[number, number]> {
  const a = 0.08, b = 0.92, p = 0.29, q = 0.71
  const grid: Array<[number, number]> = [[a, a], [0.5, a], [b, a], [b, 0.5], [0.5, 0.5], [a, 0.5], [a, b], [0.5, b], [b, b]]
  const extra: Array<[number, number]> = [[p, p], [0.5, p], [q, p], [q, 0.5], [p, 0.5], [p, q], [0.5, q], [q, q]]
  const out: Array<[number, number]> = []
  for (let i = 0; i < 9; i++) {
    out.push(grid[i])
    if (extra[i]) out.push(extra[i])
  }
  return out.map(([u, v]) => [u * W, v * H])
}

// ---------- 合成特征生成器 ----------
// 特征 = 视线方向的非线性编码（随机投影 + tanh）+ 每个注视点共享的扰动（头姿、瞳孔微偏） + 逐帧噪声
const K_LAT = 6
const proj = Array.from({ length: D }, () => Float64Array.from({ length: K_LAT }, () => randn()))
const nuisProj = Array.from({ length: D }, () => Float64Array.from({ length: 4 }, () => randn()))
function feature(tx: number, ty: number, nuis: number[], noise: number): Float64Array {
  const u = (tx / W) * 2 - 1
  const v = (ty / H) * 2 - 1
  const lat = [u, v, u * v, u * u, v * v, 1]
  const f = new Float64Array(D)
  for (let j = 0; j < D; j++) {
    let s = 0
    for (let k = 0; k < K_LAT; k++) s += proj[j][k] * lat[k]
    let n = 0
    for (let k = 0; k < 4; k++) n += nuisProj[j][k] * nuis[k]
    f[j] = Math.tanh(0.5 * s) + n + noise * randn()
  }
  return f
}
function session(points: Array<[number, number]>, frames: number, nuisScale: number, noise: number) {
  const rows: Float64Array[] = []
  const tx: number[] = []
  const ty: number[] = []
  const groups: number[] = []
  points.forEach(([x, y], g) => {
    const nuis = [0, 0, 0, 0].map(() => nuisScale * randn())
    for (let i = 0; i < frames; i++) {
      rows.push(feature(x, y, nuis, noise))
      tx.push(x)
      ty.push(y)
      groups.push(g)
    }
  })
  return { rows, tx, ty, groups, screenW: W, screenH: H }
}

// ---------- 原始形式岭回归（对照组，只用于计时） ----------
function cholesky(A: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    const rj = j * n
    let s = A[rj + j]
    for (let k = 0; k < j; k++) s -= A[rj + k] * A[rj + k]
    if (!(s > 0)) return false
    const l = Math.sqrt(s)
    A[rj + j] = l
    for (let i = j + 1; i < n; i++) {
      const ri = i * n
      let t = A[ri + j]
      for (let k = 0; k < j; k++) t -= A[ri + k] * A[rj + k]
      A[ri + j] = t / l
    }
  }
  return true
}
function primalFit(rows: Float64Array[], lambda: number): number {
  const N = rows.length
  const d = rows[0].length
  const t0 = performance.now()
  const G = new Float64Array(d * d)
  for (let i = 0; i < N; i++) {
    const r = rows[i]
    for (let a = 0; a < d; a++) {
      const ra = r[a]
      const off = a * d
      for (let b = 0; b <= a; b++) G[off + b] += ra * r[b]
    }
  }
  for (let a = 0; a < d; a++) G[a * d + a] += lambda
  cholesky(G, d)
  return performance.now() - t0
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

const results: Record<string, unknown> = {}

// ---------- E1：原始形式 vs 对偶形式耗时 ----------
{
  const pts = calibPoints()
  const s = session(pts, FRAMES, 0.15, 0.25)
  const dualSingle: number[] = []
  const dualCv: number[] = []
  const primal: number[] = []
  for (let r = 0; r < 3; r++) {
    let t0 = performance.now()
    fitRidge(s, [3e-3])
    dualSingle.push(performance.now() - t0)
    t0 = performance.now()
    fitRidge(s)
    dualCv.push(performance.now() - t0)
    primal.push(primalFit(s.rows, 1))
  }
  results.E1 = {
    N: s.rows.length, d: D,
    dualSingleMs: median(dualSingle), dualWithCvMs: median(dualCv), primalSingleMs: median(primal),
    flops: { primalGram: s.rows.length * D * D, primalChol: D ** 3 / 3, dualGram: s.rows.length ** 2 * D, dualChol: s.rows.length ** 3 / 3 }
  }
  console.log('E1', results.E1)
}

// ---------- E2：交叉验证的偏差（随机留一帧 vs 按点整组留出） ----------
{
  const trials = 3
  const rows: Array<{ frameCv: number; groupCv: number; truth: number }> = []
  for (let t = 0; t < trials; t++) {
    const pts = calibPoints()
    const s = session(pts, 12, 0.15, 0.25)
    const group = fitRidge(s)
    const frameGroups = s.groups.map((_, i) => i)
    const frame = fitRidge({ ...s, groups: frameGroups })
    // 真实误差：在从没见过的 200 个随机位置上测
    const test: Array<[number, number]> = Array.from({ length: 200 }, () => [W * (0.05 + 0.9 * rand()), H * (0.05 + 0.9 * rand())])
    const ts = session(test, 1, 0.15, 0.25)
    let err = 0
    ts.rows.forEach((f, i) => {
      const p = predictRidge(group, f)
      err += Math.hypot(p.x - ts.tx[i], p.y - ts.ty[i])
    })
    rows.push({ frameCv: frame.cvErrorPx ?? NaN, groupCv: group.cvErrorPx ?? NaN, truth: err / ts.rows.length })
  }
  results.E2 = rows
  console.log('E2', rows)
}

// ---------- E3：One Euro vs 固定截止频率 ----------
{
  const FPS = 30
  const dt = 1000 / FPS
  // 12 次注视，每次 600–1200ms，注视点在屏幕随机位置，逐帧加 σ=40px 的噪声
  const truth: number[] = []
  const obs: number[] = []
  const onsets: number[] = []
  let x = W / 2
  for (let f = 0; f < 12; f++) {
    const nx = W * (0.1 + 0.8 * rand())
    onsets.push(truth.length)
    x = nx
    const len = Math.round((600 + 600 * rand()) / dt)
    for (let i = 0; i < len; i++) {
      truth.push(x)
      obs.push(x + 40 * randn())
    }
  }
  const configs = [
    { name: 'Fixed low cutoff (0.55 Hz)', min: 0.55, beta: 0 },
    { name: 'Fixed high cutoff (5 Hz)', min: 5, beta: 0 },
    { name: 'One Euro (0.55 Hz, β = 0.0045)', min: 0.55, beta: 0.0045 }
  ]
  const out = configs.map((c) => {
    const f = new OneEuro(c.min, c.beta)
    const y = obs.map((v, i) => f.filter(v, i * dt))
    // 抖动：每次注视后 300ms 之后的稳态段，输出相对真值的 RMS
    let sq = 0
    let n = 0
    const lags: number[] = []
    onsets.forEach((on, k) => {
      const end = k + 1 < onsets.length ? onsets[k + 1] : truth.length
      for (let i = on + Math.round(300 / dt); i < end; i++) {
        sq += (y[i] - truth[i]) ** 2
        n++
      }
      if (k === 0) return
      const from = truth[on - 1]
      const to = truth[on]
      const need = 0.9 * Math.abs(to - from)
      let lag = NaN
      for (let i = on; i < end; i++) {
        if (Math.abs(y[i] - from) >= need) {
          lag = (i - on) * dt
          break
        }
      }
      if (!Number.isNaN(lag)) lags.push(lag)
    })
    return { name: c.name, jitterRmsPx: Math.sqrt(sq / n), lag90Ms: median(lags), trace: y.slice(0, 150) }
  })
  results.E3 = { rawNoisePx: 40, configs: out.map(({ trace, ...r }) => r), trace: { truth: truth.slice(0, 150), obs: obs.slice(0, 150), series: out.map((o) => ({ name: o.name, y: o.trace })) } }
  console.log('E3', (results.E3 as any).configs)
}

// ---------- E4：漂移校正（与 engine.ts correction() 相同的公式） ----------
{
  type Res = { px: number; py: number; rx: number; ry: number; t: number; w: number }
  function correction(res: Res[], x: number, y: number, now: number, kernel = true, shrink = true) {
    if (!res.length) return { dx: 0, dy: 0 }
    const sigma = 520
    const tau = 20 * 60 * 1000
    let sw = 0, sx = 0, sy = 0
    for (const r of res) {
      const d2 = (r.px - x) ** 2 + (r.py - y) ** 2
      const w = r.w * (kernel ? Math.exp(-d2 / (2 * sigma * sigma)) : 1) * Math.exp(-(now - r.t) / tau)
      sw += w
      sx += w * r.rx
      sy += w * r.ry
    }
    if (sw < 1e-3) return { dx: 0, dy: 0 }
    const k = shrink ? sw / (sw + 0.35) : 1
    return { dx: (sx / sw) * k, dy: (sy / sw) * k }
  }
  // 漂移场：随位置变化的偏移（模拟姿势变化后的非均匀误差）
  const drift = (x: number, y: number) => ({ dx: 70 * (x / W - 0.5) + 35, dy: -60 * (y / H - 0.5) - 25 })
  const grid: Array<[number, number]> = []
  for (let i = 0; i < 9; i++) for (let j = 0; j < 6; j++) grid.push([W * (0.08 + 0.84 * i / 8), H * (0.08 + 0.84 * j / 5)])
  const variants = [
    { name: 'Full method', kernel: true, shrink: true, gate: true },
    { name: 'No 320 px gate', kernel: true, shrink: true, gate: false },
    { name: 'Global mean (no spatial kernel)', kernel: false, shrink: true, gate: true },
    { name: 'No shrinkage', kernel: true, shrink: false, gate: true }
  ]
  const counts = [0, 1, 2, 4, 8, 16]
  const reps = 200
  const table = variants.map((v) => {
    const byCount = counts.map((c) => {
      let tot = 0
      for (let r = 0; r < reps; r++) {
        const res: Res[] = []
        let tries = 0
        while (res.length < c && tries < 200) {
          tries++
          const tx = W * (0.05 + 0.9 * rand())
          const ty = H * (0.05 + 0.9 * rand())
          const d = drift(tx, ty)
          // 预测 = 真值 + 漂移 + 450ms 均值后的残余噪声；15% 的按键用户其实没在看焦点
          const lookingAway = rand() < 0.15
          const ox = lookingAway ? (rand() < 0.5 ? -1 : 1) * (250 + 400 * rand()) : 0
          const oy = lookingAway ? (rand() < 0.5 ? -1 : 1) * (250 + 400 * rand()) : 0
          const px = tx + d.dx + 12 * randn() + ox
          const py = ty + d.dy + 12 * randn() + oy
          if (v.gate && Math.hypot(tx - px, ty - py) >= 320) continue
          res.push({ px, py, rx: tx - px, ry: ty - py, t: 0, w: 0.6 })
        }
        let e = 0
        for (const [gx, gy] of grid) {
          const d = drift(gx, gy)
          const px = gx + d.dx
          const py = gy + d.dy
          const c2 = correction(res, px, py, 0, v.kernel, v.shrink)
          e += Math.hypot(px + c2.dx - gx, py + c2.dy - gy)
        }
        tot += e / grid.length
      }
      return tot / reps
    })
    return { name: v.name, errorPx: byCount }
  })
  results.E4 = { counts, reps, table }
  console.log('E4', JSON.stringify(table))
}

writeFileSync(process.argv[2] ?? 'results.json', JSON.stringify(results, null, 1))
console.log('done')
