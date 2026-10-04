// agent-rl.js — PPO 强化学习人机（第六代）：驾驶头由 PPO 在线学习，瞄准/开火/维护沿用第五代外壳
// 激活方式（满足其一）：
//   URL ?rl=1 / ?rl=enemy（敌方）或 ?rl=ally（队友）——训练用，默认采样+上报
//   localStorage.wt_rl = 'enemy'|'ally'（出战页「🧪 第六代实验体」按钮写入）——玩家用，
//     默认确定性推理（无噪声不上报）+ 静态权重 training/rl-weights.json
//   ?rl=0 强制关。平时（全未激活）第一行就 return，零影响。
// 参数：
//   rlNoise=0      确定性推理（取均值，不采样不上报）——评测/玩家模式默认
//   rlSrv=<url>    PPO 服务器地址（默认 http://<host>:8770，拉模式同步权重）
//   rlW=<path>     静态权重文件（如 training/rl-weights.json；优先于 rlSrv）
//   rlDump=1       调试输出
// 架构（第六代）：
//   维护层   🧯灭火 + 🔧修车（每帧，与第五代同款）
//   远距(>270m)  P 控制器进场（不采样——脚本驾驶不归 PPO 管）
//   交战区   PPO 驾驶头（mean+σ 高斯采样 → clamp 执行）+ 精确炮手 + 开火纪律兜底
//   奖励    击杀+10 / 命中+2 / 被命中-2 / 阵亡-10 / 开火-0.05 / 出环带[60,260]m -0.01/步
//   归因    旁听 EntityManager.checkCollisions 的 hits（{owner,target,killed}）逐弹归因
//   上报    每窗口攒 256 步或 15s POST /rollout；未完段带 lastObsByTid 引导值
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var _lrl = '0'; try { _lrl = localStorage.getItem('wt_rl') || '0'; } catch (e) { }
  var VIAURL = qs.get('rl') !== null;
  if (qs.get('rl') === '0') return;   // URL 硬关：短路；localStorage 状态交给模块级热切换守望器
  var SIDE = (qs.get('rl') === 'ally' || qs.get('rlSide') === 'ally') ? 'ally'
           : (qs.get('rl') === 'both' || qs.get('rlSide') === 'both' || _lrl === 'both') ? 'both'
           : (qs.get('rl') === 'enemy' || qs.get('rlSide') === 'enemy') ? 'enemy'
           : (_lrl === 'ally' ? 'ally' : 'enemy');
  var TRAIN = VIAURL ? qs.get('rlNoise') !== '0' : false;   // URL 训练默认开；玩家按钮=确定性
  var SRV = qs.get('rlSrv') || (location.protocol + '//' + location.hostname + ':8770');
  var WFILE = qs.get('rlW') || (VIAURL ? null : 'training/rl-weights.json');   // 玩家模式默认静态权重
  var DUMP = qs.get('rlDump') === '1';

  var CORE = window.__WTA;
  var THINK_MS = 100;                 // 与 BC/录制同款 10Hz
  var NAV_DIST = 0.6;                 // >0.6(270m) 走 P 控制器（第五代外壳）
  var BAND_LO = 60, BAND_HI = 260;    // 交战环带（米）：出带小额惩罚
  var POST_EVERY = 256;               // 攒多少步上报一次
  var POST_MS = 15000;                // 或最久 15s 上报一次
  var HALF_LOG_2PI = 0.5 * Math.log(2 * Math.PI);

  var winId = qs.get('farmSeed') || ('w' + Math.floor(Math.random() * 1e6));
  var tidSeq = 0;

  // ---------- PPO 网络前向（trunk 与 BC 同构，头 3 输出 [mean_thr, mean_turn, value]） ----------
  var W = null;   // {W1,b1,W2,b2,W3,b3, logStd[], norm{mu,sd}, gen}
  function matvec(x, M, b) {
    var out = new Float32Array(b.length);
    for (var j = 0; j < b.length; j++) {
      var s = 0;
      for (var i = 0; i < x.length; i++) s += x[i] * M[i][j];
      out[j] = s + b[j];
    }
    return out;
  }
  function forward(obs) {   // → {m:[thr,turn], v:value}
    var x = new Float32Array(obs.length), i;
    for (i = 0; i < obs.length; i++) x[i] = (obs[i] - W.norm.mu[i]) / W.norm.sd[i];
    var h1 = matvec(x, W.W1, W.b1);
    for (i = 0; i < h1.length; i++) if (h1[i] < 0) h1[i] = 0;
    var h2 = matvec(h1, W.W2, W.b2);
    for (i = 0; i < h2.length; i++) if (h2[i] < 0) h2[i] = 0;
    var out = matvec(h2, W.W3, W.b3);
    return { m: [out[0], out[1]], v: out[2] };
  }
  function gauss() {
    var u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }

  // ---------- 权重加载：静态文件（评测）或 PPO 服务器拉模式（训练） ----------
  var stats = { bots: 0, thinking: 0, steps: 0, posts: 0, postErr: 0, kills: 0, hits: 0,
                taken: 0, deaths: 0, fires: 0, nav: 0, fallbacks: 0, gen: -1 };

  function loadStatic() {
    return fetch(new URL(WFILE, location.href).href).then(function (r) {
      if (!r.ok) throw new Error('rlW http ' + r.status);
      return r.json();
    }).then(function (w) {
      W = w; stats.gen = w.gen;
      console.log('[RL] static weights loaded: gen=' + w.gen);
    });
  }
  function pullWeights() {
    return fetch(SRV + '/weights').then(function (r) { return r.json(); }).then(function (w) {
      W = w; stats.gen = w.gen;
      console.log('[RL] weights pulled: gen=' + w.gen + ' logStd=[' +
        w.logStd.map(function (x) { return x.toFixed(2); }).join(',') + ']');
    });
  }
  function startWeightSync() {
    if (WFILE) return loadStatic().catch(function (e) { console.warn('[RL] static load failed:', e); });
    var boot = pullWeights().catch(function (e) {
      console.warn('[RL] PPO server not ready, retry:', e);
      return new Promise(function (res) { setTimeout(res, 3000); }).then(pullWeights);
    });
    boot.then(function loop() {
      setTimeout(function () {
        fetch(SRV + '/gen').then(function (r) { return r.json(); }).then(function (g) {
          if (g.gen !== stats.gen) return pullWeights();
        }).then(loop).catch(function () { setTimeout(loop, 3000); });
      }, 5000);
    });
    return boot;
  }

  // ---------- 命中事件旁听（奖励归因）：包 EntityManager.checkCollisions，先执行原方法 ----------
  function hookEmClass(Cls) {
    if (!Cls || !Cls.prototype || Cls.prototype.__rlHooked) return;
    Cls.prototype.__rlHooked = true;
    var orig = Cls.prototype.checkCollisions;
    if (!orig) return;
    Cls.prototype.checkCollisions = function () {
      var hits = orig.apply(this, arguments);
      try { if (hits && hits.length) onHits(hits); } catch (e) { /* 旁听永不炸游戏 */ }
      return hits;
    };
    console.log('[RL] EntityManager.checkCollisions hooked');
  }

  function onHits(hits) {
    for (var h, i = 0; i < hits.length; i++) {
      h = hits[i];
      pilots.forEach(function (rec, tank) {
        if (rec.dead) return;
        if (h.owner === tank && h.target && h.target.team !== tank.team) {
          if (h.killed) { rec.pend += 10; stats.kills++; }
          else { rec.pend += 2; stats.hits++; }
        }
        if (h.target === tank) {
          if (h.killed) closeEpisode(tank, true);      // 阵亡：-10 并封段
          else { rec.pend -= 2; stats.taken++; }
        }
      });
    }
  }

  // ---------- 采样记录 ----------
  var pilots = new Map();   // tank -> rec（活跃 episode）
  var allRecs = [];         // 全部 rec（含已封段的，post 后清步）
  var pendingSteps = 0;     // 未上报步数

  function newRec(tank) {
    tank.__pilotedBy = 'rl';   // 跨脚本互斥：agent-bc 见此标记不重复接管
    var rec = {
      tank: tank, tid: winId + '-' + (++tidSeq), dead: false, pend: 0,
      applied: null, nextObs: null, lastEnemies: [], lastObstacles: [],
      stuck: CORE.makeStuck(), tgt: null,   // 脱困跟踪 + 集火分散认领
      steps: { obs: [], act: [], logp: [], val: [], rew: [], done: [] }
    };
    pilots.set(tank, rec);
    allRecs.push(rec);
    return rec;
  }

  // 关段：把 pend（含 -10 死亡惩罚）结到最后一歩，done=1
  function closeEpisode(tank, died) {
    var rec = pilots.get(tank);
    if (!rec || rec.dead) return;
    rec.dead = true;
    if (died) { rec.pend -= 10; stats.deaths++; }
    var n = rec.steps.obs.length;
    if (n > 0) {
      rec.steps.rew[n - 1] += rec.pend;
      rec.steps.done[n - 1] = 1;
    }
    rec.pend = 0;
    pilots.delete(tank);
  }

  function closeAll(matchOver) {
    pilots.forEach(function (rec, tank) { closeEpisode(tank, matchOver && !tank.alive); });
  }

  // ---------- rollout 上报 ----------
  var gameRef = null;   // mount 轮询时刷新，供上报时重建引导观测
  function collectPayload() {
    var pl = { win: winId, obs: [], act: [], logp: [], val: [], rew: [], done: [], tid: [], lastObsByTid: {} };
    for (var i = allRecs.length - 1; i >= 0; i--) {
      var rec = allRecs[i];
      var n = rec.steps.obs.length;
      if (!n) { if (rec.dead) allRecs.splice(i, 1); continue; }
      pl.obs = pl.obs.concat(rec.steps.obs);
      pl.act = pl.act.concat(rec.steps.act);
      pl.logp = pl.logp.concat(rec.steps.logp);
      pl.val = pl.val.concat(rec.steps.val);
      pl.rew = pl.rew.concat(rec.steps.rew);
      pl.done = pl.done.concat(rec.steps.done);
      for (var k = 0; k < n; k++) pl.tid.push(rec.tid);
      if (!rec.dead) {
        // 引导值：就地重建当前 obs（= 最后一歩动作之后的状态，语义精确）
        var boot = rec.nextObs;
        try {
          if (gameRef && rec.tank && rec.tank.alive) {
            boot = CORE.buildObs(rec.tank, gameRef,
              CORE.enemiesOf(rec.tank, gameRef), rec.lastObstacles || []);
          }
        } catch (e) { }
        if (boot) pl.lastObsByTid[rec.tid] = boot;
      }
      rec.steps = { obs: [], act: [], logp: [], val: [], rew: [], done: [] };
    }
    pendingSteps = 0;
    return pl;
  }
  function postNow(beacon) {
    if (!TRAIN) return;
    var pl = collectPayload();
    if (!pl.obs.length) return;
    stats.posts++;
    if (beacon) {
      try { navigator.sendBeacon(SRV + '/rollout', JSON.stringify(pl)); } catch (e) { }
      return;
    }
    fetch(SRV + '/rollout', { method: 'POST', body: JSON.stringify(pl) })   // 不设 Content-Type → text/plain 简单请求免预检
      .catch(function (e) { stats.postErr++; console.warn('[RL] post failed:', e); });
  }

  // ---------- 接管坦克（第五代外壳 + PPO 驾驶头） ----------
  function tankDist(a, b) { return Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z); }

  function pilotate(tank, game) {
    var origUpdate = tank.ai.update.bind(tank.ai);
    var lastThink = 0;
    var rec = newRec(tank);
    rec.origUpdate = origUpdate;   // 热切换关闭时还原
    stats.bots++;
    tank.ai.update = function rlPilotUpdate(dt, ctx) {
      try {
        // —— 维护层：起火即灭 + 修车 ——
        // 修车仅蓝方；训练模式（TRAIN）红方保留修车——训练环境不能中途变（污染实验）
        // rlFair=0：观察镜用——忠实还原训练环境（红方修车开着），只去掉噪声
        var noRepair = !TRAIN && SIDE !== 'both' && tank.team === 'red' && qs.get('rlFair') !== '0';
        if (tank.burning) { try { tank.tryExtinguish(); } catch (e) { } }
        if (!noRepair) {
          var mm = tank.modules;
          var modsBroken = mm && (mm.track > 0 || mm.barrel > 0 || mm.engine > 0);
          if (tank.health < tank.maxHealth || modsBroken) {
            if (tank.health < tank.maxHealth) tank.health = Math.min(tank.maxHealth, tank.health + 15 * dt);
            if (mm) {
              if (mm.track > 0) mm.track = Math.max(0, mm.track - dt * 6);
              if (mm.barrel > 0) mm.barrel = Math.max(0, mm.barrel - dt * 6);
              if (mm.engine > 0) mm.engine = Math.max(0, mm.engine - dt * 6);
            }
          }
        }

        var now = performance.now();
        if (now - lastThink >= THINK_MS) {
          lastThink = now;
          think(tank, game, rec, ctx);
        }
        if (!rec.applied) return origUpdate(dt, ctx);   // 首帧未推理：先用规则 AI
        if (!tank.alive) return;

        // —— 目标选择：集火分散（obs 仍最近 3 敌，采样语义不变）——
        var e0 = (rec.tgt && rec.tgt.alive) ? rec.tgt : rec.lastEnemies[0];
        if (!e0) { tank.drive(rec.applied[0], rec.applied[1], dt); return; }
        var dE = tankDist(tank, e0);

        // —— 卡墙脱困（最高优先级；注意：脚本驾驶段不采样）——
        var thrIntent = dE > NAV_DIST * 450 ? 1 : rec.applied[0];
        if (rec.stuck.update(tank, thrIntent, dt)) {
          stats.unstick = (stats.unstick || 0) + 1;
          tank.drive(-1, rec.stuck.dir * 0.9, dt);
          tank.aimTurretAt(CORE.gunAimPoint(tank, e0), dt);
          return;
        }

        // —— 远距进场：P 控制器（第五代外壳，脚本驾驶不采样） ——
        if (dE > NAV_DIST * 450) {
          var dx = e0.position.x - tank.position.x, dz = e0.position.z - tank.position.z;
          var hd = CORE.wrap2pi(Math.atan2(dx, dz) - tank.heading);
          tank.drive(1, Math.max(-1, Math.min(1, hd * 2.2)), dt);
          tank.aimTurretAt(CORE.gunAimPoint(tank, e0), dt);   // 精确炮手（提前量+下坠补偿）
          stats.nav++;
          return;
        }
        // —— 交战区：PPO 驾驶 + 精确炮手 ——
        var ap0 = CORE.gunAimPoint(tank, e0);
        var converged0 = CORE.barrelAligned(tank, ap0, CORE.fireTol(dE));
        var ret = CORE.retreatCmd(tank, e0);
        if (ret) {
          stats.retreat = (stats.retreat || 0) + 1;   // 残血撤退：倒卡拉距、车头对敌、照常开火
          tank.drive(ret.thr, ret.turn, dt);
        } else {
          // 稳炮：近距差一点收敛 → 压一拍转向让炮塔跟上
          var turnCmd = rec.applied[1];
          if (!converged0 && dE < 120 && tank.canFire()) {
            var aimOffQ = CORE.wrap2pi(Math.atan2(ap0.x - tank.position.x, ap0.z - tank.position.z)
              - tank.heading - (tank.turretYaw || 0));
            if (Math.abs(aimOffQ) < 0.35) { turnCmd *= 0.3; stats.steady = (stats.steady || 0) + 1; }
          }
          tank.drive(rec.applied[0], turnCmd, dt);   // 避让层撤除（gen226 训练时无此层，部署打架致 422/526s 拖延）
        }
        tank.aimTurretAt(ap0, dt);
        // —— 开火三重门：地形 LOS + 烟幕纪律 + 收敛（240m 内 + 障碍 LOS + 装填好）——
        if (tank.canFire()) {
          var em0 = (ctx && ctx.entityManager) || game.em;
          var dx0 = e0.position.x - tank.position.x, dz0 = e0.position.z - tank.position.z;
          if (Math.hypot(dx0, dz0) < 240) {
            var terrainHold = CORE.terrainLos(tank.position.x, tank.position.y + 1.8, tank.position.z,
                                              ap0.x, ap0.y, ap0.z);
            if (terrainHold) stats.terrainHold = (stats.terrainHold || 0) + 1;
            var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], tank.position, e0.position);
            if (smokeB) stats.smokeHold = (stats.smokeHold || 0) + 1;
            var aimOff = CORE.wrap2pi(Math.atan2(ap0.x - tank.position.x, ap0.z - tank.position.z)
              - tank.heading - (tank.turretYaw || 0));
            var losN = CORE.blockedCount(rec.lastObstacles, tank.position.x, tank.position.z,
                                         e0.position.x, e0.position.z, 9);
            if (!terrainHold && !smokeB && converged0 && Math.abs(aimOff) < 0.06 && losN === 0) {
              if (tank.tryFire(em0)) { stats.fires++; rec.pend -= 0.05; }
            }
          }
        }
      } catch (e) {
        stats.fallbacks++;
        if (!stats.errLogged) { stats.errLogged = 1; console.error('[RL] pilot error:', e); }
        try { origUpdate(dt, ctx); } catch (e2) { }
      }
    };
  }

  // 10Hz 思考：环带惩罚 → 结转上一步奖励 → 采样动作（交战区才记步）
  function think(tank, game, rec, ctx) {
    var em = (ctx && ctx.entityManager) || game.em;
    var obstacles = (ctx && ctx.obstacles) || (em && em.obstacles) || [];
    rec.lastEnemies = CORE.enemiesOf(tank, game);
    rec.lastObstacles = obstacles;
    // 目标认领（集火分散）
    var newTgt = CORE.pickTarget(tank, rec.lastEnemies, rec.tgt);
    if (newTgt !== rec.tgt) { CORE.releaseTarget(tank, rec.tgt); CORE.claimTarget(tank, newTgt); rec.tgt = newTgt; }
    var e0 = rec.lastEnemies[0];
    var d = e0 ? tankDist(tank, e0) : 9999;
    var inEngage = e0 && d <= NAV_DIST * 450;   // 交战区：RL 驾驶（导航段不采样——P 控制器脚本驾驶）

    // 出交战环带小额惩罚（只计 RL 驾驶段）
    if (inEngage && (d > BAND_HI || d < BAND_LO)) rec.pend -= 0.01;

    // 结转：上一区间发生的事件奖励归上一动作（导航段发生的事件不归策略——那是 P 控制器在开车）
    var n = rec.steps.obs.length;
    if (n > 0 && inEngage) { rec.steps.rew[n - 1] += rec.pend; }
    rec.pend = 0;

    var obs = CORE.buildObs(tank, game, rec.lastEnemies, obstacles);
    var out = forward(obs);
    stats.thinking++;

    var a0, a1, logp = 0;
    if (TRAIN) {
      var s0 = Math.exp(W.logStd[0]), s1 = Math.exp(W.logStd[1]);
      var z0 = gauss(), z1 = gauss();
      a0 = out.m[0] + s0 * z0; a1 = out.m[1] + s1 * z1;
      logp = (-0.5 * z0 * z0 - W.logStd[0] - HALF_LOG_2PI) +
             (-0.5 * z1 * z1 - W.logStd[1] - HALF_LOG_2PI);
    } else {
      a0 = out.m[0]; a1 = out.m[1];   // 评测：确定均值
    }
    rec.applied = [clamp1(a0), clamp1(a1)];

    if (TRAIN && inEngage) {
      // 记步：obs=动作前状态（因果配对），act=未截断原始采样值（与 logp 一致）
      rec.steps.obs.push(obs);
      rec.steps.act.push([a0, a1]);
      rec.steps.logp.push(logp);
      rec.steps.val.push(out.v);
      rec.steps.rew.push(0);
      rec.steps.done.push(0);
      rec.nextObs = obs;      // 引导值：本 obs 是上一动作后的状态
      stats.steps++;
      pendingSteps++;
      if (pendingSteps >= POST_EVERY) postNow(false);
      if (DUMP && stats.steps <= 20)
        console.log('[RLDUMP] d=' + d.toFixed(0) + ' m=[' + out.m[0].toFixed(2) + ',' + out.m[1].toFixed(2) +
          '] a=[' + rec.applied[0].toFixed(2) + ',' + rec.applied[1].toFixed(2) + '] v=' + out.v.toFixed(2));
    }
  }

  // ---------- Q 代打·第六代（2026-10-04 用户要求：Q 换第六代大脑）----------
  // 默认第六代；localStorage.wt_qgen='5' 或 URL ?qGen=5 切回第五代（agent-bc 那套让位/接管互补）
  function qGenIs6() {
    var q = null;
    try { q = qs.get('qGen'); } catch (e) { }
    if (q === '5') return false;
    if (q === '6') return true;
    try { return localStorage.getItem('wt_qgen') !== '5'; } catch (e) { return true; }
  }
  function startQCopilot6() {
    setInterval(function () {
      try {
        var g = window.__game;
        if (!g || !g._pilotAI) return;
        var ai = g._pilotAI;
        if (ai.__rlq !== undefined) return;
        if (!ai.tank) { ai.__rlq = 'skip'; return; }          // 飞机/直升机：仍用原版
        if (!qGenIs6()) { ai.__rlq = 'gen5'; return; }        // 五代模式：agent-bc 接管
        ai.__rlq = true;
        var t = ai.tank;
        var origUpdate = ai.update.bind(ai);
        var lastThink = 0, applied = null, lastEnemies = [], lastObstacles = [];
        var qStuck = CORE.makeStuck(), qTgt = null;
        var q = { fires: 0, thinks: 0, fallbacks: 0 };
        if (!W) {   // 懒加载静态权重（与玩家版同源）
          fetch(new URL('training/rl-weights.json', location.href).href).then(function (r) { return r.json(); })
            .then(function (w) { W = w; console.log('[RL] Q 代打权重就位: gen', w.gen); })
            .catch(function (e) { console.warn('[RL] Q 代打权重加载失败，暂用原版:', e); });
        }
        ai.update = function rlQUpdate(dt, ctx) {
          try {
            if (!W) return origUpdate(dt, ctx);
            // 维护（玩家坦克=蓝方，修车开）
            if (t.burning) { try { t.tryExtinguish(); } catch (e) { } }
            var mm = t.modules;
            var mb = mm && (mm.track > 0 || mm.barrel > 0 || mm.engine > 0);
            if (t.health < t.maxHealth || mb) {
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
              lastObstacles = (ctx && ctx.obstacles) || (em && em.obstacles) || [];
              lastEnemies = CORE.enemiesOf(t, g);
              var obs = CORE.buildObs(t, g, lastEnemies, lastObstacles);
              var out = forward(obs);                       // 第六代头：mean 确定性（不采样）
              applied = [Math.max(-1, Math.min(1, out.m[0])), Math.max(-1, Math.min(1, out.m[1]))];
              q.thinks++;
              var newTgt = CORE.pickTarget(t, lastEnemies, qTgt);
              if (newTgt !== qTgt) { CORE.releaseTarget(t, qTgt); CORE.claimTarget(t, newTgt); qTgt = newTgt; }
            }
            if (!applied) return origUpdate(dt, ctx);
            if (!t.alive) return;
            var e0 = (qTgt && qTgt.alive) ? qTgt : lastEnemies[0];
            ai.phase = '六代交战中';
            if (e0) {
              var d = Math.hypot(e0.position.x - t.position.x, e0.position.z - t.position.z);
              var thrIntent = d > NAV_DIST * 450 ? 1 : applied[0];
              if (qStuck.update(t, thrIntent, dt)) {
                q.unstick = (q.unstick || 0) + 1;
                ai.phase = '六代脱困';
                t.drive(-1, qStuck.dir * 0.9, dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                return;
              }
              if (d > NAV_DIST * 450) {
                var dx = e0.position.x - t.position.x, dz = e0.position.z - t.position.z;
                var hd = CORE.wrap2pi(Math.atan2(dx, dz) - t.heading);
                t.drive(1, Math.max(-1, Math.min(1, hd * 2.2)), dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                ai.phase = '六代进场';
                return;
              }
              var ap = CORE.gunAimPoint(t, e0);
              var converged = CORE.barrelAligned(t, ap, CORE.fireTol(d));
              var ret = CORE.retreatCmd(t, e0);
              if (ret) {
                ai.phase = '六代撤退';
                q.retreat = (q.retreat || 0) + 1;
                t.drive(ret.thr, ret.turn, dt);
              } else {
                var turnCmd = applied[1];
                if (!converged && d < 120 && t.canFire()) {
                  var aimOffQ = CORE.wrap2pi(Math.atan2(ap.x - t.position.x, ap.z - t.position.z)
                    - t.heading - (t.turretYaw || 0));
                  if (Math.abs(aimOffQ) < 0.35) turnCmd *= 0.3;
                }
                t.drive(applied[0], turnCmd, dt);
              }
              t.aimTurretAt(ap, dt);
              // 开火三重门（纪律兜底，无网络火头）
              var terrainHold = CORE.terrainLos(t.position.x, t.position.y + 1.8, t.position.z,
                                                ap.x, ap.y, ap.z);
              if (terrainHold) q.terrainHold = (q.terrainHold || 0) + 1;
              var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], t.position, e0.position);
              if (smokeB) q.smokeHold = (q.smokeHold || 0) + 1;
              if (!terrainHold && !smokeB && converged && t.canFire()) {
                var dx0 = e0.position.x - t.position.x, dz0 = e0.position.z - t.position.z;
                if (Math.hypot(dx0, dz0) < 240) {
                  var aimOff = CORE.wrap2pi(Math.atan2(ap.x - t.position.x, ap.z - t.position.z)
                    - t.heading - (t.turretYaw || 0));
                  var losN = CORE.blockedCount(lastObstacles, t.position.x, t.position.z,
                                               e0.position.x, e0.position.z, 9);
                  if (Math.abs(aimOff) < 0.06 && losN === 0) {
                    if (t.tryFire((ctx && ctx.entityManager) || g.em)) q.fires++;
                  }
                }
              }
            } else {
              t.drive(applied[0], applied[1], dt);
            }
          } catch (e) {
            q.fallbacks++;
            if (!q.errLogged) { q.errLogged = 1; console.error('[RL] Q-copilot error:', e); }
            try { origUpdate(dt, ctx); } catch (e2) { }
          }
        };
        console.log('[RL] Q 代打已换装第六代大脑（确定性；wt_qgen=5 可切回五代）');
      } catch (e) { /* 轮询永不炸 */ }
    }, 200);
  }

  // ---------- 徽标 / API ----------
  function badge(txt) {
    var el = document.getElementById('__rlBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__rlBadge';
      el.style.cssText = 'position:fixed;left:12px;top:114px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#d8f;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #84a;';   // 左上（FPS 下方），避让右侧击杀播报/回放小窗
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = txt;
  }
  function badgeText() {
    return (W ? '🧠 RL[' + (SIDE === 'ally' ? '队友' : SIDE === 'both' ? '双方' : '敌方') + '] gen' + stats.gen +
      (TRAIN ? ' σ' + Math.exp(W.logStd[0]).toFixed(2) : ' 确定性') :
      '🧠 RL 等权重…') +
      ' · ' + stats.bots + ' bots · ' + stats.steps + ' steps · 🎯' + stats.kills + '/' + stats.hits +
      ' · ☠' + stats.deaths + ' · 🔥' + stats.fires +
      (stats.fallbacks ? ' · ⚠' + stats.fallbacks : '');
  }

  window.__RLAPI = { stats: stats, postNow: function () { postNow(false); } };

  // ---------- 主流程 ----------
  var liveSide = VIAURL ? SIDE : null;   // URL 模式冻结；localStorage 模式由守望器热切
  var booted = false;                    // 玩家模式权重已就位
  function boot() {                       // 权重就位后启动 mount 循环（幂等）
    if (booted) return;
    booted = true;
    startWeightSync().then(function () {
    if (!W) { booted = false; return; }
    var lastPost = 0;
    var mount = setInterval(function () {
      try {
        var g = window.__game;
        if (!g || !g.em) return;
        gameRef = g;
        if (g.state === 'playing') {
          if (!liveSide) { restoreAll(g); return; }
          hookEmClass(g.em.constructor);
          var pool = g.em.tanks || [];
          for (var i = 0; i < pool.length; i++) {
            var t = pool[i];
            if (!t || !t.alive || !t.ai || t.netGhost || pilots.has(t)) continue;
            if (t.__pilotedBy && t.__pilotedBy !== 'rl') continue;   // BC 先到先得（跨脚本互斥）
            var want = (liveSide === 'enemy' && t.team === 'red') ||
                       (liveSide === 'ally' && t.side === 'ally') ||
                       (liveSide === 'both' && (t.team === 'red' || t.side === 'ally'));
            if (want) { SIDE = liveSide; pilotate(t, g); }
          }
        } else if (g.state === 'over') {
          closeAll(true);                    // 局终：封所有段（死亡的含 -10）
          if (TRAIN && Date.now() - lastPost > 3000) { lastPost = Date.now(); postNow(false); }
        }
        // 兜底：非 hits 路径死亡（溅射/坠毁等）由 watchdog 封段
        pilots.forEach(function (rec, tank) { if (!tank.alive) closeEpisode(tank, true); });
        if (TRAIN && Date.now() - lastPost > POST_MS) { lastPost = Date.now(); postNow(false); }
        badge(badgeText());
      } catch (e) { /* 轮询永不炸 */ }
    }, 500);
    setInterval(function () { if (liveSide || TRAIN) console.log('[RL] stats:', JSON.stringify(stats)); }, 20000);
    });
  }
  // —— 热切换守望（模块级）：出战页「🧪 第六代实验体」写 localStorage，0.5s 生效免刷新 ——
  setInterval(function () {
    try {
      var v = '0'; try { v = localStorage.getItem('wt_rl') || '0'; } catch (e) { }
      var want = (v === 'enemy' || v === 'ally' || v === 'both') ? v : null;
      if (VIAURL) return;   // URL 模式：加载时冻结，不热切
      if (want !== liveSide) {
        liveSide = want;
        console.log('[RL] 热切换 →', want || '关闭');
        if (want) { SIDE = want; boot(); }
      }
    } catch (e) { }
  }, 500);
  function restoreAll(g) {
    try {
      var pool = (g && g.em && g.em.tanks) || [];
      for (var i = 0; i < pool.length; i++) {
        var t = pool[i];
        if (!t) continue;
        var rec = pilots.get(t);
        if (rec && rec.origUpdate) { try { t.ai.update = rec.origUpdate; } catch (e) { } }
        pilots.delete(t);
        if (t.__pilotedBy === 'rl') t.__pilotedBy = null;
      }
    } catch (e) { }
  }
  if (VIAURL) boot();
  startQCopilot6();   // Q 代打·第六代（与 agent-bc 的五代版互补让位）
  window.addEventListener('beforeunload', function () { closeAll(true); postNow(true); });
})();
