import { createStore, Emitter } from '../store'
import { boundsStore, screenToClient, clientToScreen, uiStore, la, settingsStore, toast, dismissToast, rumble, type Side } from '../appState'
import { gaze } from '../gaze/engine'
import type { Fixation } from '../gaze/filters'
import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection } from './types'
import { GRAN_ORDER, GRAN_LABEL, unionBox } from './types'
import { magnetNow, snapParams } from './snap'

// 焦点控制器：把「眼睛大概在看哪」变成「具体指着哪段文字」
// - 软焦点：跟着注视点走，默认按段高亮（摄像头眼动只能到段落级）
// - 硬焦点：一推右摇杆就从软焦点落点起步，逐词 / 逐行精确移动，不再被视线带跑
// - 再看向别处超过 0.8 秒，或按右摇杆按下，就回到跟随视线
// - 左右两侧分开：左手柄 − = 视线只跟左边内容，右手柄 + = 视线只跟右边的 AI 回答，
//   看另一边时焦点原地不动，不会在两栏之间来回乱飘
// - 吸附（强度在设置 → 眼动）：软焦点出了当前这段一点点还算这段；光环吸住一个词时，推 / 按右摇杆直接落在那个词上

/** 视线落在这一侧外面多远以内，还算这一侧（拉回边上）；再远就当在看另一边 */
const SIDE_MARGIN = 70

/** 视图属于哪一侧：对话区和它下面裂变出的解释窗口在右边，其余（文档、终端、全局屏幕）在左边 */
export function sideOfPane(id: string | null | undefined): Side | null {
  if (!id) return null
  return id === 'chat' || id === 'fork' ? 'right' : 'left'
}

const regionEls: Partial<Record<Side, Element>> = {}

/** 这一侧在屏幕上的范围（屏幕坐标）；全局模式的左侧 = 整块屏幕去掉右边的侧边栏 */
export function sideRegion(side: Side): Box | null {
  const b = boundsStore.get()
  if (b.mode === 'global' && side === 'left') {
    const d = b.display
    const w = b.content.x - d.x
    return w > 100 ? { x: d.x, y: d.y, width: w, height: d.height } : { ...d }
  }
  let el = regionEls[side]
  if (!el?.isConnected) {
    el = document.querySelector(side === 'left' ? '.left-wrap' : 'section.right') || undefined
    regionEls[side] = el
  }
  const r = el?.getBoundingClientRect()
  if (!r || !r.width || !r.height) return null
  const p = clientToScreen(r.left, r.top)
  return { x: p.x, y: p.y, width: r.width, height: r.height }
}

/** 把屏幕坐标的点归到某一侧：在范围里原样返回；溢出 margin 以内的拉回边上；再远就是 null */
export function toSide(p: { x: number; y: number }, side: Side = uiStore.get().side, margin = SIDE_MARGIN): { x: number; y: number } | null {
  const r = sideRegion(side)
  if (!r) return null
  const inset = 4
  const x = Math.min(r.x + r.width - inset, Math.max(r.x + inset, p.x))
  const y = Math.min(r.y + r.height - inset, Math.max(r.y + inset, p.y))
  if (Math.hypot(x - p.x, y - p.y) > margin) return null
  return margin > 0 ? { x, y } : { x: p.x, y: p.y }
}

/** 窗口坐标的点在不在这一侧（给视线光环用：不在就不画） */
export function clientInSide(x: number, y: number, side: Side = uiStore.get().side, margin = 0): boolean {
  return !!toSide(clientToScreen(x, y), side, margin)
}

/**
 * 眼睛跑到另一侧时，视线光环往哪儿滑走（屏幕坐标）：朝眼睛去的方向一直滑出 bounds（主窗口或整块屏幕），边走边淡，
 * 内容模式往右看就往右滑到最右边，回答模式往左看就往左滑走；高度跟着眼睛
 */
