import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 平板版的渲染进程：和桌面版同一份代码，产物放进 APK 的 assets/www
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    // 平板的 WebView 版本可能比桌面的 Electron 老：pdf.js 正式版用的新接口（Uint8Array.toHex、Map.getOrInsertComputed…）
    // WebView 137 上没有，一打开 PDF 就报错。平板用它的 legacy 版，自带这些补丁
    alias: [
      { find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.min.mjs' },
      { find: /^pdfjs-dist\/build\/pdf\.worker\.min\.mjs/, replacement: 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' }
    ]
  },
  publicDir: resolve(__dirname, 'src/renderer/public'),
  build: {
    outDir: resolve(__dirname, 'android/app/src/main/assets/www'),
    emptyOutDir: true,
    // 页面的 CSP 不许 data: 脚本（录音 worklet），小文件也别内联
    assetsInlineLimit: 0
  }
})
