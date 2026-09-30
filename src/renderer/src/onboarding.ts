import { createStore } from './store'
import { uiStore, settingsStore, updateSettings, toast } from './appState'
import { gaze } from './gaze/engine'
import { avatarStore } from './avatar/avatar'

// 新手引导：装好后第一次打开时一步步带着走——连 Joy-Con → 填 Key（已经有就跳过）→ 校准眼睛 → 试一试（看、选词、解释、说话）
// 界面在 ui/Guide.tsx；按键说明里「从头走一遍引导」能随时再走一次

export type GuideStep = 'welcome' | 'joycon' | 'key' | 'calibrate' | 'practice' | 'done'

export const guideStore = createStore<{
  step: GuideStep | null
  /** 选了「没有手柄，先用键盘」：后面的提示都换成键盘按键 */
  keyboard: boolean
}>({ step: null, keyboard: false })

/** 大模型的 Key 填了没有（本地 Ollama 不用 Key） */
export function hasChatKey(): boolean {
  const s = settingsStore.get().s
  const p = s?.providers.find((x) => x.id === s.chatModel.providerId)
  return !!p && (!!p.apiKey || /127\.0\.0\.1|localhost/.test(p.baseUrl))
}

/** 启动时调用：全新安装走引导；老用户（已经校准过或生成过小人）直接记成引导过了 */
export function startOnboarding(): void {
  const s = settingsStore.get().s
  if (!s) return
  if (!s.onboarded) {
    if (gaze.isCalibrated() || avatarStore.get().img) updateSettings((x) => ({ ...x, onboarded: true }))
    else return openGuide()
  }
  nextStepHint()
}

export function openGuide(): void {
  guideStore.set({ step: 'welcome', keyboard: false })
}

export function goGuide(step: GuideStep): void {
  guideStore.patch({ step })
}

/** 结束引导（走完或跳过）：记下来，下次打开不再弹 */
export function closeGuide(skipped = false): void {
  guideStore.patch({ step: null })
  if (settingsStore.get().s?.onboarded === false) updateSettings((x) => ({ ...x, onboarded: true }))
  if (skipped) nextStepHint()
}

/** 引导正弹着窗（练习那一步除外）：这时手柄按键只归引导，不去触发解释、翻译 */
export function guideModal(): boolean {
  const st = guideStore.get().step
  return st !== null && st !== 'practice'
}

/** 没走引导的人：没填 Key 先去填，填了没校准就去校准 */
function nextStepHint(): void {
  if (!hasChatKey()) {
    toast('还没填大模型的 Key', 'warn', { ttl: 8000, action: { label: '去填', run: () => uiStore.patch({ showSettings: true, settingsTab: 'providers' }) } })
  } else if (!gaze.isCalibrated()) {
    toast('还没校准眼睛，视线会对不上', 'info', { ttl: 9000, action: { label: '去校准', run: () => uiStore.patch({ showCalibration: true }) } })
  }
}
