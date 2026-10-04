// agent-recorder.js — 行为克隆数据录制钩子（零侵入旁听，不改任何游戏逻辑）
// 激活方式：URL 加 ?record=1（可加 &autodl=0 只统计不自动下载、&hz=5 改采样率）
// 平时（无参数）第一行就 return，游戏路径完全不受影响——同 net-stub.js 模式。
//
// 原理：旁听规则 AI 发给 Tank 的驾驶指令（drive/aimTurretAt/tryFire 原型方法包裹，
// 先执行原方法、记录部分 try/catch 静默），按固定频率把「战场快照 obs + 聚合动作 act」
// 写进缓冲，分片下载 jsonl（F9 手动导出 / 每 3000 样本自动分片 / 关页兜底）。
// 挂载状态用 WeakMap 保存，不在游戏对象上添加任何属性。
//
// 数据用途：Python 侧行为克隆（BC）训练 → PPO 精调 → 导出 ONNX 回浏览器当人机。
// obs 维度 = 16(自身) + 3×11(最近敌) + 6×3(最近障碍) + 3(上下文) = 70，定长。
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  if (qs.get('record') !== '1') return;   // 默认短路：正常游玩零执行

  var HZ = parseFloat(qs.get('hz')) || 10;          // 采样率（默认 10Hz，AI 决策粒度足够）
  var AUTODL = qs.get('autodl') !== '0';            // 自动分片下载
  var CHUNK = 3000;                                  // 每多少样本自动分片
  var OBS_DIM = 70;

  // ---------- 工具 ----------
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }   // wrap2pi 由 agent-core.js 提供
  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { console.warn('[REC] download failed:', e); }
  }

  // ---------- 状态 ----------
  var pend = new WeakMap();   // tank -> pending 聚合缓冲 {n,thr,turn,aimYaw,aimPitch,fire}
  var lastObs = new WeakMap(); // tank -> 上一窗口的 obs（动作前的状态，因果正确配对）
  var buf = [];               // jsonl 行缓冲
  var totalSamples = 0;
  var fileSeq = 0;
  var hooked = false;

  function badge(txt) {
    var el = document.getElementById('__recBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__recBadge';
      el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#7f7;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #4a4;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = txt;
  }

  function flush(reason) {
    if (!buf.length) return;
    fileSeq++;
    var name = 'bc-tank-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') +
      '-' + fileSeq + '.jsonl';
    if (AUTODL) download(name, buf.join('\n') + '\n');
    console.log('[REC] chunk#' + fileSeq + ' (' + reason + '): ' + buf.length +
      ' samples -> ' + (AUTODL ? name : '(autodl=0, skipped)'));
    buf = [];
  }

  // ---------- 原型钩子 ----------
  function hookTankClass(Cls) {
    if (hooked || !Cls || !Cls.prototype) return;
    hooked = true;

    var origDrive = Cls.prototype.drive;
    if (origDrive) Cls.prototype.drive = function (throttle, turn, dt) {
      var r = origDrive.apply(this, arguments);   // 先执行原方法，录制永不影响驾驶
      try {
        var p = pend.get(this);
        if (!p) { p = { n: 0, thr: 0, turn: 0, aimYaw: 0, aimPitch: 0, hasAim: false, fire: 0 }; pend.set(this, p); }
        p.n++; p.thr += throttle; p.turn += turn;
      } catch (e) { /* 静默：录制绝不能炸游戏 */ }
      return r;
    };

    var origAim = Cls.prototype.aimTurretAt;
    if (origAim) Cls.prototype.aimTurretAt = function (worldPoint, dt, elev) {
      var r = origAim.apply(this, arguments);
      try {
        var t = this.position;
        var dx = worldPoint.x - t.x, dz = worldPoint.z - t.z;
        var dy = worldPoint.y - (t.y + 1.8);                       // 炮管高度近似
        var p = pend.get(this);
        if (!p) { p = { n: 0, thr: 0, turn: 0, aimYaw: 0, aimPitch: 0, hasAim: false, fire: 0 }; pend.set(this, p); }
        p.aimYaw = wrap2pi(Math.atan2(dx, dz) - this.heading);     // 目标相对车体方位（学"该指向哪"）
        p.aimPitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
        p.hasAim = true;
      } catch (e) { }
      return r;
    };

    var origFire = Cls.prototype.tryFire;
    if (origFire) Cls.prototype.tryFire = function (em) {
      var r = origFire.apply(this, arguments);
      try {
        if (r !== false) {
          var p = pend.get(this);
          if (!p) { p = { n: 0, thr: 0, turn: 0, aimYaw: 0, aimPitch: 0, hasAim: false, fire: 0 }; pend.set(this, p); }
          p.fire++;
        }
      } catch (e) { }
      return r;
    };
    console.log('[REC] Tank prototype hooked @' + HZ + 'Hz');
  }

  // ---------- 观测构造（与推理端共享 agent-core.js，语义逐位一致） ----------
  var CORE = window.__WTA;
  var buildObs = CORE.buildObs;
  var enemiesOf = CORE.enemiesOf;
  var wrap2pi = CORE.wrap2pi;

  // ---------- 主循环（等待游戏实例） ----------
  var waitTimer = setInterval(function () {
    try {
      var g = window.__game;
      if (!g || !g.player) return;
      clearInterval(waitTimer);
      start(g);
    } catch (e) { /* 游戏未起来，继续等 */ }
  }, 200);

  function start(game) {
    hookTankClass(game.player.constructor);

    var sampleTimer = setInterval(function () {
      try {
        if (!game || game._disposed) { clearInterval(sampleTimer); flush('disposed'); return; }
        if (game.state !== 'playing' || game.paused) return;   // 暂停/菜单不采（防全零污染）
        if (game.mode !== 'tank') return;                      // M1 只录坦克

        var obstacles = (game.em && game.em.obstacles) || [];
        var pool = (game.em && game.em.tanks) || [];
        for (var i = 0; i < pool.length; i++) {
          var t = pool[i];
          if (!t || !t.alive || t.netGhost) continue;
          var p = pend.get(t);
          if (!p || p.n === 0) continue;                       // 这帧没人驾驶（如车长趴窝）→ 不采
          var prev = lastObs.get(t);
          var enemies = enemiesOf(t, game);
          var obs = buildObs(t, game, enemies, obstacles);
          if (prev) {
            // 因果正确配对：obs=动作前的状态（上一窗口末），act=本窗口聚合动作。
            // （否则开炮引发的装填重置会被写进同一样本的 obs，把开火条件学反。）
            var act = [
              clamp01(Math.abs(p.thr / p.n) < 1.2 ? p.thr / p.n : Math.sign(p.thr)),  // 均值油门
              Math.max(-1, Math.min(1, p.turn / p.n)),                                 // 均值转向
              p.hasAim ? p.aimYaw / Math.PI : 0,
              p.hasAim ? p.aimPitch / 0.3 : 0,
              p.fire > 0 ? 1 : 0
            ];
            buf.push(JSON.stringify({
              t: +(game.matchT || 0).toFixed(1),
              role: t.side || t.team,
              type: t.type || 'medium',
              obs: prev.map(function (v) { return +v.toFixed(4); }),
              act: act.map(function (v) { return +v.toFixed(4); })
            }));
            totalSamples++;
          }
          lastObs.set(t, obs);
          // 清空聚合缓冲（保留结构）
          p.n = 0; p.thr = 0; p.turn = 0; p.fire = 0; p.hasAim = false;
        }
        badge('REC ● ' + totalSamples + ' samples');
        if (buf.length >= CHUNK) flush('auto');
      } catch (e) { console.warn('[REC] sample error (ignored):', e); }
    }, Math.round(1000 / HZ));

    // 手动导出 / 关页兜底
    window.addEventListener('keydown', function (ev) {
      if (ev.key === 'F9') { flush('manual-F9'); ev.preventDefault(); }
    });
    window.addEventListener('beforeunload', function () { flush('unload'); });
    console.log('[REC] recorder started: hz=' + HZ + ' autodl=' + AUTODL + ' obsDim=' + OBS_DIM +
      ' — F9 导出，每 ' + CHUNK + ' 样本自动分片');
  }
})();
