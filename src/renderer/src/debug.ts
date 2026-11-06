// 开发模式下把内部单例挂到 window.__la，方便用调试协议做自动化测试；桌面打包后不存在
import { focus, panes, switchSide } from './focus/focus'
import { snapshot } from './focus/snapshot'
import { magnetNow } from './focus/snap'
import { gaze } from './gaze/engine'
import { chatStore, ask, popFork, closeFork } from './chat/chatStore'
import { docsStore, openDoc } from './panes/docs'
import { input } from './input/joycon'
import * as haptics from './input/haptics'
import * as wrist from './input/wrist'
import { uiStore, settingsStore, toastStore, boundsStore, updateSettings, clientToScreen } from './appState'
import { terminals } from './panes/TerminalPane'
import { avatarStore, takeHeadshot, generateAvatar } from './avatar/avatar'
import { guideStore, openGuide, goGuide, closeGuide } from './onboarding'

// 平板调试包也挂上（调试靠 adb 转发 WebView 调试端口）；正式包不挂
if (import.meta.env.DEV || (window as any).GlintNative?.debuggable?.()) {
  ;(window as any).__la = {
    focus,
    panes,
    switchSide,
    snapshot,
    magnetNow,
    gaze,
    chatStore,
    ask,
    popFork,
    closeFork,
    docsStore,
    openDoc,
    input,
    haptics,
    wrist,
    uiStore,
    settingsStore,
    toastStore,
    terminals,
    avatarStore,
    takeHeadshot,
    generateAvatar,
    boundsStore,
    updateSettings,
    clientToScreen,
    guide: { store: guideStore, open: openGuide, go: goGuide, close: closeGuide }
  }
}
