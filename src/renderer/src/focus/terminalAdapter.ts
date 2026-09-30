import type { Terminal } from '@xterm/xterm'
import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection } from './types'
import { clip, unionBox } from './types'
import { terminalAgent } from '../panes/agent'

// 终端视图的焦点：视线 → 字符格 → 行 / 词；「段」= 前后连续的非空行；「节」= 当前屏
// 终端里跑的多半是 Qwen Code 这类编程智能体，所以上下文会带上整屏输出

const seg = new Intl.Segmenter('zh', { granularity: 'word' })

type TermAnchor = Anchor & { row: number; col: number }

interface LineInfo {
  text: string
  /** 字符串下标 → 列 */
  cols: number[]
}

export function createTerminalAdapter(id: string, getTerm: () => Terminal | null, title: () => string): PaneAdapter {
  const screenEl = (): HTMLElement | null => (getTerm()?.element?.querySelector('.xterm-screen') as HTMLElement) || null

  function geom(): { r: DOMRect; cw: number; ch: number } | null {
    const t = getTerm()
    const el = screenEl()
    if (!t || !el) return null
    const r = el.getBoundingClientRect()
    return { r, cw: r.width / t.cols, ch: r.height / t.rows }
  }

  function line(row: number): LineInfo {
    const t = getTerm()
    const l = t?.buffer.active.getLine(row)
    if (!t || !l) return { text: '', cols: [] }
    let text = ''
    const cols: number[] = []
    for (let c = 0; c < t.cols; c++) {
      const cell = l.getCell(c)
      if (!cell) break
      if (cell.getWidth() === 0) continue
      const ch = cell.getChars() || ' '
      for (let k = 0; k < ch.length; k++) cols.push(c)
      text += ch
    }
    return { text: text.replace(/\s+$/, ''), cols }
  }

  function words(li: LineInfo): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = []
    // 路径、命令参数这类连续非空白串整体算一个词
    const re = /\S+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(li.text))) {
      const tok = m[0]
      if (/[一-鿿]/.test(tok)) {
        for (const s of seg.segment(tok)) if (s.isWordLike) out.push({ start: m.index + s.index, end: m.index + s.index + s.segment.length })
      } else out.push({ start: m.index, end: m.index + tok.length })
    }
    return out
  }

  function wordAt(a: TermAnchor): { li: LineInfo; w: { start: number; end: number } | null } {
    const li = line(a.row)
    const ws = words(li)
    const idx = li.cols.findIndex((c) => c >= a.col)
    const pos = idx < 0 ? li.text.length - 1 : idx
    let w = ws.find((x) => pos >= x.start && pos < x.end) || null
    if (!w && ws.length) w = ws.reduce((best, x) => (Math.abs(x.start - pos) < Math.abs(best.start - pos) ? x : best))
    return { li, w }
  }

  function rectFor(row: number, c0: number, c1: number): Box | null {
    const g = geom()
    const t = getTerm()
    if (!g || !t) return null
    const vr = row - t.buffer.active.viewportY
    if (vr < 0 || vr >= t.rows) return null
    return { x: g.r.left + c0 * g.cw, y: g.r.top + vr * g.ch, width: Math.max(g.cw, (c1 - c0) * g.cw), height: g.ch }
  }

  function blockRows(row: number): [number, number] {
    const t = getTerm()
    if (!t) return [row, row]
    const blank = (r: number) => !line(r).text.trim() || /^[\s─━═╌┄-]+$/.test(line(r).text)
    let a = row
    let b = row
    while (a > 0 && !blank(a - 1) && row - a < 40) a--
    while (b < t.buffer.active.length - 1 && !blank(b + 1) && b - row < 40) b++
    return [a, b]
  }

  function screenText(): string {
    const t = getTerm()
    if (!t) return ''
    const out: string[] = []
    const top = t.buffer.active.viewportY
    for (let r = top; r < top + t.rows; r++) out.push(line(r).text)
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  const adapter: PaneAdapter = {
    id,
    kind: 'terminal',
    element: () => (getTerm()?.element as HTMLElement) || null,

    anchorAt(x, y) {
      const g = geom()
      const t = getTerm()
      if (!g || !t) return null
      if (x < g.r.left - 4 || x > g.r.right + 4 || y < g.r.top - 4 || y > g.r.bottom + 4) return null
      const col = Math.max(0, Math.min(t.cols - 1, Math.floor((x - g.r.left) / g.cw)))
      let vr = Math.max(0, Math.min(t.rows - 1, Math.floor((y - g.r.top) / g.ch)))
      // 落在空行上就往上下找最近的有字行
      const base = t.buffer.active.viewportY
      for (let d = 0; d < 4; d++) {
        for (const s of [vr - d, vr + d]) {
          if (s >= 0 && s < t.rows && line(base + s).text.trim()) {
            vr = s
            return { pane: id, row: base + vr, col } as TermAnchor
          }
        }
      }
      return { pane: id, row: base + vr, col } as TermAnchor
    },

    move(a: Anchor, dir: Dir) {
      const ta = a as TermAnchor
      const t = getTerm()
      if (!t) return null
      if (dir === 'up' || dir === 'down') {
        let r = ta.row + (dir === 'down' ? 1 : -1)
        while (r >= 0 && r < t.buffer.active.length && !line(r).text.trim()) r += dir === 'down' ? 1 : -1
        if (r < 0 || r >= t.buffer.active.length) return null
        const vr = r - t.buffer.active.viewportY
        if (vr < 0) t.scrollLines(vr - 2)
        else if (vr >= t.rows) t.scrollLines(vr - t.rows + 3)
        return { pane: id, row: r, col: ta.col } as TermAnchor
      }
      const { li, w } = wordAt(ta)
      const ws = words(li)
      const i = w ? ws.indexOf(w) : -1
      const n = ws[i + (dir === 'right' ? 1 : -1)]
      if (n) return { pane: id, row: ta.row, col: li.cols[n.start] } as TermAnchor
      // 换行
      let r = ta.row + (dir === 'right' ? 1 : -1)
      while (r >= 0 && r < t.buffer.active.length) {
        const l2 = line(r)
        const w2 = words(l2)
        if (w2.length) {
          const pick = dir === 'right' ? w2[0] : w2[w2.length - 1]
          return { pane: id, row: r, col: l2.cols[pick.start] } as TermAnchor
        }
        r += dir === 'right' ? 1 : -1
      }
      return null
    },

    moveBlock(a: Anchor, dir: 'up' | 'down') {
      const ta = a as TermAnchor
      const [s, e] = blockRows(ta.row)
      const t = getTerm()
      if (!t) return null
      let r = dir === 'down' ? e + 1 : s - 1
      while (r >= 0 && r < t.buffer.active.length && !line(r).text.trim()) r += dir === 'down' ? 1 : -1
      if (r < 0 || r >= t.buffer.active.length) return null
      // 跳到屏幕外的块：先滚到整块露出来（按段挪焦点时要能一直往下走）；比一屏还高的块露出开头
      const [bs, be] = blockRows(r)
      const top = t.buffer.active.viewportY
      if (bs < top) t.scrollLines(bs - top - 1)
      else if (be >= top + t.rows) t.scrollLines(Math.min(be - top - t.rows + 2, bs - top))
      return { pane: id, row: r, col: 0 } as TermAnchor
    },

    select(a: Anchor, gran: Granularity): Selection | null {
      const ta = a as TermAnchor
      const t = getTerm()
      if (!t) return null
      if (gran === 'word') {
        const { li, w } = wordAt(ta)
        if (!w) return null
        const c0 = li.cols[w.start]
        const c1 = (li.cols[w.end - 1] ?? c0) + 1
        const r = rectFor(ta.row, c0, c1)
        return r ? { rects: [r], space: 'client', text: li.text.slice(w.start, w.end), gran, blockKey: `row${blockRows(ta.row)[0]}` } : null
      }
      if (gran === 'sentence') {
        const li = line(ta.row)
        const r = rectFor(ta.row, 0, Math.max(1, (li.cols[li.text.length - 1] ?? 0) + 1))
        return r ? { rects: [r], space: 'client', text: li.text.trim(), gran, blockKey: `row${blockRows(ta.row)[0]}` } : null
      }
      const [s, e] = gran === 'section' ? [t.buffer.active.viewportY, t.buffer.active.viewportY + t.rows - 1] : blockRows(ta.row)
      const rects: Box[] = []
      const texts: string[] = []
      for (let r = s; r <= e; r++) {
        const li = line(r)
        texts.push(li.text)
        const box = rectFor(r, 0, t.cols)
        if (box) rects.push(box)
      }
      const u = unionBox(rects)
      return u ? { rects: [u], space: 'client', text: texts.join('\n').trim(), gran, blockKey: `row${s}` } : null
    },

    async context(a: Anchor, gran: Granularity): Promise<FocusContext> {
      const ta = a as TermAnchor
      const sel = adapter.select(a, gran)
      const [s, e] = blockRows(ta.row)
      const block: string[] = []
      for (let r = s; r <= e; r++) block.push(line(r).text)
      const screen = screenText()
      const agent = terminalAgent(screen)
      return {
        source: 'terminal',
        docTitle: agent ? `终端里的 ${agent}` : title(),
        location: `终端第 ${ta.row + 1} 行`,
        gran: sel?.gran ?? gran,
        selection: clip(sel?.text ?? '', 3000),
        paragraph: clip(block.join('\n'), 3000),
        extra: clip(screen, 5000)
      }
    },

    scrollBy(dy: number) {
      const g = geom()
      getTerm()?.scrollLines(Math.round(dy / (g?.ch || 16)))
    },

    page(delta: number) {
      const t = getTerm()
      t?.scrollLines(delta * Math.max(1, t.rows - 3))
    }
  }
  return adapter
}
