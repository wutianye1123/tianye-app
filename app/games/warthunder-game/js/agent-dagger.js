// agent-dagger.js — DAgger 影子老师录制：BC bot 开车，规则 AI 当「影子老师」给纠正标签
// 激活方式：URL 加 ?dagger=1（可选 &autodl=0 只统计不下载）
// 平时（无参数）第一行就 return，游戏路径完全不受影响。
//
// 原理（DAgger：解决 BC 复合误差——学生开车的失误分布上没有老师标签）：
//   1. 调 __BCAPI.activate()：BC bot 接管红方坦克（学生开车，产生真实失误分布）
//   2. 对每辆红方坦克建「影子老师」：new TankAI(Proxy(tank))——Proxy 拦截
//      drive/aimTurretAt/tryFire 只记录不执行（老师不碰真车），其余属性透传真坦克
//   3. 每 100ms 用游戏同款 ctx（最近蓝方目标/威胁/障碍/烟幕）调老师 update
//   4. 记录 (obs[动作前], teacherAct)——因果配对与 agent-recorder.js 修复后一致
// 产出 jsonl 与 bc_train.py 兼容，与 farm 原数据混合重训。
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  if (qs.get('dagger') !== '1') return;   // 默认短路：正常游玩零执行

  var CORE = window.__WTA;
  var AUTODL = qs.get('autodl') !== '0';
  var CHUNK = 3000;
  var TICK_MS = 100;          // 与 BC 推理/录制采样率对齐（10Hz）

  var teachers = new WeakMap();  // tank -> {ai(影子TankAI), pend, lastObs}
  var buf = [];
  var total = 0, fileSeq = 0;

  function download(name, text) {
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { console.warn('[DAG] download failed:', e); }
  }
  function flush(reason) {
    if (!buf.length) return;
    fileSeq++;
    var name = 'dagger-tank-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') +
      '-' + fileSeq + '.jsonl';
    if (AUTODL) download(name, buf.join('\n') + '\n');
    console.log('[DAG] chunk#' + fileSeq + ' (' + reason + '): ' + buf.length + ' -> ' +
      (AUTODL ? name : '(autodl=0)'));
    buf = [];
  }

  // 影子老师：Proxy 拦截三个驾驶方法（记录不执行），其余透传
  function makeTeacher(tank, TankAICls) {
    var rec = { ai: null, pend: { n: 0, thr: 0, turn: 0, aimYaw: 0, aimPitch: 0, hasAim: false, fire: 0 }, lastObs: null };
    var proxy = new Proxy(tank, {
      get: function (target, prop) {
        if (prop === 'drive') return function (throttle, turn, dt) {
          rec.pend.n++; rec.pend.thr += throttle; rec.pend.turn += turn;   // 只记录，不执行
        };
        if (prop === 'aimTurretAt') return function (worldPoint) {
          var t = target.position;
          var dx = worldPoint.x - t.x, dz = worldPoint.z - t.z;
          var dy = worldPoint.y - (t.y + 1.8);
          rec.pend.aimYaw = CORE.wrap2pi(Math.atan2(dx, dz) - target.heading);
          rec.pend.aimPitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
          rec.pend.hasAim = true;
        };
        if (prop === 'tryFire') return function () { rec.pend.fire++; return true; };
        var v = target[prop];
        return (typeof v === 'function') ? v.bind(target) : v;   // 方法绑真车（只读用途）
      }
    });
    try { rec.ai = new TankAICls(proxy); } catch (e) { return null; }
    teachers.set(tank, rec);
    return rec;
  }

  // 游戏 ctx 的简化版：最近蓝方目标（玩家+队友）、威胁、障碍、烟幕——与主循环同构
  function buildCtx(tank, game) {
    var blue = [];
    if (game.player && game.player.alive) blue.push(game.player);
    for (var i = 0; i < (game.allies || []).length; i++) {
      var a = game.allies[i];
      if (a.alive) blue.push(a);
    }
    var target = null, bd = Infinity;
    for (i = 0; i < blue.length; i++) {
      var d = (blue[i].position.x - tank.position.x) ** 2 + (blue[i].position.z - tank.position.z) ** 2;
      if (d < bd) { bd = d; target = blue[i]; }
    }
    return {
      target: target,
      threats: blue,
      entityManager: game.em,
      obstacles: (game.terrain && game.terrain.obstacles) || (game.em && game.em.obstacles) || [],
      smokes: (game.em && game.em.smokes) || []
    };
  }

  function badge() {
    var el = document.getElementById('__dagBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__dagBadge';
      el.style.cssText = 'position:fixed;top:34px;right:8px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#fd6;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #a84;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = '⍺ DAgger ' + total + ' samples';
  }

  // 主流程：BC 先激活（学生开车）→ 挂影子老师 → 10Hz 采样
  function start(game) {
    var TankAICls = null;
    for (var i = 0; i < (game.enemies || []).length; i++) {
      if (game.enemies[i] && game.enemies[i].ai && game.enemies[i].ai.constructor) {
        TankAICls = game.enemies[i].ai.constructor; break;
      }
    }
    if (!TankAICls) { console.warn('[DAG] no TankAI class found'); return; }

    var timer = setInterval(function () {
      try {
        if (!game || game._disposed) { clearInterval(timer); flush('disposed'); return; }
        if (game.state !== 'playing' || game.paused || game.mode !== 'tank') return;
        var pool = (game.em && game.em.tanks) || [];
        for (var j = 0; j < pool.length; j++) {
          var t = pool[j];
          if (!t || !t.alive || t.netGhost || t.team !== 'red') continue;
          var rec = teachers.get(t) || makeTeacher(t, TankAICls);
          if (!rec) continue;

          var ctx = buildCtx(t, game);
          if (ctx.target) {
            try { rec.ai.update(TICK_MS / 1000, ctx); } catch (e) { /* 老师出错跳过本窗 */ }
          }
          // 因果配对：lastObs(动作前状态) + 本窗老师动作
          var p = rec.pend;
          var enemies = CORE.enemiesOf(t, game);
          var obs = CORE.buildObs(t, game, enemies, ctx.obstacles);
          if (rec.lastObs && p.n > 0) {
            var act = [
              Math.max(-1, Math.min(1, p.thr / p.n)),
              Math.max(-1, Math.min(1, p.turn / p.n)),
              p.hasAim ? p.aimYaw / Math.PI : 0,
              p.hasAim ? p.aimPitch / 0.3 : 0,
              p.fire > 0 ? 1 : 0
            ];
            buf.push(JSON.stringify({
              t: +(game.matchT || 0).toFixed(1), role: 'dagger', type: t.type || 'medium',
              obs: rec.lastObs.map(function (v) { return +v.toFixed(4); }),
              act: act.map(function (v) { return +v.toFixed(4); })
            }));
            total++;
          }
          rec.lastObs = obs;
          p.n = 0; p.thr = 0; p.turn = 0; p.fire = 0; p.hasAim = false;
        }
        badge();
        if (buf.length >= CHUNK) flush('auto');
      } catch (e) { console.warn('[DAG] tick error (ignored):', e); }
    }, TICK_MS);

    window.addEventListener('beforeunload', function () { flush('unload'); });
    console.log('[DAG] dagger recorder started (BC student + shadow teacher)');
  }

  // BC 学生先就位，再等开局
  if (window.__BCAPI && window.__BCAPI.activate) {
    window.__BCAPI.activate().then(function () {
      var wait = setInterval(function () {
        var g = window.__game;
        if (g && g.player && g.state === 'playing') { clearInterval(wait); start(g); }
      }, 300);
    }).catch(function (e) { console.warn('[DAG] BC activate failed:', e); });
  } else {
    console.warn('[DAG] __BCAPI not found (agent-bc.js must load before agent-dagger.js)');
  }
})();
