import type { JevConfig, Settings } from './types'

// Jev 判断默认走阿里云百炼的「决策模型」decision-model-preview（就是 TypeSafe 的 Jev 上架到百炼，接口同样是 systemone）。
// 百炼的地址要带业务空间 ID：https://<ws-xxx>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone，
// 只写 dashscope.aliyuncs.com 会 404，业务空间写错会 403。Key 和千问共用百炼那把，不用单独填。

export const BAILIAN_JEV_MODEL = 'decision-model-preview'
export const BAILIAN_JEV_URL = 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
/** 百炼控制台的决策模型页面，「API 代码示例」里的地址带着业务空间 ID */
export const BAILIAN_JEV_CONSOLE = 'https://bailian.console.aliyun.com/cn-beijing/model/market/detail/decision-model-preview'

const WS = /\b(ws-[a-z0-9]+)\b/i

export function isBailianJev(j: JevConfig): boolean {
  return /aliyuncs\.com|\{WorkspaceId\}/i.test(j.baseUrl)
}

/** 从任意一段文字里抠业务空间 ID：直接填 ws-xxx、或者把控制台示例里的整条地址贴进来都认 */
export function parseWorkspace(text: string): string {
  return text.match(WS)?.[1].toLowerCase() || ''
}

function bailianProviderKey(s: Settings): string {
  const list = s.providers.filter((p) => p.apiKey && /aliyuncs\.com/.test(p.baseUrl))
  return (list.find((p) => p.id === 'qwen') || list[0])?.apiKey || ''
}

/** 实际用的 Key：Jev 自己没填、又是百炼地址，就借千问服务商的 Key */
export function jevKey(s: Settings): string {
  return s.jev.apiKey || (isBailianJev(s.jev) ? bailianProviderKey(s) : '')
}

/** 业务空间 ID：设置里填的 > 地址里写死的 > 千问服务商用的是业务空间专属域名时从那儿取 */
export function jevWorkspace(s: Settings): string {
  if (s.jev.workspaceId) return parseWorkspace(s.jev.workspaceId)
  const fromUrl = parseWorkspace(s.jev.baseUrl)
  if (fromUrl) return fromUrl
  for (const p of s.providers) {
    const w = /aliyuncs\.com/.test(p.baseUrl) ? parseWorkspace(p.baseUrl) : ''
    if (w) return w
  }
  return ''
}

/** 网关地址三种写法都认：只写主机、带 /v1、或者直接写到动作路径；百炼地址里的 {WorkspaceId} 换成业务空间 ID */
export function jevEndpoint(s: Settings): string {
  let b = s.jev.baseUrl.trim().replace(/\/+$/, '')
  if (/\{WorkspaceId\}/i.test(b)) b = b.replace(/\{WorkspaceId\}/gi, jevWorkspace(s))
  if (/\/(systemone|evaluate|decisions)$/.test(b)) return b
  if (/\/v1$/.test(b)) return `${b}/systemone`
  return `${b}/v1/systemone`
}

/** 还缺什么才能用；空串表示齐了 */
export function jevMissing(s: Settings): string {
  if (!jevKey(s)) return isBailianJev(s.jev) ? '还没填百炼的 Key' : '还没填 Jev 的 Key'
  if (/\{WorkspaceId\}/i.test(s.jev.baseUrl) && !jevWorkspace(s)) return '还没填百炼的业务空间 ID'
  return ''
}
