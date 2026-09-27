import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { gaze } from '../gaze/engine'
import { uiStore, settingsStore, toast } from '../appState'
import { input } from '../input/joycon'
import { avatarStore, takeHeadshot, generateAvatar } from '../avatar/avatar'
import { Icon } from './Icon'

// 拍大头照 → 生成实时小人：摄像头预览（镜像）+ 倒数 3 秒拍照 + 确认后交给图生图
// 画的时候可以先关掉窗口，画好了角落里的小人会自己换上

const PREVIEW_W = 480
const PREVIEW_H = 360

type Step = 'live' | 'count' | 'shot'

export function PhotoBooth(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  if (!ui.showBooth) return null
  return <BoothInner />
}

function BoothInner(): React.JSX.Element {
  const st = useStore(gaze.status)
  const av = useStore(avatarStore)
  const s = useStore(settingsStore).s
  const [step, setStep] = useState<Step>('live')
  const [count, setCount] = useState(3)
  const [photo, setPhoto] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  /** 这次打开窗口后亲手生成的（生成完在窗口里展示结果） */
  const [made, setMade] = useState(false)
  const [, setTick] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [faceOk, setFaceOk] = useState(false)

  const close = () => uiStore.patch({ showBooth: false })

  useEffect(() => {
    if (gaze.status.get().state !== 'running') gaze.start(s?.gaze.cameraId || undefined)
  }, [])

  // 实时预览：从眼动引擎的摄像头画面直接画（不挪动 video 元素，免得眼动循环被暂停）
  useEffect(() => {
    if (step === 'shot') return
    let raf = 0
    const draw = () => {
      const cv = canvasRef.current
      const v = gaze.video
      if (cv && v.readyState >= 2 && v.videoWidth) {
        const dpr = window.devicePixelRatio || 1
        if (cv.width !== PREVIEW_W * dpr) {
          cv.width = PREVIEW_W * dpr
          cv.height = PREVIEW_H * dpr
        }
        const g = cv.getContext('2d')!
        // 铺满（裁掉多余的边），镜像
        const k = Math.max(cv.width / v.videoWidth, cv.height / v.videoHeight)
        const w = v.videoWidth * k
        const h = v.videoHeight * k
        g.setTransform(-1, 0, 0, 1, cv.width, 0)
        g.drawImage(v, (cv.width - w) / 2, (cv.height - h) / 2, w, h)
        g.setTransform(1, 0, 0, 1, 0, 0)
        const b = gaze.lastFaceBox
        const ok = !!b && performance.now() - gaze.lastFaceBoxAt < 700 && b.w > 0.12 && Math.abs(b.x + b.w / 2 - 0.5) < 0.22
        setFaceOk((prev) => (prev === ok ? prev : ok))
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [step])

  // 生成时每秒刷新已用时间
  useEffect(() => {
    if (!av.busy) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [av.busy])

  const shoot = () => {
    if (step !== 'live' || av.busy) return
    if (performance.now() - gaze.lastFaceBoxAt > 1000) {
      toast('没看到脸：正对摄像头，光线从前面来', 'warn')
      return
    }
    setStep('count')
    let n = 3
    setCount(n)
    const id = setInterval(() => {
      n--
      if (n > 0) {
        setCount(n)
        return
      }
      clearInterval(id)
      const p = takeHeadshot()
      if (!p) {
        toast('那一下没拍到脸，再来一次', 'warn')
        setStep('live')
        return
      }
      setFlash(true)
      setTimeout(() => setFlash(false), 260)
      setPhoto(p)
      setStep('shot')
    }, 700)
  }

  const make = async () => {
    if (!photo || av.busy) return
    setMade(false)
    const ok = await generateAvatar(photo)
    if (ok) setMade(true)
  }

  const retake = () => {
    setPhoto(null)
    setMade(false)
    setStep('live')
  }

  // 手柄 / 键盘：A 确认，B 退一步
  useEffect(() => {
    return input.onAction((a) => {
      if (a === 'confirm') {
        if (made) close()
        else if (step === 'live') shoot()
        else if (step === 'shot' && !av.busy) make()
      } else if (a === 'cancel') {
        if (av.busy || step === 'live') close()
        else retake()
      }
    })
  })

  const genSec = av.busy ? Math.round((Date.now() - av.since) / 1000) : 0
  const provider = s?.providers.find((p) => p.id === s.avatar.providerId)

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal booth" onClick={(e) => e.stopPropagation()}>
        <h2>
          <Icon name="person" />
          拍张大头照，生成你的实时小人
        </h2>
        <p className="dim small">
          小人会一直待在屏幕角落，跟着你的头实时动；坐偏了、离远了它会告诉你往哪挪。照片只发给图生图服务
          （{provider?.name || s?.avatar.providerId} · {s?.avatar.model}），不存本地。
        </p>

        <div className="booth-stage">
          {step !== 'shot' ? (
            <div className="booth-live">
              <canvas ref={canvasRef} style={{ width: PREVIEW_W, height: PREVIEW_H }} />
              <div className={`booth-oval ${faceOk ? 'ok' : ''}`} />
              {step === 'count' && <div className="booth-count">{count}</div>}
              {st.state !== 'running' && <div className="booth-note">{st.state === 'loading' ? '摄像头启动中…' : st.error || '摄像头没开'}</div>}
            </div>
          ) : (
            <div className="booth-result">
              <figure>
                <img src={photo!} alt="大头照" />
                <figcaption>大头照</figcaption>
              </figure>
              <div className={`booth-arrow ${av.busy ? 'busy' : ''}`}>
                <Icon name="sparkles" />
              </div>
              <figure className={`booth-avatar ${av.busy ? 'busy' : ''}`}>
                {made && av.img ? <img src={av.img} alt="小人" /> : <div className="booth-wait">{av.busy ? `${genSec}s` : '？'}</div>}
                <figcaption>{made ? '你的小人' : av.busy ? '正在画…（一般 40～60 秒）' : '小人'}</figcaption>
              </figure>
            </div>
          )}
          {flash && <div className="booth-flash" />}
        </div>

        {av.error && step === 'shot' && !av.busy && !made && <p className="err small">没画出来：{av.error}</p>}

        <div className="booth-actions">
          {made ? (
            <>
              <button className="btn primary" onClick={close}>
                就用它（A）
              </button>
              <button className="btn" onClick={retake}>
                重拍一张（B）
              </button>
            </>
          ) : step === 'shot' ? (
            av.busy ? (
              <button className="btn" onClick={close}>
                先关掉，画好了自动换上（B）
              </button>
            ) : (
              <>
                <button className="btn primary" onClick={make}>
                  {av.error ? '再试一次（A）' : '生成小人（A）'}
                </button>
                <button className="btn" onClick={retake}>
                  重拍（B）
                </button>
              </>
            )
          ) : (
            <>
              <button className="btn primary" onClick={shoot} disabled={step !== 'live' || st.state !== 'running' || av.busy}>
                {av.busy ? '上一个小人还在画…' : '拍照（A）· 倒数 3 秒'}
              </button>
              <button className="btn" onClick={close}>
                取消（B）
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
