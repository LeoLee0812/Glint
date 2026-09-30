import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'

// Mac / Windows 两个平台在主进程里的差别集中放这儿：默认 shell、shell 启动参数

export const isMac = process.platform === 'darwin'
export const isWin = process.platform === 'win32'

/** 在 PATH 里找一个可执行文件，找不到返回 null */
function onPath(exe: string): string | null {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, exe)
    if (existsSync(p)) return p
  }
  return null
}

/** 左侧终端默认用的 shell：Mac 是登录 shell（一般是 zsh）；Windows 优先 PowerShell 7，没装就用系统自带的 Windows PowerShell */
export function defaultShell(): string {
  if (!isWin) return process.env.SHELL || '/bin/zsh'
  const pwsh = onPath('pwsh.exe') || join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(pwsh)) return pwsh
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * shell 的启动参数：Mac 上 -l 当登录 shell（会读 ~/.zprofile，qwen / agent 命令才找得到）；
 * Windows 的 PowerShell 用 -ExecutionPolicy Bypass：Windows PowerShell 5.1 默认禁止跑脚本，
 * npm 全局装的 qwen 是个 qwen.ps1，不放开就报「禁止运行脚本」
 */
export function shellArgs(shell: string): string[] {
  const name = basename(shell).toLowerCase()
  if (!isWin) return ['-l']
  if (name === 'pwsh.exe' || name === 'powershell.exe') return ['-NoLogo', '-ExecutionPolicy', 'Bypass']
  if (name === 'bash.exe') return ['-l']
  return []
}
