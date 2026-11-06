import { spawn, type ChildProcess } from 'child_process'
import type { GpuEvent } from '../shared/types'

// 本地翻译时采集显卡占用：nvidia-smi 常驻循环输出，一次一行，比反复起进程省资源（单次调用要 70~100 毫秒）。
// 没选 Windows 的「GPU Engine」计数器：实测一次要 2 秒，还抓不到 Ollama 的计算负载

const FIELDS = 'name,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu'
const INTERVAL_MS = 250

let proc: ChildProcess | null = null

/** "NVIDIA GeForce RTX 3050 Laptop GPU" → "RTX 3050" */
function shortName(name: string): string {
  return name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').replace(/\s+Laptop GPU$/i, '').trim()
}

/** 解析一行输出；驱动不支持的字段是 [N/A]，功耗和温度缺了不影响画曲线，占用缺了这行就不要 */
export function parseGpuLine(line: string): Extract<GpuEvent, { t: 'sample' }> | null {
  const p = line.split(',').map((x) => x.trim())
  if (p.length < 6) return null
  const num = (s: string): number => {
    const n = Number(s)
    return Number.isFinite(n) ? n : 0
  }
  const util = Number(p[1])
  if (!Number.isFinite(util)) return null
  return { t: 'sample', name: shortName(p[0]), util, memUsed: num(p[2]), memTotal: num(p[3]), power: num(p[4]), temp: num(p[5]) }
}

export function gpuWatch(on: boolean, emit: (e: GpuEvent) => void): void {
  if (!on) {
    proc?.kill()
    proc = null
    return
  }
  if (proc) return
  const child = spawn('nvidia-smi', [`--query-gpu=${FIELDS}`, '--format=csv,noheader,nounits', `-lms`, String(INTERVAL_MS)], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  proc = child
  let buf = ''
  let got = false
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const s = parseGpuLine(line)
      if (s) {
        got = true
        emit(s)
      }
    }
  })
  const ended = (): void => {
    if (proc !== child) return
    proc = null
    // 没有 N 卡或驱动异常：一个样本都没拿到，告诉界面别等了
    if (!got) emit({ t: 'unavailable' })
  }
  child.on('error', ended)
  child.on('exit', ended)
}
