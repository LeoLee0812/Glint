import { clientToScreen, screenToClient, la, toast, uiStore, type Side } from '../appState'
import { focus, gazeUsable, mousePos, sideOfPane } from './focus'
import { gaze } from '../gaze/engine'
import { activeDoc } from '../panes/docs'
import type { Box, FocusContext, SourceKind } from './types'
import { toBox, unionBox } from './types'

// 看图问：把视线跟着的那一侧整块截下来，在眼睛看的地方画一个蓝圈，交给看图模型「重点解释蓝圈里的东西」
// 不用再先精确选中是哪一行：眼动只到段落级也够用，剩下的让视觉模型自己从图里认

/** 蓝圈（屏幕坐标），from 记下它是按什么定的 */
interface Circle {
  cx: number
  cy: number
  rx: number
  ry: number
  from: 'hard' | 'gaze' | 'soft' | 'mouse'
}

/** 发给模型的图最长边，再大也看不出更多东西，只是更慢更贵 */
const MAX_EDGE = 1600
const BLUE = 'rgb(0, 122, 255)'

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

function contains(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
}

/** 截哪一块（屏幕坐标）：左边 = 阅读区（不含标签栏），右边 = 回答区 + 解释窗口 */
function captureRegion(side: Side): Box | null {
  const sels = side === 'left' ? ['.left-body'] : ['.msgs', '.fork']
  const rects = sels
    .map((q) => document.querySelector(q)?.getBoundingClientRect())
    .filter((r): r is DOMRect => !!r && r.width > 4 && r.height > 4)
    .map(toBox)
  const u = unionBox(rects)
  if (!u) return null
  const p = clientToScreen(u.x, u.y)
  return { x: p.x, y: p.y, width: u.width, height: u.height }
}

/** 焦点框换成屏幕坐标 */
function focusBoxScreen(): Box | null {
  const sel = focus.state.get().sel
  const u = sel ? unionBox(sel.rects) : null
  if (!u) return null
  const p = clientToScreen(u.x, u.y)
  return { x: p.x, y: p.y, width: u.width, height: u.height }
}

/** 蓝圈画在哪：硬焦点 > 视线 > 刚跟过视线的软焦点 > 鼠标；落在截图范围外就不画 */
function pickCircle(region: Box, side: Side): Circle | null {
  const st = focus.state.get()
  const onSide = sideOfPane(st.paneId) === side
  const fb = onSide ? focusBoxScreen() : null
  // 1. 硬焦点：用户已经用摇杆点准了，整个圈住
  if (st.mode === 'hard' && fb && contains(region, fb.x + fb.width / 2, fb.y + fb.height / 2)) {
    return { cx: fb.x + fb.width / 2, cy: fb.y + fb.height / 2, rx: Math.max(30, fb.width / 2 + 16), ry: Math.max(22, fb.height / 2 + 14), from: 'hard' }
  }
  // 2. 视线：圈的大小跟校准误差走，误差大就圈大一点
  const g = gazeUsable() ? gaze.lastSample?.smooth : null
  if (g && contains(region, g.x, g.y)) {
    const r = Math.max(46, Math.min(110, (gaze.status.get().cvErrorPx ?? 140) * 0.6))
    return { cx: g.x, cy: g.y, rx: r, ry: r, from: 'gaze' }
  }
  // 3. 软焦点：最近 10 秒还跟着视线的那段（按键时眼睛可能已经挪到按钮上了）
  if (st.mode === 'soft' && fb && focus.isFresh(10000) && contains(region, fb.x + fb.width / 2, fb.y + fb.height / 2)) {
    return { cx: fb.x + fb.width / 2, cy: fb.y + fb.height / 2, rx: Math.min(260, fb.width / 2 + 16), ry: Math.min(150, fb.height / 2 + 14), from: 'soft' }
  }
  // 4. 鼠标：没有眼动时的兜底
  const m = mousePos()
  if (m) {
    const p = clientToScreen(m.x, m.y)
    if (contains(region, p.x, p.y)) return { cx: p.x, cy: p.y, rx: 50, ry: 50, from: 'mouse' }
  }
  return null
}

