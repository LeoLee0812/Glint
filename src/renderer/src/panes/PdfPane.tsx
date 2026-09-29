import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { DomAdapter, type Block, type BlockProvider } from '../focus/domAdapter'
import { panes, focus } from '../focus/focus'
import { toBox, unionBox, type Box } from '../focus/types'
import { la, toast } from '../appState'
import type { Doc } from './docs'
import type { VBox, VisualBlock, VisualLayout } from './pdfLayout'
import { layoutCanvas, PdfFocusAdapter, PdfVisual } from './pdfVisual'

// PDF 论文视图：pdf.js 画页面 + 透明文字层；文字层渲染完做一次版面分析，
// 把碎片 span 合成「行 → 段」，处理双栏、标题识别，段落焦点和「总结这一节」都靠它。
// 扫描件（页面只是一张图，文字层几乎没字）改看像素：pdfLayout 按墨迹切出段 / 图表 / 公式块（pdfVisual.ts），
// 视线照样能选，提问时把那一块高清截出来交给看图模型

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
const ASSET = new URL('./pdfjs/', window.location.href).href

interface PdfBlockData {
  key: string
  page: number
  spans: HTMLElement[]
  text: string
  heading: number | 0
  /** 字号（pdf.js 的 --font-height），用来认标题 */
  fh: number
}

const CJK = /[　-鿿＀-￯]/
const WORDCH = /[\p{L}\p{N}]/gu
const BAD = /[\uE000-\uF8FF\uFFFD]/g

/** 一页文字层里有效字（字母、数字、汉字）少于这个数，就当扫描页，按版面切块 */
const SCAN_CHARS = 300

/** 字体没带 Unicode 映射时，文字层是一串私有区码位 / 替换符：这种字当没有 */
function garbled(text: string): boolean {
  const t = text.replace(/\s/g, '')
  return !!t && (t.match(BAD)?.length ?? 0) >= t.length * 0.5
}

/** 扫描块里被文字层盖住三成以上的不要（那里有真文字，走文字层）；没盖住的是扫描进来的内容 */
function uncovered(blocks: VisualBlock[], boxes: VBox[]): VisualBlock[] {
  if (!boxes.length) return blocks
  return blocks.filter((b) => {
    let cov = 0
    for (const t of boxes) {
      const ix = Math.min(b.x + b.w, t.x + t.w) - Math.max(b.x, t.x)
      const iy = Math.min(b.y + b.h, t.y + t.h) - Math.max(b.y, t.y)
      if (ix > 0 && iy > 0) cov += ix * iy
    }
    return cov < b.w * b.h * 0.3
  })
}

function joinText(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  const last = a[a.length - 1]
  const first = b[0]
  if (last === '-' && /[a-z]/.test(first)) return a.slice(0, -1) + b
  if (CJK.test(last) || CJK.test(first) || /\s$/.test(a) || /^\s/.test(b)) return a + b
  return a + ' ' + b
}

function headingLevel(text: string, h: number, medianH: number): number {
  const t = text.trim()
  if (t.length > 90 || t.length < 2) return 0
  // 「3.2 Attention」这种编号标题；排除「1 2 3」之类的表格数字
  const m = /^(\d+(?:\.\d+){0,3})\.?\s+[A-Za-z\u4e00-\u9fff]/.exec(t)
  if (m && t.length < 70) return Math.min(4, m[1].split('.').length + 1)
  if (/^(abstract|introduction|related work|method|methods|experiments?|results|discussion|conclusions?|references|acknowledg(e)?ments|appendix|摘要|引言|参考文献|结论|致谢)\b/i.test(t)) return 2
  if (h > medianH * 1.25) return 2
  return 0
}

class PdfBlocks implements BlockProvider {
  blocks = new Map<string, PdfBlockData>()
  order: string[] = []
  title = ''

  clear(): void {
    this.blocks.clear()
    this.order = []
  }

