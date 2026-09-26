import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection } from './types'
import { clip } from './types'
import { boundsStore, la, toast } from '../appState'
import type { OcrLine } from '../../../shared/types'

// 全局模式的焦点：视线落在任意 App 上，焦点是一块屏幕矩形
// 取上下文 = 截这块屏幕 → 系统 OCR 识字 + 辅助功能读原文（终端、浏览器等能拿到原文）+ 截图给视觉模型

type ScreenAnchor = Anchor & { x: number; y: number }

const SIZE: Record<Granularity, [number, number]> = {
  word: [200, 46],
  sentence: [560, 60],
  paragraph: [760, 210],
  section: [980, 460]
}

function rectAround(a: ScreenAnchor, gran: Granularity): Box {
  const [w, h] = SIZE[gran]
  const b = boundsStore.get()
  const d = b.display
  // 右边是 LookAsk 侧边栏，焦点框不要压到侧边栏上
  const maxX = b.mode === 'global' ? Math.min(d.x + d.width, b.content.x) : d.x + d.width
  let x = a.x - w / 2
  let y = a.y - h / 2
  x = Math.max(d.x, Math.min(maxX - w, x))
  y = Math.max(d.y, Math.min(d.y + d.height - h, y))
  return { x, y, width: w, height: h }
}

let warnedScreen = false

export function createScreenAdapter(): PaneAdapter {
  const adapter: PaneAdapter = {
    id: 'screen',
    kind: 'screen',
    element: () => null,
    anchorAt(x, y) {
      return { pane: 'screen', x, y } as ScreenAnchor
    },
    move(a: Anchor, dir: Dir) {
      const sa = a as ScreenAnchor
      const dx = dir === 'left' ? -90 : dir === 'right' ? 90 : 0
      const dy = dir === 'up' ? -30 : dir === 'down' ? 30 : 0
      return { pane: 'screen', x: sa.x + dx, y: sa.y + dy } as ScreenAnchor
    },
    moveBlock(a: Anchor, dir) {
      const sa = a as ScreenAnchor
      return { pane: 'screen', x: sa.x, y: sa.y + (dir === 'down' ? 160 : -160) } as ScreenAnchor
    },
    select(a: Anchor, gran: Granularity): Selection {
      const r = rectAround(a as ScreenAnchor, gran)
      return { rects: [r], space: 'screen', text: '', gran, blockKey: `scr${Math.round(r.x / 200)}_${Math.round(r.y / 120)}` }
    },
    async context(a: Anchor, gran: Granularity): Promise<FocusContext> {
      const sa = a as ScreenAnchor
      const rect = rectAround(sa, gran)
      const [cap, ax] = await Promise.all([la.screen.capture(rect), la.bridge.ax(sa.x, sa.y)])
      let ocrText = ''
      let image: string | undefined
      if ('error' in cap) {
        if (cap.error === 'screen_permission' && !warnedScreen) {
          warnedScreen = true
          toast('全局模式要「录屏与系统录音」权限才能看见别的 App，去系统设置里给 LookAsk 打开', 'warn', {
            ttl: 9000,
            action: { label: '打开设置', run: () => la.perm.openSettings('screen') }
          })
        }
      } else {
        image = cap.dataUrl
        const o: any = await la.bridge.ocr(cap.path, false)
        const lines: OcrLine[] = o?.lines || []
        ocrText = lines.map((l) => l.text).join('\n')
      }
      const axr: any = ax && !ax.error ? ax : null
      const axLine: string = (axr?.line || '').trim()
      const axText: string = (axr?.text || '').trim()
      return {
        source: 'screen',
        docTitle: axr?.window || axr?.app || '屏幕',
        app: axr?.app,
        location: axr?.app ? `${axr.app}${axr.window ? ` ·「${axr.window}」` : ''}` : '屏幕',
        gran,
        selection: clip(axLine || ocrText, 2000),
        paragraph: clip(ocrText || axLine, 3000),
        extra: axText && axText !== axLine ? clip(axText, 4000) : undefined,
        image
      }
    },
    scrollBy() {
      // 全局模式不替别的 App 滚动
    }
  }
  return adapter
}
