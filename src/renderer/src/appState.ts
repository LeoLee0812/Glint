import type { Settings, Rect } from '../../shared/types'
import { createStore, uid } from './store'

// 全局共享状态：设置、窗口位置、界面模式、提示条

export const la = window.lookask

export interface WinBounds {
  content: Rect
  display: Rect
  workArea: Rect
  scale: number
  mode: 'normal' | 'calibration' | 'global'
}

export const settingsStore = createStore<{ s: Settings | null }>({ s: null })

export async function loadSettingsIntoStore(): Promise<Settings> {
  const s = await la.settings.get()
  settingsStore.set({ s })
  return s
}

export async function updateSettings(mut: (s: Settings) => Settings): Promise<void> {
  const cur = settingsStore.get().s
  if (!cur) return
  const next = mut(structuredClone(cur))
  settingsStore.set({ s: next })
  await la.settings.save(next)
}

export const boundsStore = createStore<WinBounds>({
  content: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  display: { x: 0, y: 0, width: screen.width, height: screen.height },
  workArea: { x: 0, y: 0, width: screen.width, height: screen.height },
  scale: window.devicePixelRatio,
  mode: 'normal'
})

la.win.onBounds((b) => boundsStore.set(b as WinBounds))
la.win.requestBounds()

/** 屏幕坐标 → 主窗口内坐标 */
export function screenToClient(x: number, y: number): { x: number; y: number } {
  const c = boundsStore.get().content
  return { x: x - c.x, y: y - c.y }
}

export function clientToScreen(x: number, y: number): { x: number; y: number } {
  const c = boundsStore.get().content
  return { x: x + c.x, y: y + c.y }
}

export type UiMode = 'normal' | 'calibration' | 'global'
/** 视线跟哪一边：左 = 阅读内容（全局模式下是整块屏幕），右 = AI 回答区 */
export type Side = 'left' | 'right'
export const uiStore = createStore<{
  mode: UiMode
  side: Side
  showSettings: boolean
  showHelp: boolean
  showCalibration: boolean
  calibrationKind: 'full' | 'validate' | 'drift'
  /** 拍大头照 / 生成小人的弹窗 */
  showBooth: boolean
  /** 正在截主窗口：视线圈、焦点框、小人这些浮在上面的东西先藏起来 */
  capturing: boolean
}>({
  mode: 'normal',
  side: 'left',
  showSettings: false,
  showHelp: false,
  showCalibration: false,
  calibrationKind: 'full',
  showBooth: false,
  capturing: false
})

// 主进程才是窗口模式的权威来源（渲染进程刷新后要跟上）
boundsStore.subscribe(() => {
  const m = boundsStore.get().mode
  if (m && m !== uiStore.get().mode) uiStore.patch({ mode: m })
})

export async function setUiMode(mode: UiMode): Promise<void> {
  await la.win.setMode(mode)
  uiStore.patch({ mode })
}

export interface Toast {
  id: string
  text: string
  kind: 'info' | 'ok' | 'warn' | 'error' | 'jev'
  action?: { label: string; run: () => void }
  ttl: number
}

export const toastStore = createStore<{ list: Toast[] }>({ list: [] })

export function toast(text: string, kind: Toast['kind'] = 'info', opts: { ttl?: number; action?: Toast['action'] } = {}): string {
  const t: Toast = { id: uid('t'), text, kind, ttl: opts.ttl ?? 3200, action: opts.action }
  toastStore.set((s) => ({ list: [...s.list.slice(-3), t] }))
  if (t.ttl > 0) setTimeout(() => dismissToast(t.id), t.ttl)
  return t.id
}

export function dismissToast(id: string): void {
  toastStore.set((s) => ({ list: s.list.filter((t) => t.id !== id) }))
}

/** 手柄震动反馈（没连手柄时静默） */
export function rumble(kind: 'tick' | 'done' | 'alert' | 'soft' = 'tick', side?: 'L' | 'R'): void {
  const presets = {
    tick: { amp: 0.32, ms: 45, low: 160, high: 320 },
    soft: { amp: 0.2, ms: 60, low: 120, high: 240 },
    done: { amp: 0.45, ms: 90, low: 180, high: 360 },
    alert: { amp: 0.7, ms: 220, low: 140, high: 280 }
  }
  la.bridge.send({ cmd: 'rumble', side, ...presets[kind] })
  if (kind === 'done') setTimeout(() => la.bridge.send({ cmd: 'rumble', side, ...presets.tick }), 150)
}
