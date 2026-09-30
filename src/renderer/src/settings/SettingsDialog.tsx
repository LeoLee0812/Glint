import { useEffect, useState } from 'react'
import type { Provider, Settings, ModelRef, TdStatus, TdMount } from '../../../shared/types'
import { useStore, uid } from '../store'
import { settingsStore, updateSettings, uiStore, la, toast } from '../appState'
import { gaze } from '../gaze/engine'
import { avatarStore, clearAvatar } from '../avatar/avatar'
import { MOUNT_LABEL } from '../gaze/td/mount'

// 设置：模型服务商（OpenAI 兼容 / Anthropic）增删改、三路模型分配、Jev 网关、眼动参数（输入源、iPhone 原深感配对）

type Tab = 'providers' | 'models' | 'jev' | 'gaze' | 'misc'

/** 实时小人能选的百炼图像编辑模型（第一个是默认） */
const AVATAR_MODELS: Array<[string, string]> = [
  ['qwen-image-3.0-pro', '千问图像 3.0 Pro（推荐）'],
  ['qwen-image-3.0', '千问图像 3.0'],
  ['qwen-image-2.0-pro', '千问图像 2.0 Pro'],
  ['qwen-image-edit-max', '千问图像编辑 Max（盲盒风）'],
  ['qwen-image-edit-plus', '千问图像编辑 Plus']
]

