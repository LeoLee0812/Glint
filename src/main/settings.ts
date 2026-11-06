import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Settings, Provider } from '../shared/types'
import { defaultShell, isMac, isWin } from './platform'
import { AVATAR_MODEL, LOCAL_MODEL, LOCAL_TRANSLATE_MODEL, baseSettings } from '../shared/defaults'

export { AVATAR_MODEL }

// 设置存在 ~/Library/Application Support/LookAsk/settings.json（Windows 是 %APPDATA%\LookAsk\settings.json；权限 600，只有本人可读）
// Key 只存本机，不进仓库

// 2026-09 起只用千问（云端百炼 + 本地 Ollama）：老设置里的中转站（OpenLux / 云雾）和其它几家内置服务商都删掉，
// 用到它们的地方换回千问；删之前连同 Key 备份到 removed-providers.json，Key 不会丢。自己添加的服务商不动
const RELAY = /openlux|yunwu/i
const RETIRED = ['deepseek', 'zhipu', 'kimi', 'anthropic']

function isRetired(p: Provider): boolean {
  return RETIRED.includes(p.id) || RELAY.test(p.id) || RELAY.test(p.baseUrl)
}

/** 删掉的服务商追加进 userData/removed-providers.json（权限 600） */
function backupRemoved(list: Provider[]): void {
  const p = join(dataDir(), 'removed-providers.json')
  let old: Provider[] = []
  try {
    old = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    /* 第一次备份 */
  }
  writeFileSync(p, JSON.stringify([...old, ...list], null, 2), 'utf8')
  chmodSync(p, 0o600)
}

/** Jev 模式已下线：老设置里的 Jev 配置（含 Key）追加进 userData/removed-jev.json（权限 600），不丢 Key */
function backupJev(j: unknown): void {
  const p = join(dataDir(), 'removed-jev.json')
  let old: unknown[] = []
  try {
    old = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    /* 第一次备份 */
  }
  writeFileSync(p, JSON.stringify([...old, j], null, 2), 'utf8')
  chmodSync(p, 0o600)
}

/** 老设置迁移：删不用的服务商、补上千问、补官网链接；返回有没有改动 */
function migrate(s: Settings, def: Settings): boolean {
  let changed = false
  const removed = s.providers.filter(isRetired)
  const kept = s.providers.filter((p) => !isRetired(p))
  if (removed.length) {
    backupRemoved(removed)
    changed = true
  }
  const qwen = def.providers.find((p) => p.id === 'qwen')!
  if (!kept.some((p) => p.id === 'qwen')) {
    kept.unshift({ ...qwen, models: [...qwen.models] })
    changed = true
  }
  for (const p of kept) {
    const d = def.providers.find((x) => x.id === p.id)
    if (d?.console && !p.console) {
      p.console = d.console
      changed = true
    }
  }
  // 本地 Ollama：老默认的 qwen2.5:7b 从来没装上过，换成配好的本地千问
  const local = kept.find((p) => p.id === 'ollama')
  const localDef = def.providers.find((p) => p.id === 'ollama')!
  if (local && local.models.join() === 'qwen2.5:7b') {
    Object.assign(local, { name: localDef.name, baseUrl: localDef.baseUrl, models: [...localDef.models], extraBody: localDef.extraBody })
    for (const k of ['chatModel', 'fastModel', 'visionModel'] as const) {
      if (s[k].providerId === 'ollama') s[k] = { providerId: 'ollama', model: LOCAL_MODEL }
    }
    changed = true
  }
  s.providers = kept
  if (isWin && useLocalTranslate(s)) changed = true
  const alive = (id: string) => kept.some((p) => p.id === id)
  for (const k of ['chatModel', 'fastModel', 'visionModel'] as const) {
    if (!alive(s[k].providerId)) {
      s[k] = { ...def[k] }
      changed = true
    }
  }
  const av = s.avatar as Settings['avatar'] & { quality?: unknown }
  if (!alive(av.providerId) || !/^(qwen-image|wan)/.test(av.model)) {
    s.avatar = { providerId: 'qwen', model: AVATAR_MODEL, show: av.show }
    changed = true
  } else if ('quality' in av) {
    // 画质档是 gpt-image 的参数，百炼用不到
    delete av.quality
    changed = true
  }
  return changed
}

/** Windows 翻译默认走本地模型；只切还是默认云端模型的，本地没开时 chatStore 会退回云端 */
function useLocalTranslate(s: Settings): boolean {
  const local = s.providers.find((p) => p.id === 'ollama')
  if (!local) return false
  let changed = false
  // 老版本的本地翻译模型换成千问：翻译原来选的是它就直接跟过来
  const old = local.models.indexOf('hy-mt:1.8b')
  if (old >= 0) {
    local.models.splice(old, 1)
    changed = true
  }
  if (s.fastModel.model === 'hy-mt:1.8b') {
    s.fastModel = { providerId: 'ollama', model: LOCAL_TRANSLATE_MODEL }
    changed = true
  }
  if (!local.models.includes(LOCAL_TRANSLATE_MODEL)) {
    local.models.push(LOCAL_TRANSLATE_MODEL)
    if (s.fastModel.providerId === 'qwen' && s.fastModel.model === 'qwen3.8-flash') s.fastModel = { providerId: 'ollama', model: LOCAL_TRANSLATE_MODEL }
    changed = true
  }
  return changed
}

export function defaultSettings(): Settings {
  const s = baseSettings({ cwd: homedir(), shell: defaultShell() })
  if (isWin) useLocalTranslate(s)
  return s
}

function dataDir(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function settingsPath(): string {
  return join(dataDir(), 'settings.json')
}

let cache: Settings | null = null

/** 读设置：和默认值做浅合并，新版本加的字段自动补上，已有 Key 不动 */
export function loadSettings(): Settings {
  if (cache) return cache
  const def = defaultSettings()
  let s: Settings = def
  const p = settingsPath()
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Settings> & { jev?: unknown; jevMode?: unknown }
      const hadJev = 'jev' in raw || 'jevMode' in raw
      if (raw.jev) backupJev(raw.jev)
      delete raw.jev
      delete raw.jevMode
      s = {
        ...def,
        ...raw,
        avatar: { ...def.avatar, ...(raw.avatar || {}) },
        gaze: { ...def.gaze, ...(raw.gaze || {}) },
        terminal: { ...def.terminal, ...(raw.terminal || {}) },
        providers: raw.providers?.length ? raw.providers : def.providers
      }
      if (migrate(s, def) || hadJev) saveSettings(s)
    } catch (e) {
      console.error('[settings] 读取失败，用默认值', e)
    }
  }
  // iPhone 原深感只有 Mac 版有（手机把数据发给 Mac 上的原生助手）；从 Mac 拷过来的设置在别的平台上一律当摄像头（Glint Eye 是 USB 摄像头，两边都能用）
  if (!isMac && s.gaze.source === 'truedepth') s.gaze = { ...s.gaze, source: 'webcam' }
  cache = s
  return s
}

export function saveSettings(next: Settings): Settings {
  cache = next
  const p = settingsPath()
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8')
  try {
    chmodSync(p, 0o600)
  } catch {
    /* 忽略 */
  }
  return next
}

export function getProvider(id: string): Provider | undefined {
  return loadSettings().providers.find((p) => p.id === id)
}
