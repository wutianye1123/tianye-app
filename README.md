# 天业游戏中心 (Tianye Game Center)

一个基于 Electron + HTML5 的游戏合集，包含多款网页小游戏。

[English](README_EN.md)

## 包含游戏

> 🎖 **旗舰作：陆空对战（类战争雷霆）** —— 63 型载具（坦克/飞机/直升机，六级分房）、真实弹道与装甲判定（跳弹/殉爆/模块）、主机权威联机 PvP、**可学习的人机智能体**（行为克隆+DAgger+PPO，无头评测反超规则 AI）、战雷式机场起飞与 12 张地形。在线玩：[xiaotuling.com](https://xiaotuling.com)

| 游戏 | 类型 |
|------|------|
| 陆空对战 · 类战争雷霆 | 战争 · 联机 PvP · AI 智能体 |
| 天业太空计划 | 太空模拟 |
| 太空发射 | 太空 |
| 火箭发射 | 物理 |
| 3D我的世界 | 3D 沙盒 |
| 2D我的世界 | 2D 沙盒 |
| 3D战斗机 | 3D 飞行 |
| FPV练习 | 飞行模拟 |
| 飞船 | 飞行 |
| CS对战 | FPS |
| 狩猎游戏 | FPS |
| 三体战舰大战 | 策略 |
| 坦克大战 | 策略 |
| 植物大战僵尸 | 塔防 |
| 全面战争模拟器 / 全面战争模拟器 3D | 模拟 |
| 地平线 | 竞速 |
| 3D开车 | 竞速 |
| 沙雕赛车 | 竞速 |
| 模拟山羊 | 休闲 |
| 轻松水族馆 | 休闲 |
| 钓鱼游戏 | 休闲 |
| 花朵大作战 | 休闲 |
| 超级马里奥 | 平台 |
| LevelDevil | 平台 |
| 超级钟表 | 益智 |
| 后室游戏 | 恐怖 |
| 废品机械师 | 物理 |
| 物理破碎 | 物理 |
| Sandboxels 落沙沙盒 | 沙盒 · 物理（by R74n） |
| 星露谷物语 | 模拟 |
| 音乐生成器 | 音乐 |

## 技术栈

- **Electron** - 桌面应用打包
- **Three.js** - 3D 渲染
- **p5.js** - 2D 渲染
- **原生 HTML5 / CSS / JavaScript** - 前端

## 运行方式

### 网页版

在线玩：[https://xiaotuling.com](https://xiaotuling.com)（含全部游戏与联机对战）

或直接在浏览器中打开 `index.html` 体验天业太空计划。

### 桌面版（游戏中心）

```bash
cd app
npm install
npm start
```

## 打包

```bash
# Windows
npm run build

# macOS
npm run build:mac
```

## License

MIT
