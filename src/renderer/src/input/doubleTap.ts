import { focus } from '../focus/focus'
import { ask } from '../chat/chatStore'
import { rumble, uiStore } from '../appState'
import { guideModal } from '../onboarding'

// 平板：不连手柄也能用。双击论文的某一块，直接解释那一段（扫描页走截图，和按 A 同一条路）；双击回答里的某处，往下开解释卡片

const MAX_GAP_MS = 350
const MAX_MOVE_PX = 30
/** 手指抬起前移动超过这么多就是在滑动，不算点 */
const TAP_SLOP_PX = 12

let down: { x: number; y: number } | null = null
let lastTap: { x: number; y: number; t: number } | null = null

function tappable(el: Element | null): boolean {
  if (!el) return false
  if (
    el.closest(
      'button, a, input, textarea, select, label, .tabs, .topbar, .composer, .buddy',
    )
  )
    return false
  return !!el.closest('.left-body, .msgs')
}

function install(): void {
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return
    down = { x: e.clientX, y: e.clientY }
  })

  window.addEventListener('pointercancel', () => {
    down = null
  })

  window.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary || !down) return
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
    down = null
    const ui = uiStore.get()
    if (
      moved > TAP_SLOP_PX ||
      ui.showCalibration ||
      ui.showSettings ||
      ui.showHelp ||
      ui.showBooth ||
      guideModal() ||
      !tappable(e.target as Element)
    ) {
      lastTap = null
      return
    }
    const now = performance.now()
    const prev = lastTap
    if (
      prev &&
      now - prev.t < MAX_GAP_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < MAX_MOVE_PX
    ) {
      lastTap = null
      // 双击的是「这一块」：不管现在粒度是什么，都高亮并解释整段
    focus.setUnit('paragraph')
    focus.focusAt(e.clientX, e.clientY, 'hard')
      if (focus.state.get().mode !== 'hard') return
        ask('explain', { gran: 'paragraph' })
      rumble('tick', 'R')
      return
    }
    lastTap = { x: e.clientX, y: e.clientY, t: now }
  })
}

if ((window.lookask.platform as string) === 'android') install()
