// 安装后准备离线资源：从 node_modules 拷 MediaPipe 的 wasm 运行时，并下载人脸关键点模型
// 这些大文件不进 git，打包时随 renderer/public 一起进 App
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src/renderer/public/mediapipe')
mkdirSync(outDir, { recursive: true })

// Apple 芯片的 Chromium 都支持 wasm SIMD，只带 SIMD 版运行时（不带 nosimd / module 版，省 20MB）
const wasmDir = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
for (const f of readdirSync(wasmDir)) {
  if (f.startsWith('vision_wasm_internal.')) copyFileSync(join(wasmDir, f), join(outDir, f))
}
for (const f of readdirSync(outDir)) {
  if (/^vision_wasm_(nosimd|module)_internal/.test(f)) rmSync(join(outDir, f))
}

const modelPath = join(outDir, 'face_landmarker.task')
const modelUrl =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
if (!existsSync(modelPath) || statSync(modelPath).size < 1_000_000) {
  console.log('[fetch-assets] 下载 face_landmarker.task …')
  const res = await fetch(modelUrl)
  if (!res.ok) throw new Error(`模型下载失败 ${res.status}`)
  writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()))
}
// pdf.js 的中日韩 CMap、标准字体、解码 wasm、色彩配置：中文 PDF 没有 CMap 会乱码
const pdfDir = join(root, 'src/renderer/public/pdfjs')
for (const sub of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = join(root, 'node_modules/pdfjs-dist', sub)
  if (!existsSync(from)) continue
  const to = join(pdfDir, sub)
  mkdirSync(to, { recursive: true })
  for (const f of readdirSync(from)) copyFileSync(join(from, f), join(to, f))
}
console.log('[fetch-assets] MediaPipe / pdf.js 资源就绪')
