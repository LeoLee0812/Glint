import { createStore } from '../store'
import { la } from '../appState'

// 显卡曲线：眼动开着时常驻；没开眼动时翻译开始才采，翻完再多留一会，这样能看到「平稳 → 冲高 → 回落」
// 实测 RTX 3050 上开摄像头占 26%~28%，停掉摄像头只剩 0%~2%，所以常驻时标「眼动」
// 单词翻译只要 100 多毫秒，采样可能赶不上，所以翻译区间单独记下来，在曲线上标出来

export const GPU_WINDOW_MS = 30_000
/** 没开眼动时，最后一次翻译结束后曲线还留多久 */
const HOLD_MS = 45_000

export interface GpuPoint {
  t: number
  util: number
}

export interface GpuState {
  visible: boolean
  gaze: boolean
  name: string
  util: number
  memUsed: number
  memTotal: number
  power: number
  points: GpuPoint[]
  /** 正在翻译的区间，to 为 null 表示还没结束 */
  bands: Array<{ reqId: string; from: number; to: number | null }>
}

export const gpuStore = createStore<GpuState>({ visible: false, gaze: false, name: '', util: 0, memUsed: 0, memTotal: 0, power: 0, points: [], bands: [] })

let hideTimer: ReturnType<typeof setTimeout> | null = null
let subscribed = false
let watching = false
let gazeOn = false

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  la.gpu.onEvent((e) => {
    if (!watching) return
    if (e.t === 'unavailable') {
      watching = false
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

function startWatching(): void {
  subscribe()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  watching = true
  la.gpu.watch(true)
}

function stopWatching(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  watching = false
  la.gpu.watch(false)
  gpuStore.patch({ visible: false, points: [], bands: [] })
}

function translating(): boolean {
  return gpuStore.get().bands.some((b) => b.to === null)
}

/** 眼动开关：开着时曲线常驻。关掉时如果还在翻译或翻完的保留期内，就等那边收尾 */
export function gpuGazeSet(on: boolean): void {
  if (la.platform !== 'win32' || on === gazeOn) return
  gazeOn = on
  gpuStore.patch({ gaze: on })
  if (on) startWatching()
  else if (watching && !translating() && !hideTimer) stopWatching()
}

/** 本地翻译开始：只在 Windows 上采，安卓和 Mac 没有这条链路 */
export function gpuTranslateStart(reqId: string): void {
  if (la.platform !== 'win32') return
  startWatching()
  gpuStore.set((s) => ({ ...s, bands: [...s.bands, { reqId, from: performance.now(), to: null }] }))
}

export function gpuTranslateEnd(reqId: string): void {
  const s = gpuStore.get()
  if (!s.bands.some((b) => b.reqId === reqId && b.to === null)) return
  gpuStore.patch({ bands: s.bands.map((b) => (b.reqId === reqId ? { ...b, to: performance.now() } : b)) })
  if (translating() || gazeOn) return
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (!gazeOn) stopWatching()
  }, HOLD_MS)
}
