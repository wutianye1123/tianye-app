// farm-rl7.cjs — 第七代 PPO 训练农场（无头 Electron 多窗口：双侧采样 ally/enemy 交替）
// 用法：electron farm-rl7.cjs [目标步数=400000] [并发窗口数=4] [静态端口=8123] [PPO端口=8771] [侧序列=AEAE]
//   ★ 收工判据 = 服务器 steps_total ≥ 目标步数（2026-10-05 改：wall 计时在系统睡眠下是幻觉——
//     合盖必睡，caffeinate 无效；按步数收工则睡眠只是暂停，唤醒自动续跑，训练量确定）
//   第二参数起与旧版一致；老用法传分钟数仍兼容（≤1440 视为分钟→按 ~115 步/分/窗折算）
//   侧序列字符：A=ally（蓝方队友位，带挂机玩家打 6 红规则 AI——评测同款位）
//               E=enemy（红方位，弱属性位；蓝方=挂机玩家+2 规则 AI 队友）
// 原理：每窗口 load ?auto=tank&rl7=<side>&rl7Srv=… —— 游戏自动开局、对应侧坦克换第七代 bot、
//       agent-rl7.js 每 256 步 POST /rollout；本脚本守望局末重开 + 汇报训练进度。
//       PPO 服务器须已启动（python3 training/ppo7_train.py [port]）。
const { app, BrowserWindow } = require('electron');
const http = require('http');

const ARG2 = parseFloat(process.argv[2] || '400000');
const STEP_GOAL = ARG2 <= 1440 ? Math.round(ARG2 * 115) : Math.round(ARG2);   // 兼容旧分钟用法
const NWINS = parseInt(process.argv[3] || '4', 10);
const PORT = process.argv[4] || '8123';
const PPO_PORT = process.argv[5] || '8771';
const SIDES = (process.argv[6] || 'AEAE').toUpperCase();
const PPO = `http://127.0.0.1:${PPO_PORT}`;
const WALL_FUSE_MS = 12 * 3600 * 1000;   // wall 熔断（防真死循环）：12 小时必停

function log(msg) { process.stderr.write(`[farm-rl7] ${new Date().toISOString().slice(11, 19)} ${msg}\n`); }

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

// 地图池（与 main.js MAPS 同步；auto=tank 默认恒为 MAPS[0]=city——无头窗不点按钮永远同一张图）
const MAPS_TANK = ['city','open','hills','desert','forest','factory','snow','night','rain','canyon','island','storm'];
// 局末(over)延迟重开；45s 未开局强制 reload；wantMap 校验重开撞图 —— 持续守望
// mapSeq：'' 固定图（兼容旧行为）| 'all' 按序轮换 12 图 | 'rand' 每局随机（用户会换图玩 → 训练必须覆盖）
function armWatch(win, idx, mkUrl, nextMap) {
  if (win.isDestroyed()) return;
  const load = () => win.loadURL(mkUrl(nextMap && nextMap())).catch(() => {});
  const wantOf = () => nextMap && nextMap.peek();
  let noGameSince = Date.now();
  const w = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(w); return; }
    win.webContents.executeJavaScript(
      `window.__game ? JSON.stringify({ s: window.__game.state, m: window.__game.mapId }) : 'null'`, true
    ).then((r) => {
      let s = 'nogame', m = '';
      try { const j = JSON.parse(r); s = j.s === 'over' ? 'over' : 'ok'; m = j.m; } catch (e) { s = r === 'null' ? 'nogame' : 'ok'; }
      const want = wantOf();
      if (s === 'ok' && want && m && m !== want) {   // 本局图 ≠ 目标图：重开撞图
        log(`win${idx} 地图 ${m}≠${want} → 重开撞图`);
        clearInterval(w); setTimeout(load, 300); armWatch(win, idx, mkUrl, nextMap);
        return;
      }
      if (s === 'over') { log(`win${idx} 局结束(${m}) → 重开`); clearInterval(w); setTimeout(load, 3000); armWatch(win, idx, mkUrl, nextMap); }
      else if (s === 'ok') noGameSince = Date.now();
      if (s !== 'ok' && Date.now() - noGameSince > 45000) {
        log(`win${idx} 45s 未开局 → reload`); clearInterval(w); load(); armWatch(win, idx, mkUrl, nextMap);
      }
    }).catch(() => {});
  }, 2000);
}

