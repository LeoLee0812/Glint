// 扫描版 PDF（页面只是一张图、没有文字层）的版面切块：只看像素里「文字的影子」（墨迹），
// 先把扫歪的页面摆正，找栏间的竖白缝，把页面切成若干「栏片区」（通栏的标题 / 大图把栏截断的地方另起一片），
// 再在每个片区里按横向投影切出行，行 → 段（段间空白、首行缩进、上一行没写满、字号变化），
// 图、表单独成块，居中且带编号的行当公式。
// 不按固定份数切：一页双栏论文通常切出十来块，每块就是一段 / 一张图 / 一个表 / 一个公式；
// 栏片区是更粗的一档（「节」粒度 = 这一栏）。纯函数、不碰 DOM：PDF 视图的 worker 和 Node 离线测试共用

export type VisualKind = 'text' | 'figure' | 'table' | 'formula'

/** 归一化到页面宽高（0~1）的框 */
export interface VBox {
  x: number
  y: number
  w: number
  h: number
}

export interface VisualBlock extends VBox {
  kind: VisualKind
  /** 块里的文字行，从上到下（图没有行） */
  lines: VBox[]
  /** 属于第几个栏片区（阅读顺序）：同一栏里、上下两个通栏元素之间的那一片 */
  zone: number
}

export interface VisualLayout {
  /** 按阅读顺序：片区从上到下、同一带里先左栏后右栏，片区里从上到下 */
  blocks: VisualBlock[]
  zones: VBox[]
  /** 正文行高（归一化到页面高度） */
  lineH: number
  columns: number
  /** 页面扫歪了多少度（顺时针为正） */
  skew: number
  /** 墨迹像素占比 */
  ink: number
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

type LineKind = 'text' | 'rule' | 'graphic' | 'formula' | 'tabular'

interface Line extends Rect {
  ink: number
  /** 细长横线（方框的上下边、坐标轴）出现的最高、最低位置，没有就是 -1 */
  thinTop: number
  thinBottom: number
  kind: LineKind
  /** 行内比 1.4 个字宽还宽的空白有几处（表格的列缝、公式编号前的空） */
  gaps: number
  /** 墨迹密度：墨点数 / 外接框面积 */
  rho: number
}

interface RawBlock extends Rect {
  kind: VisualKind
  lines: Line[]
}

const EMPTY: VisualLayout = { blocks: [], zones: [], lineH: 0, columns: 0, skew: 0, ink: 0 }
const DEG = Math.PI / 180

function quantile(a: number[], q: number): number {
  if (!a.length) return 0
  const s = [...a].sort((p, r) => p - r)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * q)))]
}

// ---------- 二值化、去边、摆正 ----------

/** Otsu 阈值：扫描件的纸色、墨色都不固定，按直方图自己找分界；再夹一下，浅灰的底纹不算墨 */
function binarize(gray: ArrayLike<number>, n: number): { bin: Uint8Array; ink: number } {
  const hist = new Float64Array(256)
  for (let i = 0; i < n; i++) hist[gray[i]]++
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = -1
  let thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += t * hist[t]
    const d = sumB / wB - (sum - sumB) / wF
    const between = wB * wF * d * d
    if (between > best) {
      best = between
      thr = t
    }
  }
  thr = Math.max(60, Math.min(200, thr))
  const bin = new Uint8Array(n)
  let ink = 0
  for (let i = 0; i < n; i++) {
    if (gray[i] <= thr) {
      bin[i] = 1
      ink++
    }
  }
  return { bin, ink: ink / n }
}

/** 去掉孤立的噪点像素（八邻域都没墨） */
function despeckle(bin: Uint8Array, W: number, H: number): void {
  for (let y = 1; y < H - 1; y++) {
    const r = y * W
    for (let x = 1; x < W - 1; x++) {
      const i = r + x
      if (!bin[i]) continue
      if (bin[i - 1] | bin[i + 1] | bin[i - W] | bin[i + W] | bin[i - W - 1] | bin[i - W + 1] | bin[i + W - 1] | bin[i + W + 1]) continue
      bin[i] = 0
    }
  }
}

function rowCounts(bin: Uint8Array, W: number, r: Rect): Int32Array {
  const out = new Int32Array(r.y1 - r.y0)
  for (let y = r.y0; y < r.y1; y++) {
    let k = 0
    const row = y * W
    for (let x = r.x0; x < r.x1; x++) k += bin[row + x]
    out[y - r.y0] = k
  }
  return out
}

function colCounts(bin: Uint8Array, W: number, r: Rect): Int32Array {
  const out = new Int32Array(r.x1 - r.x0)
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * W
    for (let x = r.x0; x < r.x1; x++) out[x - r.x0] += bin[row + x]
  }
  return out
}

