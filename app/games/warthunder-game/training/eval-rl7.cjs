// eval-rl7.cjs — 第七代 vs 第六代 vs 第五代 vs 规则 AI 四方强度评测（无头自动对局）
// 用法：electron eval-rl7.cjs [每类局数=6] [并行窗口总数=8] [端口=8123]
// 四模式轮转开窗（rl7/rl6/bc/base 各 1/4）：
//   rl7   我方队友=第七代人机（确定性均值+纪律兜底，静态权重 rl7-weights.json）
//   rl6   我方队友=第六代 PPO（确定性，静态权重 rl-weights.json=gen226；基线 201s）
//   bc    我方队友=第五代 BC（bc-weights.json；基线 200s，10-04 终评）
//   base  我方队友=规则 AI（基线 207s，10-04 终评）
// 敌方一律满血规则 AI（与 eval-bc/eval-rl 同口径：挂机玩家+队友换装对照）。
// 局结束(state==='over')读战果后自动开下一局，跑满汇总胜率/杀敌/存活/局时长。
const { app, BrowserWindow } = require('electron');

const ROUNDS = parseInt(process.argv[2] || '6', 10);
const NWINS = parseInt(process.argv[3] || '8', 10);
const PORT = process.argv[4] || '8123';
const MAX_MS = 45 * 60 * 1000;

function log(m) { process.stderr.write(`[eval-rl7] ${new Date().toISOString().slice(11, 19)} ${m}\n`); }
const results = { rl7: [], rl6: [], bc: [], base: [] };
const MODES = ['rl7', 'rl6', 'bc', 'base'];
const LABELS = { rl7: '第七代 RL(队友)', rl6: '第六代 RL(队友)', bc: '第五代 BC(队友)', base: '规则 AI(队友)' };
const URLS = {
  rl7: `http://localhost:${PORT}/?auto=tank&rl7=ally&rl7Noise=0&rl7W=training/rl7-weights.json`,
  rl6: `http://localhost:${PORT}/?auto=tank&rl=ally&rlNoise=0&rlW=training/rl-weights.json`,
  bc: `http://localhost:${PORT}/?auto=tank&bc=ally`,
  base: `http://localhost:${PORT}/?auto=tank`,
};

app.setPath('userData', '/tmp/wt-eval-rl7');
app.whenReady().then(() => {
  const t0 = Date.now();
  let openWins = 0;

  for (let i = 0; i < NWINS; i++) {
    const mode = MODES[i % MODES.length];
    const url = URLS[mode];
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    let round = 0, lastSnap = 0, lastState = '', noGameSince = Date.now();
    const load = () => win.loadURL(url + '&r=' + Date.now()).catch(() => {});
    win.webContents.on('console-message', (e, level, message) => {
      if (/\[RL7\]|\[BC\]|error|Error|failed/i.test(message)) log(`w${i}(${mode}) console: ${message.slice(0, 160)}`);
    });
    win.webContents.on('render-process-gone', (e, d) => { log(`w${i}(${mode}) GONE: ${d.reason} → reload`); setTimeout(load, 2000); });
    const poll = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(poll); return; }
      win.webContents.executeJavaScript(
        `(() => { const g = window.__game; if (!g || !g.em) return 'null';
           return JSON.stringify({ s: g.state, k: g.kills || 0, t: Math.round(g.matchT || 0),
             L: g.playerLives == null ? -1 : g.playerLives,
             aA: (g.allies || []).filter(a => a.alive).length, aT: (g.allies || []).length }); })()`, true
      ).then((r) => {
        if (r === undefined || r === null) { log(`w${i}(${mode}) 探针返回空`); return; }
        if (!r || r === 'null') {
          if (lastState !== 'nogame') { log(`w${i}(${mode}) 无 __game（停在菜单/加载）`); lastState = 'nogame'; }
          if (Date.now() - noGameSince > 45000) {   // 卡菜单/加载兜底：45s 强制 reload（学 farm）
            log(`w${i}(${mode}) 45s 未开局 → reload`);
            noGameSince = Date.now();
            load();
          }
          return;
        }
        noGameSince = Date.now();
        let s;
        try { s = JSON.parse(r); } catch (e) { log(`w${i}(${mode}) 探针解析失败: ${r.slice(0, 80)}`); return; }
        if (s.s !== lastState) { log(`w${i}(${mode}) state: ${lastState || '∅'} → ${s.s} (k=${s.k} t=${s.t})`); lastState = s.s; }
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
  log(`eval started: ${ROUNDS} rounds × ${MODES.join('/')} modes, ${NWINS} windows`);

  const fuse = setInterval(() => {
    if (Date.now() - t0 > MAX_MS) { log('time fuse'); clearInterval(fuse); finish(); }
  }, 10000);

  function finish() {
    clearInterval(fuse);
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
    const avg = (arr, f) => arr.length ? (arr.reduce((s, x) => s + f(x), 0) / arr.length) : NaN;
    log('====== 汇总 ======');
    for (const mode of MODES) {
      const r = results[mode];
      if (!r.length) { log(`${mode}: 无完整对局`); continue; }
      const wins = r.filter(x => x.L > 0).length;
      log(`${LABELS[mode]} × ${r.length} 局: ` +
          `胜 ${wins}/${r.length} | 杀敌 ${avg(r, x => x.k).toFixed(1)} | 玩家剩命 ${avg(r, x => x.L).toFixed(1)} | ` +
          `队友存活 ${avg(r, x => x.aA).toFixed(1)}/${r[0].aT} | 局时长 ${avg(r, x => x.t).toFixed(0)}s`);
    }
    setTimeout(() => app.quit(), 300);
  }
});
