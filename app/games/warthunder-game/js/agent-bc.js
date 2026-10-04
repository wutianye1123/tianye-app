// agent-bc.js — 行为克隆人机（BC bot）：加载 bc-weights.json，替换敌方坦克的规则 AI
// 激活方式（满足其一）：URL 带 ?bc=1，或 localStorage.wt_bc === '1'（出战页「🤖 学习型人机」开关写入）
// URL ?bc=0 可强制关闭。辅助参数：&bcAssist=0 关开火纪律兜底、&bcBoth=1 队友也换、&bcDump=1 调试输出
// Q 代打接管（2026-10-04）：按 Q 的「AI 代打」大脑换成第五代 BC（默认开；?bcQ=0 或 localStorage.wt_bcq='0' 关闭）
// 平时（未激活）第一行就 return，游戏路径完全不受影响——同 net-stub.js 模式。
//
// 架构（第一代混合模式）：
//   远距进场（>270m）：经典 P 控制器朝最近敌开（规则 AI 同款增益）
//   交战区：BC 全控驾驶+炮塔；开火 = BC 置信度过阈值 ∨（assist 且 240m 内+LOS 通+炮口对准+装填好）
// 任何异常回退原规则 AI（每 tank 保留原 update 引用）。
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  // SIDE：enemy=替换敌方(默认) / ally=替换队友(当我的队友) / both=全换
  var SIDE = (qs.get('bc') === 'ally' || qs.get('bcSide') === 'ally') ? 'ally'
           : (qs.get('bc') === 'both' || qs.get('bcSide') === 'both') ? 'both' : 'enemy';
  var _ls = '0'; try { _ls = localStorage.getItem('wt_bc') || '0'; } catch (e) { }
  if (_ls === 'ally') SIDE = 'ally';
  var BCON = qs.get('bc') !== null || _ls === '1' || _ls === 'enemy' || _ls === 'ally';
  if (qs.get('bc') === '0') BCON = false;
  // Q 代打接管：默认开（用户 2026-10-04 要求）
  var QON = qs.get('bcQ') !== '0';
  try { if (localStorage.getItem('wt_bcq') === '0') QON = false; } catch (e) { }
  if (!BCON && !QON) return;   // 两个特性都关：短路，零执行

  var CORE = window.__WTA;
  var ASSIST = qs.get('bcAssist') !== '0';   // 开火纪律兜底（默认开）：BC 犹豫但条件齐也开
  var THINK_MS = 100;         // 推理频率（与录制采样率 10Hz 对齐）
  var WEIGHTS_URL = new URL('training/bc-weights.json', location.href).href;

  // ---------- 手写 MLP 前向（与 bc_train.py 网络严格一致） ----------
  var W = null;   // {W1,b1,W2,b2,W3,b3, mu, sd, meta}
  function matvec(x, M, b) {
    var out = new Float32Array(b.length);
    for (var j = 0; j < b.length; j++) {
      var s = 0;
      for (var i = 0; i < x.length; i++) s += x[i] * M[i][j];
      out[j] = s + b[j];
    }
    return out;
  }
  function forward(obs) {
    // 标准化（mu/sd 存于 weights.norm）
    var x = new Float32Array(obs.length);
    for (var i = 0; i < obs.length; i++) x[i] = (obs[i] - W.norm.mu[i]) / W.norm.sd[i];
    // 两层 ReLU
    var h1 = matvec(x, W.W1, W.b1);
    for (var j = 0; j < h1.length; j++) if (h1[j] < 0) h1[j] = 0;
    var h2 = matvec(h1, W.W2, W.b2);
    for (var k = 0; k < h2.length; k++) if (h2[k] < 0) h2[k] = 0;
    var out = matvec(h2, W.W3, W.b3);
    // 输出语义：前 4 维 tanh，第 5 维 sigmoid
    return [
      Math.tanh(out[0]), Math.tanh(out[1]), Math.tanh(out[2]), Math.tanh(out[3]),
      1 / (1 + Math.exp(-out[4]))
    ];
  }

  // ---------- 替换敌方 AI ----------
  var done = new WeakSet();   // 已替换的 tank 实例（死亡重生后是新实例，会重新替换）
  var stats = { bots: 0, fires: 0, thinking: 0, fallbacks: 0, exting: 0, repairs: 0 };
  var NAV_DIST = 0.6;        // 最近敌距离 >0.6(≈270m)：经典 P 控制器进场，交战区才交给 BC

  function pilotate(tank, game) {
    var origUpdate = tank.ai.update.bind(tank.ai);   // 保留原规则 AI 作兜底
    var lastThink = 0, act = null, lastEnemies = [], lastObstacles = [];
    var stuck = CORE.makeStuck();   // 卡墙脱困跟踪器
    var tgt = null;                // 集火分散：本机认领的目标
    done.add(tank);
    tank.__pilotedBy = 'bc';   // 跨脚本互斥：agent-rl 见此标记不重复接管
    stats.bots++;
    tank.ai.update = function bcPilotUpdate(dt, ctx) {
      try {
        // —— 维护：起火立即灭（8s 冷却自带）+ 边走边修（照 AI 代打副驾驶同款：15/s 回血 + 模块 6/s） ——
        if (tank.burning) { if (tank.tryExtinguish()) stats.exting++; }
        var mm = tank.modules;
        var modsBroken = mm && (mm.track > 0 || mm.barrel > 0 || mm.engine > 0);
        if (tank.health < tank.maxHealth || modsBroken) {
          if (tank.health < tank.maxHealth) tank.health = Math.min(tank.maxHealth, tank.health + 15 * dt);
          if (mm) {
            if (mm.track > 0) mm.track = Math.max(0, mm.track - dt * 6);
            if (mm.barrel > 0) mm.barrel = Math.max(0, mm.barrel - dt * 6);
            if (mm.engine > 0) mm.engine = Math.max(0, mm.engine - dt * 6);
          }
          stats.repairs++;
        }

        var now = performance.now();
        if (now - lastThink >= THINK_MS) {
          lastThink = now;
          var em = (ctx && ctx.entityManager) || game.em;
          var obstacles = (ctx && ctx.obstacles) || (em && em.obstacles) || [];
          lastEnemies = CORE.enemiesOf(tank, game);
          var obs = CORE.buildObs(tank, game, lastEnemies, obstacles);
          lastObstacles = obstacles;
          act = forward(obs);
          stats.thinking++;
          // 目标认领（10Hz 换脑子：评分=距离+250m×队友锁定数，滞回 100m）
          var newTgt = CORE.pickTarget(tank, lastEnemies, tgt);
          if (newTgt !== tgt) { CORE.releaseTarget(tank, tgt); CORE.claimTarget(tank, newTgt); tgt = newTgt; }
          if (qs.get('bcDump') === '1' && obs[16] < 0.6 && (stats._dumps = (stats._dumps || 0) + 1) <= 40)
            console.log('[BCDUMP] ' + JSON.stringify({ d: +obs[16].toFixed(3), p: +act[4].toPrecision(3),
              obs: obs.map(function (v) { return +v.toFixed(3); }) }));
          stats.firePMax = Math.max(stats.firePMax || 0, act[4]);
          stats.firePSum = (stats.firePSum || 0) + act[4];
          stats.distSum = (stats.distSum || 0) + obs[16];   // 最近敌距离（归一）
        }
        if (!act) return origUpdate(dt, ctx);        // 首帧没推理完：先用规则 AI
        if (!tank.alive) return;

        // —— 目标选择：集火分散（评分=距离+250m×队友已锁定数，带滞回；obs 仍用最近 3 敌）——
        var e0 = (tgt && tgt.alive) ? tgt : lastEnemies[0];
        if (!e0) { tank.drive(act[0], act[1], dt); return; }   // 无敌可打：按 BC 心意兜底走
        var dE = tankDist(tank, e0);

        // —— 卡墙脱困（最高优先级：卡死了什么战术都白搭；规则 AI 同款参数）——
        var thrIntent = dE > NAV_DIST * 450 ? 1 : act[0];
        if (stuck.update(tank, thrIntent, dt)) {
          stats.unstick = (stats.unstick || 0) + 1;
          tank.drive(-1, stuck.dir * 0.9, dt);       // 倒车打满舵甩头
          tank.aimTurretAt(CORE.gunAimPoint(tank, e0), dt);
          return;                                     // 甩头期间不开火（收敛难满足，省弹）
        }

        // —— 远距进场：P 控制器朝选定目标开（规则 AI 同款增益）——
        if (dE > NAV_DIST * 450) {
          var dx = e0.position.x - tank.position.x, dz = e0.position.z - tank.position.z;
          var hd = CORE.wrap2pi(Math.atan2(dx, dz) - tank.heading);
          tank.drive(1, Math.max(-1, Math.min(1, hd * 2.2)), dt);
          tank.aimTurretAt(CORE.gunAimPoint(tank, e0), dt);   // 精确炮手（提前量+下坠补偿）
          stats.nav++;
          return;
        }

        // —— 交战区 ——
        var ap = CORE.gunAimPoint(tank, e0);
        var converged = CORE.barrelAligned(tank, ap, CORE.fireTol(dE));   // 距离自适应收敛门
        var ret = CORE.retreatCmd(tank, e0);
        if (ret) {
          // 残血撤退（规则 AI 同款 33% 阈值）：倒卡拉距、车头对敌、炮口继续输出（下方开火门照常）
          stats.retreat = (stats.retreat || 0) + 1;
          tank.drive(ret.thr, ret.turn, dt);
        } else {
          // 稳炮：近距缠斗炮口差一点收敛 → 压一拍转向让炮塔跟上，打完这炮再继续绕
          var turnCmd = act[1];
          if (!converged && dE < 120 && tank.canFire()) {
            var aimOffQ = CORE.wrap2pi(Math.atan2(ap.x - tank.position.x, ap.z - tank.position.z)
              - tank.heading - (tank.turretYaw || 0));
            if (Math.abs(aimOffQ) < 0.35) { turnCmd *= 0.3; stats.steady = (stats.steady || 0) + 1; }
          }
          tank.drive(act[0], turnCmd, dt);
        }
        tank.aimTurretAt(ap, dt);

        // —— 开火三重门：地形 LOS（坡）+ 烟幕纪律（烟里不开火）+ 收敛门（炮口真对准）——
        var em0 = (ctx && ctx.entityManager) || game.em;
        var terrainHold = CORE.terrainLos(tank.position.x, tank.position.y + 1.8, tank.position.z,
                                          ap.x, ap.y, ap.z);
        if (terrainHold) stats.terrainHold = (stats.terrainHold || 0) + 1;
        var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], tank.position, e0.position);
        if (smokeB) stats.smokeHold = (stats.smokeHold || 0) + 1;
        var wantFire = !terrainHold && !smokeB && converged && act[4] > (W.meta.fireTh || 0.5);
        if (!wantFire && !terrainHold && !smokeB && converged && ASSIST && tank.canFire()) {
          var dx0 = e0.position.x - tank.position.x, dz0 = e0.position.z - tank.position.z;
          if (Math.hypot(dx0, dz0) < 240) {
            var aimOff = CORE.wrap2pi(Math.atan2(ap.x - tank.position.x, ap.z - tank.position.z)
              - tank.heading - (tank.turretYaw || 0));
            var losN = CORE.blockedCount(lastObstacles, tank.position.x, tank.position.z,
                                         e0.position.x, e0.position.z, 9);
            if (Math.abs(aimOff) < 0.06 && losN === 0) { wantFire = true; stats.assist++; }
          }
        }
        if (wantFire && tank.canFire()) {
          if (tank.tryFire(em0)) stats.fires++;
        }
      } catch (e) {
        stats.fallbacks++;
        if (!stats.errLogged) { stats.errLogged = 1; console.error('[BC] pilot error:', e); }
        try { origUpdate(dt, ctx); } catch (e2) { /* 规则 AI 也异常则随游戏自身兜底 */ }
      }
    };
  }

  function tankDist(a, b) {
    return Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z);
  }

  function badge() {
    var el = document.getElementById('__bcBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__bcBadge';
      el.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#7cf;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #46a;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = '🤖 BC[' + (SIDE === 'ally' ? '队友' : SIDE === 'both' ? '双方' : '敌方') + '] ' +
      stats.bots + ' bots · ' + stats.fires + ' fires' +
      (stats.exting ? ' · 🧯' + stats.exting : '') +
      (stats.repairs ? ' · 🔧' + (stats.repairs / 60).toFixed(0) + 's' : '') +
      (stats.fallbacks ? ' · ⚠' + stats.fallbacks + ' fallback' : '');
  }

  // ---------- 主流程：加载权重 → 等游戏 → 轮询替换 ----------
  // activate()：供外部（agent-dagger.js 等）程序化激活；URL 方式自动激活
  function activate() {
    if (W) return Promise.resolve();
    return fetch(WEIGHTS_URL).then(function (r) {
      if (!r.ok) throw new Error('weights http ' + r.status);
      return r.json();
    }).then(function (w) {
      W = w;
      console.log('[BC] weights loaded: arch 70→' + w.meta.arch.join('→') + '→5, fireTh=' + w.meta.fireTh);
      if (BCON) {
        var wait = setInterval(function () {
          try {
            var g = window.__game;
            if (!g || !g.em) return;
            if (g.state !== 'playing') return;
            var pool = g.em.tanks || [];
            for (var i = 0; i < pool.length; i++) {
              var t = pool[i];
              if (!t || !t.alive || !t.ai || t.netGhost || done.has(t)) continue;
              if (t.__pilotedBy && t.__pilotedBy !== 'bc') continue;   // rl 实验体先到先得
              var want = (SIDE === 'enemy' && t.team === 'red') ||
                         (SIDE === 'ally' && t.side === 'ally') ||
                         (SIDE === 'both' && (t.team === 'red' || t.side === 'ally'));
              if (want) pilotate(t, g);
            }
            badge();
          } catch (e) { /* 轮询永不炸 */ }
        }, 1000);
        setInterval(function () {
          console.log('[BC] stats:', JSON.stringify(stats));
        }, 20000);
      }
      if (QON) startQCopilot();
    });
  }

  // ---------- Q 代打接管（2026-10-04）：游戏自带「AI 代打」的大脑换成第五代 BC ----------
  // 原理：Q 键后游戏创建 game._pilotAI = new TankAI(玩家坦克) 并每帧调其 update——
  //       我们轮询监视 _pilotAI 出现，把它的 update 换成 BC 全栈（维护+进场 P 控+交战 BC+
  //       精确炮手+开火）。Q 开关/buff（炮塔×1.8 装填×0.6）/HUD 提示全部沿用游戏原逻辑。
  //       飞机/直升机局不接管（_pilotAI 无 .tank 字段）；BC 异常回退原 TankAI。
  function startQCopilot() {
    setInterval(function () {
      try {
        var g = window.__game;
        if (!g || !g._pilotAI) return;
        var ai = g._pilotAI;
        if (ai.__bcq !== undefined) return;        // 已处理（接管或跳过）；Q 关→对象丢弃，天然还原
        if (!ai.tank) { ai.__bcq = 'skip'; return; }   // PlaneAI/HeliAI：仍用原版
        ai.__bcq = true;
        var t = ai.tank;
        var origUpdate = ai.update.bind(ai);
        var lastThink = 0, act = null, lastEnemies = [], lastObstacles = [];
        var qStuck = CORE.makeStuck(), qTgt = null;   // 脱困跟踪 + 目标认领
        var q = { fires: 0, thinks: 0, fallbacks: 0 };
        ai.update = function bcQUpdate(dt, ctx) {
          try {
            // 维护：灭火 + 修车（与 Q 副驾驶自带逻辑双保险，冷却幂等）
            if (t.burning) { try { t.tryExtinguish(); } catch (e) { } }
            var mm = t.modules;
            var modsBroken = mm && (mm.track > 0 || mm.barrel > 0 || mm.engine > 0);
            if (t.health < t.maxHealth || modsBroken) {
              if (t.health < t.maxHealth) t.health = Math.min(t.maxHealth, t.health + 15 * dt);
              if (mm) {
                if (mm.track > 0) mm.track = Math.max(0, mm.track - dt * 6);
                if (mm.barrel > 0) mm.barrel = Math.max(0, mm.barrel - dt * 6);
                if (mm.engine > 0) mm.engine = Math.max(0, mm.engine - dt * 6);
              }
            }
            var now = performance.now();
            if (now - lastThink >= THINK_MS) {
              lastThink = now;
              var em = (ctx && ctx.entityManager) || g.em;
              var obstacles = (ctx && ctx.obstacles) || (em && em.obstacles) || [];
              lastEnemies = CORE.enemiesOf(t, g);
              lastObstacles = obstacles;
              var obs = CORE.buildObs(t, g, lastEnemies, obstacles);
              act = forward(obs);
              q.thinks++;
              var newTgt = CORE.pickTarget(t, lastEnemies, qTgt);
              if (newTgt !== qTgt) { CORE.releaseTarget(t, qTgt); CORE.claimTarget(t, newTgt); qTgt = newTgt; }
            }
            if (!act) return origUpdate(dt, ctx);
            if (!t.alive) return;
            var e0 = (qTgt && qTgt.alive) ? qTgt : lastEnemies[0];
            ai.phase = 'BC 交战中';
            if (e0) {
              var d = Math.hypot(e0.position.x - t.position.x, e0.position.z - t.position.z);
              // 卡墙脱困（最高优先级）
              var thrIntent = d > NAV_DIST * 450 ? 1 : act[0];
              if (qStuck.update(t, thrIntent, dt)) {
                q.unstick = (q.unstick || 0) + 1;
                ai.phase = 'BC 脱困';
                t.drive(-1, qStuck.dir * 0.9, dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                return;
              }
              if (d > NAV_DIST * 450) {
                // 远距进场：P 控制器（AI 代打 buff 过的 maxSpeed 生效）
                var dx = e0.position.x - t.position.x, dz = e0.position.z - t.position.z;
                var hd = CORE.wrap2pi(Math.atan2(dx, dz) - t.heading);
                t.drive(1, Math.max(-1, Math.min(1, hd * 2.2)), dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                ai.phase = 'BC 进场';
                return;
              }
              var ap = CORE.gunAimPoint(t, e0);
              var converged = CORE.barrelAligned(t, ap, CORE.fireTol(d));   // 距离自适应收敛门
              var ret = CORE.retreatCmd(t, e0);
              if (ret) {
                ai.phase = 'BC 撤退';         // 残血倒车拉开，车头对敌继续输出
                q.retreat = (q.retreat || 0) + 1;
                t.drive(ret.thr, ret.turn, dt);
              } else {
                // 稳炮：近距差一点收敛 → 压一拍转向
                var turnCmd = act[1];
                if (!converged && d < 120 && t.canFire()) {
                  var aimOffQ = CORE.wrap2pi(Math.atan2(ap.x - t.position.x, ap.z - t.position.z)
                    - t.heading - (t.turretYaw || 0));
                  if (Math.abs(aimOffQ) < 0.35) turnCmd *= 0.3;
                }
                t.drive(act[0], turnCmd, dt);
              }
              t.aimTurretAt(ap, dt);
              // 开火三重门：地形 LOS + 烟幕纪律 + 收敛
              var terrainHold = CORE.terrainLos(t.position.x, t.position.y + 1.8, t.position.z,
                                                ap.x, ap.y, ap.z);
              if (terrainHold) q.terrainHold = (q.terrainHold || 0) + 1;
              var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], t.position, e0.position);
              if (smokeB) q.smokeHold = (q.smokeHold || 0) + 1;
              var wantFire = !terrainHold && !smokeB && converged && act[4] > (W.meta.fireTh || 0.5);
              if (!wantFire && !terrainHold && !smokeB && converged && ASSIST && t.canFire()) {
                var dx0 = e0.position.x - t.position.x, dz0 = e0.position.z - t.position.z;
                if (Math.hypot(dx0, dz0) < 240) {
                  var aimOff = CORE.wrap2pi(Math.atan2(ap.x - t.position.x, ap.z - t.position.z)
                    - t.heading - (t.turretYaw || 0));
                  var losN = CORE.blockedCount(lastObstacles, t.position.x, t.position.z,
                                               e0.position.x, e0.position.z, 9);
                  if (Math.abs(aimOff) < 0.06 && losN === 0) wantFire = true;
                }
              }
              if (wantFire && t.canFire()) {
                if (t.tryFire((ctx && ctx.entityManager) || g.em)) q.fires++;
              }
            } else {
              t.drive(act[0], act[1], dt);
            }
          } catch (e) {
            q.fallbacks++;
            if (!q.errLogged) { q.errLogged = 1; console.error('[BC] Q-copilot error:', e); }
            try { origUpdate(dt, ctx); } catch (e2) { }
          }
        };
        console.log('[BC] Q 代打已换装第五代大脑（坦克局；局内按 Q 关闭即还原原版）');
      } catch (e) { /* 轮询永不炸 */ }
    }, 200);
  }
  window.__BCAPI = { activate: activate };

  activate().catch(function (e) {
    console.warn('[BC] weights load failed, BC disabled:', e);
  });
})();
