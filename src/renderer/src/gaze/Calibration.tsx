import { useEffect, useRef, useState } from 'react'
import { gaze, meanPose, type HeadPos } from './engine'
import { useStore } from '../store'
import { uiStore, setUiMode, settingsStore, clientToScreen, toast, rumble, boundsStore, la } from '../appState'
import { input, type Btn } from '../input/joycon'
import { haptic } from '../input/haptics'
import type { FitInput } from './ridge'
import { occludedRegion, isOccluded } from './td/mount'
import { meanHead3D, screenGeo, type Head3D } from './headmotion'
import { FACE_KEYS, sideOf, dirOf, glyphOf, type Dir } from '../ui/JoyKeys'
import { saveRun, whenLabel, type GameRun } from './gameScores'

// 全屏校准：一个个点看过去，采眼睛特征，拟合视线模型（摄像头在 Worker 里拟合岭回归；iPhone 原深感拟合几何模型）
// 点「校准」就直接开始（3、2、1 倒数），不再有选玩法的开始页：两只 Joy-Con 都连着就玩手柄小游戏，没连齐就看圆点。
// 只有看不到脸 / iPhone 没连好时才停下来给个画面提示，好了自动开始
// 两种玩法：
// - 看圆点：点出现后缩小，缩到最小时采样
// - 手柄小游戏（两只 Joy-Con 都连上才能选）：每个点是手柄上的一颗键——左手柄十字键（蓝）、右手柄 X A B Y（红），一共 8 颗。
//   看清亮的是哪颗、按手柄上的同一颗；要按对就得先看清，眼睛自然盯在点上，取按下前后那一小段采样。
//   按对「叮叮」，又快又对再往上一扬，按错闷一下；有分数和连击，每局记进排行榜（gameScores.ts）。B 是游戏键，退出改成 HOME / Esc
// 进行中屏幕上只有目标本身和最底边一道进度细条，不放任何会被目标盖住的文字
// iPhone 竖放在屏幕和键盘之间时会挡住屏幕中下部，被挡住的点自动跳过

type Phase = 'wait' | 'count' | 'points' | 'fitting' | 'result'

const SETTLE_MS = 750
const RECORD_MS = 850

/** 小游戏：目标出现多久后才开始算（眼睛跳过去约 200ms，再稳一下） */
const GAME_SETTLE = 350
/** 最多取按下前多久：按之前眼睛一直在这儿，再往前可能还在找 */
const GAME_BEFORE = 1000
/** 按下后再收一小会：命中动画会把眼睛留在原地 */
const GAME_AFTER = 220
/** 帧不够时按下后最多再多收多久 */
const GAME_EXTRA = 450
/** 外圈缩到键上之前按对 = 完美 */
const PERFECT_MS = 1100
const GREAT_MS = 1900
/** 这么久还没按对，给个提示、震一下该用的那只手柄 */
const NUDGE_MS = 5000

const GRADE: Record<'perfect' | 'great' | 'good', { label: string; pts: number }> = {
  perfect: { label: '完美', pts: 300 },
  great: { label: '很好', pts: 200 },
  good: { label: '不错', pts: 100 }
}

/** 这一下得几分：档位底分 + 越快越多的速度分（不然全是「完美」的两局分数一样，排行榜分不出高下），再乘连击 */
function points(grade: keyof typeof GRADE, ms: number, combo: number): number {
  const speed = grade === 'perfect' ? (PERFECT_MS - ms) / 5 : grade === 'great' ? (GREAT_MS - ms) / 10 : 0
  return Math.round((GRADE[grade].pts + Math.max(0, speed)) * (1 + Math.min(combo, 10) * 0.1))
}

function pattern(n: 9 | 17): Array<[number, number]> {
  const a = 0.07
  const b = 0.93
  const grid: Array<[number, number]> = [
    [a, a], [0.5, a], [b, a],
    [b, 0.5], [0.5, 0.5], [a, 0.5],
    [a, b], [0.5, b], [b, b]
  ]
  if (n === 9) return grid
  const p = 0.29
  const q = 0.71
  const extra: Array<[number, number]> = [
    [p, p], [0.5, p], [q, p],
    [q, 0.5], [p, 0.5],
    [p, q], [0.5, q], [q, q]
  ]
  // 大格点和中间点交错着来，避免连续同一行把头带偏
  const out: Array<[number, number]> = []
  for (let i = 0; i < 9; i++) {
    out.push(grid[i])
    if (extra[i]) out.push(extra[i])
  }
  return out
}

