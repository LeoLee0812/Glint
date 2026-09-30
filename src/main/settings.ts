import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Settings, Provider } from '../shared/types'
import { defaultShell, isMac } from './platform'

// 设置存在 ~/Library/Application Support/LookAsk/settings.json（Windows 是 %APPDATA%\LookAsk\settings.json；权限 600，只有本人可读）
// Key 只存本机，不进仓库

/** 终端里的编程智能体从 Qwen Code 换成了 Qwen Code，老设置里存的默认提示词这一句跟着换（migrate） */
const OLD_AGENT_LINE = '- 如果焦点内容来自终端里的 Qwen Code，把它当作编程协作场景来解释'
const AGENT_LINE = '- 如果焦点内容来自终端里的 Qwen Code（或别的编程智能体），把它当作编程协作场景来解释'

const DEFAULT_SYSTEM_PROMPT = `你是 Glint 瞳问的阅读副驾。用户用眼动追踪 + Joy-Con 手柄指向了屏幕上的内容，「当前焦点」就是用户此刻正在看的东西。
回答规则：
- 先给一句话结论，再按需展开；默认简短，用户追问再深入
- 默认用简体中文；专业术语第一次出现时附英文原词
- 公式用 LaTeX（行内 $...$，独立 $$...$$），代码用代码块
- 焦点只是线索：结合周边上下文理解，不要逐字复述原文
${AGENT_LINE}`

/** 本地小模型：Ollama 里的千问 3.5 4B（3.4GB，能看图）；装法见 scripts/setup-local-model.sh */
const LOCAL_MODEL = 'qwen3.5:4b'

const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'qwen',
    name: '千问 · 阿里云百炼',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-vl-plus', 'qwen3-vl-flash'],
    // Qwen3 系列默认会先思考，关掉才能秒回
    extraBody: { enable_thinking: false },
    console: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key'
  },
  {
    id: 'ollama',
    name: '本地千问 · Ollama',
    kind: 'openai',
    // 写 127.0.0.1 不写 localhost：Ollama 只听 IPv4，localhost 会先试 IPv6
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama',
    models: [LOCAL_MODEL],
    // 本地千问默认先「思考」上千字才回答，关掉才能秒回
    extraBody: { reasoning_effort: 'none' }
  }
]

/** 实时小人默认用的百炼图像编辑模型：实测一张 15 秒左右，头发、眼镜这些特征保留得最像 */
export const AVATAR_MODEL = 'qwen-image-3.0-pro'

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
  // 提示词里只换这一句，用户自己改过的其余部分不动
  if (s.systemPrompt.includes(OLD_AGENT_LINE)) {
    s.systemPrompt = s.systemPrompt.replace(OLD_AGENT_LINE, AGENT_LINE)
    changed = true
  }
  return changed
}

export const JEV_PRESETS = [
  { name: 'TypeSafe 官方直连', baseUrl: 'https://api.typesafe.ai', model: 'jev-latest' },
  { name: '博查 Jev（限时免费）', baseUrl: 'https://jev.bocha.cn', model: 'bocha-jev-v1' },
  { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen', model: 'jev-1.13' },
  { name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1/evaluate', model: 'typesafe-ai/jev' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' }
]

export function defaultSettings(): Settings {
  return {
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })),
    chatModel: { providerId: 'qwen', model: 'qwen3.8-max' },
    fastModel: { providerId: 'qwen', model: 'qwen3.8-flash' },
    visionModel: { providerId: 'qwen', model: 'qwen3.8-max' },
    avatar: { providerId: 'qwen', model: AVATAR_MODEL, show: true },
    jev: { baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', dailyTokenCap: 60000 },
    jevMode: false,
    gaze: { source: 'webcam', tdMount: 'bottom', cameraId: '', calibrationPoints: 17, showCursor: true, autoScroll: true, smoothing: 0.5, magnet: 0.7, headComp: true },
    terminal: { cwd: homedir(), shell: defaultShell() },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    leftRatio: 0.62,
    onboarded: false
  }
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
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Settings>
      s = {
        ...def,
        ...raw,
        jev: { ...def.jev, ...(raw.jev || {}) },
        avatar: { ...def.avatar, ...(raw.avatar || {}) },
        gaze: { ...def.gaze, ...(raw.gaze || {}) },
        terminal: { ...def.terminal, ...(raw.terminal || {}) },
        providers: raw.providers?.length ? raw.providers : def.providers
      }
      if (migrate(s, def)) saveSettings(s)
    } catch (e) {
      console.error('[settings] 读取失败，用默认值', e)
    }
  }
  // iPhone 原深感只有 Mac 版有（手机把数据发给 Mac 上的原生助手）；从 Mac 拷过来的设置在别的平台上一律当摄像头
  if (!isMac && s.gaze.source !== 'webcam') s.gaze = { ...s.gaze, source: 'webcam' }
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
