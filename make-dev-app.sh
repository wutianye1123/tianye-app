#!/bin/bash
# 生成 游戏中心-Dev.app（双击直跑源码的 DEV 版入口，无终端窗口）
# 用法: ./make-dev-app.sh   （产物装进 /Applications，并在项目文件夹放一个别名）
set -e
cd "$(dirname "$0")"
APP="/Applications/游戏中心-Dev.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp app/build/appicon.icns "$APP/Contents/Resources/dev-icon.icns" 2>/dev/null || true
cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>游戏中心-Dev</string>
  <key>CFBundleDisplayName</key><string>游戏中心 DEV</string>
  <key>CFBundleIdentifier</key><string>com.game.center.dev</string>
  <key>CFBundleExecutable</key><string>dev-launch</string>
  <key>CFBundleIconFile</key><string>dev-icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST
cat > "$APP/Contents/MacOS/dev-launch" << 'LAUNCH'
#!/bin/bash
# DEV版：退出正式版 → 从源码直跑（与正式版共用存档；改代码后游戏内 Cmd+R 即生效）
pkill -9 -f "游戏中心.app/Contents/MacOS" 2>/dev/null
sleep 1
cd /Users/wulart/tianye/app
export GC_DEV=1
exec npx electron .
LAUNCH
chmod +x "$APP/Contents/MacOS/dev-launch"
touch "$APP"
# 项目文件夹放一个别名（还原老 DEV 版所在的位置）
osascript -e 'tell application "Finder" to make alias file to POSIX file "/Applications/游戏中心-Dev.app" at POSIX file "/Users/wulart/tianye/"' >/dev/null 2>&1 || true
echo "已生成 $APP"
