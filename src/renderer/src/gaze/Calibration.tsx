import { useEffect, useRef, useState } from 'react'
import { gaze } from './engine'
import { useStore } from '../store'
import { uiStore, setUiMode, settingsStore, clientToScreen, screenToClient, toast, rumble, boundsStore, la } from '../appState'
import { input } from '../input/joycon'
import type { FitInput } from './ridge'

// 全屏校准：盯着点看，点缩小时采集眼睛特征；结束后在 Worker 里拟合并给出交叉验证误差
// 另有两个轻量流程：精度测试（5 个随机点量真实误差）、漂移校正（盯中心点 1.5 秒）

type Phase = 'intro' | 'points' | 'fitting' | 'result' | 'validate' | 'validateResult' | 'drift'

const SETTLE_MS = 750
const RECORD_MS = 850

function pattern(n: 9 | 17): Array<[number, number]> {
  const a = 0.07
  const b = 0.93
  const grid: Array<[number, number]> = [
    [a, a], [0.5, a], [b, a],
    [b, 0.5], [0.5, 0.5], [a, 0.5],
    [a, b], [0.5, b], [b, b]
  ]
  if (n === 9) return grid
  const p = 0.29
  const q = 0.71
  const extra: Array<[number, number]> = [
    [p, p], [0.5, p], [q, p],
    [q, 0.5], [p, 0.5],
    [p, q], [0.5, q], [q, q]
  ]
  // 大格点和中间点交错着来，避免连续同一行把头带偏
  const out: Array<[number, number]> = []
  for (let i = 0; i < 9; i++) {
    out.push(grid[i])
    if (extra[i]) out.push(extra[i])
  }
  return out
}

function ptToDeg(px: number): number {
  // 估算：macOS 默认缩放下 1pt ≈ 0.023cm，眼睛到屏幕按 55cm 算
  return (Math.atan((px * 0.023) / 55) * 180) / Math.PI
}

export function Calibration(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  if (!ui.showCalibration) return null
  return <CalibrationInner kind={ui.calibrationKind} />
}

