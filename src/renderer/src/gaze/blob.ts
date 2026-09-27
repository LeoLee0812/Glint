// 视线光环：一圈会变形的「果冻」光环，代替死板的圆圈（参考 Fovea 的视线指示）
// - 一圈 N 个节点，各自用弹簧追自己的静止位置：朝运动方向的节点弹簧硬、背后的软，
//   扫视时整圈被拉成泪滴 / 长椭圆，停下来再回弹成圆，带一点果冻般的过冲
// - 静止形状本身也在缓慢起伏（几路不同频率的正弦叠加），盯住时轻轻「呼吸」
// - 吸附：给一个目标矩形，光环圆心被拉过去，形状从圆渐变成包住目标的圆角矩形（超椭圆）；
//   lock = 完全包住（硬焦点），否则按 strength 部分吸过去（软吸附到关键词）
// 不依赖任何应用状态

export interface BlobBox {
  x: number
  y: number
  width: number
  height: number
}

export interface BlobTarget {
  /** 视线点，和画布同一坐标系（CSS 像素） */
  x: number
  y: number
  visible: boolean
  /** 吸附目标 */
  magnet?: BlobBox | null
  /** 0~1：吸附力度；lock 时忽略，直接 1 */
  strength?: number
  lock?: boolean
  /** 0~1：视线质量（没有原始样本 / 眨眼时降低），用来调透明度 */
  confidence?: number
}

const N = 36
const BASE_R = 30
const PAD = 7
const MAX_LAG = 42

type V2 = { x: number; y: number }

export class GazeBlob {
  private ctx: CanvasRenderingContext2D
  private nodes: Array<{ p: V2; v: V2 }> = []
  private c: V2 = { x: 0, y: 0 }
  private cv: V2 = { x: 0, y: 0 }
  private attract = 0
  private alpha = 0
  private shownOnce = false
  private box: BlobBox | null = null
  private raf = 0
  private last = 0
  private dpr = 1
  private cleared = true
  private t0 = performance.now()

  constructor(
    private canvas: HTMLCanvasElement,
    private source: () => BlobTarget
  ) {
    this.ctx = canvas.getContext('2d')!
    for (let i = 0; i < N; i++) this.nodes.push({ p: { x: 0, y: 0 }, v: { x: 0, y: 0 } })
  }

