#!/bin/bash
# 生成 dist/Iris-<版本>.dmg(内含 Iris.app 与 Applications 快捷方式)
set -e
cd "$(dirname "$0")"
./build.sh
VER=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' src/Info.plist)
DMG="dist/Iris-$VER.dmg"
STAGE=$(mktemp -d)
cp -R dist/Iris.app "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Iris" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
shasum -a 256 "$DMG"
echo "✓ $DMG"