export function exitPoint(p: { x: number; y: number }, side: Side, bounds: Box): { x: number; y: number } {
  const r = sideRegion(side)
  if (!r) return p
  const x = p.x > r.x + r.width ? bounds.x + bounds.width + 60 : p.x < r.x ? bounds.x - 60 : p.x
  return { x, y: p.y }
}

export interface FocusState {
  mode: 'none' | 'soft' | 'hard'
  gran: Granularity
  paneId: string | null
  sel: Selection | null
  label: string
  /** 最近一次焦点变化的时间（performance.now） */
  at: number
}

export interface BlockDwell {
  paneId: string
  blockKey: string
  text: string
  dwellMs: number
  visits: number
  lastSeen: number
}

class PaneRegistry {
  private map = new Map<string, PaneAdapter>()
  register(p: PaneAdapter): () => void {
    this.map.set(p.id, p)
    return () => {
      if (this.map.get(p.id) === p) this.map.delete(p.id)
    }
  }
  get(id: string | null): PaneAdapter | null {
    return id ? this.map.get(id) || null : null
  }
  /** 在某一侧（默认当前这一侧）找包含该点的视图；全局模式的左侧永远是屏幕适配器（屏幕坐标），其余用窗口坐标 */
  at(x: number, y: number, side: Side = uiStore.get().side): PaneAdapter | null {
    if (uiStore.get().mode === 'global' && side === 'left') return this.map.get('screen') || null
    for (const p of this.map.values()) {
      if (p.id === 'screen' || sideOfPane(p.id) !== side) continue
      const el = p.element()
      if (!el || !el.isConnected) continue
      const r = el.getBoundingClientRect()
      if (r.width && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return p
    }
    return null
  }
}

export const panes = new PaneRegistry()

class FocusController {
  state = createStore<FocusState>({ mode: 'none', gran: 'paragraph', paneId: null, sel: null, label: '', at: 0 })
  events = new Emitter<{ dwell: BlockDwell; changed: FocusState }>()

  private anchor: Anchor | null = null
  private pane: PaneAdapter | null = null
  private awayFix: { fix: Fixation; since: number } | null = null
  private dwell = new Map<string, BlockDwell>()
  private currentBlock: string | null = null
  private lastFixUpdate = 0
  /** 切到另一侧前记下这一侧的焦点，切回来时还原 */
  private memory: Record<Side, { pane: PaneAdapter; anchor: Anchor; mode: 'soft' | 'hard'; gran: Granularity } | null> = {
    left: null,
    right: null
  }

  constructor() {
    gaze.events.on('fixStart', (f) => this.onFix(f, true))
    gaze.events.on('fixUpdate', (f) => this.onFix(f, false))
  }

  // ---------- 视线驱动 ----------

  /** 屏幕坐标 → 当前这一侧视图用的坐标：全局模式的左侧（整块屏幕）就用屏幕坐标，其余换成主窗口坐标 */
  private paneSpace(s: { x: number; y: number }): { x: number; y: number } {
    const ui = uiStore.get()
    return ui.mode === 'global' && ui.side === 'left' ? { x: s.x, y: s.y } : screenToClient(s.x, s.y)
  }

  /** 眼睛（没有可用眼动就用鼠标）此刻落在当前这一侧的哪里，按视图坐标给；在看另一边就是 null */
  private pointNow(): { x: number; y: number } | null {
    const g = gazeUsable() ? gaze.lastSample?.smooth : null
    const scr = g ?? (lastMouse ? clientToScreen(lastMouse.x, lastMouse.y) : null)
    if (!scr) return null
    const s = toSide(scr, uiStore.get().side, g ? SIDE_MARGIN : 0)
    return s ? this.paneSpace(s) : null
  }

  private onFix(f: Fixation, isStart: boolean): void {
    if (uiStore.get().showCalibration) return
    const now = performance.now()
    if (!isStart && now - this.lastFixUpdate < 450) return
    // 只在当前这一侧找焦点：看另一边时焦点原地不动
    const s = toSide(f)
    if (!s) return
    this.lastFixUpdate = now
    this.applyFix(this.paneSpace(s), f)
  }

