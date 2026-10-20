#!/bin/bash
# 生成 dist/Iris.app(完全离线,仅依赖系统自带 WebKit)
set -e
cd "$(dirname "$0")"
python3 build_html.py
cp dist/reader.html dist/Iris.html   # 通用单文件版:任意系统的浏览器直接打开

APP="dist/Iris.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# 部署目标 13.3:页面用到的 DecompressionStream / 正则后行断言需要 Safari 16.4(macOS 13.3)的 WebKit
MIN=13.3
T=$(mktemp -d)
swiftc -O -target arm64-apple-macos$MIN -o "$T/arm64" src/main.swift
if swiftc -O -target x86_64-apple-macos$MIN -o "$T/x86_64" src/main.swift 2>/dev/null; then
  lipo -create "$T/arm64" "$T/x86_64" -output "$APP/Contents/MacOS/Iris"
else
  echo "x86_64 构建失败,仅生成 arm64"; cp "$T/arm64" "$APP/Contents/MacOS/Iris"
fi
rm -rf "$T"
cp dist/reader.html "$APP/Contents/Resources/reader.html"
cp src/home.html "$APP/Contents/Resources/home.html"
cp src/home_icon.png "$APP/Contents/Resources/home_icon.png"
[ -f src/AppIcon.icns ] && cp src/AppIcon.icns "$APP/Contents/Resources/"
cp src/Info.plist "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" 2>/dev/null || true
echo "✓ $APP"
