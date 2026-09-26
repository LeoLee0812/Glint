import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '../chat/markdown'
import { DomAdapter, ElementBlocks } from '../focus/domAdapter'
import { panes } from '../focus/focus'
import { la } from '../appState'
import type { Doc } from './docs'

// Markdown 阅读视图：拖进来的笔记、AI 回复、使用说明都在这里读

export function MarkdownPane({ doc, active }: { doc: Doc; active: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(doc.text || ''), [doc.text])
  const blocksRef = useRef<ElementBlocks | null>(null)

  useEffect(() => {
    if (!active) return
    const blocks = new ElementBlocks(() => ref.current)
    blocksRef.current = blocks
    const adapter = new DomAdapter({
      id: `doc:${doc.id}`,
      kind: 'markdown',
      root: () => ref.current,
      blocks,
      docTitle: () => doc.title,
      capture: (rect) => la.win.capture(rect)
    })
    return panes.register(adapter)
  }, [active, doc.id, doc.title])

  useEffect(() => {
    blocksRef.current?.invalidate()
  }, [html])

  return (
    <div className="doc-scroll" ref={ref}>
      <article className="md-doc" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
