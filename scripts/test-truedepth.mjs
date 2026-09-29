#!/usr/bin/env node
// 原深感 Mac 端全链路测试：假 iPhone（fake-truedepth.mjs）→ UDP → 原生助手 → 主进程验签、配对、丢乱序帧 → 渲染进程眼动引擎
// 自己起一个隔离的开发版 LookAsk（单独的用户数据目录、原生助手不接管 Joy-Con、假摄像头），用 Playwright 走 CDP 驱动和断言。
// 测试期间窗口会全屏跑一次 17 点校准（约 30 秒），别碰键盘鼠标。
//
// 用法：npm run build:native && npm run test:truedepth        加 --keep 测完不关窗口
// 断言：
//   1. 没配对的手机发来的帧不进眼动引擎；配错码被拒、配对码对了才收
//   2. 收到帧后眼动状态变成运行中、帧率正常，实时小人的头位置 / 歪头跟着假轨迹走
//   3. 用假轨迹跑完整校准（被手机挡住的点自动跳过），交叉验证误差合理，静止时实测误差合理
//   4. 校准后歪头 15°、左右挪 6 厘米、往后靠 10 厘米，视线点偏移都小，且明显小于不做三维几何的对照模型
//   5. 断线 3 秒顶栏显示「iPhone 已断开」，恢复后自动续上
//   6. 丢包 5%、抖动 20ms 时视线圈不乱跳

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { FakePhone } from './fake-truedepth.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UDP_PORT = 47651
const DEBUG_PORT = 9335
const KEEP = process.argv.includes('--keep')
const OUT = process.env.LOOKASK_TEST_OUT || mkdtempSync(join(tmpdir(), 'lookask-td-out-'))
mkdirSync(OUT, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '：' + detail : ''}`)
}

/** 截图只是留档：全屏切换时 CDP 截图偶尔会卡住，超时就跳过，不影响断言 */
async function shot(page, name) {
  try {
    await page.screenshot({ path: join(OUT, name), timeout: 6000 })
  } catch {
    console.log(`  （截图 ${name} 超时，跳过）`)
  }
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(stepMs)
  }
}

// ---------- 起开发版 ----------

const userData = mkdtempSync(join(tmpdir(), 'lookask-td-test-'))
// 跳过首次引导（第一步拍大头照），不然拍照窗口一上来就盖住校准
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ onboarded: true }))
const app = spawn(join(ROOT, 'node_modules/.bin/electron-vite'), ['dev'], {
  cwd: ROOT,
  env: {
    ...process.env,
    LOOKASK_USER_DATA: userData,
    LOOKASK_BRIDGE_NO_JOY: '1',
    LOOKASK_FAKE_CAM: '1',
    LOOKASK_TD_PORT: String(UDP_PORT),
    LOOKASK_TD_NAME: 'LookAsk 测试',
    LOOKASK_DEBUG_PORT: String(DEBUG_PORT)
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

let phone = null
let browser = null
async function cleanup(code) {
  phone?.stop()
  if (!KEEP) {
    await browser?.close().catch(() => undefined)
    try {
      process.kill(-app.pid, 'SIGTERM')
    } catch {
      /* 已经退了 */
    }
    await sleep(800)
    rmSync(userData, { recursive: true, force: true })
  }
  process.exit(code)
}
process.on('SIGINT', () => cleanup(130))

try {
  const ver = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      return r.ok ? r.json() : null
    } catch {
      return null
    }
  }, 120_000, 500)
  if (!ver) throw new Error('开发版没起来：\n' + appLog.slice(-2000))
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`)
  const page = await waitFor(async () => {
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) if (/index\.html/.test(p.url())) return p
    return null
  }, 30_000, 300)
  if (!page) throw new Error('找不到主窗口页面')
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [renderer error]', m.text().slice(0, 300))
  })
  await waitFor(() => page.evaluate(() => !!(window.__la && window.__la.settingsStore.get().s)), 30_000)

  // ---------- 切到原深感输入源 ----------
  await page.evaluate(async () => {
    const la = window.__la
    await la.updateSettings((s) => ({ ...s, gaze: { ...s.gaze, source: 'truedepth', tdMount: 'bottom' } }))
    await la.gaze.start()
  })
  const display = await waitFor(() => page.evaluate(() => window.__la.gaze.td.display), 10_000)
  const bounds = await page.evaluate(() => window.__la.boundsStore.get())
  console.log(`显示器：${display.mmW.toFixed(1)}×${display.mmH.toFixed(1)} 毫米，${display.ptW}×${display.ptH} 点（${display.measured ? '系统报的' : '猜的'}）`)
  const listening = await waitFor(() => page.evaluate(() => window.lookask.truedepth.status().then((s) => s.listening && s)), 10_000)
  check('原生助手开始监听并发布 Bonjour 服务', !!listening, listening ? `「${listening.name}」UDP ${listening.port}` : '')

  phone = new FakePhone({ port: UDP_PORT, display, mount: 'bottom', code: '4827', seed: 42 })
  const dispX = bounds.display.x
  const dispY = bounds.display.y
  await phone.start()
  phone.lookAt(display.ptW * 0.2, display.ptH * 0.15)

  // ---------- 1. 配对 ----------
  const unpaired = await waitFor(() => page.evaluate(() => window.__la.gaze.status.get().link?.state === 'unpaired'), 8000)
  check('没配对的手机被识别为待配对', !!unpaired)
  const beforePair = await page.evaluate(() => window.__la.gaze.status.get())
  check('没配对时帧不进眼动引擎', beforePair.state !== 'running' && !beforePair.face, `state=${beforePair.state}`)
  await sleep(1200)
  await shot(page, '1-待配对.png')
  const wrong = await page.evaluate((dev) => window.lookask.truedepth.pair(dev, '1111'), phone.dev)
  check('配对码不对被拒绝', !wrong.ok, wrong.error)
  const right = await page.evaluate((dev) => window.lookask.truedepth.pair(dev, '4827'), phone.dev)
  check('配对码对了配对成功', right.ok)

  // ---------- 2. 收帧、头位置 ----------
  const live = await waitFor(() => page.evaluate(() => {
    const st = window.__la.gaze.status.get()
    return st.state === 'running' && st.face && st.link?.state === 'live' ? st : null
  }), 8000)
  check('配对后眼动状态变成运行中、看得到脸', !!live)
  await sleep(1500)
  const st1 = await page.evaluate(() => window.__la.gaze.status.get())
  check('Mac 端实收帧率正常', st1.fps >= 45, `${st1.fps} fps`)
  check('手机收到 Mac 的回包（已配对）', phone.macState?.state === 'paired', JSON.stringify(phone.macState))
  const pill = await page.textContent('.topbar .cam-pill')
  check('顶栏显示 iPhone 帧率', /iPhone \d+ fps/.test(pill || ''), pill)

  const poseAt = async (h) => {
    phone.setHead({ x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0, ...h })
    await sleep(900)
    return page.evaluate(() => window.__la.gaze.pose.get().cur)
  }
  const pR = await poseAt({ x: 0.06 })
  const pL = await poseAt({ x: -0.06 })
  const pRoll = await poseAt({ roll: 15 })
  const pNear = await poseAt({ z: -0.1 })
  const pFar = await poseAt({ z: 0.1 })
  await poseAt({})
  check('头往右挪，小人往镜子右边动', pR.cx - pL.cx > 0.1, `cx 右 ${pR.cx.toFixed(3)} / 左 ${pL.cx.toFixed(3)}`)
  check('头歪向右肩，小人顺时针歪', pRoll.roll > 0.2, `roll ${(pRoll.roll * 57.3).toFixed(1)}°`)
  check('往前凑小人变大、往后靠变小', pNear.w > pFar.w * 1.3, `w 近 ${pNear.w.toFixed(3)} / 远 ${pFar.w.toFixed(3)}`)

  // ---------- 3. 17 点校准 ----------
  await page.evaluate(() => window.__la.uiStore.patch({ showCalibration: true, calibrationKind: 'full' }))
  await waitFor(() => page.evaluate(() => !!document.querySelector('.calib-td.ok')), 8000)
  await shot(page, '2-校准前.png')
  await page.evaluate(() => document.querySelector('.calib-actions .btn.primary').click())
  const seen = new Set()
  const seenToasts = new Set()
  const t0 = Date.now()
  let done = false
  while (Date.now() - t0 < 120_000) {
    const s = await page.evaluate(() => {
      const d = document.querySelector('.calib-dot')
      const h = document.querySelector('.calib-center h2')
      const b = window.__la.boundsStore.get()
      if (d) {
        const r = d.getBoundingClientRect()
        return { dot: { x: r.left + r.width / 2 + b.content.x, y: r.top + r.height / 2 + b.content.y } }
      }
      return { title: h?.textContent || null }
    })
    const toasts = await page.evaluate(() => window.__la.toastStore.get().list.map((t) => t.text))
    for (const t of toasts) if (!seenToasts.has(t)) (seenToasts.add(t), console.log('  [提示]', t))
    if (s.dot) {
      phone.lookAt(s.dot.x - dispX, s.dot.y - dispY)
      seen.add(`${Math.round(s.dot.x)},${Math.round(s.dot.y)}`)
      // 校准时头会有一点自然晃动
      const k = (Date.now() - t0) / 1000
      phone.setHead({ x: 0.004 * Math.sin(k * 1.3), y: 0.003 * Math.cos(k), z: 0.006 * Math.sin(k * 0.7), roll: 2 * Math.sin(k * 0.5) })
    } else if (s.title && /校准完成/.test(s.title)) {
      done = true
      break
    } else if (s.title === null && seen.size > 0) {
      // 拟合中
    }
    await sleep(25)
  }
  phone.setHead({ x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0 })
  const cal = await page.evaluate(() => {
    const m = window.__la.gaze.tdCalibration
    return m && { cv: m.cvErrorPx, variant: m.variant, gain: m.gain, T: m.T, R: m.R, nPoints: m.nPoints, mirrorX: m.mirrorX }
  })
  check('17 点校准跑完（被手机挡住的点自动跳过）', done && !!cal, cal ? `用了 ${cal.nPoints} 个点，模型 ${cal.variant}，眼睛增益 ${cal.gain.map((g) => g.toFixed(2)).join('/')}` : '')
  check('校准交叉验证误差合理（< 60 点）', !!cal && cal.cv != null && cal.cv < 60, cal ? `${cal.cv?.toFixed(1)} 点` : '')
  await shot(page, '3-校准完成.png')
  await page.evaluate(() => document.querySelector('.calib-actions .btn.primary')?.click())
  await waitFor(() => page.evaluate(() => !window.__la.uiStore.get().showCalibration && window.__la.boundsStore.get().mode === 'normal'), 5000)
  await sleep(600)

  // ---------- 4. 精度 + 头动 ----------
  const occ = await page.evaluate(() => {
    const d = window.__la.gaze.td.display
    const half = 70.6 / 2 + 15
    return { x0: 0.5 - half / d.mmW, x1: 0.5 + half / d.mmW, y0: (d.mmH - (146.6 - 12) - 10) / d.mmH }
  })
  const visible = ([u, v]) => !(u >= occ.x0 && u <= occ.x1 && v >= occ.y0)
  const targets = [
    [0.2, 0.2],
    [0.8, 0.22],
    [0.15, 0.75],
    [0.86, 0.8],
    [0.5, 0.1],
    [0.25, 0.5]
  ].filter(visible)
  /** 看着某点、头在某个姿势，稳定后取 0.6 秒平滑视线的平均 → 离目标多远（点） */
  const gazeErr = async (u, v, head = {}) => {
    const X = u * display.ptW
    const Y = v * display.ptH
    phone.lookAt(X, Y)
    phone.setHead({ x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0, ...head })
    await sleep(900)
    const pts = []
    const tEnd = Date.now() + 600
    while (Date.now() < tEnd) {
      const s = await page.evaluate(() => window.__la.gaze.lastSample?.smooth)
      if (s) pts.push(s)
      await sleep(30)
    }
    const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length - dispX
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length - dispY
    return Math.hypot(mx - X, my - Y)
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
  const rest = []
  for (const [u, v] of targets) rest.push(await gazeErr(u, v))
  check('静止时实测误差合理（< 45 点）', mean(rest) < 45, `${mean(rest).toFixed(1)} 点（${targets.length} 个点）`)

  // 对照：不做三维几何换算，眼睛转角 + 头位置直接线性回归到屏幕（相当于平面摄像头方案的做法），同样的校准点和数据
  const naive = fitNaive(phone, display, targets, occ)
  const poses = [
    ['歪头 15°', { roll: 15 }],
    ['歪头 -15°', { roll: -15 }],
    ['往右挪 6 厘米', { x: 0.06 }],
    ['往左挪 6 厘米', { x: -0.06 }],
    ['往后靠 10 厘米', { z: 0.1 }],
    ['转头 15°', { yaw: 15 }]
  ]
  for (const [name, head] of poses) {
    const e = []
    for (const [u, v] of targets) e.push(await gazeErr(u, v, head))
    const en = naive.errAt(targets, head)
    const ok = mean(e) < 70 && mean(e) < en * 0.6
    check(`${name}后视线仍然准，且偏移小于对照`, ok, `原深感几何法 ${mean(e).toFixed(1)} 点 · 对照 ${en.toFixed(1)} 点`)
  }
  phone.setHead({ x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0 })

  // ---------- 5. 断线 / 恢复 ----------
  phone.pause(true)
  const lost = await waitFor(() => page.evaluate(() => window.__la.gaze.status.get().link?.state === 'lost'), 6000)
  const lostPill = await page.textContent('.topbar .cam-pill')
  check('断线 3 秒顶栏显示「iPhone 已断开」', !!lost && /已断开/.test(lostPill || ''), lostPill)
  await shot(page, '4-断开.png')
  phone.pause(false)
  const back = await waitFor(() => page.evaluate(() => {
    const st = window.__la.gaze.status.get()
    return st.state === 'running' && st.link?.state === 'live' && st.face
  }), 5000)
  const backPill = await page.textContent('.topbar .cam-pill')
  check('手机恢复后自动续上', !!back && /fps/.test(backPill || ''), backPill)

  // ---------- 6. 丢包 5% + 抖动 20ms ----------
  const spread = async () => {
    const X = display.ptW * 0.2
    const Y = display.ptH * 0.2
    phone.lookAt(X, Y)
    await sleep(1200)
    const pts = []
    const tEnd = Date.now() + 3000
    while (Date.now() < tEnd) {
      const s = await page.evaluate(() => window.__la.gaze.lastSample?.smooth)
      if (s) pts.push(s)
      await sleep(16)
    }
    const mx = mean(pts.map((p) => p.x))
    const my = mean(pts.map((p) => p.y))
    const rms = Math.sqrt(mean(pts.map((p) => (p.x - mx) ** 2 + (p.y - my) ** 2)))
    let jump = 0
    for (let i = 1; i < pts.length; i++) jump = Math.max(jump, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
    return { rms, jump }
  }
  const clean = await spread()
  phone.drop = 0.05
  phone.jitterMs = 20
  await sleep(1500)
  const noisy = await spread()
  const stNoisy = await page.evaluate(() => window.lookask.truedepth.status())
  const dev = stNoisy.devices.find((d) => d.dev === phone.dev)
  check(
    '丢包 5%、抖动 20ms 时视线圈不乱跳',
    noisy.rms < 20 && noisy.jump < 40 && noisy.rms < clean.rms * 2 + 4,
    `抖动 RMS ${noisy.rms.toFixed(1)} 点（正常 ${clean.rms.toFixed(1)}），最大单帧跳 ${noisy.jump.toFixed(1)} 点；Mac 估的丢包 ${Math.round((dev?.loss ?? 0) * 100)}%，${dev?.fps} fps`
  )
  phone.drop = 0
  phone.jitterMs = 0

  // 设置页配对面板截图
  await page.evaluate(() => window.__la.uiStore.patch({ showSettings: true, settingsTab: 'gaze' }))
  await sleep(1200)
  await shot(page, '5-设置眼动.png')
  await page.evaluate(() => window.__la.uiStore.patch({ showSettings: false }))
} catch (e) {
  check('测试脚本跑完', false, e.stack || String(e))
}

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  const lines = appLog.split('\n').filter((l) => /renderer:(2|3|error|warn)|Error|error/i.test(l) && !/XNNPACK/.test(l))
  if (lines.length) console.log('\n开发版日志里的报错：\n' + lines.slice(-30).join('\n'))
}
console.log(`\n${results.length - failed.length}/${results.length} 通过；截图在 ${OUT}`)
await cleanup(failed.length ? 1 : 0)

