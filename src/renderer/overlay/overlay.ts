import { GazeBlob, type BlobTarget } from '../src/gaze/blob'
import type { OverlayState } from '../../shared/types'

// 全局模式的透明浮层：把主窗口算好的视线点和焦点框画在整块屏幕上（屏幕坐标 = 浮层坐标）
// 视线光环在这里自己跑物理动画；硬焦点时光环包住焦点框
const focusEl = document.getElementById('focus') as HTMLDivElement
const labelEl = document.getElementById('label') as HTMLDivElement
const canvas = document.getElementById('blob') as HTMLCanvasElement

let state: OverlayState = { gaze: null, focus: null, mode: 'soft' }
/** 最后一次画出来的位置：藏起来时原地淡出，不飞回左上角 */
let shown = { x: 0, y: 0 }

new GazeBlob(canvas, (): BlobTarget => {
  // 眼睛去了视线不跟的那一侧：朝那个方向滑走、边走边淡；别的情况原地淡出
  if (!state.gaze) {
    const to = state.exit ?? shown
    return { x: to.x, y: to.y, visible: false }
  }
  const hard = state.mode === 'hard' && state.focus
  shown = hard && state.focus ? { x: state.focus.x + state.focus.width / 2, y: state.focus.y + state.focus.height / 2 } : { ...state.gaze }
  return { x: state.gaze.x, y: state.gaze.y, visible: true, magnet: hard ? state.focus : null, lock: !!hard }
}).start()

window.lookask.overlay.onState((s) => {
  state = s
  if (s.focus) {
    focusEl.style.display = 'block'
    focusEl.className = s.mode === 'soft' ? 'soft' : ''
    focusEl.style.left = `${s.focus.x}px`
    focusEl.style.top = `${s.focus.y}px`
    focusEl.style.width = `${s.focus.width}px`
    focusEl.style.height = `${s.focus.height}px`
    if (s.label) {
      labelEl.style.display = 'block'
      labelEl.textContent = s.label
      labelEl.style.left = `${s.focus.x}px`
      labelEl.style.top = `${Math.max(0, s.focus.y - 30)}px`
    } else {
      labelEl.style.display = 'none'
    }
  } else {
    focusEl.style.display = 'none'
    labelEl.style.display = 'none'
  }
})

// 主进程截图前会让浮层先隐身一帧
window.lookask.overlay.onVisible((v) => {
  document.body.style.visibility = v ? 'visible' : 'hidden'
})
