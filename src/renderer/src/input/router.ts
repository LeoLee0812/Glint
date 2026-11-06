import { input, type ButtonEvent } from './joycon'
import { haptic, hapticCount, homeLight } from './haptics'
import { speechStart, speechStop, onSpeech } from './speech'
import { wristStart, wristEnd, wristActive } from './wrist'
import { focus, panes, switchSide, sideOfPane } from '../focus/focus'
import { GRAN_ORDER, type Dir, type Granularity, type PaneAdapter } from '../focus/types'
import { gaze } from '../gaze/engine'
import { ask, abort, chatStore, popFork } from '../chat/chatStore'
import { activeDoc, cycleDoc } from '../panes/docs'
import { terminals, KEYS, type TermHandle } from '../panes/TerminalPane'
import { la, uiStore, settingsStore, updateSettings, toast, rumble, screenToClient } from '../appState'
import { looksLikePermissionPrompt } from '../panes/agent'
import { docsStore } from '../panes/docs'
import { guideModal } from '../onboarding'

// 按键路由：左手 Joy-Con 管左边（滚动、翻页、终端按键、对终端里的 Qwen Code 说话），
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
  if (!d || d.kind !== 'terminal' || uiStore.get().side === 'right') return null
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

// ---------- 语音 ----------

let asrTarget: 'chat' | 'terminal' = 'chat'
let asrTerminal: TermHandle | null = null

function startVoice(target: 'chat' | 'terminal'): void {
  asrTarget = target
  asrTerminal = target === 'terminal' ? activeTerminal() : null
  chatStore.patch({ asr: { active: true, text: '', target } })
  speechStart(target)
  rumble('soft', target === 'terminal' ? 'L' : 'R')
}

function stopVoice(): void {
  if (!chatStore.get().asr.active) return
  speechStop()
  // 松开 = 发出去了：往下沉一下
  haptic('send', asrTarget === 'terminal' ? 'L' : 'R')
}

/** 语音出错时的提示和「去处理」按钮：系统设置的哪一页，或者 key = 设置里填百炼 Key 那页 */
const ASR_TIPS: Record<string, [string, 'speech' | 'microphone' | 'key' | null]> = {
  speech_denied: ['语音识别没开权限，去系统设置里给 Glint 打开', 'speech'],
  mic_denied:
    la.platform === 'darwin'
      ? ['麦克风没开权限，去系统设置里给 Glint 打开', 'microphone']
      : ['麦克风没开权限：设置 → 隐私和安全性 → 麦克风，打开「让桌面应用访问你的麦克风」', 'microphone'],
  recognizer_unavailable: ['系统语音识别用不了，中文听写要先联网下载一次', null],
  // Windows 走百炼云端识别（src/main/asrCloud.ts）
  no_key: ['说话要用百炼的 Key 转文字，先在设置里填上', 'key'],
  no_mic: ['没找到麦克风', null],
  auth: ['百炼的 Key 不对，语音识别用不了', 'key'],
  connect: ['连不上百炼的语音识别，看看网络和 Key', 'key'],
  network: ['和百炼的连接断了，这句没听全', null],
  timeout: ['百炼的语音识别没回音，再说一次试试', null]
}

onSpeech((e) => {
  if (e.state === 'partial') chatStore.patch({ asr: { ...chatStore.get().asr, text: e.text || '' } })
  else if (e.state === 'error') {
    chatStore.patch({ asr: { active: false, text: '', target: asrTarget } })
    const [msg, pane] = ASR_TIPS[e.error || ''] || [`语音出错：${e.error}`, null]
    const run = pane === 'key' ? () => uiStore.patch({ showSettings: true, settingsTab: 'providers' }) : pane ? () => la.perm.openSettings(pane) : null
    toast(msg, 'error', { ttl: 8000, action: run ? { label: pane === 'key' ? '去填 Key' : '打开设置', run } : undefined })
  } else if (e.state === 'final') {
    const text = (e.text || '').trim()
    chatStore.patch({ asr: { active: false, text: '', target: asrTarget } })
    if (!text) return
    if (asrTarget === 'terminal' && asrTerminal) {
      // 只打字不回车，确认无误再按十字键 → 回车
      asrTerminal.write(text)
      toast('打进终端了，按十字键 → 发送', 'info')
    } else {
      implicitCalibrate()
      ask('ask', { question: text })
    }
  }
})

// ---------- 按键 ----------