  /** 没有可用眼动时，鼠标停住就当一次注视（演示、没校准时也能完整用） */
  pointerFix(x: number, y: number): void {
    if (uiStore.get().showCalibration || uiStore.get().mode === 'global') return
    // 鼠标是精确指向，不做贴边吸附：停在另一边就不算
    if (!clientInSide(x, y)) return
    this.pointerSeq++
    this.applyFix({ x, y }, { id: -this.pointerSeq, x, y, start: performance.now() - 400, duration: 400 })
  }

  private pointerSeq = 0

  private applyFix(p: { x: number; y: number }, f: Fixation): void {
    const now = performance.now()
    const st = this.state.get()
    if (st.mode === 'hard' && st.sel) {
      const u = unionBox(st.sel.rects)
      const far = !u || Math.hypot(p.x - (u.x + u.width / 2), p.y - (u.y + u.height / 2)) > 320
      if (!far) {
        this.awayFix = null
        return
      }
      // 看向别处要持续一会儿才放弃硬焦点，免得扫一眼回答区就丢了位置
      if (!this.awayFix || this.awayFix.fix.id !== f.id) this.awayFix = { fix: f, since: now }
      if (f.duration < 800 && f.id > 0) return
      if (f.id < 0) return
      this.awayFix = null
    }
    // 眼动抖到段外一点点不跳段（鼠标是精确指向，不做这个）
    if (f.id > 0 && this.holdsSoft(p)) {
      this.trackDwell(f)
      return
    }
    const pane = panes.at(p.x, p.y)
    if (!pane) return
    const a = pane.anchorAt(p.x, p.y)
    if (!a) return
    this.pane = pane
    this.anchor = a
    this.update('soft', 'paragraph')
    this.trackDwell(f)
  }

  /** 软焦点的迟滞：视线落在当前这段外面、但没超出吸附边距，就还算这段 */
  private holdsSoft(p: { x: number; y: number }): boolean {
    const st = this.state.get()
    if (st.mode !== 'soft' || st.sel?.space !== 'client') return false
    const u = unionBox(st.sel.rects)
    if (!u) return false
    // 在这段里面照常更新锚点（推摇杆时从视线处起步）
    if (p.x >= u.x && p.x <= u.x + u.width && p.y >= u.y && p.y <= u.y + u.height) return false
    const m = snapParams().stick
    return p.x >= u.x - m && p.x <= u.x + u.width + m && p.y >= u.y - m && p.y <= u.y + u.height + m
  }

  /** 光环正吸着一个词（刚更新过、吸得够牢）→ 硬焦点直接落在这个词上 */
  private snapToMagnet(): boolean {
    const m = magnetNow
    if (!m.box || performance.now() - m.at > 500 || m.strength < 0.35) return false
    const x = m.box.x + m.box.width / 2
    const y = m.box.y + m.box.height / 2
    const pane = panes.at(x, y)
    const a = pane?.anchorAt(x, y)
    if (!pane || !a) return false
    this.pane = pane
    this.anchor = a
    this.update('hard', 'word')
    return true
  }

  /** 统计每个段落的停留时长和回看次数（给 Jev 判断读者是不是卡住了） */
  private trackDwell(f: Fixation): void {
    const sel = this.state.get().sel
    if (!sel?.blockKey || !this.pane) return
    const key = `${this.pane.id}:${sel.blockKey}`
    const now = Date.now()
    let d = this.dwell.get(key)
    if (!d) {
      d = { paneId: this.pane.id, blockKey: sel.blockKey, text: sel.text, dwellMs: 0, visits: 0, lastSeen: 0 }
      this.dwell.set(key, d)
    }
    if (this.currentBlock !== key) {
      d.visits++
      this.currentBlock = key
    }
    d.dwellMs += Math.min(f.duration, 600)
    d.lastSeen = now
    d.text = sel.text
    this.events.emit('dwell', { ...d })
    if (this.dwell.size > 400) {
      const oldest = [...this.dwell.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0]
      this.dwell.delete(oldest[0])
    }
  }

