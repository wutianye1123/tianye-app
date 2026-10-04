// eval-duel.cjs — 兄弟阋墙：第五代（红方 BC）vs 第六代（蓝方 RL 队友）公平对决
// 用法：electron eval-duel.cjs [局数=4] [窗口数=4] [端口=8000]
// 局面：⚔公平模式开（双方数值一致）｜红=第五代×6（3 同屏补位）｜蓝=第六代×2 队友+挂机玩家
// 判读：胜率看第六代能不能带飞；局时长看碾压/胶着； allies 存活=第六代自保能力。
const { app, BrowserWindow } = require('electron');
const ROUNDS = parseInt(process.argv[2] || '4', 10);
const NWINS = parseInt(process.argv[3] || '4', 10);
const PORT = process.argv[4] || '8000';
const MAX_MS = 30 * 60 * 1000;
function log(m) { process.stderr.write(`[duel] ${new Date().toISOString().slice(11, 19)} ${m}\n`); }
const results = [];
app.setPath('userData', '/tmp/wt-eval-duel');
app.whenReady().then(() => {
  const t0 = Date.now();
  const url = `http://localhost:${PORT}/?auto=tank&bc=1&rl=ally&rlNoise=0` +
              `&rlW=training/rl-weights.json&fair=1&duelSeed=${Date.now()}`;
  let openWins = 0;
  for (let i = 0; i < NWINS; i++) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    let round = 0, lastSnap = 0;
    const load = () => win.loadURL(url + '&r=' + Date.now() + '-' + i).catch(() => {});
    win.webContents.on('render-process-gone', (e, d) => { log(`w${i} GONE: ${d.reason} → reload`); setTimeout(load, 2000); });
    const poll = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(poll); return; }
      win.webContents.executeJavaScript(
        `(() => { const g = window.__game; if (!g || !g.em) return 'null';
           return JSON.stringify({ s: g.state, k: g.kills || 0, t: Math.round(g.matchT || 0),
             L: g.playerLives == null ? -1 : g.playerLives,
             aA: (g.allies || []).filter(a => a.alive).length,
             rl: window.__RLAPI ? window.__RLAPI.stats.kills : -1 }); })()`, true
      ).then((r) => {
        if (!r || r === 'null') return;
        const s = JSON.parse(r);
        if (s.s === 'over' && Date.now() - lastSnap > 5000) {
          lastSnap = Date.now();
          results.push(s);
          round++;
          log(`w${i} 局#${round}: ${s.L > 0 ? '🏆六代(蓝)胜' : '💥五代(红)胜'} t=${s.t}s 六代击杀${s.rl} 队友存活${s.aA}`);
          if (round >= ROUNDS) { clearInterval(poll); win.destroy(); if (--openWins === 0) finish(); return; }
          setTimeout(load, 3000);
        }
      }).catch(() => {});
    }, 2000);
    openWins++;
    load();
  }
  log(`兄弟局开打: ${ROUNDS}×${NWINS} 局｜⚔公平模式｜红=五代×6 vs 蓝=六代×2+挂机玩家`);
  const fuse = setInterval(() => {
    if (Date.now() - t0 > MAX_MS) { clearInterval(fuse); finish(); }
  }, 10000);
  function finish() {
    clearInterval(fuse);
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    if (!results.length) { log('无完整对局'); setTimeout(() => app.quit(), 300); return; }
    const avg = (f) => results.reduce((s, x) => s + f(x), 0) / results.length;
    const wins = results.filter(x => x.L > 0).length;
    log('====== 兄弟局汇总 ======');
    log(`六代(蓝)胜 ${wins}/${results.length} | 局时长 ${avg(x => x.t).toFixed(0)}s | ` +
        `蓝方杀敌 ${avg(x => x.k).toFixed(1)}/6 | 六代个人击杀 ${avg(x => x.rl).toFixed(1)} | 队友存活 ${avg(x => x.aA).toFixed(1)}`);
    setTimeout(() => app.quit(), 300);
  }
});
