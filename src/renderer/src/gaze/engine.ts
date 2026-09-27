import { FaceDetector, extractCombinedFeatures, type FaceLandmarkerResult } from '@realeye-io/webcam-eyetracker-light-open'
import { createStore, Emitter } from '../store'
import { boundsStore } from '../appState'
import { OneEuro2D, FixationDetector, type Fixation } from './filters'
import { predictRidge, type RidgeModel, type FitInput } from './ridge'

// 眼动引擎：摄像头 → MediaPipe 人脸 478 点 → RealEye 特征（关键点 + 表情系数 + 双眼小图）
// → 岭回归映射到屏幕坐标 → 漂移校正 → One Euro 平滑 → 注视检测
// 输出统一用「屏幕坐标（点）」，谁用谁自己换算到窗口坐标。以后换 iPhone 原深感也只换这一层。

const MODEL_KEY = 'lookask.gazeModel.v1'
const PROC_W = 1280
const PROC_H = 720

export interface GazeFrame {
  t: number
  features: Float64Array | null
  face: boolean
  blink: number
  headZ: number | null
  faceBox: { x: number; y: number; w: number; h: number } | null
  /** 这一帧的头位置和转角（未平滑） */
  pose: HeadPos | null
}

export interface GazeSample {
  t: number
  raw: { x: number; y: number } | null
  smooth: { x: number; y: number } | null
  face: boolean
  blink: boolean
}

export interface GazeStatus {
  state: 'off' | 'loading' | 'running' | 'error'
  error?: string
  face: boolean
  fps: number
  calibrated: boolean
  cvErrorPx: number | null
  cameraLabel: string
  cameras: Array<{ id: string; label: string }>
  /** 脸宽占画面宽度的比例，用来看人离屏幕的远近有没有变 */
  faceScale: number | null
  calibFaceScale: number | null
  driftPx: number
  /** 画面几乎全黑（镜头被挡 / iPhone 扣在桌上） */
  dark: boolean
}

/** 头在摄像头画面里的位置（已镜像成「照镜子」的方向，0~1）；w = 脸宽占画面宽度，越大越近 */
export interface HeadPos {
  cx: number
  cy: number
  w: number
  /** 歪头（弧度，镜子里顺时针为正） */
  roll?: number
  /** 左右转头（≈ 1.4 × tan(转角)，转向镜子里的右边为正） */
  yaw?: number
  /** 抬头低头：鼻尖在「两眼连线 → 下巴」之间的位置，越大越低头 */
  pitch?: number
}

/** 脸上的小动作（给实时小人用）：眨眼、张嘴、眼珠往哪看（-1~1，镜子方向） */
export interface FaceExpr {
  blink: number
  mouth: number
  lookX: number
  lookY: number
}

type Residual = { px: number; py: number; rx: number; ry: number; t: number; w: number }

/** 人脸框 → 镜像后的头位置（和校准预览、照镜子的方向一致） */
export function poseOf(b: { x: number; y: number; w: number; h: number }): HeadPos {
  return { cx: 1 - (b.x + b.w / 2), cy: b.y + b.h / 2, w: b.w }
}

/**
 * 从 478 个关键点估头的转角，已镜像成照镜子的方向
 * 33 / 263 = 右眼 / 左眼外眼角，1 = 鼻尖，234 / 454 = 右 / 左脸颊边缘，152 = 下巴
 */
