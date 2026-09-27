#!/usr/bin/env node
// 假 iPhone：按 LookAskEye 的协议往 Mac 发 UDP 帧，没有真手机时测 Mac 端全链路用
//
// 几何：虚拟一个人坐在屏幕前，手机按摆放位置固定在屏幕上（默认竖放在屏幕和键盘之间的缝里，镜头在屏幕中间偏上）。
// 给定「头的位置 / 转角」和「看屏幕上哪个点」，按 ARKit 的约定算出头、双眼的位姿，
// 再加上 ARKit 常见的毛病：眼睛转角偏小（增益 < 1）、固定偏置、逐帧噪声。
// 相机坐标系故意和屏幕坐标系差一个 90° 旋转（手机竖放），还可以 --mirror 模拟「坐标系左右镜像」，
// 看 Mac 端能不能自己兜住。
//
// 命令行：
//   node scripts/fake-truedepth.mjs                         # 用 Bonjour 找 Mac，循环跑演示轨迹
//   node scripts/fake-truedepth.mjs --host 127.0.0.1 --port 47650 --drop 5% --jitter 20ms
//   选项：--code 4827 --fps 60 --mount bottom|top --mirror --name <Bonjour 名> --traj demo|still
// 测试脚本里：import { FakePhone, findMac } from './fake-truedepth.mjs'，用 setHead / lookAt 精确控制

import dgram from 'node:dgram'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// ---------- 小线性代数 ----------

const rad = (d) => (d * Math.PI) / 180
const mulMV = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
const mulMM = (a, b) => {
  const o = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return o
}
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const unit = (a) => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / n, a[1] / n, a[2] / n]
}
const Rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)]
const Ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)]
const Rz = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1]

/** 旋转矩阵 → 四元数 [x, y, z, w] */
function matToQuat(m) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m
  const tr = m00 + m11 + m22
  let x, y, z, w
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s
    x = (m21 - m12) / s
    y = (m02 - m20) / s
    z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }
  return [x, y, z, w]
}

/** 可复现的随机数 */
function rng(seed) {
  let s = seed >>> 0 || 1
  const u = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const n = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u())
  return { u, n }
}

// ---------- 场景 ----------

// 屏幕坐标系 D：原点在手机镜头，x 朝人的右手、y 朝上、z 朝人。相机坐标系 C = R_CD · D（手机竖放，差 90°）
const R_CD = [0, 1, 0, -1, 0, 0, 0, 0, 1]
// ARKit 脸坐标系：+x 是脸自己的左边、+y 朝上、+z 从脸朝外。正对屏幕时在 D 里是 diag(-1, 1, -1)
const FACE_NEUTRAL = [-1, 0, 0, 0, 1, 0, 0, 0, -1]
// 两眼相对脸原点的位置（脸坐标系，米）：左眼在脸的 +x
const EYE_L = [0.031, 0.026, 0.028]
const EYE_R = [-0.031, 0.026, 0.028]
// 镜像：整个坐标系左右翻（位置 p → Mp，旋转 R → MRM）
const MIRROR = [-1, 0, 0, 0, 1, 0, 0, 0, 1]

export const MBA13 = { mmW: 290.3, mmH: 188.7, ptW: 1280, ptH: 832 }