function onButton(e: ButtonEvent): void {
  // 右摇杆松开 = 手腕精调结束；放在最前面，中途弹出校准 / 设置也要能收尾
  if (e.btn === 'RS' && !e.down) wristEnd()
  const u = uiStore.get()
  // 弹窗里（包括新手引导的前几步）按键只归弹窗，不去解释、翻译
  if (u.showCalibration || u.showSettings || u.showHelp || u.showBooth || guideModal()) return
  const term = activeTerminal()

  if (!e.down) {
    if (e.btn === 'ZR' || e.btn === 'ZL') stopVoice()
    const short = (e.heldMs ?? 0) < 650
    if (e.btn === 'Home' && short) la.win.toggleVisible()
    // − 短按：视线切回左边；已经在左边时终端里当 ⇧Tab（Qwen Code 里轮换审批模式；− 不再管校准）
    if (e.btn === 'Minus' && short) {
      if (u.side !== 'left') switchSide('left')
      else if (term) term.write(KEYS.shiftTab)
      else toast('已经在左边了，按 + 去右边', 'info')
    }
    // + 短按：视线切到右边的 AI 回答
    if (e.btn === 'Plus' && short) {
      if (u.side !== 'right') switchSide('right')
      else toast('已经在右边了，按 − 回左边', 'info')
    }
    return
  }

  if (e.long) return

  switch (e.btn) {
    // ----- 右手：对话 -----
    case 'A': {
      implicitCalibrate()
      ask('explain')
      rumble('tick', 'R')
      break
    }
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
      // 粒度用几下「咔」表示，不用看屏幕：词 1 下、句 2 下、段 3 下、节 4 下
      hapticCount(GRAN_ORDER.indexOf(focus.state.get().unit) + 1, 'R')
      break
    case 'RS': {
      // 按下 = 焦点跳到视线处；按住不放拧手腕 = 从这里逐词 / 逐行精调，松开落定（input/wrist.ts）
      const g = gaze.status.get()
      if (gaze.isCalibrated() && g.state === 'running' && !g.face) haptic('lost', 'R')
      else rumble('soft', 'R')
      focus.snapToGaze(true)
      if (e.source === 'joycon') wristStart()
      break
    }
    case 'ZR':
      startVoice('chat')
      break

    // ----- 左手：内容（左摇杆按下只在拍大头照窗口里当快门，PhotoBooth 自己接） -----
    case 'ZL':
      startVoice(term ? 'terminal' : 'chat')
      break
    case 'L':
      cycleDoc(1)
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

// ---------- 放行终端里的 Qwen Code ----------

function approveInTerminal(term: TermHandle): void {
  term.write(KEYS.enter)
  rumble('tick', 'L')
}

// ---------- 摇杆（连续量）+ 眼动翻页 ----------

let repeatDir: Dir | null = null
let nextRepeat = 0
let repeatN = 0
let pageArmed = true
/** 右摇杆按住连发的最短间隔倍数（×55ms），按粒度 */
const REPEAT_SLOW: Record<Granularity, number> = { word: 1, sentence: 2, paragraph: 4, section: 5 }
let bottomSince = 0
let autoCooldown = 0

function scrollTarget(): PaneAdapter | null {
  const p = focus.activePane()
  if (p) return p
  return sidePane()
}

function tick(t: number): void {
  const busyUi = uiStore.get().showCalibration || uiStore.get().showSettings || guideModal()
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

    // 右摇杆：一步一步挪焦点，按住会加速连发（连发时每步的「咔」越来越轻）；
    // 按住右摇杆拧手腕时不算，按下去难免把摇杆带歪
    const mag = wristActive() ? 0 : Math.hypot(s.rx, s.ry)
    if (mag > 0.5) {
      const dir: Dir = Math.abs(s.rx) > Math.abs(s.ry) ? (s.rx > 0 ? 'right' : 'left') : s.ry > 0 ? 'up' : 'down'
      if (dir !== repeatDir) {
        repeatDir = dir
        repeatN = 0
        focus.step(dir)
        nextRepeat = t + 380
      } else if (t >= nextRepeat) {
        repeatN++
        focus.step(dir, Math.max(0.5, 1 - repeatN * 0.05))
        // 按句 / 段 / 节走时连发慢一些，一眨眼翻过去好几段就找不着了
        nextRepeat = t + Math.max(55 * REPEAT_SLOW[focus.state.get().gran], 160 - repeatN * 14)
      }
    } else if (mag < 0.3) repeatDir = null

    autoScroll(t)
  }
  requestAnimationFrame(tick)
}

/** 眼动翻页：视线停在正文底部 2 秒，自动往下翻半屏 */
function autoScroll(t: number): void {
  if (!settingsStore.get().s?.gaze.autoScroll) return
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

// ---------- 右手柄 HOME 灯 = AI 状态灯：在想 / 在出字时呼吸，答完（或停掉）就灭 ----------
// 屏幕上配一个：从提问到出第一个字这段「思考」时间，<html> 挂 ai-thinking，右侧顶上那道线变成 Joy-Con 电光紫、跟着呼吸

let aiBusy = false
let aiThinking = false
chatStore.subscribe(() => {
  const st = chatStore.get()
  const busy = !!st.busy
  if (busy !== aiBusy) {
    aiBusy = busy
    homeLight(busy ? 'breathe' : 'off')
  }
  const thinking = busy && [...st.msgs, ...st.fork.map((c) => c.ans)].some((m) => m.status === 'streaming' && !m.text)
  if (thinking !== aiThinking) {
    aiThinking = thinking
    document.documentElement.classList.toggle('ai-thinking', thinking)
  }
})

// ---------- 眼动断了（iPhone 断开 / 摄像头出错）：两只手柄一起「长-短」 ----------

let gazeState = gaze.status.get().state
gaze.status.subscribe(() => {
  const s = gaze.status.get().state
  if (s === 'error' && gazeState === 'running') haptic('lost')
  gazeState = s
})
