import { net } from 'electron'
import { createLlm } from '../shared/llmCore'
import { getProvider } from './settings'

// 大模型流式调用：放在主进程用 net.fetch，走 Chromium 网络栈（认系统代理、没有跨域问题、Key 不进渲染进程）；协议逻辑在 shared/llmCore.ts

export const { startStream, abortStream, completeOnce, listModels, testProvider } = createLlm(net.fetch as typeof fetch, getProvider)