function CalibrationInner({ kind }: { kind: 'full' | 'validate' | 'drift' }): React.JSX.Element {
  const settings = useStore(settingsStore).s
  const status = useStore(gaze.status)
  const [phase, setPhase] = useState<Phase>(kind === 'full' ? 'intro' : kind)
  const [dot, setDot] = useState<{ x: number; y: number; shrink: boolean } | null>(null)
  const [idx, setIdx] = useState(0)
  const [total, setTotal] = useState(0)
  const [result, setResult] = useState<{ cv: number | null; ms: number; samples: number } | null>(null)
  const [valErr, setValErr] = useState<{ px: number; deg: number; points: Array<{ tx: number; ty: number; gx: number; gy: number }> } | null>(null)
  const [face, setFace] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const scaleRef = useRef<number | null>(null)

  // 进全屏；退出时还原窗口
  useEffect(() => {
    abortRef.current = false
    setUiMode('calibration')
    if (gaze.status.get().state !== 'running') gaze.start(settings?.gaze.cameraId || undefined)
    return () => {
      abortRef.current = true
      setUiMode('normal')
    }
  }, [])

  // 预览摄像头 + 人脸框
  useEffect(() => {
    if (phase !== 'intro' || !previewRef.current) return
    const v = gaze.video
    v.className = 'calib-video'
    previewRef.current.prepend(v)
    const off = gaze.events.on('frame', (f) => setFace(f.faceBox))
    return () => {
      off()
      // 从 DOM 里拿掉的 video 会被浏览器自动暂停，要马上接着播，不然眼动循环就停了
      v.remove()
      v.play().catch(() => undefined)
    }
  }, [phase])

  const close = () => uiStore.patch({ showCalibration: false })

  // 手柄/键盘：A 开始，B 退出
  useEffect(() => {
    return input.onAction((a) => {
      if (a === 'confirm' && phase === 'intro') run()
      else if (a === 'confirm' && (phase === 'result' || phase === 'validateResult')) close()
      else if (a === 'cancel') close()
    })
  })

  useEffect(() => {
    if (kind === 'validate') runValidate()
    if (kind === 'drift') runDrift()
  }, [])

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 等窗口真的铺满屏幕、主进程把新位置推过来，再开始算校准点的屏幕坐标 */
  async function waitFullscreen(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await la.win.requestBounds()
      await sleep(80)
      const b = boundsStore.get()
      if (b.mode === 'calibration' && Math.abs(b.content.width - b.display.width) < 2 && Math.abs(b.content.height - b.display.height) < 2) return
    }
  }

  async function run(): Promise<void> {
    if (status.state !== 'running') {
      toast('摄像头还没准备好', 'warn')
      return
    }
    await waitFullscreen()
    await sleep(250)
    const pts = pattern(settings?.gaze.calibrationPoints ?? 17)
    setTotal(pts.length)
    setPhase('points')
    const W = window.innerWidth
    const H = window.innerHeight
    const rows: Float64Array[] = []
    const tx: number[] = []
    const ty: number[] = []
    const groups: number[] = []
    const zs: number[] = []
    for (let i = 0; i < pts.length; i++) {
      if (abortRef.current) return
      const [nx, ny] = pts[i]
      const cx = nx * W
      const cy = ny * H
      setIdx(i)
      setDot({ x: cx, y: cy, shrink: false })
      await sleep(30)
      setDot({ x: cx, y: cy, shrink: true })
      await sleep(SETTLE_MS)
      let got = await gaze.collect(RECORD_MS)
      if (got.rows.length < 6) {
        // 眨眼或脸丢了，这个点再来一次
        setDot({ x: cx, y: cy, shrink: false })
        await sleep(200)
        setDot({ x: cx, y: cy, shrink: true })
        await sleep(SETTLE_MS)
        got = await gaze.collect(RECORD_MS + 300)
      }
      const s = clientToScreen(cx, cy)
      for (const r of got.rows) {
        rows.push(r)
        tx.push(s.x)
        ty.push(s.y)
        groups.push(i)
      }
      if (got.faceScale) zs.push(got.faceScale)
      rumble('soft', 'R')
    }
    setDot(null)
    if (rows.length < 40) {
      toast('有效样本太少：检查光线、别戴反光眼镜、脸完整进画面', 'error', { ttl: 6000 })
      setPhase('intro')
      return
    }
    setPhase('fitting')
    const input: FitInput = { rows, tx, ty, groups, screenW: W, screenH: H }
    try {
      const { model, ms } = await gaze.fit(input)
      scaleRef.current = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null
      gaze.setModel(model, scaleRef.current)
      setResult({ cv: model.cvErrorPx, ms, samples: rows.length })
      setPhase('result')
      rumble('done', 'R')
    } catch (e: any) {
      toast('拟合失败：' + e.message, 'error')
      setPhase('intro')
    }
  }

  async function runValidate(): Promise<void> {
    if (!gaze.isCalibrated()) {
      toast('先做一次完整校准', 'warn')
      close()
      return
    }
    await waitFullscreen()
    await sleep(300)
    const W = window.innerWidth
    const H = window.innerHeight
    const pts: Array<[number, number]> = [[0.5, 0.5], [0.2, 0.25], [0.8, 0.3], [0.25, 0.78], [0.78, 0.75]]
    setTotal(pts.length)
    const out: Array<{ tx: number; ty: number; gx: number; gy: number }> = []
    for (let i = 0; i < pts.length; i++) {
      if (abortRef.current) return
      const cx = pts[i][0] * W
      const cy = pts[i][1] * H
      setIdx(i)
      setDot({ x: cx, y: cy, shrink: false })
      await sleep(30)
      setDot({ x: cx, y: cy, shrink: true })
      await sleep(650)
      const samples: Array<{ x: number; y: number }> = []
      const off = gaze.events.on('sample', (s) => s.smooth && s.raw && samples.push(s.smooth))
      await sleep(900)
      off()
      if (!samples.length) continue
      const g = {
        x: samples.reduce((a, p) => a + p.x, 0) / samples.length,
        y: samples.reduce((a, p) => a + p.y, 0) / samples.length
      }
      const s = clientToScreen(cx, cy)
      out.push({ tx: s.x, ty: s.y, gx: g.x, gy: g.y })
    }
    setDot(null)
    const errs = out.map((p) => Math.hypot(p.gx - p.tx, p.gy - p.ty))
    const px = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0
    setValErr({ px, deg: ptToDeg(px), points: out })
    setPhase('validateResult')
  }

  async function runDrift(): Promise<void> {
    if (!gaze.isCalibrated()) {
      toast('先做一次完整校准', 'warn')
      close()
      return
    }
    await waitFullscreen()
    await sleep(250)
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    setDot({ x: cx, y: cy, shrink: false })
    await sleep(30)
    setDot({ x: cx, y: cy, shrink: true })
    await sleep(700)
    const pred = await new Promise<{ x: number; y: number } | null>((r) => setTimeout(() => r(gaze.recentPrediction(700)), 800))
    if (pred) {
      gaze.addResidual(clientToScreen(cx, cy), pred, 2)
      toast(`漂移已校正（偏了 ${Math.round(Math.hypot(clientToScreen(cx, cy).x - pred.x, clientToScreen(cx, cy).y - pred.y))} 点）`, 'ok')
      rumble('done', 'R')
    } else {
      toast('没拿到视线数据，脸在画面里吗？', 'warn')
    }
    close()
  }

  const scale = status.faceScale

  return (
    <div className="calib">
      {phase === 'intro' && (
        <div className="calib-intro">
          <h1>眼动校准</h1>
          <div className="calib-preview" ref={previewRef}>
            {face && (
              <div
                className="calib-facebox"
                style={{
                  left: `${(1 - face.x - face.w) * 100}%`,
                  top: `${face.y * 100}%`,
                  width: `${face.w * 100}%`,
                  height: `${face.h * 100}%`
                }}
              />
            )}
            {status.dark ? (
              <div className="calib-noface">画面是黑的：{status.cameraLabel} 被挡住了？到 设置 → 眼动 换摄像头</div>
            ) : (
              !status.face && <div className="calib-noface">画面里没找到脸</div>
            )}
          </div>
          <div className="calib-meta">
            <span>摄像头：{status.cameraLabel || '启动中…'}</span>
            <span>帧率：{status.fps} fps</span>
            <span>
              脸占画面：{scale ? `${Math.round(scale * 100)}%` : '—'}
              {scale && scale > 0.42 ? '（太近了，往后坐一点）' : scale && scale < 0.13 ? '（太远了，往前坐一点）' : ''}
            </span>
          </div>
          <ul className="calib-tips">
            <li>坐正，眼睛离屏幕 45～65 厘米；接下来 25 秒尽量别动头，只动眼睛</li>
            <li>每个点出现后盯住它的圆心，直到它缩小消失</li>
            <li>
              M4 MacBook Air 的「人物居中」会自动裁切画面，校准会失效：控制中心 → 视频效果 → 关掉人物居中
            </li>
            <li>光线从正面来最好，别背光；反光眼镜会降低精度</li>
          </ul>
          <div className="calib-actions">
            <button className="btn primary" onClick={run} disabled={status.state !== 'running'}>
              开始校准（A / 空格）
            </button>
            <button className="btn" onClick={close}>
              取消（B / Esc）
            </button>
          </div>
        </div>
      )}

      {(phase === 'points' || phase === 'validate' || phase === 'drift') && dot && (
        <>
          <div className={`calib-dot ${dot.shrink ? 'shrink' : ''}`} style={{ left: dot.x, top: dot.y }}>
            <i />
          </div>
          {phase !== 'drift' && (
            <div className="calib-progress">
              {idx + 1} / {total}
              {!status.face && <b> · 看不到脸</b>}
            </div>
          )}
        </>
      )}

      {phase === 'fitting' && <div className="calib-center">正在拟合视线模型…</div>}

      {phase === 'result' && result && (
        <div className="calib-center">
          <h2>校准完成</h2>
          <p className="big">
            {result.cv != null ? `交叉验证误差 ≈ ${Math.round(result.cv)} 点` : '已完成'}
            {result.cv != null && <small>（约 {ptToDeg(result.cv).toFixed(1)}°）</small>}
          </p>
          <p className="dim">
            {result.samples} 帧样本 · 拟合 {Math.round(result.ms)} ms。普通摄像头能到段落级，最后一步靠 Joy-Con 摇杆微调。
          </p>
          {result.cv != null && result.cv > 250 && (
            <p className="warn">误差偏大：多半是校准时头动了、光线从背后来，或者没盯住点。调好再「重新校准」一次。</p>
          )}
          <div className="calib-actions">
            <button className="btn primary" onClick={close}>
              开始用（A）
            </button>
            <button className="btn" onClick={() => setPhase('intro')}>
              重新校准
            </button>
            <button className="btn" onClick={() => runValidate().then(() => undefined)}>
              精度测试
            </button>
          </div>
        </div>
      )}

      {phase === 'validateResult' && valErr && (
        <div className="calib-center">
          {valErr.points.map((p, i) => {
            const t = screenToClient(p.tx, p.ty)
            const g = screenToClient(p.gx, p.gy)
            return (
              <div key={i}>
                <div className="val-target" style={{ left: t.x, top: t.y }} />
                <div className="val-gaze" style={{ left: g.x, top: g.y }} />
              </div>
            )
          })}
          <h2>实测平均误差 {Math.round(valErr.px)} 点</h2>
          <p className="big">约 {valErr.deg.toFixed(1)}°</p>
          <p className="dim">青色圆 = 目标，黄色点 = 视线估计。误差超过 200 点建议重新校准或调光线。</p>
          <div className="calib-actions">
            <button className="btn primary" onClick={close}>
              好（A）
            </button>
            <button className="btn" onClick={() => setPhase('intro')}>
              重新校准
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
