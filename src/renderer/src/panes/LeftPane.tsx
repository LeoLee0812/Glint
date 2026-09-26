import { useState } from 'react'
import { useStore } from '../store'
import { docsStore, activate, closeDoc, openFile, openViaDialog, newTerminal, type Doc } from './docs'
import { MarkdownPane } from './MarkdownPane'
import { PdfPane } from './PdfPane'
import { TerminalPane } from './TerminalPane'
import { WindowPane } from './WindowPane'

// 左侧：标签页 + 拖放打开文件

const ICON: Record<Doc['kind'], string> = { md: '📄', pdf: '📕', terminal: '⌨️', window: '🪟' }

function Pane({ doc, active }: { doc: Doc; active: boolean }): React.JSX.Element {
  switch (doc.kind) {
    case 'md':
      return <MarkdownPane doc={doc} active={active} />
    case 'pdf':
      return <PdfPane doc={doc} active={active} />
    case 'terminal':
      return <TerminalPane doc={doc} active={active} />
    case 'window':
      return <WindowPane />
  }
}

export function LeftPane(): React.JSX.Element {
  const { docs, active } = useStore(docsStore)
  const [drag, setDrag] = useState(false)
  const [menu, setMenu] = useState(false)

  return (
    <section
      className={`left ${drag ? 'dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrag(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setDrag(false)
        for (const f of Array.from(e.dataTransfer.files)) await openFile(f)
      }}
    >
      <div className="tabs">
        {docs.map((d) => (
          <div key={d.id} className={`tab ${d.id === active ? 'on' : ''}`} onClick={() => activate(d.id)} title={d.path || d.title}>
            <span className="tab-icon">{ICON[d.kind]}</span>
            <span className="tab-title">{d.title}</span>
            {d.id !== 'welcome' && d.id !== 'window' && (
              <button
                className="tab-x"
                onClick={(e) => {
                  e.stopPropagation()
                  closeDoc(d.id)
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <div className="tab-add">
          <button className="btn sm ghost" onClick={() => setMenu((m) => !m)}>
            ＋
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button
                onClick={() => {
                  setMenu(false)
                  openViaDialog()
                }}
              >
                打开 PDF / Markdown…
              </button>
              <button
                onClick={() => {
                  setMenu(false)
                  newTerminal()
                }}
              >
                新终端
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="left-body">
        {docs.map((d) => (
          <div key={d.id} className="pane-slot" style={{ display: d.id === active ? 'flex' : 'none' }}>
            <Pane doc={d} active={d.id === active} />
          </div>
        ))}
        {!docs.length && <div className="empty">把 .md / .pdf 拖到这里</div>}
      </div>
      {drag && <div className="drop-hint">松手打开（支持 .md / .pdf / .txt）</div>}
    </section>
  )
}