/** 截图：截之前先把视线圈、焦点框、小人藏两帧 */
async function grab(region: Box): Promise<string | null> {
  const c = screenToClient(region.x, region.y)
  uiStore.patch({ capturing: true })
  try {
    await nextFrame()
    await nextFrame()
    return await la.win.capture({ x: c.x, y: c.y, width: region.width, height: region.height })
  } finally {
    uiStore.patch({ capturing: false })
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('截图解码失败'))
    img.src = src
  })
}

/** 在截图上画蓝圈（白色衬边，深色背景上也显眼），顺便缩到最长边 1600、转 JPEG */
async function annotate(dataUrl: string, region: Box, c: Circle | null): Promise<string> {
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const cv = document.createElement('canvas')
  cv.width = Math.max(1, Math.round(img.naturalWidth * scale))
  cv.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const g = cv.getContext('2d')!
  g.drawImage(img, 0, 0, cv.width, cv.height)
  if (c) {
    // 屏幕点 → 输出像素
    const k = cv.width / region.width
    const x = (c.cx - region.x) * k
    const y = (c.cy - region.y) * k
    const lw = Math.max(3, 3.2 * k)
    g.beginPath()
    g.ellipse(x, y, c.rx * k, c.ry * k, 0, 0, Math.PI * 2)
    g.lineWidth = lw + Math.max(3, 2.6 * k)
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)'
    g.stroke()
    g.lineWidth = lw
    g.strokeStyle = BLUE
    g.stroke()
  }
  return cv.toDataURL('image/jpeg', 0.9)
}

const KIND_LABEL: Partial<Record<string, string>> = { pdf: 'PDF', md: 'Markdown' }

/** 截的是哪一块，给提示词和气泡用 */
function describe(side: Side): { region: string; source: SourceKind; docTitle: string } {
  if (side === 'right') return { region: '右侧 AI 回答区', source: 'chat', docTitle: '右侧对话' }
  const d = activeDoc()
  if (d?.kind === 'terminal') return { region: '左侧终端（多半在跑 Qwen Code）', source: 'terminal', docTitle: d.title }
  const k = d ? KIND_LABEL[d.kind] : undefined
  return { region: `左侧阅读区${k ? `（${k}《${d!.title}》）` : ''}`, source: d?.kind === 'pdf' ? 'pdf' : 'markdown', docTitle: d?.title || '左侧' }
}

/**
 * 看图问的上下文：视线跟着的那一侧整块截图，眼睛看的地方画蓝圈。
 * 焦点正好就在蓝圈那儿时，顺带附上页面文字层里的原文（模型认字更准）。失败返回 null（已提示过）
 */
export async function snapshot(): Promise<FocusContext | null> {
  const side = uiStore.get().side
  const region = captureRegion(side)
  if (!region) {
    toast('没找到要截的区域', 'warn')
    return null
  }
  const circle = pickCircle(region, side)
  // 先定蓝圈再取文字：取文字可能会把焦点吸到视线处
  const st = focus.state.get()
  const fb = sideOfPane(st.paneId) === side ? focusBoxScreen() : null
  const textNear =
    !!circle &&
    !!fb &&
    (circle.from === 'hard' ||
      circle.from === 'soft' ||
      Math.hypot(Math.max(fb.x - circle.cx, 0, circle.cx - fb.x - fb.width), Math.max(fb.y - circle.cy, 0, circle.cy - fb.y - fb.height)) < circle.rx)
  const [raw, near] = await Promise.all([grab(region), textNear ? focus.context() : Promise.resolve(null)])
  if (!raw) {
    toast('截图失败了，再按一次试试', 'warn')
    return null
  }
  let image: string
  try {
    image = await annotate(raw, region, circle)
  } catch (e: any) {
    toast(`截图处理失败：${e?.message || e}`, 'error')
    return null
  }
  const d = describe(side)
  return {
    source: near?.source ?? d.source,
    docTitle: near?.docTitle || d.docTitle,
    location: near?.location ?? '',
    gran: near?.gran ?? 'paragraph',
    selection: near?.selection ?? '',
    paragraph: near?.paragraph ?? '',
    section: near?.section,
    ref: near?.ref,
    image,
    region: d.region,
    circle: !!circle
  }
}
