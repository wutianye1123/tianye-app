// inj-test.cjs — 维护能力注入测试：打残+点火 BC 队友，验证灭火/修车自愈
const { app, BrowserWindow } = require('electron');
app.setPath('userData', '/tmp/wt-inj');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e, l, m) => { if (m.includes('[BC]')) process.stderr.write('[pg] ' + m + '\n'); });
  await win.loadURL('http://localhost:8123/?auto=tank&bc=ally');
  const findBC = `(window.__game && (window.__game.allies || []).find(a => a.alive && a.ai && a.ai.update && a.ai.update.name === 'bcPilotUpdate'))`;
  setTimeout(async () => {
    const r = await win.webContents.executeJavaScript(`(() => {
      const t = ${findBC}; if (!t) return 'NO_BC_BOT';
      t.health = Math.round(t.maxHealth * 0.3);
      t.burning = true;
      if (t.modules) { t.modules.track = 3; t.modules.engine = 5; }
      return JSON.stringify({ injected: true, h: t.health, max: t.maxHealth });
    })()`, true);
    process.stderr.write('[inj] ' + r + '\n');
  }, 45000);
  setTimeout(async () => {
    const r = await win.webContents.executeJavaScript(`(() => {
      const t = ${findBC}; if (!t) return 'BOT_DEAD';
      return JSON.stringify({ h: Math.round(t.health), max: t.maxHealth, burning: t.burning,
        trk: t.modules ? +t.modules.track.toFixed(1) : -1,
        eng: t.modules ? +t.modules.engine.toFixed(1) : -1 });
    })()`, true);
    process.stderr.write('[chk 7s后] ' + r + '\n');
    app.quit();
  }, 52000);
});
