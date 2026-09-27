import type { GazeSourceKind } from '../../../shared/types'
import { createStore, Emitter } from '../store'
import { boundsStore, settingsStore } from '../appState'
import { OneEuro2D, FixationDetector, type Fixation } from './filters'
import { predictRidge, type RidgeModel, type FitInput } from './ridge'
import { lerpPose, type FaceExpr, type HeadPos } from './pose'
import type { GazeFrame, GazeSample, GazeStatus, SourceFrame } from './types'
import { WebcamSource } from './sources/webcam'
import { TrueDepthSource } from './sources/truedepth'
import { fitTd, predictTd, type TdModel } from './td/model'

// 眼动引擎：输入源 → 特征 → 校准模型映射到屏幕坐标 → 漂移校正 → One Euro 平滑 → 注视检测
// 输入源两种（gaze/sources/）：
// - Mac 摄像头：MediaPipe 人脸 478 点 → RealEye 特征 → 岭回归
// - iPhone 原深感：头的三维位姿 + 双眼朝向 → 视线和屏幕平面求交 → 几何校准（头挪、歪、前后动都不偏）
// 两种源的校准模型分开存，切来切去不用重校。输出统一用「屏幕坐标（点）」，谁用谁自己换算到窗口坐标。

export type { GazeFrame, GazeSample, GazeStatus, TdLink } from './types'
export { poseOf, rotationOf, meanPose, type HeadPos, type FaceExpr } from './pose'

