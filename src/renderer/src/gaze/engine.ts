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
  headZ: number | null
  calibHeadZ: number | null
  driftPx: number
  /** 画面几乎全黑（镜头被挡 / iPhone 扣在桌上） */
  dark: boolean
}

type Residual = { px: number; py: number; rx: number; ry: number; t: number; w: number }

class GazeEngine {
  status = createStore<GazeStatus>({
    state: 'off',
    face: false,
    fps: 0,
    calibrated: false,
    cvErrorPx: null,
    cameraLabel: '',
    cameras: [],
    headZ: null,
    calibHeadZ: null,
    driftPx: 0,
    dark: false
  })
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
  private headZs: number[] = []
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
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    if (this.status.get().state !== 'off') this.status.patch({ state: 'off', face: false, fps: 0 })
  }

  private loop(): void {
    if (!this.running) return
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    const next = () => {
      if (!this.running) return
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
      if (headZ) {
        this.headZs.push(headZ)
        if (this.headZs.length > 30) this.headZs.shift()
      }
    }
    const face = !!features
    const st = this.status.get()
    if (st.face !== face && (face || t - this.lastFaceAt > 600)) this.status.patch({ face })
    if (headZ && this.frameCount % 15 === 0) {
      const avg = this.headZs.reduce((a, b) => a + b, 0) / this.headZs.length
      this.status.patch({ headZ: Math.round(avg) })
    }

    this.events.emit('frame', { t, features, face, blink, headZ, faceBox })

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
        this.status.patch({ calibrated: true, cvErrorPx: m.cvErrorPx })
      }
    } catch {
      /* 旧模型坏了就当没校准 */
    }
  }

  setModel(m: RidgeModel, headZ: number | null): void {
    this.model = m
    this.residuals = []
    this.filter.reset()
    this.fixations.reset()
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(m))
    } catch {
      /* 存不下就只在本次会话有效 */
    }
    this.status.patch({ calibrated: true, cvErrorPx: m.cvErrorPx, calibHeadZ: headZ, driftPx: 0 })
  }

  clearModel(): void {
    this.model = null
    localStorage.removeItem(MODEL_KEY)
    this.status.patch({ calibrated: false, cvErrorPx: null })
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
  collect(ms: number, onProgress?: (n: number) => void): Promise<{ rows: Float64Array[]; headZ: number | null }> {
    return new Promise((resolve) => {
      const rows: Float64Array[] = []
      const zs: number[] = []
      const t0 = performance.now()
      const off = this.events.on('frame', (f) => {
        if (f.features && f.blink < 0.4) {
          rows.push(f.features)
          if (f.headZ) zs.push(f.headZ)
          onProgress?.(rows.length)
        }
        if (performance.now() - t0 >= ms) {
          off()
          resolve({ rows, headZ: zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null })
        }
      })
      // 摄像头没出帧也要能结束
      setTimeout(() => {
        off()
        resolve({ rows, headZ: zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null })
      }, ms + 1500)
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
