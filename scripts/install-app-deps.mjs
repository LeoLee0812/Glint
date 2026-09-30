// npm install 之后为 Electron 重编译原生依赖（node-pty）。只在 Mac 上做：
// Windows 上 node-pty / node-hid 都自带 Node-API 预编译二进制，直接能用；
// 而且 node-pty 源码包里缺 winpty 的 GetCommitHash.bat，node-gyp 在 Windows 上根本编不过
import { spawnSync } from 'node:child_process'

if (process.platform === 'win32') {
  console.log('[install-app-deps] Windows 直接用 node-pty 自带的预编译版，跳过重编译')
  process.exit(0)
}
const r = spawnSync('electron-builder', ['install-app-deps'], { stdio: 'inherit', shell: true })
process.exit(r.status ?? 1)