/** 原深感竖放在屏幕下方时手机挡住的那块（0~1 坐标）；其它情况 null */
function occluded(): ReturnType<typeof occludedRegion> {
  if (gaze.source !== 'truedepth') return null
  return occludedRegion(settingsStore.get().s?.gaze.tdMount ?? 'bottom', gaze.td.display)
}

function ptToDeg(px: number): number {
  // 估算：macOS 默认缩放下 1pt ≈ 0.023cm，眼睛到屏幕按 55cm 算
  return (Math.atan((px * 0.023) / 55) * 180) / Math.PI
}

/** 交叉验证误差 → 一句人话 */
function rating(cv: number | null, td: boolean): { label: string; tone: 'good' | 'mid' | 'bad'; tip?: string } {
  if (cv == null || cv <= 90) return { label: '很准', tone: 'good' }
  if (cv <= 170) return { label: '够用', tone: 'good' }
  if (cv <= 250) return { label: '有点偏', tone: 'mid', tip: '能用。想更准，再来一次' }
  return {
    label: '偏得多',
    tone: 'bad',
    tip: td ? '可能没盯住，或者手机被碰动了。放好再来一次' : '可能头动了，或者光从背后照过来。调好再来一次'
  }
}

type Got = { rows: Float64Array[]; faceScale: number | null; poses: HeadPos[]; heads: Head3D[] }

/** 小游戏的采样：目标一出现就开始录帧，按对之后再按时间窗截取 */
function frameTape(): { count: (from: number, to: number) => number; stop: (from: number, to: number) => Got; cancel: () => void } {
  const tape: Array<{ t: number; row: Float64Array; pose: HeadPos | null; head: Head3D | null }> = []
  const off = gaze.events.on('frame', (f) => {
    if (f.features && f.blink < 0.4) tape.push({ t: performance.now(), row: f.features, pose: f.pose, head: f.head3d ?? null })
  })
  return {
    count: (from, to) => tape.filter((x) => x.t >= from && x.t <= to).length,
    stop(from, to) {
      off()
      const sel = tape.filter((x) => x.t >= from && x.t <= to)
      const poses = sel.flatMap((x) => (x.pose ? [x.pose] : []))
      return {
        rows: sel.map((x) => x.row),
        faceScale: poses.length ? poses.reduce((a, p) => a + p.w, 0) / poses.length : null,
        poses,
        heads: sel.flatMap((x) => (x.head ? [x.head] : []))
      }
    },
    cancel: off
  }
}

/** 等摄像头帧重新流起来：开始页的预览把 video 挪出 DOM 时会卡一下，不等的话第一个点常常采不到帧、要重来 */
function waitFrames(n: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let got = 0
    const done = () => {
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = gaze.events.on('frame', (f) => {
      if (f.features && ++got >= n) done()
    })
    const timer = setTimeout(done, maxMs)
  })
}

/**
 * 下一颗键：只从连着的手柄里挑，不和上一颗重复。
 * 贴边的点只挑「另外三颗往屏幕里摆」的键：亮的是下面那颗，另外三颗就摆在它上方，放在顶边会顶出屏幕
 */
function pickKey(prev: Btn | null, u: number, v: number): Btn | null {
  const c = input.connected()
  const bad = new Set<Dir>()
  if (v < 0.2) bad.add('down')
  if (v > 0.8) bad.add('up')
  if (u < 0.2) bad.add('right')
  if (u > 0.8) bad.add('left')
  const pool = FACE_KEYS.filter((b) => b !== prev && (sideOf(b) === 'L' ? c.L : c.R) && !bad.has(dirOf(b) as Dir))
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
}

type Target = {
  id: number
  x: number
  y: number
  key: Btn
  miss: number
  /** 贴着顶边：得分飘在键下面 */
  below: boolean
  hit: { grade: keyof typeof GRADE; pts: number; combo: number } | null
}

