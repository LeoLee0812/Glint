import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection, SourceKind } from './types'
import { clip, toBox, unionBox } from './types'

// 通用 DOM 文字视图的焦点适配器：Markdown、PDF 文字层、右侧对话气泡都用它
// 词 / 句用 Intl.Segmenter（中文按词典分词），段 / 节交给各视图自己的 BlockProvider

const wordSeg = new Intl.Segmenter('zh', { granularity: 'word' })
const sentSeg = new Intl.Segmenter('zh', { granularity: 'sentence' })
const JOINERS = new Set(['-', '_', '.', "'", '’', '/', '+'])

export interface Block {
  key: string
  rects(): Box[]
  textNodes(): Text[]
  /** 喂给 AI 的干净文本（公式还原成 LaTeX） */
  text(): string
  headingLevel?: number
}

export interface BlockProvider {
  blockOf(node: Node): Block | null
  neighbor(b: Block, dir: -1 | 1): Block | null
  section(b: Block): { title: string; blocks: Block[] } | null
  location?(b: Block): string
}

type Seg = { start: number; end: number; word: boolean }
const segCache = new WeakMap<Text, { data: string; segs: Seg[] }>()

/** 分词，并把 self-attention、GPT-4o、e.g. 这类用连接符粘起来的片段并成一个词 */
export function segmentsOf(node: Text): Seg[] {
  const c = segCache.get(node)
  if (c && c.data === node.data) return c.segs
  const raw: Seg[] = []
  for (const s of wordSeg.segment(node.data)) raw.push({ start: s.index, end: s.index + s.segment.length, word: !!s.isWordLike })
  const segs: Seg[] = []
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i]
    const prev = segs[segs.length - 1]
    if (
      prev &&
      prev.word &&
      !s.word &&
      s.end - s.start === 1 &&
      JOINERS.has(node.data[s.start]) &&
      raw[i + 1]?.word
    ) {
      prev.end = raw[i + 1].end
      i++
      continue
    }
    segs.push({ ...s })
  }
  segCache.set(node, { data: node.data, segs })
  return segs
}

function excluded(n: Node): boolean {
  const el = n.nodeType === 1 ? (n as Element) : n.parentElement
  return !!el?.closest('.katex-mathml, .no-focus, script, style, .focus-skip')
}

export function textNodesIn(el: Element): Text[] {
  const out: Text[] = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!(n as Text).data.trim() || excluded(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  let n: Node | null
  while ((n = w.nextNode())) out.push(n as Text)
  return out
}

function katexOf(node: Node): HTMLElement | null {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement
  return (el?.closest('.katex') as HTMLElement) || null
}

export function texOf(k: Element): string {
  const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent
  return tex ? `$${tex.trim()}$` : k.textContent || ''
}

/** 元素的干净文本：KaTeX 公式换回 LaTeX 源码 */
export function cleanText(el: Element): string {
  if (!el.querySelector('.katex')) return (el as HTMLElement).innerText ?? el.textContent ?? ''
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('.katex').forEach((k) => k.replaceWith(document.createTextNode(texOf(k))))
  return clone.textContent || ''
}

/** 把 getClientRects 的碎片按行合并 */
export function mergeLineRects(rects: DOMRectList | DOMRect[]): Box[] {
  const list = Array.from(rects).filter((r) => r.width > 0.5 && r.height > 0.5)
  list.sort((a, b) => a.top - b.top || a.left - b.left)
  const out: Box[] = []
  for (const r of list) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.y - r.top) < Math.max(3, r.height * 0.35) && r.left - (last.x + last.width) < 24) {
      const x2 = Math.max(last.x + last.width, r.right)
      const y2 = Math.max(last.y + last.height, r.bottom)
      last.x = Math.min(last.x, r.left)
      last.y = Math.min(last.y, r.top)
      last.width = x2 - last.x
      last.height = y2 - last.y
    } else out.push(toBox(r))
  }
  return out
}

type DomAnchor = Anchor & { node: Text; offset: number }

