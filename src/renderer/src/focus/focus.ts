import { createStore, Emitter } from '../store'
import { boundsStore, screenToClient, clientToScreen, uiStore, la, settingsStore } from '../appState'
import { gaze } from '../gaze/engine'
import type { Fixation } from '../gaze/filters'
import type { Anchor, Box, Dir, FocusContext, Granularity, PaneAdapter, Selection } from './types'
import { GRAN_ORDER, GRAN_LABEL, unionBox } from './types'

// 焦点控制器：把「眼睛大概在看哪」变成「具体指着哪段文字」
// - 软焦点：跟着注视点走，默认按段高亮（摄像头眼动只能到段落级）
// - 硬焦点：一推右摇杆就从软焦点落点起步，逐词 / 逐行精确移动，不再被视线带跑
// - 再看向别处超过 0.8 秒，或按右摇杆按下，就回到跟随视线

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
  /** 找包含该点（窗口坐标）的视图，全局模式下永远是屏幕适配器 */
  at(x: number, y: number): PaneAdapter | null {
    if (uiStore.get().mode === 'global') return this.map.get('screen') || null
    for (const p of this.map.values()) {
      if (p.id === 'screen') continue
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

  constructor() {
    gaze.events.on('fixStart', (f) => this.onFix(f, true))
    gaze.events.on('fixUpdate', (f) => this.onFix(f, false))
  }

  // ---------- 视线驱动 ----------

  private gazeClient(f: { x: number; y: number }): { x: number; y: number } {
    return uiStore.get().mode === 'global' ? { x: f.x, y: f.y } : screenToClient(f.x, f.y)
  }

  private onFix(f: Fixation, isStart: boolean): void {
    if (uiStore.get().showCalibration) return
    const now = performance.now()
    if (!isStart && now - this.lastFixUpdate < 450) return
    this.lastFixUpdate = now
    this.applyFix(this.gazeClient(f), f)
  }

  /** 没有可用眼动时，鼠标停住就当一次注视（演示、没校准时也能完整用） */
  pointerFix(x: number, y: number): void {
    if (uiStore.get().showCalibration || uiStore.get().mode === 'global') return
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
    const pane = panes.at(p.x, p.y)
    if (!pane) return
    const a = pane.anchorAt(p.x, p.y)
    if (!a) return
    this.pane = pane
    this.anchor = a
    this.update('soft', 'paragraph')
    this.trackDwell(f)
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
      if (!this.anchor) this.snapToGaze(false)
      if (!this.anchor || !this.pane) return
      // 第一次推摇杆：原地变成「词」焦点，不动
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
    const s = gazeUsable() ? gaze.lastSample?.smooth : null
    const p = s ? this.gazeClient(s) : lastMouse
    if (!p) return
    const pane = panes.at(p.x, p.y)
    const a = pane?.anchorAt(p.x, p.y)
    if (!pane || !a) return
    this.pane = pane
    this.anchor = a
    this.update(keepHard ? 'hard' : 'soft', keepHard ? 'word' : 'paragraph')
  }

  /** 没有眼动时（没校准 / 键盘演示），从某个窗口坐标点起步 */
  focusAt(x: number, y: number, mode: 'soft' | 'hard' = 'hard'): void {
    const pane = panes.at(x, y)
    const a = pane?.anchorAt(x, y)
    if (!pane || !a) return
    this.pane = pane
    this.anchor = a
    this.update(mode, mode === 'hard' ? 'word' : 'paragraph')
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
    const s = gazeUsable() ? gaze.lastSample?.smooth : null
    const p = s ? this.gazeClient(s) : lastMouse
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

export const focus = new FocusController()

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
  if (uiStore.get().mode !== 'global') return
  const now = performance.now()
  if (!force && now - lastOverlay < 33) return
  lastOverlay = now
  const st = focus.state.get()
  const u = st.sel ? unionBox(st.sel.rects) : null
  const show = settingsStore.get().s?.gaze.showCursor !== false
  const g = gazeUsable() ? gaze.lastSample?.smooth ?? null : null
  la.overlay.update({
    gaze: show && g ? g : null,
    focus: (st.sel?.space === 'screen' ? u : null) as Box | null,
    label: st.mode === 'hard' ? st.label : undefined,
    mode: st.mode === 'hard' ? 'hard' : 'soft'
  })
}
gaze.events.on('sample', () => pushOverlay())
focus.state.subscribe(() => pushOverlay(true))
uiStore.subscribe(() => pushOverlay(true))

// 窗口移动/缩放后高亮要跟着重算
boundsStore.subscribe(() => focus.refresh())
