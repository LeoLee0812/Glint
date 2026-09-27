import { input, type ButtonEvent } from './joycon'
import { focus, panes, switchSide, sideOfPane } from '../focus/focus'
import type { Dir, PaneAdapter } from '../focus/types'
import { gaze } from '../gaze/engine'
import { ask, abort, chatStore, addNote, popFork } from '../chat/chatStore'
import { activeDoc, cycleDoc } from '../panes/docs'
import { terminals, KEYS, type TermHandle } from '../panes/TerminalPane'
import { la, uiStore, settingsStore, updateSettings, toast, rumble, setUiMode, screenToClient } from '../appState'
import { onDwell, setSuggestHandler, setTerminalAlertHandler, setFactHandler, jevEnabled, looksLikePermissionPrompt, riskGate } from '../jev/jevBrain'
import { docsStore } from '../panes/docs'

// 按键路由：左手 Joy-Con 管左边（滚动、翻页、终端按键、对 Qwen Code 说话），
// 右手 Joy-Con 管右边（微调焦点、解释/翻译/总结、按住问 AI）
// − / + 决定视线跟哪一边：− 左边内容，+ 右边 AI 回答（右边问到的解释往下裂变出一个窗口）

function leftAdapter(): PaneAdapter | null {
  const d = activeDoc()
  return d ? panes.get(`doc:${d.id}`) : null
}

/** 没有焦点时，滚动 / 翻页落到视线跟着的那一侧 */
function sidePane(): PaneAdapter | null {
  return uiStore.get().side === 'right' ? panes.get('chat') : leftAdapter()
}

/** 左边当前是终端，且视线跟着左边 → 十字键当方向键用 */
function activeTerminal(): TermHandle | null {
  const d = activeDoc()
  if (!d || d.kind !== 'terminal' || uiStore.get().mode === 'global' || uiStore.get().side === 'right') return null
  const fp = focus.state.get().paneId
  if (sideOfPane(fp) === 'right') return null
  return terminals.get(d.id) || null
}

/** 用户按 A/X/Y 时多半正看着硬焦点——拿这一刻当一次隐式校准，越用越准 */
function implicitCalibrate(): void {
  if (!gaze.isCalibrated() || focus.state.get().mode !== 'hard') return
  const target = focus.focusCenterScreen()
  const pred = gaze.recentPrediction(450)
  if (!target || !pred) return
  if (Math.hypot(target.x - pred.x, target.y - pred.y) < 320) gaze.addResidual(target, pred, 0.6)
}

function driftCorrect(): void {
  if (!gaze.isCalibrated()) {
    toast('还没校准：长按 −（或右上角「校准」）先做一次完整校准', 'warn')
    return
  }
  const st = focus.state.get()
  const target = st.mode === 'hard' ? focus.focusCenterScreen() : null
  const pred = gaze.recentPrediction(500)
  if (target && pred) {
    gaze.addResidual(target, pred, 2)
    toast(`漂移已校正：以焦点「${st.label}」为准`, 'ok')
    rumble('done')
    return
  }
  // 没有硬焦点：看屏幕中心的点做一次单点校正
  uiStore.patch({ showCalibration: true, calibrationKind: 'drift' })
}

function toggleJev(): void {
  const s = settingsStore.get().s
  if (!s) return
  if (!s.jev.apiKey) {
    toast('Jev 还没配置 Key，去设置里填', 'warn')
    uiStore.patch({ showSettings: true })
    return
  }
  const on = !s.jevMode
  updateSettings((x) => ({ ...x, jevMode: on }))
  toast(on ? 'Jev 模式开：先判断，再开口' : 'Jev 模式关', on ? 'jev' : 'info')
  rumble(on ? 'done' : 'soft', 'R')
}

function toggleAutoScroll(): void {
  const on = !settingsStore.get().s?.gaze.autoScroll
  updateSettings((x) => ({ ...x, gaze: { ...x.gaze, autoScroll: on } }))
  toast(on ? '眼动翻页：开（盯着底部 2 秒自动往下翻）' : '眼动翻页：关', 'info')
}