export function rotationOf(lm: Array<{ x: number; y: number }>, vw: number, vh: number): Pick<HeadPos, 'roll' | 'yaw' | 'pitch'> | null {
  const rEye = lm[33]
  const lEye = lm[263]
  const nose = lm[1]
  const rEdge = lm[234]
  const lEdge = lm[454]
  const chin = lm[152]
  if (!rEye || !lEye || !nose || !rEdge || !lEdge || !chin) return null
  // 画面里从人的右眼（在画面左边）指向左眼；镜像后左右翻过来，角度取反
  const roll = -Math.atan2((lEye.y - rEye.y) * vh, (lEye.x - rEye.x) * vw)
  // 鼻尖在两颊之间的位置：正对时约 0.5；人往自己左边转，鼻尖在画面里往右，镜子里是往左转
  const span = lEdge.x - rEdge.x
  const yaw = Math.abs(span) > 1e-4 ? (0.5 - (nose.x - rEdge.x) / span) * 2 : 0
  const eyeY = (rEye.y + lEye.y) / 2
  const down = chin.y - eyeY
  const pitch = Math.abs(down) > 1e-4 ? (nose.y - eyeY) / down : 0.5
  return { roll, yaw, pitch }
}

export function meanPose(list: HeadPos[]): HeadPos | null {
  if (!list.length) return null
  const n = list.length
  const avg = (f: (p: HeadPos) => number) => list.reduce((a, p) => a + f(p), 0) / n
  const out: HeadPos = { cx: avg((p) => p.cx), cy: avg((p) => p.cy), w: avg((p) => p.w) }
  // 转角只在每一帧都有时才平均（老数据没有）
  if (list.every((p) => p.roll != null && p.yaw != null && p.pitch != null)) {
    out.roll = avg((p) => p.roll!)
    out.yaw = avg((p) => p.yaw!)
    out.pitch = avg((p) => p.pitch!)
  }
  return out
}

function lerpPose(e: HeadPos, p: HeadPos, k: number): HeadPos {
  const out: HeadPos = { cx: e.cx + (p.cx - e.cx) * k, cy: e.cy + (p.cy - e.cy) * k, w: e.w + (p.w - e.w) * k }
  if (p.roll != null) out.roll = e.roll != null ? e.roll + (p.roll - e.roll) * k : p.roll
  if (p.yaw != null) out.yaw = e.yaw != null ? e.yaw + (p.yaw - e.yaw) * k : p.yaw
  if (p.pitch != null) out.pitch = e.pitch != null ? e.pitch + (p.pitch - e.pitch) * k : p.pitch
  return out
}

class GazeEngine {
  status = createStore<GazeStatus>({
    state: 'off',
    face: false,
    fps: 0,
    calibrated: false,
    cvErrorPx: null,
    cameraLabel: '',
    cameras: [],
    faceScale: null,
    calibFaceScale: null,
    driftPx: 0,
    dark: false
  })
  /** 当前头位置和校准时的头位置，给「往前 / 往后 / 往左…」的提醒和实时小人用；expr = 眨眼、张嘴、眼珠方向 */
  pose = createStore<{ cur: HeadPos | null; ref: HeadPos | null; expr: FaceExpr | null }>({ cur: null, ref: null, expr: null })
  /** 最近一次看到脸时的人脸框（0~1，未镜像）和时间（performance.now），拍大头照时按它裁 */
  lastFaceBox: { x: number; y: number; w: number; h: number } | null = null
  lastFaceBoxAt = 0
  events = new Emitter<{
    frame: GazeFrame
    sample: GazeSample
    fixStart: Fixation
    fixUpdate: Fixation
    fixEnd: Fixation
  }>()

  readonly video: HTMLVideoElement = document.createElement('video')
  private stream: MediaStream | null = null
  private detector: FaceDetector | null = null
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private model: RidgeModel | null = null
  private filter = new OneEuro2D(0.55, 0.0045)
  private fixations = new FixationDetector(95, 140)
  private residuals: Residual[] = []
  private recent: Array<{ t: number; x: number; y: number }> = []
  private running = false
  private frameCount = 0
  private fpsT0 = performance.now()
  private lastFaceAt = 0
  private scales: number[] = []
  private poseEma: HeadPos | null = null
  private exprEma: FaceExpr | null = null
  private tiny = document.createElement('canvas')
  private tinyCtx = this.tiny.getContext('2d', { willReadFrequently: true })!
  lastSample: GazeSample | null = null

  private wantedCamera: string | undefined