function ProviderCard({ p, onChange, onRemove }: { p: Provider; onChange: (p: Provider) => void; onRemove: () => void }): React.JSX.Element {
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState('')
  const [extra, setExtra] = useState(p.extraBody ? JSON.stringify(p.extraBody) : '')
  const [modelsText, setModelsText] = useState(p.models.join(', '))

  const test = async () => {
    setBusy('测试中…')
    const r = await la.settings.testProvider(p, p.models[0] || '')
    setBusy(r.ok ? `✅ 通了，${r.ms}ms` : `❌ ${r.error?.slice(0, 80)}`)
  }
  const fetchModels = async () => {
    setBusy('获取中…')
    try {
      const list = await la.settings.listModels(p)
      setBusy(`找到 ${list.length} 个模型，最多加 30 个进列表`)
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
        模型（逗号隔开）
        <input
          value={modelsText}
          onChange={(e) => setModelsText(e.target.value)}
          onBlur={() => onChange({ ...p, models: modelsText.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean) })}
        />
      </label>
      <label>
        附加参数（JSON）
        <input
          value={extra}
          placeholder='如 {"enable_thinking": false}'
          onChange={(e) => setExtra(e.target.value)}
          onBlur={() => {
            if (!extra.trim()) return onChange({ ...p, extraBody: undefined })
            try {
              onChange({ ...p, extraBody: JSON.parse(extra) })
            } catch {
              toast('附加参数不是有效的 JSON', 'warn')
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
        {p.console && (
          <a className="btn sm ghost" href={p.console} target="_blank" rel="noreferrer">
            去官网拿 Key ↗
          </a>
        )}
        <span className="small dim">{busy}</span>
      </div>
    </div>
  )
}

/** iPhone 原深感：这台 Mac 在手机上叫什么、发现了哪些手机、输配对码 */
function TdPairing(): React.JSX.Element {
  const [st, setSt] = useState<TdStatus | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<Record<string, string>>({})
  useEffect(() => {
    la.truedepth.status().then(setSt)
    return la.truedepth.onStatus(setSt)
  }, [])

  const pair = async (dev: string) => {
    const code = (codes[dev] || '').trim()
    setMsg((m) => ({ ...m, [dev]: '核对中…' }))
    const r = await la.truedepth.pair(dev, code)
    setMsg((m) => ({ ...m, [dev]: r.ok ? '✅ 配好了' : `❌ ${r.error}` }))
    if (r.ok) toast(`已和「${r.name}」配对`, 'ok')
  }

  const online = new Set(st?.devices.map((d) => d.dev))
  const offline = (st?.paired || []).filter((p) => !online.has(p.dev))
  return (
    <div className="card td-card">
      <div className="small">
        {st?.listening ? (
          <>
            这台 Mac 在手机上叫 <b title={`端口 ${st.port}`}>「{st.name}」</b>
          </>
        ) : st?.error ? (
          <span className="warn-text">收不了 iPhone 数据：{st.error}</span>
        ) : (
          '正在准备…'
        )}
      </div>
      {st?.devices.map((d) => (
        <div key={d.dev} className="td-dev">
          <div className="grow">
            <b>{d.name}</b>
            {d.model && <span className="dim small"> · {d.model}</span>}
            <div className="small dim">
              {d.paired
                ? `${st.active === d.dev ? '正在用' : '已配对'}，${d.tracked ? '看得到脸' : '看不到脸'}${d.loss > 0.01 ? '，网络不太稳' : ''}${d.therm && d.therm >= 2 ? '，手机有点热' : ''}`
                : d.badCode
                  ? '手机上换过配对码，要重新输入'
                  : '输入手机上的 4 位配对码'}
            </div>
          </div>
          {d.paired ? (
            <button className="btn sm ghost" onClick={() => la.truedepth.unpair(d.dev)}>
              取消配对
            </button>
          ) : (
            <>
              <input
                className="td-code"
                inputMode="numeric"
                maxLength={4}
                placeholder="配对码"
                value={codes[d.dev] || ''}
                onChange={(e) => setCodes((c) => ({ ...c, [d.dev]: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
                onKeyDown={(e) => e.key === 'Enter' && pair(d.dev)}
              />
              <button className="btn sm primary" disabled={(codes[d.dev] || '').length !== 4} onClick={() => pair(d.dev)}>
                配对
              </button>
            </>
          )}
          {msg[d.dev] && <div className="small td-msg">{msg[d.dev]}</div>}
        </div>
      ))}
      {st?.listening && !st.devices.length && (
        <p className="dim small">还没找到手机。iPhone 上打开 Glint Eye，点「{st.name}」，两边要连同一个 Wi‑Fi 或热点。</p>
      )}
      {offline.map((p) => (
        <div key={p.dev} className="td-dev">
          <div className="grow">
            <b>{p.name}</b>
            <div className="small dim">已配对，不在线</div>
          </div>
          <button className="btn sm ghost" onClick={() => la.truedepth.unpair(p.dev)}>
            取消配对
          </button>
        </div>
      ))}
    </div>
  )
}

function ModelSelect({ s, value, onChange }: { s: Settings; value: ModelRef; onChange: (m: ModelRef) => void }): React.JSX.Element {
  const opts = s.providers.flatMap((p) => p.models.map((m) => ({ v: `${p.id}::${m}`, label: `${p.name} · ${m}${p.apiKey ? '' : '（没填 Key）'}` })))
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
      if (ui.settingsTab) {
        setTab(ui.settingsTab)
        uiStore.patch({ settingsTab: null })
      }
    }
  }, [ui.showSettings])

  // 设置里选着 iPhone 原深感时先开着接收，手机才搜得到这台 Mac、才能配对
  const wantTd = ui.showSettings && draft?.gaze.source === 'truedepth'
  useEffect(() => {
    if (!wantTd) return
    la.truedepth.enable('pairing', true)
    return () => {
      la.truedepth.enable('pairing', false)
    }
  }, [wantTd])

  if (!ui.showSettings || !draft) return null

  const set = (p: Partial<Settings>) => setDraft({ ...draft, ...p })
  const close = async (save: boolean) => {
    if (save) {
      const before = cur?.gaze
      await updateSettings(() => draft)
      gaze.setSmoothing(draft.gaze.smoothing)
      // 换了输入源就按新的重启；原深感换了摆放位置，要重新校准才准
      if (before && before.source !== draft.gaze.source) {
        await gaze.start(draft.gaze.cameraId || undefined)
        toast(draft.gaze.source === 'truedepth' ? '换成 iPhone 原深感了' : '换回 Mac 摄像头了', 'ok')
        if (!gaze.isCalibrated()) toast('这个输入源还没校准，点右上角「校准」', 'info', { ttl: 6000 })
      } else {
        if (before && draft.gaze.source === 'truedepth' && before.tdMount !== draft.gaze.tdMount) toast('手机换了位置，要重新校准', 'warn')
        toast('已保存', 'ok')
      }
    }
    uiStore.patch({ showSettings: false })
  }
  const td = draft.gaze.source === 'truedepth'

  return (
    <div className="modal-mask" onClick={() => close(true)}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        {/* 标签栏吸顶，底色不透明：往下滚时表单不会从它底下透出来 */}
        <div className="settings-head">
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
          </div>
          <button className="btn sm primary" onClick={() => close(true)}>
            保存并关闭
          </button>
        </div>

        <div className="settings-body">
          {tab === 'providers' && (
            <>
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
                回答
                <ModelSelect s={draft} value={draft.chatModel} onChange={(m) => set({ chatModel: m })} />
              </label>
              <label>
                翻译
                <ModelSelect s={draft} value={draft.fastModel} onChange={(m) => set({ fastModel: m })} />
              </label>
              <label>
                看图
                <ModelSelect s={draft} value={draft.visionModel} onChange={(m) => set({ visionModel: m })} />
              </label>
            </div>
          )}

          {tab === 'jev' && (
            <div className="form">
              <label>
                预设
                <select
                  value=""
                  onChange={(e) => {
                    const pr = presets.find((x) => x.name === e.target.value)
                    if (pr) set({ jev: { ...draft.jev, baseUrl: pr.baseUrl, model: pr.model } })
                  }}
                >
                  <option value="">选一个，自动填地址和模型</option>
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
                每天 token 上限
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
                    setJevTest(r.ok ? `✅ 通了，${r.ms}ms` : `❌ ${r.error}`)
                  }}
                >
                  测试 Jev
                </button>
                <span className="small dim">{jevTest}</span>
              </div>
              <label className="check">
                <input type="checkbox" checked={draft.jevMode} onChange={(e) => set({ jevMode: e.target.checked })} />
                开启 Jev 模式
              </label>
            </div>
          )}

          {tab === 'gaze' && (
            <div className="form">
              <label>
                输入源
                <select
                  value={draft.gaze.source}
                  onChange={(e) => set({ gaze: { ...draft.gaze, source: e.target.value as Settings['gaze']['source'] } })}
                >
                  <option value="webcam">Mac 摄像头</option>
                  <option value="truedepth">iPhone 原深感</option>
                </select>
              </label>
              {td ? (
                <>
                  <label>
                    iPhone 放在哪
                    <select value={draft.gaze.tdMount} onChange={(e) => set({ gaze: { ...draft.gaze, tdMount: e.target.value as TdMount } })}>
                      {(Object.keys(MOUNT_LABEL) as TdMount[]).map((k) => (
                        <option key={k} value={k}>
                          {MOUNT_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <TdPairing />
                </>
              ) : (
                <>
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
                </>
              )}
              <label>
                校准点数
                <select
                  value={draft.gaze.calibrationPoints}
                  onChange={(e) => set({ gaze: { ...draft.gaze, calibrationPoints: Number(e.target.value) as 9 | 17 } })}
                >
                  <option value={17}>17 个点，更准</option>
                  <option value={9}>9 个点，更快</option>
                </select>
              </label>
              <label>
                平滑 {Math.round(draft.gaze.smoothing * 100)}%
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
                吸附 {Math.round((draft.gaze.magnet ?? 0.7) * 100)}%
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
                盯着页底自动翻页
              </label>
              {!td && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.gaze.headComp !== false}
                    onChange={(e) => set({ gaze: { ...draft.gaze, headComp: e.target.checked } })}
                  />
                  头动补偿
                </label>
              )}
              <div className="row">
                <button
                  className="btn sm"
                  onClick={async () => {
                    await updateSettings(() => draft)
                    await gaze.start(draft.gaze.cameraId || undefined)
                    toast(td ? '切到 iPhone 了，等手机连上' : '摄像头重启了', 'ok')
                  }}
                >
                  {td ? '开始接收 iPhone' : '重启摄像头'}
                </button>
                <button className="btn sm ghost" onClick={() => gaze.resetDrift()}>
                  清除漂移校正
                </button>
                <button className="btn sm ghost" onClick={() => gaze.clearModel()}>
                  删除{g.source === 'truedepth' ? '原深感' : '摄像头'}校准
                </button>
              </div>

              <h3 className="settings-sub">实时小人</h3>
              <label className="check">
                <input type="checkbox" checked={draft.avatar.show} onChange={(e) => set({ avatar: { ...draft.avatar, show: e.target.checked } })} />
                显示实时小人
              </label>
              <div className="row">
                <label className="grow">
                  用哪个百炼 Key
                  <select value={draft.avatar.providerId} onChange={(e) => set({ avatar: { ...draft.avatar, providerId: e.target.value } })}>
                    {draft.providers
                      .filter((p) => /aliyuncs\.com/.test(p.baseUrl))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.apiKey ? '' : '（没填 Key）'}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="grow">
                  模型
                  <select value={draft.avatar.model} onChange={(e) => set({ avatar: { ...draft.avatar, model: e.target.value } })}>
                    {(AVATAR_MODELS.some(([m]) => m === draft.avatar.model) ? AVATAR_MODELS : [[draft.avatar.model, draft.avatar.model], ...AVATAR_MODELS]).map(
                      ([m, label]) => (
                        <option key={m} value={m}>
                          {label}
                        </option>
                      )
                    )}
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
                  {av.busy ? '正在生成…' : av.img ? '重新拍一张' : '拍照生成小人'}
                </button>
                {av.img && (
                  <button className="btn sm ghost" onClick={() => clearAvatar()}>
                    删掉小人
                  </button>
                )}
              </div>
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
