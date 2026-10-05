// agent-rl7.js — 第七代 PPO 人机：端到端瞄准开火（第一课）+ 避让层入壳同训 + 新奖励体系
// 激活方式（满足其一）：
//   URL ?rl7=1 / ?rl7=enemy（敌方）/ ?rl7=ally（队友）/ ?rl7=both（双方）——训练用，默认采样+上报
//   localStorage.wt_rl7 = 'enemy'|'ally'|'both'（出战页「🚀 第七代人机」按钮写入）——玩家用，
//     默认确定性推理（不采样不上报）+ 静态权重 training/rl7-weights.json
//   ?rl7=0 强制关。平时（全未激活）第一行就 return，零影响。
// 参数：rlNoise=0 确定性 / rl7Srv=<url> 训练服务器（默认 :8771）/ rl7W=<path> 静态权重 /
//       rl7Assist=0 关开火纪律兜底 / rl7Dump=1 调试
// 架构（第七代，与训练壳严格一致——改壳=改环境，改完必须重训）：
//   维护层   🧯灭火 + 🔧修车（每帧，与五/六代同款）
//   远距(>270m)  P 控制器进场 + avoidCmd 避让 + 精确炮手（脚本段，不采样）
//   脱困/撤退    驾驶脚本接管；瞄准/开火仍走网络（交战区内统一，训练=部署）
//   交战区   PPO 全控：drive(thr,turn)+avoidCmd 避让（部署同款入壳）/ aimTurretAt(网络瞄准点) /
//            开火 = 网络火头 ∪ 纪律兜底，物理门（地形LOS/烟幕/障碍LOS/炮口收敛/240m/装填）硬拦
//   动作 5 维 [thr, turn, aimYaw, aimPitch, fire]：前 4 高斯（σ 逐维上限：驾驶 1.11/瞄准 0.15），
//            fire 伯努利；执行时 thr/turn/aim clamp，aim 反算世界点喂 aimTurretAt（与录制标签互逆）
//   奖励    击杀+10 / 命中+2 / 被命中-2 / 阵亡-10 / 开火-0.05 / 出环带[60,260]m -0.01/步
//          + 撞障罚（脱困触发 -0.5）+ 干净接近奖(+0.01×Δdist/10) + 朝敌奖(+0.003×cos)
//          + 绕圈罚(-0.03/步：4s 窗里程>15m 且 净位移比<0.3 且 窗口内未开火——治绕圈，不误伤缠斗)
//   归因/上报 同六代：旁听 checkCollisions 逐弹归因；每 256 步或 15s POST /rollout
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  var _l7 = '0'; try { _l7 = localStorage.getItem('wt_rl7') || '0'; } catch (e) { }
  var VIAURL = qs.get('rl7') !== null;
  if (qs.get('rl7') === '0') return;   // URL 硬关：短路；localStorage 状态交给模块级热切换守望器
  var SIDE = (qs.get('rl7') === 'ally' || qs.get('rl7Side') === 'ally') ? 'ally'
           : (qs.get('rl7') === 'both' || qs.get('rl7Side') === 'both' || _l7 === 'both') ? 'both'
           : (qs.get('rl7') === 'enemy' || qs.get('rl7Side') === 'enemy') ? 'enemy'
           : (_l7 === 'ally' ? 'ally' : 'enemy');
  var TRAIN = VIAURL ? qs.get('rl7Noise') !== '0' : false;   // URL 训练默认开；玩家按钮=确定性
  var SRV = qs.get('rl7Srv') || (location.protocol + '//' + location.hostname + ':8771');
  var WFILE = qs.get('rl7W') || (VIAURL ? null : 'training/rl7-weights.json');
  var ASSIST = qs.get('rl7Assist') !== '0';
  var DUMP = qs.get('rl7Dump') === '1';

  var CORE = window.__WTA;
  var THINK_MS = 100;                 // 10Hz（与 BC/录制/六代同款）
  var NAV_DIST = 0.6;                 // >0.6(270m) 走 P 控制器（脚本段）
  var BAND_LO = 60, BAND_HI = 260;    // 交战环带（米）
  var POST_EVERY = 256, POST_MS = 15000;
  var HALF_LOG_2PI = 0.5 * Math.log(2 * Math.PI);
  // —— 新奖励常数（第七代） ——
  var STUCK_PEN = 0.5;                // 撞障罚：脱困触发一次性 -0.5
  var APPROACH_K = 0.01 / 10;         // 干净接近奖：+0.01×Δdist/10（每米 0.001）
  var APPROACH_CAP = 20;              // 单步 Δdist 封顶（防换目标/传送虚增）
  var FACE_K = 0.003;                 // 朝敌奖：+0.003×max(0,cos 朝敌角)（治绕圈·正向）
  var TRAIL_N = 40;                   // 绕圈检测窗：40 步 = 4s
  var TRAIL_PATH_MIN = 15;            // 窗口里程阈值（m）：低于它=没在跑，不判绕圈
  var TRAIL_RATIO = 0.3;              // 净位移/里程 < 0.3 = 绕圈/空转（直线冲敌≈0.9）
  var CIRCLE_PEN = 0.03;              // 绕圈罚：-0.03/步（连续绕 10s=-3.0；窗口内开过火不罚=合法缠斗）
  var PROX_K = 0.012;                 // 接近罚：-0.012×(1-d/15)²/步（正对障碍<15m，撞墙前置信号，
                                      // 错误瞬间扣钱——脱困罚-0.5 是追认式追不上连环触发）
  var FIRE_TA = 0.12, FIRE_TB = 0.6;  // fire 对数尺度温度（与 ppo7_train.py 同值）：BC 火头 logit mean=-27，
                                      // 固定偏置无法校准；训练采样/logp 同用 sigmoid(a·f+b)；
                                      // 评测不带温度（保守）+纪律兜底
  var AIM_K = 0.0;                    // 瞄准蒸馏塑形（A' 试验 2026-10-05 半小时无显著改善后关闭）：
                                      // B 变体（同日）——执行端瞄准直接用几何炮手（五代六代同款 33-54% 命中率），
                                      // 网络只学驾驶+开火时机（fire 头信用更干净：瞄必准，开火≠命中全归它）。
                                      // aimErr 统计保留纯观测（看 aim 头是否自发向家教收敛）

  var winId = qs.get('farmSeed') || ('w' + Math.floor(Math.random() * 1e6));
  var tidSeq = 0;

  // —— buildObs7（2026-10-05 用户实战反馈"绕路不聪明/瞻前不顾后"→ 感知扩容）——
  // 旧 70 维原样保留（W1 旧列语义不变，热启动无损）+ 追加 22 新维：
  //   [障碍 7~10 号 ×3 维（d/60, sinB, cosB，格式同旧槽）] + [前 10 障碍半径 ×1 维（r/15）]
  // = 92 维。网络从"6 个没有大小的点"升级为"10 个有半径的障碍"。
  // 旧 BC 锚数据 pad 22 个 0（网络初始忽略新维=旧行为，PPO 在线学会利用）。
  var OBS7_DIM = 92;
  function buildObs7(tank, game, enemies, obstacles) {
    var base = CORE.buildObs(tank, game, enemies, obstacles);
    var obs = base.slice();   // 70 维
    var pos = tank.position, h = tank.heading;
    var list = [];
    for (var i = 0; i < obstacles.length; i++) {
      var ob = obstacles[i];
      if (!ob || !ob.position) continue;
      list.push(ob);
    }
    list.sort(function (a, b) {
      var da = (a.position.x - pos.x) ** 2 + (a.position.z - pos.z) ** 2;
      var db = (b.position.x - pos.x) ** 2 + (b.position.z - pos.z) ** 2;
      return da - db;
    });
    for (i = 6; i < 10; i++) {          // 障碍 7~10 号：方位 3 维（同旧槽格式）
      ob = list[i];
      if (!ob) { obs.push(0, 0, 0); continue; }
      var dx = ob.position.x - pos.x, dz = ob.position.z - pos.z;
      var brg = CORE.wrap2pi(Math.atan2(dx, dz) - h);
      obs.push(Math.min(1, Math.hypot(dx, dz) / 60), Math.sin(brg), Math.cos(brg));
    }
    for (i = 0; i < 10; i++) {          // 前 10 障碍：半径归一（15m 封顶；石头 3 vs 建筑 15 终于有区别）
      ob = list[i];
      obs.push(ob ? Math.min(1, (ob.radius || 3) / 15) : 0);
    }
    return obs;
  }

  // ---------- PPO 网络前向（trunk 与 BC 同构；头 6 输出 [mean×4, fireLogit, value]） ----------
  var W = null;   // {W1,b1,W2,b2,W3,b3, logStd[4], norm{mu,sd}, gen}
  function matvec(x, M, b) {
    var out = new Float32Array(b.length);
    for (var j = 0; j < b.length; j++) {
      var s = 0;
      for (var i = 0; i < x.length; i++) s += x[i] * M[i][j];
      out[j] = s + b[j];
    }
    return out;
  }
  function forward(obs) {   // → {m:[thr,turn,yaw,pitch], f:fireLogit, v:value}
    var inDim = W.W1.length;                        // 输入维（旧权重 70 / 新权重 92）
    if (obs.length > inDim) obs = obs.slice(0, inDim);   // 旧权重吃 92 维 obs：截回（过渡兼容）
    var x = new Float32Array(inDim), i;
    for (i = 0; i < obs.length; i++) x[i] = (obs[i] - W.norm.mu[i]) / W.norm.sd[i];
    var h1 = matvec(x, W.W1, W.b1);
    for (i = 0; i < h1.length; i++) if (h1[i] < 0) h1[i] = 0;
    var h2 = matvec(h1, W.W2, W.b2);
    for (i = 0; i < h2.length; i++) if (h2[i] < 0) h2[i] = 0;
    var out = matvec(h2, W.W3, W.b3);   // 6 维
    return { m: [out[0], out[1], out[2], out[3]], f: out[4], v: out[5] };
  }
  function gauss() {
    var u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }

  // 网络瞄准点：aimYaw(±1→±π 相对车体) × aimPitch(±1→±0.3rad) 反算世界点。
  // 与录制端互逆：录制标签 = aimTurretAt(点) 的方向/俯仰归一；执行端用同一公式还原点。
  function netAimPoint(tank, a2, a3, dist) {
    var horiz = Math.max(30, dist || 200);
    var wh = tank.heading + clamp1(a2) * Math.PI;
    var pitch = clamp1(a3) * 0.3;
    return { x: tank.position.x + Math.sin(wh) * horiz,
             y: tank.position.y + 2.0 + Math.tan(pitch) * horiz,
             z: tank.position.z + Math.cos(wh) * horiz };
  }

  // ---------- 权重加载：静态文件（评测/玩家）或 PPO 服务器拉模式（训练） ----------
  var stats = { bots: 0, thinking: 0, steps: 0, posts: 0, postErr: 0, kills: 0, hits: 0,
                taken: 0, deaths: 0, fires: 0, nav: 0, fallbacks: 0, gen: -1,
                stuckPen: 0, circlePen: 0, circleTrig: 0, assistFire: 0, netFire: 0,
                terrainHold: 0, smokeHold: 0, alignHold: 0, blockedHold: 0 };

  function loadStatic() {
    return fetch(new URL(WFILE, location.href).href).then(function (r) {
      if (!r.ok) throw new Error('rl7W http ' + r.status);
      return r.json();
    }).then(function (w) {
      W = w; stats.gen = w.gen;
      console.log('[RL7] static weights loaded: gen=' + w.gen);
    });
  }
  function pullWeights() {
    return fetch(SRV + '/weights').then(function (r) { return r.json(); }).then(function (w) {
      W = w; stats.gen = w.gen;
      console.log('[RL7] weights pulled: gen=' + w.gen + ' logStd=[' +
        w.logStd.map(function (x) { return x.toFixed(2); }).join(',') + ']');
    });
  }
  function startWeightSync() {
    if (WFILE) return loadStatic().catch(function (e) { console.warn('[RL7] static load failed:', e); });
    var boot = pullWeights().catch(function (e) {
      console.warn('[RL7] PPO server not ready, retry:', e);
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

  // ---------- 命中事件旁听（奖励归因）：同六代 ----------
  function hookEmClass(Cls) {
    if (!Cls || !Cls.prototype || Cls.prototype.__rl7Hooked) return;
    Cls.prototype.__rl7Hooked = true;
    var orig = Cls.prototype.checkCollisions;
    if (!orig) return;
    Cls.prototype.checkCollisions = function () {
      var hits = orig.apply(this, arguments);
      try { if (hits && hits.length) onHits(hits); } catch (e) { }
      return hits;
    };
    console.log('[RL7] EntityManager.checkCollisions hooked');
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
          if (h.killed) closeEpisode(tank, true);
          else { rec.pend -= 2; stats.taken++; }
        }
      });
    }
  }

  // ---------- 采样记录 ----------
  var pilots = new Map();
  var allRecs = [];
  var pendingSteps = 0;

  function newRec(tank) {
    tank.__pilotedBy = 'rl7';   // 跨脚本互斥：agent-bc / agent-rl 见此标记不重复接管
    var rec = {
      tank: tank, tid: winId + '-' + (++tidSeq), dead: false, pend: 0,
      applied: null, appliedAim: null, appliedFire: 0, firedSinceThink: false,
      nextObs: null, lastEnemies: [], lastObstacles: [],
      stuck: CORE.makeStuck(), tgt: null, prevD: null, prevTgt: null,
      trail: [],   // 绕圈检测窗：[{x,z,fired}]
      steps: { obs: [], act: [], logp: [], val: [], rew: [], done: [] }
    };
    pilots.set(tank, rec);
    allRecs.push(rec);
    return rec;
  }

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
  var gameRef = null;
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
        var boot = rec.nextObs;
        try {
          if (gameRef && rec.tank && rec.tank.alive) {
            boot = buildObs7(rec.tank, gameRef,
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
    fetch(SRV + '/rollout', { method: 'POST', body: JSON.stringify(pl) })
      .catch(function (e) { stats.postErr++; console.warn('[RL7] post failed:', e); });
  }

  // ---------- 接管坦克（第七代外壳：避让入壳 + 端到端瞄准开火） ----------
  function tankDist(a, b) { return Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z); }

  function pilotate(tank, game) {
    var origUpdate = tank.ai.update.bind(tank.ai);
    var lastThink = 0;
    var rec = newRec(tank);
    rec.origUpdate = origUpdate;
    stats.bots++;
    tank.ai.update = function rl7PilotUpdate(dt, ctx) {
      try {
        // —— 维护层：起火即灭 + 修车（与六代同款：修车仅蓝方；训练模式红方保留=实验环境不变） ——
        var noRepair = !TRAIN && SIDE !== 'both' && tank.team === 'red' && qs.get('rl7Fair') !== '0';
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

        var e0 = (rec.tgt && rec.tgt.alive) ? rec.tgt : rec.lastEnemies[0];
        if (!e0) {
          // 无敌可打：回退规则 AI（自带待机/巡逻）。修复 10-05 实战反馈「无敌原地转圈」——
          // 训练采样只在交战区、BC 锚也无此状态，网络对敌人槽全 0 的观测是纯外推（转向饱和）。
          // 训练=部署同款回退（训练时无敌=全灭将至局终，不采样，安全一致）
          stats.idleFallback = (stats.idleFallback || 0) + 1;
          return origUpdate(dt, ctx);
        }
        var dE = tankDist(tank, e0);

        // —— 卡墙脱困（最高优先级，驾驶脚本；触发瞬间撞障罚 -0.5；瞄准/开火仍网络） ——
        var thrIntent = rec.applied[0];   // 导航段也是网络油门（②采样扩展后 P 控制器退役）
        var wasU = rec.stuck.unstickT <= 0.01;
        var unsticking = rec.stuck.update(tank, thrIntent, dt);
        if (unsticking) {
          if (wasU) { rec.pend -= STUCK_PEN; stats.stuckPen++; }
          stats.unstick = (stats.unstick || 0) + 1;
          tank.drive(-1, rec.stuck.dir * 0.9, dt);
          engageAimFire(tank, rec, e0, dE, dt, ctx);
          return;
        }

        // —— 远距进场：网络驾驶（避让已折叠进 applied）+ 家教炮手。
        //    ②采样扩展：进场 60~100s 第一次成为可学习对象（接近奖/撞墙罚有地方落账）
        if (dE > NAV_DIST * 450) {
          tank.drive(rec.applied[0], rec.applied[1], dt);
          tank.aimTurretAt(CORE.gunAimPoint(tank, e0), dt);
          stats.nav++;
          return;
        }

        // —— 交战区 ——
        var ret = CORE.retreatCmd(tank, e0);
        if (ret) {
          stats.retreat = (stats.retreat || 0) + 1;   // 残血撤退：驾驶脚本，瞄准/开火仍网络
          tank.drive(ret.thr, ret.turn, dt);
        } else {
          var turnCmd = rec.applied[1];   // 已含避让折叠（think 内 avoidCmd），勿再叠
          // 稳炮：瞄准点差一点收敛 → 压一拍转向让炮塔跟上（B 变体：瞄准点=家教解，同五代六代）
          var nap = CORE.gunAimPoint(tank, e0);
          if (!CORE.barrelAligned(tank, nap, CORE.fireTol(dE)) && dE < 120 && tank.canFire()) {
            var aimOffQ = CORE.wrap2pi(Math.atan2(nap.x - tank.position.x, nap.z - tank.position.z)
              - tank.heading - (tank.turretYaw || 0));
            if (Math.abs(aimOffQ) < 0.35) { turnCmd *= 0.3; stats.steady = (stats.steady || 0) + 1; }
          }
          tank.drive(rec.applied[0], turnCmd, dt);
        }
        engageAimFire(tank, rec, e0, dE, dt, ctx);
      } catch (e) {
        stats.fallbacks++;
        if (!stats.errLogged) { stats.errLogged = 1; console.error('[RL7] pilot error:', e); }
        try { origUpdate(dt, ctx); } catch (e2) { }
      }
    };
  }

  // 交战区瞄准+开火（脱困/撤退/正常共用——训练=部署严格一致）：
  //   B 变体：瞄准 = 几何炮手（gunAimPoint，五代六代同款解析解）；开火 = 网络火头 ∪ 纪律兜底
  function engageAimFire(tank, rec, e0, dE, dt, ctx) {
    var nap = CORE.gunAimPoint(tank, e0);   // 家教解（提前量+下坠）；netAimPoint 仅无敌兜底用
    tank.aimTurretAt(nap, dt);
    if (!tank.canFire() || dE >= 240) return;
    // 物理门（环境约束，训练/部署同款，不是策略的一部分）：
    // 地形门查「敌人可达性」（gunAimPoint 敌参考点，与五/六代同口径）——不查网络瞄准点：
    // 早期网络瞄偏很正常，敌人可达时放行让 miss 自己教；只有敌人真在山后才硬拦
    var gap = CORE.gunAimPoint(tank, e0);
    var terrainHold = CORE.terrainLos(tank.position.x, tank.position.y + 1.8, tank.position.z,
                                      gap.x, gap.y, gap.z);
    if (terrainHold) stats.terrainHold++;
    var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], tank.position, e0.position);
    if (smokeB) stats.smokeHold++;
    var converged = CORE.barrelAligned(tank, nap, CORE.fireTol(dE));   // 炮口跟上网络指令了吗
    if (!converged) stats.alignHold++;
    var losN = CORE.blockedCount(rec.lastObstacles, tank.position.x, tank.position.z,
                                 e0.position.x, e0.position.z, 9);
    if (losN) stats.blockedHold++;
    var wantFire = rec.appliedFire === 1;
    if (wantFire && (terrainHold || smokeB || !converged || losN)) {   // 门径流向：哪道门在卡炮
      if (terrainHold) stats.blockTerrain = (stats.blockTerrain || 0) + 1;
      else if (!converged) stats.blockAlign = (stats.blockAlign || 0) + 1;
      else if (losN) stats.blockLos = (stats.blockLos || 0) + 1;
      else stats.blockSmoke = (stats.blockSmoke || 0) + 1;
    }
    // 纪律兜底仅评测/玩家模式开：训练时开火必须出自策略自己的选择——
    // 否则「策略采了 fire=0、环境替它开炮命中 +2」会把正优势推给 fire=0 样本，反向教学
    if (!TRAIN && !wantFire && ASSIST && converged) { wantFire = true; stats.assistWant = (stats.assistWant || 0) + 1; }
    if (wantFire && !terrainHold && !smokeB && converged && losN === 0) {
      if (tank.tryFire((ctx && ctx.entityManager) || gameRef.em)) {
        stats.fires++;
        if (rec.appliedFire === 1) stats.netFire++; else stats.assistFire++;
        rec.pend -= 0.05;
        rec.firedSinceThink = true;
      }
    }
  }

  // 10Hz 思考：奖励塑形（环带/接近/朝敌/绕圈）→ 结转 → 采样 5 维动作（交战区才记步）
  function think(tank, game, rec, ctx) {
    var em = (ctx && ctx.entityManager) || game.em;
    var obstacles = (ctx && ctx.obstacles) || (em && em.obstacles) || [];
    rec.lastEnemies = CORE.enemiesOf(tank, game);
    rec.lastObstacles = obstacles;
    // 目标认领（集火分散 + 近距威胁优先）
    var newTgt = CORE.pickTarget(tank, rec.lastEnemies, rec.tgt);
    // 近距威胁优先（2026-10-05 用户实战反馈：最近敌不打非打远的→被反杀）：
    // 最近敌 <150m 强制接管——集火分散/滞回只在中远距生效，近身的必须先解决
    if (rec.lastEnemies[0] && newTgt !== rec.lastEnemies[0] &&
        tankDist(tank, rec.lastEnemies[0]) < 150) {
      newTgt = rec.lastEnemies[0];
    }
    if (newTgt !== rec.tgt) { CORE.releaseTarget(tank, rec.tgt); CORE.claimTarget(tank, newTgt); rec.tgt = newTgt; }
    var e0 = rec.lastEnemies[0];
    var d = e0 ? tankDist(tank, e0) : 9999;
    var inEngage = e0 && d <= NAV_DIST * 450;   // 交战区
    var inNav = e0 && !inEngage;                // 导航段（有敌但远）：②采样扩展——进场 60~100s 变成可学习对象
    var sampled = inEngage || inNav;            // 记步段（无敌=回退规则 AI 待机，不采）

    if (inEngage) {
      // ① 出环带罚（只计交战段，照旧）
      if (d > BAND_HI || d < BAND_LO) rec.pend -= 0.01;

      // ③ 朝敌奖（+0.003×max(0,cos)）：车头指向最近敌（治绕圈·正向引导）
      var dxE = e0.position.x - tank.position.x, dzE = e0.position.z - tank.position.z;
      var distE = Math.hypot(dxE, dzE) || 1;
      var cosB = (dxE * Math.sin(tank.heading) + dzE * Math.cos(tank.heading)) / distE;
      if (cosB > 0) rec.pend += FACE_K * cosB;

      // ⑤ 瞄准蒸馏塑形（A'）：|网络瞄准 − 几何炮手解|（归一化域，yaw 带 wrap 处理）每步小额罚。
      //    几何炮手解=打当前认领目标的最优瞄准（含提前量+下坠补偿）——比录制标签还好的老师。
      if (rec.tgt && rec.tgt.alive && rec.appliedAim) {
        var apT = CORE.gunAimPoint(tank, rec.tgt);
        var ty = CORE.wrap2pi(Math.atan2(apT.x - tank.position.x, apT.z - tank.position.z) - tank.heading) / Math.PI;
        var tp = Math.atan2(apT.y - (tank.position.y + 1.8),
                            Math.hypot(apT.x - tank.position.x, apT.z - tank.position.z) || 1) / 0.3;
        var dyA = rec.appliedAim[0] - ty;
        var eyA = Math.min(Math.abs(dyA), 2 - Math.abs(dyA));   // yaw 跨 ±π wrap
        var epA = Math.abs(rec.appliedAim[1] - Math.max(-1, Math.min(1, tp)));
        rec.pend -= AIM_K * (eyA + epA);
        stats.aimErrSum = (stats.aimErrSum || 0) + eyA + epA;
        stats.aimErrN = (stats.aimErrN || 0) + 1;
      }

      // ④ 绕圈罚（-0.03/步）：4s 滑动窗，里程>15m 且净位移比<0.3 且窗口内未开火
      rec.trail.push({ x: tank.position.x, z: tank.position.z, fired: rec.firedSinceThink });
      if (rec.trail.length > TRAIL_N) rec.trail.shift();
      rec.firedSinceThink = false;
      if (rec.trail.length === TRAIL_N) {
        var pathLen = 0, firedAny = false, i2;
        for (i2 = 1; i2 < TRAIL_N; i2++) {
          pathLen += Math.hypot(rec.trail[i2].x - rec.trail[i2 - 1].x, rec.trail[i2].z - rec.trail[i2 - 1].z);
          if (rec.trail[i2].fired) firedAny = true;
        }
        if (rec.trail[0].fired) firedAny = true;
        var netDist = Math.hypot(rec.trail[TRAIL_N - 1].x - rec.trail[0].x,
                                 rec.trail[TRAIL_N - 1].z - rec.trail[0].z);
        if (!firedAny && pathLen > TRAIL_PATH_MIN && netDist / pathLen < TRAIL_RATIO) {
          rec.pend -= CIRCLE_PEN;
          stats.circlePen++;
          stats.circleTrig++;
        }
      }
    } else {
      rec.trail.length = 0;   // 离开交战区清窗（导航段不算绕圈账）
    }

    // ② 干净接近奖（+0.01×Δdist/10）：导航段+交战段都发（导航段是它最大的用武之地）
    if (sampled) {
      if (rec.tgt !== rec.prevTgt) { rec.prevD = null; rec.prevTgt = rec.tgt; }   // 换目标重置（防虚增）
      if (rec.prevD !== null && rec.tgt && rec.tgt.alive) {
        var dd2 = Math.max(-APPROACH_CAP, Math.min(APPROACH_CAP, rec.prevD - d));
        rec.pend += APPROACH_K * dd2;
      }
      rec.prevD = (rec.tgt && rec.tgt.alive) ? d : null;

      // ⑥ 接近罚（−0.012×(1−d/15)²/步）：正对障碍（cos>0.7）且 <15m——撞墙的前置信号，
      //    错误发生瞬间扣钱（脱困罚 −0.5 是追认式，追不上连环触发；此罚梯度直达）
      var proxWorst = 0, fwdX = Math.sin(tank.heading), fwdZ = Math.cos(tank.heading);
      for (var obi = 0; obi < obstacles.length; obi++) {
        var obP = obstacles[obi];
        if (!obP || !obP.position) continue;
        var pdx = obP.position.x - tank.position.x, pdz = obP.position.z - tank.position.z;
        if (pdx > 15 || pdx < -15 || pdz > 15 || pdz < -15) continue;   // 快筛
        var pdd = Math.hypot(pdx, pdz);
        if (pdd >= 15) continue;
        if ((pdx * fwdX + pdz * fwdZ) / (pdd || 1) < 0.7) continue;     // 只算正前方锥
        var prox = 1 - pdd / 15;
        var pen2 = PROX_K * prox * prox;
        if (pen2 > proxWorst) proxWorst = pen2;
      }
      if (proxWorst > 0) { rec.pend -= proxWorst; stats.proxPen = (stats.proxPen || 0) + 1; }
    }

    // 结转：上一区间事件奖励归上一动作（导航段也结转——撞墙罚/接近奖终于有地方落账）
    var n = rec.steps.obs.length;
    if (n > 0 && sampled) { rec.steps.rew[n - 1] += rec.pend; }
    rec.pend = 0;

    var obs = buildObs7(tank, game, rec.lastEnemies, obstacles);   // 92 维感知扩容
    var out = forward(obs);
    stats.thinking++;

    var a0, a1, a2, a3, fire, logp = 0;
    var s0 = Math.exp(W.logStd[0]), s1 = Math.exp(W.logStd[1]),
        s2 = Math.exp(W.logStd[2]), s3 = Math.exp(W.logStd[3]);
    var z2 = 0, z3 = 0;
    if (TRAIN) {
      var z0 = gauss(), z1 = gauss(); z2 = gauss(); z3 = gauss();
      a0 = out.m[0] + s0 * z0; a1 = out.m[1] + s1 * z1;
      a2 = out.m[2] + s2 * z2; a3 = out.m[3] + s3 * z3;
      // fire 伯努利采样（对数尺度温度，与服务器 logp 同口径）
      var p = 1 / (1 + Math.exp(-(FIRE_TA * out.f + FIRE_TB)));
      p = Math.min(1 - 1e-6, Math.max(1e-6, p));
      fire = Math.random() < p ? 1 : 0;
      logp += fire ? Math.log(p) : Math.log(1 - p);
    } else {
      a0 = out.m[0]; a1 = out.m[1]; a2 = out.m[2]; a3 = out.m[3];   // 评测/玩家：确定均值
      fire = out.f > 0 ? 1 : 0;                                      // sigmoid>0.5
    }
    // ① 避让折叠：执行值 = 采样值经 avoidCmd（连续转向场）——策略从此「看见」避让层，
    //    PPO 学会与它配合直至内化（收敛后避让推力趋零）。执行值参与 logp（aim/fire 维用原采样）。
    var avF = CORE.avoidCmd(tank, obstacles, clamp1(a1), clamp1(a0), 0.6);   // 0.6=侧向排斥（治瞻前不顾后）
    var eThr = avF.thr, eTurn = avF.turn;
    if (TRAIN) {
      var z0e = (eThr - out.m[0]) / s0, z1e = (eTurn - out.m[1]) / s1;
      logp = (-0.5 * z0e * z0e - W.logStd[0] - HALF_LOG_2PI) +
             (-0.5 * z1e * z1e - W.logStd[1] - HALF_LOG_2PI) +
             (-0.5 * z2 * z2 - W.logStd[2] - HALF_LOG_2PI) +
             (-0.5 * z3 * z3 - W.logStd[3] - HALF_LOG_2PI) + logp;
    }
    rec.applied = [eThr, eTurn];        // update 循环直接执行（避让已折叠，勿再叠）
    rec.appliedAim = [clamp1(a2), clamp1(a3)];
    rec.appliedFire = fire;

    if (TRAIN && sampled) {
      // 记步：obs=动作前状态（因果配对）；act=[执行值 thr/turn + 原始采样 aim/fire]（与 logp 一致）
      rec.steps.obs.push(obs);
      rec.steps.act.push([eThr, eTurn, a2, a3, fire]);
      rec.steps.logp.push(logp);
      rec.steps.val.push(out.v);
      rec.steps.rew.push(0);
      rec.steps.done.push(0);
      rec.nextObs = obs;
      stats.steps++;
      pendingSteps++;
      if (pendingSteps >= POST_EVERY) postNow(false);
      if (DUMP && stats.steps <= 20)
        console.log('[RL7DUMP] d=' + d.toFixed(0) + ' m=[' + out.m[0].toFixed(2) + ',' + out.m[1].toFixed(2) +
          '] exec=[' + eThr.toFixed(2) + ',' + eTurn.toFixed(2) + '] v=' + out.v.toFixed(2));
    }
  }

  // ---------- Q 代打·第七代（2026-10-05 用户要求：Q 换七代 B 大脑，默认）----------
  // wt_qgen: '5'→第五代(agent-bc) / '6'→第六代(agent-rl) / '7'→第七代B(本文件,默认)
  // 执行壳与 bot 模式严格同款（B 变体）：维护 + P控进场(带避让) + 脱困/撤退脚本 +
  //   家教瞄准（gunAimPoint）+ 开火 = 网络火头(确定性 f>0) ∪ 纪律兜底，物理门同款
  function qGenIs7() {
    var q = qs.get('qGen');
    if (q === '7') return true;
    if (q === '5' || q === '6') return false;
    try { var g = localStorage.getItem('wt_qgen'); return g !== '5' && g !== '6'; } catch (e) { return true; }
  }
  function startQCopilot7() {
    setInterval(function () {
      try {
        var g = window.__game;
        if (!g || !g._pilotAI) return;
        var ai = g._pilotAI;
        if (ai.__rl7q !== undefined) return;             // 已处理（接管/让位/跳过）
        if (!ai.tank) { ai.__rl7q = 'skip'; return; }    // 飞机/直升机：仍用原版
        if (!qGenIs7()) { ai.__rl7q = 'other'; return; } // 五/六代模式：让位
        ai.__rl7q = true;
        var t = ai.tank;
        var origUpdate = ai.update.bind(ai);
        var lastThink = 0, applied = null, appliedFire = 0, lastEnemies = [], lastObstacles = [];
        var qStuck = CORE.makeStuck(), qTgt = null;
        var q = { fires: 0, thinks: 0, fallbacks: 0 };
        if (!W) {   // 懒加载静态权重（玩家版同源 training/rl7-weights.json = B 变体最新）
          fetch(new URL('training/rl7-weights.json', location.href).href).then(function (r) { return r.json(); })
            .then(function (w) { W = w; console.log('[RL7] Q 代打权重就位: gen', w.gen); })
            .catch(function (e) { console.warn('[RL7] Q 代打权重加载失败，暂用原版:', e); });
        }
        ai.update = function rl7QUpdate(dt, ctx) {
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
              var obs = buildObs7(t, g, lastEnemies, lastObstacles);   // 92 维感知扩容
              var out = forward(obs);                       // 确定性均值
              // 避让折叠（与训练壳同款：10Hz think 内算执行值，帧间直接执行）
              var avT = CORE.avoidCmd(t, lastObstacles, clamp1(out.m[1]), clamp1(out.m[0]), 0.6);   // 侧向排斥同款
              applied = [avT.thr, avT.turn];
              appliedFire = out.f > 0 ? 1 : 0;              // 不带温度（保守），兜底会补
              q.thinks++;
              var newTgt = CORE.pickTarget(t, lastEnemies, qTgt);
              // 近距威胁优先（同 bot 模式：最近敌 <150m 强制接管，治"打远不打近被反杀"）
              if (lastEnemies[0] && newTgt !== lastEnemies[0] &&
                  Math.hypot(lastEnemies[0].position.x - t.position.x,
                             lastEnemies[0].position.z - t.position.z) < 150) {
                newTgt = lastEnemies[0];
              }
              if (newTgt !== qTgt) { CORE.releaseTarget(t, qTgt); CORE.claimTarget(t, newTgt); qTgt = newTgt; }
            }
            if (!applied) return origUpdate(dt, ctx);
            if (!t.alive) return;
            var e0 = (qTgt && qTgt.alive) ? qTgt : lastEnemies[0];
            ai.phase = '七代交战中';
            if (e0) {
              var d = Math.hypot(e0.position.x - t.position.x, e0.position.z - t.position.z);
              var thrIntent = d > NAV_DIST * 450 ? 1 : applied[0];
              if (qStuck.update(t, thrIntent, dt)) {
                q.unstick = (q.unstick || 0) + 1;
                ai.phase = '七代脱困';
                t.drive(-1, qStuck.dir * 0.9, dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                return;
              }
              if (d > NAV_DIST * 450) {
                // 网络驾驶进场（与训练壳一致：②采样扩展后 P 控制器退役；applied 已含避让折叠）
                t.drive(applied[0], applied[1], dt);
                t.aimTurretAt(CORE.gunAimPoint(t, e0), dt);
                ai.phase = '七代进场';
                return;
              }
              var ap = CORE.gunAimPoint(t, e0);   // B 变体：家教瞄准
              var converged = CORE.barrelAligned(t, ap, CORE.fireTol(d));
              var ret = CORE.retreatCmd(t, e0);
              if (ret) {
                ai.phase = '七代撤退';
                q.retreat = (q.retreat || 0) + 1;
                t.drive(ret.thr, ret.turn, dt);
              } else {
                var turnCmd = applied[1];   // 已含避让折叠（think 内），勿再叠
                if (!converged && d < 120 && t.canFire()) {
                  var aimOffQ = CORE.wrap2pi(Math.atan2(ap.x - t.position.x, ap.z - t.position.z)
                    - t.heading - (t.turretYaw || 0));
                  if (Math.abs(aimOffQ) < 0.35) turnCmd *= 0.3;
                }
                t.drive(applied[0], turnCmd, dt);
              }
              t.aimTurretAt(ap, dt);
              // 开火：网络火头 ∪ 纪律兜底（Q 模式永远开兜底），物理门同款
              if (t.canFire() && d < 240) {
                var terrainHold = CORE.terrainLos(t.position.x, t.position.y + 1.8, t.position.z,
                                                  ap.x, ap.y, ap.z);
                var smokeB = CORE.smokeBlind((ctx && ctx.smokes) || [], t.position, e0.position);
                var losN = CORE.blockedCount(lastObstacles, t.position.x, t.position.z,
                                             e0.position.x, e0.position.z, 9);
                var wantFire = appliedFire === 1 || (ASSIST && converged);
                if (wantFire && !terrainHold && !smokeB && converged && losN === 0) {
                  if (t.tryFire((ctx && ctx.entityManager) || g.em)) {
                    q.fires++;
                    if (appliedFire === 1) q.netFire = (q.netFire || 0) + 1;
                  }
                }
              }
            } else {
              // 无敌可打：回退规则 AI 待机（同 bot 模式，修「无敌原地转圈」）
              return origUpdate(dt, ctx);
            }
          } catch (e) {
            q.fallbacks++;
            if (!q.errLogged) { q.errLogged = 1; console.error('[RL7] Q-copilot error:', e); }
            try { origUpdate(dt, ctx); } catch (e2) { }
          }
        };
        console.log('[RL7] Q 代打已换装第七代 B 大脑（确定性；wt_qgen=5/6 可切回五/六代）');
      } catch (e) { /* 轮询永不炸 */ }
    }, 200);
  }

  // ---------- 徽标 / API ----------
  function badge(txt) {
    var el = document.getElementById('__rl7Badge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__rl7Badge';
      el.style.cssText = 'position:fixed;left:12px;top:140px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#fd6;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #a84;';   // 五代蓝/六代紫/公平金之下排
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = txt;
  }
  function badgeText() {
    return (W ? '🚀 第七代[' + (SIDE === 'ally' ? '队友' : SIDE === 'both' ? '双方' : '敌方') + '] gen' + stats.gen +
      (TRAIN ? ' σ' + Math.exp(W.logStd[0]).toFixed(2) : ' 确定性') :
      '🚀 七代 等权重…') +
      ' · ' + stats.bots + ' bots · ' + stats.steps + ' steps · 🎯' + stats.kills + '/' + stats.hits +
      ' · ☠' + stats.deaths + ' · 🔥' + stats.fires +
      (stats.circleTrig ? ' · 🔄' + stats.circleTrig : '') +
      (stats.stuckPen ? ' · 🧱' + stats.stuckPen : '') +
      (stats.fallbacks ? ' · ⚠' + stats.fallbacks : '');
  }

  window.__RL7API = { stats: stats, postNow: function () { postNow(false); } };
  startQCopilot7();   // Q 代打·第七代（默认；与 agent-bc 五代/agent-rl 六代互补让位）

  // ---------- 主流程 ----------
  var liveSide = VIAURL ? SIDE : null;   // URL 模式冻结；localStorage 模式由守望器热切
  var booted = false;
  function boot() {
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
              if (t.__pilotedBy && t.__pilotedBy !== 'rl7') continue;   // bc/rl 先到先得（跨脚本互斥）
              var want = (liveSide === 'enemy' && t.team === 'red') ||
                         (liveSide === 'ally' && t.side === 'ally') ||
                         (liveSide === 'both' && (t.team === 'red' || t.side === 'ally'));
              if (want) { SIDE = liveSide; pilotate(t, g); }
            }
          } else if (g.state === 'over') {
            closeAll(true);
            if (TRAIN && Date.now() - lastPost > 3000) { lastPost = Date.now(); postNow(false); }
          }
          pilots.forEach(function (rec, tank) { if (!tank.alive) closeEpisode(tank, true); });
          if (TRAIN && Date.now() - lastPost > POST_MS) { lastPost = Date.now(); postNow(false); }
          badge(badgeText());
        } catch (e) { /* 轮询永不炸 */ }
      }, 500);
      setInterval(function () { if (liveSide || TRAIN) console.log('[RL7] stats:', JSON.stringify(stats)); }, 20000);
    });
  }
  // —— 热切换守望（模块级）：出战页「🚀 第七代人机」写 localStorage，0.5s 生效免刷新 ——
  setInterval(function () {
    try {
      var v = '0'; try { v = localStorage.getItem('wt_rl7') || '0'; } catch (e) { }
      var want = (v === 'enemy' || v === 'ally' || v === 'both') ? v : null;
      if (VIAURL) return;
      if (want !== liveSide) {
        liveSide = want;
        console.log('[RL7] 热切换 →', want || '关闭');
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
        if (t.__pilotedBy === 'rl7') t.__pilotedBy = null;
      }
    } catch (e) { }
  }
  if (VIAURL) boot();
  window.addEventListener('beforeunload', function () { closeAll(true); postNow(true); });
})();
