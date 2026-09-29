import * as pty from 'node-pty'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

// 左侧终端：node-pty 起一个登录 shell（会读 ~/.zprofile ~/.zshrc，所以 qwen / agent 命令都能找到）；
// Qwen Code 要的百炼 Key 和默认设置由 qwenCode.ts 准备好，经 opts.env 带进来

type Send = (channel: string, payload: unknown) => void

interface Session {
  proc: pty.IPty
}

const sessions = new Map<string, Session>()
let seq = 1

export function createPty(
  opts: { cols: number; rows: number; cwd?: string; shell?: string; env?: Record<string, string> },
  send: Send
): string {
  const id = `pty${seq++}`
  const shell = opts.shell && existsSync(opts.shell) ? opts.shell : process.env.SHELL || '/bin/zsh'
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    // npm / Electron 自己注入的变量不要带进用户的 shell（会让 nvm 等工具报错）
    if (typeof v !== 'string' || /^(npm_|ELECTRON_|VITE_)/i.test(k) || k === 'INIT_CWD') continue
    env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'Glint'
  if (!env.LANG) env.LANG = 'zh_CN.UTF-8'
  // 从 Finder 双击启动时 PATH 很短，补上 Homebrew 常见路径兜底
  env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(':')
  Object.assign(env, opts.env)
  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols),
    rows: Math.max(5, opts.rows),
    cwd,
    env
  })
  sessions.set(id, { proc })
  proc.onData((data) => send('pty:data', { id, data }))
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    send('pty:exit', { id, code: exitCode })
  })
  return id
}

export function writePty(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resizePty(id: string, cols: number, rows: number): void {
  try {
    sessions.get(id)?.proc.resize(Math.max(20, cols), Math.max(5, rows))
  } catch {
    /* 进程已退出 */
  }
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    /* 已退出 */
  }
  sessions.delete(id)
}

export function killAllPty(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