/** 收紧到墨迹范围；每行 / 每列只有一两个像素的当噪点 */
function trim(bin: Uint8Array, W: number, r: Rect, tolFrac = 0.002): Rect | null {
  if (r.x1 <= r.x0 || r.y1 <= r.y0) return null
  const rows = rowCounts(bin, W, r)
  const tolR = Math.floor((r.x1 - r.x0) * tolFrac)
  let a = 0
  while (a < rows.length && rows[a] <= tolR) a++
  let b = rows.length
  while (b > a && rows[b - 1] <= tolR) b--
  if (a >= b) return null
  const r2: Rect = { x0: r.x0, y0: r.y0 + a, x1: r.x1, y1: r.y0 + b }
  const cols = colCounts(bin, W, r2)
  const tolC = Math.floor((r2.y1 - r2.y0) * tolFrac)
  let c = 0
  while (c < cols.length && cols[c] <= tolC) c++
  let d = cols.length
  while (d > c && cols[d - 1] <= tolC) d--
  if (c >= d) return null
  return { x0: r.x0 + c, y0: r2.y0, x1: r.x0 + d, y1: r2.y1 }
}

/** 从页边往里：扫描仪留下的黑边 / 阴影（贴着页边、几乎整行整列都是墨）跳过去，返回内容从哪开始 */
function edgeBand(ratio: (i: number) => number, n: number): number {
  const lim = Math.floor(n * 0.1)
  let i = 0
  const white0 = Math.floor(n * 0.006)
  while (i < white0 && ratio(i) < 0.35) i++
  if (ratio(i) < 0.35) return 0
  while (i < lim && ratio(i) >= 0.2) i++
  return i < lim ? i + 2 : 0
}

/** 去掉扫描黑边后的内容范围；黑边那几行几列顺手清成白的，后面摆正时不会转进来 */
function contentBox(bin: Uint8Array, W: number, H: number): Rect | null {
  const rows = rowCounts(bin, W, { x0: 0, y0: 0, x1: W, y1: H })
  const cols = colCounts(bin, W, { x0: 0, y0: 0, x1: W, y1: H })
  const top = edgeBand((i) => rows[i] / W, H)
  const bottom = edgeBand((i) => rows[H - 1 - i] / W, H)
  const left = edgeBand((i) => cols[i] / H, W)
  const right = edgeBand((i) => cols[W - 1 - i] / H, W)
  if (top || bottom || left || right) {
    for (let y = 0; y < H; y++) {
      const r = y * W
      if (y < top || y >= H - bottom) bin.fill(0, r, r + W)
      else {
        if (left) bin.fill(0, r, r + left)
        if (right) bin.fill(0, r + W - right, r + W)
      }
    }
  }
  return trim(bin, W, { x0: left, y0: top, x1: W - right, y1: H - bottom })
}

/**
 * 估计扫歪的角度：把墨迹点沿不同角度投到竖直方向，角度对了一行行字会叠成尖峰（平方和最大）。
 * 先 ±2° 粗搜再细搜；返回弧度，文字行满足 y ≈ y0 + (x - cx)·tan(角度)
 */
function estimateSkew(bin: Uint8Array, W: number, c: Rect): number {
  let n = 0
  for (let y = c.y0; y < c.y1; y += 2) {
    const r = y * W
    for (let x = c.x0; x < c.x1; x += 2) n += bin[r + x]
  }
  if (n < 400) return 0
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  let k = 0
  const xc = (c.x0 + c.x1) / 2
  for (let y = c.y0; y < c.y1; y += 2) {
    const r = y * W
    for (let x = c.x0; x < c.x1; x += 2) {
      if (bin[r + x]) {
        xs[k] = x - xc
        ys[k] = y - c.y0
        k++
      }
    }
  }
  // 按 2 像素一格分箱：采样本来就隔行取的，按 1 像素分箱时 0° 会只落在偶数格里，平方和凭空翻倍
  const pad = Math.ceil(((c.x1 - c.x0) * Math.tan(2.5 * DEG)) / 2) + 2
  const counts = new Int32Array(Math.ceil((c.y1 - c.y0) / 2) + pad * 2)
  const score = (deg: number): number => {
    const t = Math.tan(deg * DEG)
    counts.fill(0)
    for (let i = 0; i < n; i++) counts[Math.round((ys[i] - xs[i] * t) / 2) + pad]++
    let s = 0
    for (let i = 0; i < counts.length; i++) s += counts[i] * counts[i]
    return s
  }
  const s0 = score(0)
  let best = 0
  let bestS = s0
  for (let d = -2; d <= 2.0001; d += 0.2) {
    const s = score(d)
    if (s > bestS) {
      bestS = s
      best = d
    }
  }
  const c0 = best
  for (let d = c0 - 0.2; d <= c0 + 0.2001; d += 0.04) {
    const s = score(d)
    if (s > bestS) {
      bestS = s
      best = d
    }
  }
  // 提升不明显（图多字少的页）就当没歪
  return bestS > s0 * 1.03 ? best * DEG : 0
}

