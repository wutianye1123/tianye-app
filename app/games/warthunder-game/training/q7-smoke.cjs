// q7-smoke.cjs — Q 代打·第七代 冒烟：开局→按Q→60s 观察进场/接管/开火
const { app, BrowserWindow } = require('electron');
const PORT = process.argv[2] || '8123';
app.setPath('userData', '/tmp/wt-q7-smoke');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const logs = [];
  win.webContents.on('console-message', (e, l, m) => { if (/\[RL7\]|\[RL\]|\[BC\]/.test(m)) logs.push(m.slice(0, 120)); });
  const url = `http://localhost:${PORT}/?auto=tank&qGen=7`;
  win.loadURL(url).catch(() => {});
  const t0 = Date.now();
  let qPressed = false, lastPos = null, firstPos = null;
  const iv = setInterval(() => {
    win.webContents.executeJavaScript(`(() => {
      const g = window.__game; if (!g || !g.em || g.state !== 'playing') return 'wait';
      return JSON.stringify({ ph: g._pilotAI ? (g._pilotAI.phase || '?') : null,
        q7: g._pilotAI ? g._pilotAI.__rl7q : null,
        x: g.player ? +g.player.position.x.toFixed(0) : null, z: g.player ? +g.player.position.z.toFixed(0) : null,
        hp: g.player ? Math.round(g.player.health) : null,
        upd: g._pilotAI && g._pilotAI.update ? g._pilotAI.update.name : null }); })()`, true
    ).then((r) => {
      if (!r || r === 'wait' || r === '"wait"') return;
      const s = JSON.parse(r);
      if (!qPressed && s.x !== null) {   // 开局就位：派发 Q（keydown+keyup 边沿）
        qPressed = true; firstPos = [s.x, s.z];
        win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyQ',key:'q'}));
          setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyQ',key:'q'})), 80);`, true).catch(() => {});
      }
      lastPos = [s.x, s.z];
      if (Date.now() - t0 > 62000) {
        clearInterval(iv);
        const dist = firstPos ? Math.hypot(lastPos[0] - firstPos[0], lastPos[1] - firstPos[1]) : -1;
        console.log('== Q7 冒烟结果 ==');
        console.log('接管标记 __rl7q:', s.q7, '| update 挂载:', s.upd, '| phase:', s.ph, '| 血量:', s.hp);
        console.log('60s 位移:', Math.round(dist) + 'm', firstPos ? `(${firstPos} → ${lastPos})` : '');
        console.log('关键日志:'); logs.slice(0, 8).forEach(l => console.log('  ' + l));
        app.quit();
      }
    }).catch(() => {});
  }, 2000);
});
