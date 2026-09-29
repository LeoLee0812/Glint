#!/usr/bin/env bash
# 打包并重装 Glint：删掉 /Applications 里的旧版，装上刚打的新版，只留这一份
# 用法：npm run reinstall
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
BUILT="release/$VERSION/mac-arm64/Glint.app"
DEST="/Applications/Glint.app"

# 打包产物目录不让 Spotlight 收录，免得启动台 / 聚焦里出现两个 Glint
mkdir -p release
touch release/.metadata_never_index

npm run dist

# 正在跑的 Glint 先退掉——不管是从 /Applications 还是从 release/ 里打开的
# （单实例锁：旧的不退，新装的打开只会把旧窗口拉到前台）；开发版进程名是 Electron，不受影响
RUNNING="Glint.app/Contents/MacOS/Glint"
if pgrep -f "$RUNNING" >/dev/null; then
  osascript -e 'tell application id "com.leo.lookask" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -f "$RUNNING" >/dev/null || break; sleep 0.5; done
  pkill -f "$RUNNING" 2>/dev/null || true
fi

rm -rf "$DEST"
ditto "$BUILT" "$DEST"
# 装好后删掉打包目录里的 .app（dmg 留着），系统里只剩 /Applications 这一份
rm -rf "release/$VERSION/mac-arm64"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

open "$DEST"
echo "已重装：${DEST}（版本 ${VERSION}）"