type Score = { score: number; combo: number; best: number; perfect: number; rts: number[] }

export function Calibration(): React.JSX.Element | null {
  const ui = useStore(uiStore)
  if (!ui.showCalibration) return null
  return <CalibrationInner />
}

function CalibrationInner(): React.JSX.Element {
  const settings = useStore(settingsStore).s
  const status = useStore(gaze.status)
  const joy = useStore(input.status)
  const [phase, setPhase] = useState<Phase>('wait')
  const [count, setCount] = useState(3)
  const [dot, setDot] = useState<{ x: number; y: number; shrink: boolean } | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [nudge, setNudge] = useState(false)
  const [idx, setIdx] = useState(0)
  const [total, setTotal] = useState(0)
  const [result, setResult] = useState<{
    cv: number | null
    note?: string
    game: { me: GameRun; board: GameRun[]; rank: number; record: boolean; total: number } | null
  } | null>(null)
  const [face, setFace] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const resultAt = useRef(0)

  const td = status.source === 'truedepth'
  const canGame = (joy.L.connected || joy.P.connected) && (joy.R.connected || joy.P.connected)
  const canGameRef = useRef(canGame)
  canGameRef.current = canGame
  /** 这一轮是不是小游戏：开始时定下来，中途手柄断了也不换 */
  const [gameRun, setGameRun] = useState(false)
  const gameRunRef = useRef(false)
  /** 能开始了：摄像头 / iPhone 在跑，看得到脸 */
  const ready = status.state === 'running' && status.face && !status.dark && (!td || status.link?.state === 'live')

  // 进全屏；退出时还原窗口
  useEffect(() => {
    abortRef.current = false
    setUiMode('calibration')
    if (gaze.status.get().state !== 'running') gaze.start(settings?.gaze.cameraId || undefined)
    if (gaze.source === 'truedepth') gaze.td.refreshDisplay()
    return () => {
      abortRef.current = true
      setUiMode('normal')
    }
  }, [])

  // 看得到脸就直接开始；看不到才停在这儿，下面画个画面提示，好了自动开始
  useEffect(() => {
    if (phase === 'wait' && ready) void start()
  }, [phase, ready])

  // 等的时候给个摄像头画面 + 人脸框（原深感没有画面，显示连接状态）
  useEffect(() => {
    if (phase !== 'wait' || ready || !previewRef.current || td) return
    const v = gaze.video
    v.className = 'calib-video'
    previewRef.current.prepend(v)
    const off = gaze.events.on('frame', (f) => setFace(f.faceBox))
    return () => {
      off()
      // 从 DOM 里拿掉的 video 会被浏览器自动暂停，要马上接着播，不然眼动循环就停了
      v.remove()
      v.play().catch(() => undefined)
    }
  }, [phase, td, ready])

  const close = () => uiStore.patch({ showCalibration: false })

  // A = 结果页「开始用」，B = 退出；小游戏进行中 B 是游戏键，不当退出（退出走 HOME / Esc）
  useEffect(() => {
    return input.onAction((a) => {
      if (phase === 'points' && gameRunRef.current) return
      // 刚出结果时手还在连按，别把结果页直接按掉
      if (a === 'confirm' && phase === 'result' && performance.now() - resultAt.current > 700) close()
      else if (a === 'cancel') close()
    })
  })

  // 小游戏进行中随时能退：HOME / Esc（B 是游戏键，不能拿来退）
  useEffect(() => {
    if ((phase !== 'points' && phase !== 'count') || !gameRun) return
    const off = input.onButton((e) => {
      if (e.down && !e.long && e.btn === 'Home' && e.source === 'joycon') close()
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [phase, gameRun])

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 等窗口真的铺满屏幕、主进程把新位置推过来，再开始算校准点的屏幕坐标 */
  async function waitFullscreen(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await la.win.requestBounds()
      await sleep(80)
      const b = boundsStore.get()
      if (b.mode === 'calibration' && Math.abs(b.content.width - b.display.width) < 2 && Math.abs(b.content.height - b.display.height) < 2) return
    }
  }

  /** 3、2、1 倒数（顺便等窗口铺满），然后开始：两只手柄都连着就玩小游戏 */
  async function start(): Promise<void> {
    const game = canGameRef.current
    gameRunRef.current = game
    setGameRun(game)
    setResult(null)
    setPhase('count')
    const full = waitFullscreen()
    for (let n = 3; n >= 1; n--) {
      setCount(n)
      if (game) haptic('tick')
      await sleep(480)
      if (abortRef.current) return
    }
    await full
    await run(game)
  }

  /** 看圆点：点出现、缩小，盯住后采样；眨眼或脸丢了就再来一次 */
  async function dotPoint(cx: number, cy: number): Promise<Got> {
    setDot({ x: cx, y: cy, shrink: false })
    await sleep(30)
    setDot({ x: cx, y: cy, shrink: true })
    await sleep(SETTLE_MS)
    let got = await gaze.collect(RECORD_MS)
    if (got.rows.length < 6) {
      setDot({ x: cx, y: cy, shrink: false })
      await sleep(200)
      setDot({ x: cx, y: cy, shrink: true })
      await sleep(SETTLE_MS)
      got = await gaze.collect(RECORD_MS + 300)
    }
    setDot(null)
    rumble('soft', 'R')
    return got
  }

  // ---------- 小游戏 ----------

  const seq = useRef(0)
  const lastKey = useRef<Btn | null>(null)
  const sc = useRef<Score>({ score: 0, combo: 0, best: 0, perfect: 0, rts: [] })

  /** 等按下目标键：按对返回按下的时刻，校准窗口关了（HOME / Esc 退出）返回 null；按错震一下、断连击，接着等 */
  function waitPress(key: Btn): Promise<number | null> {
    return new Promise((resolve) => {
      let done = false
      const t0 = performance.now()
      const finish = (v: number | null) => {
        if (done) return
        done = true
        offBtn()
        clearInterval(watch)
        setNudge(false)
        resolve(v)
      }
      const offBtn = input.onButton((e) => {
        if (!e.down || e.long || e.source !== 'joycon') return
        if (e.btn === key) return finish(performance.now())
        if (FACE_KEYS.includes(e.btn)) {
          haptic('wall', sideOf(e.btn))
          sc.current.combo = 0
          setTarget((t) => (t ? { ...t, miss: t.miss + 1 } : t))
        }
      })
      let nudged = false
      const watch = setInterval(() => {
        if (abortRef.current) return finish(null)
        if (!nudged && performance.now() - t0 > NUDGE_MS) {
          nudged = true
          setNudge(true)
          haptic('soft', sideOf(key))
        }
      }, 100)
    })
  }

  /** 一个点：亮一颗键，按对就收这颗之前那一小段的帧；一帧都没收到（眨眼、脸丢了）换颗键再来一次 */
  async function gamePoint(cx: number, cy: number, u: number, v: number): Promise<Got | null> {
    for (let tries = 0; ; tries++) {
      const key = pickKey(lastKey.current, u, v)
      // 手柄全断了：这个点改成看圆点
      if (!key) return dotPoint(cx, cy)
      lastKey.current = key
      const appear = performance.now()
      const tape = frameTape()
      setTarget({ id: ++seq.current, x: cx, y: cy, key, miss: 0, below: v < 0.2, hit: null })
      const at = await waitPress(key)
      if (at === null) {
        tape.cancel()
        setTarget(null)
        return null
      }
      const rt = (at - appear) / 1000
      const grade = at - appear < PERFECT_MS ? 'perfect' : at - appear < GREAT_MS ? 'great' : 'good'
      const s = sc.current
      const pts = points(grade, at - appear, s.combo)
      s.score += pts
      s.combo++
      s.best = Math.max(s.best, s.combo)
      if (grade === 'perfect') s.perfect++
      s.rts.push(rt)
      setTarget((t) => (t ? { ...t, hit: { grade, pts, combo: s.combo } } : t))
      haptic(grade === 'perfect' ? 'perfect' : 'hit', sideOf(key))
      await sleep(GAME_AFTER)
      const from = Math.max(appear + GAME_SETTLE, at - GAME_BEFORE)
      let to = at + GAME_AFTER
      // 按得太快、或者摄像头帧率低，帧不够：命中动画还在放、眼睛还在这儿，再多收一会儿
      if (tape.count(from, to) < 8) {
        await sleep(GAME_EXTRA)
        to = performance.now()
      }
      const got = tape.stop(from, to)
      // 让命中动画放完再出下一个
      await sleep(180)
      setTarget(null)
      if (got.rows.length >= 6 || tries >= 1) return got
    }
  }

  async function run(game: boolean): Promise<void> {
    const all = pattern(settings?.gaze.calibrationPoints ?? 17)
    const occ = occluded()
    const pts = all.filter(([u, v]) => !isOccluded(occ, u, v))
    setTotal(pts.length)
    sc.current = { score: 0, combo: 0, best: 0, perfect: 0, rts: [] }
    lastKey.current = null
    setPhase('points')
    await waitFrames(6, 1500)
    const W = window.innerWidth
    const H = window.innerHeight
    const rows: Float64Array[] = []
    const tx: number[] = []
    const ty: number[] = []
    const groups: number[] = []
    const zs: number[] = []
    const poses: HeadPos[] = []
    const heads: Head3D[] = []
    for (let i = 0; i < pts.length; i++) {
      if (abortRef.current) return
      const [nx, ny] = pts[i]
      const cx = nx * W
      const cy = ny * H
      setIdx(i)
      const got = game ? await gamePoint(cx, cy, nx, ny) : await dotPoint(cx, cy)
      if (!got) return close()
      if (abortRef.current) return
      const s = clientToScreen(cx, cy)
      for (const r of got.rows) {
        rows.push(r)
        tx.push(s.x)
        ty.push(s.y)
        groups.push(i)
      }
      if (got.faceScale) zs.push(got.faceScale)
      poses.push(...got.poses)
      heads.push(...got.heads)
    }
    setDot(null)
    setTarget(null)
    setIdx(pts.length)
    if (rows.length < 40) {
      toast('没怎么看到脸，看看光线，脸要整个进画面', 'error', { ttl: 6000 })
      close()
      return
    }
    setPhase('fitting')
    // 让「正在算」先画出来（原深感在主线程拟合，约零点几秒）
    await sleep(30)
    const fitInput: FitInput = { rows, tx, ty, groups, screenW: W, screenH: H }
    try {
      const scale = zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : null
      // 头动补偿：记下校准时的三维坐姿和这块屏幕的物理尺寸（摄像头按在屏幕上沿正中算）
      const ref = meanHead3D(heads)
      const disp = ref ? await la.truedepth.display().catch(() => null) : null
      const head = ref && disp ? { ref, geo: screenGeo(boundsStore.get().display, disp.mmW, disp.ptW) } : null
      const r = await gaze.calibrate(fitInput, scale, meanPose(poses), head)
      let board = null
      if (game && sc.current.rts.length) {
        const g = sc.current
        const me: GameRun = {
          at: Date.now(),
          score: g.score,
          avg: g.rts.reduce((a, b) => a + b, 0) / g.rts.length,
          fastest: Math.min(...g.rts),
          combo: g.best,
          perfect: g.perfect,
          n: g.rts.length,
          size: settings?.gaze.calibrationPoints ?? 17,
          rate: rating(r.cv, td).label
        }
        board = { me, ...saveRun(me) }
      }
      setResult({ cv: r.cv, note: r.note, game: board })
      resultAt.current = performance.now()
      setPhase('result')
      rumble('done')
    } catch (e: any) {
      toast('没算出来：' + e.message, 'error')
      close()
    }
  }

  const rate = result ? rating(result.cv, td) : null
  // 看不到脸的提示默认放在底部正中；这时的目标正好在底部中间，就挪到顶上，不和目标叠在一起
  const cur = target ?? dot
  const faceTagTop = !!cur && cur.y > window.innerHeight * 0.75 && Math.abs(cur.x - window.innerWidth / 2) < 240

  return (
    <div className="calib">
      {/* 平时一闪而过直接倒数；只有看不到脸 / iPhone 没连好时才停在这儿，好了自动开始 */}
      {phase === 'wait' && !ready && (
        <div className="calib-intro">
          {td ? (
            <>
              <TdPanel />
              <TdPoseHint />
            </>
          ) : (
            <div className="calib-preview" ref={previewRef}>
              {face && status.face && (
                <div
                  className="calib-facebox"
                  style={{
                    left: `${(1 - face.x - face.w) * 100}%`,
                    top: `${face.y * 100}%`,
                    width: `${face.w * 100}%`,
                    height: `${face.h * 100}%`
                  }}
                />
              )}
              <div className="calib-noface">
                {status.state !== 'running' ? '摄像头还没开好…' : status.dark ? '画面是黑的，镜头被挡住了？' : '看不到脸，对着摄像头坐好'}
              </div>
            </div>
          )}
          <div className="calib-actions">
            <button className="btn" onClick={close}>
              取消（B）
            </button>
          </div>
        </div>
      )}

      {phase === 'count' && (
        <div className="calib-count">
          <b key={count}>{count}</b>
          <span>{gameRun ? '亮哪颗键就按哪颗，HOME 退出' : '盯住圆点，等它缩小'}</span>
        </div>
      )}

      {phase === 'points' && dot && (
        <div className={`calib-dot ${dot.shrink ? 'shrink' : ''}`} style={{ left: dot.x, top: dot.y }}>
          <i />
        </div>
      )}

      {phase === 'points' && target && <GameTarget t={target} nudge={nudge} />}

      {/* 进度：贴着屏幕最底边的一道细条，目标永远碰不到它 */}
      {phase === 'points' && total > 0 && (
        <div className={`calib-bar${gameRun ? ' game' : ''}`}>
          <i style={{ width: `${(idx / total) * 100}%` }} />
        </div>
      )}
      {phase === 'points' && !status.face && <div className={`calib-noface-tag${faceTagTop ? ' top' : ''}`}>看不到脸</div>}

      {phase === 'fitting' && <div className="calib-center">正在算…</div>}

      {phase === 'result' && result && rate && (
        <div className="calib-center">
          <h2>校准好了</h2>
          <p
            className={`calib-rate ${rate.tone}`}
            title={result.cv != null ? `平均偏 ${Math.round(result.cv)} 点，约 ${ptToDeg(result.cv).toFixed(1)}°` : undefined}
          >
            <i />
            {rate.label}
          </p>
          {rate.tip && <p className="calib-tip">{rate.tip}</p>}
          {result.note && <p className="warn">{result.note}</p>}
          {result.game && (
            <>
              <div className="gk-stats">
                <div className={result.game.record ? 'record' : ''}>
                  <b>{result.game.me.score.toLocaleString()}</b>
                  <span>{result.game.record ? '新纪录' : '得分'}</span>
                </div>
                <div>
                  <b>{result.game.me.avg.toFixed(2)} 秒</b>
                  <span>平均反应</span>
                </div>
                <div>
                  <b>{result.game.me.fastest.toFixed(2)} 秒</b>
                  <span>最快</span>
                </div>
                <div>
                  <b>×{result.game.me.combo}</b>
                  <span>最高连击</span>
                </div>
              </div>
              <Leaderboard {...result.game} />
            </>
          )}
          <div className="calib-actions">
            <button className="btn primary" onClick={close}>
              开始用（A）
            </button>
            <button className="btn" onClick={() => void start()}>
              再来一次
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 小游戏的目标：亮着的键放在点上（眼睛要盯的就是它），同一只手柄的另外三颗淡淡地摆在旁边，外圈往里缩；
 *  5 秒还没按对，键一跳一跳地催（不放文字，免得和别的东西叠在一起） */
function GameTarget({ t, nudge }: { t: Target; nudge: boolean }): React.JSX.Element {
  const side = sideOf(t.key)
  const dir = dirOf(t.key) as Dir
  const off: Record<Dir, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] }
  const [dx, dy] = off[dir]
  const SP = 28
  return (
    <div
      key={t.id}
      className={`gk gk-${side}${t.hit ? ` hit hit-${t.hit.grade}` : ''}${t.below ? ' pop-below' : ''}${nudge && !t.hit ? ' nudge' : ''}`}
      style={{ left: t.x, top: t.y, ['--perfect' as string]: `${PERFECT_MS}ms` }}
    >
      {!t.hit && <div className="gk-ring" />}
      {(Object.keys(off) as Dir[])
        .filter((d) => d !== dir)
        .map((d) => (
          <div key={d} className="gk-sib" style={{ left: (off[d][0] - dx) * SP, top: (off[d][1] - dy) * SP }} />
        ))}
      <div key={t.miss} className={`gk-key${t.miss ? ' miss' : ''}`}>
        {glyphOf(t.key)}
      </div>
      {t.hit && (
        <>
          <div className="gk-burst">
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} style={{ ['--a' as string]: `${i * 36}deg` }} />
            ))}
          </div>
          <div className="gk-pop">
            +{t.hit.pts}
            <small>
              {GRADE[t.hit.grade].label}
              {t.hit.combo >= 2 ? ` · 连击 ${t.hit.combo}` : ''}
            </small>
          </div>
        </>
      )}
    </div>
  )
}