  // ---------- 摇杆 / 按键驱动 ----------

  /** 从当前位置（没有就用视线）出发移动一步，进入硬焦点 */
  step(dir: Dir): void {
    const st = this.state.get()
    if (st.mode !== 'hard') {
      // 第一次推摇杆：光环正吸着一个词就落在那个词上；否则原地变成「词」焦点，不动
      if (this.snapToMagnet()) return
      if (!this.anchor) this.snapToGaze(false)
      if (!this.anchor || !this.pane) return
      this.update('hard', 'word')
      return
    }
    if (!this.pane || !this.anchor) return
    const next = this.pane.move(this.anchor, dir)
    if (next) {
      this.anchor = next
      this.update('hard', st.gran === 'paragraph' || st.gran === 'section' ? 'word' : st.gran)
      this.scrollIntoView()
    }
  }

  stepBlock(dir: 'up' | 'down'): void {
    if (!this.anchor || !this.pane?.moveBlock) {
      this.snapToGaze(false)
      if (!this.anchor || !this.pane?.moveBlock) return
    }
    const next = this.pane.moveBlock!(this.anchor!, dir)
    if (next) {
      this.anchor = next
      this.update('hard', 'paragraph')
    }
  }

  cycleGran(): void {
    const st = this.state.get()
    if (!this.anchor) this.snapToGaze(false)
    if (!this.anchor) return
    const i = GRAN_ORDER.indexOf(st.gran)
    const g = GRAN_ORDER[(i + 1) % GRAN_ORDER.length]
    this.update('hard', g)
  }

  snapToGaze(keepHard = true): void {
    // 按右摇杆「跳回视线处」：光环吸着词时就落在那个词上
    if (keepHard && this.snapToMagnet()) return
    const p = this.pointNow()
    if (!p) return
    const pane = panes.at(p.x, p.y)
    const a = pane?.anchorAt(p.x, p.y)
    if (!pane || !a) return
    this.pane = pane
    this.anchor = a
    this.update(keepHard ? 'hard' : 'soft', keepHard ? 'word' : 'paragraph')
  }

  /** 没有眼动时（没校准 / 键盘演示），从某个窗口坐标点起步；明确点到另一边时视线模式跟着切过去 */
  focusAt(x: number, y: number, mode: 'soft' | 'hard' = 'hard'): void {
    const ui = uiStore.get()
    // 全局模式下主窗口只剩侧边栏，窗口里点到的一定是右边的对话
    const side: Side | null = ui.mode === 'global' ? 'right' : panes.at(x, y, 'left') ? 'left' : panes.at(x, y, 'right') ? 'right' : null
    if (!side) return
    if (side !== ui.side) this.setSide(side)
    const pane = panes.at(x, y, side)
    const a = pane?.anchorAt(x, y)
    if (!pane || !a) return
    this.pane = pane
    this.anchor = a
    this.update(mode, mode === 'hard' ? 'word' : 'paragraph')
  }

  /** 切换视线跟哪一边；这一侧的焦点记下来，切回来时还原 */
  setSide(side: Side): void {
    const cur = uiStore.get().side
    if (cur === side) return
    const st = this.state.get()
    this.memory[cur] = this.pane && this.anchor && st.mode !== 'none' ? { pane: this.pane, anchor: this.anchor, mode: st.mode, gran: st.gran } : null
    this.awayFix = null
    uiStore.patch({ side })
    const m = this.memory[side]
    this.memory[side] = null
    // 中间进出过全局模式的话，左边的视图已经换了（文档 ↔ 整块屏幕），旧焦点不能要
    const global = uiStore.get().mode === 'global'
    const fits = m && (m.pane.id === 'screen' ? global : sideOfPane(m.pane.id) === 'right' || !global)
    if (m && fits && panes.get(m.pane.id) === m.pane && m.pane.select(m.anchor, m.gran)) {
      this.pane = m.pane
      this.anchor = m.anchor
      this.update(m.mode, m.gran)
    } else {
      this.clear()
      this.snapToGaze(false)
    }
  }