export interface DomAdapterOpts {
  id: string
  kind: SourceKind
  root: () => HTMLElement | null
  blocks: BlockProvider
  docTitle: () => string
  capture?: (rect: Box) => Promise<string | null>
  page?: (delta: number) => void
  /** 焦点所在的上层条目（对话区的消息 id、解释窗口的卡片 id），写进上下文的 ref */
  refOf?: (node: Node) => string | undefined
}

export class DomAdapter implements PaneAdapter {
  id: string
  kind: SourceKind
  constructor(private o: DomAdapterOpts) {
    this.id = o.id
    this.kind = o.kind
  }

  element(): HTMLElement | null {
    return this.o.root()
  }

  private caret(x: number, y: number): DomAnchor | null {
    const root = this.o.root()
    if (!root) return null
    const r = document.caretRangeFromPoint(x, y)
    if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) return null
    const node = r.startContainer as Text
    if (!root.contains(node) || excluded(node) || !node.data.trim()) return null
    // caretRangeFromPoint 在行尾空白处也会返回，离文字太远的不要
    const probe = document.createRange()
    const off = Math.min(r.startOffset, Math.max(0, node.data.length - 1))
    probe.setStart(node, off)
    probe.setEnd(node, Math.min(node.data.length, off + 1))
    const b = probe.getBoundingClientRect()
    if (b.width + b.height > 0 && (Math.abs(b.top + b.height / 2 - y) > Math.max(24, b.height * 1.5) || x - b.right > 60)) return null
    return { pane: this.id, node, offset: r.startOffset }
  }

  anchorAt(x: number, y: number): Anchor | null {
    // 视线落在空白处时，就近螺旋找一个有字的位置
    const steps = [0, 10, 22, 36, 54, 78]
    for (const d of steps) {
      const pts = d === 0 ? [[0, 0]] : [[0, -d], [0, d], [-d, 0], [d, 0], [-d, -d], [d, d], [d, -d], [-d, d]]
      for (const [dx, dy] of pts) {
        const a = this.caret(x + dx, y + dy)
        if (a) return this.snapWord(a)
      }
    }
    return null
  }

  /** 让锚点落在一个「像词」的片段上 */
  private snapWord(a: DomAnchor): DomAnchor {
    const segs = segmentsOf(a.node)
    const hit = segs.find((s) => a.offset >= s.start && a.offset < s.end)
    if (hit?.word) return { ...a, offset: hit.start }
    let best: Seg | null = null
    for (const s of segs) {
      if (!s.word) continue
      if (!best || Math.abs(s.start - a.offset) < Math.abs(best.start - a.offset)) best = s
    }
    return best ? { ...a, offset: best.start } : a
  }

  private wordSeg(a: DomAnchor): Seg | null {
    const segs = segmentsOf(a.node)
    return segs.find((s) => a.offset >= s.start && a.offset < s.end && s.word) || segs.find((s) => s.word && s.start >= a.offset) || null
  }

  private wordRects(a: DomAnchor): Box[] {
    const k = katexOf(a.node)
    if (k) return [toBox(k.getBoundingClientRect())]
    const s = this.wordSeg(a)
    if (!s) return []
    const r = document.createRange()
    r.setStart(a.node, s.start)
    r.setEnd(a.node, s.end)
    return mergeLineRects(r.getClientRects())
  }

  private walker(root: HTMLElement): TreeWalker {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (!(n as Text).data.trim() || excluded(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
    })
  }

  private stepWord(a: DomAnchor, dir: 1 | -1): DomAnchor | null {
    const root = this.o.root()
    if (!root) return null
    const k = katexOf(a.node)
    const segs = segmentsOf(a.node)
    if (!k) {
      const cur = segs.findIndex((s) => a.offset >= s.start && a.offset < s.end)
      for (let i = cur + dir; i >= 0 && i < segs.length; i += dir) {
        if (segs[i].word) return { ...a, offset: segs[i].start }
      }
    }
    // 跨文本节点：公式整体当一个词跳过
    const w = this.walker(root)
    if (k) {
      const inner = textNodesIn(k)
      w.currentNode = dir === 1 ? inner[inner.length - 1] || a.node : inner[0] || a.node
    } else w.currentNode = a.node
    let n: Node | null
    while ((n = dir === 1 ? w.nextNode() : w.previousNode())) {
      const t = n as Text
      const kk = katexOf(t)
      if (kk) return { pane: this.id, node: textNodesIn(kk)[0] || t, offset: 0 }
      const ss = segmentsOf(t).filter((s) => s.word)
      if (ss.length) return { pane: this.id, node: t, offset: dir === 1 ? ss[0].start : ss[ss.length - 1].start }
    }
    return null
  }

  private stepLine(a: DomAnchor, dir: 1 | -1): DomAnchor | null {
    const root = this.o.root()
    if (!root) return null
    let rects = this.wordRects(a)
    if (!rects.length) return null
    let r = rects[0]
    const view = root.getBoundingClientRect()
    const lh = Math.max(12, r.height)
    // 目标行在可视区外：先滚一截再找
    const edge = dir === 1 ? r.y + r.height + lh * 1.2 > view.bottom : r.y - lh * 1.2 < view.top
    if (edge) {
      root.scrollBy({ top: dir * lh * 4 })
      rects = this.wordRects(a)
      if (!rects.length) return null
      r = rects[0]
    }
    const x = r.x + Math.min(r.width / 2, 10)
    for (let k = 0; k < 5; k++) {
      const y = dir === 1 ? r.y + r.height + lh * (0.55 + k * 0.7) : r.y - lh * (0.55 + k * 0.7)
      if (y < view.top || y > view.bottom) break
      const c = this.caret(x, y)
      if (c && !(c.node === a.node && Math.abs(c.offset - a.offset) < 1)) {
        const s = this.snapWord(c)
        const nr = this.wordRects(s)[0]
        if (nr && (dir === 1 ? nr.y > r.y + 2 : nr.y < r.y - 2)) return s
      }
    }
    return null
  }

  move(a: Anchor, dir: Dir): Anchor | null {
    const da = a as DomAnchor
    if (!da.node?.isConnected) return null
    if (dir === 'left') return this.stepWord(da, -1)
    if (dir === 'right') return this.stepWord(da, 1)
    return this.stepLine(da, dir === 'down' ? 1 : -1)
  }

  moveBlock(a: Anchor, dir: 'up' | 'down'): Anchor | null {
    const da = a as DomAnchor
    const b = this.o.blocks.blockOf(da.node)
    if (!b) return null
    const nb = this.o.blocks.neighbor(b, dir === 'down' ? 1 : -1)
    return nb ? this.enter(nb) : null
  }

  /** 跳进某一块：锚点落在它第一个词上，块在可视区外就先滚过去 */
  enter(nb: Block): Anchor | null {
    const t = nb.textNodes()[0]
    if (!t) return null
    const first = segmentsOf(t).find((s) => s.word)
    const na: DomAnchor = { pane: this.id, node: t, offset: first?.start ?? 0 }
    const rr = nb.rects()[0]
    const root = this.o.root()
    if (rr && root) {
      const view = root.getBoundingClientRect()
      if (rr.y < view.top + 20 || rr.y + Math.min(rr.height, 120) > view.bottom - 20) {
        root.scrollBy({ top: rr.y - view.top - view.height * 0.3, behavior: 'smooth' })
      }
    }
    return na
  }

  /** 锚点所在的块（给外层组合适配器排跨页的阅读顺序） */
  blockAt(a: Anchor): Block | null {
    const da = a as DomAnchor
    return da.node?.isConnected ? this.o.blocks.blockOf(da.node) : null
  }

  /** 块内文字到文本节点的映射，给「句」粒度用 */
  private blockMap(b: Block): { text: string; parts: Array<{ node: Text; start: number }> } {
    let text = ''
    const parts: Array<{ node: Text; start: number }> = []
    for (const n of b.textNodes()) {
      parts.push({ node: n, start: text.length })
      text += n.data
    }
    return { text, parts }
  }

  private sentenceRange(a: DomAnchor, b: Block): { range: Range; text: string } | null {
    const { text, parts } = this.blockMap(b)
    const part = parts.find((p) => p.node === a.node)
    if (!part) return null
    const g = part.start + a.offset
    let s0 = 0
    let s1 = text.length
    for (const s of sentSeg.segment(text)) {
      if (g >= s.index && g < s.index + s.segment.length) {
        s0 = s.index
        s1 = s.index + s.segment.length
        break
      }
    }
    const locate = (pos: number, end: boolean) => {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (pos > p.start || (!end && pos === p.start) || i === 0) {
          return { node: p.node, off: Math.min(p.node.data.length, Math.max(0, pos - p.start)) }
        }
      }
      return { node: parts[0].node, off: 0 }
    }
    const st = locate(s0, false)
    const en = locate(s1, true)
    const range = document.createRange()
    range.setStart(st.node, st.off)
    range.setEnd(en.node, en.off)
    return { range, text: text.slice(s0, s1).trim() }
  }

  select(a: Anchor, gran: Granularity): Selection | null {
    const da = a as DomAnchor
    if (!da.node?.isConnected) return null
    const b = this.o.blocks.blockOf(da.node)
    if (gran === 'word' || !b) {
      const k = katexOf(da.node)
      if (k) return { rects: [toBox(k.getBoundingClientRect())], space: 'client', text: texOf(k), gran: 'word', blockKey: b?.key }
      const s = this.wordSeg(da)
      if (!s) return null
      return { rects: this.wordRects(da), space: 'client', text: da.node.data.slice(s.start, s.end), gran: 'word', blockKey: b?.key }
    }
    if (gran === 'sentence') {
      const sr = this.sentenceRange(da, b)
      if (sr) return { rects: mergeLineRects(sr.range.getClientRects()), space: 'client', text: sr.text, gran, blockKey: b.key }
    }
    if (gran === 'section') {
      const sec = this.o.blocks.section(b)
      if (sec) {
        const rects = sec.blocks.flatMap((x) => x.rects())
        const u = unionBox(rects)
        return {
          rects: u ? [u] : rects,
          space: 'client',
          text: sec.blocks.map((x) => x.text()).join('\n'),
          gran,
          blockKey: b.key
        }
      }
    }
    const rects = b.rects()
    const u = unionBox(rects)
    return { rects: u ? [u] : rects, space: 'client', text: b.text(), gran: 'paragraph', blockKey: b.key }
  }

  async context(a: Anchor, gran: Granularity): Promise<FocusContext> {
    const da = a as DomAnchor
    const b = this.o.blocks.blockOf(da.node)
    const sel = this.select(a, gran)
    let before = ''
    let after = ''
    if (b) {
      let p = this.o.blocks.neighbor(b, -1)
      while (p && before.length < 700) {
        before = p.text() + '\n' + before
        p = this.o.blocks.neighbor(p, -1)
      }
      const n = this.o.blocks.neighbor(b, 1)
      if (n) after = n.text()
    }
    const sec = b ? this.o.blocks.section(b) : null
    return {
      source: this.kind,
      docTitle: this.o.docTitle(),
      location: b && this.o.blocks.location ? this.o.blocks.location(b) : '',
      gran: sel?.gran ?? gran,
      selection: clip(sel?.text ?? '', 4000),
      paragraph: clip(b?.text() ?? '', 2400),
      section: sec?.title,
      before: before ? clip(before.slice(-700), 700) : undefined,
      after: after ? clip(after, 400) : undefined,
      ref: this.o.refOf?.(da.node)
    }
  }

  scrollBy(dy: number): void {
    this.o.root()?.scrollBy({ top: dy })
  }

  page(delta: number): void {
    if (this.o.page) return this.o.page(delta)
    const r = this.o.root()
    if (r) r.scrollBy({ top: delta * r.clientHeight * 0.85, behavior: 'smooth' })
  }

  capture(rect: Box): Promise<string | null> {
    return this.o.capture ? this.o.capture(rect) : Promise.resolve(null)
  }
}

