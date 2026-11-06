// 编译原生助手，产物放 native/bin（开发时主进程从这里拉起，打包时经 extraResources 放进 resources/bin）
// - Mac：swiftc 编 native/LookAskBridge（见 native/build.sh）→ native/bin/lookask-bridge
// - Windows：esbuild 把 native/win/*.ts 连同 node-hid 的 JS 打成一个文件 → native/bin/lookask-bridge.cjs，
//   再把 node-hid 自带的 Node-API 预编译二进制拷到它旁边的 prebuilds/ 里（node-hid 按 __dirname 找二进制）；
//   本地语音子进程打成 native/bin/lookask-asr.cjs，sherpa-onnx 的 Windows 二进制下到它旁边
// 带 --win 时在 Mac 上也按 Windows 打（交叉打包用）
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const forWin = process.argv.includes('--win')

if (process.platform === 'darwin' && !forWin) {
  const r = spawnSync('bash', [join(root, 'native/build.sh')], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

if (process.platform !== 'win32' && !forWin) {
  console.error('[build-native] 只支持 macOS 和 Windows')
  process.exit(1)
}

const { build } = await import('esbuild')
const outDir = join(root, 'native/bin')
mkdirSync(outDir, { recursive: true })
await build({
  entryPoints: [join(root, 'native/win/main.ts')],
  outfile: join(outDir, 'lookask-bridge.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning'
})

// 只带 Windows 的两种架构（x64 / arm64），各 400KB 左右
for (const arch of ['x64', 'arm64']) {
  const name = `HID-win32-${arch}`
  const from = join(root, 'node_modules/node-hid/prebuilds', name, 'node-napi-v4.node')
  if (!existsSync(from)) {
    console.error(`[build-native] 找不到 ${from}，先 npm install`)
    process.exit(1)
  }
  const to = join(outDir, 'prebuilds', name)
  mkdirSync(to, { recursive: true })
  copyFileSync(from, join(to, 'node-napi-v4.node'))
}

// 本地语音（SenseVoice）：子进程脚本 + sherpa-onnx 的 Windows 版原生模块和 DLL。这个包限定 Windows，Mac 上 npm install 装不上，所以直接下 tarball
await build({
  entryPoints: [join(root, 'native/win/asrWorker.ts')],
  outfile: join(outDir, 'lookask-asr.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning'
})
const SHERPA = 'sherpa-onnx-win-x64'
const SHERPA_VERSION = '2.0.1'
const sherpaDir = join(outDir, SHERPA)
if (!existsSync(join(sherpaDir, 'sherpa-onnx.node'))) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const pack = spawnSync(npm, ['pack', `${SHERPA}@${SHERPA_VERSION}`, '--silent', '--pack-destination', outDir], { encoding: 'utf8', shell: process.platform === 'win32' })
  const tgz = join(outDir, `${SHERPA}-${SHERPA_VERSION}.tgz`)
  if (pack.status !== 0 || !existsSync(tgz)) {
    console.error(`[build-native] 下载 ${SHERPA} 失败：${pack.stderr}`)
    process.exit(1)
  }
  const untar = spawnSync('tar', ['-xzf', tgz, '-C', outDir], { stdio: 'inherit' })
  if (untar.status !== 0) process.exit(1)
  renameSync(join(outDir, 'package'), sherpaDir)
}
console.log('==> native/bin/lookask-bridge.cjs 和 lookask-asr.cjs 编译完成')
