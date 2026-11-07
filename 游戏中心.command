#!/bin/bash
# 打开正式版游戏中心（唯一真身：/Applications/游戏中心.app）
if [ -d "/Applications/游戏中心.app" ]; then
  open "/Applications/游戏中心.app"
else
  echo "未安装正式版，正在打开网页版…"
  open "https://xiaotuling.com"
fi
