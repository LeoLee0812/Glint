import { randomUUID } from 'node:crypto'
import { createAsr, type AsrAudio, type AsrEmit } from '../shared/asrCore'
import { localActive, localAsrAvailable, localAudio, localStart, localStop } from './asrLocal'
import { loadSettings } from './settings'

// 协议逻辑在 shared/asrCore.ts；这里只提供桌面版的依赖（Node 自带的 WebSocket 支持握手时带请求头）
const cloud = createAsr({
  providers: () => loadSettings().providers,
  openWs: (url, headers) => new (WebSocket as any)(url, { headers }),
  uuid: randomUUID,
  urlOverride: process.env.LOOKASK_ASR_URL
})

// Windows 装了本地模型就走本地，否则走云端；测试开关 LOOKASK_ASR_URL 指定了服务时始终走云端那条路
export function asrStart(target: string, emit: AsrEmit): void {
  if (!process.env.LOOKASK_ASR_URL && localAsrAvailable()) localStart(target, emit)
  else cloud.asrStart(target, emit)
}

export function asrAudio(chunk: AsrAudio): void {
  if (localActive()) localAudio(chunk)
  else cloud.asrAudio(chunk)
}

export function asrStop(): void {
  if (localActive()) localStop()
  else cloud.asrStop()
}
