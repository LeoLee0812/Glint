#!/bin/bash
# 编译 LookAsk 原生助手（Joy-Con HID / 语音 / 原深感收包），产物 native/bin/lookask-bridge
# Info.plist 以段的形式嵌进二进制，命令行程序才能申请麦克风和语音识别权限
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O \
  -target arm64-apple-macos13.0 \
  -framework IOKit -framework AppKit -framework Speech -framework AVFoundation \
  -framework Network -framework SystemConfiguration \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker LookAskBridge/Info.plist \
  -o bin/lookask-bridge \
  LookAskBridge/*.swift
codesign --force --sign - --identifier com.leo.lookask.bridge bin/lookask-bridge
echo "==> native/bin/lookask-bridge 编译完成"