  release(): void {
    const st = this.state.get()
    if (st.mode === 'hard') this.update('soft', 'paragraph')
    else this.clear()
  }

  clear(): void {
    this.anchor = null
    this.pane = null
    this.state.set({ mode: 'none', gran: 'paragraph', paneId: null, sel: null, label: '', at: performance.now() })
  }

  activePane(): PaneAdapter | null {
    if (this.pane) return this.pane
    const p = this.pointNow()
    return p ? panes.at(p.x, p.y) : null
  }

  private update(mode: 'soft' | 'hard', gran: Granularity): void {
    if (!this.pane || !this.anchor) return
    const sel = this.pane.select(this.anchor, gran)
    // 文字视图里选到空白（终端空行、段落间隙）就不算焦点
    if (sel && !sel.text.trim() && sel.space === 'client') return
    const label = sel ? `${GRAN_LABEL[sel.gran]} · ${sel.text.replace(/\s+/g, ' ').slice(0, 24)}` : ''
    const next: FocusState = { mode, gran: sel?.gran ?? gran, paneId: this.pane.id, sel, label, at: performance.now() }
    this.state.set(next)
    this.events.emit('changed', next)
  }

  /** 内容滚动后重新算高亮框位置（锚点不变） */
  refresh(): void {
    const st = this.state.get()
    if (st.mode === 'none' || !this.pane || !this.anchor) return
    // 视图被切走（标签页隐藏）了，焦点跟着清掉，不然高亮会画到左上角
    const el = this.pane.element()
    if (el && (!el.isConnected || !el.offsetParent)) {
      this.clear()
      return
    }
    const sel = this.pane.select(this.anchor, st.gran)
    if (!sel || (sel.space === 'client' && sel.rects.every((r) => r.width < 1 && r.height < 1))) {
      this.clear()
      return
    }
    const a = st.sel?.rects[0]
    const b = sel.rects[0]
    if (a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && st.sel?.rects.length === sel.rects.length) return
    this.state.set({ ...st, sel })
  }

  private scrollIntoView(): void {
    const sel = this.state.get().sel
    const el = this.pane?.element()
    if (!sel || !el || sel.space !== 'client') return
    const u = unionBox(sel.rects)
    if (!u) return
    const r = el.getBoundingClientRect()
    if (u.y < r.top + 30) this.pane!.scrollBy(u.y - r.top - 60)
    else if (u.y + u.height > r.bottom - 30) this.pane!.scrollBy(u.y + u.height - r.bottom + 60)
  }

  // ---------- 取上下文 ----------

  async context(opts: { withImage?: boolean } = {}): Promise<FocusContext | null> {
    if (!this.pane || !this.anchor) this.snapToGaze(false)
    if (!this.pane || !this.anchor) return null
    const st = this.state.get()
    const ctx = await this.pane.context(this.anchor, st.gran)
    if (opts.withImage && st.sel && this.pane.capture) {
      const u = unionBox(st.sel.rects)
      if (u) {
        const pad = 14
        const img = await this.pane.capture({ x: u.x - pad, y: u.y - pad, width: u.width + pad * 2, height: u.height + pad * 2 })
        if (img) ctx.image = img
      }
    }
    return ctx
  }

  /** 焦点框中心（屏幕坐标），给漂移校正当「真实落点」 */
  focusCenterScreen(): { x: number; y: number } | null {
    const sel = this.state.get().sel
    const u = sel ? unionBox(sel.rects) : null
    if (!u) return null
    const cx = u.x + u.width / 2
    const cy = u.y + u.height / 2
    return sel!.space === 'screen' ? { x: cx, y: cy } : clientToScreen(cx, cy)
  }

  /** 焦点是不是「新鲜」的：硬焦点一直算；软焦点 30 秒没动就当过期，打字提问时不再附带 */
  isFresh(maxAgeMs = 30000): boolean {
    const st = this.state.get()
    if (st.mode === 'hard') return true
    return st.mode === 'soft' && performance.now() - st.at < maxAgeMs
  }

