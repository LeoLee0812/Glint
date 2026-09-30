import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { uiStore, settingsStore, updateSettings, la } from '../appState'
import { input, type Btn } from '../input/joycon'
import { haptic } from '../input/haptics'
import { gaze } from '../gaze/engine'
import { focus, switchSide } from '../focus/focus'
import { GRAN_LABEL, GRAN_ORDER, type Granularity } from '../focus/types'
import { chatStore } from '../chat/chatStore'
import { activate } from '../panes/docs'
import { avatarStore } from '../avatar/avatar'
import { guideStore, goGuide, closeGuide, hasChatKey, type GuideStep } from '../onboarding'
import { KeyCap, Kbd, Diamond, sideOf } from './JoyKeys'
import { JoyConArt } from './JoyConArt'
import { Icon } from './Icon'
import logoUrl from '../assets/logo.png'

// 新手引导的界面：前几步是居中的卡片（这时手柄按键只归引导），「试一试」是贴在左下角的小卡片，
// 按键照常生效，做对一步勾一步

const ORDER: GuideStep[] = ['welcome', 'joycon', 'key', 'calibrate', 'practice', 'done']

/** 下一步 / 上一步：Key 已经填好就跳过填 Key 那一步 */
function stepFrom(step: GuideStep, dir: 1 | -1): GuideStep {
  let i = ORDER.indexOf(step) + dir
  if (ORDER[i] === 'key' && hasChatKey()) i += dir
  return ORDER[Math.max(0, Math.min(ORDER.length - 1, i))]
}

/** 这次的校准是不是从引导里点开的：校准完回来接着往下走 */
let calibFromGuide = false

export function Guide(): React.JSX.Element | null {
  const g = useStore(guideStore)
  const ui = useStore(uiStore)

  // 从引导点开的校准做完了：接着「试一试」；没校准成（中途退出）就留在这一步
  const wasCalib = useRef(false)
  useEffect(() => {
    if (ui.showCalibration) wasCalib.current = true
    else if (wasCalib.current) {
      wasCalib.current = false
      if (calibFromGuide && guideStore.get().step === 'calibrate' && gaze.isCalibrated()) goGuide('practice')
      calibFromGuide = false
    }
  }, [ui.showCalibration])

  if (!g.step) return null
  // 校准、拍照、设置弹出来时先让开
  if (ui.showCalibration || ui.showBooth || ui.showSettings) return null
  if (g.step === 'practice') return <Coach keyboard={g.keyboard} />
  return <GuideCard step={g.step} keyboard={g.keyboard} />
}

// ---------- 居中的卡片 ----------

type Actions = { primary?: { label: string; run: () => void; disabled?: boolean }; back?: () => void }

