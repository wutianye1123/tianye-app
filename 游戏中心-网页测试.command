#!/bin/bash
# 网页测试：起本地服务器+浏览器打开，最快看效果（纯网页能力，不测Electron专属功能）
# 端口优先用 18765（与正式版同源共用存档）；被占用则退回 8123（存档独立）
cd "$(dirname "$0")/app"
PORT=18765
if lsof -i tcp:18765 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠ 18765 被占用（正式版在跑？）——用 8123 独立端口，存档不共用"
  PORT=8123
fi
echo "本地服务: http://localhost:$PORT （关掉浏览器标签页后 Ctrl+C 停服务）"
open "http://localhost:$PORT/launcher.html"
python3 -m http.server $PORT