export class FakePhone {
  constructor(o = {}) {
    this.host = o.host || '127.0.0.1'
    this.port = o.port || 47650
    this.code = o.code || '4827'
    this.dev = o.dev || 'FAKE-' + crypto.randomBytes(4).toString('hex').toUpperCase()
    this.name = o.name || '假 iPhone'
    this.display = o.display || MBA13
    this.mount = o.mount || 'bottom'
    this.fps = o.fps || 60
    this.drop = o.drop || 0
    this.jitterMs = o.jitterMs || 0
    this.mirror = !!o.mirror
    // ARKit 的眼睛转角：偏小、带固定偏置、有噪声（度）
    this.gain = o.gain || [0.82, 0.74]
    this.bias = o.bias || [1.2, -2.0]
    this.noiseDeg = o.noiseDeg ?? 0.35
    this.headNoiseM = o.headNoiseM ?? 0.0008
    this.pitchCurve = o.pitchCurve ?? 0.25
    this.rand = rng(o.seed || 20260928)
    this.sid = (crypto.randomBytes(4).readUInt32BE(0) % 2_000_000_000) + 1
    this.seq = 0
    this.sock = null
    this.timer = null
    this.hbTimer = null
    this.paused = false
    this.tracked = true
    this.blinking = false
    this.macState = null
    this.acks = 0
    this.sent = 0
    this.key = crypto.createHash('sha256').update(`lookask-td|${this.dev}|${this.code}`).digest()
    // 默认坐姿：两眼中点在镜头正前方 52 厘米、比镜头高 7 厘米（13 寸 MacBook 上镜头在屏幕上沿往下 6 厘米）
    this.head = { x: 0, y: 0, z: 0, roll: 0, yaw: 0, pitch: 0 }
    this.base = { x: 0, y: 0.07, z: 0.52 }
    const d = this.display
    // 手机镜头在屏幕上的位置（毫米，从屏幕左上角量）和屏幕平面相对镜头的前后位置（米）
    if (this.mount === 'top') {
      this.cam = { u: d.mmW / 2 + 3, v: -11 }
      this.planeZ = 0.007
      this.base = { x: 0, y: -0.04, z: 0.55 }
    } else {
      this.cam = { u: d.mmW / 2 + 4, v: d.mmH - (146.6 - 12) + 8 }
      this.planeZ = -0.011
    }
    this.target = { x: d.ptW / 2, y: d.ptH / 4 }
  }

  /** 头相对默认坐姿的偏移：x/y/z 米（x 朝人的右手、y 朝上、z 往后），roll/yaw/pitch 度（歪向右肩、转向右、低头为正） */
  setHead(h) {
    this.head = { ...this.head, ...h }
  }

  /** 看屏幕上的哪个点（显示器坐标，点） */
  lookAt(x, y) {
    this.target = { x, y }
  }

  setTracked(v) {
    this.tracked = v
  }

  /** 屏幕上的点（点）→ D 坐标（米） */
  screenToD(x, y) {
    const d = this.display
    const u = (x / d.ptW) * d.mmW
    const v = (y / d.ptH) * d.mmH
    return [(u - this.cam.u) / 1000, -(v - this.cam.v) / 1000, this.planeZ]
  }

