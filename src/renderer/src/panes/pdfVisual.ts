import type { VisualBlock, VisualLayout, VBox } from './pdfLayout'
import type { Block, DomAdapter } from '../focus/domAdapter'
import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection } from '../focus/types'
import { GRAN_ORDER, unionBox } from '../focus/types'

// 扫描页（页面只是一张图、没有文字层）的焦点：按 pdfLayout 切出的版面块给视线选、给摇杆走，
// 提问时把那一块从 PDF 里高清截出来交给看图模型。同一份 PDF 里有文字层的页照旧走 DomAdapter，
// PdfFocusAdapter 按锚点类型分派；整份 PDF 都有文字层时它和以前的 DomAdapter 完全一样

// ---------- worker ----------

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, (l: VisualLayout | null) => void>()

/** 把渲染好的页面画布缩到宽 1200 左右（正文一行十几像素，切行最稳）交给 worker 切块 */
export async function layoutCanvas(canvas: HTMLCanvasElement): Promise<VisualLayout | null> {
  if (!canvas.width || !canvas.height) return null
  const w = Math.min(1200, canvas.width)
  const h = Math.max(1, Math.round((canvas.height * w) / canvas.width))
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
  } catch {
    return null
  }
  if (!worker) {
    worker = new Worker(new URL('./pdfLayout.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; layout?: VisualLayout; error?: string }>) => {
      const done = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      if (e.data.error) console.warn('[pdf] 版面切块失败', e.data.error)
      done?.(e.data.layout ?? null)
    }
    worker.onerror = (e) => {
      console.warn('[pdf] 版面切块 worker 出错', e.message)
      for (const done of waiting.values()) done(null)
      waiting.clear()
      worker?.terminate()
      worker = null
    }
  }
  const id = ++seq
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    worker!.postMessage({ id, bitmap }, [bitmap])
  })
}

// ---------- 扫描块 ----------

export type VisAnchor = Anchor & { vis: true; page: number; block: number; line: number }

export function isVis(a: Anchor | null | undefined): a is VisAnchor {
  return !!a && (a as VisAnchor).vis === true
}

const UNIT: Record<VisualBlock['kind'], string> = { text: '段', figure: '图表', table: '图表', formula: '公式' }
const VIS_GRANS: Granularity[] = ['word', 'paragraph', 'section']

interface VisPage {
  blocks: VisualBlock[]
  zones: VBox[]
  columns: number
}

export interface PdfVisualOpts {
  paneId: string
  root: () => HTMLElement | null
  pageEl: (n: number) => HTMLElement | null
  /** 从 PDF 里把第 n 页的这一块高清渲染出来（mark = 在图上用蓝框标出的那一行），返回 dataURL */
  crop: (page: number, box: VBox, mark?: VBox) => Promise<string | null>
  docTitle: () => string
}

