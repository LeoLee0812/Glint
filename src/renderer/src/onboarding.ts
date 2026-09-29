import { uiStore, settingsStore, updateSettings, toast } from './appState'
import { gaze } from './gaze/engine'
import { avatarStore } from './avatar/avatar'

// 装好后第一次打开的引导：第一步拍大头照（左摇杆当快门），关掉拍照窗口后再提示填 Key / 校准。只走一次

/** 启动时调用：还没引导过、也还没有小人，就先弹拍照窗口 */
export function startOnboarding(): void {
  const s = settingsStore.get().s
  if (!s) return
  if (!s.onboarded) {
    // 老用户已经有小人了，不用再拍
    if (avatarStore.get().img) updateSettings((x) => ({ ...x, onboarded: true }))
    else return uiStore.patch({ showBooth: true })
  }
  nextStepHint()
}

/** 拍照窗口关掉时调用：第一次的话记下「引导过了」，接着提示下一步 */
export function finishOnboarding(): void {
  if (settingsStore.get().s?.onboarded !== false) return
  updateSettings((x) => ({ ...x, onboarded: true }))
  nextStepHint()
}

/** 下一步：没填 Key 先去填，填了但没校准就去校准 */
function nextStepHint(): void {
  const s = settingsStore.get().s
  if (!s) return
  const chatProvider = s.providers.find((p) => p.id === s.chatModel.providerId)
  if (!chatProvider?.apiKey) {
    toast('还没配置大模型 Key：设置 → 模型服务', 'warn', { ttl: 8000, action: { label: '去设置', run: () => uiStore.patch({ showSettings: true, settingsTab: 'providers' }) } })
  } else if (!gaze.isCalibrated()) {
    toast('先做一次眼动校准（约 30 秒），视线才能对上屏幕', 'info', {
      ttl: 9000,
      action: { label: '开始校准', run: () => uiStore.patch({ showCalibration: true, calibrationKind: 'full' }) }
    })
  }
}
