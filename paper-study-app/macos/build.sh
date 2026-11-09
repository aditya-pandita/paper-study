#!/bin/bash
# Builds "Paper Study.app" into paper-study-app/dist/ using Swift Package Manager (no Xcode needed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APPROOT="$(cd "$HERE/.." && pwd)"
DIST="$APPROOT/dist"
APP="$DIST/Paper Study.app"

cd "$HERE"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/PaperStudy"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/lib"
cp "$BIN" "$APP/Contents/MacOS/PaperStudy"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp "$APPROOT/index.html" "$APPROOT/app.js" "$APPROOT/style.css" "$APP/Contents/Resources/web/"
cp "$APPROOT/lib/validate.js" "$APPROOT/lib/fixes.js" "$APP/Contents/Resources/web/lib/"

# App icon: draw once at 1024 px, then let sips/iconutil make the .icns
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
python3 -I "$APPROOT/tools/make_icon.py" "$ICONSET/icon_512x512@2x.png" 1024
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature so macOS will run it locally
codesign --force --deep --sign - "$APP"
echo "Built: $APP"