/** 排行榜：历史前 5 局，这局高亮；这局没进前 5 就在最后补一行它的名次 */
function Leaderboard({ me, board, rank, total }: { me: GameRun; board: GameRun[]; rank: number; total: number }): React.JSX.Element {
  const size = me.size ?? 17
  const top = board.slice(0, 5)
  const row = (r: GameRun, i: number) => (
    <li key={r.at} className={r.at === me.at ? 'me' : ''}>
      <span className="rk">{i + 1}</span>
      <span className="sc">{r.score.toLocaleString()}</span>
      <span className="rt">{r.avg.toFixed(2)} 秒</span>
      <span className="fx">{r.fastest.toFixed(2)} 秒</span>
      <span className="cb">×{r.combo}</span>
      <span className="wh">{r.at === me.at ? '这局' : whenLabel(r.at)}</span>
    </li>
  )
  return (
    <div className="gk-board">
      <div className="gk-board-head">
        <b>排行榜</b>
        <span>
          {size} 个点 · 玩了 {total} 局
        </span>
      </div>
      <div className="gk-board-cols">
        <span className="rk" />
        <span className="sc">得分</span>
        <span className="rt">平均反应</span>
        <span className="fx">最快</span>
        <span className="cb">连击</span>
        <span className="wh" />
      </div>
      <ol>
        {top.map(row)}
        {rank > top.length && row(me, rank - 1)}
      </ol>
    </div>
  )
}

