import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { gaze } from './engine'
import { focus } from '../focus/focus'
import { screenToClient, settingsStore, uiStore } from '../appState'

// 主窗口里的视线圈 + 焦点高亮（全局模式下这些画在透明浮层里，这里不画）

export function GazeLayer(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  const f = useStore(focus.state)
  const s = useStore(settingsStore).s
  const dotRef = useRef<HTMLDivElement>(null)

  // 视线点用 rAF 直接改 DOM，不走 React 渲染
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const el = dotRef.current
      const smp = gaze.lastSample
      if (el) {
        if (smp?.smooth && gaze.isCalibrated() && s?.gaze.showCursor !== false) {
          const p = screenToClient(smp.smooth.x, smp.smooth.y)
          el.style.transform = `translate(${p.x}px, ${p.y}px)`
          el.style.opacity = smp.raw ? '1' : '0.35'
        } else el.style.opacity = '0'
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [s?.gaze.showCursor])

  // 任何滚动都要重算高亮框
  useEffect(() => {
    let pending = false
    const onScroll = () => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        focus.refresh()
      })
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  if (ui.mode === 'global' || ui.showCalibration) return null

  return (
    <div className="gaze-layer">
      {f.sel?.space === 'client' &&
        f.sel.rects.map((r, i) => (
          <div
            key={i}
            className={`hl ${f.mode} g-${f.gran}`}
            style={{ left: r.x - 3, top: r.y - 2, width: r.width + 6, height: r.height + 4 }}
          />
        ))}
      {f.mode === 'hard' && f.sel?.space === 'client' && f.sel.rects[0] && (
        <div className="hl-label" style={{ left: f.sel.rects[0].x - 3, top: Math.max(4, f.sel.rects[0].y - 24) }}>
          {f.label}
        </div>
      )}
      <div className="gaze-dot" ref={dotRef} />
    </div>
  )
}
