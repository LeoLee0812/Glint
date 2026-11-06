import { BrowserWindow, screen } from 'electron'
import { ISLAND_MS, islandCss, islandHtml } from '../shared/island'
import { isMac } from './platform'

// 顶部弹窗的窗口：透明、置顶、不抢焦点、点击穿透，显示完自己关。样式在 shared/island.ts

const W = 440
let cur: BrowserWindow | null = null
let timer: ReturnType<typeof setTimeout> | null = null

function closeCurrent(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (cur && !cur.isDestroyed()) cur.destroy()
  cur = null
}

export function showIsland(text: string, on: boolean, near: BrowserWindow | null): void {
  closeCurrent()
  const d = near && !near.isDestroyed() ? screen.getDisplayMatching(near.getBounds()) : screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: Math.round(d.bounds.x + d.bounds.width / 2 - W / 2),
    // 工作区顶边：Mac 是菜单栏（刘海）下面，Windows 是屏幕顶边
    y: d.workArea.y,
    width: W,
    height: 140,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    roundedCorners: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    ...(isMac ? { type: 'panel' as const } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  cur = win
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}${islandCss()}</style>${islandHtml(text, on)}`
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.showInactive()
    timer = setTimeout(closeCurrent, ISLAND_MS)
  })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}
