// 左侧终端里跑的编程智能体：默认 Qwen Code（千问官方开源 CLI，命令 qwen），也认得 Qwen Code。
// 只靠屏幕上的字判断「是谁在跑」「是不是在等你批准」；Qwen Code 的界面语言跟系统语言走（Glint 的终端默认 zh_CN），中英文都认

export const AGENT = {
  name: 'Qwen Code',
  cmd: 'qwen',
  /** 没装时点「启动」就用 npm 全局装上再启动 */
  install: 'npm i -g @qwen-code/qwen-code@latest && qwen'
}

/** 装 Qwen Code 的命令按 shell 写：Windows PowerShell 5.1 不认 &&，用 ; 再拿 $? 判断装没装成 */
export function installCommand(shell: string): string {
  return /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell) ? 'npm i -g @qwen-code/qwen-code@latest; if ($?) { qwen }' : AGENT.install
}

/** shell 报「找不到 qwen 这个命令」的各种说法：zsh / bash，PowerShell（中英文，5.1 的报错里还带 CommandNotFoundException），cmd（中英文） */
export const QWEN_NOT_FOUND =
  /command not found: qwen|qwen: command not found|term 'qwen' is not recognized|无法将[“"']qwen[”"']项识别|CommandNotFoundException|'qwen' 不是内部或外部命令|'qwen' is not recognized/

// Qwen Code：底栏的模型名 / 审批模式提示、输入框占位、等确认时的转圈文字
const QWEN = /Qwen Code|Shift \+ Tab 切换|shift \+ tab to cycle|输入您的消息或|Type your message or @|等待用户确认|Waiting for user confirmation|· qwen\d/
const agent = /Qwen Code|agent\.ai|✻|⏺|Do you want to|Yes, and don.t ask/

// 权限确认框：Qwen Code 跑命令「允许执行：'rm'？」、改文件「是否应用此更改？」，选项「是，允许一次 / 否，建议更改 (esc)」；
// Qwen Code「Do you want to …?」；再加几种通用的 y/n。Qwen Code 向你提问（询问用户）不算，那是选答案不是放行
const PERMISSION =
  /允许执行|是否应用此更改|是，允许一次|否，建议更改|是否继续？|Allow execution of|Apply this change\?|Yes, allow once|No, suggest changes|Do you want to|Yes, and don.t ask|\(y\/n\)|\[Y\/n\]|Proceed\?|是否允许|要继续吗/

/** 屏幕上跑的是哪家编程智能体，认不出返回 null */
export function terminalAgent(screen: string): string | null {
  if (QWEN.test(screen)) return 'Qwen Code'
  if (agent.test(screen)) return 'Qwen Code'
  return null
}

/** 屏幕底部像不像权限确认框 */
export function looksLikePermissionPrompt(screen: string): boolean {
  return PERMISSION.test(screen.split('\n').slice(-18).join('\n'))
}

/**
 * 去掉底栏的审批模式行（Qwen Code「⏸ 请求授权 (Shift + Tab 切换)」「⏸ Ask permissions (shift + tab to cycle)」、
 * Qwen Code「accept edits on (shift+tab to cycle)」）再给 Jev 看：模式名读起来像「在请求批准」，实测空闲时也会被判成等你批准
 */
export function withoutModeLine(screen: string): string {
  return screen
    .split('\n')
    .filter((l) => !/shift ?\+ ?tab/i.test(l))
    .join('\n')
}

/** 本地粗筛：像编程智能体或者交互确认，才值得花 Jev 的钱判断状态 */
export function looksLikeAgent(tail: string): boolean {
  return !!terminalAgent(tail) || PERMISSION.test(tail) || /╭|[❯›]\s*\d\.|要不要|是否/.test(tail)
}