function GuideCard({ step, keyboard }: { step: GuideStep; keyboard: boolean }): React.JSX.Element {
  const act = useRef<Actions>({})

  // A / ⌥↩ = 主按钮，B / Esc = 上一步；回车也算主按钮（输入框里由输入框自己处理）
  useEffect(() => {
    const offA = input.onAction((a) => {
      if (a === 'confirm') {
        const p = act.current.primary
        if (p && !p.disabled) p.run()
      } else if (a === 'cancel') act.current.back?.()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.altKey || e.isComposing) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.closest('.xterm'))) return
      const p = act.current.primary
      if (p && !p.disabled) {
        e.preventDefault()
        p.run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      offA()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const setActions = (a: Actions) => {
    act.current = a
  }

  const body =
    step === 'welcome' ? (
      <Welcome setActions={setActions} />
    ) : step === 'joycon' ? (
      <JoyconStep setActions={setActions} />
    ) : step === 'key' ? (
      <KeyStep setActions={setActions} />
    ) : step === 'calibrate' ? (
      <CalibrateStep setActions={setActions} keyboard={keyboard} />
    ) : (
      <DoneStep setActions={setActions} />
    )

  return (
    <div className="modal-mask guide-mask">
      <div className={`modal guide step-${step}`}>
        {step !== 'welcome' && step !== 'done' && <Progress step={step} />}
        {body}
      </div>
    </div>
  )
}

function Progress({ step }: { step: GuideStep }): React.JSX.Element {
  const items: Array<[GuideStep, string]> = [
    ['joycon', '手柄'],
    ['key', 'Key'],
    ['calibrate', '校准'],
    ['practice', '试一试']
  ]
  const cur = ORDER.indexOf(step)
  return (
    <ol className="guide-progress">
      {items.map(([k, label]) => {
        const i = ORDER.indexOf(k)
        return (
          <li key={k} className={i < cur ? 'done' : i === cur ? 'on' : ''}>
            <i />
            {label}
          </li>
        )
      })}
    </ol>
  )
}

function Foot({ primary, back, extra }: Actions & { extra?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="guide-foot">
      {back && (
        <button className="btn ghost" onClick={back}>
          上一步
        </button>
      )}
      {extra}
      <span className="grow" />
      {primary && (
        <button className="btn primary" onClick={primary.run} disabled={primary.disabled}>
          {primary.label}
        </button>
      )}
    </div>
  )
}

type StepProps = { setActions: (a: Actions) => void }

function Welcome({ setActions }: StepProps): React.JSX.Element {
  const a: Actions = { primary: { label: '开始（A）', run: () => goGuide('joycon') } }
  setActions(a)
  return (
    <>
      <div className="guide-hero">
        <img className="guide-logo" src={logoUrl} alt="" />
        <h1>Glint 瞳问</h1>
        <p className="guide-lead">眼睛选内容，手柄来提问。</p>
        <p>两三分钟：连上手柄，校准眼睛，再问第一个问题。</p>
      </div>
      <Foot
        {...a}
        extra={
          <button className="btn ghost" onClick={() => closeGuide(true)}>
            跳过引导
          </button>
        }
      />
    </>
  )
}

function JoyconStep({ setActions }: StepProps): React.JSX.Element {
  const j = useStore(input.status)
  const L = j.L.connected || j.P.connected
  const R = j.R.connected || j.P.connected
  const both = L && R
  const [lit, setLit] = useState<Set<Btn>>(new Set())

  // 按哪个键，示意图上哪个键亮一下，手柄跟着震一下
  useEffect(() => {
    return input.onButton((e) => {
      if (!e.down || e.long || e.source !== 'joycon') return
      setLit((s) => new Set(s).add(e.btn))
      setTimeout(
        () =>
          setLit((s) => {
            const n = new Set(s)
            n.delete(e.btn)
            return n
          }),
        260
      )
      haptic('tick', sideOf(e.btn))
    })
  }, [])

  // 刚连上的那只「嗡」一下打个招呼
  const prev = useRef({ L, R })
  useEffect(() => {
    if (L && !prev.current.L) haptic('done', 'L')
    if (R && !prev.current.R) haptic('done', 'R')
    prev.current = { L, R }
  }, [L, R])

  const a: Actions = {
    primary: { label: '下一步（A）', run: () => goGuide(stepFrom('joycon', 1)), disabled: !both },
    back: () => goGuide('welcome')
  }
  setActions(a)

  return (
    <>
      <h2>连上 Joy-Con</h2>
      <div className="guide-joy">
        <figure className={L ? 'on' : ''}>
          <JoyConArt side="L" connected={L} lit={lit} />
          <figcaption>{L ? '左手柄连上了' : '左手柄'}</figcaption>
        </figure>
        <figure className={R ? 'on' : ''}>
          <JoyConArt side="R" connected={R} lit={lit} />
          <figcaption>{R ? '右手柄连上了' : '右手柄'}</figcaption>
        </figure>
      </div>
      {both ? (
        <p className="guide-ok">都连上了。随便按几个键试试，手柄会跟着震。</p>
      ) : (
        <>
          <ol className="guide-steps">
            <li>把两只 Joy-Con 从 Switch 上滑下来</li>
            <li>按住手柄侧面导轨上的小圆键，直到指示灯来回跑</li>
            <li>在 Mac 的蓝牙设置里，点 Joy-Con 旁边的「连接」</li>
          </ol>
          <button className="btn" onClick={() => la.perm.openSettings('bluetooth')}>
            打开蓝牙设置
          </button>
        </>
      )}
      <Foot
        {...a}
        extra={
          !both && (
            <button
              className="btn ghost"
              onClick={() => {
                guideStore.patch({ keyboard: true })
                goGuide(stepFrom('joycon', 1))
              }}
            >
              没有手柄，先用键盘
            </button>
          )
        }
      />
    </>
  )
}

/** 百炼常见的几种报错翻成一句话，其余原样截一段 */
function keyError(e: string): string {
  if (/incorrect api key|invalid.?api.?key|401|unauthori[sz]ed/i.test(e)) return 'Key 不对，看看是不是没复制全'
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|network/i.test(e)) return '连不上百炼，看看网络'
  if (/429|quota|arrearage|余额|欠费/i.test(e)) return '这个 Key 的额度用完了，或者账户欠费了'
  return `没连上：${e.slice(0, 80)}`
}

function KeyStep({ setActions }: StepProps): React.JSX.Element {
  const s = useStore(settingsStore).s
  const p = s?.providers.find((x) => x.id === s.chatModel.providerId)
  const [key, setKey] = useState(p?.apiKey || '')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const k = key.trim()
    if (!k || !p || busy) return
    setBusy(true)
    setMsg(null)
    await updateSettings((x) => ({ ...x, providers: x.providers.map((q) => (q.id === p.id ? { ...q, apiKey: k } : q)) }))
    const cur = settingsStore.get().s!
    const r = await la.settings.testProvider({ ...p, apiKey: k }, cur.chatModel.model)
    setBusy(false)
    if (r.ok) {
      setMsg({ ok: true, text: '能用了' })
      haptic('done')
      setTimeout(() => goGuide('calibrate'), 700)
    } else setMsg({ ok: false, text: keyError(r.error || '') })
  }

  const a: Actions = {
    primary: { label: busy ? '在试…' : '保存（A）', run: save, disabled: !key.trim() || busy },
    back: () => goGuide('joycon')
  }
  setActions(a)

  return (
    <>
      <h2>填上千问的 Key</h2>
      <p>回答用的是阿里云百炼的千问，要一个 API Key，只存在这台电脑上。</p>
      <div className="guide-key">
        <input
          type="password"
          value={key}
          autoFocus
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
          }}
        />
        {p?.console && (
          <a className="btn ghost" href={p.console} target="_blank" rel="noreferrer">
            去百炼拿 Key ↗
          </a>
        )}
      </div>
      {msg && <p className={msg.ok ? 'guide-ok' : 'err'}>{msg.text}</p>}
      <Foot
        {...a}
        extra={
          <button className="btn ghost" onClick={() => goGuide('calibrate')}>
            {msg && !msg.ok ? '先跳过' : '以后再填'}
          </button>
        }
      />
    </>
  )
}

