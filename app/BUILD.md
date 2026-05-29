# 游戏中心 打包指南

## 项目结构

```
APP/
├── main.js            # Electron 主进程（HTTP 服务器 + 窗口管理）
├── preload.js         # 预加载脚本（IPC 桥接）
├── launcher.html      # 游戏启动器界面
├── launcher.css       # 启动器样式
├── games/             # 所有游戏（每个游戏一个文件夹）
│   └── 狩猎游戏/
│       └── index.html
└── dist/              # 构建产物
    ├── mac-universal/游戏中心.app
    └── 游戏中心-2.0.0-Mac.dmg
```

## 打包命令

```bash
cd /Users/wulart/tianye/APP

# macOS 打包
npm run build:mac

# Windows 打包
npm run build
```

## 打包产物

| 文件 | 说明 |
|------|------|
| `dist/mac-universal/游戏中心.app` | macOS 应用 |
| `dist/游戏中心-2.0.0-Mac.dmg` | macOS 安装镜像 |

## 添加新游戏

1. 在 `games/` 下创建游戏文件夹，放入 HTML 入口文件
2. 在 `launcher.html` 的 `games` 数组中注册：
   ```js
   { id:'文件夹名', name:'显示名称', desc:'描述', icon:'🎯', file:'入口.html', tags:['标签'], genre:'分类' }
   ```
   `id` 必须与文件夹名称一致
3. 重新打包

## 版本号

在 `package.json` 中修改 `version` 字段。

## 技术栈

- Electron + electron-builder
- 内嵌 HTTP 服务器（端口 18765），游戏通过 `http://localhost:{port}/games/...` 加载
- LAN 联机通过 WebSocket 实现
