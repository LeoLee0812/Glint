import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { gaze } from './engine'
import { focus, gazeUsable, mousePos, clientInSide, exitPoint } from '../focus/focus'
import { keywordNear, refreshMagnet, sameMagnet, type Magnet } from '../focus/magnet'
import { magnetNow, snapParams } from '../focus/snap'
import { unionBox } from '../focus/types'
import { boundsStore, clientToScreen, screenToClient, settingsStore, uiStore } from '../appState'
import { GazeBlob, type BlobTarget } from './blob'

// 主窗口里的视线光环 + 焦点高亮
// 光环吸附规则：硬焦点 → 整个包住选中的词/句；软焦点 → 盯住时被附近的关键词吸过去，扫视时不吸
// 藏起来时不飞回左上角：眼睛去了另一侧就朝那个方向滑走、边走边淡，别的情况原地淡出
// 吸得多积极、多牢、多久才松开，都跟着「吸附强度」（设置 → 眼动）走；吸着的词记在 magnetNow，推右摇杆时从它起步

/** 页面一滚动，吸着的词位置就变了：下一帧立刻重新探一次，不等 90ms */
let magnetDirty = false

/** 点到框的距离（在框里就是 0） */
function distTo(p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }): number {
  return Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.width)), Math.max(b.y - p.y, 0, p.y - (b.y + b.height)))
}

function createTargetSource(): () => BlobTarget {
  let cur: Magnet | null = null
  let probeAt = 0
  let probePos = { x: -1e4, y: -1e4 }
  let prev: { x: number; y: number; t: number } | null = null
  let speed = 0
  /** 最后一次画出来的位置 */
  let shown = { x: 0, y: 0 }
  const fade = (to = shown): BlobTarget => {
    magnetNow.box = null
    return { x: to.x, y: to.y, visible: false }
  }

  return () => {
    const ui = uiStore.get()
    if (ui.showCalibration || settingsStore.get().s?.gaze.showCursor === false) return fade()

    let p: { x: number; y: number } | null = null
    let confidence = 1
    const smp = gaze.lastSample
    if (smp?.smooth && gazeUsable()) {
      p = screenToClient(smp.smooth.x, smp.smooth.y)
      confidence = smp.raw ? 1 : 0.4
    } else {
      // 没校准 / 看不到脸：跟着鼠标走（和「鼠标停住当注视」的兜底一致）
      p = mousePos()
    }
    if (!p) return fade()

    const now = performance.now()
    if (prev) {
      const dt = Math.max(1, now - prev.t) / 1000
      const v = Math.hypot(p.x - prev.x, p.y - prev.y) / dt
      speed += (v - speed) * 0.25
    }
    prev = { x: p.x, y: p.y, t: now }

    const st = focus.state.get()
    if (st.mode === 'hard' && st.sel?.space === 'client') {
      const u = unionBox(st.sel.rects)
      if (u) {
        shown = { x: u.x + u.width / 2, y: u.y + u.height / 2 }
        magnetNow.box = null
        return { x: p.x, y: p.y, visible: true, confidence, magnet: u, lock: true }
      }
    }

    // 只在视线跟着的那一侧画：眼睛去了另一边，光环就朝眼睛去的方向滑出窗口、边走边淡，免得以为焦点跟过去了
    // （内容模式往右看 → 往右滑到最右边；回答模式往左看 → 往左滑走）
    if (!clientInSide(p.x, p.y, ui.side, 24)) {
      const ex = exitPoint(clientToScreen(p.x, p.y), ui.side, boundsStore.get().content)
      return fade(screenToClient(ex.x, ex.y))
    }
    shown = { x: p.x, y: p.y }

    const prm = snapParams()
    // 扫视中不吸，免得光环在词之间乱跳
    if (speed > prm.saccade) {
      magnetNow.box = null
      return { x: p.x, y: p.y, visible: true, confidence }
    }

    // 最多每 90ms 探一次；视线一下子挪远了立刻再探
    if (magnetDirty || now - probeAt > 90 || Math.hypot(p.x - probePos.x, p.y - probePos.y) > 40) {
      magnetDirty = false
      probeAt = now
      probePos = { ...p }
      // 吸着的词先按现在的样子重算（页面滚动过位置就变了，视线挪过分数就变了）
      if (cur) cur = refreshMagnet(cur, p.x, p.y, prm)
      // 视线已经离开它够远了才松开；没走远时附近找不到别的词也继续吸着
      if (cur && distTo(p, cur.box) > prm.release) cur = null
      const cand = keywordNear(p.x, p.y, prm)
      // 迟滞：同一个词就直接更新；换别的词，要明显更好才换
      if (cand && (!cur || sameMagnet(cand, cur) || cand.weight > cur.weight * prm.switchRatio)) cur = cand
    }
    if (!cur) {
      magnetNow.box = null
      return { x: p.x, y: p.y, visible: true, confidence }
    }
    // 读书时视线本来就在慢慢挪，只有接近扫视的速度才明显减弱吸附
    const slow = 1 - Math.min(1, (speed / prm.saccade) ** 2)
    const strength = Math.min(prm.cap, prm.base + cur.weight * prm.slope) * slow
    magnetNow.box = cur.box
    magnetNow.text = cur.text
    magnetNow.strength = strength
    magnetNow.at = now
    return { x: p.x, y: p.y, visible: true, confidence, magnet: cur.box, strength }
  }
}

export function GazeLayer(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  const f = useStore(focus.state)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  // 光环自己跑 rAF 物理和绘制，不走 React 渲染
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const blob = new GazeBlob(cv, createTargetSource())
    blob.start()
    return () => blob.stop()
  }, [])

  // 任何滚动都要重算高亮框
  useEffect(() => {
    let pending = false
    const onScroll = () => {
      magnetDirty = true
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

  // 截图时整层先藏起来（截图上会另外画一个干净的蓝圈）
  const hidden = ui.showCalibration || ui.capturing

  return (
    <div className="gaze-layer" style={{ display: hidden ? 'none' : undefined }}>
      {f.sel?.space === 'client' &&
        f.sel.rects.map((r, i) => (
          <div
            key={i}
            className={`hl ${f.mode} g-${f.gran}`}
            style={{ left: r.x - 3, top: r.y - 2, width: r.width + 6, height: r.height + 4 }}
          />
        ))}
      {f.mode === 'hard' && f.sel?.space === 'client' && f.sel.rects[0] && (
        <div className="hl-label" style={{ left: f.sel.rects[0].x - 3, top: Math.max(4, f.sel.rects[0].y - 30) }}>
          {f.label}
        </div>
      )}
      <canvas className="gaze-canvas" ref={canvasRef} />
    </div>
  )
}