function CalibrateStep({ setActions, keyboard }: StepProps & { keyboard: boolean }): React.JSX.Element {
  const st = useStore(gaze.status)
  const j = useStore(input.status)
  const game = !keyboard && (j.L.connected || j.P.connected) && (j.R.connected || j.P.connected)
  const start = () => {
    calibFromGuide = true
    uiStore.patch({ showCalibration: true })
  }
  const a: Actions = st.calibrated
    ? { primary: { label: '下一步（A）', run: () => goGuide('practice') }, back: () => goGuide(stepFrom('calibrate', -1)) }
    : { primary: { label: '开始校准（A）', run: start }, back: () => goGuide(stepFrom('calibrate', -1)) }
  setActions(a)
  return (
    <>
      <h2>校准眼睛</h2>
      <p>目标会一个个冒出来，看着它就行，大约半分钟。头别动，只动眼睛。</p>
      {game && (
        <div className="guide-game">
          <span className="guide-game-art">
            <Diamond side="L" lit="up" />
            <Diamond side="R" lit="right" />
          </span>
          <span>
            <b>手柄小游戏</b>
            <br />
            哪个键亮了，就按手柄上的哪个键。
          </span>
        </div>
      )}
      {st.calibrated && <p className="guide-ok">已经校准过了，可以直接下一步。</p>}
      <Foot
        {...a}
        extra={
          st.calibrated ? (
            <button className="btn ghost" onClick={start}>
              重新校准
            </button>
          ) : (
            <button className="btn ghost" onClick={() => goGuide('practice')}>
              先跳过
            </button>
          )
        }
      />
    </>
  )
}

function DoneStep({ setActions }: StepProps): React.JSX.Element {
  const av = useStore(avatarStore)
  const a: Actions = { primary: { label: '开始用（A）', run: () => closeGuide() } }
  setActions(a)
  return (
    <>
      <div className="guide-hero">
        <div className="guide-check">✓</div>
        <h1>好了</h1>
        <p>按键忘了，点右上角的「？」。</p>
      </div>
      {!av.img && !av.busy && (
        <div className="guide-extra">
          <Icon name="person" />
          <span>拍张大头照，角落里的小人就换成你的样子。</span>
          <button
            className="btn sm"
            onClick={() => {
              closeGuide()
              uiStore.patch({ showBooth: true })
            }}
          >
            拍一张
          </button>
        </div>
      )}
      <Foot {...a} />
    </>
  )
}

// ---------- 试一试：左下角的小卡片，按键照常生效 ----------

type Item = { id: string; keys: React.ReactNode; text: string }

/** 「选中一个词」「换成一整句」 */
const ONE: Record<Granularity, string> = { word: '一个词', sentence: '一整句', paragraph: '一整段', section: '一整节' }

