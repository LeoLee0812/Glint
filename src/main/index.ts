import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type Rectangle
} from 'electron'
import { join, basename, extname, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'
import type { LlmRequest, Provider, Settings, JevQuestion, Rect, TrayStatus } from '../shared/types'
import { loadSettings, saveSettings, JEV_PRESETS } from './settings'
import { startStream, abortStream, listModels, testProvider } from './llm'
import { judge, jevUsage, flushJev } from './jev'
import { startBridge, stopBridge, onBridge, sendBridge } from './bridge'
import { createPty, writePty, resizePty, killPty, killAllPty } from './pty'
import { qwenCodeEnv } from './qwenCode'
import { generateAvatar, loadAvatar, clearAvatar } from './avatar'
import { initTrueDepth, tdEnable, tdPair, tdUnpair, tdStatus, displayInfo } from './truedepth'
import { initTray, setTrayStatus, refreshTray, destroyTray } from './tray'
import { isMac, isWin } from './platform'
import { prefetchMonitors } from './displayWin'
import { asrStart, asrAudio, asrStop } from './asrCloud'

app.setName('Glint')
// 改名前叫 LookAsk：用户数据（设置、校准、小人、配对）继续放在老目录，改名不丢数据
app.setPath('userData', join(app.getPath('appData'), 'LookAsk'))
// 测试用：LOOKASK_USER_DATA=<目录> 换一套用户数据（设置、校准、小人都分开存），能和已装好的 LookAsk 同时开
if (process.env.LOOKASK_USER_DATA) app.setPath('userData', process.env.LOOKASK_USER_DATA)
// Windows：任务栏分组、通知都认这个 ID，和安装包建的快捷方式（electron-builder 用 appId）对上
if (isWin) app.setAppUserModelId('com.leo.lookask')

// 打包后渲染进程走自定义协议 lookask://app/，不能用 file://：
// MediaPipe 要用 fetch 拉 wasm 和模型，Chromium 的 fetch 不支持 file 协议
protocol.registerSchemesAsPrivileged([
  { scheme: 'lookask', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

const MIME: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.task': 'application/octet-stream'
}

function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('lookask', async (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname)
    const file = normalize(join(root, rel))
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const type = MIME[extname(file).toLowerCase()]
    if (!type) return res
    return new Response(res.body, { status: res.status, headers: { 'content-type': type } })
  })
}

let win: BrowserWindow | null = null
let savedBounds: Rectangle | null = null
let mode: 'normal' | 'calibration' = 'normal'
/**
 * Windows：窗口是不是在最前面。后台程序拿不到焦点（按 HOME 把窗口拉出来后 isFocused() 还是 false），
 * 只看 isFocused 的话 HOME 永远只会「拉出来」、藏不回去；所以自己记：拉到最前 / 获得焦点 = 在前面，别的窗口一激活（blur）= 被盖住了
 */
let inFront = true

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

// 开发模式：开远程调试端口（方便自动化测试），渲染进程日志转到终端
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', process.env.LOOKASK_DEBUG_PORT || '9333')
// 测试用：LOOKASK_FAKE_CAM=1 用 Chromium 的假摄像头（测校准流程，不需要真人）
if (process.env.LOOKASK_FAKE_CAM) app.commandLine.appendSwitch('use-fake-device-for-media-stream')
if (process.env.LOOKASK_FAKE_CAM_FILE) app.commandLine.appendSwitch('use-file-for-fake-video-capture', process.env.LOOKASK_FAKE_CAM_FILE)

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function pushBounds(): void {
  if (!win || win.isDestroyed()) return
  const b = win.getContentBounds()
  const d = screen.getDisplayMatching(b)
  send('win:bounds', {
    content: b,
    display: d.bounds,
    workArea: d.workArea,
    scale: d.scaleFactor,
    mode
  })
}

function loadRenderer(w: BrowserWindow, page: 'index'): void {
  if (isDev) w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
  else w.loadURL(`lookask://app/${page}.html`)
}

/** 标题栏：Mac 留左上角红绿灯；Windows 自己画顶栏，右上角留系统的最小化 / 最大化 / 关闭按钮 */
function titleBarOptions(): BrowserWindowConstructorOptions {
  if (isMac) return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
  return {
    titleBarStyle: 'hidden',
    // 顶栏 52px，按钮条 51px：顶栏底下那道发丝线在按钮下面也露出来
    titleBarOverlay: { color: '#ffffff', symbolColor: '#1d1d1f', height: 51 },
    // 打包后窗口图标用 exe 自带的；开发时手动给一个
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'resources/icon.ico') })
  }
}

