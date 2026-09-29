import type { TrayCommand, TrayStatus } from '../../shared/types'
import { la, uiStore, settingsStore, updateSettings, toast } from './appState'
import { gaze } from './gaze/engine'
import { input } from './input/joycon'
import { findJoyCons } from './input/haptics'
import { switchSide } from './focus/focus'
import { openViaDialog, newTerminal } from './panes/docs'

// 菜单栏图标：把状态推给主进程，执行菜单里点的命令

let last = ''

function push(): void {
  const g = gaze.status.get()
  const j = input.status.get()
  const s = settingsStore.get().s
  const st: TrayStatus = {
    gaze: g.state,
    source: g.source,
    face: g.face,
    calibrated: g.calibrated,
    cvErrorPx: g.cvErrorPx != null ? Math.round(g.cvErrorPx) : null,
    joyL: j.L.connected || j.P.connected,
    joyR: j.R.connected || j.P.connected,
    joyRestL: j.L.connected ? j.L.resting : j.P.connected && j.P.resting,
    joyRestR: j.R.connected ? j.R.resting : j.P.connected && j.P.resting,
    side: uiStore.get().side,
    jev: !!s?.jevMode
  }
  // 状态源里 fps 之类每秒都在变，只在菜单要显示的内容变了时才推
  const key = JSON.stringify(st)
  if (key === last) return
  last = key
  la.tray.status(st)
}

async function run(c: TrayCommand): Promise<void> {
  const s = settingsStore.get().s
  switch (c.cmd) {
    case 'gaze:toggle': {
      const on = ['running', 'loading'].includes(gaze.status.get().state)
      if (on) gaze.stop()
      else await gaze.start(s?.gaze.cameraId || undefined)
      toast(on ? '眼动追踪已暂停' : '眼动追踪已开启', 'info')
      return
    }
    case 'gaze:source': {
      if (!s || s.gaze.source === c.source) return
      await updateSettings((x) => ({ ...x, gaze: { ...x.gaze, source: c.source } }))
      await gaze.start(s.gaze.cameraId || undefined)
      toast(c.source === 'truedepth' ? '眼动输入源换成 iPhone 原深感了' : '眼动输入源换回 Mac 摄像头了', 'ok')
      if (!gaze.isCalibrated()) toast('这个输入源还没校准过：菜单栏图标 → 校准', 'info', { ttl: 6000 })
      return
    }
    case 'calibrate':
      return uiStore.patch({ showCalibration: true, calibrationKind: 'full' })
    case 'validate':
      if (gaze.isCalibrated()) uiStore.patch({ showCalibration: true, calibrationKind: 'validate' })
      return
    case 'open':
      return openViaDialog()
    case 'terminal':
      return newTerminal()
    case 'side':
      return switchSide(c.side)
    case 'jev': {
      const next = !s?.jevMode
      await updateSettings((x) => ({ ...x, jevMode: next }))
      toast(next ? 'Jev 模式已开启' : 'Jev 模式已关闭', 'jev')
      return
    }
    case 'settings':
      return uiStore.patch({ showSettings: true })
    case 'help':
      return uiStore.patch({ showHelp: true })
    case 'joy:find':
      findJoyCons(3)
      toast('手柄会「哔哔」响 3 秒，灯也在闪', 'info')
      return
  }
}

for (const store of [gaze.status, input.status, uiStore, settingsStore]) store.subscribe(push)
la.tray.onCommand((c) => {
  run(c).catch((e) => toast(`菜单操作失败：${e?.message || e}`, 'error'))
})
push()
