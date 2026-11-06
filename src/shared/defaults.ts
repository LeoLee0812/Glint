import type { Provider, Settings } from './types'

// 默认设置：桌面版主进程和平板版垫片共用

const AGENT_LINE = '- 如果焦点内容来自终端里的 Qwen Code（或别的编程智能体），把它当作编程协作场景来解释'

export const DEFAULT_SYSTEM_PROMPT = `你是 Glint 瞳问的阅读副驾。用户用眼动追踪 + Joy-Con 手柄指向了屏幕上的内容，「当前焦点」就是用户此刻正在看的东西。
回答规则：
- 先给一句话结论，再按需展开；默认简短，用户追问再深入
- 默认用简体中文；专业术语第一次出现时附英文原词
- 公式用 LaTeX（行内 $...$，独立 $$...$$），代码用代码块
- 焦点只是线索：结合周边上下文理解，不要逐字复述原文
${AGENT_LINE}`

/** 本地小模型：Ollama 里的千问 3.5 4B（3.4GB，能看图）；装法见 scripts/setup-local-model.sh */
export const LOCAL_MODEL = 'qwen3.5:4b'

/** 本地翻译模型：千问 Qwen3.5-2B（Q4，1.3GB，4GB 显存放得下），关掉思考只做翻译；Windows 默认用它，装法见 README */
export const LOCAL_TRANSLATE_MODEL = 'qwen3.5:2b-mt'

const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'qwen',
    name: '千问 · 阿里云百炼',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-vl-plus'],
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

export function baseSettings(terminal: Settings['terminal']): Settings {
  return {
    providers: DEFAULT_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })),
    chatModel: { providerId: 'qwen', model: 'qwen3.8-max' },
    fastModel: { providerId: 'qwen', model: 'qwen3.8-flash' },
    visionModel: { providerId: 'qwen', model: 'qwen3.8-max' },
    avatar: { providerId: 'qwen', model: AVATAR_MODEL, show: true },
    gaze: { source: 'webcam', tdMount: 'bottom', cameraId: '', glintRotate: 90, calibrationPoints: 17, showCursor: true, autoScroll: true, smoothing: 0.5, magnet: 0.7, headComp: true },
    terminal,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    leftRatio: 0.62,
    onboarded: false
  }
}
