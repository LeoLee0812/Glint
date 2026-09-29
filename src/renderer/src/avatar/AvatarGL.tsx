import { useEffect, useRef, useState } from 'react'
import { gaze } from '../gaze/engine'
import { buildRig, deformRig, type RigPose } from './rig'
import { avatarLandmarks } from './landmarks'
import { spring, step } from './spring'

// 实时小人的 2.5D 渲染：卡通图变成网格，跟着你的头真的转过去、眨眼、张嘴、眼珠跟着瞟
// 每一帧直接读眼动引擎的原始头姿（gaze.live），自己做弹簧平滑：头会稍微过冲一点再停、头发慢半拍甩、身体跟着呼吸起伏
// 转角减掉一个很慢的基准（你平时的坐姿）：摄像头装得偏、平时习惯低头看屏幕，小人也还是正脸
// 网格建不起来（认不出脸、没有 WebGL）就退回原来的静态图片，由外面按旧办法整张转

const VS = `
attribute vec3 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 1.0);
}`

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_solid;
varying vec2 v_uv;
void main() {
  gl_FragColor = mix(texture2D(u_tex, v_uv), u_color, u_solid);
}`

/** 口腔的颜色 */
const MOUTH: [number, number, number, number] = [0.36, 0.13, 0.12, 1]
/** 基准坐姿跟过来的时间常数（秒） */
const BASE_TAU = 25

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

/** 画到 512×512 的画布上当贴图（WebGL1 做多级纹理要求边长是 2 的幂；缩小显示时不闪） */
function potCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = 512
  cv.height = 512
  cv.getContext('2d')!.drawImage(img, 0, 0, 512, 512)
  return cv
}

function program(gl: WebGLRenderingContext): WebGLProgram | null {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
  }
  const vs = sh(gl.VERTEX_SHADER, VS)
  const fs = sh(gl.FRAGMENT_SHADER, FS)
  if (!vs || !fs) return null
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null
}

export function AvatarGL({ src, size, onMode }: { src: string; size: number; onMode?: (gl: boolean) => void }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sizeRef = useRef(size)
  sizeRef.current = size
  const modeRef = useRef(onMode)
  modeRef.current = onMode
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let dead = false
    let raf = 0
    let release = () => {}
    setReady(false)
    modeRef.current?.(false)
    ;(async () => {
      const img = new Image()
      img.src = src
      await img.decode()
      const lm = await avatarLandmarks(src, img).catch((e) => {
        console.warn('[avatar] 小人图上找关键点失败', e)
        return null
      })
      const cv = canvasRef.current
      if (dead || !lm || !cv) return
      const tex = potCanvas(img)
      const rig = buildRig(tex, lm)
      const gl = rig && cv.getContext('webgl', { antialias: true, alpha: false, depth: true })
      const prog = gl && program(gl)
      if (dead || !rig || !gl || !prog) return

      // ---------- 缓冲区和贴图 ----------
      gl.useProgram(prog)
      const aPos = gl.getAttribLocation(prog, 'a_pos')
      const aUv = gl.getAttribLocation(prog, 'a_uv')
      const uSolid = gl.getUniformLocation(prog, 'u_solid')
      const uColor = gl.getUniformLocation(prog, 'u_color')
      const posBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
      gl.bufferData(gl.ARRAY_BUFFER, rig.n * 3 * 4, gl.DYNAMIC_DRAW)
      const uvBuf = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
      gl.bufferData(gl.ARRAY_BUFFER, rig.uv, gl.STATIC_DRAW)
      const triBuf = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rig.tris, gl.STATIC_DRAW)
      const mouthBuf = gl.createBuffer()
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mouthBuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rig.mouthTris, gl.STATIC_DRAW)
      const texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex)
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.enable(gl.DEPTH_TEST)
      gl.depthFunc(gl.LEQUAL)
      release = () => {
        gl.deleteBuffer(posBuf)
        gl.deleteBuffer(uvBuf)
        gl.deleteBuffer(triBuf)
        gl.deleteBuffer(mouthBuf)
        gl.deleteTexture(texture)
        gl.deleteProgram(prog)
      }

      // ---------- 驱动：弹簧 ----------
      const S = {
        yaw: spring(),
        pitch: spring(),
        roll: spring(),
        hairYaw: spring(),
        hairPitch: spring(),
        hairRoll: spring(),
        blink: spring(),
        lookX: spring(),
        lookY: spring(),
        jaw: spring(),
        brow: spring()
      }
      let base: { yaw: number; pitch: number; roll: number } | null = null
      let last = performance.now()
      let nextBlink = last + 3000
      let blinkUntil = 0
      const pos = new Float32Array(rig.n * 3)
      const pose: RigPose = { yaw: 0, pitch: 0, roll: 0, hairYaw: 0, hairPitch: 0, hairRoll: 0, blink: 0, lookX: 0, lookY: 0, jaw: 0, brow: 0, breath: 0 }

      const frame = (now: number) => {
        if (dead) return
        const dt = Math.min(0.1, (now - last) / 1000)
        last = now
        const live = gaze.live
        const fresh = !!live.pose && now - live.t < 700
        let ty = 0
        let tp = 0
        let tr = 0
        let tb = 0
        let tlx = 0
        let tly = 0
        let tj = 0
        let tbr = 0
        if (fresh) {
          const rot = live.pose!.rot
          if (rot) {
            if (!base) base = { ...rot }
            const k = dt / BASE_TAU
            base.yaw += (rot.yaw - base.yaw) * k
            base.pitch += (rot.pitch - base.pitch) * k
            base.roll += (rot.roll - base.roll) * k
            // 转得比你稍微夸张一点点，小尺寸下才看得出来
            ty = clamp((rot.yaw - base.yaw) * 1.2, -0.6, 0.6)
            tp = clamp((rot.pitch - base.pitch) * 1.25, -0.42, 0.42)
            tr = clamp(rot.roll - base.roll, -0.55, 0.55)
          }
          const e = live.expr
          if (e) {
            tb = clamp((e.blink - 0.22) / 0.38, 0, 1)
            tlx = e.lookX
            tly = e.lookY
            tj = clamp((e.mouth - 0.08) / 0.6, 0, 1)
            tbr = clamp(((e.brow ?? 0) - 0.15) / 0.5, 0, 1)
          }
        } else {
          // 看不到你：回正，自己隔几秒眨一下眼
          if (now > nextBlink) {
            blinkUntil = now + 140
            nextBlink = now + 2800 + Math.random() * 2600
          }
          tb = now < blinkUntil ? 1 : 0
        }
        pose.yaw = step(S.yaw, ty, 14, 0.62, dt)
        pose.pitch = step(S.pitch, tp, 14, 0.62, dt)
        pose.roll = step(S.roll, tr, 12, 0.65, dt)
        // 头发追的是「头现在的角度」，更软更慢，所以会甩过头再荡回来
        pose.hairYaw = step(S.hairYaw, pose.yaw, 6.5, 0.32, dt)
        pose.hairPitch = step(S.hairPitch, pose.pitch, 6.5, 0.32, dt)
        pose.hairRoll = step(S.hairRoll, pose.roll, 6, 0.35, dt)
        pose.blink = step(S.blink, tb, 55, 1, dt)
        pose.lookX = step(S.lookX, tlx, 26, 0.85, dt)
        pose.lookY = step(S.lookY, tly, 26, 0.85, dt)
        pose.jaw = step(S.jaw, tj, 24, 0.8, dt)
        pose.brow = step(S.brow, tbr, 12, 0.9, dt)
        pose.breath = Math.sin(((now / 1000) * 2 * Math.PI) / 3.8)
        deformRig(rig, pose, pos)

        const px = Math.max(16, Math.round(sizeRef.current * (window.devicePixelRatio || 1)))
        if (cv.width !== px || cv.height !== px) {
          cv.width = px
          cv.height = px
        }
        gl.viewport(0, 0, px, px)
        gl.clearColor(rig.bg[0], rig.bg[1], rig.bg[2], 1)
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos)
        gl.enableVertexAttribArray(aPos)
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0)
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf)
        gl.enableVertexAttribArray(aUv)
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0)
        if (rig.mouthTris.length && pose.jaw > 0.02) {
          gl.uniform1f(uSolid, 1)
          gl.uniform4fv(uColor, MOUTH)
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mouthBuf)
          gl.drawElements(gl.TRIANGLES, rig.mouthTris.length, gl.UNSIGNED_SHORT, 0)
        }
        gl.uniform1f(uSolid, 0)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, triBuf)
        gl.drawElements(gl.TRIANGLES, rig.tris.length, gl.UNSIGNED_SHORT, 0)
        raf = requestAnimationFrame(frame)
      }
      setReady(true)
      modeRef.current?.(true)
      raf = requestAnimationFrame(frame)
    })().catch((e) => console.warn('[avatar] 2.5D 小人起不来，用静态图', e))
    return () => {
      dead = true
      cancelAnimationFrame(raf)
      release()
    }
  }, [src])

  return (
    <>
      {!ready && <img src={src} alt="我的小人" draggable={false} />}
      <canvas ref={canvasRef} className="buddy-gl" style={{ width: size, height: size, display: ready ? 'block' : 'none' }} />
    </>
  )
}
