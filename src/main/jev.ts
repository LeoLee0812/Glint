import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JevQuestion, JevResult, JevUsage } from '../shared/types'
import { loadSettings } from './settings'
import { jevEndpoint, jevKey, jevMissing } from '../shared/jev'

// Jev 判断引擎客户端：只判断不写字（choice / score / noul），默认走阿里云百炼的决策模型 decision-model-preview
// 这里做三件事：命中缓存不重复请求、按天记账、超过每日上限直接拒绝

const CACHE_MAX = 800

let cache: Map<string, { answers: JevResult['answers']; model?: string; inputTokens: number }> | null = null
let usage: JevUsage | null = null
let saveTimer: NodeJS.Timeout | null = null

function file(name: string): string {
  return join(app.getPath('userData'), name)
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadState(): void {
  if (!cache) {
    cache = new Map()
    try {
      const raw = JSON.parse(readFileSync(file('jev-cache.json'), 'utf8')) as Array<[string, any]>
      for (const [k, v] of raw) cache.set(k, v)
    } catch {
      /* 首次运行没有缓存 */
    }
  }
  if (!usage) {
    try {
      usage = JSON.parse(readFileSync(file('jev-usage.json'), 'utf8'))
    } catch {
      usage = { day: today(), inputTokens: 0, calls: 0, cacheHits: 0, totalTokens: 0 }
    }
  }
  if (usage!.day !== today()) {
    usage = { day: today(), inputTokens: 0, calls: 0, cacheHits: 0, totalTokens: usage!.totalTokens }
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      writeFileSync(file('jev-cache.json'), JSON.stringify([...cache!.entries()]))
      writeFileSync(file('jev-usage.json'), JSON.stringify(usage))
    } catch (e) {
      console.error('[jev] 保存缓存失败', e)
    }
  }, 1500)
}

export function jevUsage(): JevUsage {
  loadState()
  return { ...usage! }
}

export async function judge(state: string, questions: Record<string, JevQuestion>): Promise<JevResult> {
  loadState()
  const t0 = Date.now()
  const s = loadSettings()
  const cfg = s.jev
  const missing = jevMissing(s)
  if (missing) return { ok: false, answers: {}, inputTokens: 0, cached: false, ms: 0, error: missing }

  // state 上限 32k token（百炼是 64k），这里按字符粗截断，留足余量
  const st = state.length > 12000 ? state.slice(0, 12000) : state
  const key = createHash('sha1').update(cfg.model).update('\u0000').update(st).update('\u0000').update(JSON.stringify(questions)).digest('hex')
  const hit = cache!.get(key)
  if (hit) {
    cache!.delete(key)
    cache!.set(key, hit)
    usage!.cacheHits++
    scheduleSave()
    return { ok: true, answers: hit.answers, model: hit.model, inputTokens: 0, cached: true, ms: Date.now() - t0 }
  }
  if (usage!.inputTokens >= cfg.dailyTokenCap) {
    return { ok: false, answers: {}, inputTokens: 0, cached: false, ms: 0, error: '今天的 Jev 额度用完了，明天恢复。急用可以去设置里调高' }
  }

  const body = JSON.stringify({ state: st, model: cfg.model, questions })
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await net.fetch(jevEndpoint(s), {
        method: 'POST',
        headers: { authorization: `Bearer ${jevKey(s)}`, 'content-type': 'application/json' },
        body
      })
      const j: any = await res.json().catch(() => ({}))
      if (res.status === 429 || res.status === 529) {
        lastErr = `判断服务太忙（HTTP ${res.status}），等会儿再试`
        await new Promise((r) => setTimeout(r, 1500))
        continue
      }
      if (!res.ok) return { ok: false, answers: {}, inputTokens: 0, cached: false, ms: Date.now() - t0, error: `HTTP ${res.status}：${JSON.stringify(j).slice(0, 300)}` }
      const inputTokens = Number(j.usage?.input_tokens || 0)
      usage!.inputTokens += inputTokens
      usage!.totalTokens += inputTokens
      usage!.calls++
      cache!.set(key, { answers: j.answers || {}, model: j.model, inputTokens })
      while (cache!.size > CACHE_MAX) cache!.delete(cache!.keys().next().value as string)
      scheduleSave()
      return { ok: true, answers: j.answers || {}, model: j.model, inputTokens, cached: false, ms: Date.now() - t0 }
    } catch (e: any) {
      lastErr = e?.message || String(e)
    }
  }
  return { ok: false, answers: {}, inputTokens: 0, cached: false, ms: Date.now() - t0, error: lastErr }
}

export function flushJev(): void {
  if (!cache || !usage) return
  try {
    writeFileSync(file('jev-cache.json'), JSON.stringify([...cache.entries()]))
    writeFileSync(file('jev-usage.json'), JSON.stringify(usage))
  } catch {
    /* 退出时尽力而为 */
  }
}

export function jevCacheExists(): boolean {
  return existsSync(file('jev-cache.json'))
}
