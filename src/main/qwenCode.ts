import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

// 左侧终端里的编程智能体默认是 Qwen Code（千问官方开源的命令行编程智能体，命令 qwen，npm 包 @qwen-code/qwen-code）。
// 不动用户自己的 ~/.qwen：Glint 在 userData 里写一份 Qwen Code 的「系统默认设置」，起终端时用
// QWEN_CODE_SYSTEM_DEFAULTS_PATH 指过去。这一层优先级最低（系统设置 > 项目 > 用户 > 系统默认），
// 用户在 ~/.qwen/settings.json 里配了别的（Coding Plan / Token Plan / 换默认模型）一律以用户的为准。
// Key 不写进文件：放进终端环境变量 DASHSCOPE_API_KEY（百炼的标准变量名，Qwen Code 的联网搜索、看图工具也认它），
// 配置里用 envKey 引用。Qwen OAuth 免费额度 2026-04-15 已停，没 Key 就不写默认设置，让 Qwen Code 自己弹登录方式

/** Qwen Code 里 /model 能选的百炼模型，第一个是默认：3.8-max 最强，3.7-plus 便宜好几倍，3.8-flash 最快最省 */
export const QWEN_CODE_MODELS = ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']

/** Qwen Code 0.24 的设置版本号；写对了它就不会去迁移这份文件 */
const SETTINGS_VERSION = 4

/** 起终端时额外带上的环境变量；没填百炼 Key 返回空 */
export function qwenCodeEnv(s: Settings): Record<string, string> {
  const p = s.providers.find((x) => x.id === 'qwen')
  if (!p?.apiKey) return {}
  const env: Record<string, string> = {}
  // 用户自己在环境里配过的不覆盖
  if (!process.env.DASHSCOPE_API_KEY) env.DASHSCOPE_API_KEY = p.apiKey
  if (process.env.QWEN_CODE_SYSTEM_DEFAULTS_PATH) return env
  const dir = join(app.getPath('userData'), 'qwen-code')
  const file = join(dir, 'system-defaults.json')
  const baseUrl = p.baseUrl.replace(/\/+$/, '')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          $version: SETTINGS_VERSION,
          security: { auth: { selectedType: 'openai' } },
          modelProviders: { openai: QWEN_CODE_MODELS.map((id) => ({ id, name: `[百炼] ${id}`, baseUrl, envKey: 'DASHSCOPE_API_KEY' })) },
          model: { name: QWEN_CODE_MODELS[0] }
        },
        null,
        2
      ),
      'utf8'
    )
    env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = file
  } catch (e) {
    console.error('[qwen-code] 写默认设置失败', e)
  }
  return env
}
