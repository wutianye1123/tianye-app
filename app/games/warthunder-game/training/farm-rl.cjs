// farm-rl.cjs — PPO 训练农场（无头 Electron 多窗口：RL bot 打局采样，rollout 直发 PPO 服务器）
// 用法：electron farm-rl.cjs [分钟数=40] [并发窗口数=4] [静态端口=8000] [PPO端口=8770]
// 原理：每窗口 load ?auto=tank&rl=1&rlSrv=… —— 游戏自动开局、红方坦克换 PPO bot、
//       agent-rl.js 每 256 步 POST /rollout 到 PPO 服务器；本脚本守望局末重开 + 汇报训练进度。
//       PPO 服务器须已启动（python3 training/ppo_train.py [port]）。
const { app, BrowserWindow } = require('electron');
const http = require('http');

const MINS = parseFloat(process.argv[2] || '40');
const NWINS = parseInt(process.argv[3] || '4', 10);
const PORT = process.argv[4] || '8000';
const PPO_PORT = process.argv[5] || '8770';
const PPO = `http://127.0.0.1:${PPO_PORT}`;

function log(msg) { process.stderr.write(`[farm-rl] ${new Date().toISOString().slice(11, 19)} ${msg}\n`); }

function ppoGet(path) {
  return new Promise((res) => {
    const req = http.get(PPO + path, (r) => {
      let b = ''; r.on('data', (c) => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { log(`ppoGet ${path} 解析失败(status ${r.statusCode}): ${b.slice(0, 80)}`); res(null); } });
    });
    req.on('error', (e) => { log(`ppoGet ${path} 请求失败: ${e.code || e.message}`); res(null); });
    req.setTimeout(4000, () => { log(`ppoGet ${path} 超时`); req.destroy(); res(null); });
  });
}

// 局末(over)延迟重开；45s 未开局强制 reload —— 持续守望（同 farm-dagger 模式）
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

app.setPath('userData', '/tmp/wt-farm-rl');
app.whenReady().then(async () => {
  const t0 = Date.now();
  const st = await ppoGet('/gen');   // 启动探测用 /gen（极小且永不含 NaN；/stats 首更前含 null/NaN 不宜做存活判据）
  if (!st) { log(`❌ PPO 服务器 ${PPO} 不可达，先启动：python3 training/ppo_train.py ${PPO_PORT}`); app.quit(); return; }
  log(`PPO 服务器就绪: gen=${st.gen}`);

  for (let i = 0; i < NWINS; i++) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    const url = `http://localhost:${PORT}/?auto=tank&rl=1&rlSrv=${encodeURIComponent('http://127.0.0.1:' + PPO_PORT)}&farmSeed=${i}-${Date.now()}`;
    win.webContents.on('render-process-gone', (e, d) => log(`win${i} RENDERER GONE: ${d.reason}`));
    win.loadURL(url).catch(() => {});
    armWatch(win, i, url);
  }
  log(`farm started: ${MINS}min windows=${NWINS} game=:${PORT} ppo=:${PPO_PORT}`);

  const mon = setInterval(async () => {
    // 1) 服务器侧进度
    const s = await ppoGet('/stats');
    if (s) log(`ppo: gen=${s.gen} updates=${s.updates} steps=${s.steps_total} buffered=${s.buffered}` +
      (s.updating ? ' [updating]' : '') +
      (Number.isFinite(s.last_stats.rew) ? ` mean_rew=${s.last_stats.rew.toFixed(3)} kl=${(s.last_stats.kl || 0).toFixed(4)}` : ''));
    // 2) 页面侧健康（抽窗口 0）
    const wins = BrowserWindow.getAllWindows();
    if (wins[0] && !wins[0].isDestroyed()) {
      wins[0].webContents.executeJavaScript(
        `window.__RLAPI ? JSON.stringify(window.__RLAPI.stats) : 'null'`, true
      ).then((r) => { if (r && r !== 'null') log(`win0 rl: ${r}`); }).catch(() => {});
    }
    if (Date.now() - t0 > MINS * 60 * 1000) {
      log('⏰ 时间到，收工（checkpoint 已在服务器侧持续落盘）');
      clearInterval(mon);
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      setTimeout(() => app.quit(), 500);
    }
  }, 15000);
});
