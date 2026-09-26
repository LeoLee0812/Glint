// 视线信号处理：One Euro 平滑（静止时稳、扫视时跟得上）+ 在线 I-DT 注视检测

class LowPass {
  private y: number | null = null
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y
    return this.y
  }
  last(): number | null {
    return this.y
  }
  reset(): void {
    this.y = null
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff)
  return 1 / (1 + tau / dt)
}

/** One Euro Filter（Casiez 2012），单通道 */
export class OneEuro {
  private x = new LowPass()
  private dx = new LowPass()
  private tPrev: number | null = null
  constructor(public minCutoff = 0.6, public beta = 0.004, public dCutoff = 1.0) {}

  filter(value: number, tMs: number): number {
    if (this.tPrev === null) {
      this.tPrev = tMs
      this.dx.filter(0, 1)
      return this.x.filter(value, 1)
    }
    const dt = Math.max(1e-3, (tMs - this.tPrev) / 1000)
    this.tPrev = tMs
    const prev = this.x.last() ?? value
    const edx = this.dx.filter((value - prev) / dt, alpha(this.dCutoff, dt))
    const cutoff = this.minCutoff + this.beta * Math.abs(edx)
    return this.x.filter(value, alpha(cutoff, dt))
  }

  reset(): void {
    this.x.reset()
    this.dx.reset()
    this.tPrev = null
  }
}

export class OneEuro2D {
  private fx: OneEuro
  private fy: OneEuro
  constructor(minCutoff = 0.6, beta = 0.004) {
    this.fx = new OneEuro(minCutoff, beta)
    this.fy = new OneEuro(minCutoff, beta)
  }
  setParams(minCutoff: number, beta: number): void {
    this.fx.minCutoff = this.fy.minCutoff = minCutoff
    this.fx.beta = this.fy.beta = beta
  }
  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) }
  }
  reset(): void {
    this.fx.reset()
    this.fy.reset()
  }
}

export interface Fixation {
  id: number
  x: number
  y: number
  start: number
  duration: number
}

type FixEvent = { kind: 'start' | 'update' | 'end'; fix: Fixation }

/**
 * 在线注视检测：最近 minDur 毫秒内的点都落在半径 radius 内 → 开始一次注视；
 * 之后新点离质心超过 radius*1.3 就结束。摄像头眼动噪声大，半径要给足。
 */
export class FixationDetector {
  private pts: Array<{ x: number; y: number; t: number }> = []
  private cur: Fixation | null = null
  private sumX = 0
  private sumY = 0
  private n = 0
  private seq = 0
  constructor(public radius = 95, public minDur = 140) {}

  push(x: number, y: number, t: number): FixEvent | null {
    if (this.cur) {
      const dx = x - this.cur.x
      const dy = y - this.cur.y
      if (Math.hypot(dx, dy) <= this.radius * 1.3) {
        this.sumX += x
        this.sumY += y
        this.n++
        this.cur.x = this.sumX / this.n
        this.cur.y = this.sumY / this.n
        this.cur.duration = t - this.cur.start
        return { kind: 'update', fix: { ...this.cur } }
      }
      const ended = { ...this.cur }
      this.cur = null
      this.pts = [{ x, y, t }]
      return { kind: 'end', fix: ended }
    }
    this.pts.push({ x, y, t })
    while (this.pts.length && t - this.pts[0].t > this.minDur * 1.6) this.pts.shift()
    if (this.pts.length < 3 || t - this.pts[0].t < this.minDur) return null
    const cx = this.pts.reduce((a, p) => a + p.x, 0) / this.pts.length
    const cy = this.pts.reduce((a, p) => a + p.y, 0) / this.pts.length
    const within = this.pts.every((p) => Math.hypot(p.x - cx, p.y - cy) <= this.radius)
    if (!within) {
      this.pts.shift()
      return null
    }
    this.seq++
    this.sumX = cx * this.pts.length
    this.sumY = cy * this.pts.length
    this.n = this.pts.length
    this.cur = { id: this.seq, x: cx, y: cy, start: this.pts[0].t, duration: t - this.pts[0].t }
    this.pts = []
    return { kind: 'start', fix: { ...this.cur } }
  }

  current(): Fixation | null {
    return this.cur ? { ...this.cur } : null
  }

  reset(): void {
    this.pts = []
    this.cur = null
  }
}
