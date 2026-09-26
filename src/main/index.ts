import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  type Rectangle
} from 'electron'
import { join, basename, extname, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { LlmRequest, OverlayState, Provider, Settings, JevQuestion, Rect } from '../shared/types'
import { loadSettings, saveSettings, JEV_PRESETS } from './settings'
import { startStream, abortStream, listModels, testProvider } from './llm'
import { judge, jevUsage, flushJev } from './jev'
import { startBridge, stopBridge, onBridge, sendBridge, requestBridge } from './bridge'
import { createPty, writePty, resizePty, killPty, killAllPty } from './pty'

app.setName('LookAsk')

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
let overlay: BrowserWindow | null = null
let savedBounds: Rectangle | null = null
let mode: 'normal' | 'calibration' | 'global' = 'normal'

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

// 开发模式：开远程调试端口（方便自动化测试），渲染进程日志转到终端
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', process.env.LOOKASK_DEBUG_PORT || '9333')

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

function loadRenderer(w: BrowserWindow, page: 'index' | 'overlay'): void {
  if (isDev) w.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
  else w.loadURL(`lookask://app/${page}.html`)
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
    title: 'LookAsk',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#0e1014',
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
    win?.show()
    pushBounds()
  })
  for (const ev of ['move', 'resize', 'moved', 'enter-full-screen', 'leave-full-screen', 'show'] as const) {
    win.on(ev as any, pushBounds)
  }
  win.on('closed', () => {
    win = null
    overlay?.destroy()
    overlay = null
  })
  if (isDev) {
    win.webContents.on('console-message', (e: any) => {
      if (e?.message) console.log(`[renderer:${e.level}]`, e.message)
    })
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(win, 'index')
}

// ---------- 校准模式：窗口铺满整块屏幕（盖住菜单栏和程序坞），校准点才能用屏幕坐标 ----------

function enterCalibration(): void {
  if (!win || mode === 'calibration') return
  if (mode === 'global') exitGlobal()
  savedBounds = win.getBounds()
  mode = 'calibration'
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setSimpleFullScreen(true)
  win.focus()
  setTimeout(pushBounds, 120)
}

function exitCalibration(): void {
  if (!win || mode !== 'calibration') return
  mode = 'normal'
  win.setSimpleFullScreen(false)
  win.setAlwaysOnTop(false)
  if (savedBounds) win.setBounds(savedBounds)
  savedBounds = null
  setTimeout(pushBounds, 120)
}

// ---------- 全局模式：主窗口缩成右侧边栏，透明浮层画视线，左边可以是任何 App ----------

function enterGlobal(): void {
  if (!win || mode === 'global') return
  if (mode === 'calibration') exitCalibration()
  savedBounds = win.getBounds()
  mode = 'global'
  const d = screen.getDisplayMatching(win.getBounds())
  const wa = d.workArea
  const width = Math.min(480, Math.round(wa.width * 0.34))
  win.setBounds({ x: wa.x + wa.width - width, y: wa.y, width, height: wa.height })
  win.setAlwaysOnTop(true, 'floating')

  overlay = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    focusable: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  overlay.setIgnoreMouseEvents(true)
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 不开内容保护：演示录屏时要能录到视线圈；截图给 OCR 前会先临时藏起浮层
  loadRenderer(overlay, 'overlay')
  overlay.once('ready-to-show', () => overlay?.showInactive())
  setTimeout(pushBounds, 150)
}

function exitGlobal(): void {
  if (!win || mode !== 'global') return
  mode = 'normal'
  overlay?.destroy()
  overlay = null
  win.setAlwaysOnTop(false)
  if (savedBounds) win.setBounds(savedBounds)
  savedBounds = null
  setTimeout(pushBounds, 150)
}

// ---------- 截屏：全局模式下取视线处画面，给 OCR 和视觉模型 ----------

