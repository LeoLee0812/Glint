// 开发模式下把内部单例挂到 window.__la，方便用调试协议做自动化测试；打包后不存在
import { focus, panes } from './focus/focus'
import { gaze } from './gaze/engine'
import { chatStore, ask } from './chat/chatStore'
import { docsStore, openDoc } from './panes/docs'
import { input } from './input/joycon'
import * as jevBrain from './jev/jevBrain'
import { jevStore } from './jev/jevBrain'
import { uiStore, settingsStore, toastStore } from './appState'
import { terminals } from './panes/TerminalPane'

if (import.meta.env.DEV) {
  ;(window as any).__la = { focus, panes, gaze, chatStore, ask, docsStore, openDoc, input, jevStore, uiStore, settingsStore, toastStore, terminals, jevBrain }
}