/** 绕 (cx, cy) 把页面转正（逆映射、最近邻，不会有空洞） */
function rotate(bin: Uint8Array, W: number, H: number, a: number, cx: number, cy: number): Uint8Array {
  const out = new Uint8Array(W * H)
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  for (let y = 0; y < H; y++) {
    // 转正后的 (x', y) 来自原图 (cx + (x'-cx)cos - (y-cy)sin, cy + (x'-cx)sin + (y-cy)cos)
    let sx = cx - cx * cos - (y - cy) * sin
    let sy = cy - cx * sin + (y - cy) * cos
    const r = y * W
    for (let x = 0; x < W; x++, sx += cos, sy += sin) {
      const ix = Math.round(sx)
      const iy = Math.round(sy)
      if (ix >= 0 && ix < W && iy >= 0 && iy < H && bin[iy * W + ix]) out[r + x] = 1
    }
  }
  return out
}

// ---------- 行高 ----------

/** 在一排窄竖条里数墨迹段的高度：中位数 ≈ 正文一行字的高度，行间白缝的中位数 ≈ 行距空白 */
function estimateLine(bin: Uint8Array, W: number, H: number, c: Rect): { lineH: number; gap: number } {
  const cw = c.x1 - c.x0
  const sw = Math.max(6, Math.round(cw / 50))
  const S = 24
  const inks: number[] = []
  const gaps: number[] = []
  for (let s = 0; s < S; s++) {
    const sx = Math.round(c.x0 + ((cw - sw) * (s + 0.5)) / S)
    let run = 0
    let gap = 0
    let seen = false
    for (let y = c.y0; y < c.y1; y++) {
      let k = 0
      const row = y * W
      for (let x = sx; x < sx + sw; x++) k += bin[row + x]
      if (k > 0) {
        if (gap && seen) gaps.push(gap)
        gap = 0
        run++
        seen = true
      } else {
        if (run) inks.push(run)
        run = 0
        gap++
      }
    }
    if (run) inks.push(run)
  }
  const maxH = (c.y1 - c.y0) * 0.06
  const hs = inks.filter((v) => v >= 3 && v <= maxH)
  // 窄竖条里常只碰到不带上下伸笔画的字母（只有 x 高），取偏高的分位数才接近一整行字的高度
  const lineH = hs.length >= 8 ? quantile(hs, 0.7) : Math.max(8, H * 0.012)
  const gs = gaps.filter((v) => v <= lineH * 1.5)
  const gap = gs.length >= 8 ? quantile(gs, 0.5) : Math.max(2, lineH * 0.3)
  return { lineH, gap }
}

// ---------- 栏 ----------

type Gutter = { x0: number; x1: number }

/**
 * 找栏间竖白缝：把页面横着切成一片片（每片约 5 行字），数每个 x 在多少片里落在「两边都有墨、宽度够一栏间距」的白缝里。
 * 双栏正文那几片，栏缝处几乎片片都是白的；通栏的标题、大图那几片会把它盖住，所以只要求一部分片是白的。
 * 再验一遍：大部分有字的行都压过这条缝（单栏正文里碰巧对齐的表格空隙），就不是栏缝
 */
function findGutters(bin: Uint8Array, W: number, c: Rect, lineH: number): Gutter[] {
  const cw = c.x1 - c.x0
  if (cw < lineH * 12) return []
  const sliceH = Math.max(12, Math.round(lineH * 5))
  const G = Math.max(4, Math.round(lineH * 0.7))
  const score = new Float32Array(cw)
  let slices = 0
  for (let y = c.y0; y < c.y1; y += sliceH) {
    const s: Rect = { x0: c.x0, y0: y, x1: c.x1, y1: Math.min(c.y1, y + sliceH) }
    const cols = colCounts(bin, W, s)
    let covered = 0
    for (let x = 0; x < cw; x++) if (cols[x] > 0) covered++
    // 只有一两个字的片（页码、页眉）不算数
    if (covered < cw * 0.3) continue
    slices++
    let last = -1
    for (let x = 0; x < cw; x++) {
      if (!cols[x]) continue
      if (last >= 0 && x - last - 1 >= G) for (let k = last + 1; k < x; k++) score[k]++
      last = x
    }
  }
  if (slices < 3) return []
  for (let x = 0; x < cw; x++) score[x] /= slices
  // 论文首页上半截是通栏的标题摘要，双栏只占下面一小段，所以门槛放得低，靠后面的验证把关
  const lo = Math.floor(cw * 0.12)
  const hi = Math.ceil(cw * 0.88)
  const found: Array<Gutter & { s: number }> = []
  let x = lo
  while (x < hi) {
    if (score[x] < 0.15) {
      x++
      continue
    }
    let e = x
    let peak = 0
    while (e < hi && score[e] >= 0.15) peak = Math.max(peak, score[e++])
    let a = x
    let b = e
    while (a < b && score[a] < peak * 0.8) a++
    while (b > a && score[b - 1] < peak * 0.8) b--
    // 真栏缝至少有大半行字那么宽（LaTeX 双栏默认 10pt 间距）；再窄多半是几行字的词间空格碰巧对齐
    if (b - a >= Math.max(3, lineH * 0.8) && slices * peak >= 3) found.push({ x0: c.x0 + a, x1: c.x0 + b, s: peak })
    x = e
  }
  found.sort((p, q) => q.s - p.s)
  const valid = found.filter((f) => validGutter(bin, W, c, f, lineH))
  const rel = (f: Gutter) => ((f.x0 + f.x1) / 2 - c.x0) / cw
  const bare = (f: Gutter): Gutter => ({ x0: f.x0, x1: f.x1 })
  // 只认两种栏式：三栏（两条缝各在 1/3、2/3 附近）或两栏（缝在中间一带）；栏里的表格、公式留下的空隙不会恰好落在这些位置
  const t1 = valid.find((f) => Math.abs(rel(f) - 1 / 3) < 0.08)
  const t2 = valid.find((f) => Math.abs(rel(f) - 2 / 3) < 0.08)
  if (t1 && t2 && Math.min(t1.s, t2.s) >= 0.3) return [bare(t1), bare(t2)]
  const two = valid.find((f) => rel(f) > 0.3 && rel(f) < 0.7)
  return two ? [bare(two)] : []
}