// ---------- 语音 ----------

let asrTarget: 'chat' | 'terminal' = 'chat'
let asrTerminal: TermHandle | null = null

function startVoice(target: 'chat' | 'terminal'): void {
  asrTarget = target
  asrTerminal = target === 'terminal' ? activeTerminal() : null
  chatStore.patch({ asr: { active: true, text: '', target } })
  la.bridge.send({ cmd: 'asr_start', lang: 'zh-CN', target })
  rumble('soft', target === 'terminal' ? 'L' : 'R')
}

function stopVoice(): void {
  if (!chatStore.get().asr.active) return
  la.bridge.send({ cmd: 'asr_stop' })
}

la.bridge.onEvent((e) => {
  if (e.t !== 'asr') return
  if (e.state === 'partial') chatStore.patch({ asr: { ...chatStore.get().asr, text: e.text || '' } })
  else if (e.state === 'error') {
    chatStore.patch({ asr: { active: false, text: '', target: asrTarget } })
    const tips: Record<string, [string, 'speech' | 'microphone' | null]> = {
      speech_denied: ['语音识别没授权：系统设置 → 隐私与安全性 → 语音识别，给 LookAsk 打开', 'speech'],
      mic_denied: ['麦克风没授权：系统设置 → 隐私与安全性 → 麦克风，给 LookAsk 打开', 'microphone'],
      recognizer_unavailable: ['系统语音识别暂不可用（中文听写需要联网下载一次模型）', null]
    }
    const [msg, pane] = tips[e.error || ''] || [`语音出错：${e.error}`, null]
    toast(msg, 'error', { ttl: 8000, action: pane ? { label: '打开设置', run: () => la.perm.openSettings(pane) } : undefined })
  } else if (e.state === 'final') {
    const text = (e.text || '').trim()
    chatStore.patch({ asr: { active: false, text: '', target: asrTarget } })
    if (!text) return
    if (asrTarget === 'terminal' && asrTerminal) {
      // 只打字不回车，确认无误再按十字键 → 回车
      asrTerminal.write(text)
      toast('已输入到终端，按十字键 → 发送', 'info')
    } else {
      implicitCalibrate()
      ask('ask', { question: text })
    }
  }
})

// ---------- 按键 ----------

function onButton(e: ButtonEvent): void {
  const u = uiStore.get()
  if (u.showCalibration || u.showSettings || u.showHelp || u.showBooth) return
  const term = activeTerminal()

  if (!e.down) {
    if (e.btn === 'ZR' || e.btn === 'ZL') stopVoice()
    const short = (e.heldMs ?? 0) < 650
    if (e.btn === 'Home' && short) la.win.toggleVisible()
    // − 短按：视线切回左边；已经在左边时还是老功能（终端里 ⇧Tab，其余漂移校正）
    if (e.btn === 'Minus' && short) {
      if (u.side !== 'left') switchSide('left')
      else if (term) term.write(KEYS.shiftTab)
      else driftCorrect()
    }
    // + 短按：视线切到右边的 AI 回答
    if (e.btn === 'Plus' && short) {
      if (u.side !== 'right') switchSide('right')
      else toast('视线已经跟着右边的回答（− 回左边，长按 + 开关 Jev）', 'info')
    }
    return
  }

  if (e.long) {
    if (e.btn === 'Minus') uiStore.patch({ showCalibration: true, calibrationKind: 'full' })
    if (e.btn === 'Plus') toggleJev()
    if (e.btn === 'Home' && uiStore.get().mode === 'global') {
      setUiMode('normal')
      toast('已回到普通模式', 'info')
    }
    return
  }

  switch (e.btn) {
    // ----- 右手：对话 -----
    case 'A':
      implicitCalibrate()
      ask('explain')
      rumble('tick', 'R')
      break
    case 'X':
      implicitCalibrate()
      ask('translate')
      rumble('tick', 'R')
      break
    case 'Y':
      implicitCalibrate()
      ask('summarize')
      rumble('tick', 'R')
      break
    case 'B':
      if (chatStore.get().busy) abort()
      else if (focus.state.get().mode === 'hard') focus.release()
      // 右侧模式：B 一层层收起往下裂变出的解释窗口
      else if (u.side === 'right' && popFork()) rumble('soft', 'R')
      else focus.release()
      break
    case 'R':
      focus.cycleGran()
      rumble('soft', 'R')
      break
    case 'RS':
      focus.snapToGaze(true)
      rumble('soft', 'R')
      break
    case 'ZR':
      startVoice('chat')
      break

    // ----- 左手：内容 -----
    case 'ZL':
      startVoice(term ? 'terminal' : 'chat')
      break
    case 'L':
      cycleDoc(1)
      break
    case 'LS':
      toggleAutoScroll()
      break
    case 'Up':
    case 'Down':
      if (term) term.write(e.btn === 'Up' ? KEYS.up : KEYS.down)
      else focus.stepBlock(e.btn === 'Up' ? 'up' : 'down')
      break
    case 'Right':
      if (term) approveInTerminal(term)
      else (focus.activePane() || sidePane())?.page?.(1)
      break
    case 'Left':
      if (term) term.write(KEYS.esc)
      else (focus.activePane() || sidePane())?.page?.(-1)
      break
    case 'Capture':
      implicitCalibrate()
      ask('capture')
      rumble('tick', 'L')
      break
  }
}