function unionV(bs: VBox[]): VBox {
  const x0 = Math.min(...bs.map((b) => b.x))
  const y0 = Math.min(...bs.map((b) => b.y))
  const x1 = Math.max(...bs.map((b) => b.x + b.w))
  const y1 = Math.max(...bs.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export class PdfVisual {
  private pages = new Map<number, VisPage>()

  constructor(private o: PdfVisualOpts) {}

  get size(): number {
    return this.pages.size
  }

  has(page: number): boolean {
    return this.pages.has(page)
  }

  /** 登记一页的扫描块；blocks 是去掉了被文字层盖住的那些之后剩下的 */
  set(page: number, layout: VisualLayout, blocks: VisualBlock[]): void {
    if (blocks.length) this.pages.set(page, { blocks, zones: layout.zones, columns: layout.columns })
    else this.pages.delete(page)
  }

  drop(page: number): void {
    this.pages.delete(page)
  }

  clear(): void {
    this.pages.clear()
  }

  blocksOf(page: number): VisualBlock[] {
    return this.pages.get(page)?.blocks ?? []
  }

  private block(a: VisAnchor): VisualBlock | null {
    return this.pages.get(a.page)?.blocks[a.block] ?? null
  }

  /** 归一化框 → 窗口坐标 */
  private box(page: number, b: VBox): Box | null {
    const el = this.o.pageEl(page)
    const r = el?.getBoundingClientRect()
    if (!r || !r.width || !r.height) return null
    return { x: r.left + b.x * r.width, y: r.top + b.y * r.height, width: b.w * r.width, height: b.h * r.height }
  }

  private anchor(page: number, block: number, line: number): VisAnchor {
    return { pane: this.o.paneId, vis: true, page, block, line }
  }

  /** 视线落点附近最近的扫描块（块外 reach 像素以内也算），顺带找离得最近的那一行 */
  hit(x: number, y: number, reach = 48): { anchor: VisAnchor; dist: number } | null {
    let best: { anchor: VisAnchor; dist: number } | null = null
    for (const [page, vp] of this.pages) {
      const el = this.o.pageEl(page)
      const r = el?.getBoundingClientRect()
      if (!r || !r.width || y < r.top - reach || y > r.bottom + reach || x < r.left - reach || x > r.right + reach) continue
      vp.blocks.forEach((b, i) => {
        const bx = r.left + b.x * r.width - 4
        const by = r.top + b.y * r.height - 4
        const bw = b.w * r.width + 8
        const bh = b.h * r.height + 8
        const d = Math.hypot(Math.max(bx - x, 0, x - bx - bw), Math.max(by - y, 0, y - by - bh))
        if (d > reach || (best && d >= best.dist)) return
        let line = -1
        let ld = Infinity
        b.lines.forEach((l, k) => {
          const cy = r.top + (l.y + l.h / 2) * r.height
          if (Math.abs(cy - y) < ld) {
            ld = Math.abs(cy - y)
            line = k
          }
        })
        best = { anchor: this.anchor(page, i, line), dist: d }
      })
    }
    return best
  }

  /** 这一片是哪一栏：单栏页不说，跨栏的叫通栏 */
  private column(page: number, zone: number): string {
    const vp = this.pages.get(page)
    const z = vp?.zones[zone]
    if (!vp || !z || vp.columns < 2) return ''
    if (z.w > 0.6) return '通栏'
    const cx = z.x + z.w / 2
    if (vp.columns === 2) return cx < 0.5 ? '左栏' : '右栏'
    return cx < 1 / 3 ? '左栏' : cx < 2 / 3 ? '中栏' : '右栏'
  }

  /** 给人看的位置：「第 3 页 · 左栏 · 第 2 段」 */
  where(page: number, block: number): string {
    const vp = this.pages.get(page)
    const b = vp?.blocks[block]
    if (!vp || !b) return `第 ${page} 页`
    const same = vp.blocks.filter((x) => x.zone === b.zone && UNIT[x.kind] === UNIT[b.kind])
    const what = b.kind === 'text' ? `第 ${same.indexOf(b) + 1} 段` : UNIT[b.kind]
    return [`第 ${page} 页`, this.column(page, b.zone), what].filter(Boolean).join(' · ')
  }

  select(a: VisAnchor, gran: Granularity): Selection | null {
    const vp = this.pages.get(a.page)
    const b = vp?.blocks[a.block]
    if (!vp || !b) return null
    const blockKey = `v${a.page}_${a.block}`
    const where = this.where(a.page, a.block)
    if (gran === 'word' && a.line >= 0 && b.lines[a.line]) {
      const r = this.box(a.page, b.lines[a.line])
      return r ? { rects: [r], space: 'client', text: `${where} · 第 ${a.line + 1} 行`, gran: 'word', blockKey, unit: '行', visual: true } : null
    }
    if (gran === 'section') {
      const rects = vp.blocks.filter((x) => x.zone === b.zone).map((x) => this.box(a.page, x)).filter((r): r is Box => !!r)
      const u = unionBox(rects)
      const col = this.column(a.page, b.zone)
      return u ? { rects: [u], space: 'client', text: `第 ${a.page} 页${col ? ' · ' + col : ''}`, gran: 'section', blockKey, unit: col ? '栏' : '页', visual: true } : null
    }
    // 段（句也按段算：扫描页分不出句子）
    const r = this.box(a.page, b)
    return r ? { rects: [r], space: 'client', text: where, gran: 'paragraph', blockKey, unit: UNIT[b.kind], visual: true } : null
  }

  /** 阅读顺序里的下一块 / 上一块：页内按切块顺序，出了这页接着相邻的扫描页 */
  private next(page: number, block: number, d: 1 | -1): { page: number; block: number } | null {
    const vp = this.pages.get(page)
    if (!vp) return null
    if (block + d >= 0 && block + d < vp.blocks.length) return { page, block: block + d }
    const np = this.pages.get(page + d)
    if (!np?.blocks.length) return null
    return { page: page + d, block: d > 0 ? 0 : np.blocks.length - 1 }
  }

  /** 右摇杆：上下逐行（出了这一块接着上一块 / 下一块），左右跳到旁边那一栏同一高度的块 */
  move(a: VisAnchor, dir: Dir): VisAnchor | null {
    const b = this.block(a)
    if (!b) return null
    if (dir === 'up' || dir === 'down') {
      const d = dir === 'down' ? 1 : -1
      if (b.lines.length) {
        const cur = a.line < 0 ? (d > 0 ? -1 : b.lines.length) : a.line
        const nl = cur + d
        if (nl >= 0 && nl < b.lines.length) return this.anchor(a.page, a.block, nl)
      }
      const n = this.next(a.page, a.block, d)
      if (!n) return null
      const nb = this.pages.get(n.page)!.blocks[n.block]
      return this.anchor(n.page, n.block, nb.lines.length ? (d > 0 ? 0 : nb.lines.length - 1) : -1)
    }
    const d = dir === 'right' ? 1 : -1
    const vp = this.pages.get(a.page)!
    const ref = a.line >= 0 && b.lines[a.line] ? b.lines[a.line] : b
    const cy = ref.y + ref.h / 2
    let best = -1
    let bestD = Infinity
    vp.blocks.forEach((x, i) => {
      if (i === a.block) return
      const dx = d > 0 ? x.x - (b.x + b.w) : b.x - (x.x + x.w)
      if (dx < -0.02) return
      const dy = Math.max(x.y - cy, 0, cy - x.y - x.h)
      const score = dx + dy * 3
      if (score < bestD) {
        bestD = score
        best = i
      }
    })
    if (best < 0) return null
    const nb = vp.blocks[best]
    let line = -1
    let ld = Infinity
    nb.lines.forEach((l, k) => {
      const dd = Math.abs(l.y + l.h / 2 - cy)
      if (dd < ld) {
        ld = dd
        line = k
      }
    })
    return this.anchor(a.page, best, line)
  }

  /** 进到某一块（十字键跳块）：块在可视区外就先滚过去 */
  enter(page: number, block: number): VisAnchor | null {
    const b = this.pages.get(page)?.blocks[block]
    if (!b) return null
    const rr = this.box(page, b)
    const root = this.o.root()
    if (rr && root) {
      const view = root.getBoundingClientRect()
      if (rr.y < view.top + 20 || rr.y + Math.min(rr.height, 120) > view.bottom - 20) {
        root.scrollBy({ top: rr.y - view.top - view.height * 0.3, behavior: 'smooth' })
      }
    }
    return this.anchor(page, block, -1)
  }

  /**
   * 提问上下文：没有原文，只有这一块的高清截图。
   * 行粒度截的是整段、焦点那一行用蓝框标出（单独一行截出来前后文全没了）；节粒度截这一栏
   */
  async context(a: VisAnchor, gran: Granularity): Promise<FocusContext> {
    const vp = this.pages.get(a.page)
    const b = vp?.blocks[a.block]
    const sel = this.select(a, gran)
    let box: VBox | null = b ?? null
    let mark: VBox | undefined
    let unit = sel?.unit ?? '段'
    if (b && sel?.gran === 'word' && a.line >= 0 && b.lines[a.line]) mark = b.lines[a.line]
    else if (b && vp && sel?.gran === 'section') box = unionV(vp.blocks.filter((x) => x.zone === b.zone))
    if (!b) unit = '段'
    const image = box ? await this.o.crop(a.page, box, mark) : null
    const col = b ? this.column(a.page, b.zone) : ''
    return {
      source: 'pdf',
      docTitle: this.o.docTitle(),
      location: `第 ${a.page} 页${col ? ' · ' + col : ''}（扫描件）`,
      gran: sel?.gran ?? gran,
      selection: '',
      paragraph: '',
      image: image ?? undefined,
      scan: { unit, marked: !!mark, label: sel?.text }
    }
  }
}

// ---------- 组合适配器 ----------

export interface PdfTextBlocks {
  /** 第 n 页有文字层的块，按阅读顺序 */
  onPage(page: number): Block[]
  pageOf(b: Block): number
}

/**
 * PDF 视图的焦点适配器：有文字层的页交给 DomAdapter，扫描页交给 PdfVisual。
 * 视线落点在扫描块里就选扫描块；否则先找文字，找不到再就近吸到扫描块上
 */
export class PdfFocusAdapter implements PaneAdapter {
  id: string
  kind = 'pdf' as const

  constructor(
    private dom: DomAdapter,
    private vis: PdfVisual,
    private text: PdfTextBlocks,
    private pageCount: () => number
  ) {
    this.id = dom.id
  }

  element(): HTMLElement | null {
    return this.dom.element()
  }

  anchorAt(x: number, y: number): Anchor | null {
    if (!this.vis.size) return this.dom.anchorAt(x, y)
    const h = this.vis.hit(x, y)
    if (h && h.dist <= 2) return h.anchor
    return this.dom.anchorAt(x, y) ?? h?.anchor ?? null
  }

  move(a: Anchor, dir: Dir): Anchor | null {
    return isVis(a) ? this.vis.move(a, dir) : this.dom.move(a, dir)
  }

  /** 十字键跳块：有扫描页时，文字块和扫描块按页排成一条阅读顺序 */
  moveBlock(a: Anchor, dir: 'up' | 'down'): Anchor | null {
    if (!this.vis.size) return this.dom.moveBlock(a, dir)
    type Entry = { page: number; vis?: number; text?: Block }
    const domBlock = isVis(a) ? null : this.dom.blockAt(a)
    const cur = isVis(a) ? a.page : domBlock ? this.text.pageOf(domBlock) : 0
    if (!cur) return this.dom.moveBlock(a, dir)
    // 只排当前页和前后各一页（几百页的扫描书不用每按一次都把整本排一遍）
    const seqList: Entry[] = []
    for (let p = Math.max(1, cur - 1); p <= Math.min(this.pageCount(), cur + 1); p++) {
      this.vis.blocksOf(p).forEach((_, i) => seqList.push({ page: p, vis: i }))
      for (const t of this.text.onPage(p)) seqList.push({ page: p, text: t })
    }
    let i = -1
    if (isVis(a)) i = seqList.findIndex((e) => e.page === a.page && e.vis === a.block)
    else if (domBlock) i = seqList.findIndex((e) => e.text?.key === domBlock.key)
    if (i < 0) return isVis(a) ? null : this.dom.moveBlock(a, dir)
    const e = seqList[i + (dir === 'down' ? 1 : -1)]
    if (!e) return null
    return e.vis !== undefined ? this.vis.enter(e.page, e.vis) : this.dom.enter(e.text!)
  }

  select(a: Anchor, gran: Granularity): Selection | null {
    return isVis(a) ? this.vis.select(a, gran) : this.dom.select(a, gran)
  }

  context(a: Anchor, gran: Granularity): Promise<FocusContext> {
    return isVis(a) ? this.vis.context(a, gran) : this.dom.context(a, gran)
  }

  grans(a: Anchor): Granularity[] {
    return isVis(a) ? VIS_GRANS : GRAN_ORDER
  }

  scrollBy(dy: number): void {
    this.dom.scrollBy(dy)
  }

  page(delta: number): void {
    this.dom.page(delta)
  }

  capture(rect: Box): Promise<string | null> {
    return this.dom.capture(rect)
  }
}
