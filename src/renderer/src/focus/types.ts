// 焦点系统的公共类型：每种左侧视图（Markdown / PDF / 终端）和右侧对话都实现 PaneAdapter

export type Granularity = 'word' | 'sentence' | 'paragraph' | 'section'

export const GRAN_ORDER: Granularity[] = ['word', 'sentence', 'paragraph', 'section']
export const GRAN_LABEL: Record<Granularity, string> = { word: '词', sentence: '句', paragraph: '段', section: '节' }

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Selection {
  rects: Box[]
  /** 主窗口坐标 */
  space: 'client'
  text: string
  gran: Granularity
  /** 所在块的稳定标识，给 Jev 统计停留和回看 */
  blockKey?: string
}

export type SourceKind = 'markdown' | 'pdf' | 'terminal' | 'chat'

export interface FocusContext {
  source: SourceKind
  docTitle: string
  location: string
  gran: Granularity
  selection: string
  paragraph: string
  section?: string
  before?: string
  after?: string
  image?: string
  /** 终端上附带的大段原文 */
  extra?: string
  /** 焦点落在哪条消息 / 哪张解释卡片里（对话区用，决定解释窗口从哪一层往下裂变） */
  ref?: string
  /** 对话区：这段回答当初是在回应什么 */
  origin?: string
  /** 整张截图：截的是哪一块（左侧阅读区 / 右侧回答区 / 整块屏幕） */
  region?: string
  /** 整张截图上有没有画蓝圈标出视线位置 */
  circle?: boolean
}

export type Anchor = { pane: string } & Record<string, any>

export type Dir = 'left' | 'right' | 'up' | 'down'

export interface PaneAdapter {
  id: string
  kind: SourceKind
  /** 命中测试和滚动用的容器 */
  element(): HTMLElement | null
  anchorAt(x: number, y: number): Anchor | null
  move(a: Anchor, dir: Dir): Anchor | null
  /** 按段跳（十字键上下） */
  moveBlock?(a: Anchor, dir: 'up' | 'down'): Anchor | null
  select(a: Anchor, gran: Granularity): Selection | null
  context(a: Anchor, gran: Granularity): Promise<FocusContext>
  scrollBy(dy: number): void
  page?(delta: number): void
  /** 截取焦点区域的画面（客户端坐标矩形），返回 dataURL */
  capture?(rect: Box): Promise<string | null>
}

export function unionBox(rects: Box[]): Box | null {
  if (!rects.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.width)
    y2 = Math.max(y2, r.y + r.height)
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

export function toBox(r: DOMRect | DOMRectReadOnly): Box {
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

export function clip(s: string, n: number): string {
  const t = s.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
