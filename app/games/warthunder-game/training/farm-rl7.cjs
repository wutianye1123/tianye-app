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

// 地图池（与 main.js MAPS 同步；auto=tank 恒取 MAPS[0]=city——reload 会把 mapIndex 归零，换图只能游戏内）
const MAPS_TANK = ['city','open','hills','desert','forest','factory','snow','night','rain','canyon','island','storm'];
const MAP_NAMES = ['城镇巷战','旷野','丘陵山地','沙漠','密林','工业厂区','雪原','夜战','雨天','峡谷','海岛','雷暴'];
// 局末游戏内换图（v3 确定性换图，替代撞图重开——游戏开局恒 city，撞图对非 city 目标=死循环）：
// 读 #btn-map 文本得当前图索引 → 点 N 次推到目标图 → 点 #btn-again（restart 不重载页面，mapIndex 保留）
function armWatch(win, idx, url, nextMap) {
  if (win.isDestroyed()) return;
  const load = () => win.loadURL(url + '&r=' + Date.now()).catch(() => {});
  let noGameSince = Date.now(), restarting = false, restartAt = 0;
  const w = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(w); return; }
    if (restarting && Date.now() - restartAt > 8000) restarting = false;
    win.webContents.executeJavaScript(
      `window.__game ? JSON.stringify({ s: window.__game.state, m: window.__game.mapId }) : 'null'`, true
    ).then((r) => {
      let s = 'nogame', m = '';
      try { const j = JSON.parse(r); s = j.s; m = j.m; } catch (e) { }
      if (s !== 'nogame') noGameSince = Date.now();
      if (s === 'over' && !restarting) {
        restarting = true; restartAt = Date.now();
        const tgt = nextMap();
        win.webContents.executeJavaScript(`(() => {
          const IDS = ${JSON.stringify(MAPS_TANK)}, NAMES = ${JSON.stringify(MAP_NAMES)};
          const tgt = ${JSON.stringify(tgt)};
          const btn = document.getElementById('btn-map'), again = document.getElementById('btn-again');
          if (!btn || !again) return 'no-ui';
          const mm = btn.innerHTML.match(/<b>([^<]*)<\\/b>/);
          const curIdx = mm ? Math.max(0, NAMES.indexOf(mm[1])) : 0;
          const clicks = (IDS.indexOf(tgt) - curIdx + IDS.length) % IDS.length;
          for (let k = 0; k < clicks; k++) btn.click();
          again.click();
          return '→' + tgt + '(+' + clicks + ')';
        })()`, true).then((res) => {
          log(`win${idx} 局结束(${m}) ${res || '换图重开'}`);
          setTimeout(() => { restarting = false; }, 3000);
        }).catch(() => { restarting = false; });
      }
      if (s === 'nogame' && Date.now() - noGameSince > 45000) {
        log(`win${idx} 45s 未开局 → reload 兜底`); clearInterval(w); load(); armWatch(win, idx, url, nextMap);
      }
    }).catch(() => { });
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

  const MAPSEQ = (process.argv[7] || 'rand').toLowerCase();   // ''=固定不换 | all=按序轮换 | rand=随机（默认）
  for (let i = 0; i < NWINS; i++) {
    const ch = SIDES[i % SIDES.length];
    const side = ch === 'E' ? 'enemy' : 'ally';               // A/C=ally（蓝队友位）、E=enemy（红弱侧位）
    const fixedMap = ch === 'C' ? 'city' : null;              // C=城市保底窗（固定 city）
    let round = 0;
    const nextMap = fixedMap ? (() => fixedMap)
      : (MAPSEQ === 'rand' ? () => MAPS_TANK[Math.floor(Math.random() * MAPS_TANK.length)]
                           : () => MAPS_TANK[(i + round++) % MAPS_TANK.length]);
    const url = `http://localhost:${PORT}/?auto=tank&rl7=${side}` +
      `&rl7Srv=${encodeURIComponent('http://127.0.0.1:' + PPO_PORT)}&farmSeed=${i}-${Date.now()}`;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.on('render-process-gone', (e, d) => log(`win${i}(${side}) RENDERER GONE: ${d.reason}`));
    win.loadURL(url).catch(() => {});
    armWatch(win, i, url, nextMap);
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
