import { createInterface } from 'node:readline'

// 与 Electron 主进程通信：stdout 每行一条 JSON 事件，stdin 每行一条 JSON 命令（和 Mac 版 Swift 助手 IO.swift 同一套协议）

export type Cmd = { cmd?: string; id?: number; [k: string]: unknown }

/** 输出一条事件：一条一整行，Node 单线程不会交错 */
export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

export function logMsg(msg: string): void {
  emit({ t: 'log', msg })
}

/** 逐行读 stdin 交给 handler；stdin 关闭说明父进程已退出，先收尾（关手柄的灯）再跟着退出，避免残留孤儿进程 */
export function startCommandReader(handler: (cmd: Cmd) => void, beforeExit: () => Promise<void>): void {
  // 父进程突然没了，写 stdout 会报 EPIPE：直接退
  process.stdout.on('error', () => process.exit(0))
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      return
    }
    if (obj && typeof obj === 'object') handler(obj as Cmd)
  })
  rl.on('close', () => {
    beforeExit().finally(() => process.exit(0))
  })
}
