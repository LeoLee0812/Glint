import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Display } from 'electron'

// Windows 上显示器的物理尺寸（摄像头头动补偿要按毫米换算屏幕上的点）：Mac 版由原生助手问 CGDisplayScreenSize，
// Windows 没有现成接口，用 PowerShell 查一次 WMI（在用的显示器 + 接口类型）和注册表里的 EDID，
// EDID 第一个详细时序里有精确到毫米的尺寸和原生分辨率，再按「内屏 / 外接」「原生分辨率」「型号名」对上 Electron 的 display

interface Monitor {
  inst: string
  /** 物理尺寸（毫米，横放时的宽高） */
  mmW: number
  mmH: number
  /** 原生分辨率 */
  pxW: number
  pxH: number
  name: string
  internal: boolean
}

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$conn = @{}
Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams | ForEach-Object { $conn[$_.InstanceName] = [int64]$_.VideoOutputTechnology }
$r = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | Where-Object { $_.Active } | ForEach-Object {
  $k = $_.InstanceName -replace '_\\d+$', ''
  $e = (Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\$k\\Device Parameters" -Name EDID).EDID
  [pscustomobject]@{ inst = $_.InstanceName; cmW = [int]$_.MaxHorizontalImageSize; cmH = [int]$_.MaxVerticalImageSize; vot = $conn[$_.InstanceName]; edid = $(if ($e) { [Convert]::ToBase64String($e) } else { '' }) }
})
ConvertTo-Json -Compress -InputObject $r
`

/** 接口类型（D3DKMDT_VIDEO_OUTPUT_TECHNOLOGY）里算内屏的：LVDS、内嵌 DisplayPort、内嵌 UDI、INTERNAL */
const INTERNAL_VOT = new Set([6, 11, 13, 0x80000000])

function parseEdid(b64: string): { mmW: number; mmH: number; pxW: number; pxH: number; name: string } | null {
  const e = Buffer.from(b64, 'base64')
  if (e.length < 128) return null
  let mmW = 0
  let mmH = 0
  let pxW = 0
  let pxH = 0
  let name = ''
  for (let o = 54; o <= 108; o += 18) {
    const clock = e[o] | (e[o + 1] << 8)
    if (clock && !pxW) {
      // 第一个详细时序：原生分辨率 + 显示区域物理尺寸（毫米）
      pxW = e[o + 2] | ((e[o + 4] & 0xf0) << 4)
      pxH = e[o + 5] | ((e[o + 7] & 0xf0) << 4)
      mmW = e[o + 12] | ((e[o + 14] & 0xf0) << 4)
      mmH = e[o + 13] | ((e[o + 14] & 0x0f) << 8)
    } else if (!clock && e[o + 3] === 0xfc) {
      name = e.subarray(o + 5, o + 18).toString('latin1').split('\n')[0].trim()
    }
  }
  // 有的 EDID 详细时序里尺寸填 0，退回基本参数里的厘米
  if (mmW < 50 || mmH < 30) {
    mmW = e[21] * 10
    mmH = e[22] * 10
  }
  return { mmW, mmH, pxW, pxH, name }
}

function queryMonitors(): Promise<Monitor[]> {
  const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve) => {
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) {
        console.warn('[display] 查显示器尺寸失败', err.message)
        return resolve([])
      }
      try {
        const rows = JSON.parse(stdout.trim() || '[]') as Array<{ inst: string; cmW: number; cmH: number; vot: number | null; edid: string }>
        resolve(
          rows.map((r) => {
            const ed = r.edid ? parseEdid(r.edid) : null
            return {
              inst: r.inst,
              mmW: ed?.mmW || r.cmW * 10,
              mmH: ed?.mmH || r.cmH * 10,
              pxW: ed?.pxW || 0,
              pxH: ed?.pxH || 0,
              name: ed?.name || '',
              internal: r.vot != null && INTERNAL_VOT.has(r.vot)
            }
          })
        )
      } catch (e) {
        console.warn('[display] 解析显示器尺寸失败', e)
        resolve([])
      }
    })
  })
}

let cache: Promise<Monitor[]> | null = null

/** 查一次缓存起来（PowerShell 起一次要半秒多）；启动后先在后台查好，校准完要用时就不用等 */
export function prefetchMonitors(): void {
  if (!cache) cache = queryMonitors()
}

function pick(d: Display, mons: Monitor[]): Monitor | null {
  const usable = mons.filter((m) => m.mmW >= 50 && m.mmH >= 30)
  if (mons.length === 1) return usable[0] ?? null
  // 笔记本 + 一台外接显示器最常见：内屏对内屏、外接对外接
  const sameKind = usable.filter((m) => m.internal === !!d.internal)
  if (sameKind.length === 1) return sameKind[0]
  // 原生分辨率对得上（缩放、旋转都换算回物理像素）
  const w = Math.round(d.size.width * d.scaleFactor)
  const h = Math.round(d.size.height * d.scaleFactor)
  const byRes = usable.filter((m) => (m.pxW === w && m.pxH === h) || (m.pxW === h && m.pxH === w))
  if (byRes.length === 1) return byRes[0]
  // 型号名对得上
  if (d.label) {
    const byName = usable.filter((m) => m.name && d.label.includes(m.name))
    if (byName.length === 1) return byName[0]
  }
  return null
}

/** 这块屏幕的物理宽高（毫米，按屏幕现在的方向）；对不上是哪台显示器就返回 null */
export async function displayMillimeters(d: Display): Promise<{ w: number; h: number } | null> {
  prefetchMonitors()
  const m = pick(d, await cache!)
  if (!m) return null
  const rotated = d.rotation === 90 || d.rotation === 270
  return rotated ? { w: m.mmH, h: m.mmW } : { w: m.mmW, h: m.mmH }
}
