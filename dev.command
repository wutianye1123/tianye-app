#!/bin/bash
cd "$(dirname "$0")"
ELECTRON="./app/node_modules/.bin/electron"
if [ ! -f "$ELECTRON" ]; then
    echo "Installing Electron..."
    cd app && npm install && cd ..
fi
echo "启动天业太空计划 (Cmd+R 刷新)..."
"$ELECTRON" electron-main.js
