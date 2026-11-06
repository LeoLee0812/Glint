import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AsrAudio, AsrEmit } from '../shared/asrCore'
import { isWin } from './platform'

// Windows 的本地语音识别：SenseVoice Small 放在子进程里跑（native/win/asrWorker.ts）。
// 模型在 userData/models/sensevoice，有模型才用本地，没有就还走云端；松手后一次识别整段，所以没有边说边出字

const FINAL_WAIT_MS = 15000

function modelDir(): string {
  return join(app.getPath('userData'), 'models', 'sensevoice')
}

function workerPath(): string {
  const packed = join(process.resourcesPath || '', 'bin', 'lookask-asr.cjs')
  return app.isPackaged && existsSync(packed) ? packed : join(app.getAppPath(), 'native', 'bin', 'lookask-asr.cjs')
}

interface Pending {
  emit: AsrEmit
  target: string
  timer: ReturnType<typeof setTimeout>
}

let worker: ChildProcessWithoutNullStreams | null = null
let broken = false
let nextId = 1
const pending = new Map<number, Pending>()
let cur: { target: string; emit: AsrEmit; chunks: Buffer[] } | null = null

function settle(id: number, text: string | null, error?: string): void {
  const p = pending.get(id)
  if (!p) return
  pending.delete(id)
  clearTimeout(p.timer)
  if (error) p.emit({ t: 'asr', state: 'error', error: `local: ${error}`, target: p.target })
  else p.emit({ t: 'asr', state: 'final', text: text || '', target: p.target })
}

function ensureWorker(): void {
  if (worker || broken) return
  const bin = workerPath()
  const proc = spawn(process.execPath, [bin, modelDir()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', Path: `${join(dirname(bin), 'sherpa-onnx-win-x64')};${process.env.Path || ''}` },
    windowsHide: true
  })
  worker = proc
  createInterface({ input: proc.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line) as { id?: number; text?: string; error?: string; fatal?: string }
      if (m.fatal) {
        // 模型或原生模块加载不了：这次运行不再试，改走云端
        console.error('[asr] 本地识别起不来', m.fatal)
        broken = true
      } else if (m.id) settle(m.id, m.text ?? '', m.error)
    } catch {
      /* 不是协议输出，忽略 */
    }
  })
  proc.stderr.on('data', (d) => console.warn('[asr]', String(d).slice(0, 300)))
  proc.on('error', () => {
    broken = true
  })
  proc.on('exit', () => {
    worker = null
    for (const id of [...pending.keys()]) settle(id, null, 'worker_exit')
  })
}

/** 这次按下要不要走本地 */
export function localAsrAvailable(): boolean {
  return isWin && !broken && existsSync(join(modelDir(), 'model.int8.onnx')) && existsSync(join(modelDir(), 'tokens.txt')) && existsSync(workerPath())
}

export function localStart(target: string, emit: AsrEmit): void {
  ensureWorker()
  cur = { target, emit, chunks: [] }
  emit({ t: 'asr', state: 'listening', target })
}

/** 当前这句是不是本地在收，主进程按这个分流音频和松手 */
export function localActive(): boolean {
  return cur !== null
}

export function localAudio(chunk: AsrAudio): void {
  if (!cur) return
  cur.chunks.push(chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
}

export function localStop(): void {
  if (!cur) return
  const { target, emit, chunks } = cur
  cur = null
  if (!chunks.length) {
    emit({ t: 'asr', state: 'final', text: '', target })
    return
  }
  if (!worker?.stdin.writable) {
    emit({ t: 'asr', state: 'error', error: 'local: worker_unavailable', target })
    return
  }
  const id = nextId++
  pending.set(id, { emit, target, timer: setTimeout(() => settle(id, null, 'timeout'), FINAL_WAIT_MS) })
  worker.stdin.write(JSON.stringify({ id, pcm: Buffer.concat(chunks).toString('base64') }) + '\n')
}

// 启动几秒后先把模型载入，第一次说话不用等
if (isWin) {
  setTimeout(() => {
    if (localAsrAvailable()) ensureWorker()
  }, 5000)
}
