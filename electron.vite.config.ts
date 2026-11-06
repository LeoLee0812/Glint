import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 主进程 / 预加载 / 渲染进程三段构建
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // MediaPipe 的 wasm 与模型放在 public 里，原样拷贝、按相对路径加载，打包后离线可用
    publicDir: resolve(__dirname, 'src/renderer/public'),
    build: {
      // 页面 CSP 不许 data: 脚本：录音 worklet 不到 4KB，默认会被内联成 data: 地址，Windows 按住说话就加载不了
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