  constructor() {
    // 摄像头插拔 / iPhone 连续互通相机连上断开时自动重试
    navigator.mediaDevices?.addEventListener('devicechange', () => {
      this.listCameras().catch(() => undefined)
      const st = this.status.get().state
      if (st === 'error' || (st === 'running' && !this.stream?.active)) {
        setTimeout(() => this.start(this.wantedCamera), 800)
      }
    })
    this.video.muted = true
    this.video.playsInline = true
    this.canvas.width = PROC_W
    this.canvas.height = PROC_H
    this.loadModel()
  }

  // ---------- 摄像头 ----------

  async listCameras(): Promise<Array<{ id: string; label: string }>> {
    const devs = await navigator.mediaDevices.enumerateDevices()
    const cams = devs.filter((d) => d.kind === 'videoinput').map((d) => ({ id: d.deviceId, label: d.label || '摄像头' }))
    this.status.patch({ cameras: cams })
    return cams
  }

  async start(cameraId?: string): Promise<void> {
    if (this.status.get().state === 'loading') return
    this.wantedCamera = cameraId
    this.stop()
    this.status.patch({ state: 'loading', error: undefined })
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
        this.status.patch({ state: 'error', error: '摄像头断开了', face: false })
        setTimeout(() => this.start(this.wantedCamera), 1500)
      })
      const track = this.stream.getVideoTracks()[0]
      this.video.srcObject = this.stream
      await this.video.play()
      const cams = await this.listCameras()
      this.status.patch({
        state: 'running',
        cameraLabel: track?.label || cams.find((c) => c.id === cameraId)?.label || '摄像头'
      })
      this.running = true
      this.loop()
    } catch (e: any) {
      console.error('[gaze] 启动失败', e)
      const notFound = e?.name === 'NotFoundError' || /not found/i.test(e?.message || '')
      this.status.patch({
        state: 'error',
        error: notFound ? '没有可用的摄像头（MacBook 合盖时内置摄像头不可用，可以用 iPhone 连续互通相机）' : e?.message || String(e)
      })
      this.listCameras().catch(() => undefined)
    }
  }

  stop(): void {
    this.running = false
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    if (this.status.get().state !== 'off') this.status.patch({ state: 'off', face: false, fps: 0 })
  }

  private loopGen = 0
  private lastProcessAt = 0
  private watchdog: ReturnType<typeof setInterval> | null = null

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
      if (dark !== this.status.get().dark) this.status.patch({ dark })
    }
    if (t - this.fpsT0 > 1000) {
      this.status.patch({ fps: Math.round((this.frameCount * 1000) / (t - this.fpsT0)) })
      this.frameCount = 0
      this.fpsT0 = t
    }

    let features: Float64Array | null = null
    let blink = 0
    let headZ: number | null = null
    let faceBox: GazeFrame['faceBox'] = null
    let pose: HeadPos | null = null
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
      this.lastFaceAt = t
      this.lastFaceBox = faceBox
      this.lastFaceBoxAt = t
      this.scales.push(faceBox.w)
      if (this.scales.length > 30) this.scales.shift()
      pose = { ...poseOf(faceBox), ...(rotationOf(det.allLandmarks, vw, vh) || {}) }
      this.poseEma = this.poseEma ? lerpPose(this.poseEma, pose, 0.15) : pose
      const ex = this.exprOf(det)
      const ee = this.exprEma
      // 眨眼要跟得快，别的稍微平滑一点
      this.exprEma = ee
        ? { blink: ee.blink + (ex.blink - ee.blink) * 0.6, mouth: ee.mouth + (ex.mouth - ee.mouth) * 0.4, lookX: ee.lookX + (ex.lookX - ee.lookX) * 0.3, lookY: ee.lookY + (ex.lookY - ee.lookY) * 0.3 }
        : ex
      if (this.frameCount % 3 === 0) this.pose.patch({ cur: { ...this.poseEma }, expr: { ...this.exprEma } })
    } else if (this.poseEma && t - this.lastFaceAt > 600) {
      this.poseEma = null
      this.exprEma = null
      this.pose.patch({ cur: null, expr: null })
    }
    const face = !!features
    const st = this.status.get()
    if (st.face !== face && (face || t - this.lastFaceAt > 600)) this.status.patch({ face })
    if (face && this.frameCount % 15 === 0 && this.scales.length) {
      const avg = this.scales.reduce((a, b) => a + b, 0) / this.scales.length
      this.status.patch({ faceScale: Math.round(avg * 1000) / 1000 })
    }

    this.events.emit('frame', { t, features, face, blink, headZ, faceBox, pose })

    // 闭眼那几帧眼部图像是废的，直接跳过，保持上一次的视线
    const blinking = blink > 0.45
    if (!this.model || !features || blinking) {
      const s: GazeSample = { t, raw: null, smooth: this.lastSample?.smooth ?? null, face, blink: blinking }
      this.lastSample = s
      this.events.emit('sample', s)
      return
    }
    const p = predictRidge(this.model, features)
    const c = this.correction(p.x, p.y)
    const d = boundsStore.get().display
    // 允许稍微越界，但不能飞太远
    const rx = Math.min(d.x + d.width + 80, Math.max(d.x - 80, p.x + c.dx))
    const ry = Math.min(d.y + d.height + 80, Math.max(d.y - 80, p.y + c.dy))
    this.recent.push({ t, x: p.x, y: p.y })
    while (this.recent.length && t - this.recent[0].t > 1500) this.recent.shift()
    const sm = this.filter.filter(rx, ry, t)
    const sample: GazeSample = { t, raw: { x: rx, y: ry }, smooth: sm, face, blink: false }
    this.lastSample = sample
    this.events.emit('sample', sample)
    const ev = this.fixations.push(sm.x, sm.y, t)
    if (ev?.kind === 'start') this.events.emit('fixStart', ev.fix)
    else if (ev?.kind === 'update') this.events.emit('fixUpdate', ev.fix)
    else if (ev?.kind === 'end') this.events.emit('fixEnd', ev.fix)
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

  /** 最近一段时间（毫秒）原始预测的平均值，未加漂移校正 */
  recentPrediction(ms = 400): { x: number; y: number } | null {
    const now = performance.now()
    const pts = this.recent.filter((p) => now - p.t <= ms)
    if (pts.length < 3) return null
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
  }

  currentFixation(): Fixation | null {
    return this.fixations.current()
  }

  setSmoothing(v: number): void {
    // v: 0（跟手）~ 1（很稳）
    const minCutoff = 1.4 - v * 1.2
    this.filter.setParams(Math.max(0.12, minCutoff), 0.0045)
  }

  // ---------- 校准模型 ----------

  isCalibrated(): boolean {
    return !!this.model
  }

  private loadModel(): void {
    try {
      const raw = localStorage.getItem(MODEL_KEY)
      if (!raw) return
      const m = JSON.parse(raw) as RidgeModel
      if (m && m.d > 0 && m.betaX?.length === m.d) {
        this.model = m
        const sc = Number(localStorage.getItem(MODEL_KEY + '.scale'))
        this.status.patch({ calibrated: true, cvErrorPx: m.cvErrorPx, calibFaceScale: sc > 0 ? sc : null })
        const ref = JSON.parse(localStorage.getItem(MODEL_KEY + '.pose') || 'null') as HeadPos | null
        // 老版本只存了脸宽，那就只能提醒前后
        this.pose.patch({ ref: ref ?? (sc > 0 ? { cx: NaN, cy: NaN, w: sc } : null) })
      }
    } catch {
      /* 旧模型坏了就当没校准 */
    }
  }

  setModel(m: RidgeModel, faceScale: number | null, pose: HeadPos | null = null): void {
    this.model = m
    this.residuals = []
    this.filter.reset()
    this.fixations.reset()
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(m))
    } catch {
      /* 存不下就只在本次会话有效 */
    }
    this.status.patch({ calibrated: true, cvErrorPx: m.cvErrorPx, calibFaceScale: faceScale, driftPx: 0 })
    this.pose.patch({ ref: pose })
    try {
      localStorage.setItem(MODEL_KEY + '.scale', String(faceScale ?? ''))
      localStorage.setItem(MODEL_KEY + '.pose', JSON.stringify(pose))
    } catch {
      /* 忽略 */
    }
  }

  clearModel(): void {
    this.model = null
    localStorage.removeItem(MODEL_KEY)
    this.status.patch({ calibrated: false, cvErrorPx: null })
    this.pose.patch({ ref: null })
  }

  /** 在 Worker 里拟合 */
  fit(input: FitInput): Promise<{ model: RidgeModel; ms: number }> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./ridge.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (e) => {
        w.terminate()
        if (e.data.ok) resolve({ model: e.data.model, ms: e.data.ms })
        else reject(new Error(e.data.error))
      }
      w.onerror = (e) => {
        w.terminate()
        reject(new Error(e.message))
      }
      w.postMessage(input)
    })
  }

  /** 收集 ms 毫秒内的有效特征帧（有脸、没眨眼） */
  collect(ms: number, onProgress?: (n: number) => void): Promise<{ rows: Float64Array[]; faceScale: number | null; poses: HeadPos[] }> {
    return new Promise((resolve) => {
      const rows: Float64Array[] = []
      const sc: number[] = []
      const poses: HeadPos[] = []
      const t0 = performance.now()
      let done = false
      const finish = () => {
        if (done) return
        done = true
        off()
        resolve({ rows, faceScale: sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null, poses })
      }
      const off = this.events.on('frame', (f) => {
        if (f.features && f.blink < 0.4) {
          rows.push(f.features)
          if (f.faceBox) sc.push(f.faceBox.w)
          if (f.pose) poses.push(f.pose)
          onProgress?.(rows.length)
        }
        if (performance.now() - t0 >= ms) finish()
      })
      // 摄像头没出帧也要能结束
      setTimeout(finish, ms + 1500)
    })
  }

  // ---------- 漂移校正（越用越准） ----------

  /**
   * 记一条「真实落点 vs 预测」的残差。
   * 来源：用户按 − 做的显式校正，或者用摇杆把焦点挪到目标后按 A（按下那一刻人一般正看着目标）。
   */
  addResidual(target: { x: number; y: number }, pred: { x: number; y: number }, weight = 1): void {
    const rx = target.x - pred.x
    const ry = target.y - pred.y
    this.residuals.push({ px: pred.x, py: pred.y, rx, ry, t: Date.now(), w: weight })
    if (this.residuals.length > 16) this.residuals.shift()
    const c = this.correction(pred.x, pred.y)
    this.status.patch({ driftPx: Math.round(Math.hypot(c.dx, c.dy)) })
  }

  resetDrift(): void {
    this.residuals = []
    this.status.patch({ driftPx: 0 })
  }

  private correction(x: number, y: number): { dx: number; dy: number } {
    if (!this.residuals.length) return { dx: 0, dy: 0 }
    const now = Date.now()
    const sigma = 520
    const tau = 20 * 60 * 1000
    let sw = 0
    let sx = 0
    let sy = 0
    for (const r of this.residuals) {
      const d2 = (r.px - x) ** 2 + (r.py - y) ** 2
      const w = r.w * Math.exp(-d2 / (2 * sigma * sigma)) * Math.exp(-(now - r.t) / tau)
      sw += w
      sx += w * r.rx
      sy += w * r.ry
    }
    if (sw < 1e-3) return { dx: 0, dy: 0 }
    // 权重太小时往 0 收，避免一两条样本把全屏带偏
    const k = sw / (sw + 0.35)
    return { dx: (sx / sw) * k, dy: (sy / sw) * k }
  }
}

export const gaze = new GazeEngine()
