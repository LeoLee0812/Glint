import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { gaze, type FaceExpr, type HeadPos } from '../gaze/engine'
import { adviseHead, headAdviceStore, type HeadAdvice } from '../gaze/headGuide'
import { uiStore, rumble, settingsStore, updateSettings, toast } from '../appState'
import { avatarStore } from '../avatar/avatar'
import { Icon } from './Icon'

// 实时小人：一直待在屏幕角落的「小镜子」。你的卡通形象跟着你的头实时动（挪位置、远近、歪头、转头、点头、眨眼），
// 虚线圈是校准时头的位置；一偏就告诉你往哪挪，偏了超过 1.2 秒震一下手柄、给出「就在这儿重新校准」。
// 形象是拍大头照后图生图画的，还没拍就先用内置的默认小人；默认待在右边回答区的右上角（不挡左边正在读的内容），可以拖到任何地方

const LOUD_AFTER = 1200
const GOOD_AFTER = 600
const LOST_AFTER = 2500
const STAGE_W = 176
const STAGE_H = 112
/** 舞台横向显示摄像头画面的多宽（比例）：越小，挪一点动得越明显 */
const VIEW = 0.9
/** 卡通头像直径 ≈ 脸宽 × 这个倍数（带上头发和一点肩膀） */
const HEAD_K = 1.55

type Phase = 'nocam' | 'nocal' | 'lost' | 'off' | 'good'

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

/** 还没生成卡通形象时的默认小人：眨眼、张嘴、眼珠方向都跟着你 */
function DefaultBuddy({ expr }: { expr: FaceExpr | null }): React.JSX.Element {
  const blink = expr ? clamp((expr.blink - 0.25) / 0.45, 0, 1) : 0
  const lx = (expr?.lookX ?? 0) * 3.2
  const ly = (expr?.lookY ?? 0) * 2.4
  const ry = 5.4 * (1 - blink) + 0.7
  const mouth = expr?.mouth ?? 0
  return (
    <svg className="buddy-default" viewBox="0 0 100 100" aria-hidden>
      <circle cx="50" cy="50" r="49" fill="#dcecff" />
      <ellipse cx="50" cy="57" rx="32" ry="33" fill="#ffe0c4" />
      <path d="M18 54C14 25 36 13 52 14c18 0 34 11 30 40-4-13-15-21-31-21-15 0-28 8-33 21Z" fill="#3a3a3c" />
      <ellipse cx={38 + lx} cy={58 + ly} rx="4.3" ry={ry} fill="#1d1d1f" />
      <ellipse cx={62 + lx} cy={58 + ly} rx="4.3" ry={ry} fill="#1d1d1f" />
      <circle cx="29" cy="69" r="5" fill="#ff9f9f" opacity="0.55" />
      <circle cx="71" cy="69" r="5" fill="#ff9f9f" opacity="0.55" />
      {mouth > 0.12 ? (
        <ellipse cx="50" cy="76" rx={3.6 + mouth * 3} ry={1.6 + mouth * 6} fill="#b4441c" />
      ) : (
        <path d="M43 74q7 6 14 0" stroke="#b4441c" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      )}
    </svg>
  )
}