app.setPath('userData', '/tmp/wt-farm-rl7');
app.whenReady().then(async () => {
  const t0 = Date.now();
  let st = null;
  for (let k = 0; k < 6 && !st; k++) {          // 探活重试：torch 服务器冷启动（import+BC 锚加载）可能 10s+
    st = await ppoGet('/gen');
    if (!st) { log(`PPO 服务器未就绪(${k + 1}/6)，3s 后重试…`); await new Promise(r => setTimeout(r, 3000)); }
  }
  if (!st) { log(`❌ PPO 服务器 ${PPO} 不可达，先启动：python3 training/ppo7_train.py ${PPO_PORT}`); app.quit(); return; }
  log(`PPO7 服务器就绪: gen=${st.gen}`);

  const MAPSEQ = (process.env.MAPSEQ || (process.argv[7] || 'rand')).toLowerCase();   // ''/all/rand
  for (let i = 0; i < NWINS; i++) {
    const ch = SIDES[i % SIDES.length];
    const side = ch === 'E' ? 'enemy' : 'ally';                 // A/C=ally（蓝队友位）、E=enemy（红弱侧位）
    const fixedMap = ch === 'C' ? 'city' : null;                // C=城市专窗（固定 city）
    let round = 0;
    const nextMap = (MAPSEQ && !fixedMap) ? (() => {
      let cur = null;
      const gen = () => { cur = MAPSEQ === 'rand'
        ? MAPS_TANK[Math.floor(Math.random() * MAPS_TANK.length)]
        : MAPS_TANK[(i + round++) % MAPS_TANK.length]; return cur; };
      gen.peek = () => cur;
      return gen;
    })() : null;
    const mkUrl = (m) => `http://localhost:${PORT}/?auto=tank&rl7=${side}` +
      `${m ? '&wantMap=' + m : ''}&rl7Srv=${encodeURIComponent('http://127.0.0.1:' + PPO_PORT)}&farmSeed=${i}-${Date.now()}`;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (e, d) => log(`win${i}(${side}${fixedMap ? '/' + fixedMap : MAPSEQ ? '/' + MAPSEQ : ''}) RENDERER GONE: ${d.reason}`));
    win.loadURL(mkUrl(nextMap ? nextMap() : fixedMap)).catch(() => {});
    armWatch(win, i, mkUrl, nextMap || (fixedMap ? { peek: () => fixedMap, call: () => fixedMap } : null));
  }
  log(`farm started: 目标 ${STEP_GOAL} 步 windows=${NWINS} sides=${SIDES} game=:${PORT} ppo=:${PPO_PORT}`);
  const goal0 = (await ppoGet('/stats') || {}).steps_total || 0;   // 起跑线（不含历史步数）
  log(`起跑线: 服务器已有 ${goal0} 步，本轮目标再攒 ${STEP_GOAL} 步 → 收工线 ${goal0 + STEP_GOAL}`);

  const mon = setInterval(async () => {
    const s = await ppoGet('/stats');
    if (s) {
      const ls = s.last_stats || {};
      const done = s.steps_total - goal0;
      log(`ppo7: gen=${s.gen} updates=${s.updates} 本轮 ${done}/${STEP_GOAL} 步(${(done / STEP_GOAL * 100).toFixed(0)}%) buffered=${s.buffered}` +
        (s.updating ? ' [updating]' : '') +
        (Number.isFinite(ls.rew) ? ` mean_rew=${ls.rew.toFixed(3)} kl=${(ls.kl || 0).toFixed(4)}` : ''));
      // 收工判据：本轮步数达标（睡眠只暂停不计步，唤醒续跑）
      if (done >= STEP_GOAL) {
        log(`✅ 目标达成（${done} 步），收工（checkpoint 已在服务器侧持续落盘）`);
        clearInterval(mon);
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
        setTimeout(() => app.quit(), 500);
        return;
      }
      // wall 熔断：12h 真死循环保护（睡眠不计——进程冻结时 interval 也不跑）
      if (Date.now() - t0 > WALL_FUSE_MS) {
        log('⏰ wall 熔断（12h），强制收工');
        clearInterval(mon);
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
        setTimeout(() => app.quit(), 500);
        return;
      }
    }
    // 页面侧健康（抽窗口 0）
    const wins = BrowserWindow.getAllWindows();
    if (wins[0] && !wins[0].isDestroyed()) {
      wins[0].webContents.executeJavaScript(
        `window.__RL7API ? JSON.stringify(window.__RL7API.stats) : 'null'`, true
      ).then((r) => { if (r && r !== 'null') log(`win0 rl7: ${r}`); }).catch(() => {});
    }
  }, 15000);
});