/**
 * 整个内容宽度上按行切出一段段墨迹（双栏正文两边的行错开时会连成一大段），逐段看有没有压过栏缝：
 * 缝中间有墨，或者缝那儿的空白比栏缝窄得多（其实是一行通栏的字，缝正好落在词间空格上），都算压过
 */
function crossRuns(bin: Uint8Array, W: number, c: Rect, gutters: Gutter[]): Array<{ a: number; b: number; cross: boolean }> {
  const rows = rowCounts(bin, W, c)
  const n = rows.length
  const out: Array<{ a: number; b: number; cross: boolean }> = []
  let a = -1
  for (let y = 0; y <= n; y++) {
    if (y < n && rows[y] > 0) {
      if (a < 0) a = y
      continue
    }
    if (a < 0) continue
    let cross = false
    for (const g of gutters) {
      const gw = g.x1 - g.x0
      const lo = Math.max(c.x0, g.x0 - gw)
      const hi = Math.min(c.x1, g.x1 + gw)
      const cols = colCounts(bin, W, { x0: lo, y0: c.y0 + a, x1: hi, y1: c.y0 + y })
      const mid = Math.round((g.x0 + g.x1) / 2) - lo
      if (cols[mid] > 0) cross = true
      else {
        let l = mid
        while (l > 0 && !cols[l - 1]) l--
        let r = mid
        while (r < cols.length - 1 && !cols[r + 1]) r++
        if (l > 0 && r < cols.length - 1 && r - l + 1 < gw * 0.7) cross = true
      }
      if (cross) break
    }
    out.push({ a: c.y0 + a, b: c.y0 + y, cross })
    a = -1
  }
  return out
}

/**
 * 验证栏缝：
 * 1) 得有连续好几行都不压缝的一大片，至少五行字、占内容高度的一成八
 *    （单栏正文里碰巧对齐的空隙，几乎每行字都会压过去；栏里一个小表格留下的空隙没这么高）；
 * 2) 那一片里缝两边都是满满的正文：左右两侧几乎每个 x 上都有字（表格、公式组的列之间是整条的空白）
 */
function validGutter(bin: Uint8Array, W: number, c: Rect, g: Gutter, lineH: number): boolean {
  let best = { a: 0, b: 0 }
  let start = -1
  for (const r of crossRuns(bin, W, c, [g])) {
    if (r.cross) {
      start = -1
      continue
    }
    if (start < 0) start = r.a
    if (r.b - start > best.b - best.a) best = { a: start, b: r.b }
  }
  if (best.b - best.a < Math.max(lineH * 5, (c.y1 - c.y0) * 0.18)) return false
  const covered = (x0: number, x1: number): number => {
    if (x1 - x0 < lineH * 4) return 0
    const cols = colCounts(bin, W, { x0, y0: best.a, x1, y1: best.b })
    let k = 0
    for (let x = 0; x < cols.length; x++) if (cols[x] > 0) k++
    return k / cols.length
  }
  return covered(c.x0, g.x0) >= 0.9 && covered(g.x1, c.x1) >= 0.9
}

/**
 * 按栏缝把页面分成栏片区：压过栏缝的那几段（通栏标题、跨栏大图、页眉线）是通栏片区，
 * 其余的带按栏缝左右切开。阅读顺序：带从上到下，同一带里从左到右。
 * 夹在两段通栏中间、只有一两行字的那一带并进通栏（通栏段落没写满的末行、标题摘要里偶尔有一行没压到缝），
 * 一两行字成不了双栏
 */