// ---------- 普通 HTML（Markdown、对话气泡）的块 ----------

const HEADINGS = 'h1,h2,h3,h4,h5,h6'

export class ElementBlocks implements BlockProvider {
  private list: HTMLElement[] | null = null
  private listRoot: HTMLElement | null = null
  private seq = 0

  constructor(
    private root: () => HTMLElement | null,
    private selector = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,figcaption,dt,dd,.katex-display,.msg-plain',
    private locate?: (el: HTMLElement) => string
  ) {}

  invalidate(): void {
    this.list = null
  }

  private all(): HTMLElement[] {
    const root = this.root()
    if (!root) return []
    if (this.list && this.listRoot === root && this.list.every((e) => e.isConnected)) return this.list
    const cands = Array.from(root.querySelectorAll<HTMLElement>(this.selector))
    // 只保留最内层的块：li 里包着 p 时用 p
    this.list = cands.filter((el) => !el.querySelector(this.selector) || el.matches('pre,.katex-display'))
    this.listRoot = root
    return this.list
  }

  private wrap(el: HTMLElement): Block {
    if (!el.dataset.bk) el.dataset.bk = `b${++this.seq}_${Math.random().toString(36).slice(2, 6)}`
    const lvl = /^H([1-6])$/.exec(el.tagName)
    return {
      key: el.dataset.bk,
      rects: () => [toBox(el.getBoundingClientRect())],
      textNodes: () => textNodesIn(el),
      text: () => cleanText(el).trim(),
      headingLevel: lvl ? Number(lvl[1]) : undefined,
      // @ts-expect-error 内部用：拿回元素
      el
    }
  }

