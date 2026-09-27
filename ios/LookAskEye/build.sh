#!/bin/bash
# LookAskEye 构建脚本
#   bash ios/LookAskEye/build.sh test     # 生成工程 + 在模拟器上跑单元测试
#   bash ios/LookAskEye/build.sh ipa      # 无签名 .ipa → release/ios/（以后用 Sideloadly / AltStore 拿 Apple ID 重签安装）
#   bash ios/LookAskEye/build.sh device   # 用本机个人团队证书签名，装到插着线（或同一 Wi‑Fi、已解锁）的 iPhone 上
# 没越狱的 iPhone 装不了完全无签名的 App；免费个人团队签的版本 7 天后过期，到时再跑一次 device
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
DD="${LOOKASK_IOS_DD:-$ROOT/ios/.build}"
SIM_NAME="LookAsk iPhone 15 Pro"

xcodegen generate >/dev/null

case "${1:-}" in
  test)
    SIM=$(xcrun simctl list devices | grep "$SIM_NAME" | grep -oE '[0-9A-F-]{36}' | head -1)
    if [ -z "$SIM" ]; then
      SIM=$(xcrun simctl create "$SIM_NAME" com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro "$(xcrun simctl list runtimes | grep -oE 'com.apple.CoreSimulator.SimRuntime.iOS-[0-9-]+' | tail -1)")
    fi
    xcodebuild -project LookAskEye.xcodeproj -scheme LookAskEye -destination "platform=iOS Simulator,id=$SIM" \
      -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO test
    ;;
  ipa)
    xcodebuild -project LookAskEye.xcodeproj -scheme LookAskEye -configuration Release -sdk iphoneos \
      -derivedDataPath "$DD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
    OUT="$ROOT/release/ios"
    TMP="$(mktemp -d)"
    mkdir -p "$TMP/Payload" "$OUT"
    cp -R "$DD/Build/Products/Release-iphoneos/LookAskEye.app" "$TMP/Payload/"
    VER=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$TMP/Payload/LookAskEye.app/Info.plist")
    (cd "$TMP" && zip -qry "$OUT/LookAskEye-$VER-unsigned.ipa" Payload)
    rm -rf "$TMP"
    echo "==> $OUT/LookAskEye-$VER-unsigned.ipa"
    ;;
  device)
    DEVICE=$(xcrun devicectl list devices 2>/dev/null | grep -E 'iPhone' | grep -v unavailable | grep -oE '[0-9A-F]{8}-[0-9A-F-]{27}' | head -1)
    xcodebuild -project LookAskEye.xcodeproj -scheme LookAskEye -configuration Debug -destination 'generic/platform=iOS' \
      -derivedDataPath "$DD" -allowProvisioningUpdates build
    APP="$DD/Build/Products/Debug-iphoneos/LookAskEye.app"
    if [ -z "$DEVICE" ]; then
      echo "==> 签好了：$APP"
      echo "    手机没连上（插线或同一 Wi‑Fi、解锁），连上后再跑一次：bash ios/LookAskEye/build.sh device"
      exit 2
    fi
    xcrun devicectl device install app --device "$DEVICE" "$APP"
    echo "==> 已装到手机。第一次打开要在「设置 → 通用 → VPN 与设备管理」里信任开发者"
    xcrun devicectl device process launch --device "$DEVICE" com.leo.lookask.eye || true
    ;;
  *)
    echo "用法：bash ios/LookAskEye/build.sh test|ipa|device"
    exit 1
    ;;
esac