  /**
   * 单页版面分析：文字碎片 → 行 → 段；先判断这一页是单栏还是双栏。
   * 返回这页文字层有多少有效字、各碎片在页面上的位置（归一化），给「是不是扫描页」判断用
   */
  analyzePage(page: number, pageDiv: HTMLElement, divs: HTMLElement[]): { chars: number; boxes: VBox[] } {
    // 先清掉这一页旧的块（缩放后重画）
    for (const [k, b] of this.blocks) if (b.page === page) this.blocks.delete(k)

    const pr = pageDiv.getBoundingClientRect()
    const W = pr.width
    type It = { el: HTMLElement; x: number; y: number; w: number; h: number; fh: number; text: string }
    const items: It[] = []
    let chars = 0
    const boxes: VBox[] = []
    for (const el of divs) {
      const text = el.textContent || ''
      if (!text.trim()) continue
      if (garbled(text)) {
        el.classList.add('focus-skip')
        continue
      }
      // 旋转的文字（比如 arXiv 侧边竖排编号）不参与分段
      const rot = el.style.getPropertyValue('--rotate')
      if (rot && parseFloat(rot) !== 0) continue
      const r = el.getBoundingClientRect()
      if (r.width < 0.5 || r.height < 0.5) continue
      const fh = parseFloat(el.style.getPropertyValue('--font-height')) || r.height
      items.push({ el, x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height, fh, text })
      chars += text.match(WORDCH)?.length ?? 0
      if (pr.width && pr.height) boxes.push({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height })
    }
    if (!items.length) {
      this.rebuildOrder()
      return { chars, boxes }
    }
    items.sort((a, b) => a.y - b.y || a.x - b.x)

    type Line = { items: It[]; x: number; y: number; w: number; h: number; fh: number }
    const lines: Line[] = []
    for (const it of items) {
      let hit: Line | null = null
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 14); i--) {
        const ln = lines[i]
        const cy = ln.y + ln.h / 2
        const iy = it.y + it.h / 2
        const tol = Math.max(ln.h, it.h) * 0.45
        const gap = it.x - (ln.x + ln.w)
        if (Math.abs(cy - iy) < tol && gap < Math.max(ln.h, it.h) * 2.4 && it.x + it.w > ln.x - 4) {
          hit = ln
          break
        }
      }
      if (hit) {
        hit.items.push(it)
        const x2 = Math.max(hit.x + hit.w, it.x + it.w)
        const y2 = Math.max(hit.y + hit.h, it.y + it.h)
        hit.x = Math.min(hit.x, it.x)
        hit.y = Math.min(hit.y, it.y)
        hit.w = x2 - hit.x
        hit.h = y2 - hit.y
        hit.fh = Math.max(hit.fh, it.fh)
      } else lines.push({ items: [it], x: it.x, y: it.y, w: it.w, h: it.h, fh: it.fh })
    }
    for (const ln of lines) ln.items.sort((a, b) => a.x - b.x)

    // 双栏判断：左半边和右半边各有足够多「比较长」的行，而且纵向范围重叠
    const longish = lines.filter((l) => l.w > W * 0.22)
    const leftL = longish.filter((l) => l.x + l.w < W * 0.53)
    const rightL = longish.filter((l) => l.x > W * 0.47)
    const span = (ls: Line[]) => (ls.length ? [Math.min(...ls.map((l) => l.y)), Math.max(...ls.map((l) => l.y + l.h))] : [0, 0])
    const [la0, la1] = span(leftL)
    const [ra0, ra1] = span(rightL)
    const twoCol = leftL.length >= 5 && rightL.length >= 5 && Math.min(la1, ra1) - Math.max(la0, ra0) > pr.height * 0.2

    const col = (ln: Line) => (!twoCol ? 0 : ln.x + ln.w < W * 0.53 ? 0 : ln.x > W * 0.47 ? 1 : -1)
    lines.sort((a, b) => a.y - b.y || a.x - b.x)
    let ordered: Line[] = lines
    if (twoCol) {
      // 通栏行把页面切成若干带，带内先左栏后右栏
      ordered = []
      let band: Line[] = []
      const flush = () => {
        ordered.push(...band.filter((l) => col(l) === 0), ...band.filter((l) => col(l) === 1))
        band = []
      }
      for (const ln of lines) {
        if (col(ln) === -1) {
          flush()
          ordered.push(ln)
        } else band.push(ln)
      }
      flush()
    }

    const fhs = ordered.map((l) => l.fh).sort((a, b) => a - b)
    const medianFh = fhs[Math.floor(fhs.length / 2)] || 10

    // 行 → 段：同一栏、行距小、字号相近、左边大致对齐（允许首行缩进），标题单独成段
    const groups: Line[][] = []
    for (const ln of ordered) {
      const g = groups[groups.length - 1]
      const prev = g?.[g.length - 1]
      const lnText = ln.items.map((i) => i.text).join('')
      const prevText = prev ? prev.items.map((i) => i.text).join('') : ''
      const same =
        !!prev &&
        col(prev) === col(ln) &&
        ln.y >= prev.y + prev.h * 0.5 &&
        ln.y - (prev.y + prev.h) < Math.max(prev.h, ln.h) * 0.85 &&
        Math.abs(ln.fh - prev.fh) < Math.max(prev.fh, ln.fh) * 0.2 &&
        Math.abs(ln.x - prev.x) < Math.max(ln.h * 3.2, 40) &&
        !headingLevel(prevText, prev.fh, medianFh) &&
        !headingLevel(lnText, ln.fh, medianFh)
      if (same) g.push(ln)
      else groups.push([ln])
    }

    groups.forEach((g, i) => {
      const key = `p${page}b${i}`
      const spans: HTMLElement[] = []
      let text = ''
      for (const ln of g) {
        let lineText = ''
        for (const it of ln.items) {
          spans.push(it.el)
          it.el.dataset.b = key
          lineText = joinText(lineText, it.text)
        }
        text = joinText(text, lineText.trim())
      }
      const fh = Math.max(...g.map((l) => l.fh))
      const lvl = g.length <= 2 ? headingLevel(text, fh, medianFh) : 0
      this.blocks.set(key, { key, page, spans, text: text.trim(), heading: lvl, fh })
    })
    this.rebuildOrder()
    if (page === 1 && !this.title) {
      // 论文标题：第一页字号最大、又不太长的那一段
      const cands = [...this.blocks.values()].filter((b) => b.page === 1 && b.text.length > 6 && b.text.length < 160)
      cands.sort((a, b) => b.fh - a.fh)
      this.title = cands[0]?.text || ''
    }
    return { chars, boxes }
  }

  /** 第 n 页的文字块，按阅读顺序 */
  onPage(page: number): Block[] {
    return this.order.map((k) => this.blocks.get(k)!).filter((d) => d.page === page).map((d) => this.wrap(d))
  }

  pageOf(b: Block): number {
    return this.blocks.get(b.key)?.page ?? 0
  }

  private rebuildOrder(): void {
    const all = [...this.blocks.values()]
    all.sort((a, b) => a.page - b.page || Number(a.key.split('b')[1]) - Number(b.key.split('b')[1]))
    this.order = all.map((b) => b.key)
  }

  private wrap(d: PdfBlockData): Block {
    return {
      key: d.key,
      rects: () => {
        const u = unionBox(d.spans.filter((s) => s.isConnected).map((s) => toBox(s.getBoundingClientRect())))
        return u ? [u] : []
      },
      textNodes: () => d.spans.map((s) => s.firstChild).filter((n): n is Text => !!n && n.nodeType === Node.TEXT_NODE),
      text: () => d.text,
      headingLevel: d.heading || undefined
    }
  }

  blockOf(node: Node): Block | null {
    const el = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest<HTMLElement>('[data-b]')
    const d = el ? this.blocks.get(el.dataset.b!) : undefined
    return d ? this.wrap(d) : null
  }

  neighbor(b: Block, dir: -1 | 1): Block | null {
    const i = this.order.indexOf(b.key)
    const k = this.order[i + dir]
    const d = k ? this.blocks.get(k) : undefined
    return d ? this.wrap(d) : null
  }

  section(b: Block): { title: string; blocks: Block[] } | null {
    let i = this.order.indexOf(b.key)
    if (i < 0) return null
    while (i >= 0 && !this.blocks.get(this.order[i])?.heading) i--
    if (i < 0) return { title: '', blocks: this.order.slice(0, 8).map((k) => this.wrap(this.blocks.get(k)!)) }
    const h = this.blocks.get(this.order[i])!
    const out: Block[] = [this.wrap(h)]
    for (let j = i + 1; j < this.order.length && out.length < 30; j++) {
      const d = this.blocks.get(this.order[j])!
      if (d.heading && d.heading <= h.heading) break
      out.push(this.wrap(d))
    }
    return { title: h.text.slice(0, 120), blocks: out }
  }

  location(b: Block): string {
    const d = this.blocks.get(b.key)
    const sec = this.section(b)
    return `第 ${d?.page ?? '?'} 页${sec?.title ? ` · ${sec.title}` : ''}`
  }
}

