import { FaceDetector, extractCombinedFeatures, type FaceLandmarkerResult } from '@realeye-io/webcam-eyetracker-light-open'
import { poseOf, rotationOf, type FaceExpr, type HeadPos } from '../pose'
import type { GazeFrame, SourceHooks } from '../types'

// 输入源一：Mac 摄像头（或连续互通相机）。摄像头 → MediaPipe 人脸 478 点 → RealEye 特征（关键点 + 表情系数 + 双眼小图）
// 选了原深感时，拍大头照还会临时借用它（只要画面和人脸框，不算视线）

const PROC_W = 1280
const PROC_H = 720

export class WebcamSource {
  readonly video: HTMLVideoElement = document.createElement('video')
  /** 最近一次看到脸时的人脸框（0~1，未镜像）和时间（performance.now），拍大头照时按它裁 */
  lastFaceBox: GazeFrame['faceBox'] = null
  lastFaceBoxAt = 0
  running = false

  private stream: MediaStream | null = null
  private detector: FaceDetector | null = null
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private tiny = document.createElement('canvas')
  private tinyCtx = this.tiny.getContext('2d', { willReadFrequently: true })!
  private frameCount = 0
  private fpsT0 = performance.now()
  private wantedCamera: string | undefined
  private loading = false
  private dark = false
  private loopGen = 0
  private lastProcessAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(private hooks: SourceHooks) {
    // 摄像头插拔 / iPhone 连续互通相机连上断开时自动重试
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      this.listCameras().catch(() => undefined)
      if (this.wantRunning && (!this.running || !this.stream?.active)) {
        setTimeout(() => this.wantRunning && this.start(this.wantedCamera), 800)
      }
    })
    this.video.muted = true
    this.video.playsInline = true
    this.canvas.width = PROC_W
    this.canvas.height = PROC_H
  }

  /** 该不该开着（出错后自动重试用） */
  private wantRunning = false

  async listCameras(): Promise<Array<{ id: string; label: string }>> {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const cams = devs.filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: d.label || '摄像头' }))
    this.hooks.status({ cameras: cams })
    return cams
  }

  async start(cameraId?: string): Promise<void> {
    if (this.loading) return
    this.wantedCamera = cameraId
    this.stop()
    this.wantRunning = true
    this.loading = true
    this.hooks.status({ state: 'loading', error: undefined })
    try {
      if (!this.detector) {
        const base = new URL('./mediapipe/', window.location.href).href
        this.detector = new FaceDetector({
          modelPath: base + 'face_landmarker.task',
          wasmPath: base.replace(/\/$/, ''),
          mode: 'landmarker',
          delegate: 'GPU',
          runningMode: 'VIDEO'
        })
        await this.detector.initialize()
      }
      const video: MediaTrackConstraints = { width: { ideal: PROC_W }, height: { ideal: PROC_H }, frameRate: { ideal: 30 } }
      if (cameraId) {
        // 指定的摄像头不在了（iPhone 走开了）就退回默认摄像头
        const cams = await this.listCameras().catch(() => [])
        if (cams.some((c) => c.id === cameraId)) video.deviceId = { exact: cameraId }
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
      this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.hooks.status({ state: 'error', error: '摄像头断开了', face: false })
        setTimeout(() => this.wantRunning && this.start(this.wantedCamera), 1500)
      })
      const track = this.stream.getVideoTracks()[0]
      this.video.srcObject = this.stream
      await this.video.play()
      const cams = await this.listCameras()
      this.hooks.status({
        state: 'running',
        cameraLabel: track?.label || cams.find((c) => c.id === cameraId)?.label || '摄像头'
      })
      this.running = true
      this.loop()
    } catch (e: any) {
      console.error('[gaze] 启动失败', e)
      const notFound = e?.name === 'NotFoundError' || /not found/i.test(e?.message || '')
      this.hooks.status({
        state: 'error',
        error: notFound ? '没有可用的摄像头（MacBook 合盖时内置摄像头不可用，可以用 iPhone 连续互通相机）' : e?.message || String(e)
      })
      this.listCameras().catch(() => undefined)
    } finally {
      this.loading = false
    }
  }

  stop(): void {
    this.wantRunning = false
    this.running = false
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    this.hooks.status({ state: 'off', face: false, fps: 0 })
  }

  private loop(): void {
    if (!this.running) return
    const gen = ++this.loopGen
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    const next = () => {
      if (!this.running || gen !== this.loopGen) return
      this.lastProcessAt = performance.now()
      try {
        this.process()
      } catch (e) {
        console.warn('[gaze] 处理帧出错', e)
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next)
      else setTimeout(next, 33)
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next)
    else setTimeout(next, 33)
    // 看门狗：video 被挪出 DOM 会自动暂停、帧回调就断了，1.5 秒没出帧就重新播放并重挂循环
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (!this.running) return
        if (performance.now() - this.lastProcessAt > 1500) {
          this.video.play().catch(() => undefined)
          this.loop()
        }
      }, 1000)
    }
  }

  private process(): void {
    if (!this.detector || this.video.readyState < 2) return
    const t = performance.now()
    const vw = this.video.videoWidth || PROC_W
    const vh = this.video.videoHeight || PROC_H
    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw
      this.canvas.height = vh
    }
    this.ctx.drawImage(this.video, 0, 0, vw, vh)
    const det = this.detector.detectWithLandmarks(this.canvas) as FaceLandmarkerResult | null

    this.frameCount++
    // 每 20 帧看一眼画面亮度，全黑就提示用户（镜头被挡、iPhone 扣着、盖子合上）
    if (this.frameCount % 20 === 1) {
      this.tiny.width = 32
      this.tiny.height = 18
      this.tinyCtx.drawImage(this.canvas, 0, 0, 32, 18)
      const px = this.tinyCtx.getImageData(0, 0, 32, 18).data
      let sum = 0
      for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11
      const dark = sum / (px.length / 4) < 10
      if (dark !== this.dark) {
        this.dark = dark
        this.hooks.status({ dark })
      }
    }
    if (t - this.fpsT0 > 1000) {
      this.hooks.status({ fps: Math.round((this.frameCount * 1000) / (t - this.fpsT0)) })
      this.frameCount = 0
      this.fpsT0 = t
    }

    let features: Float64Array | null = null
    let blink = 0
    let headZ: number | null = null
    let faceBox: GazeFrame['faceBox'] = null
    let pose: HeadPos | null = null
    let expr: FaceExpr | null = null
    if (det && det.allLandmarks?.length >= 478) {
      const img = this.ctx.getImageData(0, 0, vw, vh)
      const f = extractCombinedFeatures(
        img,
        det.boundingBox,
        det.keypoints,
        true,
        det.allLandmarks,
        vw,
        vh,
        40,
        20,
        det.blendshapes,
        det.headPose
      )
      features = Float64Array.from(f)
      blink = Math.max(det.blendshapes?.eyeBlinkLeft ?? 0, det.blendshapes?.eyeBlinkRight ?? 0)
      headZ = det.headPose ? Math.abs(det.headPose.translationZ) : null
      faceBox = { x: det.boundingBox.x / vw, y: det.boundingBox.y / vh, w: det.boundingBox.width / vw, h: det.boundingBox.height / vh }
      this.lastFaceBox = faceBox
      this.lastFaceBoxAt = t
      pose = { ...poseOf(faceBox), ...(rotationOf(det.allLandmarks, vw, vh) || {}) }
      expr = this.exprOf(det)
    }
    this.hooks.frame({ t, features, face: !!features, blink, headZ, faceBox, pose, expr })
  }

  /**
   * 眨眼（表情系数）、张嘴（上下唇内缘距离 / 脸高）、眼珠方向（虹膜在眼眶里的位置，换成镜子方向）
   * 眼珠用几何算不用表情系数：表情系数的左右在不同版本里对不上，几何不会错
   */
  private exprOf(det: FaceLandmarkerResult): FaceExpr {
    const b = det.blendshapes
    const lm = det.allLandmarks
    const faceH = Math.abs((lm[152]?.y ?? 1) - (lm[10]?.y ?? 0)) || 1
    const gap = Math.max(0, (lm[14]?.y ?? 0) - (lm[13]?.y ?? 0))
    // 虹膜中心在两个眼角之间的位置（画面坐标，0.5 = 正中）；468 配右眼 33/133，473 配左眼 263/362
    const across = (a?: { x: number }, c?: { x: number }, iris?: { x: number }) => {
      if (!a || !c || !iris) return 0.5
      const x0 = Math.min(a.x, c.x)
      const x1 = Math.max(a.x, c.x)
      return x1 - x0 > 1e-4 ? (iris.x - x0) / (x1 - x0) : 0.5
    }
    const updown = (top?: { y: number }, bot?: { y: number }, iris?: { y: number }) => {
      if (!top || !bot || !iris) return 0.5
      const h = bot.y - top.y
      return Math.abs(h) > 1e-4 ? (iris.y - top.y) / h : 0.5
    }
    const u = (across(lm[33], lm[133], lm[468]) + across(lm[263], lm[362], lm[473])) / 2
    const v = (updown(lm[159], lm[145], lm[468]) + updown(lm[386], lm[374], lm[473])) / 2
    const clamp1 = (x: number) => Math.max(-1, Math.min(1, x))
    return {
      blink: b ? Math.max(b.eyeBlinkLeft, b.eyeBlinkRight) : 0,
      mouth: Math.min(1, gap / faceH / 0.18),
      // 虹膜在画面里偏右 = 人往自己左边看 = 镜子里往左
      lookX: clamp1((0.5 - u) * 5),
      lookY: clamp1((v - 0.5) * 4)
    }
  }
}