export function HeadGuide(): React.JSX.Element | null {
  const { cur, ref, expr } = useStore(gaze.pose)
  const st = useStore(gaze.status)
  const ui = useStore(uiStore)
  const s = useStore(settingsStore).s
  const av = useStore(avatarStore)
  const [phase, setPhase] = useState<Phase>('nocam')
  const [advice, setAdvice] = useState<HeadAdvice | null>(null)
  const [loud, setLoud] = useState(false)
  const [menu, setMenu] = useState(false)
  const [, setTick] = useState(0)
  const offSince = useRef(0)
  const okSince = useRef(0)
  const lostSince = useRef(0)
  const snoozeUntil = useRef(0)
  /** 看不到脸时停在最后的位置 */
  const lastPose = useRef<HeadPos | null>(null)
  /** 点头的基准：校准时的，没有就慢慢跟着平时的姿势走 */
  const pitchBase = useRef<number | null>(null)

  const running = st.state === 'running'
  const calibrated = st.calibrated && !!ref

  useEffect(() => {
    if (!running) {
      setPhase('nocam')
      setLoud(false)
      offSince.current = okSince.current = lostSince.current = 0
      headAdviceStore.set({ advice: null, lost: false })
      return
    }
    const t = performance.now()
    if (!cur) {
      offSince.current = okSince.current = 0
      if (!lostSince.current) lostSince.current = t
      const lost = t - lostSince.current > LOST_AFTER
      headAdviceStore.set({ advice: null, lost: lost && calibrated })
      if (lost) setPhase('lost')
      setLoud(false)
      return
    }
    lostSince.current = 0
    lastPose.current = cur
    if (cur.pitch != null) pitchBase.current = pitchBase.current == null ? cur.pitch : pitchBase.current + (cur.pitch - pitchBase.current) * 0.02
    if (!calibrated) {
      setPhase('nocal')
      setLoud(false)
      headAdviceStore.set({ advice: null, lost: false })
      return
    }
    // 迟滞：偏过阈值才算偏，回到 70% 以内才算回正
    const strict = adviseHead(cur, ref!, 1)
    const loose = adviseHead(cur, ref!, 0.7)
    headAdviceStore.set({ advice: strict.main ? strict : null, lost: false })
    if (strict.main) {
      okSince.current = 0
      if (!offSince.current) offSince.current = t
      setAdvice(strict)
      setPhase('off')
      if (t - offSince.current > LOUD_AFTER && t > snoozeUntil.current) {
        setLoud((was) => {
          if (!was) rumble('soft', 'L')
          return true
        })
      }
    } else if (!loose.main) {
      offSince.current = 0
      if (!okSince.current) okSince.current = t
      if (phase !== 'off' || t - okSince.current > GOOD_AFTER) {
        setPhase('good')
        setLoud(false)
      }
    } else if (phase === 'off') {
      // 在回正的路上：文字跟着更新
      setAdvice(loose)
    }
  }, [cur, ref, running, calibrated])

  // 生成小人时每秒刷新一下已用时间
  useEffect(() => {
    if (!av.busy) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [av.busy])

  // ---------- 拖动：按离窗口右边、上边的距离记住，普通 / 全局模式分开 ----------
  const posKey = `lookask.buddy.rt.${ui.mode === 'global' ? 'global' : 'normal'}`
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null)
  const posRef = useRef(pos)
  posRef.current = pos
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(posKey) || 'null')
      setPos(v && Number.isFinite(v.right) && Number.isFinite(v.top) ? v : null)
    } catch {
      setPos(null)
    }
  }, [posKey])
  const drag = useRef<{ x: number; y: number; right: number; top: number } | null>(null)

  if (!s || s.avatar?.show === false || ui.showCalibration || ui.showBooth || ui.mode === 'calibration') return null

  // 默认在右边：对话标题栏下面、贴着右边（全局模式的侧边栏里也一样）
  const headBottom = document.querySelector('.right .chat-head')?.getBoundingClientRect().bottom ?? 102
  const at = pos ?? { right: 14, top: headBottom + 10 }
  const right = clamp(at.right, 4, Math.max(4, window.innerWidth - 60))
  const top = clamp(at.top, 4, Math.max(4, window.innerHeight - 60))

  // ---------- 舞台：摄像头画面的一部分，照镜子的方向 ----------
  const p = cur ?? lastPose.current
  const hasRefPos = calibrated && Number.isFinite(ref!.cx)
  const c0 = hasRefPos ? { cx: ref!.cx, cy: ref!.cy } : { cx: 0.5, cy: 0.45 }
  const v = gaze.video
  const aspect = v.videoWidth && v.videoHeight ? v.videoHeight / v.videoWidth : 9 / 16
  const kx = STAGE_W / VIEW
  const ky = kx * aspect
  const D = p ? clamp(p.w * kx * HEAD_K, 28, 120) : 64
  const hx = p ? clamp(STAGE_W / 2 + (p.cx - c0.cx) * kx, D * 0.2, STAGE_W - D * 0.2) : STAGE_W / 2
  const hy = p ? clamp(STAGE_H / 2 + (p.cy - c0.cy) * ky, D * 0.2, STAGE_H - D * 0.2) : STAGE_H / 2
  const refD = calibrated ? clamp(ref!.w * kx * HEAD_K, 28, 120) : 0
  const deg = 180 / Math.PI
  const roll = clamp((p?.roll ?? 0) * deg, -40, 40)
  // yaw ≈ 1.4 × tan(转角)：鼻尖比两颊边缘往前凸出约 0.7 个脸宽
  const yaw = clamp(Math.atan((p?.yaw ?? 0) / 1.4) * deg, -40, 40)
  const base = ref?.pitch ?? pitchBase.current
  const pitch = p?.pitch != null && base != null ? clamp(-(p.pitch - base) * 150, -25, 25) : 0
  const showArrow = phase === 'off' && Math.hypot(hx - STAGE_W / 2, hy - STAGE_H / 2) > 12

  const text: Record<Phase, [string, string]> = {
    nocam: ['摄像头没开', '点一下打开'],
    nocal: ['还没校准', '校准后我会记住你坐的位置'],
    lost: ['看不到你的脸', '回到摄像头正前方，脸完整露出来'],
    off: [advice?.main || '偏了', advice?.sub || '回到虚线圈里'],
    good: ['位置正好', '和校准时一致，视线会准']
  }
  const [main, sub] = text[phase]
  const genSec = av.busy ? Math.round((Date.now() - av.since) / 1000) : 0

  const snooze = () => {
    snoozeUntil.current = performance.now() + 2 * 60_000
    setLoud(false)
  }

  return (
    <div
      className={`buddy phase-${phase} ${loud ? 'loud' : ''}`}
      style={{ right, top }}
      role="status"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button, .buddy-menu')) return
        drag.current = { x: e.clientX, y: e.clientY, right, top }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const el = e.currentTarget
        setPos({
          right: clamp(d.right - (e.clientX - d.x), 4, window.innerWidth - el.offsetWidth - 4),
          top: clamp(d.top + (e.clientY - d.y), 4, window.innerHeight - el.offsetHeight - 4)
        })
      }}
      onPointerUp={() => {
        if (drag.current && posRef.current) localStorage.setItem(posKey, JSON.stringify(posRef.current))
        drag.current = null
      }}
      onClick={() => phase === 'nocam' && gaze.start(s.gaze.cameraId || undefined)}
    >
      <div className="buddy-stage" style={{ width: STAGE_W, height: STAGE_H }}>
        {calibrated && <div className="buddy-ref" style={{ width: refD, height: refD, left: STAGE_W / 2 - refD / 2, top: STAGE_H / 2 - refD / 2 }} />}
        {showArrow && (
          <svg className="buddy-arrow" width={STAGE_W} height={STAGE_H} aria-hidden>
            <defs>
              <marker id="buddy-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            <line x1={hx} y1={hy} x2={STAGE_W / 2} y2={STAGE_H / 2} markerEnd="url(#buddy-head)" />
          </svg>
        )}
        <div
          className="buddy-head"
          style={{
            width: D,
            height: D,
            left: hx - D / 2,
            top: hy - D / 2,
            transform: `perspective(240px) rotateY(${yaw.toFixed(1)}deg) rotateX(${pitch.toFixed(1)}deg) rotate(${roll.toFixed(1)}deg)`
          }}
        >
          {av.img ? <img src={av.img} alt="我的小人" draggable={false} /> : <DefaultBuddy expr={phase === 'lost' ? null : expr} />}
          {av.busy && <span className="buddy-spin" />}
        </div>
        <button className="buddy-more" title="小人菜单" onClick={() => setMenu((m) => !m)}>
          <Icon name="more" />
        </button>
        {menu && (
          <div className="buddy-menu" onMouseLeave={() => setMenu(false)}>
            <button
              onClick={() => {
                setMenu(false)
                uiStore.patch({ showBooth: true })
              }}
            >
              {av.img ? '重新拍照换个小人' : '拍张大头照生成小人'}
            </button>
            <button
              onClick={() => {
                setMenu(false)
                updateSettings((x) => ({ ...x, avatar: { ...x.avatar, show: false } }))
                toast('小人藏起来了：设置 → 眼动 → 实时小人 里可以再打开', 'info', { ttl: 5000 })
              }}
            >
              先藏起来
            </button>
          </div>
        )}
      </div>
      <div className="buddy-status">
        <div className="buddy-main">
          <i />
          {main}
        </div>
        <div className="buddy-sub">{av.busy ? `小人生成中… ${genSec}s（一般 40～60 秒）` : sub}</div>
        {loud && phase === 'off' && (
          <div className="buddy-actions">
            <button className="btn sm" onClick={() => uiStore.patch({ showCalibration: true, calibrationKind: 'full' })}>
              就在这儿重新校准
            </button>
            <button className="btn sm ghost" onClick={snooze}>
              稍后
            </button>
          </div>
        )}
        {!av.img && !av.busy && !(loud && phase === 'off') && (
          <button className="buddy-cta" onClick={() => uiStore.patch({ showBooth: true })}>
            <Icon name="camera" />
            拍照生成我的小人
          </button>
        )}
      </div>
    </div>
  )
}
