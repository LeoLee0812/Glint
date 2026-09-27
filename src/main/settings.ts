import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Settings, Provider } from '../shared/types'

// 设置存在 ~/Library/Application Support/LookAsk/settings.json（权限 600，只有本人可读）
// Key 只存本机，不进仓库

const DEFAULT_SYSTEM_PROMPT = `你是 Glint 瞳问的阅读副驾。用户用眼动追踪 + Joy-Con 手柄指向了屏幕上的内容，「当前焦点」就是用户此刻正在看的东西。
回答规则：
- 先给一句话结论，再按需展开；默认简短，用户追问再深入
- 默认用简体中文；专业术语第一次出现时附英文原词
- 公式用 LaTeX（行内 $...$，独立 $$...$$），代码用代码块
- 焦点只是线索：结合周边上下文理解，不要逐字复述原文
- 如果焦点内容来自终端里的 Qwen Code，把它当作编程协作场景来解释`

const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'qwen',
    name: '千问 · 阿里云百炼',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-vl-plus', 'qwen3-vl-flash'],
    // Qwen3 系列默认会先思考，关掉才能秒回
    extraBody: { enable_thinking: false }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  {
    id: 'openlux',
    name: 'OpenLux 聚合中转',
    kind: 'openai',
    baseUrl: 'https://api.openlux.ai/v1',
    apiKey: '',
    models: ['gemini-2.5-flash', 'gpt-4o-mini', 'agent-sonnet-4-5']
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    models: ['glm-5.3-flash']
  },
  {
    id: 'kimi',
    name: 'Kimi · Moonshot',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    models: ['kimi-k2.7-code-highspeed']
  },
  {
    id: 'anthropic',
    name: 'Anthropic agent',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models: ['agent-sonnet-5', 'agent-haiku-4-5-20251001']
  },
  {
    id: 'ollama',
    name: '本地 Ollama',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
    models: ['qwen2.5:7b']
  }
]

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
    avatar: { providerId: 'openlux', model: 'gpt-image-2', quality: 'medium', show: true },
    jev: { baseUrl: 'https://api.typesafe.ai', apiKey: '', model: 'jev-latest', dailyTokenCap: 60000 },
    jevMode: false,
    gaze: { source: 'webcam', tdMount: 'bottom', cameraId: '', calibrationPoints: 17, showCursor: true, autoScroll: true, smoothing: 0.5, magnet: 0.7 },
    terminal: { cwd: homedir(), shell: process.env.SHELL || '/bin/zsh' },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    leftRatio: 0.62
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
    } catch (e) {
      console.error('[settings] 读取失败，用默认值', e)
    }
  }
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
