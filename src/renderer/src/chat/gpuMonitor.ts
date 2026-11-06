import { createStore } from '../store'
import { la } from '../appState'

// 本地翻译的显卡曲线：翻译开始前就开始采，翻完再多留一会，这样能看到「平稳 → 冲高 → 回落」
// 单词翻译只要 100 多毫秒，采样可能赶不上，所以翻译区间单独记下来，在曲线上标出来

export const GPU_WINDOW_MS = 30_000
/** 最后一次翻译结束后，曲线还留多久 */
const HOLD_MS = 45_000

export interface GpuPoint {
  t: number
  util: number
}

export interface GpuState {
  visible: boolean
  name: string
  util: number
  memUsed: number
  memTotal: number
  power: number
  points: GpuPoint[]
  /** 正在翻译的区间，to 为 null 表示还没结束 */
  bands: Array<{ reqId: string; from: number; to: number | null }>
}

export const gpuStore = createStore<GpuState>({ visible: false, name: '', util: 0, memUsed: 0, memTotal: 0, power: 0, points: [], bands: [] })

let hideTimer: ReturnType<typeof setTimeout> | null = null
let subscribed = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  la.gpu.onEvent((e) => {
    if (e.t === 'unavailable') {
      gpuStore.patch({ visible: false })
      return
    }
    const now = performance.now()
    gpuStore.set((s) => ({
      ...s,
      visible: true,
      name: e.name,
      util: e.util,
      memUsed: e.memUsed,
      memTotal: e.memTotal,
      power: e.power,
      points: [...s.points.filter((p) => now - p.t <= GPU_WINDOW_MS), { t: now, util: e.util }],
      bands: s.bands.filter((b) => b.to === null || now - b.to <= GPU_WINDOW_MS)
    }))
  })
}

/** 本地翻译开始：只在 Windows 上采，安卓和 Mac 没有这条链路 */
export function gpuTranslateStart(reqId: string): void {
  if (la.platform !== 'win32') return
  subscribe()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  la.gpu.watch(true)
  gpuStore.set((s) => ({ ...s, bands: [...s.bands, { reqId, from: performance.now(), to: null }] }))
}

export function gpuTranslateEnd(reqId: string): void {
  const s = gpuStore.get()
  if (!s.bands.some((b) => b.reqId === reqId && b.to === null)) return
  const bands = s.bands.map((b) => (b.reqId === reqId ? { ...b, to: performance.now() } : b))
  gpuStore.patch({ bands })
  if (bands.some((b) => b.to === null)) return
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    la.gpu.watch(false)
    gpuStore.patch({ visible: false, points: [], bands: [] })
  }, HOLD_MS)
}
