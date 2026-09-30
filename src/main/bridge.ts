import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BridgeEvent } from '../shared/types'

// 拉起原生助手，按行收发 JSON；挂了自动重启（退避到最多 10 秒）
// - Mac：Swift 编的二进制 lookask-bridge（Joy-Con / 语音 / 原深感）
// - Windows：native/win 用 esbuild 打成的 lookask-bridge.cjs（只管 Joy-Con），用 Electron 自带的 Node 跑（ELECTRON_RUN_AS_NODE）

type Listener = (e: BridgeEvent) => void

let child: ChildProcessWithoutNullStreams | null = null
let listeners: Listener[] = []
let restartDelay = 500
let stopping = false
let nextId = 1
const pending = new Map<number, (e: any) => void>()

function binaryPath(): string {
  // 打包后在 Resources/bin 下；开发时在 native/bin 下
  const name = process.platform === 'win32' ? 'lookask-bridge.cjs' : 'lookask-bridge'
  const packed = join(process.resourcesPath || '', 'bin', name)
  if (app.isPackaged && existsSync(packed)) return packed
  return join(app.getAppPath(), 'native', 'bin', name)
}

/** 怎么拉起助手：Windows 上是个脚本，交给 Electron 自带的 Node 跑 */
function spawnBridge(bin: string): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') return spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  return spawn(process.execPath, [bin], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true
  })
}

export function onBridge(fn: Listener): void {
  listeners.push(fn)
}

function dispatch(e: BridgeEvent): void {
  const id = (e as any).id
  if (
    typeof id === 'number' &&
    pending.has(id) &&
    (e.t === 'display_mm' || (e as any).t === 'pong')
  ) {
    pending.get(id)!(e)
    pending.delete(id)
  }
  for (const l of listeners) l(e)
}

export function startBridge(): void {
  const bin = binaryPath()
  if (!existsSync(bin)) {
    console.warn('[bridge] 找不到原生助手，先跑 npm run build:native：', bin)
    dispatch({ t: 'log', msg: `找不到原生助手 ${bin}` })
    return
  }
  stopping = false
  child = spawnBridge(bin)
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buf += chunk
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as BridgeEvent
        if (e.t === 'ready') restartDelay = 500
        dispatch(e)
      } catch {
        console.log('[bridge]', line)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => console.warn('[bridge:stderr]', d.trim()))
  child.on('exit', (code) => {
    child = null
    dispatch({ t: 'bridge_exit', code })
    for (const [id, cb] of pending) cb({ t: 'error', id, error: 'bridge_exit' })
    pending.clear()
    if (!stopping) {
      setTimeout(startBridge, restartDelay)
      restartDelay = Math.min(restartDelay * 2, 10000)
    }
  })
}

export function stopBridge(): void {
  stopping = true
  if (child) {
    try {
      child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n')
    } catch {
      /* 已经退了 */
    }
    setTimeout(() => child?.kill(), 300)
  }
}

export function sendBridge(cmd: Record<string, unknown>): void {
  if (!child) return
  try {
    child.stdin.write(JSON.stringify(cmd) + '\n')
  } catch (e) {
    console.warn('[bridge] 写命令失败', e)
  }
}

/** 发命令并等对应 id 的回包（如 display_mm），超时返回 null */
export function requestBridge<T = any>(cmd: Record<string, unknown>, timeoutMs = 8000): Promise<T | null> {
  return new Promise((resolve) => {
    if (!child) return resolve(null)
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeoutMs)
    pending.set(id, (e) => {
      clearTimeout(timer)
      resolve(e as T)
    })
    sendBridge({ ...cmd, id })
  })
}