function createMainWindow(): void {
  const wa = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    minWidth: 380,
    minHeight: 480,
    title: 'Glint 瞳问',
    ...titleBarOptions(),
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      // 摄像头推理和手柄轮询不能因为窗口在后台就降频
      backgroundThrottling: false
    }
  })
  win.once('ready-to-show', () => {
    // Windows 上直接最大化（Mac 是铺满工作区）
    if (isWin) win?.maximize()
    win?.show()
    pushBounds()
  })
  for (const ev of ['move', 'resize', 'moved', 'enter-full-screen', 'leave-full-screen', 'show'] as const) {
    win.on(ev as any, pushBounds)
  }
  win.on('show', refreshTray)
  win.on('hide', refreshTray)
  win.on('focus', () => (inFront = true))
  win.on('blur', () => (inFront = false))
  win.on('closed', () => {
    win = null
    refreshTray()
  })
  if (isDev) {
    win.webContents.on('console-message', (e: any) => {
      if (e?.message) console.log(`[renderer:${e.level}]`, e.message)
    })
    // Windows 去掉了菜单栏，开发时 F12 / Ctrl+Shift+I 开开发者工具
    if (!isMac) {
      win.webContents.on('before-input-event', (_e, input) => {
        if (input.type !== 'keyDown') return
        if (input.key === 'F12' || (input.control && input.shift && input.key.toUpperCase() === 'I')) win?.webContents.toggleDevTools()
      })
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(win, 'index')
}

function showWindow(): void {
  if (!win) return createMainWindow()
  bringToFront(win)
}

/**
 * 把窗口拉到最前。Windows 不让后台程序抢焦点（按手柄 HOME、点托盘图标时 Glint 都在后台），
 * 光 focus() 只会让任务栏按钮闪；先临时置顶再取消，至少能盖到最上面。校准时本来就置顶，别去动它
 */
function bringToFront(w: BrowserWindow): void {
  if (w.isMinimized()) w.restore()
  w.show()
  if (isWin && mode !== 'calibration') {
    w.setAlwaysOnTop(true)
    w.focus()
    w.setAlwaysOnTop(false)
  } else w.focus()
  inFront = true
}

// ---------- 校准模式：窗口铺满整块屏幕（盖住菜单栏和程序坞），校准点才能用屏幕坐标 ----------

function enterCalibration(): void {
  if (!win || mode === 'calibration') return
  savedBounds = win.getBounds()
  mode = 'calibration'
  win.setAlwaysOnTop(true, 'screen-saver')
  // Mac 用「简单全屏」（不另开一个桌面空间）；Windows 普通全屏就盖住任务栏
  if (isMac) win.setSimpleFullScreen(true)
  else win.setFullScreen(true)
  win.focus()
  setTimeout(pushBounds, 120)
}

function exitCalibration(): void {
  if (!win || mode !== 'calibration') return
  mode = 'normal'
  if (isMac) win.setSimpleFullScreen(false)
  else win.setFullScreen(false)
  win.setAlwaysOnTop(false)
  // Windows 退出全屏会自己回到原来的样子（包括最大化），再 setBounds 反而把最大化弄丢
  if (isMac && savedBounds) win.setBounds(savedBounds)
  savedBounds = null
  setTimeout(pushBounds, 120)
}

// ---------- IPC ----------

function registerIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:save', (_e, s: Settings) => saveSettings(s))
  ipcMain.handle('settings:jevPresets', () => JEV_PRESETS)
  ipcMain.handle('settings:listModels', (_e, p: Provider) => listModels(p))
  ipcMain.handle('settings:testProvider', (_e, p: Provider, model: string) => testProvider(p, model))

  ipcMain.on('llm:start', (_e, req: LlmRequest) => {
    startStream(req, (ch, payload) => send(ch, payload))
  })
  ipcMain.on('llm:abort', (_e, reqId: string) => abortStream(reqId))

  ipcMain.handle('jev:judge', (_e, state: string, questions: Record<string, JevQuestion>) => judge(state, questions))
  ipcMain.handle('jev:usage', () => jevUsage())

  ipcMain.handle('pty:create', (_e, opts: { cols: number; rows: number; cwd?: string }) => {
    const s = loadSettings()
    return createPty({ ...opts, shell: s.terminal.shell, cwd: opts.cwd || s.terminal.cwd, env: qwenCodeEnv(s) }, send)
  })
  ipcMain.on('pty:write', (_e, id: string, data: string) => writePty(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))

  ipcMain.on('bridge:send', (_e, cmd: Record<string, unknown>) => sendBridge(cmd))

  // 按住说话（Windows）：渲染进程采麦克风，主进程转给百炼实时识别；结果和 Mac 原生助手的一样走 bridge:event
  ipcMain.on('asr:start', (_e, target: string) => asrStart(target, (ev) => send('bridge:event', ev)))
  ipcMain.on('asr:audio', (_e, chunk: ArrayBuffer) => asrAudio(chunk))
  ipcMain.on('asr:stop', () => asrStop())

  ipcMain.handle('win:mode', (_e, next: 'normal' | 'calibration') => {
    if (next === 'calibration') enterCalibration()
    else exitCalibration()
    return mode
  })
  ipcMain.handle('win:bounds', () => {
    pushBounds()
    return true
  })
  ipcMain.on('win:toggleVisible', () => {
    if (!win) return
    const front = win.isFocused() || (isWin && inFront && !win.isMinimized())
    if (win.isVisible() && front) win.hide()
    else bringToFront(win)
  })
  ipcMain.on('win:focus', () => {
    if (win) bringToFront(win)
  })
  // Windows 右上角的系统按钮条不会跟着页面的弹窗蒙层变暗：白底压上 22% 的黑 ≈ #c7c7c7
  ipcMain.on('win:overlayDim', (_e, dim: boolean) => {
    if (!isWin || !win || win.isDestroyed()) return
    win.setTitleBarOverlay(dim ? { color: '#c7c7c7', symbolColor: '#3a3a3c' } : { color: '#ffffff', symbolColor: '#1d1d1f' })
  })
  ipcMain.on('tray:status', (_e, st: TrayStatus) => setTrayStatus(st))

  // iPhone 原深感：开关监听、配对、状态、显示器物理尺寸
  ipcMain.handle('td:enable', (_e, reason: 'source' | 'pairing', on: boolean) => tdEnable(reason, on))
  ipcMain.handle('td:pair', (_e, dev: string, code: string) => tdPair(dev, code))
  ipcMain.handle('td:unpair', (_e, dev: string) => tdUnpair(dev))
  ipcMain.handle('td:status', () => tdStatus())
  ipcMain.handle('td:display', () => displayInfo(win))

  ipcMain.handle('avatar:get', () => loadAvatar())
  ipcMain.handle('avatar:generate', (_e, photo: string) => generateAvatar(photo))
  ipcMain.handle('avatar:clear', () => clearAvatar())

  // 截主窗口里的一块（窗口坐标），给 Markdown / 终端 / 对话区的「截图问」用
  ipcMain.handle('win:capture', async (_e, rect: Rect) => {
    if (!win) return null
    const r = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(4, Math.round(rect.width)),
      height: Math.max(4, Math.round(rect.height))
    }
    const img = await win.webContents.capturePage(r)
    return img.isEmpty() ? null : img.toDataURL()
  })
  ipcMain.handle('perm:status', () => ({
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone')
  }))
  ipcMain.handle('perm:openSettings', async (_e, pane: 'camera' | 'microphone' | 'speech' | 'bluetooth') => {
    // Windows：直接跳「设置」里对应的页（隐私 → 相机 / 麦克风 / 语音，蓝牙和其他设备）
    if (isWin) {
      const page: Record<string, string> = {
        camera: 'ms-settings:privacy-webcam',
        microphone: 'ms-settings:privacy-microphone',
        speech: 'ms-settings:privacy-speech',
        bluetooth: 'ms-settings:bluetooth'
      }
      return shell.openExternal(page[pane])
    }
    // 蓝牙：新手引导里连 Joy-Con（macOS 13 起蓝牙设置页的标识是 com.apple.BluetoothSettings）
    if (pane === 'bluetooth') return shell.openExternal('x-apple.systempreferences:com.apple.BluetoothSettings')
    // 从没申请过的权限，系统设置列表里根本没有 Glint，得先弹系统授权框
    if ((pane === 'microphone' || pane === 'camera') && systemPreferences.getMediaAccessStatus(pane) === 'not-determined') {
      await systemPreferences.askForMediaAccess(pane).catch(() => false)
      return
    }
    const map: Record<string, string> = {
      camera: 'Privacy_Camera',
      microphone: 'Privacy_Microphone',
      speech: 'Privacy_SpeechRecognition'
    }
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${map[pane]}`)
  })

  ipcMain.handle('file:open', async () => {
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: '论文 / 笔记', extensions: ['pdf', 'md', 'markdown', 'txt'] }]
    })
    if (r.canceled || !r.filePaths[0]) return null
    return readForRenderer(r.filePaths[0])
  })
  ipcMain.handle('file:read', (_e, path: string) => readForRenderer(path))
  ipcMain.handle('file:saveText', async (_e, name: string, text: string) => {
    if (!win) return null
    const r = await dialog.showSaveDialog(win, { defaultPath: name })
    if (r.canceled || !r.filePath) return null
    writeFileSync(r.filePath, text, 'utf8')
    return r.filePath
  })
}

function readForRenderer(path: string): { name: string; path: string; kind: 'pdf' | 'md'; text?: string; data?: Uint8Array } {
  const ext = extname(path).toLowerCase()
  const name = basename(path)
  if (ext === '.pdf') return { name, path, kind: 'pdf', data: new Uint8Array(readFileSync(path)) }
  return { name, path, kind: 'md', text: readFileSync(path, 'utf8') }
}

// ---------- 启动 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) bringToFront(win)
  })

  app.whenReady().then(async () => {
    // Windows 上窗口自己画顶栏，不要默认菜单栏（它的 Ctrl+R 会把页面整个刷掉，终端也跟着没了）
    if (!isMac) Menu.setApplicationMenu(null)
    registerAppProtocol()
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)
    )
    registerIpc()
    // 原深感原始数据报（60 帧/秒）不直接给渲染进程，由 truedepth.ts 验签后以 td:frame 推送
    onBridge((e) => e.t !== 'td_pkt' && send('bridge:event', e))
    initTrueDepth(send)
    // 测试用：LOOKASK_NO_BRIDGE=1 不拉原生助手，免得和正在用的 LookAsk 抢手柄
    if (!process.env.LOOKASK_NO_BRIDGE) startBridge()
    createMainWindow()
    initTray({
      showWindow,
      toggleWindow: () => (win?.isVisible() ? win.hide() : showWindow()),
      windowVisible: () => !!win?.isVisible(),
      command: (c) => send('tray:command', c)
    })
    // 先把系统摄像头授权弹出来，渲染进程再开摄像头就不会卡住（假摄像头用不到真摄像头，不弹）；
    // 这个授权框只有 Mac 有，Windows 的相机权限在「设置 → 隐私和安全性」里统一管
    const fakeCam = !!(process.env.LOOKASK_FAKE_CAM || process.env.LOOKASK_FAKE_CAM_FILE)
    if (isMac && !fakeCam && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      systemPreferences.askForMediaAccess('camera').catch(() => undefined)
    }
    // Windows：显示器物理尺寸要起一次 PowerShell 查，先在后台查好，校准完要用时不用等
    if (isWin) setTimeout(prefetchMonitors, 3000)
  })

  app.on('activate', () => {
    if (!win) createMainWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    destroyTray()
    flushJev()
    killAllPty()
    stopBridge()
  })
}
