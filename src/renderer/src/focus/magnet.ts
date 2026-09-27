import { panes } from './focus'
import { segmentsOf, mergeLineRects } from './domAdapter'
import type { Box } from './types'
import { toBox } from './types'
import { snapParams, type SnapParams } from './snap'

// 关键词吸附：在视线周围撒一圈探测点，找出附近「像关键词」的词（术语、缩写、公式、加粗/代码…），
// 按「关键词程度 × 离视线的远近」打分，给视线光环当吸附目标。只做 DOM 文字视图（Markdown / PDF 文字层 / 对话）

export interface Magnet {
  box: Box
  text: string
  /** 0~1：关键词程度 × 距离衰减 */
  weight: number
  /** 关键词程度（不含距离） */
  kw: number
  /** 词在哪：文本节点 + 起止（公式就是整个 .katex 元素），用来认出「还是同一个词」、滚动后重算位置 */
  node: Node
  start: number
  end: number
}

const EN_STOP = new Set(
  'the a an and or of to in on for with by from as at is are was were be been being this that these those it its we our they their you your which what when where how than then there here such can could may might will would should into over under about also not only more most other some any each both between while after before during without within via per using used use based show shows shown paper section figure table'.split(
    ' '
  )
)
const ZH_STOP = new Set(
  '我们 你们 他们 这个 那个 一个 这些 那些 可以 进行 通过 因为 所以 但是 如果 然后 以及 或者 并且 其中 已经 没有 就是 还是 什么 怎么 为了 对于 由于 其他 一些 这样 那样 这种 那种 不是 可能 需要 使用 提出 方法 本文 如下 所示'.split(
    ' '
  )
)

const CJK = /[一-鿿]/
const EMPH = 'strong, b, em, code, a, h1, h2, h3, h4, h5, th, dt, mark'

/** 这个词有多像「值得问一句」的关键词，0~1 */
function keywordness(word: string, el: Element | null): number {
  const w = word.trim()
  if (!w) return 0
  let s = 0
  if (CJK.test(w)) {
    if (ZH_STOP.has(w)) return 0
    s = w.length >= 4 ? 0.8 : w.length === 3 ? 0.62 : w.length === 2 ? 0.3 : 0
  } else {
    const lower = w.toLowerCase()
    if (EN_STOP.has(lower) || w.length < 2) return 0
    if (/^[A-Z]{2,}[a-z]?s?$/.test(w)) s = 0.9 // 缩写：MDP、RL、LLMs
    else if (/\d/.test(w) && /[a-z]/i.test(w)) s = 0.85 // GPT-4o、Q-learning 里的带数字词
    else if (/[a-z][A-Z]/.test(w)) s = 0.85 // CamelCase
    else if (/[-_/]/.test(w)) s = 0.72 // self-attention
    else if (w.length >= 9) s = 0.66
    else if (w.length >= 7) s = 0.5
    else if (w.length >= 5) s = 0.3
    else s = 0.12
    if (/^[A-Z]/.test(w) && w.length >= 5 && s < 0.5) s += 0.12 // 专有名词
  }
  if (el?.closest(EMPH)) s += 0.4
  return Math.min(1, s)
}

function skip(el: Element | null): boolean {
  return !el || !!el.closest('.katex-mathml, .no-focus, .focus-skip, script, style')
}

function distToBox(x: number, y: number, b: Box): number {
  const dx = Math.max(b.x - x, 0, x - (b.x + b.width))
  const dy = Math.max(b.y - y, 0, y - (b.y + b.height))
  return Math.hypot(dx, dy)
}

function weightAt(kw: number, box: Box, x: number, y: number, radius: number): number {
  const d = distToBox(x, y, box)
  return kw * Math.max(0, 1 - Math.min(1, d / radius) ** 1.5)
}

export function sameMagnet(a: Magnet, b: Magnet): boolean {
  return a.node === b.node && a.start === b.start
}

/** 重算已经吸住的词：页面滚动过就更新位置，视线挪过就更新分数；词已经不在页面上（或折行了）就是 null */
export function refreshMagnet(m: Magnet, x: number, y: number, prm: SnapParams = snapParams()): Magnet | null {
  if (!m.node.isConnected) return null
  let box: Box
  if (m.node.nodeType === Node.ELEMENT_NODE) box = toBox((m.node as Element).getBoundingClientRect())
  else {
    const r = document.createRange()
    r.setStart(m.node, m.start)
    r.setEnd(m.node, m.end)
    const rects = mergeLineRects(r.getClientRects())
    if (rects.length !== 1) return null
    box = rects[0]
  }
  if (box.width < 1) return null
  return { ...m, box, weight: weightAt(m.kw, box, x, y, prm.radius) }
}

/** 探测点：横向铺到吸附半径的 1.3 倍（长词的一头落在点上就行），纵向上下各两行左右 */
function probes(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const sx = Math.max(24, radius * 0.3)
  const sy = Math.max(14, radius * 0.22)
  for (let dy = 0; dy <= radius * 0.5; dy += sy) {
    for (let dx = 0; dx <= radius * 1.3; dx += sx) {
      out.push([dx, dy])
      if (dx) out.push([-dx, dy])
      if (dy) out.push([dx, -dy])
      if (dx && dy) out.push([-dx, -dy])
    }
  }
  return out
}

/** 在窗口坐标 (x, y) 附近找最值得吸附的关键词；范围和门槛跟着吸附强度走 */
export function keywordNear(x: number, y: number, prm: SnapParams = snapParams()): Magnet | null {
  const radius = prm.radius
  const pane = panes.at(x, y)
  if (!pane || pane.kind === 'terminal' || pane.kind === 'screen') return null
  const root = pane.element()
  if (!root) return null
  const seen = new Set<string>()
  const nodeIds = new Map<Node, number>()
  const idOf = (n: Node): number => {
    let id = nodeIds.get(n)
    if (id == null) nodeIds.set(n, (id = nodeIds.size))
    return id
  }
  let best: Magnet | null = null

  const consider = (box: Box, text: string, kw: number, node: Node, start: number, end: number) => {
    if (kw < prm.threshold || box.width < 2) return
    if (distToBox(x, y, box) > radius) return
    const weight = weightAt(kw, box, x, y, radius)
    if (!best || weight > best.weight) best = { box, text, weight, kw, node, start, end }
  }

  for (const [dx, dy] of probes(radius)) {
    const r = document.caretRangeFromPoint(x + dx, y + dy)
    if (!r || r.startContainer.nodeType !== Node.TEXT_NODE) continue
    const node = r.startContainer as Text
    if (!root.contains(node) || skip(node.parentElement)) continue
    // 公式整块当一个关键词
    const k = node.parentElement?.closest('.katex')
    if (k) {
      const key = 'k:' + idOf(k)
      if (seen.has(key)) continue
      seen.add(key)
      consider(toBox(k.getBoundingClientRect()), k.textContent || '', 0.95, k, 0, 0)
      continue
    }
    const seg = segmentsOf(node).find((s) => s.word && r.startOffset >= s.start && r.startOffset <= s.end)
    if (!seg) continue
    const key = `${idOf(node)}:${seg.start}`
    if (seen.has(key)) continue
    seen.add(key)
    const word = node.data.slice(seg.start, seg.end)
    const range = document.createRange()
    range.setStart(node, seg.start)
    range.setEnd(node, seg.end)
    const rects = mergeLineRects(range.getClientRects())
    if (rects.length !== 1) continue // 跨行的词不吸
    consider(rects[0], word, keywordness(word, node.parentElement), node, seg.start, seg.end)
  }
  return best
}