  blockOf(node: Node): Block | null {
    const root = this.root()
    const start = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!root || !start) return null
    let el = start.closest<HTMLElement>(this.selector)
    // 命中的是外层容器（比如 li 里套 p），往里收
    if (el && el.querySelector(this.selector) && !el.matches('pre,.katex-display')) {
      const inner = Array.from(el.querySelectorAll<HTMLElement>(this.selector)).find((c) => c.contains(start))
      if (inner) el = inner
    }
    if (!el || !root.contains(el)) return null
    return this.wrap(el)
  }

  neighbor(b: Block, dir: -1 | 1): Block | null {
    const all = this.all()
    const el = (b as any).el as HTMLElement
    const i = all.indexOf(el)
    if (i < 0) return null
    const n = all[i + dir]
    return n ? this.wrap(n) : null
  }

  section(b: Block): { title: string; blocks: Block[] } | null {
    const all = this.all()
    const el = (b as any).el as HTMLElement
    let i = all.indexOf(el)
    if (i < 0) return null
    while (i >= 0 && !all[i].matches(HEADINGS)) i--
    if (i < 0) {
      // 没有标题：把开头到下一个标题前当一节
      const end = all.findIndex((e) => e.matches(HEADINGS))
      const blocks = all.slice(0, end < 0 ? Math.min(all.length, 12) : end).map((e) => this.wrap(e))
      return { title: '', blocks }
    }
    const h = all[i]
    const level = Number(h.tagName[1])
    const blocks: Block[] = [this.wrap(h)]
    for (let j = i + 1; j < all.length; j++) {
      const e = all[j]
      if (e.matches(HEADINGS) && Number(e.tagName[1]) <= level) break
      blocks.push(this.wrap(e))
      if (blocks.length > 40) break
    }
    return { title: cleanText(h).trim(), blocks }
  }

  location(b: Block): string {
    const el = (b as any).el as HTMLElement
    if (this.locate) return this.locate(el)
    const sec = this.section(b)
    return sec?.title ? `「${sec.title}」一节` : ''
  }
}