const MODEL_KEY = 'lookask.gazeModel.v1'
const TD_MODEL_KEY = 'lookask.gazeModel.td.v1'

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
    faceScale: null,
    calibFaceScale: null,
    driftPx: 0,
    dark: false,
    source: 'webcam',
    link: null
  })
  /** 当前头位置和校准时的头位置，给「往前 / 往后 / 往左…」的提醒和实时小人用；expr = 眨眼、张嘴、眼珠方向 */
  pose = createStore<{ cur: HeadPos | null; ref: HeadPos | null; expr: FaceExpr | null }>({ cur: null, ref: null, expr: null })
  events = new Emitter<{
    frame: GazeFrame
    sample: GazeSample
    fixStart: Fixation
    fixUpdate: Fixation
    fixEnd: Fixation
  }>()
  lastSample: GazeSample | null = null

  readonly webcam: WebcamSource
  readonly td: TrueDepthSource
  private kind: GazeSourceKind = 'webcam'
  /** 拍大头照时临时借用摄像头（当前输入源是原深感） */
  private webcamBorrowed = false

  private model: RidgeModel | null = null
  private ridgeScale: number | null = null
  private ridgeRef: HeadPos | null = null
  private tdModel: TdModel | null = null
  private tdRef: HeadPos | null = null

  private filter = new OneEuro2D(0.55, 0.0045)
  private fixations = new FixationDetector(95, 140)
  private residuals: Residual[] = []
  private recent: Array<{ t: number; x: number; y: number }> = []
  private frameCount = 0
  private lastFaceAt = 0
  private scales: number[] = []
  private poseEma: HeadPos | null = null
  private exprEma: FaceExpr | null = null

  constructor() {
    this.webcam = new WebcamSource({
      frame: (f) => this.ingest('webcam', f),
      status: (p) => {
        if (this.kind === 'webcam') this.status.patch(p)
        else if (p.cameras) this.status.patch({ cameras: p.cameras })
      }
    })
    this.td = new TrueDepthSource(
      {
        frame: (f) => this.ingest('truedepth', f),
        status: (p) => this.kind === 'truedepth' && this.status.patch(p)
      },
      {
        mirrorX: () => this.tdModel?.mirrorX ?? false,
        mount: () => settingsStore.get().s?.gaze.tdMount ?? 'bottom'
      }
    )
    this.loadModels()
  }

  /** 摄像头画面（校准预览、拍大头照用；输入源是原深感时只有借用期间才有画面） */
  get video(): HTMLVideoElement {
    return this.webcam.video
  }

  /** 最近一次看到脸时的人脸框（0~1，未镜像），拍大头照时按它裁 */
  get lastFaceBox(): GazeFrame['faceBox'] {
    return this.webcam.lastFaceBox
  }

  get lastFaceBoxAt(): number {
    return this.webcam.lastFaceBoxAt
  }

  get source(): GazeSourceKind {
    return this.kind
  }

  // ---------- 输入源 ----------

  listCameras(): Promise<Array<{ id: string; label: string }>> {
    return this.webcam.listCameras()
  }

  /** 按设置里选的输入源启动（摄像头的话用 cameraId） */
  async start(cameraId?: string): Promise<void> {
    const want: GazeSourceKind = settingsStore.get().s?.gaze.source === 'truedepth' ? 'truedepth' : 'webcam'
    this.setSource(want)
    if (want === 'truedepth') {
      await this.td.start()
      await this.td.refreshDisplay()
    } else await this.webcam.start(cameraId)
  }

  stop(): void {
    if (this.kind === 'truedepth') this.td.stop()
    else this.webcam.stop()
  }

  /** 换输入源：停掉旧的，换上对应的校准模型；视线平滑、注视、漂移校正都从头来 */
  setSource(kind: GazeSourceKind): void {
    if (kind === this.kind) return
    if (this.kind === 'truedepth') this.td.stop()
    else if (!this.webcamBorrowed) this.webcam.stop()
    this.kind = kind
    this.filter.reset()
    this.fixations.reset()
    this.residuals = []
    this.recent = []
    this.scales = []
    this.poseEma = null
    this.exprEma = null
    this.lastSample = null
    this.status.patch({
      source: kind,
      state: 'off',
      error: undefined,
      face: false,
      fps: 0,
      dark: false,
      faceScale: null,
      driftPx: 0,
      link: null,
      cameraLabel: kind === 'truedepth' ? 'iPhone 原深感' : ''
    })
    this.applyModelStatus()
  }

  /** 输入源是原深感时，拍大头照要临时开一下摄像头 */
  async borrowWebcam(cameraId?: string): Promise<void> {
    if (this.kind === 'webcam' || this.webcamBorrowed) return
    this.webcamBorrowed = true
    await this.webcam.start(cameraId)
  }

  releaseWebcam(): void {
    if (!this.webcamBorrowed) return
    this.webcamBorrowed = false
    if (this.kind !== 'webcam') this.webcam.stop()
  }

  /** 摄像头画面能不能用（拍大头照前判断） */
  webcamReady(): boolean {
    return this.webcam.running && this.webcam.video.readyState >= 2
  }

  // ---------- 每一帧 ----------

  private ingest(kind: GazeSourceKind, f: SourceFrame): void {
    // 借用中的摄像头只要人脸框（在源里记着），不算视线
    if (kind !== this.kind) return
    const t = f.t
    this.frameCount++
    if (f.face && f.pose) {
      this.lastFaceAt = t
      this.scales.push(f.pose.w)
      if (this.scales.length > 30) this.scales.shift()
      this.poseEma = this.poseEma ? lerpPose(this.poseEma, f.pose, 0.15) : f.pose
      if (f.expr) {
        const ex = f.expr
        const ee = this.exprEma
        // 眨眼要跟得快，别的稍微平滑一点
        this.exprEma = ee
          ? { blink: ee.blink + (ex.blink - ee.blink) * 0.6, mouth: ee.mouth + (ex.mouth - ee.mouth) * 0.4, lookX: ee.lookX + (ex.lookX - ee.lookX) * 0.3, lookY: ee.lookY + (ex.lookY - ee.lookY) * 0.3 }
          : ex
      }
      if (this.frameCount % 3 === 0) this.pose.patch({ cur: { ...this.poseEma }, expr: this.exprEma ? { ...this.exprEma } : null })
    } else if (this.poseEma && t - this.lastFaceAt > 600) {
      this.poseEma = null
      this.exprEma = null
      this.pose.patch({ cur: null, expr: null })
    }
    const face = !!f.features && f.face
    const st = this.status.get()
    if (st.face !== face && (face || t - this.lastFaceAt > 600)) this.status.patch({ face })
    if (face && this.frameCount % 15 === 0 && this.scales.length) {
      const avg = this.scales.reduce((a, b) => a + b, 0) / this.scales.length
      this.status.patch({ faceScale: Math.round(avg * 1000) / 1000 })
    }

    this.events.emit('frame', { t, features: f.features, face, blink: f.blink, headZ: f.headZ, faceBox: f.faceBox, pose: f.pose })

    // 闭眼那几帧眼部数据是废的，直接跳过，保持上一次的视线
    const blinking = f.blink > 0.45
    const p = face && !blinking ? this.predict(f.features!) : null
    if (!p) {
      const s: GazeSample = { t, raw: null, smooth: this.lastSample?.smooth ?? null, face, blink: blinking }
      this.lastSample = s
      this.events.emit('sample', s)
      return
    }
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

  private predict(features: Float64Array): { x: number; y: number } | null {
    if (this.kind === 'truedepth') return this.tdModel ? predictTd(this.tdModel, features) : null
    return this.model ? predictRidge(this.model, features) : null
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

  // ---------- 校准模型（两种源各存一份） ----------

  isCalibrated(): boolean {
    return this.kind === 'truedepth' ? !!this.tdModel : !!this.model
  }

  /** 当前原深感模型（调试 / 测试用） */
  get tdCalibration(): TdModel | null {
    return this.tdModel
  }

  private loadModels(): void {
    try {
      const raw = localStorage.getItem(MODEL_KEY)
      if (raw) {
        const m = JSON.parse(raw) as RidgeModel
        if (m && m.d > 0 && m.betaX?.length === m.d) {
          this.model = m
          const sc = Number(localStorage.getItem(MODEL_KEY + '.scale'))
          this.ridgeScale = sc > 0 ? sc : null
          const ref = JSON.parse(localStorage.getItem(MODEL_KEY + '.pose') || 'null') as HeadPos | null
          // 老版本只存了脸宽，那就只能提醒前后
          this.ridgeRef = ref ?? (sc > 0 ? { cx: NaN, cy: NaN, w: sc } : null)
        }
      }
    } catch {
      /* 旧模型坏了就当没校准 */
    }
    try {
      const raw = localStorage.getItem(TD_MODEL_KEY)
      if (raw) {
        const m = JSON.parse(raw) as TdModel
        if (m?.kind === 'td' && Array.isArray(m.th) && m.th.length === 7) {
          this.tdModel = m
          this.tdRef = JSON.parse(localStorage.getItem(TD_MODEL_KEY + '.pose') || 'null') as HeadPos | null
        }
      }
    } catch {
      /* 同上 */
    }
    this.applyModelStatus()
  }

  private applyModelStatus(): void {
    if (this.kind === 'truedepth') {
      const m = this.tdModel
      this.status.patch({ calibrated: !!m, cvErrorPx: m?.cvErrorPx ?? null, calibFaceScale: this.tdRef?.w ?? null })
      this.pose.patch({ ref: m ? this.tdRef : null })
    } else {
      const m = this.model
      this.status.patch({ calibrated: !!m, cvErrorPx: m?.cvErrorPx ?? null, calibFaceScale: m ? this.ridgeScale : null })
      this.pose.patch({ ref: m ? this.ridgeRef : null })
    }
  }

  private afterNewModel(): void {
    this.residuals = []
    this.filter.reset()
    this.fixations.reset()
    this.status.patch({ driftPx: 0 })
    this.applyModelStatus()
  }

  setModel(m: RidgeModel, faceScale: number | null, pose: HeadPos | null = null): void {
    this.model = m
    this.ridgeScale = faceScale
    this.ridgeRef = pose
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify(m))
      localStorage.setItem(MODEL_KEY + '.scale', String(faceScale ?? ''))
      localStorage.setItem(MODEL_KEY + '.pose', JSON.stringify(pose))
    } catch {
      /* 存不下就只在本次会话有效 */
    }
    if (this.kind === 'webcam') this.afterNewModel()
  }

  setTdModel(m: TdModel, pose: HeadPos | null): void {
    this.tdModel = m
    this.tdRef = pose
    try {
      localStorage.setItem(TD_MODEL_KEY, JSON.stringify(m))
      localStorage.setItem(TD_MODEL_KEY + '.pose', JSON.stringify(pose))
    } catch {
      /* 同上 */
    }
    if (this.kind === 'truedepth') this.afterNewModel()
  }

  /** 删掉当前输入源的校准模型 */
  clearModel(): void {
    if (this.kind === 'truedepth') {
      this.tdModel = null
      localStorage.removeItem(TD_MODEL_KEY)
    } else {
      this.model = null
      localStorage.removeItem(MODEL_KEY)
    }
    this.applyModelStatus()
  }

  /** 在 Worker 里拟合岭回归（摄像头） */
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

  /** 用校准数据拟合当前输入源的模型并启用；返回交叉验证误差 */
  async calibrate(input: FitInput, faceScale: number | null, pose: HeadPos | null): Promise<{ cv: number | null; ms: number; note?: string }> {
    if (this.kind === 'truedepth') {
      const t0 = performance.now()
      await this.td.refreshDisplay()
      const m = fitTd({
        rows: input.rows,
        tx: input.tx,
        ty: input.ty,
        groups: input.groups,
        S: this.td.pointsPerMeter(),
        z0: this.td.planeOffset(),
        screenW: input.screenW,
        screenH: input.screenH
      })
      this.setTdModel(m, pose)
      const [gx, gy] = m.gain
      const odd = gx < 0.5 || gx > 2.2 || gy < 0.5 || gy > 2.2
      return {
        cv: m.cvErrorPx,
        ms: performance.now() - t0,
        note: odd ? `眼睛转角的校正量不太正常（${gx.toFixed(2)} / ${gy.toFixed(2)}），多半是校准时没盯住点，或者手机被碰动了` : undefined
      }
    }
    const { model, ms } = await this.fit(input)
    this.setModel(model, faceScale, pose)
    return { cv: model.cvErrorPx, ms }
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
          if (f.pose) {
            sc.push(f.pose.w)
            poses.push(f.pose)
          }
          onProgress?.(rows.length)
        }
        if (performance.now() - t0 >= ms) finish()
      })
      // 没出帧也要能结束
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
