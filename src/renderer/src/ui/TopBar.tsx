import { useStore } from '../store'
import { gaze } from '../gaze/engine'
import { input } from '../input/joycon'
import { uiStore, setUiMode, settingsStore } from '../appState'
import { focus, switchSide } from '../focus/focus'
import { GRAN_LABEL } from '../focus/types'
import { Icon } from './Icon'
import { headAdviceStore } from '../gaze/headGuide'

// 顶栏：摄像头 / 校准 / 手柄状态一眼可见，常用操作一键直达

function Battery({ level }: { level: number }): React.JSX.Element | null {
  if (level < 0) return null
  return <span className={`bat b${level}`} title={`电量 ${level}/4`} />
}

export function TopBar(): React.JSX.Element {
  const g = useStore(gaze.status)
  const j = useStore(input.status)
  const ui = useStore(uiStore)
  const f = useStore(focus.state)
  const s = useStore(settingsStore).s
  const head = useStore(headAdviceStore)

  const camText =
    g.state === 'running'
      ? g.dark
        ? '画面全黑'
        : g.face
          ? `${g.fps} fps`
          : '看不到脸'
      : g.state === 'loading'
        ? '启动中…'
        : g.state === 'error'
          ? /没有可用/.test(g.error || '')
            ? '没有摄像头'
            : '摄像头出错'
          : '摄像头未开'
  const calText = g.calibrated ? (g.cvErrorPx != null ? `误差≈${Math.round(g.cvErrorPx)}` : '已校准') : '未校准'

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="eye" />
        </span>
        <b>LookAsk</b>
        <span className="dim">看哪问哪</span>
      </div>
      <div className="status">
        <span
          className={`pill ${g.state === 'running' && g.face ? 'ok' : g.state === 'error' ? 'bad' : 'warn'}`}
          title={g.dark ? `${g.cameraLabel} 的画面是黑的：镜头被挡住了？在设置 → 眼动里换一个摄像头` : g.error || g.cameraLabel}
          onClick={() => (g.state === 'running' ? gaze.stop() : gaze.start(s?.gaze.cameraId || undefined))}
        >
          <Icon name="eye" />
          {camText}
        </span>
        <span
          className={`pill ${g.calibrated ? 'ok' : 'warn'}`}
          title={g.driftPx ? `已做漂移校正 ${g.driftPx} 点` : '点这里校准'}
          onClick={() => uiStore.patch({ showCalibration: true, calibrationKind: 'full' })}
        >
          <Icon name="scope" />
          {calText}
          {g.driftPx ? ` · 漂移${g.driftPx}` : ''}
        </span>
        {g.calibrated && (head.advice || head.lost) && (
          <span
            className="pill warn"
            title="头的位置和校准时不一样，视线会偏：挪回去，或者就在这儿重新校准"
            onClick={() => uiStore.patch({ showCalibration: true, calibrationKind: 'full' })}
          >
            <Icon name="person" />
            {head.lost ? '看不到脸' : head.advice!.main}
          </span>
        )}
        <span className={`pill ${j.L.connected || j.P.connected ? 'ok' : 'off'}`} title={j.L.connected ? '左手柄已连接' : '左手柄没连：按一下它的任意键唤醒'}>
          <Icon name="gamepad" />L
          <Battery level={j.L.connected ? j.L.battery : -1} />
        </span>
        <span className={`pill ${j.R.connected || j.P.connected ? 'ok' : 'off'}`} title={j.R.connected ? '右手柄已连接' : '右手柄没连：按一下它的任意键唤醒'}>
          <Icon name="gamepad" />R
          <Battery level={j.R.connected ? j.R.battery : -1} />
        </span>
        {f.mode !== 'none' && (
          <span className={`pill focus-pill ${f.mode}`}>
            <Icon name={f.mode === 'hard' ? 'scope' : 'eye'} />
            {GRAN_LABEL[f.gran]}
          </span>
        )}
        {s?.jevMode && <span className="pill jev">Jev</span>}
      </div>
      <div className="actions">
        <div className="side-seg" title="视线跟哪一边：左手柄 − 跟左边内容，右手柄 + 跟右边的 AI 回答（看另一边时焦点不会跑过去）">
          <Icon name="eye" />
          <button className={ui.side === 'left' ? 'on' : ''} onClick={() => switchSide('left')}>
            {ui.mode === 'global' ? '屏幕' : '内容'}
            <kbd>−</kbd>
          </button>
          <button className={ui.side === 'right' ? 'on' : ''} onClick={() => switchSide('right')}>
            回答
            <kbd>+</kbd>
          </button>
        </div>
        <button className="btn sm primary" onClick={() => uiStore.patch({ showCalibration: true, calibrationKind: 'full' })}>
          校准
        </button>
        <button className="btn sm ghost" onClick={() => uiStore.patch({ showCalibration: true, calibrationKind: 'validate' })} disabled={!g.calibrated}>
          测精度
        </button>
        <button className="btn sm ghost" onClick={() => setUiMode(ui.mode === 'global' ? 'normal' : 'global')}>
          {ui.mode === 'global' ? '退出全局' : '全局模式'}
        </button>
        <button className="btn sm ghost" onClick={() => uiStore.patch({ showHelp: true })} title="按键说明">
          ？
        </button>
        <button className="btn sm ghost" onClick={() => uiStore.patch({ showSettings: true })}>
          设置
        </button>
      </div>
    </header>
  )
}
