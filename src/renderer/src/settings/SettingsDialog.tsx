import { useEffect, useState } from 'react'
import type { Provider, Settings, ModelRef } from '../../../shared/types'
import { useStore, uid } from '../store'
import { settingsStore, updateSettings, uiStore, la, toast } from '../appState'
import { gaze } from '../gaze/engine'
import { avatarStore, clearAvatar } from '../avatar/avatar'

// 设置：模型服务商（OpenAI 兼容 / Anthropic）增删改、三路模型分配、Jev 网关、眼动参数

type Tab = 'providers' | 'models' | 'jev' | 'gaze' | 'misc'

function ProviderCard({ p, onChange, onRemove }: { p: Provider; onChange: (p: Provider) => void; onRemove: () => void }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState('')
  const [extra, setExtra] = useState(p.extraBody ? JSON.stringify(p.extraBody) : '')
  const [modelsText, setModelsText] = useState(p.models.join(', '))

  const test = async () => {
    setBusy('测试中…')
    const r = await la.settings.testProvider(p, p.models[0] || '')
    setBusy(r.ok ? `✅ ${r.ms}ms：${(r.text || '').slice(0, 20)}` : `❌ ${r.error?.slice(0, 80)}`)
  }
  const fetchModels = async () => {
    setBusy('获取中…')
    try {
      const list = await la.settings.listModels(p)
      setBusy(`拿到 ${list.length} 个模型，已放进候选（前 30 个）`)
      const merged = Array.from(new Set([...p.models, ...list.slice(0, 30)]))
      setModelsText(merged.join(', '))
      onChange({ ...p, models: merged })
    } catch (e: any) {
      setBusy('❌ ' + (e?.message || e))
    }
  }

  return (
    <div className="card">
      <div className="row">
        <input className="grow" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} />
        <select value={p.kind} onChange={(e) => onChange({ ...p, kind: e.target.value as Provider['kind'] })}>
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic 格式</option>
        </select>
        <button className="btn sm ghost" onClick={onRemove}>
          删除
        </button>
      </div>
      <label>
        地址
        <input value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} placeholder="https://…/v1" />
      </label>
      <label>
        API Key
        <div className="row">
          <input className="grow" type={show ? 'text' : 'password'} value={p.apiKey} onChange={(e) => onChange({ ...p, apiKey: e.target.value.trim() })} />
          <button className="btn sm ghost" onClick={() => setShow((x) => !x)}>
            {show ? '隐藏' : '显示'}
          </button>
        </div>
      </label>
      <label>
        模型（逗号分隔，第一个用来测试）
        <input
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          onBlur={() => onChange({ ...p, models: modelsText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) })}
        />
      </label>
      <label>
        附加请求字段（JSON，可空）
        <input
          value={extra}
          placeholder='如 {"enable_thinking": false}'
          onChange={(e) => setExtra(e.target.value)}
          onBlur={() => {
            if (!extra.trim()) return onChange({ ...p, extraBody: undefined })
            try {
              onChange({ ...p, extraBody: JSON.parse(extra) })
            } catch {
              toast('附加字段不是合法 JSON', 'warn')
            }
          }}
        />
      </label>
      <div className="row">
        <button className="btn sm" onClick={test} disabled={!p.apiKey}>
          测试连接
        </button>
        <button className="btn sm ghost" onClick={fetchModels} disabled={!p.apiKey}>
          获取模型列表
        </button>
        <span className="small dim">{busy}</span>
      </div>
    </div>
  )
}

