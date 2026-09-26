import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { jevStore, refreshJevUsage } from './jevBrain'
import { JevBadges } from './JevBadges'
import { settingsStore } from '../appState'

// Jev 面板：每一次「先判断」都摊开给你看——判断了什么、概率多少、花了多少 token

const KIND: Record<string, string> = { block: '看段落', stuck: '卡住了吗', route: '提问路由', terminal: 'Qwen Code' }

export function JevPanel(): React.JSX.Element {
  const j = useStore(jevStore)
  const s = useStore(settingsStore).s
  const [open, setOpen] = useState(true)

  useEffect(() => {
    refreshJevUsage()
  }, [])

  const u = j.usage
  const cap = s?.jev.dailyTokenCap ?? 0
  const usd = u ? (u.inputTokens / 1e6) * 0.042 : 0

  return (
    <div className={`jev-panel ${open ? 'open' : ''}`}>
      <div className="jev-head" onClick={() => setOpen((o) => !o)}>
        <span className="jev-logo">Jev</span>
        <span>先判断，再开口</span>
        {j.busy > 0 && <span className="pulse">判断中…</span>}
        <span className="grow" />
        {u && (
          <span className="dim small" title={`累计 ${u.totalTokens} token，缓存命中 ${u.cacheHits} 次`}>
            今日 {u.inputTokens.toLocaleString()}/{cap.toLocaleString()} tok · ${usd.toFixed(5)} · {u.calls} 次
          </span>
        )}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="jev-feed">
          {!j.traces.length && <div className="dim small">盯住一段 1.5 秒，Jev 会判断它难不难；停留很久或反复回看，它会决定要不要主动帮你。</div>}
          {j.traces.slice(0, 8).map((t) => (
            <div key={t.id} className="jev-item">
              <div className="jev-item-head">
                <b>{KIND[t.kind] || t.kind}</b>
                <span className="dim small ellipsis">{t.state.replace(/\n/g, ' ')}</span>
              </div>
              <JevBadges traces={[t]} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