async function captureScreenRect(rect: Rect): Promise<{ dataUrl: string; path: string } | { error: string }> {
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'granted') {
    return { error: 'screen_permission' }
  }
  const d = screen.getDisplayMatching({ x: Math.round(rect.x), y: Math.round(rect.y), width: 2, height: 2 })
  const sf = d.scaleFactor
  // 截图前先把视线圈和焦点框藏一帧，别被 OCR 和视觉模型看到
  const ov = overlay && !overlay.isDestroyed() ? overlay : null
  if (ov) {
    ov.webContents.send('overlay:vis', false)
    await new Promise((r) => setTimeout(r, 70))
  }
  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.bounds.width * sf), height: Math.round(d.bounds.height * sf) }
    })
  } finally {
    if (ov && !ov.isDestroyed()) ov.webContents.send('overlay:vis', true)
  }
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0]
  if (!src) return { error: 'no_source' }
  const img = src.thumbnail
  const size = img.getSize()
  const kx = size.width / d.bounds.width
  const ky = size.height / d.bounds.height
  const crop = {
    x: Math.max(0, Math.round((rect.x - d.bounds.x) * kx)),
    y: Math.max(0, Math.round((rect.y - d.bounds.y) * ky)),
    width: Math.round(rect.width * kx),
    height: Math.round(rect.height * ky)
  }
  crop.width = Math.max(8, Math.min(crop.width, size.width - crop.x))
  crop.height = Math.max(8, Math.min(crop.height, size.height - crop.y))
  const cut = img.crop(crop)
  const png = cut.toPNG()
  const dir = join(tmpdir(), 'lookask')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `cap-${Date.now()}.png`)
  writeFileSync(path, png)
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, path }
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

  ipcMain.handle('pty:create', (_e, opts: { cols: number; rows: number; cwd?: string }) =>
    createPty({ ...opts, shell: loadSettings().terminal.shell, cwd: opts.cwd || loadSettings().terminal.cwd }, send)
  )
  ipcMain.on('pty:write', (_e, id: string, data: string) => writePty(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => resizePty(id, cols, rows))
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))

  ipcMain.on('bridge:send', (_e, cmd: Record<string, unknown>) => sendBridge(cmd))
  ipcMain.handle('bridge:ocr', (_e, path: string, fast?: boolean) => requestBridge({ cmd: 'ocr', path, fast: !!fast }, 10000))
  ipcMain.handle('bridge:ax', (_e, x: number, y: number) => requestBridge({ cmd: 'ax_at', x, y }, 3000))
  ipcMain.handle('bridge:axPrompt', () => requestBridge({ cmd: 'ax_prompt' }, 3000))

  ipcMain.handle('win:mode', (_e, next: 'normal' | 'calibration' | 'global') => {
    if (next === 'calibration') enterCalibration()
    else if (next === 'global') enterGlobal()
    else if (mode === 'calibration') exitCalibration()
    else if (mode === 'global') exitGlobal()
    return mode
  })
  ipcMain.handle('win:bounds', () => {
    pushBounds()
    return true
  })
  ipcMain.on('win:toggleVisible', () => {
    if (!win) return
    if (win.isVisible() && win.isFocused()) win.hide()
    else {
      win.show()
      win.focus()
    }
  })
  ipcMain.on('win:focus', () => {
    win?.show()
    win?.focus()
  })
  ipcMain.on('overlay:update', (_e, s: OverlayState) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:state', s)
  })

  ipcMain.handle('screen:capture', (_e, rect: Rect) => captureScreenRect(rect))
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
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  }))
  ipcMain.handle('perm:openSettings', (_e, pane: 'screen' | 'accessibility' | 'camera' | 'microphone' | 'speech') => {
    const map: Record<string, string> = {
      screen: 'Privacy_ScreenCapture',
      accessibility: 'Privacy_Accessibility',
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
    win?.show()
    win?.focus()
  })

  app.whenReady().then(async () => {
    registerAppProtocol()
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      ['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(permission)
    )
    registerIpc()
    onBridge((e) => send('bridge:event', e))
    startBridge()
    createMainWindow()
    // 先把系统摄像头授权弹出来，渲染进程再开摄像头就不会卡住
    if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
      systemPreferences.askForMediaAccess('camera').catch(() => undefined)
    }
  })

  app.on('activate', () => {
    if (!win) createMainWindow()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    flushJev()
    killAllPty()
    stopBridge()
  })
}
