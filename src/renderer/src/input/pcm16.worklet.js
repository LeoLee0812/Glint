// 麦克风 → 16 位 PCM 的 AudioWorklet（Windows 按住说话用，见 speech.ts）：
// AudioContext 开在 16kHz，这里把浮点采样转成 16 位整数，攒够 100ms（1600 个）送一块；收到 flush 把零头也送出去
class Pcm16 extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Int16Array(1600)
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data !== 'flush') return
      if (this.n) this.port.postMessage(this.buf.slice(0, this.n).buffer)
      this.n = 0
      this.port.postMessage('flushed')
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer])
        this.buf = new Int16Array(1600)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm16', Pcm16)
