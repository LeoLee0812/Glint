import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 主进程 / 预加载 / 渲染进程三段构建；渲染进程有两个入口：主窗口和全局模式的透明视线浮层
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // MediaPipe 的 wasm 与模型放在 public 里，原样拷贝、按相对路径加载，打包后离线可用
    publicDir: resolve(__dirname, 'src/renderer/public'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    }
  }
})
