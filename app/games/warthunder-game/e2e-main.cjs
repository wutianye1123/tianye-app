// e2e-main.cjs — 联机 E2E 测试用 Electron 入口（完全隐藏窗口，不弹窗打扰）：
//   electron e2e-main.cjs <游戏URL> <日志名>
// show:false + backgroundThrottling:false → 窗口不可见但 rAF/定时器全速运行，
// 渲染进程 console 全部打到 stderr（含报错堆栈）。
const { app, BrowserWindow } = require('electron');
const url = process.argv[2] || 'about:blank';
const tag = process.argv[3] || 'win';
app.setPath('userData', '/tmp/wt-e2e-' + tag);   // 每实例独立 userData，避免单例锁/缓存互踩
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 960, height: 680,
    show: false,   // ★ 隐藏窗口：桌面上什么都不弹
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },   // ★ 后台不节流：rAF 全速
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    process.stderr.write(`[${tag}][lv${level}] ${message}${sourceId ? '  @' + sourceId + ':' + line : ''}\n`);
  });
  win.webContents.on('render-process-gone', (e, details) => {
    process.stderr.write(`[${tag}] RENDERER GONE: ${details.reason}\n`);
  });
  win.loadURL(url);
});
