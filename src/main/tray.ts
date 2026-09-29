import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { TrayCommand, TrayStatus } from '../shared/types'

// macOS 菜单栏小图标：一眼看到眼动 / 校准 / 手柄状态，常用操作不用切回窗口
// 图标是 template 图（resources/tray，scripts/make-tray-icon.py 生成），系统按菜单栏深浅自动反色

let tray: Tray | null = null
let status: TrayStatus | null = null
let deps: { showWindow: () => void; toggleWindow: () => void; windowVisible: () => boolean; command: (c: TrayCommand) => void } | null = null

function iconDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'tray') : join(app.getAppPath(), 'resources/tray')
}

function icon(on: boolean) {
  const img = nativeImage.createFromPath(join(iconDir(), on ? 'trayTemplate.png' : 'trayOffTemplate.png'))
  img.setTemplateImage(true)
  return img
}

function gazeLine(s: TrayStatus): string {
  const src = s.source === 'truedepth' ? 'iPhone 原深感' : '摄像头'
  if (s.gaze === 'running') return `眼动：${src} · ${s.face ? '追踪中' : '看不到脸'}`
  if (s.gaze === 'loading') return `眼动：${src} · 启动中…`
  if (s.gaze === 'error') return `眼动：${src} · 出错了`
  return `眼动：${src} · 已关闭`
}

function calLine(s: TrayStatus): string {
  if (!s.calibrated) return '校准：还没校准'
  return s.cvErrorPx != null ? `校准：误差约 ${Math.round(s.cvErrorPx)} 点` : '校准：已校准'
}

function joyLine(s: TrayStatus): string {
  // 放在桌上时震动先停（硬桌面一震嗡嗡响），拿起来就恢复
  const mark = (on: boolean, rest: boolean) => (on ? (rest ? '已连（放下）' : '已连') : '未连')
  return `手柄：左 ${mark(s.joyL, s.joyRestL)} · 右 ${mark(s.joyR, s.joyRestR)}`
}

function rebuild(): void {
  if (!tray || !deps) return
  const d = deps
  const s = status
  // 这几项要在窗口里操作，先把窗口拉出来
  const run = (c: TrayCommand, needWindow = true) => () => {
    if (needWindow) d.showWindow()
    d.command(c)
  }
  const running = s?.gaze === 'running' || s?.gaze === 'loading'
  const items: MenuItemConstructorOptions[] = [
    ...(s
      ? [
          { label: gazeLine(s), enabled: false },
          { label: calLine(s), enabled: false },
          { label: joyLine(s), enabled: false }
        ]
      : [{ label: '启动中…', enabled: false }]),
    { type: 'separator' },
    { label: d.windowVisible() ? '隐藏 Glint 窗口' : '显示 Glint 窗口', click: () => d.toggleWindow() },
    { type: 'separator' },
    { label: running ? '暂停眼动追踪' : '开启眼动追踪', enabled: !!s, click: run({ cmd: 'gaze:toggle' }, false) },
    {
      label: '眼动输入源',
      enabled: !!s,
      submenu: [
        { label: 'Mac 摄像头', type: 'radio', checked: s?.source !== 'truedepth', click: run({ cmd: 'gaze:source', source: 'webcam' }, false) },
        { label: 'iPhone 原深感', type: 'radio', checked: s?.source === 'truedepth', click: run({ cmd: 'gaze:source', source: 'truedepth' }, false) }
      ]
    },
    { label: '校准…', enabled: !!s, click: run({ cmd: 'calibrate' }) },
    { label: '测精度…', enabled: !!s?.calibrated, click: run({ cmd: 'validate' }) },
    { type: 'separator' },
    {
      label: '视线跟随',
      enabled: !!s,
      submenu: [
        { label: '左侧内容（−）', type: 'radio', checked: s?.side !== 'right', click: run({ cmd: 'side', side: 'left' }, false) },
        { label: '右侧 AI 回答（+）', type: 'radio', checked: s?.side === 'right', click: run({ cmd: 'side', side: 'right' }, false) }
      ]
    },
    { label: 'Jev 模式', type: 'checkbox', checked: !!s?.jev, enabled: !!s, click: run({ cmd: 'jev' }, false) },
    // 两只手柄「哔哔」响几秒、灯一起闪，放在桌上也响
    { label: '找手柄', enabled: !!s && (s.joyL || s.joyR), click: run({ cmd: 'joy:find' }, false) },
    { type: 'separator' },
    { label: '打开 PDF / Markdown…', enabled: !!s, click: run({ cmd: 'open' }) },
    { label: '新建终端', enabled: !!s, click: run({ cmd: 'terminal' }) },
    { type: 'separator' },
    { label: '按键说明', enabled: !!s, click: run({ cmd: 'help' }) },
    { label: '设置…', enabled: !!s, click: run({ cmd: 'settings' }) },
    { type: 'separator' },
    { label: '退出 Glint', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
  tray.setImage(icon(!!s && s.gaze === 'running'))
  tray.setToolTip(s ? `Glint 瞳问\n${gazeLine(s)}\n${calLine(s)}` : 'Glint 瞳问')
}

export function initTray(d: NonNullable<typeof deps>): void {
  deps = d
  tray = new Tray(icon(false))
  rebuild()
}

export function setTrayStatus(s: TrayStatus): void {
  status = s
  rebuild()
}

/** 窗口显示 / 隐藏后刷新「显示 / 隐藏窗口」那一项的字 */
export function refreshTray(): void {
  rebuild()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
