// agent-core.js — 智能体共享核心：观测构造（obs 70 维）+ 工具
// 录制（agent-recorder.js）与推理（agent-bc.js）共用同一实现，保证 obs 语义逐位一致。
// 纯函数、零依赖、不激活任何逻辑——只是把工具挂到 window.__WTA 上。
(function () {
  'use strict';

  function wrap2pi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  var OBS_DIM = 70;   // 16(自身) + 3×11(最近敌) + 6×3(最近障碍) + 3(上下文)

  // 按距离排序的存活敌车（对该 tank 而言的敌对方）
  function enemiesOf(tank, game) {
    var myTeam = tank.team;
    var list = [];
    var pool = (game.em && game.em.tanks) || [];
    for (var i = 0; i < pool.length; i++) {
      var t = pool[i];
      if (t === tank || !t.alive || t.netGhost) continue;
      if (t.team === myTeam) continue;
      list.push(t);
    }
    list.sort(function (a, b) {
      var da = (a.position.x - tank.position.x) ** 2 + (a.position.z - tank.position.z) ** 2;
      var db = (b.position.x - tank.position.x) ** 2 + (b.position.z - tank.position.z) ** 2;
      return da - db;
    });
    return list;
  }

  // 点到线段距离 < r 的障碍计数（近似 LOS 遮挡，2D）
  function blockedCount(obstacles, ax, az, bx, bz, cap) {
    var n = 0, dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
    for (var i = 0; i < obstacles.length && n < cap; i++) {
      var ob = obstacles[i];
      if (!ob || !ob.position) continue;
      var t2 = len2 > 1e-6 ? ((ob.position.x - ax) * dx + (ob.position.z - az) * dz) / len2 : 0;
      t2 = clamp01(t2);
      var px = ax + dx * t2, pz = az + dz * t2;
      var r = (ob.radius || 3) + 1.2;   // +坦克半径近似
      if ((ob.position.x - px) ** 2 + (ob.position.z - pz) ** 2 < r * r) n++;
    }
    return n;
  }

  function buildObs(tank, game, enemies, obstacles) {
    var o = new Array(OBS_DIM).fill(0);
    var k = 0, i, e;
    var ws = tank.worldSize || 900;
    var pos = tank.position;

    // — 自身 16 —
    var h = tank.heading, tw = h + (tank.turretYaw || 0);
    o[k++] = Math.sin(h); o[k++] = Math.cos(h);
    o[k++] = Math.sin(tw); o[k++] = Math.cos(tw);
    o[k++] = (tank.barrelPitch || 0) / 0.35;
    o[k++] = tank.health / tank.maxHealth;
    o[k++] = clamp01((tank.reloadTimer || 0) / (tank.reloadTime || 3));
    o[k++] = (tank.canFire && tank.canFire()) ? 1 : 0;
    var ms = Math.max(1, tank.maxSpeed || 12);
    var vx = (tank.velX || 0) / ms, vz = (tank.velZ || 0) / ms;
    o[k++] = vx * Math.sin(h) + vz * Math.cos(h);            // 本体系：前进分量（forward=(sin h, cos h)）
    o[k++] = vx * Math.cos(h) - vz * Math.sin(h);            // 本体系：右移分量（right=(cos h, -sin h)）
    o[k++] = pos.x / ws; o[k++] = pos.z / ws;
    var m = tank.modules || {};
    o[k++] = m.track > 0 ? 1 : 0; o[k++] = m.barrel > 0 ? 1 : 0; o[k++] = m.engine > 0 ? 1 : 0;
    o[k++] = tank.burning ? 1 : 0;

    // — 最近 3 敌 ×11 —
    for (i = 0; i < 3; i++) {
      e = enemies[i];
      if (!e) { k += 11; continue; }
      var dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      var dist = Math.hypot(dx, dz);
      var brg = wrap2pi(Math.atan2(dx, dz) - h);             // 相对本体系方位
      o[k++] = Math.min(1, dist / 450);
      o[k++] = Math.sin(brg); o[k++] = Math.cos(brg);
      var evx = (e.velX || 0) / 16, evz = (e.velZ || 0) / 16;
      o[k++] = evx * Math.sin(h) + evz * Math.cos(h);        // 敌速度：本体系前进分量
      o[k++] = evx * Math.cos(h) - evz * Math.sin(h);        // 敌速度：本体系右移分量
      var etw = (e.heading || 0) + (e.turretYaw || 0);
      o[k++] = Math.sin(etw); o[k++] = Math.cos(etw);
      o[k++] = e.health / e.maxHealth;
      o[k++] = 1;                                              // 存在位（空位为 0）
      o[k++] = Math.min(1, (e.pen || 60) / 500);
      o[k++] = Math.min(1, ((e.armor && e.armor[0]) || 30) / 200);
    }

    // — 最近 6 障碍 ×3 —
    var obs = [];
    for (i = 0; i < obstacles.length; i++) {
      var ob = obstacles[i];
      if (!ob || !ob.position) continue;
      obs.push(ob);
    }
    obs.sort(function (a, b) {
      var da = (a.position.x - pos.x) ** 2 + (a.position.z - pos.z) ** 2;
      var db = (b.position.x - pos.x) ** 2 + (b.position.z - pos.z) ** 2;
      return da - db;
    });
    for (i = 0; i < 6; i++) {
      ob = obs[i];
      if (!ob) { k += 3; continue; }
      var odx = ob.position.x - pos.x, odz = ob.position.z - pos.z;
      o[k++] = Math.min(1, Math.hypot(odx, odz) / 60);
      var obr = wrap2pi(Math.atan2(odx, odz) - h);
      o[k++] = Math.sin(obr); o[k++] = Math.cos(obr);
    }

    // — 上下文 3 —
    o[k++] = Math.min(1, (ws - Math.max(Math.abs(pos.x), Math.abs(pos.z))) / ws);   // 边界余量
    if (enemies[0]) {
      o[k++] = Math.min(1, blockedCount(obstacles, pos.x, pos.z,
        enemies[0].position.x, enemies[0].position.z, 5) / 5);                       // 最近敌 LOS 遮挡
    } else k++;
    o[k++] = Math.min(1, (game.matchT || 0) / 300);
    return o;
  }

  // 手写 MLP 前向工厂（与 bc_train.py 网络严格一致）：权重 json → forward(obs)→[thr,turn,yaw,pitch,fireP]
  function makeMLP(W) {
    function matvec(x, M, b) {
      var out = new Float32Array(b.length);
      for (var j = 0; j < b.length; j++) {
        var s = 0;
        for (var i = 0; i < x.length; i++) s += x[i] * M[i][j];
        out[j] = s + b[j];
      }
      return out;
    }
    return function (obs) {
      var x = new Float32Array(obs.length), i;
      for (i = 0; i < obs.length; i++) x[i] = (obs[i] - W.norm.mu[i]) / W.norm.sd[i];
      var h1 = matvec(x, W.W1, W.b1);
      for (i = 0; i < h1.length; i++) if (h1[i] < 0) h1[i] = 0;
      var h2 = matvec(h1, W.W2, W.b2);
      for (i = 0; i < h2.length; i++) if (h2[i] < 0) h2[i] = 0;
      var out = matvec(h2, W.W3, W.b3);
      return [Math.tanh(out[0]), Math.tanh(out[1]), Math.tanh(out[2]), Math.tanh(out[3]),
              1 / (1 + Math.exp(-out[4]))];
    };
  }

  // 精确炮手瞄准点（与 main.js TankAI 同款语义）：
  //   地面目标提前量（用目标实测速度 velX/velZ，迭代 2 次解拦截）+ 弹道下坠补偿。
  //   AI 车不走玩家输入路径，_dropAngle 自动补偿不生效 → 必须像 TankAI 一样手动抬角。
  //   弹速 = CONFIG.tank.shellSpeed(750) × vMul（ap 1.0 / apcr 1.22 / he 0.82）。
  var SHELL_VS = { ap: 750, apcr: 915, he: 615 };
  function gunAimPoint(tank, e) {
    var spd = SHELL_VS[tank.shellKind] || 750;
    var tvx = e.velX || 0, tvz = e.velZ || 0;
    var ax = e.position.x, az = e.position.z;
    for (var i = 0; i < 2; i++) {
      var fly = Math.hypot(ax - tank.position.x, az - tank.position.z) / spd;
      ax = e.position.x + tvx * fly;
      az = e.position.z + tvz * fly;
    }
    var d0 = Math.hypot(e.position.x - tank.position.x, e.position.z - tank.position.z);
    return { x: ax, y: e.position.y + 1.2 + 0.5 * 9.81 * Math.pow(d0 / spd, 2), z: az };
  }

  // —— 地形视线检查（2026-10-04：修"朝山坡打浪费弹药"）——
  // 障碍物 LOS 只查房子/岩石，查不到地形起伏——敌人在坡下时弹道被山坡吃掉。
  // 做法：炮口→瞄准点线段采样 8 点，任一点地形高度（+0.4m 余量）高过弹道线 → 挡。
  // terrainHeight 来自 lib.js（动态 import 同一模块实例，terrainMode/Scale 状态与 main.js 同步）；
  // lib 未就绪或地图平坦时按"不挡"处理（与旧版行为一致，绝不因它停火卡死）。
  var _libTH = null, _libTries = 0;
  function tryLib() {   // 偶发 import 失败（加载期连接被掐）→ 重试最多 5 次。
    // ⚠️ 必须【同 URL】重试，绝不能加 cache-buster 之类改 URL 的参数——
    // lib.js 的 terrainMode/terrainScale 是模块级状态，URL 不同=另一个实例=没被 main.js 设置过，
    // terrainHeight 会用默认地形参数算高度 → 地形 LOS 大量误拦开火（2026-10-05 五/六代集体
    // 变慢 2.6 倍事故：202s→520s，教训同踩坑#12「同一模块实例」）。
    // 失败的动态 import 不会被 memoize，同 URL 重试会重新 fetch。
    if (_libTH || _libTries >= 5) return;
    _libTries++;
    try {
      import(new URL('js/lib.js', location.href).href).then(function (m) {
        _libTH = m.terrainHeight;
      }).catch(function (e) {
        console.warn('[WTA] lib.js import 失败(第' + _libTries + '次)，稍后重试:', e && e.message);
        setTimeout(tryLib, 2000);
      });
    } catch (e) { /* 老环境不支持动态 import：静默降级 */ }
  }
  tryLib();
  function terrainLos(x0, y0, z0, x1, y1, z1) {
    if (!_libTH) return false;
    for (var i = 1; i <= 8; i++) {
      var t = i / 9;
      if (_libTH(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) + 0.4 > y0 + (y1 - y0) * t) return true;
    }
    return false;
  }

  // —— 3D 开火收敛门（2026-10-04：修"行进间射击不稳"）——
  // 旧门只查水平角（yaw）：车体摆动炮塔追不上、悬挂颠簸炮管俯仰晃，yaw 过门照样打飞。
  // 新门查炮管真实指向（getBarrelDir，含俯仰/炮塔世界朝向）与瞄准点（含提前量）的
  // 全角度夹角 < tol（0.04rad≈2.3°，比规则 AI 的 0.045 更紧一点补 BC 摆动）。
  // 方法不可用时返回 true（不拦火，绝不因它停摆）。
  function barrelAligned(tank, aimPt, tol) {
    try {
      var m = tank.getMuzzleWorld();
      var d = tank.getBarrelDir();
      var tx = aimPt.x - m.x, ty = aimPt.y - m.y, tz = aimPt.z - m.z;
      var tl = Math.hypot(tx, ty, tz) || 1;
      var dl = Math.hypot(d.x, d.y, d.z) || 1;
      var dot = (d.x * tx + d.y * ty + d.z * tz) / (dl * tl);
      return Math.acos(Math.max(-1, Math.min(1, dot))) < (tol || 0.04);
    } catch (e) { return true; }
  }

  // 距离自适应开火容差（2026-10-04：修"近战憋炮闷头冲"）——
  // 固定 0.04rad 在 22~46m 环带缠斗里几乎永不收敛（车体一直绕），开火率掉 3~4 倍。
  // 物理上命中球半径≈3.4m：30m 偏 0.07rad 弹着也只挪 2m，照样中。
  // 近距放宽（22m→0.10）、远距收紧保精度（≥100m→0.035 底线）。
  function fireTol(dist) {
    return Math.min(0.12, Math.max(0.035, Math.atan(2.2 / Math.max(10, dist))));
  }

  // ======== 规则 AI 三手绝活搬进外壳（2026-10-04 11:30）：脱困 / 撤退 / 烟幕 + 集火分散 =======

  // ① 卡墙脱困跟踪器（规则 AI 同款参数）：2.5s 挪不动且在给油 → 倒车打满舵 1.2s
  function makeStuck() {
    return {
      t: 0, unstickT: 0, dir: 1, lx: null, lz: null,
      // 每帧调用；返回 true = 正在脱困（本帧驾驶由它接管）
      update: function (tank, throttle, dt) {
        this.t += dt;
        if (this.t > 2.5) {
          var moved = this.lx == null ? 99 : Math.hypot(tank.position.x - this.lx, tank.position.z - this.lz);
          if (moved < 1.5 && Math.abs(throttle) > 0.3) {
            this.unstickT = 1.2; this.dir = Math.random() < 0.5 ? 1 : -1;
          }
          this.t = 0; this.lx = tank.position.x; this.lz = tank.position.z;
        }
        if (this.unstickT > 0) { this.unstickT -= dt; return true; }
        return false;
      }
    };
  }

  // ② 残血撤退指令（规则 AI 同款阈值 33%）：背对拉开车距、车头保持朝敌、炮口继续输出
  function retreatCmd(tank, enemy) {
    if (tank.health / tank.maxHealth >= 0.33) return null;
    var dx = enemy.position.x - tank.position.x, dz = enemy.position.z - tank.position.z;
    var hd = wrap2pi(Math.atan2(dx, dz) - tank.heading);   // 车头朝敌误差
    return { thr: -0.75, turn: Math.max(-1, Math.min(1, hd * 2)) };   // 倒车+车头对敌
  }

  // ③ 烟幕纪律（规则 AI 同款）：目标或自己在烟里 → 不开火（看不清别浪费炮弹）
  function smokeBlind(smokes, aPos, bPos) {
    if (!smokes || !smokes.length) return false;
    for (var i = 0; i < smokes.length; i++) {
      var s = smokes[i]; if (!s || !s.pos) continue;
      var r2 = (s.r || 10) * (s.r || 10);
      if ((s.pos.x - aPos.x) ** 2 + (s.pos.z - aPos.z) ** 2 < r2) return true;
      if ((s.pos.x - bPos.x) ** 2 + (s.pos.z - bPos.z) ** 2 < r2) return true;
    }
    return false;
  }

  // ④ 集火分散（超过规则 AI 的一步）：同队 bot 各选各的目标——
  // 评分 = 距离 + 250m×已被队友锁定数（别人打的不抢，除非近得多）；带 100m 滞回防抖动。
  // 注册表 window 级共享（bc/rl/Q 代打同页互通）；obs 仍用最近 3 敌（与训练数据语义一致）。
  var targetReg = new Map();   // enemy 对象 -> 锁定它的 pilot tank Set（死了自动被清）
  function _pruneReg() {
    targetReg.forEach(function (set, e) {
      if (!e.alive) { targetReg.delete(e); return; }
      set.forEach(function (p) { if (!p.alive) set.delete(p); });
      if (!set.size) targetReg.delete(e);
    });
  }
  function claimTarget(pilot, e) {
    if (!e) return;
    if (!targetReg.has(e)) targetReg.set(e, new Set());
    targetReg.get(e).add(pilot);
  }
  function releaseTarget(pilot, e) {
    var set = e && targetReg.get(e);
    if (set) { set.delete(pilot); if (!set.size) targetReg.delete(e); }
  }
  function pickTarget(tank, enemies, cur) {
    if (!enemies.length) return null;
    _pruneReg();
    var best = null, bestScore = Infinity;
    for (var i = 0; i < Math.min(3, enemies.length); i++) {
      var e = enemies[i];
      var d = Math.hypot(e.position.x - tank.position.x, e.position.z - tank.position.z);
      var n = (targetReg.get(e) || new Set()).size;
      if (cur === e) n = Math.max(0, n - 1);   // 评估时不算自己
      var score = d + 250 * n;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    // 滞回：当前目标还活着且没差太多就继续打（换目标有炮塔转向成本）
    if (cur && cur.alive && enemies.indexOf(cur) < 3) {
      var setCur = targetReg.get(cur);
      var nCur = Math.max(0, (setCur ? setCur.size : 0) - 1);
      var dCur = Math.hypot(cur.position.x - tank.position.x, cur.position.z - tank.position.z);
      if (dCur + 250 * nCur < bestScore + 100) best = cur;
    }
    return best;
  }

  // —— 前方障碍几何避让 v2/v3（v2=2026-10-04 连续转向场；v3=10-06 城市强化，七代专用）——
  // v3（传 urban=true 启用，五/六代不传=v2 行为冻结不变）：①预警分级（大障碍 45m 提前发现）；
  // ②建筑权重更高（半径>8m 危险×1.4）；③缝宽判断——前方两侧近障缝 <8m（车宽 3.5×2.2）
  // 不钻缝，全力绕宽侧+狠减速；④紧急贴墙（overlap>0.7）减速 35%→70%。
  // sideKick：侧向排斥（七代专用，绕路时防蹭侧面；五/六代不传=行为不变）。
  function avoidCmd(tank, obstacles, turnIn, thrIn, sideKick, urban) {
    var thr = (thrIn === undefined ? 0 : thrIn);
    var turn = turnIn || 0;
    if (!obstacles || !obstacles.length) return { turn: Math.max(-1, Math.min(1, turn)), thr: thr };
    var fwdX = Math.sin(tank.heading), fwdZ = Math.cos(tank.heading);
    var rightX = fwdZ, rightZ = -fwdX;
    var push = 0, wSum = 0, maxOv = 0;
    var nearR = null, nearL = null;   // 前方最近锥内障碍（缝宽判断用）
    for (var i = 0; i < obstacles.length; i++) {
      var ob = obstacles[i];
      if (!ob || !ob.position) continue;
      var dx = ob.position.x - tank.position.x, dz = ob.position.z - tank.position.z;
      var dd = Math.hypot(dx, dz);
      var obR = ob.radius || 3;
      var sense = urban ? 30 + Math.min(15, Math.max(0, obR - 3) * 1.5) : 30;   // v3 预警分级：石头 30m、建筑半径 15m→45m
      if (dd > sense || dd < 0.1) continue;
      var fwdDot = dx * fwdX + dz * fwdZ;
      var r = obR + 3.5;
      var sideDist = dx * rightX + dz * rightZ;
      var overlap, urgency, w;
      if (fwdDot <= 0) {
        if (!sideKick) continue;
        var backFade = 0.5 * (1 - Math.min(1, -fwdDot / 30)) * sideKick;
        if (Math.abs(sideDist) >= r * 1.6) continue;
        overlap = 1 - Math.abs(sideDist) / (r * 1.6);
        urgency = 0.4 + 0.6 * (30 - dd) / 30;
        w = overlap * urgency * backFade;
        push += (sideDist >= 0 ? -1 : 1) * (0.25 + 0.75 * overlap) * w;
        wSum += w;
        continue;
      }
      if (Math.abs(sideDist) >= r) continue;
      overlap = 1 - Math.abs(sideDist) / r;              // 0~1：挡得越死值越大（连续）
      if (urban && fwdDot > 0 && dd < 28 && overlap > 0.25) {    // v3：记录两侧最近锥内障碍（缝宽判断）
        if (sideDist >= 0) { if (!nearR || dd < nearR.dd) nearR = { dd: dd, side: sideDist, r: r }; }
        else { if (!nearL || dd < nearL.dd) nearL = { dd: dd, side: sideDist, r: r }; }
      }
      urgency = (0.4 + 0.6 * (30 - Math.min(30, dd)) / 30) * (urban && obR > 8 ? 1.4 : 1);   // v3：建筑更危险
      w = overlap * urgency;
      push += (sideDist >= 0 ? -1 : 1) * (0.25 + 0.75 * overlap) * w;
      wSum += w;
      if (overlap > maxOv) maxOv = overlap;
    }
    // 缝宽判断：前方两侧都有近障且横向净缝 <8m → 不钻缝，往宽的一侧全力绕 + 狠减速
    var brake = 0.35;
    if (urban && nearR && nearL) {
      var gap = (nearR.side - nearR.r) - (nearL.side + nearL.r);   // 两障碍边缘间距
      if (gap < 8) {
        var wide = (nearR.side - nearR.r) > -(nearL.side + nearL.r) ? 1 : -1;   // 更宽的一侧
        push = wide * Math.max(Math.abs(push), 0.85);
        brake = 0.7;
        wSum = Math.max(wSum, 1);   // 标记为有效推力
      }
    }
    if (urban && maxOv > 0.7) brake = 0.7;   // v3 紧急贴墙：狠减速
    if (!wSum) return { turn: Math.max(-1, Math.min(1, turn)), thr: thr };
    push = Math.max(-0.85, Math.min(0.85, push));            // 总量封顶（防多障碍叠加过度转向）
    var damp = 1 - Math.min(0.7, Math.abs(push));            // 避让强度越高，基础转向让位越多（防对拉抖动）
    return {
      turn: Math.max(-1, Math.min(1, turn * damp + push)),
      thr: Math.max(-1, Math.min(1, thr * (1 - brake * Math.min(1, Math.abs(push)))))
    };
  }

  window.__WTA = { OBS_DIM: OBS_DIM, wrap2pi: wrap2pi, clamp01: clamp01,
                   enemiesOf: enemiesOf, blockedCount: blockedCount, buildObs: buildObs,
                   makeMLP: makeMLP, gunAimPoint: gunAimPoint, terrainLos: terrainLos,
                   barrelAligned: barrelAligned, fireTol: fireTol,
                   makeStuck: makeStuck, retreatCmd: retreatCmd, smokeBlind: smokeBlind,
                   pickTarget: pickTarget, claimTarget: claimTarget, releaseTarget: releaseTarget,
                   avoidCmd: avoidCmd };
})();