interface PageSize {
  num: number
  w: number
  h: number
}

/**
 * 从 PDF 里把第 n 页的一块按高分辨率单独渲染出来（和当前缩放无关，长边约 1400 像素，公式、小字看得清）；
 * mark = 在图上用蓝框标出焦点那一行
 */
async function cropPage(pdf: PDFDocumentProxy | null, num: number, box: VBox, mark?: VBox): Promise<string | null> {
  if (!pdf) return null
  try {
    const pg = await pdf.getPage(num)
    const base = pg.getViewport({ scale: 1 })
    const x0 = Math.max(0, box.x - 0.01)
    const y0 = Math.max(0, box.y - 0.006)
    const x1 = Math.min(1, box.x + box.w + 0.01)
    const y1 = Math.min(1, box.y + box.h + 0.006)
    const long = Math.max((x1 - x0) * base.width, (y1 - y0) * base.height)
    const vp = pg.getViewport({ scale: Math.min(4, Math.max(1.5, 1400 / long)) })
    const cv = document.createElement('canvas')
    cv.width = Math.max(8, Math.round((x1 - x0) * vp.width))
    cv.height = Math.max(8, Math.round((y1 - y0) * vp.height))
    await pg.render({ canvas: cv, viewport: vp, transform: [1, 0, 0, 1, -x0 * vp.width, -y0 * vp.height] }).promise
    if (mark) {
      const g = cv.getContext('2d')!
      const pad = 4
      const mx = (mark.x - x0) * vp.width - pad
      const my = (mark.y - y0) * vp.height - pad
      const mw = mark.w * vp.width + pad * 2
      const mh = mark.h * vp.height + pad * 2
      g.lineWidth = 7
      g.strokeStyle = 'rgba(255, 255, 255, 0.92)'
      g.strokeRect(mx, my, mw, mh)
      g.lineWidth = 3.5
      g.strokeStyle = 'rgb(0, 122, 255)'
      g.strokeRect(mx, my, mw, mh)
    }
    return cv.toDataURL('image/jpeg', 0.9)
  } catch (e) {
    console.warn('[pdf] 截取扫描块失败', num, e)
    return null
  }
}