  start(): void {
    this.resize()
    window.addEventListener('resize', this.resize)
    const loop = (now: number) => {
      this.frame(now)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
  }

  private resize = (): void => {
    this.dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(window.innerWidth * this.dpr)
    this.canvas.height = Math.round(window.innerHeight * this.dpr)
    this.cleared = false
  }

  /** 角度 θ 上的静止偏移：圆（带起伏）和包住目标的超椭圆之间插值 */
  private restOffset(i: number, t: number, speed: number): V2 {
    const th = (i / N) * Math.PI * 2
    const cos = Math.cos(th)
    const sin = Math.sin(th)
    // 盯住时呼吸，移动时起伏更明显
    const breathe = 1 + 0.035 * Math.sin(t * 2.1)
    const wob =
      0.07 * Math.sin(2 * th + t * 1.3) +
      0.05 * Math.sin(3 * th - t * 0.9 + 1) +
      0.03 * Math.sin(5 * th + t * 2.3 + 2) +
      Math.min(0.06, speed / 12000) * Math.sin(4 * th + t * 7)
    const r = BASE_R * breathe * (1 + wob)
    const circ = { x: cos * r, y: sin * r }
    const a = this.attract
    const b = this.box
    if (!b || a < 0.001) return circ
    // 超椭圆 |x/w|^n + |y/h|^n = 1，n=5 接近 iOS 的连续圆角
    const hw = b.width / 2 + PAD
    const hh = b.height / 2 + PAD
    const e = 2 / 5
    const sw = 1 + 0.015 * Math.sin(3 * th + t * 1.7)
    const sq = {
      x: Math.sign(cos) * Math.pow(Math.abs(cos), e) * hw * sw,
      y: Math.sign(sin) * Math.pow(Math.abs(sin), e) * hh * sw
    }
    return { x: circ.x + (sq.x - circ.x) * a, y: circ.y + (sq.y - circ.y) * a }
  }

  private frame(now: number): void {
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - (this.last || now)) / 1000 || 1 / 60))
    this.last = now
    const tg = this.source()
    const t = (now - this.t0) / 1000

    // 透明度淡入淡出
    const wantAlpha = tg.visible ? 0.35 + 0.65 * (tg.confidence ?? 1) : 0
    this.alpha += (wantAlpha - this.alpha) * Math.min(1, dt * (tg.visible ? 10 : 6))
    if (this.alpha < 0.01 && !tg.visible) {
      if (!this.cleared) {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0)
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.cleared = true
      }
      this.shownOnce = false
      return
    }

    // 吸附力度（平滑过渡，吸上去快、松开稍慢）
    const wantA = tg.magnet ? (tg.lock ? 1 : Math.max(0, Math.min(1, tg.strength ?? 0))) : 0
    if (tg.magnet) {
      // 目标框本身也平滑移动，换词时光环是滑过去的
      if (!this.box || this.attract < 0.02) this.box = { ...tg.magnet }
      else {
        const k = Math.min(1, dt * 18)
        this.box.x += (tg.magnet.x - this.box.x) * k
        this.box.y += (tg.magnet.y - this.box.y) * k
        this.box.width += (tg.magnet.width - this.box.width) * k
        this.box.height += (tg.magnet.height - this.box.height) * k
      }
    }
    this.attract += (wantA - this.attract) * Math.min(1, dt * (wantA > this.attract ? 9 : 5))
    if (this.attract < 0.002 && !tg.magnet) this.box = null

    // 圆心目标：视线点和目标框中心之间
    const b = this.box
    const ct =
      b && this.attract > 0
        ? {
            x: tg.x + (b.x + b.width / 2 - tg.x) * this.attract,
            y: tg.y + (b.y + b.height / 2 - tg.y) * this.attract
          }
        : { x: tg.x, y: tg.y }

    if (!this.shownOnce) {
      // 第一次出现：直接放到位，不从左上角飞过来
      this.c = { ...ct }
      this.cv = { x: 0, y: 0 }
      for (let i = 0; i < N; i++) {
        const o = this.restOffset(i, t, 0)
        this.nodes[i].p = { x: ct.x + o.x, y: ct.y + o.y }
        this.nodes[i].v = { x: 0, y: 0 }
      }
      this.shownOnce = true
    }

    // 圆心：接近临界阻尼的弹簧
    const kc = 220
    const dc = 2 * Math.sqrt(kc) * 0.92
    this.cv.x += ((ct.x - this.c.x) * kc - this.cv.x * dc) * dt
    this.cv.y += ((ct.y - this.c.y) * kc - this.cv.y * dc) * dt
    this.c.x += this.cv.x * dt
    this.c.y += this.cv.y * dt
    const speed = Math.hypot(this.cv.x, this.cv.y)
    const dir = speed > 1 ? { x: this.cv.x / speed, y: this.cv.y / speed } : { x: 0, y: 0 }
    const stretch = Math.min(1, speed / 900)

    // 节点：前沿硬、尾巴软 → 扫视时拉长；阻尼偏小 → 停下时果冻般回弹
    const sub = 2
    const h = dt / sub
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < N; i++) {
        const nd = this.nodes[i]
        const o = this.restOffset(i, t, speed)
        const rx = this.c.x + o.x
        const ry = this.c.y + o.y
        const ol = Math.hypot(o.x, o.y) || 1
        const lead = ((o.x / ol) * dir.x + (o.y / ol) * dir.y) * stretch
        const k = Math.max(45, 170 * (1 + 0.9 * lead)) * (1 + this.attract * 0.8)
        const d = 2 * Math.sqrt(k) * (0.5 + this.attract * 0.35)
        nd.v.x += ((rx - nd.p.x) * k - nd.v.x * d) * h
        nd.v.y += ((ry - nd.p.y) * k - nd.v.y * d) * h
        nd.p.x += nd.v.x * h
        nd.p.y += nd.v.y * h
        // 尾巴最多拖出去 MAX_LAG，扫视再快也只是拉成泪滴，不会甩成一条长线
        const lx = nd.p.x - rx
        const ly = nd.p.y - ry
        const lag = Math.hypot(lx, ly)
        if (lag > MAX_LAG) {
          nd.p.x = rx + (lx / lag) * MAX_LAG
          nd.p.y = ry + (ly / lag) * MAX_LAG
          nd.v.x *= 0.6
          nd.v.y *= 0.6
        }
      }
    }

    this.draw()
  }

  private tracePath(): void {
    const ctx = this.ctx
    const p = this.nodes.map((n) => n.p)
    // 闭合 Catmull-Rom 转三次贝塞尔，保证光滑
    ctx.beginPath()
    ctx.moveTo(p[0].x, p[0].y)
    for (let i = 0; i < N; i++) {
      const p0 = p[(i - 1 + N) % N]
      const p1 = p[i]
      const p2 = p[(i + 1) % N]
      const p3 = p[(i + 2) % N]
      ctx.bezierCurveTo(
        p1.x + (p2.x - p0.x) / 6,
        p1.y + (p2.y - p0.y) / 6,
        p2.x - (p3.x - p1.x) / 6,
        p2.y - (p3.y - p1.y) / 6,
        p2.x,
        p2.y
      )
    }
    ctx.closePath()
  }

  private draw(): void {
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.cleared = false
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const a = this.alpha
    const lockA = this.attract
    this.tracePath()
    // 淡淡的内填充，吸住目标时稍微加深
    ctx.fillStyle = `rgba(30, 170, 240, ${(0.04 + 0.06 * lockA) * a})`
    ctx.fill()
    // 外发光主描边
    ctx.lineJoin = 'round'
    ctx.shadowColor = `rgba(30, 170, 240, ${0.6 * a})`
    ctx.shadowBlur = 14
    ctx.strokeStyle = `rgba(30, 170, 240, ${0.9 * a})`
    ctx.lineWidth = 6.5 - 3.5 * lockA
    ctx.stroke()
    // 描边中间一道白色高光，像玻璃边；包住词时描边变细，高光随之淡掉，免得看成两道线
    const hi = (1 - lockA) * 0.5 * a
    if (hi > 0.02) {
      ctx.shadowBlur = 0
      ctx.strokeStyle = `rgba(255, 255, 255, ${hi})`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
  }
}
