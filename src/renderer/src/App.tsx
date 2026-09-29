import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { uiStore, settingsStore, loadSettingsIntoStore, updateSettings } from './appState'
import { gaze } from './gaze/engine'
import { TopBar } from './ui/TopBar'
import { LeftPane } from './panes/LeftPane'
import { ChatPane } from './chat/ChatPane'
import { GazeLayer } from './gaze/GazeLayer'
import { Calibration } from './gaze/Calibration'
import { SettingsDialog } from './settings/SettingsDialog'
import { JoyHelp } from './ui/JoyHelp'
import { Toasts } from './ui/Toasts'
import { HeadGuide } from './ui/HeadGuide'
import { PhotoBooth } from './ui/PhotoBooth'
import { loadAvatar } from './avatar/avatar'
import { startOnboarding } from './onboarding'

export default function App(): React.JSX.Element {
  const ui = useStore(uiStore)
  const s = useStore(settingsStore).s
  const [ratio, setRatio] = useState(0.62)
  const dragging = useRef(false)

  useEffect(() => {
    // 小人和设置都读完再决定要不要走首次引导（已经有小人的老用户不弹拍照）
    Promise.all([loadAvatar().catch(() => undefined), loadSettingsIntoStore()]).then(([, st]) => {
      setRatio(st.leftRatio || 0.62)
      gaze.setSmoothing(st.gaze.smoothing)
      gaze.start(st.gaze.cameraId || undefined)
      startOnboarding()
    })
  }, [])

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      setRatio(Math.min(0.8, Math.max(0.3, e.clientX / window.innerWidth)))
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.classList.remove('resizing')
      setRatio((r) => {
        updateSettings((x) => ({ ...x, leftRatio: r }))
        return r
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  return (
    <div className={`app mode-${ui.mode} side-${ui.side} ${ui.capturing ? 'capturing' : ''}`}>
      <TopBar />
      <main className="split" style={{ gridTemplateColumns: `${ratio}fr 6px ${1 - ratio}fr` }}>
        <div className="left-wrap">
          <LeftPane />
        </div>
        <div
          className="splitter"
          onMouseDown={() => {
            dragging.current = true
            document.body.classList.add('resizing')
          }}
        />
        <ChatPane />
      </main>
      <GazeLayer />
      <Calibration />
      <HeadGuide />
      {/* 拍照窗口在设置下面：拍照时发现没填 Key，设置叠在它上面填完再回来接着生成 */}
      <PhotoBooth />
      <SettingsDialog />
      <JoyHelp />
      <Toasts />
      {!s && <div className="boot">启动中…</div>}
    </div>
  )
}
