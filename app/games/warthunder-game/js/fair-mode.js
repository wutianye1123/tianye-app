// fair-mode.js — 公平模式（斗兽场）：红蓝双方坦克数值完全一致，只比 AI 脑子
// 激活：URL ?fair=1 或 localStorage.wt_fair==='1'（出战页「⚔ 公平模式」按钮写入）
// 平时（未激活）第一行 return，零影响。
//
// 原理：游戏的红蓝差异集中在 5 个 CONFIG 常量（main.js Tank 构造器），
//   血 45/140、速 7.5/12、装填 5/3、伤 14/35、散布 0.032/0.03——
//   类型乘数（tt.hp 等）双方同款 → 按固定比率缩放红方即精确抹平，且保留车型差异（虎式照旧比霞飞肉）。
//   蓝方数值是玩家阵营基准（玩家自己更强属于"人类福利"，观战挂机时无影响）。
// 配合出战页两个智能体开关可任意组合：5v6（bc敌方+rl队友）/ 6v5 / 6v6（rl双方）/ 5v5（bc双方）。
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  function readOn() {
    if (qs.get('fair') === '0') return false;   // URL 硬关
    if (qs.get('fair') === '1') return true;
    try { return localStorage.getItem('wt_fair') === '1'; } catch (e) { return false; }
  }

  // 蓝方基准 / 红方现值（普通难度，main.js CONFIG.tank 默认值；难度倍率双方同乘不改比率）
  var R_HP = 140 / 45, R_SPD = 12 / 7.5, R_RLD = 3.0 / 5.0, R_DMG = 35 / 14;
  var seen = new WeakSet();

  function equalize(t) {
    seen.add(t);
    t.maxHealth = Math.round(t.maxHealth * R_HP);
    t.health = t.maxHealth;                    // 满血出生
    if (t.maxSpeed) t.maxSpeed *= R_SPD;
    if (t.reloadTime) t.reloadTime *= R_RLD;
    if (t.shellDamage) t.shellDamage *= R_DMG;
    t.fireSpread = 0.03;                       // 与蓝方队友同款散布
  }

  function badge() {
    var el = document.getElementById('__fairBadge');
    if (!el) {
      el = document.createElement('div');
      el.id = '__fairBadge';
      el.style.cssText = 'position:fixed;left:12px;top:140px;z-index:99999;pointer-events:none;' +
        'background:rgba(0,0,0,.55);color:#fd6;padding:4px 10px;border-radius:6px;' +
        'font:12px/1.4 monospace;border:1px solid #a84;';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = '⚔ 公平模式（双方数值一致）';
  }

  var n = 0;
  var timer = setInterval(function () {
    try {
      if (!readOn()) return;                    // 热切换：按钮关了就停（本局已缩放的车保留到局末）
      var g = window.__game;
      if (!g || !g.em || g.state !== 'playing') return;
      if (g.mode !== 'tank') return;           // 只管坦克局
      var pool = (g.em && g.em.tanks) || [];
      for (var i = 0; i < pool.length; i++) {
        var t = pool[i];
        if (!t || seen.has(t) || t.netGhost) continue;
        if (t.team === 'red') { equalize(t); n++; }   // 只抬红方到蓝方水准（蓝方不动）
      }
      badge();
    } catch (e) { /* 轮询永不炸 */ }
  }, 300);
  console.log('[FAIR] 公平模式开启：红方已按蓝方基准缩放（血×3.11 速×1.6 装填×0.6 伤×2.5 散布0.03）');
})();
