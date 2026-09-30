// 编译原生助手，产物放 native/bin（开发时主进程从这里拉起，打包时经 extraResources 放进 resources/bin）
// - Mac：swiftc 编 native/LookAskBridge（见 native/build.sh）→ native/bin/lookask-bridge
// - Windows：esbuild 把 native/win/*.ts 连同 node-hid 的 JS 打成一个文件 → native/bin/lookask-bridge.cjs，
//   再把 node-hid 自带的 Node-API 预编译二进制拷到它旁边的 prebuilds/ 里（node-hid 按 __dirname 找二进制）
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform === 'darwin') {
  const r = spawnSync('bash', [join(root, 'native/build.sh')], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}

if (process.platform !== 'win32') {
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
console.log('==> native/bin/lookask-bridge.cjs 编译完成')
