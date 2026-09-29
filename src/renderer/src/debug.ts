// 开发模式下把内部单例挂到 window.__la，方便用调试协议做自动化测试；打包后不存在
import { focus, panes, switchSide } from './focus/focus'
import { snapshot } from './focus/snapshot'
import { gaze } from './gaze/engine'
import { chatStore, ask, popFork, closeFork } from './chat/chatStore'
import { docsStore, openDoc } from './panes/docs'
import { input } from './input/joycon'
import * as haptics from './input/haptics'
import * as wrist from './input/wrist'
import * as jevBrain from './jev/jevBrain'
import { jevStore } from './jev/jevBrain'
import { uiStore, settingsStore, toastStore, boundsStore, updateSettings, clientToScreen } from './appState'
import { terminals } from './panes/TerminalPane'
import { avatarStore, takeHeadshot, generateAvatar } from './avatar/avatar'

if (import.meta.env.DEV) {
  ;(window as any).__la = {
    focus,
    panes,
    switchSide,
    snapshot,
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
    jevStore,
    uiStore,
    settingsStore,
    toastStore,
    terminals,
    jevBrain,
    avatarStore,
    takeHeadshot,
    generateAvatar,
    boundsStore,
    updateSettings,
    clientToScreen
  }
}
