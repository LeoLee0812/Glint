import type { Settings, Rect } from '../../shared/types'
import { createStore, uid } from './store'
import { haptic } from './input/haptics'

// 全局共享状态：设置、窗口位置、界面模式、提示条

export const la = window.lookask

export interface WinBounds {
  content: Rect
  display: Rect
  workArea: Rect
  scale: number
  mode: 'normal' | 'calibration'
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

export type UiMode = 'normal' | 'calibration'
/** 视线跟哪一边：左 = 阅读内容，右 = AI 回答区 */
export type Side = 'left' | 'right'
export const uiStore = createStore<{
  mode: UiMode
  side: Side
  showSettings: boolean
  /** 打开设置时直接跳到哪一页（比如发现 iPhone 待配对时跳到「眼动」，拍大头照发现没填 Key 时跳到「模型服务」） */
  settingsTab: 'gaze' | 'providers' | 'jev' | null
  showHelp: boolean
  showCalibration: boolean
  /** 拍大头照 / 生成小人的弹窗 */
  showBooth: boolean
  /** 正在截主窗口：视线圈、焦点框、小人这些浮在上面的东西先藏起来 */
  capturing: boolean
}>({
  mode: 'normal',
  side: 'left',
  showSettings: false,
  settingsTab: null,
  showHelp: false,
  showCalibration: false,
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

/** 手柄震动反馈（没连手柄时静默）；手感统一定义在 input/haptics.ts（strong = 拍大头照快门那一下，满幅偏低频） */
export function rumble(kind: 'tick' | 'done' | 'alert' | 'soft' | 'strong' = 'tick', side?: 'L' | 'R'): void {
  haptic(kind, side)
}
