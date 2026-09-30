import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { gaze } from '../gaze/engine'
import { uiStore, settingsStore, toast, rumble } from '../appState'
import { input } from '../input/joycon'
import { avatarStore, takeHeadshot, generateAvatar } from '../avatar/avatar'
import { Icon } from './Icon'

// 拍大头照 → 生成实时小人：摄像头预览（镜像）+ 倒数 3 秒拍照 + 确认后交给图生图
// 新手引导最后一步可以顺手拍；快门是左摇杆按下（整个 App 只有这里用它），拍下那一刻手柄重震一下
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
  // 输入源是原深感时摄像头是借来的，状态不在 gaze.status 里，按画面有没有出来判断
  const borrowed = st.source === 'truedepth'
  const [camUp, setCamUp] = useState(false)
  useEffect(() => {
    if (!borrowed) return
    const id = setInterval(() => setCamUp(gaze.webcamReady()), 300)
    return () => clearInterval(id)
  }, [borrowed])
  const camReady = borrowed ? camUp : st.state === 'running'
  const camNote = borrowed ? '正在打开 Mac 摄像头…' : st.state === 'loading' ? '摄像头启动中…' : st.error || '摄像头没开'

  const close = () => uiStore.patch({ showBooth: false })
  const provider = s?.providers.find((p) => p.id === s.avatar.providerId)
  const noKey = !provider?.apiKey
  const fillKey = () => uiStore.patch({ showSettings: true, settingsTab: 'providers' })

  useEffect(() => {
    // 输入源是 iPhone 原深感时，临时借用摄像头拍照，关窗口就还回去
    if (gaze.source === 'truedepth') {
      gaze.borrowWebcam(s?.gaze.cameraId || undefined)
      return () => gaze.releaseWebcam()
    }
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
      toast('没看到脸，正对着摄像头，光从前面来', 'warn')
      return
    }
    setStep('count')
    let n = 3
    setCount(n)
    rumble('tick', 'L')
    const id = setInterval(() => {
      n--
      if (n > 0) {
        setCount(n)
        rumble('tick', 'L')
        return
      }
      clearInterval(id)
      const p = takeHeadshot()
      if (!p) {
        toast('那一下没拍到脸，再来一次', 'warn')
        setStep('live')
        return
      }
      rumble('strong')
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

  // 手柄：左摇杆按下 = 快门，A 确认，B 退一步（键盘用 ⌥↩ / Esc）；设置叠在上面填 Key 时不抢按键
  useEffect(() => {
    return input.onButton((e) => {
      if (e.down && e.btn === 'LS' && !uiStore.get().showSettings) shoot()
    })
  })
  useEffect(() => {
    return input.onAction((a) => {
      if (uiStore.get().showSettings) return
      if (a === 'confirm') {
        if (made) close()
        else if (step === 'live') shoot()
        else if (step === 'shot' && !av.busy && noKey) fillKey()
        else if (step === 'shot' && !av.busy) make()
      } else if (a === 'cancel') {
        if (av.busy || step === 'live') close()
        else retake()
      }
    })
  })

  const genSec = av.busy ? Math.round((Date.now() - av.since) / 1000) : 0

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal booth" onClick={(e) => e.stopPropagation()}>
        <h2>
          <Icon name="person" />
          拍张大头照，生成你的小人
        </h2>
        <p className="dim small">照片只发给阿里云百炼，不存本地。</p>

        <div className="booth-stage">
          {step !== 'shot' ? (
            <div className="booth-live">
              <canvas ref={canvasRef} style={{ width: PREVIEW_W, height: PREVIEW_H }} />
              <div className={`booth-oval ${faceOk ? 'ok' : ''}`} />
              {step === 'count' && <div className="booth-count">{count}</div>}
              {!camReady && <div className="booth-note">{camNote}</div>}
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
                {made && av.img ? <img src={av.img} alt="小人" /> : <div className="booth-wait">{av.busy ? `${genSec} 秒` : '？'}</div>}
                <figcaption>{made ? '你的小人' : av.busy ? '正在画…' : '小人'}</figcaption>
              </figure>
            </div>
          )}
          {flash && <div className="booth-flash" />}
        </div>

        {av.error && step === 'shot' && !av.busy && !made && !noKey && <p className="err small">没画出来：{av.error}</p>}
        {step === 'shot' && !av.busy && !made && noKey && <p className="err small">还没填千问的 Key，填好才能画。照片先留着</p>}

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
                {noKey ? (
                  <button className="btn primary" onClick={fillKey}>
                    去填 Key（A）
                  </button>
                ) : (
                  <button className="btn primary" onClick={make}>
                    {av.error ? '再试一次（A）' : '生成小人（A）'}
                  </button>
                )}
                <button className="btn" onClick={retake}>
                  重拍（B）
                </button>
              </>
            )
          ) : (
            <>
              <button className="btn primary" onClick={shoot} disabled={step !== 'live' || !camReady || av.busy}>
                {av.busy ? '上一个小人还在画…' : '拍照（按左摇杆）'}
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
