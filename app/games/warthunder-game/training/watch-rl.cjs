// watch-rl.cjs — 训练观察窗：可见窗口加入 PPO 训练（真采样真上报，不是录像）
// 用法：electron training/watch-rl.cjs [静态端口=8123] [PPO端口=8770]
// 看什么：右上角 🧠 角标 gen 数字（每 ~1 分钟换一代大脑）、σ 探索强度、
//         bot 的驾驶风格随代际变化；局末自动重开新局。
const { app, BrowserWindow } = require('electron');
const PORT = process.argv[2] || process.argv[2] === '' ? (process.argv[2] || '8123') : '8123';
const PPO_PORT = process.argv[3] || '8770';
function log(m) { process.stderr.write(`[watch] ${new Date().toISOString().slice(11, 19)} ${m}\n`); }

app.setPath('userData', '/tmp/wt-watch-rl');
app.whenReady().then(() => {
  const url = `http://localhost:${PORT || '8123'}/?auto=tank&rl=1&rlSrv=${encodeURIComponent('http://127.0.0.1:' + (PPO_PORT || '8770'))}&farmSeed=watch-${Date.now()}`;
  const win = new BrowserWindow({
    width: 1280, height: 800,
    show: true,   // ★ 可见窗口——看得见的训练
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e, l, m) => {
    if (/RL\]|stats/.test(m)) log(m.slice(0, 150));
  });
  win.webContents.on('render-process-gone', (e, d) => { log(`GONE: ${d.reason} → reload`); setTimeout(load, 2000); });
  const load = () => win.loadURL(url + '&r=' + Date.now()).catch(() => {});
  load();
  // 局末重开（与农场同款守望）
  setInterval(() => {
    if (win.isDestroyed()) return;
    win.webContents.executeJavaScript(
      `window.__game ? (window.__game.state === 'over' ? 'over' : 'ok') : 'nogame'`, true
    ).then((s) => { if (s === 'over') load(); }).catch(() => {});
  }, 2000);
  log(`观察窗已开（真训练窗口之一）: ${url.slice(0, 80)}…`);
});