function buildZones(bin: Uint8Array, W: number, c: Rect, gutters: Gutter[]): Rect[] {
  if (!gutters.length) return [c]
  const runs = crossRuns(bin, W, c, gutters)
  const full: Array<[number, number]> = []
  let calm: Array<{ a: number; b: number }> = []
  for (const r of runs) {
    if (!r.cross) {
      calm.push(r)
      continue
    }
    const last = full[full.length - 1]
    if (last && calm.length <= 2) last[1] = r.b
    else full.push([r.a, r.b])
    calm = []
  }
  if (!full.length) return columnsOf(c, gutters, c.y0, c.y1)
  const zones: Rect[] = []
  let cur = c.y0
  for (const [a, b] of full) {
    if (a > cur) zones.push(...columnsOf(c, gutters, cur, a))
    zones.push({ x0: c.x0, y0: a, x1: c.x1, y1: b })
    cur = b
  }
  if (cur < c.y1) zones.push(...columnsOf(c, gutters, cur, c.y1))
  return zones
}

function columnsOf(c: Rect, gutters: Gutter[], y0: number, y1: number): Rect[] {
  const out: Rect[] = []
  let x = c.x0
  for (const g of gutters) {
    out.push({ x0: x, y0, x1: g.x0, y1 })
    x = g.x1
  }
  out.push({ x0: x, y0, x1: c.x1, y1 })
  return out
}

// ---------- 片区里：行 → 块 ----------

/**
 * 横向投影切行：连续有墨的行是一「行」，记下左右边界；行距很紧、上一行的下伸部分碰到下一行的上伸部分时，
 * 两行会粘成一段，在墨迹最少的那条缝上切开。
 * 顺带找细长横线（长过好几个字、上下两侧都空——方框的上下边、坐标轴），给认流程图用；
 * 小号衬线字扫描后笔画会粘成长条，但它上面或下面总挨着字身，不算细线
 */
function zoneLines(bin: Uint8Array, W: number, H: number, z: Rect, lineH: number): Line[] {
  const tol = z.x1 - z.x0 > 400 ? 1 : 0
  const minLong = Math.round(lineH * 5)
  const d = Math.max(2, Math.round(lineH * 0.2))
  const frac = (y: number, a: number, b: number): number => {
    if (y < 0 || y >= H) return 0
    let k = 0
    const r = y * W
    for (let x = a; x < b; x++) k += bin[r + x]
    return k / (b - a)
  }
  const n = z.y1 - z.y0
  const cnt = new Int32Array(n)
  const first = new Int32Array(n)
  const last = new Int32Array(n)
  // 每行里细长横线的总长度
  const thin = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const y = z.y0 + i
    const r = y * W
    let k = 0
    let f = -1
    let l = -1
    let run = 0
    for (let x = z.x0; x <= z.x1; x++) {
      if (x < z.x1 && bin[r + x]) {
        k++
        if (f < 0) f = x
        l = x
        run++
        continue
      }
      if (run >= minLong && frac(y - d, x - run, x) < 0.3 && frac(y + d, x - run, x) < 0.3) thin[i] += run
      run = 0
    }
    cnt[i] = k
    first[i] = f
    last[i] = l
  }
  const make = (a: number, b: number): Line => {
    const line: Line = { x0: Infinity, y0: z.y0 + a, x1: -Infinity, y1: z.y0 + b, ink: 0, thinTop: -1, thinBottom: -1, kind: 'text', gaps: 0, rho: 0 }
    for (let i = a; i < b; i++) {
      if (cnt[i] <= tol) continue
      line.x0 = Math.min(line.x0, first[i])
      line.x1 = Math.max(line.x1, last[i] + 1)
      line.ink += cnt[i]
    }
    // 细横线要占到这一行宽度的四成以上才算框线（一排方框的上下边）；粗体字偶尔粘出的一截不算
    for (let i = a; i < b; i++) {
      if (thin[i] < (line.x1 - line.x0) * 0.4) continue
      if (line.thinTop < 0) line.thinTop = z.y0 + i
      line.thinBottom = z.y0 + i
    }
    return line
  }
  const out: Line[] = []
  let a = -1
  for (let i = 0; i <= n; i++) {
    if (i < n && cnt[i] > tol) {
      if (a < 0) a = i
      continue
    }
    if (a < 0) continue
    // 两三行粘在一起（高 1.6~3.4 行）：墨迹最少、不到常见行两成的那几行就是行缝
    const h = i - a
    if (h >= lineH * 1.6 && h <= lineH * 3.4) {
      const seg = Array.from(cnt.subarray(a, i)).sort((p, q) => p - q)
      const ref = seg[Math.floor(seg.length * 0.75)]
      const edge = Math.round(lineH * 0.6)
      let s = a
      let k = a + edge
      while (k < i - edge) {
        if (cnt[k] > ref * 0.2) {
          k++
          continue
        }
        let m = k
        let e = k
        while (e < i - edge && cnt[e] <= ref * 0.2) {
          if (cnt[e] < cnt[m]) m = e
          e++
        }
        if (m - s >= edge) {
          out.push(make(s, m))
          s = m
        }
        k = e + edge
      }
      out.push(make(s, i))
    } else out.push(make(a, i))
    a = -1
  }
  return out.filter((l) => l.x1 > l.x0)
}

