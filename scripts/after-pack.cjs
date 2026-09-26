// 打包后、做 dmg 前：给 .app 做 ad-hoc 签名（Apple 芯片上未签名的程序会被系统拒绝运行）
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const bridge = join(app, 'Contents/Resources/bin/lookask-bridge')
  // 原生助手单独签一次，身份固定，系统权限（麦克风 / 语音）才认得住
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.leo.lookask.bridge', bridge], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log('  • ad-hoc 签名完成', app)
}
