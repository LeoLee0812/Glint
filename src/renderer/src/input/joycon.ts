import type { BridgeEvent } from '../../../shared/types'
import { createStore, Emitter } from '../store'
import { la } from '../appState'

// 输入层：把原生助手发来的 Joy-Con 原始报告解码成「虚拟按键」，键盘快捷键也映射到同一套按键
// 上层（router）只关心「哪个键按下/抬起/长按」和摇杆当前值，不关心来源

export type Btn =
  | 'A' | 'B' | 'X' | 'Y' | 'R' | 'ZR' | 'Plus' | 'Home' | 'RS' | 'SL_R' | 'SR_R'
  | 'L' | 'ZL' | 'Minus' | 'Capture' | 'LS' | 'Up' | 'Down' | 'Left' | 'Right' | 'SL_L' | 'SR_L'

// 0x30 报告第 3/4/5 字节拼成的 24 位掩码
const BITS: Array<[Btn, number]> = [
  ['Y', 0], ['X', 1], ['B', 2], ['A', 3], ['SR_R', 4], ['SL_R', 5], ['R', 6], ['ZR', 7],
  ['Minus', 8], ['Plus', 9], ['RS', 10], ['LS', 11], ['Home', 12], ['Capture', 13],
  ['Down', 16], ['Up', 17], ['Right', 18], ['Left', 19], ['SR_L', 20], ['SL_L', 21], ['L', 22], ['ZL', 23]
]

export interface ButtonEvent {
  btn: Btn
  down: boolean
  /** 抬起时：按住了多久 */
  heldMs?: number
  /** 按住超过长按阈值时额外发一次 long=true */
  long?: boolean
  source: 'joycon' | 'keyboard'
}

export interface JoyInfo {
  connected: boolean
  battery: number
  charging: boolean
  name: string
}

export type UiAction = 'confirm' | 'cancel'

const LONG_MS = 650

class InputHub {
  status = createStore<{ L: JoyInfo; R: JoyInfo; P: JoyInfo; lastInput: number }>({
    L: { connected: false, battery: -1, charging: false, name: 'Joy-Con (L)' },
    R: { connected: false, battery: -1, charging: false, name: 'Joy-Con (R)' },
    P: { connected: false, battery: -1, charging: false, name: 'Pro Controller' },
    lastInput: 0
  })
  events = new Emitter<{ button: ButtonEvent; action: UiAction }>()

  private masks: Record<'L' | 'R' | 'P', number> = { L: 0, R: 0, P: 0 }
  private pressed = new Map<Btn, number>()
  private longTimers = new Map<Btn, ReturnType<typeof setTimeout>>()
  private stick = { lx: 0, ly: 0, rx: 0, ry: 0 }
  private kbStick = { lx: 0, ly: 0, rx: 0, ry: 0 }

  constructor() {
    la.bridge.onEvent((e) => this.onBridge(e))
    la.bridge.send({ cmd: 'joy_list' })
    window.addEventListener('keydown', (e) => this.onKey(e, true), true)
    window.addEventListener('keyup', (e) => this.onKey(e, false), true)
    window.addEventListener('blur', () => this.releaseKeyboard())
  }

  private onBridge(e: BridgeEvent): void {
    if (e.t === 'joy_conn') {
      const side = e.side
      this.status.patch({ [side]: { ...this.status.get()[side], connected: e.connected, name: e.name } } as any)
      if (!e.connected) {
        this.applyMask(side, 0)
        if (side !== 'R') this.stick.lx = this.stick.ly = 0
        if (side !== 'L') this.stick.rx = this.stick.ry = 0
      }
      return
    }
    if (e.t !== 'joy') return
    const side = e.side
    const cur = this.status.get()[side]
    if (!cur.connected || cur.battery !== e.bat || cur.charging !== e.chg) {
      this.status.patch({ [side]: { ...cur, connected: true, battery: e.bat, charging: e.chg } } as any)
    }
    if (side !== 'R') {
      this.stick.lx = e.lx
      this.stick.ly = e.ly
    }
    if (side !== 'L') {
      this.stick.rx = e.rx
      this.stick.ry = e.ry
    }
    this.applyMask(side, e.b)
  }

  private applyMask(side: 'L' | 'R' | 'P', mask: number): void {
    const prev = this.masks[side]
    if (prev === mask) return
    this.masks[side] = mask
    for (const [btn, bit] of BITS) {
      const was = (prev >> bit) & 1
      const now = (mask >> bit) & 1
      if (was !== now) this.edge(btn, !!now, 'joycon')
    }
  }