function absorb(a: Line, b: Line): void {
  a.x0 = Math.min(a.x0, b.x0)
  a.y0 = Math.min(a.y0, b.y0)
  a.x1 = Math.max(a.x1, b.x1)
  a.y1 = Math.max(a.y1, b.y1)
  a.ink += b.ink
  if (b.thinTop >= 0) {
    a.thinTop = a.thinTop < 0 ? b.thinTop : Math.min(a.thinTop, b.thinTop)
    a.thinBottom = Math.max(a.thinBottom, b.thinBottom)
  }
}

/** 一行里比 minGap 宽的内部空白（按列投影），给认表格、认公式编号用 */
function innerGaps(bin: Uint8Array, W: number, l: Line, minGap: number): Array<[number, number]> {
  const cols = colCounts(bin, W, l)
  const out: Array<[number, number]> = []
  let last = -1
  for (let x = 0; x < cols.length; x++) {
    if (!cols[x]) continue
    if (last >= 0 && x - last - 1 >= minGap) out.push([l.x0 + last + 1, l.x0 + x])
    last = x
  }
  return out
}

function zoneBlocks(bin: Uint8Array, W: number, H: number, z: Rect, lineH: number, lineGap: number): RawBlock[] {
  let lines = zoneLines(bin, W, H, z, lineH)
  if (!lines.length) return []

  // 横线：够扁、够长、几乎是实心的（分隔线、表格线、粗的栏间分割线）
  const isRule = (l: Line) => {
    const h = l.y1 - l.y0
    const w = l.x1 - l.x0
    return h <= Math.max(3, lineH * 0.6) && w >= lineH * 2 && w >= h * 8 && l.ink >= w * h * 0.5
  }
  // i 上的点、重音、上下标这类矮碎片并进离得最近的那行
  const small = lineH * 0.4
  for (let pass = 0; pass < 2; pass++) {
    const out: Line[] = []
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (l.y1 - l.y0 >= small || isRule(l)) {
        out.push(l)
        continue
      }
      const prev = out[out.length - 1]
      const next = lines[i + 1]
      const dp = prev && !isRule(prev) ? l.y0 - prev.y1 : Infinity
      const dn = next && !isRule(next) ? next.y0 - l.y1 : Infinity
      if (Math.min(dp, dn) <= lineH * 0.35) {
        if (dp <= dn) absorb(prev, l)
        else absorb(next, l)
      } else if ((l.x1 - l.x0) * (l.y1 - l.y0) >= lineH * lineH * 0.3) out.push(l)
    }
    lines = out
  }

  // 这一片正文的左右边界：大部分行从哪开始、写到哪
  const wide = lines.filter((l) => l.x1 - l.x0 > (z.x1 - z.x0) * 0.5 && l.y1 - l.y0 < lineH * 2)
  const L = wide.length >= 2 ? quantile(wide.map((l) => l.x0), 0.1) : z.x0
  const R = wide.length >= 2 ? quantile(wide.map((l) => l.x1), 0.9) : z.x1
  const emOf = (l: Line) => Math.min(lineH * 1.3, Math.max(l.y1 - l.y0, lineH * 0.6))

  for (const l of lines) {
    const h = l.y1 - l.y0
    const w = l.x1 - l.x0
    l.rho = l.ink / Math.max(1, w * h)
    if (isRule(l)) {
      l.kind = 'rule'
      continue
    }
    const em = emOf(l)
    const gaps = h <= lineH * 6 ? innerGaps(bin, W, l, Math.round(em * 1.4)) : []
    l.gaps = gaps.length
    // 公式：缩进的一行，右边贴着栏边隔开一截窄窄的编号「(3)」（分式、求和号会把行撑高，所以不限行高到 6 行）
    const lastGap = gaps[gaps.length - 1]
    const eqNum = !!lastGap && l.x1 - lastGap[1] <= em * 3.5 && R - l.x1 <= em * 1.2 && lastGap[1] - lastGap[0] >= em * 1.6
    if (eqNum && l.x0 - L >= em && gaps.length <= 2 && h <= lineH * 6) l.kind = 'formula'
    else if (h > lineH * 2.6) l.kind = 'graphic'
    // 上下各有一道细长横线：一排方框（流程图）
    else if (h >= lineH * 1.3 && l.thinTop >= 0 && l.thinBottom - l.thinTop >= lineH * 0.8) l.kind = 'graphic'
    else if (gaps.length >= 2 && w > em * 6) l.kind = 'tabular'
    else l.kind = 'text'
  }

  // 「正文行」：够宽、墨迹密度正常、中间没有大空隙——图里的刻度、图例、稀疏的点都不是
  const bodyRho = quantile(
    lines.filter((l) => l.kind === 'text' && l.x1 - l.x0 > (R - L) * 0.5).map((l) => l.rho),
    0.5
  )
  const prose = (l: Line) => l.kind === 'text' && l.x1 - l.x0 >= (R - L) * 0.5 && l.gaps === 0 && l.rho >= bodyRho * 0.55

  // 行距空白：相邻两行正文之间的白缝，取偏小的分位数（段间空白、标题前后的空白不算）
  const textGaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]
    const b = lines[i]
    if (a.kind !== 'text' || b.kind !== 'text') continue
    const ha = a.y1 - a.y0
    const hb = b.y1 - b.y0
    if (Math.max(ha, hb) > Math.min(ha, hb) * 1.5) continue
    textGaps.push(b.y0 - a.y1)
  }
  const typGap = textGaps.length >= 3 ? quantile(textGaps, 0.35) : lineGap
  // 行尾参差不齐（左对齐、没两端对齐）的片区不能拿「上一行没写满」断段
  const texts = lines.filter((l) => l.kind === 'text')
  const fullShare = texts.length ? texts.filter((l) => l.x1 >= R - Math.max(lineH, (R - L) * 0.04)).length / texts.length : 0
  const justified = texts.length >= 4 && fullShare >= 0.45

  const nextText = (i: number): Line | undefined => {
    for (let k = i + 1; k < lines.length; k++) {
      if (lines[k].kind === 'text') return lines[k]
      if (lines[k].kind !== 'rule') return undefined
    }
    return undefined
  }

  const sameParagraph = (prev: Line, cur: Line, next: Line | undefined): boolean => {
    const gap = cur.y0 - prev.y1
    const hp = prev.y1 - prev.y0
    const hc = cur.y1 - cur.y0
    const em = Math.max(Math.min(hp, hc), lineH * 0.6)
    // 大字号（标题）的行距也跟着大，空白门槛按字号放大
    const k = Math.max(1, Math.min(hp, hc) / lineH)
    if (gap > Math.max(typGap * 1.8, typGap + lineH * 0.45) * k) return false
    // 字号变了：标题、图注、脚注
    if (Math.max(hp, hc) > Math.min(hp, hc) * 1.5) return false
    const indCur = cur.x0 - L
    const indPrev = prev.x0 - L
    // 上一行没写满 → 上一段结束了（居中的标题、公式组本来就不满，不算）
    if (justified && indPrev < em * 2 && prev.x1 < R - Math.max(em * 1.6, (R - L) * 0.07)) return false
    // 首行缩进：这行缩进、上一行顶格、这行写满、下一行又顶格（挂行缩进的参考文献续行不算新段）
    if (indCur >= em * 0.8 && indPrev < em * 0.5 && cur.x1 >= R - em * 1.2 && (!next || next.x0 - L < em * 0.5)) return false
    // 左边对不齐、而且隔得比行距开（居中的小标题）；图注最后一行居中但紧挨着上一行，不拆
    if (indCur > em * 3 && Math.abs(indCur - indPrev) > em * 3 && gap > typGap * 1.3 * k) return false
    return true
  }

  const blocks: RawBlock[] = []
  let cur: RawBlock | null = null
  let pendingRule: Line | null = null
  const grow = (b: RawBlock, l: Rect, asLine: boolean) => {
    b.x0 = Math.min(b.x0, l.x0)
    b.y0 = Math.min(b.y0, l.y0)
    b.x1 = Math.max(b.x1, l.x1)
    b.y1 = Math.max(b.y1, l.y1)
    if (asLine) b.lines.push(l as Line)
  }
  const close = () => {
    if (cur) blocks.push(cur)
    cur = null
  }
  const graphicLike = (k: VisualKind) => k === 'figure' || k === 'table'
  const start = (kind: VisualKind, l: Line) => {
    close()
    const b: RawBlock = { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, kind, lines: kind === 'figure' ? [] : [l] }
    if (graphicLike(kind)) {
      // 紧挨在上面的图 / 表碎片、表题这类短行（没有一行像正文）并进来，一张图或一个表只成一块
      const prev = blocks[blocks.length - 1]
      if (
        prev &&
        l.y0 - prev.y1 <= lineH * 1.2 &&
        (graphicLike(prev.kind) || (prev.kind === 'text' && prev.lines.length <= 3 && prev.lines.every((x) => !prose(x))))
      ) {
        blocks.pop()
        grow(b, prev, false)
        if (prev.kind === 'figure') b.kind = 'figure'
        b.lines = b.kind === 'figure' ? [] : [...prev.lines, l]
      }
      if (pendingRule && l.y0 - pendingRule.y1 <= lineH * 1.2) grow(b, pendingRule, false)
    }
    cur = b
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const c = cur as RawBlock | null
    const gap = c ? l.y0 - c.y1 : Infinity
    // 图 / 表往下吞：不像正文的行（坐标轴刻度、图例、稀疏的点、表格线）都算它的
    if (c && graphicLike(c.kind) && l.kind !== 'formula' && !prose(l) && gap <= lineH * (c.kind === 'table' ? 1.5 : 1.2)) {
      if (l.kind === 'graphic') {
        c.kind = 'figure'
        c.lines = []
      }
      grow(c, l, c.kind === 'table' && l.kind !== 'rule')
      pendingRule = null
      continue
    }
    switch (l.kind) {
      case 'rule':
        close()
        pendingRule = l
        continue
      case 'graphic':
        start('figure', l)
        break
      case 'tabular':
        start('table', l)
        break
      case 'formula':
        if (c?.kind === 'formula' && gap <= lineH * 0.9) grow(c, l, true)
        else start('formula', l)
        break
      default:
        // 公式下面紧挨着的矮碎片（求和号的上下标）归公式
        if (c?.kind === 'formula' && gap <= lineH * 0.6 && l.y1 - l.y0 < lineH * 0.7) grow(c, l, false)
        else if (c?.kind === 'text' && sameParagraph(c.lines[c.lines.length - 1], l, nextText(i))) grow(c, l, true)
        else start('text', l)
    }
    pendingRule = null
  }
  close()

  // 只有一行的「表」多半是页眉（页码 · 作者 · 日期中间空得很开），当普通文字
  for (const b of blocks) if (b.kind === 'table' && b.lines.length < 2) b.kind = 'text'
  // 太小的块（孤零零的页码、污点）不要
  return blocks.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) >= lineH * lineH * 0.8 || b.x1 - b.x0 >= lineH * 2)
}