  /** 按当前头位姿和注视点算一帧（ARKit 坐标约定） */
  frame() {
    const r = this.rand
    const h = this.head
    const faceD = mulMM(mulMM(mulMM(Ry(-rad(h.yaw)), Rx(-rad(h.pitch))), Rz(-rad(h.roll))), FACE_NEUTRAL)
    // 头（脸原点）的位置：让默认姿势下两眼中点落在 base
    const eyeMid = mulMV(FACE_NEUTRAL, [0, 0.026, 0.028])
    const pos = [
      this.base.x + h.x - eyeMid[0] + r.n() * this.headNoiseM,
      this.base.y + h.y - eyeMid[1] + r.n() * this.headNoiseM,
      this.base.z + h.z - eyeMid[2] + r.n() * this.headNoiseM
    ]
    const Q = this.screenToD(this.target.x, this.target.y)
    const eye = (off, bias) => {
      const e = add(pos, mulMV(faceD, off))
      const vF = mulMV(transpose(faceD), unit(sub(Q, e)))
      const yawT = Math.atan2(vF[0], vF[2])
      const pitchT = Math.asin(Math.max(-1, Math.min(1, vF[1])))
      const n = rad(this.noiseDeg)
      const yaw = this.gain[0] * yawT + rad(bias[0]) + r.n() * n
      const pitch = this.gain[1] * pitchT + this.pitchCurve * pitchT * Math.abs(pitchT) + rad(bias[1]) + r.n() * n
      // 眼睛的旋转：先绕 x 抬 / 低，再绕 y 左右，+z 轴就是视线
      return mulMM(Ry(yaw), Rx(-pitch))
    }
    const eL = eye(EYE_L, this.bias)
    const eR = eye(EYE_R, [this.bias[0] + 0.4, this.bias[1] - 0.3])
    const lookF = mulMV(transpose(faceD), sub(Q, pos))
    // 显示器往后仰 15°：重力在 D 里 = -(cos15·y + sin15·z)
    const gD = [0, -Math.cos(rad(15)), -Math.sin(rad(15))]
    // 换到相机坐标系（可选镜像）
    const M = this.mirror ? MIRROR : [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const conj = (R) => mulMM(mulMM(M, R), M)
    const headC = conj(mulMM(R_CD, faceD))
    const posC = mulMV(M, mulMV(R_CD, pos))
    const gC = mulMV(M, mulMV(R_CD, gD))
    const q = (v) => v.map((x) => Math.round(x * 1e5) / 1e5)
    const blink = this.blinking ? 0.92 : 0.04 + Math.abs(r.n()) * 0.02
    const bs = {
      eyeBlinkLeft: blink,
      eyeBlinkRight: blink,
      jawOpen: 0.02,
      eyeLookInLeft: 0,
      eyeLookOutLeft: 0,
      eyeLookUpLeft: 0,
      eyeLookDownLeft: 0,
      eyeLookInRight: 0,
      eyeLookOutRight: 0,
      eyeLookUpRight: 0,
      eyeLookDownRight: 0
    }
    return {
      tracked: this.tracked,
      head: { pos: q(posC), quat: q(matToQuat(headC)) },
      eyeL: { pos: q(mulMV(M, EYE_L)), quat: q(matToQuat(conj(eL))) },
      eyeR: { pos: q(mulMV(M, EYE_R)), quat: q(matToQuat(conj(eR))) },
      look: q(mulMV(M, lookF)),
      bs,
      grav: q(unit(gC)),
      orient: 'portrait'
    }
  }

  packet(obj) {
    const json = JSON.stringify(obj)
    const mac = crypto.createHmac('sha256', this.key).update(json).digest().subarray(0, 16).toString('hex')
    return Buffer.from(mac + json, 'utf8')
  }

  sendRaw(buf) {
    if (!this.sock) return
    if (this.drop > 0 && this.rand.u() < this.drop) return
    const go = () => this.sock && this.sock.send(buf, this.port, this.host)
    if (this.jitterMs > 0) setTimeout(go, this.rand.u() * this.jitterMs)
    else go()
    this.sent++
  }

  common(t) {
    return { t, v: 1, dev: this.dev, sid: this.sid, seq: ++this.seq, ts: Math.round(performance.now()) / 1000 }
  }

  sendFrame() {
    if (this.paused) return
    const f = this.frame()
    const pkt = { ...this.common('f'), ...f }
    if (!this.tracked) {
      delete pkt.head
      delete pkt.eyeL
      delete pkt.eyeR
      delete pkt.look
    }
    this.sendRaw(this.packet(pkt))
  }

  sendHeartbeat() {
    if (this.paused) return
    const hb = { ...this.common('hb'), name: this.name, model: 'iPhone16,1', app: 'fake', therm: 0, fps: this.fps, tracked: this.tracked, orient: 'portrait' }
    // 心跳不丢，方便测试判断配对状态
    if (this.sock) this.sock.send(this.packet(hb), this.port, this.host)
  }

  async start() {
    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => {
      try {
        const a = JSON.parse(String(m))
        if (a.t === 'ack') {
          this.macState = a
          this.acks++
        }
      } catch {
        /* 忽略 */
      }
    })
    await new Promise((r) => this.sock.bind(0, r))
    this.timer = setInterval(() => this.sendFrame(), 1000 / this.fps)
    this.hbTimer = setInterval(() => this.sendHeartbeat(), 1000)
    this.sendHeartbeat()
  }