export function PdfPane({ doc, active }: { doc: Doc; active: boolean }): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [sizes, setSizes] = useState<PageSize[]>([])
  const [zoom, setZoom] = useState(1)
  const [width, setWidth] = useState(800)
  const [page, setPage] = useState(1)
  const [error, setError] = useState('')
  const blocksRef = useRef(new PdfBlocks())
  const renderedRef = useRef(new Map<number, number>())
  const renderingRef = useRef(new Set<number>())
  // 扫描页：每页的切块结果（归一化坐标，和缩放无关，切一次就缓存）
  const [scanPages, setScanPages] = useState(0)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const layoutsRef = useRef(new Map<number, VisualLayout>())
  const toldRef = useRef(false)
  const visualRef = useRef<PdfVisual | null>(null)
  if (!visualRef.current) {
    visualRef.current = new PdfVisual({
      paneId: `doc:${doc.id}`,
      root: () => scrollRef.current,
      pageEl: (n) => scrollRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`) ?? null,
      crop: (n, box, mark) => cropPage(pdfRef.current, n, box, mark),
      docTitle: () => blocksRef.current.title || doc.title
    })
  }

  // 载入
  useEffect(() => {
    if (!doc.data) return
    let cancelled = false
    const task = pdfjs.getDocument({
      data: doc.data.slice(),
      cMapUrl: ASSET + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: ASSET + 'standard_fonts/',
      wasmUrl: ASSET + 'wasm/',
      iccUrl: ASSET + 'iccs/'
    })
    task.promise
      .then(async (p) => {
        if (cancelled) return
        const list: PageSize[] = []
        for (let i = 1; i <= p.numPages; i++) {
          const pg = await p.getPage(i)
          const v = pg.getViewport({ scale: 1 })
          list.push({ num: i, w: v.width, h: v.height })
        }
        if (cancelled) return
        blocksRef.current.clear()
        visualRef.current!.clear()
        layoutsRef.current.clear()
        setScanPages(0)
        pdfRef.current = p
        setSizes(list)
        setPdf(p)
      })
      .catch((e) => {
        setError(String(e?.message || e))
        toast('PDF 打开失败：' + (e?.message || e), 'error')
      })
    return () => {
      cancelled = true
      task.destroy()
    }
  }, [doc.data])

  // 容器宽度 → 适配宽度的缩放
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => el.clientWidth && setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const scaleOf = useCallback((s: PageSize) => ((Math.max(320, width - 48) / s.w) * zoom), [width, zoom])

  /** 文字层几乎没字的页：交给 worker 按版面切块（有缓存），去掉被真文字盖住的块，登记成扫描块 */
  const scanPage = useCallback(async (num: number, canvas: HTMLCanvasElement, boxes: VBox[]) => {
    const vis = visualRef.current!
    let lay = layoutsRef.current.get(num)
    if (!lay) {
      const t0 = performance.now()
      const got = await layoutCanvas(canvas)
      if (!got) return
      lay = got
      layoutsRef.current.set(num, lay)
      if (import.meta.env.DEV) {
        console.log(`[pdf] 第 ${num} 页按版面切块：${lay.blocks.length} 块、${lay.columns} 栏、扫歪 ${lay.skew.toFixed(2)}°，${Math.round(performance.now() - t0)}ms`)
      }
    }
    const kept = uncovered(lay.blocks, boxes)
    vis.set(num, lay, kept)
    setScanPages(vis.size)
    if (kept.length && !toldRef.current) {
      toldRef.current = true
      toast('这份 PDF 是扫描件，没有文字层：已按版面切成段落、图表、公式块，视线照样能选；按 A / X / Y 会把盯着的那一块截图交给看图模型', 'info', { ttl: 7000 })
    }
    focus.refresh()
  }, [])

  const renderPage = useCallback(
    async (num: number) => {
      if (!pdf) return
      const s = sizes[num - 1]
      const scale = scaleOf(s)
      if (renderedRef.current.get(num) === scale || renderingRef.current.has(num)) return
      const pageDiv = scrollRef.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${num}"]`)
      if (!pageDiv) return
      renderingRef.current.add(num)
      try {
        const pg = await pdf.getPage(num)
        const viewport = pg.getViewport({ scale })
        const canvas = pageDiv.querySelector('canvas')!
        const dpr = window.devicePixelRatio || 2
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        await pg.render({ canvas, viewport, transform: [dpr, 0, 0, dpr, 0, 0] }).promise
        const tl = pageDiv.querySelector<HTMLElement>('.textLayer')!
        tl.replaceChildren()
        const layer = new pdfjs.TextLayer({ textContentSource: pg.streamTextContent(), container: tl, viewport })
        await layer.render()
        const stats = blocksRef.current.analyzePage(num, pageDiv, layer.textDivs as HTMLElement[])
        renderedRef.current.set(num, scale)
        focus.refresh()
        if (stats.chars < SCAN_CHARS) void scanPage(num, canvas, stats.boxes)
        else if (visualRef.current!.has(num)) {
          visualRef.current!.drop(num)
          setScanPages(visualRef.current!.size)
        }
      } catch (e) {
        console.warn('[pdf] 渲染失败', num, e)
      } finally {
        renderingRef.current.delete(num)
      }
    },
    [pdf, sizes, scaleOf, scanPage]
  )

  // 只渲染可视区附近的页
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !pdf) return
    renderedRef.current.clear()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number((e.target as HTMLElement).dataset.page)
          if (e.isIntersecting) renderPage(n)
        }
      },
      { root, rootMargin: '900px 0px' }
    )
    root.querySelectorAll('.pdf-page').forEach((p) => io.observe(p))
    return () => io.disconnect()
  }, [pdf, renderPage, sizes])

  // 当前页码
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const onScroll = () => {
      const mid = root.scrollTop + root.clientHeight * 0.35
      let acc = 0
      for (const s of sizes) {
        acc += s.h * scaleOf(s) + 16
        if (acc > mid) {
          setPage(s.num)
          break
        }
      }
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [sizes, scaleOf])

  const goPage = useCallback(
    (delta: number) => {
      const root = scrollRef.current
      const target = Math.min(sizes.length, Math.max(1, page + delta))
      const el = root?.querySelector<HTMLElement>(`.pdf-page[data-page="${target}"]`)
      if (root && el) root.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    },
    [page, sizes.length]
  )

  // 焦点适配器：文字层交给 DomAdapter，扫描页交给 PdfVisual，外面包一层按锚点分派
  const pageCount = sizes.length
  useEffect(() => {
    if (!active) return
    const dom = new DomAdapter({
      id: `doc:${doc.id}`,
      kind: 'pdf',
      root: () => scrollRef.current,
      blocks: blocksRef.current,
      docTitle: () => blocksRef.current.title || doc.title,
      page: goPage,
      capture: async (rect: Box) => {
        // 优先从页面画布上高清裁剪（公式、图表更清楚），跨页就截窗口
        const root = scrollRef.current
        const pages = Array.from(root?.querySelectorAll<HTMLElement>('.pdf-page') || [])
        const pgEl = pages.find((p) => {
          const r = p.getBoundingClientRect()
          return rect.x >= r.left - 20 && rect.x + rect.width <= r.right + 20 && rect.y >= r.top - 20 && rect.y + rect.height <= r.bottom + 20
        })
        const canvas = pgEl?.querySelector('canvas')
        if (!pgEl || !canvas) return la.win.capture(rect)
        const r = pgEl.getBoundingClientRect()
        const k = canvas.width / r.width
        const sx = Math.max(0, (rect.x - r.left) * k)
        const sy = Math.max(0, (rect.y - r.top) * k)
        const sw = Math.min(canvas.width - sx, rect.width * k)
        const sh = Math.min(canvas.height - sy, rect.height * k)
        const out = document.createElement('canvas')
        out.width = Math.max(4, Math.round(sw))
        out.height = Math.max(4, Math.round(sh))
        out.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height)
        return out.toDataURL('image/png')
      }
    })
    return panes.register(new PdfFocusAdapter(dom, visualRef.current!, blocksRef.current, () => pageCount))
  }, [active, doc.id, doc.title, goPage, pageCount])

  // 键盘翻页（焦点不在输入框时）
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,.xterm')) return
      if (e.metaKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setZoom((z) => Math.min(3, z + 0.15))
      } else if (e.metaKey && e.key === '-') {
        e.preventDefault()
        setZoom((z) => Math.max(0.5, z - 0.15))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <div className="pdf-pane">
      <div className="pane-toolbar">
        <span className="small">
          第 {page} / {sizes.length || '…'} 页
        </span>
        <button className="btn sm" onClick={() => goPage(-1)}>
          上一页
        </button>
        <button className="btn sm" onClick={() => goPage(1)}>
          下一页
        </button>
        <span className="sep" />
        <button className="btn sm" onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}>
          −
        </button>
        <span className="small">{Math.round(zoom * 100)}%</span>
        <button className="btn sm" onClick={() => setZoom((z) => Math.min(3, z + 0.15))}>
          ＋
        </button>
        {scanPages > 0 && (
          <span className="scan-tag" title="这份 PDF 的页面只是图片、没有文字层：按版面切成段落 / 图表 / 公式块给视线选，提问时截图交给看图模型">
            扫描件 · 按版面分块
          </span>
        )}
        <span className="dim small ellipsis">{blocksRef.current.title || doc.title}</span>
      </div>
      <div className="doc-scroll pdf-scroll" ref={scrollRef}>
        {error && <div className="empty">PDF 打开失败：{error}</div>}
        {sizes.map((s) => {
          const sc = scaleOf(s)
          return (
            <div
              key={s.num}
              className="pdf-page"
              data-page={s.num}
              style={
                {
                  width: s.w * sc,
                  height: s.h * sc,
                  '--scale-factor': sc,
                  '--user-unit': 1,
                  '--total-scale-factor': sc,
                  '--scale-round-x': '1px',
                  '--scale-round-y': '1px'
                } as React.CSSProperties
              }
            >
              <canvas />
              <div className="textLayer" />
            </div>
          )
        })}
      </div>
    </div>
  )
}
