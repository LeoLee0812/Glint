import { useRef, useState } from 'react'
import { useStore } from '../store'
import { gaze } from '../gaze/engine'
import { input } from '../input/joycon'
import { uiStore, settingsStore } from '../appState'
import { focus, switchSide } from '../focus/focus'
import { GRAN_LABEL } from '../focus/types'
import { Icon } from './Icon'
import logoUrl from '../assets/logo.png'
import { headAdviceStore } from '../gaze/headGuide'
import { jevStore } from '../jev/jevBrain'
import { JevLog } from '../jev/JevLog'

// 顶栏：平时只留手柄和粒度（词 / 句 / 段 / 节，点一下换档）；摄像头 / iPhone 出问题、还没校准、坐偏了才冒出提醒

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
  const jev = useStore(jevStore)
  const [jevOpen, setJevOpen] = useState(false)
  const jevRef = useRef<HTMLButtonElement>(null)

  const td = g.source === 'truedepth'
  const link = g.link
  // 眼动一切正常时不占顶栏；看不到脸交给下面「坐偏了」那颗提醒
  const camOk = g.state === 'running' && !g.dark && (!td || link?.state === 'live')
  const camText = td
    ? g.state === 'off'
      ? 'iPhone 没开'
      : !link || link.state === 'waiting'
        ? '等 iPhone 连接'
        : link.state === 'unpaired'
          ? 'iPhone 待配对'
          : link.state === 'lost'
            ? 'iPhone 断开了'
            : link.state === 'error'
              ? '原深感出错'
              : '启动中…'
    : g.state === 'running'
      ? '画面全黑'
      : g.state === 'loading'
        ? '启动中…'
        : g.state === 'error'
          ? /找不到摄像头|没有可用/.test(g.error || '')
            ? '没有摄像头'
            : '摄像头出错'
          : '摄像头没开'
  const camTitle = td
    ? link?.state === 'unpaired'
      ? '点这里输入手机上的配对码'
      : link?.state === 'error'
        ? link.msg || g.error || ''
        : '打开手机上的 Glint Eye'
    : g.dark
      ? '镜头被挡住了？可以在设置里换摄像头'
      : g.error || ''
  const onCamPill = () => {
    // 原深感没连好时点药丸直接去设置里看连接 / 配对
    if (td && link?.state !== 'live') return uiStore.patch({ showSettings: true, settingsTab: 'gaze' })
    if (g.dark) return uiStore.patch({ showSettings: true, settingsTab: 'gaze' })
    return gaze.start(s?.gaze.cameraId || undefined)
  }
  const calibrate = () => uiStore.patch({ showCalibration: true })

  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src={logoUrl} alt="" />
        <b>Glint</b>
        <span className="dim">瞳问</span>
      </div>
      <div className="status">
        {!camOk && (
          <span className={`pill cam-pill ${g.state === 'error' ? 'bad' : 'warn'}`} title={camTitle} onClick={onCamPill}>
            <Icon name={td ? 'phone' : 'eye'} />
            {camText}
          </span>
        )}
        {!g.calibrated && (
          <span className="pill warn" onClick={calibrate}>
            <Icon name="scope" />
            未校准
          </span>
        )}
        {g.calibrated && (head.advice || head.lost) && (
          <span className="pill warn" title="和校准时坐的位置不一样了，挪回去或者重新校准" onClick={calibrate}>
            <Icon name="person" />
            {head.lost ? '看不到脸' : head.advice!.main}
          </span>
        )}
        <span
          className={`pill ${j.L.connected || j.P.connected ? 'ok' : 'off'}${j.L.connected && j.L.resting ? ' rest' : ''}`}
          title={j.L.connected ? (j.L.resting ? '左手柄放在桌上，拿起来就恢复震动' : '左手柄已连接') : '左手柄没连，按一下它的任意键'}
        >
          <Icon name="gamepad" />L
          <Battery level={j.L.connected ? j.L.battery : -1} />
        </span>
        <span
          className={`pill ${j.R.connected || j.P.connected ? 'ok' : 'off'}${j.R.connected && j.R.resting ? ' rest' : ''}`}
          title={j.R.connected ? (j.R.resting ? '右手柄放在桌上，拿起来就恢复震动' : '右手柄已连接') : '右手柄没连，按一下它的任意键'}
        >
          <Icon name="gamepad" />R
          <Battery level={j.R.connected ? j.R.battery : -1} />
        </span>
        {/* 粒度：视线和右摇杆都按它选；点一下换一档，和手柄 R 一样（没手柄时就靠它） */}
        <button className={`pill focus-pill ${f.mode}`} onClick={() => focus.cycleGran()} title="换一档：词 → 句 → 段 → 节（手柄 R）">
          <Icon name={f.mode === 'hard' ? 'scope' : 'eye'} />
          {f.mode === 'none' ? GRAN_LABEL[f.unit] : (f.sel?.unit ?? GRAN_LABEL[f.gran])}
        </button>
        {/* Jev 开着：一颗紫色药丸，正在判断时上面一个点在呼吸；点开是判断记录 */}
        {s?.jevMode && (
          <button ref={jevRef} className={`pill jev${jev.busy > 0 ? ' busy' : ''}`} onClick={() => setJevOpen((o) => !o)} title="Jev 判断记录">
            Jev
          </button>
        )}
      </div>
      {jevOpen && s?.jevMode && <JevLog left={jevRef.current?.getBoundingClientRect().left ?? 200} onClose={() => setJevOpen(false)} />}
      <div className="actions">
        {/* 视线跟哪一边：左蓝右红，和两只 Joy-Con 的颜色、− / + 键对上 */}
        <div className="side-seg">
          <Icon name="eye" />
          <button className={`seg-l${ui.side === 'left' ? ' on' : ''}`} onClick={() => switchSide('left')} title="视线跟左边">
            <kbd>−</kbd>
          </button>
          <button className={`seg-r${ui.side === 'right' ? ' on' : ''}`} onClick={() => switchSide('right')} title="视线跟右边">
            <kbd>+</kbd>
          </button>
        </div>
        <button className="btn sm primary" onClick={calibrate}>
          校准
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