input.onButton(onButton)

// ---------- 放行 Qwen Code：Jev 先评风险，危险操作要再按一次 ----------

let pendingApprove = 0

async function approveInTerminal(term: TermHandle): Promise<void> {
  const screen = term.screenText()
  if (!jevEnabled() || !looksLikePermissionPrompt(screen)) {
    term.write(KEYS.enter)
    rumble('tick', 'L')
    return
  }
  // 5 秒内第二次按 → 用户已经看过警告，直接放行
  if (Date.now() - pendingApprove < 5000) {
    pendingApprove = 0
    term.write(KEYS.enter)
    rumble('tick', 'L')
    return
  }
  const r = await riskGate(screen)
  if (!r || !r.risky) {
    term.write(KEYS.enter)
    rumble('tick', 'L')
    if (r) addNote(`✅ Jev 看过了：${r.reason}，已放行`, [r.trace])
    return
  }
  pendingApprove = Date.now()
  rumble('alert', 'L')
  addNote(`⚠️ Jev 判断这个操作有风险（${r.reason}）。确定要放行，5 秒内再按一次十字键 →；不放行按 ← 打断`, [r.trace])
  toast(`⚠️ 有风险（${r.reason}）：5 秒内再按一次 → 才放行`, 'warn', { ttl: 5000 })
}

// ---------- 摇杆（连续量）+ 眼动翻页 ----------

let repeatDir: Dir | null = null
let nextRepeat = 0
let repeatN = 0
let pageArmed = true
let bottomSince = 0
let autoCooldown = 0

function scrollTarget(): PaneAdapter | null {
  const p = focus.activePane()
  if (p && p.id !== 'screen') return p
  return sidePane()
}

function tick(t: number): void {
  const busyUi = uiStore.get().showCalibration || uiStore.get().showSettings
  if (!busyUi) {
    const s = input.sticks()
    // 左摇杆：上下滚动（推得越深越快），左右翻页
    if (Math.abs(s.ly) > 0.08) {
      const v = Math.sign(s.ly) * Math.pow(Math.abs(s.ly), 1.7) * 26
      scrollTarget()?.scrollBy(-v)
    }
    if (Math.abs(s.lx) > 0.75 && pageArmed && Math.abs(s.lx) > Math.abs(s.ly)) {
      pageArmed = false
      scrollTarget()?.page?.(Math.sign(s.lx))
    }
    if (Math.abs(s.lx) < 0.3) pageArmed = true

    // 右摇杆：一步一步挪焦点，按住会加速连发
    const mag = Math.hypot(s.rx, s.ry)
    if (mag > 0.5) {
      const dir: Dir = Math.abs(s.rx) > Math.abs(s.ry) ? (s.rx > 0 ? 'right' : 'left') : s.ry > 0 ? 'up' : 'down'
      if (dir !== repeatDir) {
        repeatDir = dir
        repeatN = 0
        focus.step(dir)
        nextRepeat = t + 380
      } else if (t >= nextRepeat) {
        repeatN++
        focus.step(dir)
        nextRepeat = t + Math.max(55, 160 - repeatN * 14)
      }
    } else if (mag < 0.3) repeatDir = null

    autoScroll(t)
  }
  requestAnimationFrame(tick)
}

