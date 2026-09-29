// 主进程、预加载、渲染进程共用的类型

export type ProviderKind = 'openai' | 'anthropic'

/** 一个大模型服务商：OpenAI 兼容（百炼千问、本地 Ollama，或自己添加的）或 Anthropic 格式 */
export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  models: string[]
  /** 附加到请求体里的字段，比如千问关思考：{"enable_thinking": false} */
  extraBody?: Record<string, unknown>
  /** 官网上创建 / 查看 API Key 的页面，设置里显示成「去官网拿 Key」 */
  console?: string
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

/** 眼动输入源：Mac 摄像头（平面画面）或 iPhone 原深感（三维头姿 + 双眼朝向） */
export type GazeSourceKind = 'webcam' | 'truedepth'

/**
 * iPhone 放在哪：bottom = 竖放在屏幕和键盘之间的缝里（会挡住屏幕中下部，校准点避开）；
 * top = 用背板挂在屏幕后面、镜头露出上沿；free = 其它不挡屏幕的位置
 */
export type TdMount = 'bottom' | 'top' | 'free'

export interface GazeConfig {
  /** 眼动输入源 */
  source: GazeSourceKind
  /** iPhone 原深感的摆放位置 */
  tdMount: TdMount
  cameraId: string
  calibrationPoints: 9 | 17
  showCursor: boolean
  autoScroll: boolean
  /** 平滑强度 0~1，越大越稳越慢 */
  smoothing: number
  /** 吸附强度 0~1：视线光环吸词有多积极、软焦点多不容易跳段（0.4 约等于最早的手感） */
  magnet: number
  /** 摄像头的头动补偿：头挪开、转头时按三维头姿修正视线（默认开，要重新校准一次才生效） */
  headComp?: boolean
}

/** 实时小人：拍的大头照交给阿里云百炼的千问图像编辑模型（Qwen-Image）变成卡通形象 */
export interface AvatarConfig {
  /** 用哪个百炼服务商的 Key（地址必须是百炼的） */
  providerId: string
  model: string
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
  /** 装好后的首次引导（第一步拍大头照）走过了没有，只弹一次 */
  onboarded: boolean
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
  /** 手柄放在桌上（IMU 几乎不动 3 秒）/ 拿起来了（一动或一按键） */
  | { t: 'joy_motion'; side: 'L' | 'R' | 'P'; id: string; resting: boolean }
  /** 手腕精调：这一包（约 15ms）里手柄往右转了多少度、手柄头抬起了多少度（imu_stream 开着时才推） */
  | { t: 'joy_gyro'; side: 'L' | 'R' | 'P'; id: string; yaw: number; pitch: number }
  | { t: 'asr'; state: 'listening' | 'partial' | 'final' | 'error'; text?: string; error?: string; target?: string }
  | { t: 'log'; msg: string }
  | { t: 'bridge_exit'; code: number | null }
  | { t: 'td_listen'; ok: boolean; port?: number; name?: string; error?: string; stopped?: boolean }
  | { t: 'td_service'; name: string }
  /** 原深感原始数据报：原样转过来，主进程校验后再给渲染进程 */
  | { t: 'td_pkt'; ep: string; d: string }
  | { t: 'display_mm'; id: number; display: number; w: number; h: number; ptw: number; pth: number; builtin: boolean }

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// ---------- iPhone 原深感 ----------
// 手机发来的数据报 = 32 位十六进制签名 + JSON；签名 = HMAC-SHA256(SHA256("lookask-td|设备ID|配对码"), JSON 原文) 的前 16 字节
// JSON 里 t = 'f' 是一帧（约 60 帧/秒），t = 'hb' 是每秒一次的心跳；Mac 回 t = 'ack'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

/** 一帧原深感数据（坐标都在手机前置相机坐标系里，单位米） */
export interface TdFrame {
  v: number
  dev: string
  /** 手机端 App 这次启动的会话号 */
  sid: number
  seq: number
  /** 手机单调时钟（秒） */
  ts: number
  /** Mac 收到的时间（Date.now，毫秒） */
  rx: number
  tracked: boolean
  /** 脸在相机坐标系里的位置和朝向（ARFaceAnchor 换到相机坐标系） */
  head?: { pos: Vec3; quat: Quat }
  /** 左右眼相对脸的位置和朝向（leftEyeTransform / rightEyeTransform） */
  eyeL?: { pos: Vec3; quat: Quat }
  eyeR?: { pos: Vec3; quat: Quat }
  /** lookAtPoint（脸坐标系） */
  look?: Vec3
  /** 眼睛、眉毛、下巴相关的表情系数 */
  bs?: Record<string, number>
  /** 重力方向（相机坐标系，单位向量）：用来定「上」，手机竖放横放都行 */
  grav?: Vec3
  /** 界面方向（仅供参考） */
  orient?: string
}

export interface TdDeviceInfo {
  dev: string
  name: string
  model?: string
  paired: boolean
  /** 配过对但签名对不上（手机上换过配对码） */
  badCode?: boolean
  /** 多少毫秒前收到过包 */
  ago: number
  /** Mac 这边实收帧率 */
  fps: number
  /** 最近几秒的丢包率 0~1 */
  loss: number
  tracked: boolean
  /** 手机发热档位：0 正常 1 偏热 2 严重 3 过热 */
  therm?: number
  /** 手机端发送帧率 */
  sendFps?: number
}

export interface TdStatus {
  listening: boolean
  port: number
  /** Bonjour 上的名字（手机列表里显示的） */
  name: string
  error?: string
  /** 正在用的那台手机 */
  active: string | null
  /** 最近一分钟收到过包的手机 */
  devices: TdDeviceInfo[]
  /** 配过对的全部手机（不在线的也列出来，方便取消配对） */
  paired: Array<{ dev: string; name: string; at: number }>
}

/** 当前窗口所在显示器：物理尺寸（毫米）和逻辑尺寸（点） */
export interface DisplayInfo {
  id: number
  mmW: number
  mmH: number
  ptW: number
  ptH: number
  /** 物理尺寸是系统报的（true）还是猜的 */
  measured: boolean
}

/** 菜单栏图标要显示的状态（渲染进程算好推给主进程，变了才推） */
export interface TrayStatus {
  gaze: 'off' | 'loading' | 'running' | 'error'
  source: GazeSourceKind
  face: boolean
  calibrated: boolean
  cvErrorPx: number | null
  joyL: boolean
  joyR: boolean
  /** 手柄放在桌上（震动先停了，拿起来就恢复） */
  joyRestL: boolean
  joyRestR: boolean
  side: 'left' | 'right'
  jev: boolean
}

/** 菜单栏菜单点了什么，主进程转给渲染进程执行 */
export type TrayCommand =
  | { cmd: 'gaze:toggle' }
  | { cmd: 'gaze:source'; source: GazeSourceKind }
  | { cmd: 'calibrate' }
  | { cmd: 'validate' }
  | { cmd: 'open' }
  | { cmd: 'terminal' }
  | { cmd: 'side'; side: 'left' | 'right' }
  | { cmd: 'jev' }
  | { cmd: 'settings' }
  | { cmd: 'help' }
  /** 找手柄：让两只手柄「哔哔」响几秒 */
  | { cmd: 'joy:find' }