// ---------- 对照模型 ----------

/** 四元数 → 视线（+z 轴）→ yaw / pitch */
function eyeAngles(q) {
  const [x, y, z, w] = q
  const v = [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)]
  return [Math.atan2(v[0], v[2]), Math.asin(Math.max(-1, Math.min(1, v[1])))]
}

function naiveFeatures(f) {
  const [yl, pl] = eyeAngles(f.eyeL.quat)
  const [yr, pr] = eyeAngles(f.eyeR.quat)
  const p = f.head.pos
  return [(yl + yr) / 2, (pl + pr) / 2, p[0], p[1], p[2], 1]
}

function lsq(X, y) {
  const n = X[0].length
  const A = Array.from({ length: n }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < n; r++) {
      A[r][n] += X[i][r] * y[i]
      for (let c = 0; c < n; c++) A[r][c] += X[i][r] * X[i][c]
    }
  }
  for (let r = 0; r < n; r++) A[r][r] += 1e-6
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const k = A[r][c] / A[c][c]
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j]
    }
  }
  return A.map((row, i) => row[n] / row[i])
}

/** 在假手机上（不走网络）按同样的 17 点、同样的轻微头晃采数据，拟合对照模型 */
function fitNaive(phone, display, _targets, occ) {
  const sim = new FakePhone({ display, mount: 'bottom', seed: 99 })
  const a = 0.07
  const b = 0.93
  const p = 0.29
  const q = 0.71
  const grid = [[a, a], [0.5, a], [b, a], [b, 0.5], [0.5, 0.5], [a, 0.5], [a, b], [0.5, b], [b, b], [p, p], [0.5, p], [q, p], [q, 0.5], [p, 0.5], [p, q], [0.5, q], [q, q]]
  const X = []
  const tx = []
  const ty = []
  let k = 0
  for (const [u, v] of grid) {
    if (u >= occ.x0 && u <= occ.x1 && v >= occ.y0) continue
    sim.lookAt(u * display.ptW, v * display.ptH)
    for (let i = 0; i < 50; i++, k++) {
      sim.setHead({ x: 0.004 * Math.sin(k / 9), y: 0.003 * Math.cos(k / 7), z: 0.006 * Math.sin(k / 13), roll: 2 * Math.sin(k / 20) })
      X.push(naiveFeatures(sim.frame()))
      tx.push(u * display.ptW)
      ty.push(v * display.ptH)
    }
  }
  const wx = lsq(X, tx)
  const wy = lsq(X, ty)
  return {
    errAt(targets, head) {
      const errs = []
      for (const [u, v] of targets) {
        sim.lookAt(u * display.ptW, v * display.ptH)
        sim.setHead({ x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0, ...head })
        let sx = 0
        let sy = 0
        for (let i = 0; i < 30; i++) {
          const f = naiveFeatures(sim.frame())
          sx += f.reduce((s, x, j) => s + x * wx[j], 0)
          sy += f.reduce((s, x, j) => s + x * wy[j], 0)
        }
        errs.push(Math.hypot(sx / 30 - u * display.ptW, sy / 30 - v * display.ptH))
      }
      return errs.reduce((x, y) => x + y, 0) / errs.length
    }
  }
}
