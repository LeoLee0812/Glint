// 岭回归（对偶形式）：特征维度 ~1650 远大于样本数 ~400，算 N×N 的核矩阵比 d×d 快十倍
// 用「留一个校准点」交叉验证自动挑正则强度，顺便得到一个诚实的误差估计

export interface RidgeModel {
  d: number
  meanX: number[]
  betaX: number[]
  betaY: number[]
  meanTx: number
  meanTy: number
  lambda: number
  cvErrorPx: number | null
  nSamples: number
  nPoints: number
  createdAt: number
  /** 校准时屏幕尺寸，换了屏要重校 */
  screenW: number
  screenH: number
}

export interface FitInput {
  rows: Float64Array[]
  tx: number[]
  ty: number[]
  groups: number[]
  screenW: number
  screenH: number
}

function cholesky(A: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    const rj = j * n
    let s = A[rj + j]
    for (let k = 0; k < j; k++) s -= A[rj + k] * A[rj + k]
    if (!(s > 0)) return false
    const ljj = Math.sqrt(s)
    A[rj + j] = ljj
    for (let i = j + 1; i < n; i++) {
      const ri = i * n
      let t = A[ri + j]
      for (let k = 0; k < j; k++) t -= A[ri + k] * A[rj + k]
      A[ri + j] = t / ljj
    }
  }
  return true
}

function cholSolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const z = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const ri = i * n
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[ri + k] * z[k]
    z[i] = s / L[ri + i]
  }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = z[i]
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]
    x[i] = s / L[i * n + i]
  }
  return x
}

/** 取核矩阵的子块并加 λI */
function subGram(K: Float64Array, N: number, idx: number[], lambda: number): Float64Array {
  const m = idx.length
  const A = new Float64Array(m * m)
  for (let a = 0; a < m; a++) {
    const ra = idx[a] * N
    for (let b = 0; b <= a; b++) {
      const v = K[ra + idx[b]]
      A[a * m + b] = v
      A[b * m + a] = v
    }
    A[a * m + a] += lambda
  }
  return A
}

export function fitRidge(input: FitInput, lambdasRel = [3e-4, 3e-3, 3e-2, 3e-1]): RidgeModel {
  const { rows, tx, ty, groups } = input
  const N = rows.length
  const d = rows[0].length
  const meanX = new Float64Array(d)
  for (const r of rows) for (let j = 0; j < d; j++) meanX[j] += r[j]
  for (let j = 0; j < d; j++) meanX[j] /= N
  const Xc = rows.map((r) => {
    const c = new Float64Array(d)
    for (let j = 0; j < d; j++) c[j] = r[j] - meanX[j]
    return c
  })
  const meanTx = tx.reduce((a, b) => a + b, 0) / N
  const meanTy = ty.reduce((a, b) => a + b, 0) / N
  const yx = Float64Array.from(tx, (v) => v - meanTx)
  const yy = Float64Array.from(ty, (v) => v - meanTy)

  const K = new Float64Array(N * N)
  for (let i = 0; i < N; i++) {
    const xi = Xc[i]
    for (let j = 0; j <= i; j++) {
      const xj = Xc[j]
      let s = 0
      for (let k = 0; k < d; k++) s += xi[k] * xj[k]
      K[i * N + j] = s
      K[j * N + i] = s
    }
  }
  let diagMean = 0
  for (let i = 0; i < N; i++) diagMean += K[i * N + i]
  diagMean = diagMean / N || 1

  const uniqueGroups = [...new Set(groups)]
  let bestLambda = lambdasRel[1] * diagMean
  let bestErr: number | null = null

  // 校准点少于 5 个就不做交叉验证了
  if (uniqueGroups.length >= 5) {
    for (const rel of lambdasRel) {
      const lambda = rel * diagMean
      let errSum = 0
      let errN = 0
      let failed = false
      for (const g of uniqueGroups) {
        const train: number[] = []
        const test: number[] = []
        for (let i = 0; i < N; i++) (groups[i] === g ? test : train).push(i)
        if (!test.length || train.length < 5) continue
        const A = subGram(K, N, train, lambda)
        if (!cholesky(A, train.length)) {
          failed = true
          break
        }
        const bx = Float64Array.from(train, (i) => yx[i])
        const by = Float64Array.from(train, (i) => yy[i])
        const ax = cholSolve(A, train.length, bx)
        const ay = cholSolve(A, train.length, by)
        // 逐帧算误差再平均（实际使用时每帧都在预测，只有轻度平滑），这样估出来的误差不会偏乐观
        for (const sIdx of test) {
          let vx = 0
          let vy = 0
          const rs = sIdx * N
          for (let t = 0; t < train.length; t++) {
            const k = K[rs + train[t]]
            vx += k * ax[t]
            vy += k * ay[t]
          }
          errSum += Math.hypot(vx + meanTx - tx[sIdx], vy + meanTy - ty[sIdx])
          errN++
        }
      }
      if (failed || !errN) continue
      const err = errSum / errN
      if (bestErr === null || err < bestErr) {
        bestErr = err
        bestLambda = lambda
      }
    }
  }

  let lambda = bestLambda
  let A = subGram(K, N, [...Array(N).keys()], lambda)
  while (!cholesky(A, N)) {
    lambda *= 10
    A = subGram(K, N, [...Array(N).keys()], lambda)
  }
  const ax = cholSolve(A, N, yx)
  const ay = cholSolve(A, N, yy)
  const betaX = new Float64Array(d)
  const betaY = new Float64Array(d)
  for (let i = 0; i < N; i++) {
    const xi = Xc[i]
    const a = ax[i]
    const b = ay[i]
    for (let j = 0; j < d; j++) {
      betaX[j] += xi[j] * a
      betaY[j] += xi[j] * b
    }
  }
  return {
    d,
    meanX: Array.from(meanX),
    betaX: Array.from(betaX),
    betaY: Array.from(betaY),
    meanTx,
    meanTy,
    lambda,
    cvErrorPx: bestErr,
    nSamples: N,
    nPoints: uniqueGroups.length,
    createdAt: Date.now(),
    screenW: input.screenW,
    screenH: input.screenH
  }
}

export function predictRidge(m: RidgeModel, f: ArrayLike<number>): { x: number; y: number } {
  let x = m.meanTx
  let y = m.meanTy
  const { meanX, betaX, betaY } = m
  for (let j = 0; j < m.d; j++) {
    const v = f[j] - meanX[j]
    x += v * betaX[j]
    y += v * betaY[j]
  }
  return { x, y }
}