  private edge(btn: Btn, down: boolean, source: ButtonEvent['source']): void {
    const now = performance.now()
    this.status.patch({ lastInput: Date.now() })
    if (down) {
      if (this.pressed.has(btn)) return
      this.pressed.set(btn, now)
      this.events.emit('button', { btn, down: true, source })
      this.longTimers.set(
        btn,
        setTimeout(() => {
          if (this.pressed.has(btn)) this.events.emit('button', { btn, down: true, long: true, source })
        }, LONG_MS)
      )
      if (btn === 'A') this.events.emit('action', 'confirm')
      if (btn === 'B') this.events.emit('action', 'cancel')
    } else {
      const t0 = this.pressed.get(btn)
      if (t0 === undefined) return
      this.pressed.delete(btn)
      clearTimeout(this.longTimers.get(btn))
      this.longTimers.delete(btn)
      this.events.emit('button', { btn, down: false, heldMs: now - t0, source })
    }
  }

  isDown(btn: Btn): boolean {
    return this.pressed.has(btn)
  }

  sticks(): { lx: number; ly: number; rx: number; ry: number } {
    const k = this.kbStick
    return {
      lx: this.stick.lx || k.lx,
      ly: this.stick.ly || k.ly,
      rx: this.stick.rx || k.rx,
      ry: this.stick.ry || k.ry
    }
  }

  connected(): { L: boolean; R: boolean } {
    const s = this.status.get()
    return { L: s.L.connected || s.P.connected, R: s.R.connected || s.P.connected }
  }

  onButton(fn: (e: ButtonEvent) => void): () => void {
    return this.events.on('button', fn)
  }

  onAction(fn: (a: UiAction) => void): () => void {
    return this.events.on('action', fn)
  }

  // ---------- 键盘兜底：没连手柄也能完整体验，演示时也更稳 ----------

  private typingTarget(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null
    if (!el) return false
    if (el.closest('.xterm')) return true
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
  }

  private keyMap(e: KeyboardEvent): Btn | null {
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      switch (e.code) {
        case 'Enter': return 'A'
        case 'KeyT': return 'X'
        case 'KeyS': return 'Y'
        case 'KeyG': return 'R'
        case 'Space': return 'ZR'
        case 'KeyV': return 'ZL'
        case 'KeyC': return 'Capture'
        case 'KeyJ': return 'Plus'
        case 'Period': return 'RS'
        case 'KeyD': return 'Minus'
        case 'KeyL': return 'L'
        case 'KeyH': return 'Home'
        case 'KeyA': return 'LS'
      }
    }
    return null
  }

  private kbCodes = new Map<string, Btn>()
  private kbArrows = new Map<string, 'l' | 'r'>()

  private onKey(e: KeyboardEvent, down: boolean): void {
    const arrows = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    // 抬起：按 code 释放，不看修饰键（用户可能先松开 ⌥）
    if (!down) {
      const btn = this.kbCodes.get(e.code)
      if (btn) {
        this.kbCodes.delete(e.code)
        e.preventDefault()
        this.edge(btn, false, 'keyboard')
        return
      }
      const side = this.kbArrows.get(e.code)
      if (side) {
        this.kbArrows.delete(e.code)
        e.preventDefault()
        if (e.code === 'ArrowUp' || e.code === 'ArrowDown') this.kbStick[`${side}y`] = 0
        else this.kbStick[`${side}x`] = 0
      }
      return
    }
    if (e.repeat) {
      if (this.kbCodes.has(e.code) || this.kbArrows.has(e.code)) e.preventDefault()
      return
    }
    // ⌥ + 方向键 = 右摇杆（移动焦点）；⌥ + ⇧ + 方向键 = 左摇杆（滚动）
    if (e.altKey && !e.metaKey && arrows.includes(e.code)) {
      e.preventDefault()
      e.stopPropagation()
      const side = e.shiftKey ? 'l' : 'r'
      this.kbArrows.set(e.code, side)
      if (e.code === 'ArrowUp') this.kbStick[`${side}y`] = 1
      if (e.code === 'ArrowDown') this.kbStick[`${side}y`] = -1
      if (e.code === 'ArrowLeft') this.kbStick[`${side}x`] = -1
      if (e.code === 'ArrowRight') this.kbStick[`${side}x`] = 1
      return
    }
    const btn = this.keyMap(e)
    if (btn) {
      e.preventDefault()
      e.stopPropagation()
      this.kbCodes.set(e.code, btn)
      this.edge(btn, true, 'keyboard')
      return
    }
    if (e.code === 'Escape' && !this.typingTarget(e)) {
      this.edge('B', true, 'keyboard')
      this.edge('B', false, 'keyboard')
      return
    }
    // 校准界面里：空格 / 回车 = 确认
    if ((e.code === 'Space' || e.code === 'Enter') && !this.typingTarget(e) && document.querySelector('.calib')) {
      e.preventDefault()
      this.events.emit('action', 'confirm')
    }
  }

  private releaseKeyboard(): void {
    this.kbStick = { lx: 0, ly: 0, rx: 0, ry: 0 }
    this.kbArrows.clear()
    for (const btn of this.kbCodes.values()) this.edge(btn, false, 'keyboard')
    this.kbCodes.clear()
  }
}

export const input = new InputHub()
