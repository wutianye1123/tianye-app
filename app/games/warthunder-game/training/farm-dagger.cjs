// farm-dagger.cjs — BC 数据录制农场（无头 Electron 多窗口自动打+录制+落盘）
// 用法：electron farm-dagger.cjs [目标样本数=60000] [并发窗口数=4] [输出目录=./data] [端口=8000]
// 原理：每窗口 load ?auto=tank&record=1&autodl=1 —— 游戏自动开局、规则 AI 互打、
//       agent-recorder.js 旁听驾驶指令，每 3000 样本自动下载分片；本脚本接住
//       will-download 静默落盘，检测局末(__game.state==='over')自动重开新局，
//       累计达标后收工。全程不弹窗、不碰游戏源码。
const { app, session, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const TARGET = parseInt(process.argv[2] || '60000', 10);
const NWINS = parseInt(process.argv[3] || '4', 10);
const OUTDIR = path.resolve(process.argv[4] || path.join(__dirname, 'data'));
const PORT = process.argv[5] || '8000';
const MAX_MS = 20 * 60 * 1000;   // 20 分钟熔断

fs.mkdirSync(OUTDIR, { recursive: true });

function countSamples() {
  let n = 0;
  for (const f of fs.readdirSync(OUTDIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const txt = fs.readFileSync(path.join(OUTDIR, f), 'utf8');
    n += txt.split('\n').filter((l) => l.trim().startsWith('{')).length;
  }
  return n;
}

function log(msg) { process.stderr.write(`[farm] ${new Date().toISOString().slice(11, 19)} ${msg}\n`); }

app.setPath('userData', '/tmp/wt-farm-dagger');
app.whenReady().then(() => {
  const t0 = Date.now();

  // 统一接住所有窗口的下载：静默落盘到 OUTDIR（重名加后缀）
  session.defaultSession.on('will-download', (e, item) => {
    let name = item.getFilename() || ('chunk-' + Date.now() + '.jsonl');
    let p = path.join(OUTDIR, name);
    let i = 1;
    while (fs.existsSync(p)) p = path.join(OUTDIR, name.replace(/\.jsonl$/, '') + '-' + (++i) + '.jsonl');
    item.setSavePath(p);
    log(`saved ${path.basename(p)}`);
  });

  // 局末(over)延迟重开；45s 未开局强制 reload —— 持续守望
  function armWatch(win, idx, url) {
    if (win.isDestroyed()) return;
    const load = () => win.loadURL(url + '&r=' + Date.now()).catch(() => {});
    let noGameSince = Date.now();
    const w = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(w); return; }
      win.webContents.executeJavaScript(
        `window.__game ? (window.__game.state === 'over' ? 'over' : 'ok') : 'nogame'`, true
      ).then((s) => {
        if (s === 'over') { log(`win${idx} 局结束 → 重开`); clearInterval(w); setTimeout(load, 3000); armWatch(win, idx, url); }
        else if (s === 'ok') noGameSince = Date.now();
        if (s !== 'ok' && Date.now() - noGameSince > 45000) {
          log(`win${idx} 45s 未开局 → reload`); clearInterval(w); load(); armWatch(win, idx, url);
        }
      }).catch(() => {});
    }, 2000);
  }

  for (let i = 0; i < NWINS; i++) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const url = `http://localhost:${PORT}/?auto=tank&bc=1&dagger=1&autodl=1&farmSeed=${i}-${Date.now()}`;
    win.webContents.on('render-process-gone', (e, d) => log(`win${i} RENDERER GONE: ${d.reason}`));
    win.loadURL(url).catch(() => {});
    armWatch(win, i, url);
  }
  log(`farm started: target=${TARGET} windows=${NWINS} out=${OUTDIR}`);

  const mon = setInterval(() => {
    const n = countSamples();
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    log(`progress: ${n}/${TARGET} samples (${mins}min, ${(n / Math.max(1, (Date.now() - t0) / 1000)).toFixed(0)}/s)`);
    if (n >= TARGET || Date.now() - t0 > MAX_MS) {
      log(n >= TARGET ? 'target reached, done' : 'time fuse tripped, stop with what we have');
      clearInterval(mon);
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      setTimeout(() => app.quit(), 500);
    }
  }, 10000);
});
