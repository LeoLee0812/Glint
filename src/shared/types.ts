// 主进程、预加载、渲染进程共用的类型

export type ProviderKind = 'openai' | 'anthropic'

/** 一个大模型服务商：OpenAI 兼容（千问/DeepSeek/OpenLux/智谱/Kimi/Ollama…）或 Anthropic 格式 */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  models: string[]
  /** 附加到请求体里的字段，比如千问关思考：{"enable_thinking": false} */
  extraBody?: Record<string, unknown>
}

export interface ModelRef {
  providerId: string
  model: string
}

export interface JevConfig {
  /** 网关地址：TypeSafe 直连 / 博查 / OpenCode Zen / Vercel 等，协议都是 systemone */
  baseUrl: string
  apiKey: string
  model: string
  /** 每天最多用多少输入 token，超了自动停，Key 不能充值要省着用 */
  dailyTokenCap: number
}

export interface GazeConfig {
  cameraId: string
  calibrationPoints: 9 | 17
  showCursor: boolean
  autoScroll: boolean
  /** 平滑强度 0~1，越大越稳越慢 */
  smoothing: number
  /** 吸附强度 0~1：视线光环吸词有多积极、软焦点多不容易跳段（0.4 约等于最早的手感） */
  magnet: number
}

/** 实时小人：拍的大头照交给哪个图生图服务变成卡通形象（OpenAI 兼容的 images/edits 接口） */
export interface AvatarConfig {
  providerId: string
  model: string
  quality: 'low' | 'medium' | 'high'
  /** 显示屏幕角落里的实时小人 */
  show: boolean
}

export interface Settings {
  providers: Provider[]
  chatModel: ModelRef
  fastModel: ModelRef
  visionModel: ModelRef
  avatar: AvatarConfig
  jev: JevConfig
  jevMode: boolean
  gaze: GazeConfig
  terminal: { cwd: string; shell: string }
  systemPrompt: string
  leftRatio: number
}

// ---------- 大模型调用 ----------

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string }

export interface ChatMessageIn {
  role: 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface LlmRequest {
  reqId: string
  model: ModelRef
  system: string
  messages: ChatMessageIn[]
  temperature?: number
  maxTokens?: number
}

export interface LlmDelta {
  reqId: string
  text?: string
  reasoning?: string
}

export interface LlmDone {
  reqId: string
  error?: string
  usage?: { input?: number; output?: number }
  ms: number
}

// ---------- Jev ----------

export type JevQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

export interface JevAnswer {
  type: 'choice' | 'score' | 'noul'
  choice?: string
  probabilities?: Record<string, number>
  score?: number
  legend?: Record<string, string>
  noul?: number
  confidence?: number
}

export interface JevResult {
  ok: boolean
  answers: Record<string, JevAnswer>
  model?: string
  inputTokens: number
  cached: boolean
  ms: number
  error?: string
}

export interface JevUsage {
  day: string
  inputTokens: number
  calls: number
  cacheHits: number
  totalTokens: number
}

// ---------- 原生助手事件 ----------

export type BridgeEvent =
  | { t: 'ready'; version: string }
  | { t: 'joy'; side: 'L' | 'R' | 'P'; id: string; b: number; lx: number; ly: number; rx: number; ry: number; bat: number; chg: boolean }
  | { t: 'joy_conn'; side: 'L' | 'R' | 'P'; id: string; name: string; connected: boolean }
  | { t: 'asr'; state: 'listening' | 'partial' | 'final' | 'error'; text?: string; error?: string; target?: string }
  | { t: 'ocr'; id: number; w?: number; h?: number; lines?: OcrLine[]; error?: string }
  | { t: 'ax'; id: number; app?: string; role?: string; title?: string; text?: string; line?: string; window?: string; error?: string }
  | { t: 'log'; msg: string }
  | { t: 'bridge_exit'; code: number | null }

export interface OcrLine {
  text: string
  conf: number
  x: number
  y: number
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 全局模式浮层要画的东西（屏幕坐标） */
export interface OverlayState {
  gaze: { x: number; y: number } | null
  /** 眼睛去了视线不跟的那一侧：光环朝这个点滑走、边走边淡 */
  exit?: { x: number; y: number } | null
  focus: Rect | null
  label?: string
  mode: 'soft' | 'hard'
}
