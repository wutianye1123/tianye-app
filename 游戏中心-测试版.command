#!/bin/bash
# 源码直跑测试版：不打包，改代码 → 游戏里 Cmd+R 刷新即生效
# 注意：与正式版共用存档（同一端口同一数据），启动前会自动退出正式版，测完先关测试版再开正式版
cd "$(dirname "$0")"
echo "退出正式版（如在运行）…"
pkill -9 -f "游戏中心.app/Contents/MacOS" 2>/dev/null
sleep 1
echo "从源码启动测试版（关闭此窗口或 Cmd+Q 退出）…"
export GC_DEV=1
cd app cd app && npx electron .cd app && npx electron . npx electron .
