import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { uiStore, settingsStore, loadSettingsIntoStore, updateSettings, toast } from './appState'
import { gaze } from './gaze/engine'
import { panes } from './focus/focus'
import { createScreenAdapter } from './focus/screenAdapter'
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

export default function App(): React.JSX.Element {
  const ui = useStore(uiStore)
  const s = useStore(settingsStore).s
  const [ratio, setRatio] = useState(0.62)
  const dragging = useRef(false)

  useEffect(() => {
    const off = panes.register(createScreenAdapter())
    loadAvatar().catch(() => undefined)
    loadSettingsIntoStore().then((st) => {
      setRatio(st.leftRatio || 0.62)
      gaze.setSmoothing(st.gaze.smoothing)
      gaze.start(st.gaze.cameraId || undefined)
      const chatProvider = st.providers.find((p) => p.id === st.chatModel.providerId)
      if (!chatProvider?.apiKey) {
        toast('还没配置大模型 Key：设置 → 模型服务', 'warn', { ttl: 8000, action: { label: '去设置', run: () => uiStore.patch({ showSettings: true }) } })
      } else if (!gaze.isCalibrated()) {
        toast('先做一次眼动校准（约 30 秒），视线才能对上屏幕', 'info', {
          ttl: 9000,
          action: { label: '开始校准', run: () => uiStore.patch({ showCalibration: true, calibrationKind: 'full' }) }
        })
      }
    })
    return off
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

  const global = ui.mode === 'global'

  return (
    <div className={`app mode-${ui.mode} side-${ui.side} ${ui.capturing ? 'capturing' : ''}`}>
      <TopBar />
      <main className="split" style={{ gridTemplateColumns: global ? '1fr' : `${ratio}fr 6px ${1 - ratio}fr` }}>
        {/* 全局模式只是藏起来不卸载，终端里的会话不能断 */}
        <div className="left-wrap" style={{ display: global ? 'none' : 'flex' }}>
          <LeftPane />
        </div>
        <div
          className="splitter"
          style={{ display: global ? 'none' : 'block' }}
          onMouseDown={() => {
            dragging.current = true
            document.body.classList.add('resizing')
          }}
        />
        <ChatPane />
      </main>
      <GazeLayer />
      <Calibration />
      <SettingsDialog />
      <JoyHelp />
      <HeadGuide />
      <PhotoBooth />
      <Toasts />
      {!s && <div className="boot">启动中…</div>}
    </div>
  )
}
