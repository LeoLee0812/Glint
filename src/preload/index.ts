import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  BridgeEvent,
  JevQuestion,
  JevResult,
  JevUsage,
  DisplayInfo,
  TdFrame,
  TdStatus,
  LlmDelta,
  LlmDone,
  LlmRequest,
  Provider,
  Rect,
  Settings,
  TrayCommand,
  TrayStatus
} from '../shared/types'

// 渲染进程能用的全部能力都从这里过，渲染进程本身拿不到 Node

function on<T>(channel: string, fn: (payload: T) => void): () => void {
  const h = (_e: unknown, payload: T) => fn(payload)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api = {
  /** 'darwin' / 'win32'：界面上按键怎么写（⌥ / Alt）、要不要显示 iPhone 原深感这些按它分 */
  platform: process.platform,
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (s: Settings): Promise<Settings> => ipcRenderer.invoke('settings:save', s),
    jevPresets: (): Promise<Array<{ name: string; baseUrl: string; model: string }>> => ipcRenderer.invoke('settings:jevPresets'),
    listModels: (p: Provider): Promise<string[]> => ipcRenderer.invoke('settings:listModels', p),
    testProvider: (p: Provider, model: string): Promise<{ ok: boolean; ms: number; text?: string; error?: string }> =>
      ipcRenderer.invoke('settings:testProvider', p, model)
  },
  llm: {
    start: (req: LlmRequest) => ipcRenderer.send('llm:start', req),
    abort: (reqId: string) => ipcRenderer.send('llm:abort', reqId),
    onDelta: (fn: (d: LlmDelta) => void) => on('llm:delta', fn),
    onDone: (fn: (d: LlmDone) => void) => on('llm:done', fn)
  },
  jev: {
    judge: (state: string, questions: Record<string, JevQuestion>): Promise<JevResult> => ipcRenderer.invoke('jev:judge', state, questions),
    usage: (): Promise<JevUsage> => ipcRenderer.invoke('jev:usage')
  },
  pty: {
    create: (opts: { cols: number; rows: number; cwd?: string }): Promise<string> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string) => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string) => ipcRenderer.send('pty:kill', id),
    onData: (fn: (p: { id: string; data: string }) => void) => on('pty:data', fn),
    onExit: (fn: (p: { id: string; code: number }) => void) => on('pty:exit', fn)
  },
  bridge: {
    send: (cmd: Record<string, unknown>) => ipcRenderer.send('bridge:send', cmd),
    onEvent: (fn: (e: BridgeEvent) => void) => on('bridge:event', fn)
  },
  /** 按住说话的云端识别（Windows 用；Mac 走原生助手的系统识别）：start 开任务，audio 送 16kHz 单声道 PCM，stop 收尾；结果从 bridge.onEvent 的 asr 事件回来 */
  asr: {
    start: (target: string) => ipcRenderer.send('asr:start', target),
    audio: (pcm: ArrayBuffer) => ipcRenderer.send('asr:audio', pcm),
    stop: () => ipcRenderer.send('asr:stop')
  },
  win: {
    setMode: (m: 'normal' | 'calibration'): Promise<string> => ipcRenderer.invoke('win:mode', m),
    requestBounds: () => ipcRenderer.invoke('win:bounds'),
    onBounds: (fn: (b: WinBounds) => void) => on('win:bounds', fn),
    toggleVisible: () => ipcRenderer.send('win:toggleVisible'),
    capture: (rect: Rect): Promise<string | null> => ipcRenderer.invoke('win:capture', rect),
    focus: () => ipcRenderer.send('win:focus'),
    /** Windows：弹窗蒙层出现 / 消失时，右上角系统按钮条跟着变暗 / 变回白 */
    setOverlayDim: (dim: boolean) => ipcRenderer.send('win:overlayDim', dim)
  },
  tray: {
    /** 菜单栏图标显示的状态 */
    status: (s: TrayStatus) => ipcRenderer.send('tray:status', s),
    onCommand: (fn: (c: TrayCommand) => void) => on('tray:command', fn)
  },
  truedepth: {
    /** 开 / 关收包：source = 选了原深感输入源，pairing = 设置里正在配对 */
    enable: (reason: 'source' | 'pairing', on: boolean): Promise<TdStatus> => ipcRenderer.invoke('td:enable', reason, on),
    pair: (dev: string, code: string): Promise<{ ok: boolean; error?: string; name?: string }> => ipcRenderer.invoke('td:pair', dev, code),
    unpair: (dev: string): Promise<void> => ipcRenderer.invoke('td:unpair', dev),
    status: (): Promise<TdStatus> => ipcRenderer.invoke('td:status'),
    display: (): Promise<DisplayInfo> => ipcRenderer.invoke('td:display'),
    onFrame: (fn: (f: TdFrame) => void) => on('td:frame', fn),
    onStatus: (fn: (s: TdStatus) => void) => on('td:status', fn)
  },
  avatar: {
    get: (): Promise<string | null> => ipcRenderer.invoke('avatar:get'),
    /** 大头照 → 卡通小人，约半分钟 */
    generate: (photo: string): Promise<{ dataUrl: string; ms: number } | { error: string }> => ipcRenderer.invoke('avatar:generate', photo),
    clear: (): Promise<void> => ipcRenderer.invoke('avatar:clear')
  },
  perm: {
    status: (): Promise<{ camera: string; microphone: string }> => ipcRenderer.invoke('perm:status'),
    /** 打开系统设置的某一页：隐私权限，或者蓝牙（新手引导里连 Joy-Con） */
    openSettings: (pane: 'camera' | 'microphone' | 'speech' | 'bluetooth') => ipcRenderer.invoke('perm:openSettings', pane)
  },
  file: {
    open: () => ipcRenderer.invoke('file:open'),
    read: (path: string) => ipcRenderer.invoke('file:read', path),
    saveText: (name: string, text: string) => ipcRenderer.invoke('file:saveText', name, text),
    pathOf: (f: File) => webUtils.getPathForFile(f)
  }
}

export interface WinBounds {
  content: Rect
  display: Rect
  workArea: Rect
  scale: number
  mode: 'normal' | 'calibration'
}

export type LookAskApi = typeof api

contextBridge.exposeInMainWorld('lookask', api)