function ModelSelect({ s, value, onChange }: { s: Settings; value: ModelRef; onChange: (m: ModelRef) => void }): React.JSX.Element {
  const opts = s.providers.flatMap((p) => p.models.map((m) => ({ v: `${p.id}::${m}`, label: `${p.name} · ${m}${p.apiKey ? '' : '（缺 Key）'}` })))
  return (
    <select value={`${value.providerId}::${value.model}`} onChange={(e) => {
      const [providerId, model] = e.target.value.split('::')
      onChange({ providerId, model })
    }}>
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function SettingsDialog(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  const cur = useStore(settingsStore).s
  const g = useStore(gaze.status)
  const av = useStore(avatarStore)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('providers')
  const [presets, setPresets] = useState<Array<{ name: string; baseUrl: string; model: string }>>([])
  const [jevTest, setJevTest] = useState('')

  useEffect(() => {
    if (ui.showSettings && cur) setDraft(structuredClone(cur))
    if (ui.showSettings) {
      la.settings.jevPresets().then(setPresets)
      gaze.listCameras().catch(() => undefined)
    }
  }, [ui.showSettings])

  if (!ui.showSettings || !draft) return null

  const set = (p: Partial<Settings>) => setDraft({ ...draft, ...p })
  const close = async (save: boolean) => {
    if (save) {
      await updateSettings(() => draft)
      gaze.setSmoothing(draft.gaze.smoothing)
      toast('设置已保存', 'ok')
    }
    uiStore.patch({ showSettings: false })
  }

  return (
    <div className="modal-mask" onClick={() => close(true)}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-tabs">
          {(
            [
              ['providers', '模型服务'],
              ['models', '模型分配'],
              ['jev', 'Jev 判断'],
              ['gaze', '眼动'],
              ['misc', '其他']
            ] as Array<[Tab, string]>
          ).map(([k, v]) => (
            <button key={k} className={`tabbtn ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {v}
            </button>
          ))}
          <span className="grow" />
          <button className="btn sm primary" onClick={() => close(true)}>
            保存并关闭
          </button>
        </div>

        <div className="settings-body">
          {tab === 'providers' && (
            <>
              <p className="dim small">Key 只存在本机（~/Library/Application Support/LookAsk/settings.json，权限 600），请求从主进程直接发给服务商。</p>
              {draft.providers.map((p, i) => (
                <ProviderCard
                  key={p.id}
                  p={p}
                  onChange={(np) => set({ providers: draft.providers.map((x, j) => (j === i ? np : x)) })}
                  onRemove={() => set({ providers: draft.providers.filter((_, j) => j !== i) })}
                />
              ))}
              <button
                className="btn"
                onClick={() =>
                  set({
                    providers: [
                      ...draft.providers,
                      { id: uid('p'), name: '自定义服务商', kind: 'openai', baseUrl: 'https://', apiKey: '', models: [] }
                    ]
                  })
                }
              >
                ＋ 添加服务商
              </button>
            </>
          )}

          {tab === 'models' && (
            <div className="form">
              <label>
                回答（解释 / 总结 / 提问）
                <ModelSelect s={draft} value={draft.chatModel} onChange={(m) => set({ chatModel: m })} />
              </label>
              <label>
                快速（翻译）
                <ModelSelect s={draft} value={draft.fastModel} onChange={(m) => set({ fastModel: m })} />
              </label>
              <label>
                看图（截图问 / Jev 判断要看图时）
                <ModelSelect s={draft} value={draft.visionModel} onChange={(m) => set({ visionModel: m })} />
              </label>
              <p className="dim small">参赛提示：天猫 AI 黑客松「效率进化」赛道的阿里云特别赛题是「基于 Qwen 大模型的科研提效」，默认三路都用千问。</p>
            </div>
          )}

          {tab === 'jev' && (
            <div className="form">
              <label>
                网关预设
                <select
                  value=""
                  onChange={(e) => {
                    const pr = presets.find((x) => x.name === e.target.value)
                    if (pr) set({ jev: { ...draft.jev, baseUrl: pr.baseUrl, model: pr.model } })
                  }}
                >
                  <option value="">选一个预设填入地址和模型…</option>
                  {presets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                地址
                <input value={draft.jev.baseUrl} onChange={(e) => set({ jev: { ...draft.jev, baseUrl: e.target.value } })} />
              </label>
              <label>
                模型
                <input value={draft.jev.model} onChange={(e) => set({ jev: { ...draft.jev, model: e.target.value } })} />
              </label>
              <label>
                API Key
                <input type="password" value={draft.jev.apiKey} onChange={(e) => set({ jev: { ...draft.jev, apiKey: e.target.value.trim() } })} />
              </label>
              <label>
                每日输入 token 上限（Key 不能充值，超了当天自动停）
                <input
                  type="number"
                  value={draft.jev.dailyTokenCap}
                  onChange={(e) => set({ jev: { ...draft.jev, dailyTokenCap: Math.max(1000, Number(e.target.value) || 0) } })}
                />
              </label>
              <div className="row">
                <button
                  className="btn sm"
                  disabled={!draft.jev.apiKey}
                  onClick={async () => {
                    await updateSettings(() => draft)
                    setJevTest('测试中…')
                    const r = await la.jev.judge('这篇论文用自注意力替代了循环结构。', {
                      term: { type: 'noul', instructions: 'The text mentions a machine learning architecture concept' }
                    })
                    setJevTest(r.ok ? `✅ ${r.ms}ms · ${r.inputTokens} tok · 判断概率 ${Math.round((r.answers.term?.noul ?? 0) * 100)}%${r.cached ? '（缓存）' : ''}` : `❌ ${r.error}`)
                  }}
                >
                  测试 Jev
                </button>
                <span className="small dim">{jevTest}</span>
              </div>
              <label className="check">
                <input type="checkbox" checked={draft.jevMode} onChange={(e) => set({ jevMode: e.target.checked })} />
                开启 Jev 模式（长按右手柄 + 也能切）
              </label>
              <p className="dim small">Jev 只判断不写字：段落难度、是否卡住、提问意图、Qwen Code 是否在等你批准。同样的内容命中本地缓存不重复花钱。</p>
            </div>
          )}

          {tab === 'gaze' && (
            <div className="form">
              <label>
                摄像头
                <select value={draft.gaze.cameraId} onChange={(e) => set({ gaze: { ...draft.gaze, cameraId: e.target.value } })}>
                  <option value="">默认</option>
                  {g.cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="dim small">iPhone 放在屏幕上沿当连续互通相机，画质比内置摄像头好；换摄像头后要重新校准。</p>
              <label>
                校准点数
                <select
                  value={draft.gaze.calibrationPoints}
                  onChange={(e) => set({ gaze: { ...draft.gaze, calibrationPoints: Number(e.target.value) as 9 | 17 } })}
                >
                  <option value={17}>17 点（约 30 秒，更准）</option>
                  <option value={9}>9 点（约 15 秒）</option>
                </select>
              </label>
              <label>
                平滑：{Math.round(draft.gaze.smoothing * 100)}%（越高越稳、越慢）
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.gaze.smoothing}
                  onChange={(e) => set({ gaze: { ...draft.gaze, smoothing: Number(e.target.value) } })}
                />
              </label>
              <label>
                吸附强度：{Math.round((draft.gaze.magnet ?? 0.7) * 100)}%（越高，视线圈越容易吸住附近的词、吸得越牢，软焦点也越不容易跳段；40% 左右是最早的手感）
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.gaze.magnet ?? 0.7}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    set({ gaze: { ...draft.gaze, magnet: v } })
                    // 边拖边生效，关掉设置前就能试手感
                    updateSettings((x) => ({ ...x, gaze: { ...x.gaze, magnet: v } }))
                  }}
                />
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.gaze.showCursor} onChange={(e) => set({ gaze: { ...draft.gaze, showCursor: e.target.checked } })} />
                显示视线圈
              </label>
              <label className="check">
                <input type="checkbox" checked={draft.gaze.autoScroll} onChange={(e) => set({ gaze: { ...draft.gaze, autoScroll: e.target.checked } })} />
                眼动翻页（盯着正文底部 2 秒自动下翻）
              </label>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={async () => {
                    await updateSettings(() => draft)
                    await gaze.start(draft.gaze.cameraId || undefined)
                    toast('摄像头已重启', 'ok')
                  }}
                >
                  用新设置重启摄像头
                </button>
                <button className="btn sm ghost" onClick={() => gaze.resetDrift()}>
                  清除漂移校正
                </button>
                <button className="btn sm ghost" onClick={() => gaze.clearModel()}>
                  删除校准模型
                </button>
              </div>

              <h3 className="settings-sub">实时小人</h3>
              <label className="check">
                <input type="checkbox" checked={draft.avatar.show} onChange={(e) => set({ avatar: { ...draft.avatar, show: e.target.checked } })} />
                在角落显示实时小人（跟着你的头动，坐偏了告诉你往哪挪）
              </label>
              <label>
                图生图服务（OpenAI 兼容的 images/edits）
                <select value={draft.avatar.providerId} onChange={(e) => set({ avatar: { ...draft.avatar, providerId: e.target.value } })}>
                  {draft.providers
                    .filter((p) => p.kind === 'openai')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.apiKey ? '' : '（缺 Key）'}
                      </option>
                    ))}
                </select>
              </label>
              <div className="row">
                <label className="grow">
                  模型
                  <input value={draft.avatar.model} onChange={(e) => set({ avatar: { ...draft.avatar, model: e.target.value.trim() } })} />
                </label>
                <label>
                  画质
                  <select
                    value={draft.avatar.quality}
                    onChange={(e) => set({ avatar: { ...draft.avatar, quality: e.target.value as Settings['avatar']['quality'] } })}
                  >
                    <option value="low">低（快、便宜）</option>
                    <option value="medium">中</option>
                    <option value="high">高（慢）</option>
                  </select>
                </label>
              </div>
              <div className="row">
                <button
                  className="btn sm"
                  disabled={av.busy}
                  onClick={async () => {
                    await updateSettings(() => draft)
                    uiStore.patch({ showSettings: false, showBooth: true })
                  }}
                >
                  {av.busy ? '小人生成中…' : av.img ? '重新拍照生成' : '拍大头照生成小人'}
                </button>
                {av.img && (
                  <button className="btn sm ghost" onClick={() => clearAvatar()}>
                    删掉小人（换回默认形象）
                  </button>
                )}
              </div>
              <p className="dim small">照片只发给上面选的图生图服务，不存本地；生成的小人存在本机。默认用 OpenLux 中转的 gpt-image-2，一次约 40～60 秒。</p>
            </div>
          )}

          {tab === 'misc' && (
            <div className="form">
              <label>
                系统提示词
                <textarea rows={9} value={draft.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} />
              </label>
              <label>
                终端起始目录
                <input value={draft.terminal.cwd} onChange={(e) => set({ terminal: { ...draft.terminal, cwd: e.target.value } })} />
              </label>
              <label>
                Shell
                <input value={draft.terminal.shell} onChange={(e) => set({ terminal: { ...draft.terminal, shell: e.target.value } })} />
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
