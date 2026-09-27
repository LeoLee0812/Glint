import type { GazeSourceKind } from '../../../shared/types'
import type { FaceExpr, HeadPos } from './pose'

// 眼动引擎对外的数据结构（引擎、输入源、界面共用）

export interface GazeFrame {
  t: number
  features: Float64Array | null
  face: boolean
  blink: number
  headZ: number | null
  faceBox: { x: number; y: number; w: number; h: number } | null
  /** 这一帧的头位置和转角（未平滑） */
  pose: HeadPos | null
}

export interface GazeSample {
  t: number
  raw: { x: number; y: number } | null
  smooth: { x: number; y: number } | null
  face: boolean
  blink: boolean
}

/** iPhone 原深感的连接状态（输入源是原深感时才有） */
export interface TdLink {
  /** waiting 在等手机连上；unpaired 手机连上了但还没配对；live 正在收帧；lost 断了；error 监听开不起来 */
  state: 'waiting' | 'unpaired' | 'live' | 'lost' | 'error'
  /** 正在用的手机名 */
  device: string
  /** 这台 Mac 在 Bonjour 上的名字（手机列表里显示的） */
  mac: string
  msg?: string
  loss: number
  /** 手机发热档位 0~3 */
  therm?: number
  /** 发现了但还没配对的手机 */
  unpaired: Array<{ dev: string; name: string; badCode?: boolean }>
  /** 眼睛到屏幕的距离（厘米） */
  distanceCm: number | null
}

export interface GazeStatus {
  state: 'off' | 'loading' | 'running' | 'error'
  error?: string
  face: boolean
  fps: number
  calibrated: boolean
  cvErrorPx: number | null
  cameraLabel: string
  cameras: Array<{ id: string; label: string }>
  /** 脸宽占画面宽度的比例，用来看人离屏幕的远近有没有变 */
  faceScale: number | null
  calibFaceScale: number | null
  driftPx: number
  /** 画面几乎全黑（镜头被挡 / iPhone 扣在桌上） */
  dark: boolean
  /** 当前输入源 */
  source: GazeSourceKind
  link: TdLink | null
}

/** 输入源交给引擎的一帧 */
export interface SourceFrame extends GazeFrame {
  expr: FaceExpr | null
}

/** 输入源回调引擎的口子 */
export interface SourceHooks {
  frame(f: SourceFrame): void
  status(p: Partial<GazeStatus>): void
}