  dwellStats(): BlockDwell[] {
    return [...this.dwell.values()]
  }
}

/** 眼动能用：已校准、摄像头在跑、看得到脸 */
export function gazeUsable(): boolean {
  const st = gaze.status.get()
  return gaze.isCalibrated() && st.state === 'running' && st.face
}

let lastMouse: { x: number; y: number } | null = null

/** 最近一次鼠标位置（窗口坐标）：没有可用眼动时视线光环跟着它走 */
export function mousePos(): { x: number; y: number } | null {
  return lastMouse
}

export const focus = new FocusController()

let sideToast: string | null = null

/** 用户切换视线跟哪一边（手柄 − / +、顶栏按钮）：切过去并提示一句、震一下；来回切时只留最新一条提示 */
export function switchSide(side: Side): void {
  if (uiStore.get().side === side) return
  focus.setSide(side)
  const global = uiStore.get().mode === 'global'
  if (sideToast) dismissToast(sideToast)
  sideToast =
    side === 'right'
      ? toast('视线跟右边的 AI 回答：看到不懂的按 A，解释往下裂变出一个窗口（− 回左边）', 'info', { ttl: 4200 })
      : toast(global ? '视线跟屏幕：看右边回答时焦点不会跑过去（+ 切到回答）' : '视线跟左边内容：看右边回答时焦点不会跑过去（+ 切到回答）', 'info', { ttl: 3600 })
  rumble('soft', side === 'right' ? 'R' : 'L')
}

// 鼠标兜底：没有可用眼动时，鼠标停住 280ms 当一次注视；⌥ + 点击直接落硬焦点
let mouseTimer: ReturnType<typeof setTimeout> | null = null
window.addEventListener(
  'mousemove',
  (e) => {
    lastMouse = { x: e.clientX, y: e.clientY }
    if (gazeUsable()) return
    if (mouseTimer) clearTimeout(mouseTimer)
    mouseTimer = setTimeout(() => lastMouse && focus.pointerFix(lastMouse.x, lastMouse.y), 280)
  },
  { passive: true }
)
window.addEventListener(
  'mousedown',
  (e) => {
    if (!e.altKey || e.button !== 0) return
    e.preventDefault()
    focus.focusAt(e.clientX, e.clientY, 'hard')
  },
  true
)

// 全局模式：把视线和焦点推给透明浮层（视线约 30fps；焦点一变就推）
let lastOverlay = 0
function pushOverlay(force = false): void {
  const ui = uiStore.get()
  if (ui.mode !== 'global') return
  const now = performance.now()
  if (!force && now - lastOverlay < 33) return
  lastOverlay = now
  const st = focus.state.get()
  const u = st.sel ? unionBox(st.sel.rects) : null
  // 右侧模式下焦点在侧边栏的对话里（窗口坐标），换成屏幕坐标交给浮层画
  const box: Box | null = u && st.sel?.space === 'client' ? { ...clientToScreen(u.x, u.y), width: u.width, height: u.height } : u
  const show = settingsStore.get().s?.gaze.showCursor !== false
  const g = gazeUsable() ? gaze.lastSample?.smooth ?? null : null
  // 视线圈只画在当前这一侧；眼睛去了另一侧就朝那边滑走
  const inSide = !!g && !!toSide(g, ui.side, 0)
  la.overlay.update({
    gaze: show && g && inSide ? g : null,
    exit: show && g && !inSide ? exitPoint(g, ui.side, boundsStore.get().display) : null,
    focus: box,
    label: st.mode === 'hard' ? st.label : undefined,
    mode: st.mode === 'hard' ? 'hard' : 'soft'
  })
}
gaze.events.on('sample', () => pushOverlay())
focus.state.subscribe(() => pushOverlay(true))
uiStore.subscribe(() => pushOverlay(true))

// 窗口移动/缩放后高亮要跟着重算
boundsStore.subscribe(() => focus.refresh())
