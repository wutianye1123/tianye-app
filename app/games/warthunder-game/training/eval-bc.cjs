// eval-bc.cjs — BC 人机 vs 规则 AI 强度对比评测（无头自动对局）
// 用法：electron eval-bc.cjs [每类局数=2] [并行窗口总数=4] [端口=8000]
// 窗口各半跑两类局：mode=bc（我方队友=BC 人机，敌方=满血规则AI） vs mode=base（队友=规则AI 对照）。
// 局结束(state==='over')读战果后自动开下一局，跑满汇总：
//   kills   = 蓝方(玩家挂机+规则队友)杀敌数 → 越低说明敌方越耐打
//   lives   = 玩家剩余命数(挂机)            → 越低说明敌方攻击性越强
//   allies  = 规则队友存活 / 总数            → 越低说明敌方越凶
//   time    = 局时长(秒)
const { app, BrowserWindow } = require('electron');

const ROUNDS = parseInt(process.argv[2] || '2', 10);
const NWINS = parseInt(process.argv[3] || '4', 10);
const PORT = process.argv[4] || '8000';
const MAX_MS = 14 * 60 * 1000;

function log(m) { process.stderr.write(`[eval] ${new Date().toISOString().slice(11, 19)} ${m}\n`); }
const results = { bc: [], base: [] };

app.setPath('userData', '/tmp/wt-eval-bc');
app.whenReady().then(() => {
  const t0 = Date.now();
  let openWins = 0;

  for (let i = 0; i < NWINS; i++) {
    const mode = i % 2 === 0 ? 'bc' : 'base';
    const url = `http://localhost:${PORT}/?auto=tank${mode === 'bc' ? '&bc=ally' : ''}`;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    let round = 0, lastSnap = 0;
    const load = () => win.loadURL(url + '&r=' + Date.now()).catch(() => {});
    win.webContents.on('render-process-gone', (e, d) => { log(`w${i}(${mode}) GONE: ${d.reason} → reload`); setTimeout(load, 2000); });
    const poll = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(poll); return; }
      win.webContents.executeJavaScript(
        `(() => { const g = window.__game; if (!g || !g.em) return 'null';
           return JSON.stringify({ s: g.state, k: g.kills || 0, t: Math.round(g.matchT || 0),
             L: g.playerLives == null ? -1 : g.playerLives,
             aA: (g.allies || []).filter(a => a.alive).length, aT: (g.allies || []).length }); })()`, true
      ).then((r) => {
        if (!r || r === 'null') return;
        const s = JSON.parse(r);
        if (s.s === 'over' && Date.now() - lastSnap > 5000) {
          lastSnap = Date.now();
          results[mode].push(s);
          round++;
          log(`w${i}(${mode}) 局#${round}: kills=${s.k} t=${s.t}s lives=${s.L} allies=${s.aA}/${s.aT}`);
          if (round >= ROUNDS) { clearInterval(poll); win.destroy(); if (--openWins === 0) finish(); return; }
          setTimeout(load, 3000);
        }
      }).catch(() => {});
    }, 2000);
    openWins++;
    load();
  }
  log(`eval started: ${ROUNDS} rounds × ${['bc', 'base']} modes, ${NWINS} windows`);

  const fuse = setInterval(() => {
    if (Date.now() - t0 > MAX_MS) { log('time fuse'); clearInterval(fuse); finish(); }
  }, 10000);

  function finish() {
    clearInterval(fuse);
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    const avg = (arr, f) => arr.length ? (arr.reduce((s, x) => s + f(x), 0) / arr.length) : NaN;
    log('====== 汇总 ======');
    for (const mode of ['bc', 'base']) {
      const r = results[mode];
      if (!r.length) { log(`${mode}: 无完整对局`); continue; }
      const wins = r.filter(x => x.L > 0).length;
      log(`${mode === 'bc' ? 'BC 人机(队友)' : '规则 AI(队友)'} × ${r.length} 局: ` +
          `胜 ${wins}/${r.length} | 杀敌 ${avg(r, x => x.k).toFixed(1)} | 玩家剩命 ${avg(r, x => x.L).toFixed(1)} | ` +
          `队友存活 ${avg(r, x => x.aA).toFixed(1)}/${r[0].aT} | 局时长 ${avg(r, x => x.t).toFixed(0)}s`);
    }
    setTimeout(() => app.quit(), 300);
  }
});