  /** 模拟断线：这段时间什么都不发 */
  pause(on) {
    this.paused = on
  }

  stop() {
    clearInterval(this.timer)
    clearInterval(this.hbTimer)
    this.timer = this.hbTimer = null
    this.sock?.close()
    this.sock = null
  }
}

/** 用系统自带的 dns-sd 找 _lookask._udp 服务，返回 { name, host, port } */
export function findMac(nameFilter, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const b = spawn('dns-sd', ['-B', '_lookask._udp', 'local.'])
    let done = false
    const finish = (v, err) => {
      if (done) return
      done = true
      b.kill()
      clearTimeout(timer)
      err ? reject(err) : resolve(v)
    }
    const timer = setTimeout(() => finish(null, new Error('没找到 _lookask._udp 服务：Mac 上的 Glint 选了 iPhone 原深感吗？')), timeoutMs)
    b.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const m = /\sAdd\s+\d+\s+\d+\s+\S+\s+_lookask\._udp\.\s+(.+)$/.exec(line)
        if (!m) continue
        const name = m[1].trim()
        if (nameFilter && name !== nameFilter) continue
        const l = spawn('dns-sd', ['-L', name, '_lookask._udp', 'local.'])
        l.stdout.on('data', (x) => {
          const r = /can be reached at (\S+?)\.?:(\d+)/.exec(String(x))
          if (r) {
            l.kill()
            finish({ name, host: r[1].replace(/\.$/, ''), port: Number(r[2]) })
          }
        })
        return
      }
    })
  })
}

// ---------- 命令行 ----------

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return def
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

async function main() {
  let host = arg('host')
  let port = Number(arg('port', 0)) || 0
  if (!host) {
    console.log('用 Bonjour 找 Mac…')
    const mac = await findMac(arg('name'))
    host = mac.host
    port = mac.port
    console.log(`找到「${mac.name}」 ${host}:${port}`)
  }
  const pct = (v) => (typeof v === 'string' ? parseFloat(v) / (v.endsWith('%') ? 100 : 1) : 0)
  const phone = new FakePhone({
    host,
    port: port || 47650,
    code: String(arg('code', '4827')),
    fps: Number(arg('fps', 60)),
    drop: pct(arg('drop', '0')),
    jitterMs: parseFloat(String(arg('jitter', '0'))) || 0,
    mount: arg('mount', 'bottom'),
    mirror: !!arg('mirror', false)
  })
  await phone.start()
  console.log(`假 iPhone 已开始发：设备 ${phone.dev}，配对码 ${phone.code}（在 Glint 设置 → 眼动 里输入）`)
  const d = phone.display
  const nine = []
  for (const v of [0.12, 0.5, 0.88]) for (const u of [0.12, 0.5, 0.88]) nine.push([u * d.ptW, v * d.ptH])
  const t0 = Date.now()
  let last = ''
  setInterval(() => {
    const t = (Date.now() - t0) / 1000
    if (arg('traj', 'demo') === 'demo') {
      const k = Math.floor(t / 1.5) % 9
      phone.lookAt(nine[k][0], nine[k][1])
      const ph = t % 40
      const s = Math.sin(((ph % 10) / 10) * 2 * Math.PI)
      phone.setHead({ x: ph >= 10 && ph < 20 ? 0.06 * s : 0, roll: ph >= 20 && ph < 30 ? 15 * s : 0, z: ph >= 30 ? 0.1 * s : 0 })
    }
    const st = phone.macState ? `Mac「${phone.macState.mac}」：${phone.macState.state === 'paired' ? '已配对' : '等配对码'}，收到 ${phone.macState.fps} fps` : 'Mac 还没回话'
    if (st !== last) {
      console.log(st)
      last = st
    }
  }, 50)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message || e)
    process.exit(1)
  })
}