function Coach({ keyboard }: { keyboard: boolean }): React.JSX.Element {
  const f = useStore(focus.state)
  const chat = useStore(chatStore)
  const st = useStore(gaze.status)
  const base = useRef(chat.msgs.length)
  // 进来时是哪一档：按 R（或点顶栏那颗药丸）换过一档就算学会了
  const unit0 = useRef(f.unit).current
  const unitNext = GRAN_ORDER[(GRAN_ORDER.indexOf(unit0) + 1) % GRAN_ORDER.length]
  const [heard, setHeard] = useState(false)
  /** 做到过（或跳过）的步骤：勾上就不再取消，焦点后来放开了也算做过 */
  const [got, setGot] = useState<Set<string>>(new Set())
  const mark = (ids: string[]) =>
    setGot((s) => {
      if (ids.every((id) => s.has(id))) return s
      const n = new Set(s)
      ids.forEach((id) => n.add(id))
      return n
    })

  // 进来先把左边切到示范文档的「试一试」，视线跟左边
  useEffect(() => {
    switchSide('left')
    activate('welcome')
    setTimeout(() => {
      const h = [...document.querySelectorAll<HTMLElement>('.md-doc h2')].find((x) => x.textContent?.trim() === '试一试')
      h?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 120)
  }, [])

  useEffect(() => {
    if (chat.asr.active) setHeard(true)
  }, [chat.asr.active])

  const fresh = chat.msgs.slice(base.current).filter((m) => m.role === 'user')
  const onLeft = !!f.paneId?.startsWith('doc:')
  const now: Record<string, boolean> = {
    look: (f.mode !== 'none' && onLeft) || fresh.length > 0,
    pick: f.mode === 'hard' || fresh.length > 0,
    unit: f.unit !== unit0,
    explain: fresh.some((m) => m.action !== 'ask'),
    voice: heard && fresh.some((m) => m.action === 'ask')
  }
  const reached = Object.keys(now).filter((k) => now[k])
  useEffect(() => {
    if (reached.length) mark(reached)
  }, [reached.join()])
  const items: Item[] = [
    { id: 'look', keys: <Icon name="eye" />, text: st.calibrated ? '看着左边这段文字' : '把鼠标停在左边一段文字上' },
    {
      id: 'pick',
      keys: keyboard ? (
        <>
          <Kbd>⌥</Kbd>
          <Kbd>→</Kbd>
        </>
      ) : (
        <KeyCap k="RS" />
      ),
      text: keyboard ? `按 ⌥ 加方向键，选中${ONE[unit0]}` : `推一下右摇杆，选中${ONE[unit0]}`
    },
    {
      id: 'unit',
      keys: keyboard ? <span className="coach-unit">{GRAN_LABEL[unit0]}</span> : <KeyCap k="R" />,
      text: keyboard ? `点顶栏的「${GRAN_LABEL[unit0]}」，换成${ONE[unitNext]}` : `按 R，换成${ONE[unitNext]}`
    },
    {
      id: 'explain',
      keys: keyboard ? (
        <>
          <Kbd>⌥</Kbd>
          <Kbd>↩</Kbd>
        </>
      ) : (
        <KeyCap k="A" lit />
      ),
      text: keyboard ? '按 ⌥ 回车，让它解释' : '按 A，让它解释'
    },
    {
      id: 'voice',
      keys: keyboard ? (
        <>
          <Kbd>⌥</Kbd>
          <Kbd>空格</Kbd>
        </>
      ) : (
        <KeyCap k="ZR" />
      ),
      text: keyboard ? '按住 ⌥ 空格说一句话，松开发送' : '按住 ZR 说一句话，松开发送'
    }
  ]
  const ok = (id: string) => got.has(id) || now[id]
  const cur = items.find((it) => !ok(it.id))
  const n = items.filter((it) => ok(it.id)).length

  // 全做完了：停一下让人看到最后一个勾，再收尾
  useEffect(() => {
    if (cur) return
    const t = setTimeout(() => goGuide('done'), 1400)
    return () => clearTimeout(t)
  }, [!cur])

  return (
    <div className="coach">
      <div className="coach-head">
        <b>试一试</b>
        <span className="coach-n">
          {n} / {items.length}
        </span>
      </div>
      <ul className="coach-list">
        {items.map((it) => (
          <li key={it.id} className={ok(it.id) ? 'done' : it === cur ? 'on' : ''}>
            <span className="coach-mark">{ok(it.id) ? '✓' : ''}</span>
            <span className="coach-keys">{it.keys}</span>
            <span className="coach-text">{it.text}</span>
          </li>
        ))}
      </ul>
      <div className="coach-foot">
        {cur && (
          <button className="btn sm ghost" onClick={() => mark([cur.id])}>
            跳过这步
          </button>
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => goGuide('done')}>
          结束
        </button>
      </div>
    </div>
  )
}
