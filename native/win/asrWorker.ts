import { createInterface } from 'node:readline'
import { join } from 'node:path'

// 本地语音识别子进程：主进程用 ELECTRON_RUN_AS_NODE 拉起，SenseVoice 推理放在这里，不卡界面。
// 一行 JSON 进（{ id, pcm: base64 的 16kHz 单声道 16 位 PCM }），一行 JSON 出（{ id, text } 或 { id, error }）；启动好了先发 { ready: true }

const modelDir = process.argv[2]
const send = (m: unknown): void => void process.stdout.write(JSON.stringify(m) + '\n')

try {
  // 原生模块和它依赖的 DLL 都在同一个目录；主进程已经把这个目录加进 PATH
  const addonPath = join(__dirname, 'sherpa-onnx-win-x64', 'sherpa-onnx.node')
  const addon = module.require(addonPath)
  const recognizer = addon.createOfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: join(modelDir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
      tokens: join(modelDir, 'tokens.txt'),
      numThreads: 4,
      provider: 'cpu',
      debug: 0
    }
  })
  send({ ready: true })

  createInterface({ input: process.stdin }).on('line', (line) => {
    let id = 0
    try {
      const req = JSON.parse(line) as { id: number; pcm: string }
      id = req.id
      const raw = Buffer.from(req.pcm, 'base64')
      const samples = new Float32Array(Math.floor(raw.length / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * 2) / 32768
      const stream = addon.createOfflineStream(recognizer)
      addon.acceptWaveformOffline(stream, { samples, sampleRate: 16000 })
      addon.decodeOfflineStream(recognizer, stream)
      const result = JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as { text?: string }
      send({ id, text: (result.text || '').trim() })
    } catch (e) {
      send({ id, error: String((e as Error)?.message || e) })
    }
  })
} catch (e) {
  send({ fatal: String((e as Error)?.message || e) })
  process.exit(1)
}
