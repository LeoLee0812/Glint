// 全局模式的透明浮层：只负责把主窗口算好的视线点和焦点框画在整块屏幕上（屏幕坐标 = 浮层坐标）
const gazeEl = document.getElementById('gaze') as HTMLDivElement
const focusEl = document.getElementById('focus') as HTMLDivElement
const labelEl = document.getElementById('label') as HTMLDivElement

window.lookask.overlay.onState((s) => {
  if (s.gaze) {
    gazeEl.style.display = 'block'
    gazeEl.style.transform = `translate(${s.gaze.x}px, ${s.gaze.y}px)`
  } else {
    gazeEl.style.display = 'none'
  }
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
      labelEl.style.top = `${Math.max(0, s.focus.y - 24)}px`
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

export {}
