import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { GPU_WINDOW_MS, gpuStore } from './gpuMonitor'
import { LOCAL_TRANSLATE_MODEL } from '../../../shared/defaults'

// 输入区上方的显卡曲线：横轴是最近 30 秒，纵轴是显卡占用 0~100%，蓝底是本地模型正在翻译的时段

const W = 600
const H = 72
const MIN_SPAN_MS = 10_000

export function GpuStrip(): React.JSX.Element | null {
  const s = useStore(gpuStore)
  const [now, setNow] = useState(() => performance.now())
  // 没新样本时曲线也要往左走
  useEffect(() => {
    if (!s.visible) return
    const id = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(id)
  }, [s.visible])
  if (!s.visible) return null

  // 刚开始采样时横轴只铺到已有的时长（至少 10 秒），曲线不会缩在右边一小截，满 30 秒后再滚动
  const span = Math.min(GPU_WINDOW_MS, Math.max(MIN_SPAN_MS, s.points[0] ? now - s.points[0].t : 0))
  const x = (t: number): number => W - ((now - t) / span) * W
  const y = (u: number): number => H - (Math.min(100, Math.max(0, u)) / 100) * (H - 2) - 1
  const pts = s.points.map((p) => `${x(p.t).toFixed(1)},${y(p.util).toFixed(1)}`)
  const first = s.points[0]
  const area = first ? `${x(first.t).toFixed(1)},${H} ${pts.join(' ')} ${W},${y(s.util).toFixed(1)} ${W},${H}` : ''
  const line = first ? `${pts.join(' ')} ${W},${y(s.util).toFixed(1)}` : ''
  const running = s.bands.some((b) => b.to === null)

  return (
    <div className={'gpu-strip no-focus' + (running ? ' running' : '')}>
      <div className="gpu-now">
        <b>{Math.round(s.util)}%</b>
        <span>本地 GPU · {s.name}</span>
        <span>
          {LOCAL_TRANSLATE_MODEL} · {(s.memUsed / 1024).toFixed(1)}/{(s.memTotal / 1024).toFixed(0)} GB · {Math.round(s.power)} W
        </span>
      </div>
      <svg className="gpu-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
        {s.bands.map((b) => {
          const from = Math.max(0, x(b.from))
          const to = b.to === null ? W : x(b.to)
          // 单词翻译很短，至少留 3 个单位宽，不然看不见
          return <rect key={b.reqId} className="gpu-band" x={from} y={0} width={Math.max(3, to - from)} height={H} />
        })}
        {area && <polygon className="gpu-area" points={area} />}
        {line && <polyline className="gpu-line" points={line} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  )
}
