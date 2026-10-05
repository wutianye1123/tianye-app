// noenemy-smoke.cjs — 修复验证冒烟：七代 bot 在「全场无敌」状态下不转圈（回退规则 AI 待机）
// 流程：开局（rl7=ally 七代队友上场）→ 25s 后模拟全灭（红方全部 alive=false）→
//       观察 15s 内七代 bot 的朝向变化总量：转圈=持续旋转（|Δheading| 大）；待机≈0
const { app, BrowserWindow } = require('electron');
const PORT = process.argv[2] || '8123';
app.setPath('userData', '/tmp/wt-noenemy-smoke');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const logs = [];
  win.webContents.on('console-message', (e, l, m) => { if (/\[RL7\]/.test(m)) logs.push(m.slice(0, 100)); });
  win.loadURL(`http://localhost:${PORT}/?auto=tank&rl7=ally&rl7Noise=0&rl7W=training/rl7-weights.json`).catch(() => {});
  const t0 = Date.now();
  let killed = false, samples = [];
  const iv = setInterval(() => {
    win.webContents.executeJavaScript(`(() => {
      const g = window.__game; if (!g || !g.em || g.state !== 'playing') return 'wait';
      const bots = (g.em.tanks || []).filter(t => t.__pilotedBy === 'rl7' && t.alive);
      if (!bots.length) return 'nobot';
      if (${killed ? 'false' : 'true'}) {
        // 模拟全灭：红方全部置死（游戏在下一帧结算，state 仍 playing 一小段窗口）
        (g.em.tanks || []).forEach(t => { if (t.team === 'red' && t.alive) { t.alive = false; t.health = 0; } });
        return 'killed';
      }
      const b = bots[0];
      return JSON.stringify({ h: +b.heading.toFixed(3), x: +b.position.x.toFixed(0), z: +b.position.z.toFixed(0),
        idle: window.__RL7API ? window.__RL7API.stats.idleFallback : -1 }); })()`, true
    ).then((r) => {
      if (!r || r === 'wait') return;
      if (r === 'nobot') return;
      if (r === 'killed') { killed = true; console.log('== 已模拟全场无敌，开始观察 bot 行为 =='); return; }
      const s = JSON.parse(r);
      samples.push(s);
      const n = samples.length;
      if (n >= 2) console.log(`t+${n}: heading=${s.h} pos=(${s.x},${s.z}) idleFallback=${s.idle}`);
      if (n >= 15) {
        clearInterval(iv);
        let rot = 0, moved = 0;
        for (let i = 1; i < samples.length; i++) {
          let d = samples[i].h - samples[i - 1].h;
          while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          rot += Math.abs(d);
          moved += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
        }
        console.log('== 结果 ==');
        console.log(`15 个采样周期(2s/次=30s) 朝向总变化: ${rot.toFixed(2)} rad (${(rot / (2 * Math.PI)).toFixed(2)} 圈) | 位移: ${Math.round(moved)}m`);
        console.log(rot > 6 ? '❌ 仍在转圈' : '✅ 未转圈（回退规则 AI 待机生效）');
        console.log('idleFallback 计数:', samples[samples.length - 1].idle);
        app.quit();
      }
    }).catch(() => {});
  }, 2000);
  setTimeout(() => { if (!killed) { console.log('⏰ 60s 未完成，退出'); app.quit(); } }, 95000);
});