/** 眼动翻页：视线停在正文底部 2 秒，自动往下翻半屏 */
function autoScroll(t: number): void {
  if (!settingsStore.get().s?.gaze.autoScroll || uiStore.get().mode === 'global') return
  const sm = gaze.lastSample?.smooth
  if (!sm || !gaze.lastSample?.raw) {
    bottomSince = 0
    return
  }
  const p = screenToClient(sm.x, sm.y)
  const pane = panes.at(p.x, p.y)
  const el = pane?.element()
  if (!pane || !el || (pane.kind !== 'markdown' && pane.kind !== 'pdf')) {
    bottomSince = 0
    return
  }
  const r = el.getBoundingClientRect()
  const nearBottom = p.y > r.bottom - r.height * 0.15 && p.y < r.bottom + 60
  if (!nearBottom || el.scrollTop + el.clientHeight >= el.scrollHeight - 4) {
    bottomSince = 0
    return
  }
  if (!bottomSince) bottomSince = t
  else if (t - bottomSince > 2000 && t > autoCooldown) {
    el.scrollBy({ top: r.height * 0.5, behavior: 'smooth' })
    autoCooldown = t + 2500
    bottomSince = 0
  }
}

requestAnimationFrame(tick)

// ---------- Jev 接线 ----------

focus.events.on('dwell', (d) => {
  if (!jevEnabled()) return
  const doc = docsStore.get().docs.find((x) => `doc:${x.id}` === d.paneId)
  onDwell(d, { aiReply: sideOfPane(d.paneId) === 'right' || !!doc?.title.startsWith('AI 回复') })
})

setFactHandler(({ trace, risk }) => {
  addNote(`🔍 你盯着的这句带具体数字 / 出处，Jev 觉得可能不准（幻觉风险 ${risk.toFixed(1)}/2），建议核实一下原始来源。`, [trace])
  rumble('soft', 'R')
})

setSuggestHandler(({ text, trace, analysis }) => {
  addNote(`💡 Jev 觉得你可能卡在这段了（难度 ${analysis.difficulty.toFixed(1)}/3${analysis.jargon > 0.6 ? '，含术语' : ''}）。按 A 让我拆解。`, [trace])
  rumble('soft', 'R')
  toast('Jev：这段好像有点难，按 A 我帮你拆解', 'jev', { ttl: 5000, action: { label: '拆解', run: () => ask('explain') } })
  void text
})

setTerminalAlertHandler(({ state, trace }) => {
  const lookingAtTerm = focus.state.get().paneId?.startsWith('doc:') && activeDoc()?.kind === 'terminal'
  const text =
    state === 'waiting_permission'
      ? '⏳ Qwen Code 在等你批准操作：十字键选选项，→ 放行（Jev 会先评风险）'
      : state === 'stuck'
        ? '🔁 Qwen Code 好像在原地打转（同样的失败反复出现）：按 ← 打断，或按住 ZL 给它换个思路'
        : '❓ Qwen Code 在问你问题：按住 ZL 直接说给它听'
  addNote(text, [trace])
  if (!lookingAtTerm) {
    rumble('alert', 'L')
    toast(state === 'waiting_permission' ? 'Qwen Code 在等你拍板' : state === 'stuck' ? 'Qwen Code 可能卡住了' : 'Qwen Code 在问你问题', 'jev', { ttl: 6000 })
  }
})
