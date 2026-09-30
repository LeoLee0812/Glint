import { randomUUID } from 'node:crypto'
import type { BridgeEvent, Provider } from '../shared/types'
import { loadSettings } from './settings'

// Windows 的按住说话：系统没有 Mac 那样开箱即用的本地中文识别，改走阿里云百炼的 Fun-ASR 实时识别（fun-asr-realtime），
// 复用设置里百炼服务商的 Key（Key 只在主进程）。渲染进程采麦克风（16kHz 单声道 16 位 PCM，100ms 一块）经 IPC 送过来，
// 这里转给百炼的 WebSocket：run-task → 等 task-started → 二进制音频 → finish-task → task-finished。
// 结果按 sentence_id 拼成整段，以和 Mac 原生助手一样的 asr 事件（listening / partial / final / error）推给渲染进程，
// 按键路由不用管是哪个平台。协议见 https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api

const MODEL = 'fun-asr-realtime'
/** 松开扳机后最多再等多久拿最终结果（云端比本地慢，Mac 本地识别等 1.2 秒） */
const FINAL_WAIT_MS = 3000

type Emit = (e: BridgeEvent) => void
/** 经 IPC 过来的一块音频：ArrayBuffer，或者被转成了 Buffer / Uint8Array */
type Audio = ArrayBuffer | ArrayBufferView

interface Session {
  id: number
  target: string
  emit: Emit
  ws: WebSocket
  taskId: string
  /** 收到 task-started 才能发音频，之前的先攒着 */
  started: boolean
  pending: Audio[]
  sentences: Map<number, string>
  finishing: boolean
  done: boolean
  timer: ReturnType<typeof setTimeout> | null
}

let seq = 0
let cur: Session | null = null

/** 用哪个百炼服务商的 Key：优先内置的「千问 · 阿里云百炼」，没填就找别的百炼地址 */
function bailian(): Provider | null {
  const list = loadSettings().providers.filter((p) => p.apiKey && /aliyuncs\.com/.test(p.baseUrl))
  return list.find((p) => p.id === 'qwen') || list[0] || null
}

/** WebSocket 地址跟着服务商的域名走：dashscope.aliyuncs.com、业务空间专属域名、国际站都是同一个路径 */
function wsUrl(p: Provider): string {
  // 测试用：LOOKASK_ASR_URL=ws://127.0.0.1:端口/… 指到本地模拟的识别服务
  if (process.env.LOOKASK_ASR_URL) return process.env.LOOKASK_ASR_URL
  return `wss://${new URL(p.baseUrl).host}/api-ws/v1/inference`
}

/** 各句按顺序拼起来；中文直接接，英文单词之间补个空格 */
function joined(s: Session): string {
  let out = ''
  for (const id of [...s.sentences.keys()].sort((a, b) => a - b)) {
    const t = s.sentences.get(id) || ''
    if (out && /[A-Za-z0-9.,!?]$/.test(out) && /^[A-Za-z0-9]/.test(t)) out += ' '
    out += t
  }
  return out.trim()
}

function header(s: Session, action: 'run-task' | 'finish-task'): Record<string, string> {
  return { action, task_id: s.taskId, streaming: 'duplex' }
}

function finish(s: Session, error?: string): void {
  if (s.done) return
  s.done = true
  if (s.timer) clearTimeout(s.timer)
  if (error && !joined(s)) s.emit({ t: 'asr', state: 'error', error, target: s.target })
  else s.emit({ t: 'asr', state: 'final', text: joined(s), target: s.target })
  try {
    s.ws.close()
  } catch {
    /* 已经关了 */
  }
  if (cur === s) cur = null
}

function sendFinish(s: Session): void {
  try {
    s.ws.send(JSON.stringify({ header: header(s, 'finish-task'), payload: { input: {} } }))
  } catch {
    finish(s, 'network')
  }
}

/** 按下扳机：开一个识别任务；上一个没收完的直接丢掉（和 Mac 一样，新的一句盖掉旧的） */
export function asrStart(target: string, emit: Emit): void {
  if (cur) {
    const old = cur
    old.done = true
    if (old.timer) clearTimeout(old.timer)
    try {
      old.ws.close()
    } catch {
      /* 忽略 */
    }
    cur = null
  }
  const p = bailian()
  if (!p) {
    emit({ t: 'asr', state: 'error', error: 'no_key', target })
    return
  }
  let ws: WebSocket
  try {
    // Node 自带的 WebSocket（undici）支持握手时带请求头，百炼在握手阶段验 Key
    ws = new (WebSocket as any)(wsUrl(p), { headers: { Authorization: `Bearer ${p.apiKey}`, 'user-agent': 'Glint' } })
  } catch (e) {
    emit({ t: 'asr', state: 'error', error: `network: ${(e as Error)?.message || e}`, target })
    return
  }
  ws.binaryType = 'arraybuffer'
  const s: Session = {
    id: ++seq,
    target,
    emit,
    ws,
    taskId: randomUUID().replace(/-/g, ''),
    started: false,
    pending: [],
    sentences: new Map(),
    finishing: false,
    done: false,
    timer: null
  }
  cur = s

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        header: header(s, 'run-task'),
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: MODEL,
          // 不设语种：中英混说（论文里的术语）让模型自己认
          parameters: { format: 'pcm', sample_rate: 16000 },
          input: {}
        }
      })
    )
  }
  ws.onmessage = (ev: MessageEvent) => {
    if (s.done || typeof ev.data !== 'string') return
    let msg: any
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    const event = msg?.header?.event
    if (event === 'task-started') {
      s.started = true
      emit({ t: 'asr', state: 'listening', target })
      for (const chunk of s.pending) ws.send(chunk)
      s.pending = []
      if (s.finishing) sendFinish(s)
    } else if (event === 'result-generated') {
      const st = msg?.payload?.output?.sentence
      if (!st || st.heartbeat) return
      s.sentences.set(Number(st.sentence_id) || 0, String(st.text || ''))
      emit({ t: 'asr', state: 'partial', text: joined(s), target })
    } else if (event === 'task-finished') {
      finish(s)
    } else if (event === 'task-failed') {
      const code = String(msg?.header?.error_code || '')
      const text = String(msg?.header?.error_message || code || '识别失败')
      finish(s, /InvalidApiKey|Unauthorized|AccessDenied/i.test(code + text) ? 'auth' : text)
    }
  }
  ws.onerror = () => finish(s, s.started ? 'network' : 'connect')
  ws.onclose = () => finish(s, s.started ? 'network' : 'connect')
}

/** 一块音频（16kHz 单声道 16 位小端 PCM） */
export function asrAudio(chunk: Audio): void {
  const s = cur
  if (!s || s.done || s.finishing || !chunk?.byteLength) return
  if (s.started) s.ws.send(chunk)
  else s.pending.push(chunk)
}

/** 松开扳机：通知服务端这句说完了，等最终结果；等不到就用最后一次的中间结果 */
export function asrStop(): void {
  const s = cur
  if (!s || s.done || s.finishing) return
  s.finishing = true
  if (s.started) sendFinish(s)
  else if (!s.pending.length) {
    // 还没连上就松开了，一个字都没录到
    finish(s)
    return
  }
  s.timer = setTimeout(() => finish(s, 'timeout'), FINAL_WAIT_MS)
}