// ---------- 入口 ----------

/**
 * 灰度图（0~255，一个像素一个字节）→ 版面块。建议宽 1000~1400 像素：
 * 正文一行十几像素高，切行最稳；太小（< 600）小字会糊成一片
 */
export function analyzeLayout(gray: ArrayLike<number>, W: number, H: number): VisualLayout {
  const { bin: bin0, ink } = binarize(gray, W * H)
  if (ink < 0.0005) return { ...EMPTY, ink }
  despeckle(bin0, W, H)
  const c0 = contentBox(bin0, W, H)
  if (!c0) return { ...EMPTY, ink }
  const skew = estimateSkew(bin0, W, c0)
  const cx = (c0.x0 + c0.x1) / 2
  const cy = (c0.y0 + c0.y1) / 2
  const straight = Math.abs(skew) >= 0.1 * DEG
  const bin = straight ? rotate(bin0, W, H, skew, cx, cy) : bin0
  const c = straight ? trim(bin, W, { x0: 0, y0: 0, x1: W, y1: H }) : c0
  if (!c) return { ...EMPTY, ink }
  const { lineH, gap } = estimateLine(bin, W, H, c)
  const gutters = findGutters(bin, W, c, lineH)
  const zones = buildZones(bin, W, c, gutters)
    .map((z) => trim(bin, W, z))
    .filter((z): z is Rect => !!z && z.y1 - z.y0 >= 3)

  // 摆正后的框换回原图：四个角转回去，取外接框
  const cos = Math.cos(skew)
  const sin = Math.sin(skew)
  const back = (r: Rect): VBox => {
    if (!straight) return { x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0) / W, h: (r.y1 - r.y0) / H }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [px, py] of [
      [r.x0, r.y0],
      [r.x1, r.y0],
      [r.x0, r.y1],
      [r.x1, r.y1]
    ]) {
      const sx = cx + (px - cx) * cos - (py - cy) * sin
      const sy = cy + (px - cx) * sin + (py - cy) * cos
      x0 = Math.min(x0, sx)
      y0 = Math.min(y0, sy)
      x1 = Math.max(x1, sx)
      y1 = Math.max(y1, sy)
    }
    x0 = Math.max(0, x0)
    y0 = Math.max(0, y0)
    x1 = Math.min(W, x1)
    y1 = Math.min(H, y1)
    return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H }
  }

  const blocks: VisualBlock[] = []
  const zoneBoxes: VBox[] = []
  for (const z of zones) {
    const raw = zoneBlocks(bin, W, H, z, lineH, gap)
    if (!raw.length) continue
    const zi = zoneBoxes.length
    zoneBoxes.push(back(z))
    for (const b of raw) blocks.push({ ...back(b), kind: b.kind, lines: b.lines.map(back), zone: zi })
  }
  return { blocks, zones: zoneBoxes, lineH: lineH / H, columns: gutters.length + 1, skew: skew / DEG, ink }
}

/** RGBA 像素（canvas 的 ImageData）→ 灰度；透明的地方当白纸 */
export function toGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length >> 2
  const out = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = rgba[j + 3] < 128 ? 255 : (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8
  }
  return out
}