/** 原深感：校准前看一眼手机连上没、看不看得到脸 */
function TdPanel(): React.JSX.Element {
  const st = useStore(gaze.status)
  const link = st.link
  const text =
    !link || link.state === 'waiting'
      ? '在等 iPhone：打开手机上的 Glint Eye，选这台 Mac'
      : link.state === 'unpaired'
        ? '手机连上了，还没配对：设置 → 眼动，输入手机上的配对码'
        : link.state === 'lost'
          ? 'iPhone 断开了，看看手机上的 Glint Eye 还开着吗'
          : link.state === 'error'
            ? `收不到 iPhone 的数据：${link.msg || st.error || ''}`
            : st.face
              ? `${link.device} 已连上，看得到你的脸`
              : '已连上，但手机看不到你的脸'
  const ok = link?.state === 'live' && st.face
  return (
    <div className={`calib-td ${ok ? 'ok' : 'bad'}`}>
      <div className="calib-td-main">{text}</div>
    </div>
  )
}

/** 原深感的摆位提示：只管远近和手机看不看得到脸（头的位置、转角会被几何补偿） */
function TdPoseHint(): React.JSX.Element {
  const st = useStore(gaze.status)
  const d = st.link?.distanceCm ?? null
  let tip = d != null ? `离屏幕 ${d} 厘米，合适` : '位置合适'
  let bad = false
  if (st.link?.state !== 'live' || !st.face) {
    tip = '手机还看不到你的脸'
    bad = true
  } else if (d != null && d < 30) {
    tip = '太近了，往后靠一点'
    bad = true
  } else if (d != null && d > 85) {
    tip = '太远了，往前凑一点'
    bad = true
  }
  return <div className={`calib-pose ${bad ? 'bad' : 'ok'}`}>{tip}</div>
}
