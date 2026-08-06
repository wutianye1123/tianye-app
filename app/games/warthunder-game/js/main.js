import * as THREE from 'three';
import { clamp, lerp, lerpAngle, randRange, randInt, makeSkyTexture, makeCloudTexture, camoTexture, makeTrackTexture, terrainHeight } from './lib.js';

// 坦克贴地姿态用的临时对象（避免每帧分配）
const _tankN = new THREE.Vector3(), _tankFwd = new THREE.Vector3(), _tankRight = new THREE.Vector3();
const _tankM = new THREE.Matrix4(), _tankY = new THREE.Vector3(0, 1, 0);
const _tankQ = new THREE.Quaternion(), _tankWQ = new THREE.Quaternion();


// ===== js/config.js =====
// 全局可调常量。所有平衡性参数集中在这里，方便后续调整 / 嵌入 app。
const CONFIG = {
  tank: {
    maxHealth: 140,
    enemyHealth: 45,
    speed: 15,            // 前进 m/s（玩家）
    enemySpeed: 9,        // 敌方较慢
    reverseSpeed: 8,
    turnSpeed: 1.3,
    turretSpeed: 0.8,
    reloadTime: 3.0,      // 玩家主炮装填
    enemyReloadTime: 5.0, // 敌方装填更长
    enemySpread: 0.06,    // 敌方炮弹散布（越大越不准）
    enemyFireChance: 0.4, // 敌方瞄准后单次开火概率
    shellSpeed: 90,
    shellDamage: 35,      // 玩家炮弹伤害
    enemyShellDamage: 14, // 敌方炮弹伤害较低
    shellGravity: 6,
    shellLife: 3.5,
    radius: 3.0,
    worldSize: 420,
  },
  plane: {
    maxHealth: 60,
    enemyHealth: 16,
    minSpeed: 28,
    maxSpeed: 95,
    throttleRate: 0.8,
    pitchRate: 1.3,
    rollRate: 2.2,
    yawRate: 0.9,
    bulletSpeed: 300,
    bulletDamage: 4,      // 玩家机炮
    enemyBulletDamage: 2,
    fireCooldown: 0.15,
    enemyFireCooldown: 0.45,
    enemySpread: 0.045,
    enemyFireChance: 0.5,
    bulletLife: 2.0,
    radius: 6.5,
    gravity: 12,
    worldSize: 800,
    ceiling: 220,
    spawnAltitude: 70,
    missile: { count: 6, damage: 55, speed: 120, cooldown: 0.8, homing: 3.0, life: 5, radius: 0.5, regen: 7 },
  },
  // 战争雷霆式规则：致命殉爆/起火、玩家多条命、敌方票数与刷新波次。
  rules: {
    playerLives: 4,         // 玩家总命数（含首次出生）
    tankTickets: 6,         // 坦克模式需击毁的目标总数
    planeTickets: 5,        // 飞机模式需击落的目标总数
    maxConcurrentEnemies: 3,// 同屏敌车上限
    allyCount: 2,           // 同屏队友数
    respawnDelay: 3.0,
    enemyRespawnDelay: 2.5,
    crit: {
      tankInstant: 0.05,    // 命中即弹药殉爆（秒杀）
      tankFire: 0.18,       // 起火
      planeInstant: 0.04,   // 飞行员阵亡
      planeFire: 0.16,
      burnDps: 6,
    },
  },
};

// —— 难度系统 ——
// 原始参数快照（applyDifficulty 会据此重算 CONFIG，所以可反复切换而不累积）。
const BASE_CONFIG = JSON.parse(JSON.stringify(CONFIG));

// 三档难度：相对 normal 的倍率。
const DIFF = {
  easy:   { playerHp: 1.4, lives: 1.34, enemyHp: 0.7, enemyDmg: 0.5, enemyReload: 1.7, enemySpread: 1.7, enemyFire: 0.6, crit: 0.5, tickets: 0.7, concurrent: 0.67, allies: 1.5 },
  normal: { playerHp: 1,   lives: 1,    enemyHp: 1,   enemyDmg: 1,   enemyReload: 1,   enemySpread: 1,   enemyFire: 1,   crit: 1,   tickets: 1,   concurrent: 1,    allies: 1   },
  hard:   { playerHp: 0.8, lives: 0.75, enemyHp: 1.2, enemyDmg: 1.45, enemyReload: 0.8, enemySpread: 0.55, enemyFire: 1.3, crit: 1.4, tickets: 1.3, concurrent: 1,    allies: 0.5 },
};

// 按难度重算 CONFIG（先从 BASE 复原，再乘倍率）。整数型字段四舍五入且 ≥1。
function applyDifficulty(level) {
  const m = DIFF[level] || DIFF.normal;
  const B = BASE_CONFIG;
  const ri = (v) => Math.max(1, Math.round(v));
  CONFIG.tank.maxHealth = B.tank.maxHealth * m.playerHp;
  CONFIG.plane.maxHealth = B.plane.maxHealth * m.playerHp;
  CONFIG.rules.playerLives = ri(B.rules.playerLives * m.lives);
  CONFIG.tank.enemyHealth = B.tank.enemyHealth * m.enemyHp;
  CONFIG.plane.enemyHealth = B.plane.enemyHealth * m.enemyHp;
  CONFIG.tank.enemyShellDamage = B.tank.enemyShellDamage * m.enemyDmg;
  CONFIG.plane.enemyBulletDamage = B.plane.enemyBulletDamage * m.enemyDmg;
  CONFIG.tank.enemyReloadTime = B.tank.enemyReloadTime * m.enemyReload;
  CONFIG.plane.enemyFireCooldown = B.plane.enemyFireCooldown * m.enemyReload;
  CONFIG.tank.enemySpread = B.tank.enemySpread * m.enemySpread;
  CONFIG.plane.enemySpread = B.plane.enemySpread * m.enemySpread;
  CONFIG.tank.enemyFireChance = B.tank.enemyFireChance * m.enemyFire;
  CONFIG.plane.enemyFireChance = B.plane.enemyFireChance * m.enemyFire;
  const c = B.rules.crit;
  CONFIG.rules.crit.tankInstant = c.tankInstant * m.crit;
  CONFIG.rules.crit.tankFire = c.tankFire * m.crit;
  CONFIG.rules.crit.planeInstant = c.planeInstant * m.crit;
  CONFIG.rules.crit.planeFire = c.planeFire * m.crit;
  CONFIG.rules.tankTickets = ri(B.rules.tankTickets * m.tickets);
  CONFIG.rules.planeTickets = ri(B.rules.planeTickets * m.tickets);
  CONFIG.rules.maxConcurrentEnemies = ri(B.rules.maxConcurrentEnemies * m.concurrent);
  CONFIG.rules.allyCount = ri(B.rules.allyCount * m.allies);
}
const DIFFICULTY_LABELS = { easy: '简单', normal: '普通', hard: '困难' };

// —— 坦克型号 ——（在难度调整后的基础数值上再乘这些倍率；scale 为体积）
const TANK_TYPES = [
  { id:'medium',  name:'中型坦克',   icon:'🛡️', scale:1.0,  hp:1.0,  speed:1.0, turn:1.0, turret:1.0, reload:1.0, dmg:1.0,  rank:1, rp:0,    prereq:null,     price:0 },
  { id:'light',   name:'轻型坦克',   icon:'🚙', scale:0.85, hp:0.75, speed:1.5, turn:1.5, turret:1.7, reload:0.7, dmg:0.75, rank:2, rp:300,  prereq:'medium', price:1500 },
  { id:'scout',   name:'侦察战车',   icon:'🏍️', scale:0.8,  hp:0.5,  speed:1.7, turn:1.8, turret:1.8, reload:0.6, dmg:0.5,  rank:2, rp:300,  prereq:'medium', price:1000 },
  { id:'td',      name:'坦克歼击车', icon:'🎯', scale:1.05, hp:1.1,  speed:0.9, turn:0.8, turret:0.7, reload:1.4, dmg:2.8,  rank:3, rp:800,  prereq:'light',  price:3500 },
  { id:'heavy',   name:'重型坦克',   icon:'🐢', scale:1.2,  hp:2.0,  speed:0.7, turn:0.7, turret:0.9, reload:1.3, dmg:2.2,  rank:4, rp:1600, prereq:'td',     price:4500 },
  { id:'assault', name:'突击重炮',   icon:'💥', scale:1.3,  hp:2.6,  speed:0.6, turn:0.6, turret:0.85,reload:1.6, dmg:3.4,  rank:5, rp:3200, prereq:'heavy',  price:9000 },
];
function tankTypeById(id) { return TANK_TYPES.find((t) => t.id === id) || TANK_TYPES[1]; }
function randomTankType() { return TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)]; }

// —— 飞机型号 ——（hp 血量、speed 速度、agi 机动、dmg 火力；均为相对倍率）
const PLANE_TYPES = [
  { id:'trainer',   name:'教练机',     icon:'🛩️', hp:0.6,  speed:0.95, agi:1.15, dmg:0.7,  rank:1, rp:0,    prereq:null,       price:0 },
  { id:'fighter',   name:'战斗机',     icon:'✈️', hp:1.0,  speed:1.0,  agi:1.0,  dmg:1.0,  rank:1, rp:0,    prereq:null,       price:0 },
  { id:'intercept', name:'截击机',     icon:'🛫', hp:0.85, speed:1.25, agi:0.85, dmg:1.1,  rank:2, rp:400,  prereq:'fighter', price:2500 },
  { id:'heavy',     name:'重型战斗机', icon:'🛩️', hp:1.4,  speed:0.9,  agi:0.8,  dmg:1.35, rank:3, rp:1000, prereq:'intercept',price:4000 },
  { id:'attacker',  name:'攻击机',     icon:'✈️', hp:1.7,  speed:0.8,  agi:0.7,  dmg:1.5,  rank:3, rp:1000, prereq:'heavy',    price:6000 },
  { id:'jet',       name:'喷气战斗机', icon:'🚀', hp:1.0,  speed:1.5,  agi:1.2,  dmg:1.4,  rank:5, rp:3000, prereq:'heavy',    price:11000 },
];
function planeTypeById(id) { return PLANE_TYPES.find((p) => p.id === id) || PLANE_TYPES[0]; }
function randomPlaneType() { return PLANE_TYPES[Math.floor(Math.random() * PLANE_TYPES.length)]; }



// ===== js/core/Input.js =====
// 键鼠输入抽象。记录按键状态、鼠标按键、鼠标位置（用于战争雷霆式的"鼠标瞄准"）。
// 不使用指针锁定——战争雷霆用的是自由光标，载具/炮塔跟随光标位置。
class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.mouseX = window.innerWidth / 2;
    this.mouseY = window.innerHeight / 2;
    this.mvX = 0; this.mvY = 0; // 鼠标移动增量（指针锁定下无限累积，用于炮塔无限旋转）

    this._onKeyDown = (e) => {
      this.keys.add(e.code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'KeyF'].includes(e.code)) {
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onMouseDown = (e) => {
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) this.rightMouseDown = true;
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.rightMouseDown = false;
    };
    this._onMouseMove = (e) => {
      this.mouseX = e.clientX; this.mouseY = e.clientY;
      this.mvX += e.movementX || 0; this.mvY += e.movementY || 0; // 指针锁定时 movementX/Y 持续给增量
    };
    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('contextmenu', this._onContext);

    // 触屏：左半屏虚拟摇杆(驾驶 WASD)，右半屏拖动=瞄准、按住=开火
    this._touches = {};
    this._setupTouch();
  }

  // 触屏双区操控。只在触屏设备生效（鼠标/键盘不受影响）。
  _setupTouch() {
    const base = document.createElement('div');
    base.style.cssText = 'position:fixed;width:128px;height:128px;border-radius:50%;border:2px solid rgba(180,255,180,.45);background:rgba(30,50,30,.2);display:none;z-index:30;pointer-events:none;transform:translate(-50%,-50%)';
    const knob = document.createElement('div');
    knob.style.cssText = 'position:absolute;left:50%;top:50%;width:56px;height:56px;border-radius:50%;background:rgba(180,255,180,.55);transform:translate(-50%,-50%)';
    base.appendChild(knob); document.body.appendChild(base);
    this._vjBase = base; this._vjKnob = knob;
    this._onTouchStart = (e) => {
      for (const t of e.changedTouches) {
        const side = t.clientX < window.innerWidth / 2 ? 'L' : 'R';
        this._touches[t.identifier] = { side, sx: t.clientX, sy: t.clientY };
        if (side === 'L') { base.style.display = 'block'; base.style.left = t.clientX + 'px'; base.style.top = t.clientY + 'px'; knob.style.left = '50%'; knob.style.top = '50%'; }
      }
      e.preventDefault();
    };
    this._onTouchMove = (e) => {
      for (const t of e.changedTouches) {
        const tr = this._touches[t.identifier]; if (!tr) continue;
        const dx = t.clientX - tr.sx, dy = t.clientY - tr.sy;
        if (tr.side === 'L') {
          const dead = 12;
          for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) this.keys.delete(k);
          if (dy < -dead) this.keys.add('KeyW');
          if (dy > dead) this.keys.add('KeyS');
          if (dx < -dead) this.keys.add('KeyA');
          if (dx > dead) this.keys.add('KeyD');
          const kx = clamp(dx, -48, 48), ky = clamp(dy, -48, 48);
          knob.style.left = `calc(50% + ${kx}px)`; knob.style.top = `calc(50% + ${ky}px)`;
        } else {
          this.mouseX = t.clientX; this.mouseY = t.clientY; this.mouseDown = true; // 右手拖动=瞄准、按住=开火
        }
      }
      e.preventDefault();
    };
    this._onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        const tr = this._touches[t.identifier]; if (!tr) continue;
        if (tr.side === 'L') {
          base.style.display = 'none';
          for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) this.keys.delete(k);
        } else this.mouseDown = false;
        delete this._touches[t.identifier];
      }
      e.preventDefault();
    };
    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  isDown(code) {
    return this.keys.has(code);
  }

  // 取走自上次调用以来的鼠标移动增量（指针锁定下=无限；非锁定时为 0，调用方用 clientX 差值兜底）。
  consumeMovement() {
    const x = this.mvX, y = this.mvY; this.mvX = 0; this.mvY = 0;
    return { x, y };
  }

  // 标准化设备坐标 [-1,1]，y 上为正。
  getNDC() {
    return {
      x: (this.mouseX / window.innerWidth) * 2 - 1,
      y: -((this.mouseY / window.innerHeight) * 2 - 1),
    };
  }

  // 指针锁定下的"虚拟瞄准点"：把鼠标移动增量累积成 NDC[-1,1]。
  // 这样光标被锁定（不会飞出窗口），飞机仍按"指哪飞哪"的绝对位置逻辑瞄准。
  aimVirtualNDC(dx, dy, gain) {
    this._vNx = clamp((this._vNx || 0) + dx * gain, -1, 1);
    this._vNy = clamp((this._vNy || 0) - dy * gain, -1, 1); // 上为正，与 getNDC 一致
    return { x: this._vNx, y: this._vNy };
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    if (this._onTouchStart) {
      this.canvas.removeEventListener('touchstart', this._onTouchStart);
      this.canvas.removeEventListener('touchmove', this._onTouchMove);
      this.canvas.removeEventListener('touchend', this._onTouchEnd);
      this.canvas.removeEventListener('touchcancel', this._onTouchEnd);
    }
    if (this._vjBase) this._vjBase.remove();
  }
}


// ===== js/core/HUD.js =====
// DOM 叠加层：血条、装填条、计分、准星、小地图、结果面板。
// 接收一个容器元素，在其内构建并管理子节点。便于嵌入 app（不依赖全局 DOM id）。
class HUD {
  constructor(container) {
    this.container = container;
    container.innerHTML = `
      <div id="crosshair"></div>
      <div id="aim-circle"></div>
      <div id="hitmarker"></div>
      <div id="lead-reticle"></div>
      <div id="stats">
        <div class="bar"><span class="lbl">血量</span><div class="bar-bg"><div class="bar-fg hp" id="hp-fg"></div></div></div>
        <div class="bar"><span class="lbl">装填</span><div class="bar-bg"><div class="bar-fg rl" id="rl-fg"></div></div></div>
        <div id="score">击毁 0　剩余 0</div>
        <div id="missiles" class="missiles"></div>
        <div id="modules" class="modules"></div>
      </div>
      <canvas id="minimap" width="150" height="150"></canvas>
      <div id="hint"></div>
      <div id="feed"></div>
      <div id="center-msg"></div>
      <div id="lock-prompt">点击画面锁定鼠标 · 解锁炮塔无限旋转</div>
      <div id="result" class="hidden">
        <div class="result-card">
          <h2 id="result-title"></h2>
          <p id="result-sub"></p>
          <button id="btn-again">再来一局</button>
          <button id="btn-menu">返回主菜单</button>
        </div>
      </div>
    `;
    this.hpFg = container.querySelector('#hp-fg');
    this.rlFg = container.querySelector('#rl-fg');
    this.scoreEl = container.querySelector('#score');
    this.mini = container.querySelector('#minimap');
    this.miniCtx = this.mini.getContext('2d');
    this.hint = container.querySelector('#hint');
    this.crosshair = container.querySelector('#crosshair');
    this.hitmarker = container.querySelector('#hitmarker');
    this.result = container.querySelector('#result');
    this.resultTitle = container.querySelector('#result-title');
    this.resultSub = container.querySelector('#result-sub');
  }

  // 让准星（与命中标记）跟随光标。
  positionCrosshair(x, y) {
    if (this.crosshair) { this.crosshair.style.left = `${x}px`; this.crosshair.style.top = `${y}px`; }
    if (this.hitmarker) { this.hitmarker.style.left = `${x}px`; this.hitmarker.style.top = `${y}px`; }
  }

  // 显隐准星+命中标记：阵亡/一局结束时隐藏，避免死后准星留在屏上误导。
  hideCrosshair() {
    if (this.crosshair) this.crosshair.style.display = 'none';
    if (this.hitmarker) this.hitmarker.style.display = 'none';
  }
  showCrosshair() {
    if (this.crosshair) this.crosshair.style.display = '';
    if (this.hitmarker) this.hitmarker.style.display = '';
  }

  // 坦克瞄准圆环：跟随世界锁定瞄准点在屏幕上的投影（炮塔转到对准它时，圆环滑到屏幕中央十字处）。
  positionAimCircle(ndcX, ndcY, on) {
    if (!this.aimCircle) this.aimCircle = this.container.querySelector('#aim-circle');
    if (!this.aimCircle) return;
    if (!on) { this.aimCircle.style.display = 'none'; return; }
    this.aimCircle.style.display = 'block';
    this.aimCircle.style.left = `${(ndcX * 0.5 + 0.5) * window.innerWidth}px`;
    this.aimCircle.style.top = `${(-ndcY * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // 提前量瞄准具：把前置拦截点（NDC）显示成屏幕上的圆环。
  positionLead(ndcX, ndcY, on) {
    if (!this.leadEl) this.leadEl = this.container.querySelector('#lead-reticle');
    if (!this.leadEl) return;
    if (!on) { this.leadEl.style.display = 'none'; return; }
    this.leadEl.style.display = 'block';
    this.leadEl.style.left = `${(ndcX * 0.5 + 0.5) * window.innerWidth}px`;
    this.leadEl.style.top = `${(-ndcY * 0.5 + 0.5) * window.innerHeight}px`;
  }

  // 模块损伤提示（坦克）：{ track, barrel, engine } 剩余秒数。
  setModules(mods) {
    if (!this.modulesEl) this.modulesEl = this.container.querySelector('#modules');
    if (!this.modulesEl) return;
    if (!mods) { this.modulesEl.textContent = ''; return; }
    const parts = [];
    if (mods.track > 0) parts.push(`🛞 履带 ${Math.ceil(mods.track)}s`);
    if (mods.barrel > 0) parts.push(`🎯 炮管 ${Math.ceil(mods.barrel)}s`);
    if (mods.engine > 0) parts.push(`⚙️ 发动机 ${Math.ceil(mods.engine)}s`);
    this.modulesEl.textContent = parts.join('　');
  }

  // 命中反馈：在准星处闪一个标记。hit=命中(金)，crit=致命(橙)，kill=击毁(红)。
  flashHit(kind = 'hit') {
    if (!this.hitmarker) return;
    this.hitmarker.classList.toggle('kill', kind === 'kill');
    this.hitmarker.classList.toggle('crit', kind === 'crit');
    this.hitmarker.style.opacity = '1';
    clearTimeout(this._hitTO);
    this._hitTO = setTimeout(() => { this.hitmarker.style.opacity = '0'; }, 180);
  }

  // 击杀/命中提示（战争雷霆式 kill feed），4 秒后淡出。
  addFeed(text, kind = 'kill') {
    if (!this.feedEl) this.feedEl = this.container.querySelector('#feed');
    const line = document.createElement('div');
    line.className = `feed-line feed-${kind}`;
    line.textContent = text;
    this.feedEl.prepend(line);
    setTimeout(() => { line.style.opacity = '0'; }, 3000);
    setTimeout(() => { line.remove(); }, 4200);
    // 最多保留 6 条
    while (this.feedEl.children.length > 6) this.feedEl.removeChild(this.feedEl.lastChild);
  }

  // 屏幕中央短消息（如"复活中 3"）。传空字符串则隐藏。
  setCenterMessage(text) {
    if (!this.centerMsg) this.centerMsg = this.container.querySelector('#center-msg');
    this.centerMsg.textContent = text || '';
    this.centerMsg.style.display = text ? 'flex' : 'none';
  }

  setHint(text) {
    this.hint.innerHTML = text;
  }

  // "点击锁定鼠标"提示：坦克模式下指针未锁定时显示，引导玩家点击以启用无限旋转。
  showLockPrompt() {
    if (!this.lockPrompt) this.lockPrompt = this.container.querySelector('#lock-prompt');
    if (this.lockPrompt) this.lockPrompt.style.display = 'block';
  }
  hideLockPrompt() {
    if (!this.lockPrompt) this.lockPrompt = this.container.querySelector('#lock-prompt');
    if (this.lockPrompt) this.lockPrompt.style.display = 'none';
  }

  update({ health = 100, maxHealth = 100, reloadFraction = 1, kills = 0, tickets = 0, lives = 0 } = {}) {
    this.hpFg.style.width = `${Math.max(0, (health / maxHealth) * 100)}%`;
    this.rlFg.style.width = `${reloadFraction * 100}%`;
    this.scoreEl.textContent = isFinite(tickets)
      ? `击毁 ${kills}/${tickets}　命数 ${lives}`
      : `无尽 · 击毁 ${kills}　命数 ${lives}`;
  }

  // 导弹计数（喷气机用）。max<=0 表示该机型无导弹，隐藏。
  setMissiles(n, max) {
    if (!this.missilesEl) this.missilesEl = this.container.querySelector('#missiles');
    if (!this.missilesEl) return;
    if (!max || max <= 0) { this.missilesEl.textContent = ''; return; }
    this.missilesEl.textContent = `🚀 导弹 ${n}/${max}`;
  }

  // 小地图：玩家居中、朝上为前进方向；敌人画红点。
  drawMinimap({ playerPos, playerHeading, enemies, allies, range = 200 } = {}) {
    const ctx = this.miniCtx;
    const w = this.mini.width, h = this.mini.height;
    ctx.clearRect(0, 0, w, h);
    // 背景
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,200,120,0.5)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    const cx = w / 2, cy = h / 2;
    const scale = (w / 2) / range;
    const cos = Math.cos(-playerHeading), sin = Math.sin(-playerHeading);

    // 把世界坐标投影到“玩家朝上”的小地图坐标
    const project = (p) => {
      const dx = p.x - playerPos.x;
      const dz = p.z - playerPos.z;
      const rx = dx * cos - dz * sin;
      const rz = dx * sin + dz * cos;
      return { px: cx + rx * scale, py: cy - rz * scale }; // 屏幕Y向下，前方在上方
    };
    const dot = (p, color, r) => {
      const { px, py } = project(p);
      if (px < 1 || px > w - 1 || py < 1 || py > h - 1) return;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    };

    if (allies) for (const a of allies) dot(a, '#66aaff', 2.4);   // 友方（蓝）
    if (enemies) for (const e of enemies) dot(e, '#ff5555', 3);   // 敌方（红）

    // 玩家三角（绿色，朝上）
    ctx.fillStyle = '#66ff88';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.closePath();
    ctx.fill();
  }

  // 显示胜负面板，按钮回调每次重绑。
  showResult({ win, kills, onAgain, onMenu, endless = false }) {
    this.resultTitle.textContent = win ? '胜利！' : (endless ? '本局阵亡' : '失败');
    this.resultTitle.style.color = win ? '#7CFC00' : (endless ? '#ffd86b' : '#ff5555');
    this.resultSub.textContent = endless ? `坚持击毁 ${kills} 个目标` : `本局击毁 ${kills} 个目标`;
    this.result.classList.remove('hidden');

    const again = this.container.querySelector('#btn-again');
    const menu = this.container.querySelector('#btn-menu');
    const a = () => { cleanup(); onAgain(); };
    const m = () => { cleanup(); onMenu(); };
    const cleanup = () => {
      this.result.classList.add('hidden');
      again.removeEventListener('click', a);
      menu.removeEventListener('click', m);
    };
    again.addEventListener('click', a);
    menu.addEventListener('click', m);
  }

  dispose() {
    this.container.innerHTML = '';
  }
}


// ===== js/entities/Projectile.js =====


// 炮弹 / 子弹。直线飞行 + 可选重力下坠 + 生命周期。
// 命中检测由 EntityManager 用 position + radius 做球体判定。
class Projectile {
  constructor({ position, direction, speed, damage, owner = null, ownerTeam, color = 0xffe08a, size = 0.35, gravity = 0, life = 3 }) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 8, 8),
      new THREE.MeshBasicMaterial({ color })
    );
    this.mesh.position.copy(position);
    this.radius = size;
    this.velocity = direction.clone().normalize().multiplyScalar(speed);
    this.damage = damage;
    this.owner = owner;           // 发射者实体（用于击杀归属）
    this.ownerTeam = ownerTeam;   // 'blue' | 'red'（同队不互伤）
    this.gravity = gravity;
    this.life = life;
    this.target = null;   // 追踪目标（导弹用）
    this.homing = 0;      // 追踪强度
    this.alive = true;
  }

  update(dt) {
    if (this.homing && this.target && this.target.alive) {
      const desired = this.target.position.clone().sub(this.mesh.position).normalize();
      const cur = this.velocity.clone().normalize();
      cur.lerp(desired, clamp(this.homing * dt, 0, 1)).normalize();
      this.velocity.copy(cur.multiplyScalar(this.velocity.length()));
    }
    if (this.gravity) this.velocity.y -= this.gravity * dt;
    this.mesh.position.addScaledVector(this.velocity, dt);
    this.life -= dt;
    if (this.life <= 0) this.alive = false;
    if (this.mesh.position.y < terrainHeight(this.mesh.position.x, this.mesh.position.z) + 0.1) this.alive = false; // 落地（贴地形）
  }
}


// ===== js/entities/Effects.js =====

// 瞬时特效的统一接口：拥有 .mesh(Object3D)、update(dt)、.alive。
// 由 EntityManager 统一更新并在结束后从场景移除。

// 爆炸：明亮内核快速膨胀 + 烟雾慢速膨胀淡出。
class Explosion {
  constructor(position, scale = 1, color = 0xffa040) {
    this.group = new THREE.Group();
    this.group.position.copy(position);

    const s = Math.max(0.5, scale);
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(s, 12, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
    );
    this.smoke = new THREE.Mesh(
      new THREE.SphereGeometry(s * 1.2, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.8 })
    );
    this.group.add(this.core, this.smoke);

    // 爆炸闪光
    this.light = new THREE.PointLight(color, 4, 30 * s);
    this.group.add(this.light);

    this.life = 0.7;
    this.maxLife = 0.7;
    this.alive = true;
    this.isExplosion = true;
    this.mesh = this.group;
  }

  update(dt) {
    this.life -= dt;
    const t = 1 - this.life / this.maxLife; // 0→1
    this.core.scale.setScalar(1 + t * 2.5);
    this.smoke.scale.setScalar(1 + t * 3.5);
    this.core.material.opacity = Math.max(0, 1 - t * 1.4);
    this.smoke.material.opacity = Math.max(0, 0.8 * (1 - t));
    this.light.intensity = Math.max(0, 4 * (1 - t * 1.5));
    if (this.life <= 0) this.alive = false;
  }
}

// 枪口火焰：极短的亮斑。
class MuzzleFlash {
  constructor(position, color = 0xffdd66) {
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 })
    );
    this.mesh.position.copy(position);
    this.life = 0.08;
    this.maxLife = 0.08;
    this.alive = true;
  }

  update(dt) {
    this.life -= dt;
    const t = 1 - this.life / this.maxLife;
    this.mesh.scale.setScalar(1 + t * 1.5);
    this.mesh.material.opacity = Math.max(0, 1 - t);
    if (this.life <= 0) this.alive = false;
  }
}

// 烟雾 / 凝结尾迹：缓慢膨胀、上浮、淡出。起火用深灰烟，喷气尾迹用白。
const _smokeGeo = new THREE.SphereGeometry(1, 6, 6); // 共享单位球，靠 scale 缩放，省去每团烟分配几何
class Smoke {
  constructor(position, color = 0x888888, size = 0.6, life = 1.2, rise = 1.5) {
    this.mesh = new THREE.Mesh(_smokeGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    this.mesh.position.copy(position);
    this.size = size;
    this.mesh.scale.setScalar(size);
    this.life = life;
    this.maxLife = life;
    this.vel = new THREE.Vector3(randRange(-0.3, 0.3), rise, randRange(-0.3, 0.3));
    this.alive = true;
  }

  update(dt) {
    this.life -= dt;
    const t = 1 - this.life / this.maxLife;
    this.mesh.position.addScaledVector(this.vel, dt);
    this.mesh.scale.setScalar(this.size * (1 + t * 2.6));
    this.mesh.material.opacity = Math.max(0, 0.55 * (1 - t));
    if (this.life <= 0) this.alive = false;
  }
}


// ===== js/core/EntityManager.js =====


// 统一管理场景中的载具与弹丸：增删、每帧更新、弹丸命中判定、死亡清理。
class EntityManager {
  constructor(scene) {
    this.scene = scene;
    this.tanks = [];
    this.planes = [];
    this.projectiles = [];
    this.effects = [];
  }

  addTank(t) { this.tanks.push(t); this.scene.add(t.group); t.em = this; }
  addPlane(p) { this.planes.push(p); this.scene.add(p.group); p.em = this; }
  addProjectile(p) {
    this.projectiles.push(p); this.scene.add(p.mesh);
    if (this.sfx && !p.homing) {
      if (p.size >= 0.4) this.sfx.gunshot(p.mesh.position);
      else this.sfx.mg(p.mesh.position);
    }
  }
  addEffect(e) {
    this.effects.push(e); if (e.mesh) this.scene.add(e.mesh);
    if (e.isExplosion && this.sfx) this.sfx.explosion(e.mesh.position);
    if (this.effects.length > 160) { // 上限：丢最老的，防特效失控涨帧
      const old = this.effects.shift();
      if (old && old.mesh) this.scene.remove(old.mesh);
    }
  }

  update(dt) {
    for (const t of this.tanks) if (t.alive) t.update(dt);
    for (const p of this.planes) if (p.alive) p.update(dt);
    for (const p of this.projectiles) p.update(dt);
    for (const e of this.effects) e.update(dt);

    // 清理失效弹丸
    this.projectiles = this.projectiles.filter((p) => {
      if (!p.alive) { this.scene.remove(p.mesh); return false; }
      return true;
    });
    // 清理失效特效
    this.effects = this.effects.filter((e) => {
      if (!e.alive) { if (e.mesh) { this.scene.remove(e.mesh); if (e.mesh.material && e.mesh.material.dispose) e.mesh.material.dispose(); } return false; }
      return true;
    });
  }

  // 弹丸 vs 目标列表 的球体命中判定。命中后扣血、生成爆炸、销毁弹丸。
  checkCollisions(targets) {
    const hits = [];
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      for (const t of targets) {
        if (!t.alive) continue;
        if (p.ownerTeam === t.team) continue; // 同队不互伤
        const r = (t.radius || 3) + (p.radius || 0.4);
        if (t.position.distanceToSquared(p.mesh.position) <= r * r) {
          const wasAlive = t.alive;
          t._lastAttacker = p.owner; // 记录击杀归属
          t.onHit(p.damage);
          p.alive = false;
          this.addEffect(new Explosion(p.mesh.position.clone(), t.radius ? t.radius * 0.6 : 1, 0xffa040));
          hits.push({ owner: p.owner, killed: wasAlive && !t.alive, crit: t.lastCrit });
          break;
        }
      }
    }
    return hits;
  }

  // 从场景与列表中移除已死亡载具，返回本次移除的列表（供 Game 计分 / 判定）。
  cullDead() {
    const removed = [];
    this.tanks = this.tanks.filter((t) => {
      if (!t.alive) { this.scene.remove(t.group); removed.push(t); return false; }
      return true;
    });
    this.planes = this.planes.filter((p) => {
      if (!p.alive) { this.scene.remove(p.group); removed.push(p); return false; }
      return true;
    });
    return removed;
  }

  clear() {
    for (const t of this.tanks) this.scene.remove(t.group);
    for (const p of this.planes) this.scene.remove(p.group);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const e of this.effects) if (e.mesh) this.scene.remove(e.mesh);
    this.tanks = []; this.planes = []; this.projectiles = []; this.effects = [];
  }
}


// ===== js/entities/Tank.js =====





// 坦克：车体 + 可独立旋转炮塔 + 可俯仰炮管 + 履带。
// 战争雷霆式鼠标瞄准（炮塔偏航+炮管仰角跟随光标），WASD 独立开车体。
// team: 'blue'(玩家/队友) | 'red'(敌方)。按队伍区分伤害/装填/散布。

// 每种型号的几何规格：hull[宽,高,长]、炮塔样式与尺寸、炮管[半径,长]、负重轮数、是否有炮口制退器。
const GEOM = {
  light:   { hull:[3.0, 0.9, 4.6], turret:'cyl',     turretSize:[1.8, 0.95], barrel:[0.14, 2.8], wheels:5, brake:false },
  medium:  { hull:[3.4, 1.1, 5.4], turret:'box',     turretSize:[2.4, 1.0 ], barrel:[0.18, 3.4], wheels:6, brake:false },
  heavy:   { hull:[4.0, 1.4, 6.4], turret:'box',     turretSize:[3.0, 1.25], barrel:[0.24, 3.6], wheels:7, brake:true  },
  td:      { hull:[3.6, 1.05,6.2], turret:'casemate',turretSize:[2.8, 0.95], barrel:[0.26, 4.6], wheels:6, brake:true  },
  assault: { hull:[4.6, 1.7, 7.0], turret:'massive', turretSize:[3.4, 1.5 ], barrel:[0.32, 3.4], wheels:7, brake:true  },
  scout:   { hull:[2.6, 0.8, 3.8], turret:'open',    turretSize:[1.5, 0.55], barrel:[0.12, 2.3], wheels:4, brake:false },
};
class Tank {
  constructor({ side = 'player', team = 'blue', color = 0x4a6b3a, type = 'medium' } = {}) {
    this.side = side;
    this.team = team;
    this.color = color;
    this.type = type;
    const tt = tankTypeById(type);
    this.typeName = tt.name;
    this.group = new THREE.Group();

    const isEnemy = team === 'red';
    this.maxHealth = (isEnemy ? CONFIG.tank.enemyHealth : CONFIG.tank.maxHealth) * tt.hp;
    this.health = this.maxHealth;
    this.heading = 0;
    this.turretYaw = 0;
    this.barrelPitch = 0;
    this._aimYawSmooth = 0;
    this.reloadTimer = 0;
    this.mgTimer = 0;
    this.alive = true;
    this.radius = CONFIG.tank.radius * tt.scale;
    this.worldSize = CONFIG.tank.worldSize;
    this.burning = false;
    this.lastCrit = null;
    this.extCooldown = 0;
    this._lastAttacker = null;
    this.modules = { track: 0, barrel: 0, engine: 0 }; // 模块损伤：>0 表示损坏剩余秒数

    // 按队伍 + 型号的性能参数（敌方更弱更慢更不准）
    this.maxSpeed = (isEnemy ? CONFIG.tank.enemySpeed : CONFIG.tank.speed) * tt.speed;
    this.reloadTime = (isEnemy ? CONFIG.tank.enemyReloadTime : CONFIG.tank.reloadTime) * tt.reload;
    this.shellDamage = (isEnemy ? CONFIG.tank.enemyShellDamage : CONFIG.tank.shellDamage) * tt.dmg;
    this.turretSpeed = CONFIG.tank.turretSpeed * tt.turret;
    this.turnSpeed = CONFIG.tank.turnSpeed * tt.turn;
    this.fireSpread = isEnemy ? CONFIG.tank.enemySpread : (side === 'ally' ? 0.03 : 0);

    this._build();
  }

  _build() {
    const g = GEOM[this.type] || GEOM.medium;
    const [hw, hh, hl] = g.hull;
    const bodyMat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.55, metalness: 0.35, map: camoTexture() });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.65 });

    // 车体 + 倾斜前装甲
    const hullY = hh * 0.5 + 0.4;
    this.hull = new THREE.Mesh(new THREE.BoxGeometry(hw, hh, hl), bodyMat);
    this.hull.position.y = hullY;
    this.hull.castShadow = true; this.hull.receiveShadow = true;
    this.group.add(this.hull);
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(hw * 0.96, hh * 0.55, hl * 0.28), bodyMat);
    glacis.position.set(0, hullY + hh * 0.1, hl * 0.5);
    glacis.rotation.x = -0.5; glacis.castShadow = true;
    this.group.add(glacis);

    // 履带 + 负重轮 + 翼子板
    for (const sx of [-1, 1]) {
      const tmat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1, map: makeTrackTexture() });
      if (sx < 0) this.trackMatL = tmat; else this.trackMatR = tmat;
      const track = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.95, hl * 1.05), tmat);
      track.position.set(sx * (hw / 2 + 0.35), 0.5, 0);
      track.castShadow = true; this.group.add(track);
      const span = hl * 0.8;
      for (let i = 0; i < g.wheels; i++) {
        const z = -span / 2 + (span * i) / Math.max(1, g.wheels - 1);
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.5, 10), darkMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (hw / 2 + 0.35), 0.5, z);
        this.group.add(wheel);
      }
      const fender = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, hl * 0.98), bodyMat);
      fender.position.set(sx * (hw / 2 + 0.7), hullY + hh * 0.5, 0);
      this.group.add(fender);
    }

    // 炮塔（按型号）+ 炮管
    this.turret = new THREE.Group();
    const turretBaseY = hullY + hh * 0.5;
    this.turret.position.y = turretBaseY;
    this._buildTurret(g, bodyMat);
    this.turretTopY = turretBaseY + g.turretSize[1];

    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(0, g.turretSize[1] * 0.2, g.turretSize[0] * 0.35);
    this.turret.add(this.barrelPivot);
    const [br, bl] = g.barrel;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(br * 0.85, br, bl, 12), metalMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, bl * 0.5);
    barrel.castShadow = true;
    this.barrelPivot.add(barrel);
    if (g.brake) {
      const brake = new THREE.Mesh(new THREE.CylinderGeometry(br * 1.5, br * 1.5, bl * 0.14, 10), metalMat);
      brake.rotation.x = Math.PI / 2;
      brake.position.set(0, 0, bl);
      this.barrelPivot.add(brake);
    }
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, bl + 0.2);
    this.barrelPivot.add(this.muzzle);

    this.group.add(this.turret);
    this.healthBar = this._makeHealthBar();
    this.group.add(this.healthBar);
  }

  // 按型号构建不同样式的炮塔。
  _buildTurret(g, bodyMat) {
    const [tw, th] = g.turretSize;
    const turret = this.turret;
    const add = (mesh, x = 0, y = 0, z = 0, rx = 0) => {
      mesh.position.set(x, y, z); mesh.rotation.x = rx; mesh.castShadow = true; turret.add(mesh);
    };
    switch (g.turret) {
      case 'cyl':
        add(new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.5, tw * 0.55, th, 14), bodyMat));
        break;
      case 'casemate': // 低矮固定战斗室（歼击车）
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.7), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 0.9, th * 0.85, tw * 0.18), bodyMat), 0, 0, tw * 0.42, -0.5);
        break;
      case 'massive': // 巨型炮塔 + 附加装甲（突击重炮）
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.85), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 1.05, th * 0.5, tw * 0.2), bodyMat), 0, -th * 0.2, tw * 0.45);
        break;
      case 'open': // 开顶侦察
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.8), bodyMat));
        break;
      case 'box':
      default:
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 1.1), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 0.85, th * 0.7, tw * 0.25), bodyMat), 0, 0, tw * 0.55, -0.5);
        break;
    }
    if (g.turret !== 'open' && g.turret !== 'casemate') {
      add(new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.18, tw * 0.2, th * 0.35, 10), bodyMat), -tw * 0.22, th * 0.6, -tw * 0.1);
    }
  }

  _makeHealthBar() {
    const bar = new THREE.Group();
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 0.35),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 })
    );
    const fg = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 0.35),
      new THREE.MeshBasicMaterial({ color: this.team === 'blue' ? 0x33ff66 : 0xff4444 })
    );
    fg.position.z = 0.01;
    this.healthFg = fg;
    bar.add(bg, fg);
    bar.position.set(0, (this.turretTopY || 2.6) + 0.9, 0);
    return bar;
  }

  get position() { return this.group.position; }

  drive(throttle, turn, dt) {
    this.lastThrottle = throttle;
    this._lastTurn = turn;
    this.heading += turn * this.turnSpeed * dt;
    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // 履带损坏→严重减速；发动机损坏→中度减速
    const mul = (this.modules.track > 0 ? 0.25 : 1) * (this.modules.engine > 0 ? 0.5 : 1);
    const sp = (throttle >= 0 ? this.maxSpeed : this.maxSpeed * 0.6) * throttle * mul;
    this.group.position.addScaledVector(forward, sp * dt);
    const lim = this.worldSize;
    this.group.position.x = clamp(this.group.position.x, -lim, lim);
    this.group.position.z = clamp(this.group.position.z, -lim, lim);
    this.group.position.y = terrainHeight(this.group.position.x, this.group.position.z); // 贴地
    // 车体姿态：按地形法线倾斜（爬坡时俯仰、侧坡时侧倾）。航向 + 贴坡一起进 group.quaternion。
    const px = this.group.position.x, pz = this.group.position.z, dd = 1.2;
    _tankN.set(terrainHeight(px - dd, pz) - terrainHeight(px + dd, pz), 2 * dd, terrainHeight(px, pz - dd) - terrainHeight(px, pz + dd)).normalize();
    _tankFwd.set(Math.sin(this.heading), 0, Math.cos(this.heading)); // 水平航向
    _tankFwd.addScaledVector(_tankN, -_tankFwd.dot(_tankN)).normalize(); // 投到坡面 = 实际爬坡朝向
    _tankRight.crossVectors(_tankN, _tankFwd).normalize();
    this.group.quaternion.setFromRotationMatrix(_tankM.makeBasis(_tankRight, _tankN, _tankFwd));
  }

  // worldPoint：世界锁定瞄准点。炮塔偏航恒速 slew 向它、对齐即停；
  // 炮管俯仰直接瞄向该点（自动压炮打近/低处目标，范围更大）。rotation.x 正值=炮口下压。
  aimTurretAt(worldPoint, dt, elevInput = 0) {
    const dx = worldPoint.x - this.group.position.x;
    const dz = worldPoint.z - this.group.position.z;
    const horiz = Math.sqrt(dx * dx + dz * dz) || 0.0001;
    const desiredWorldHeading = Math.atan2(dx, dz);
    const desiredYaw = desiredWorldHeading - this.heading;
    // 恒速 slew：转速可控（不甩），对齐到 0.5° 内即停，红环与十字重合就不动。
    let diff = desiredYaw - this.turretYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const speed = Math.max(1.0, this.turretSpeed * 1.5); // rad/s（重型车更慢）
    if (Math.abs(diff) < 0.009) this.turretYaw = desiredYaw;
    else this.turretYaw += clamp(diff, -speed * dt, speed * dt);
    // 炮管俯仰：瞄向瞄准点本身——近/低处自动大角度压炮，远处水平，高处抬头。
    const muzzleY = this.group.position.y + 2.0;
    const targetPitch = clamp(Math.atan2(muzzleY - worldPoint.y, horiz), -0.4, 0.4);
    this.barrelPitch += (targetPitch - this.barrelPitch) * Math.min(1, 8 * dt);
  }

  getBarrelDir() {
    const q = new THREE.Quaternion();
    this.barrelPivot.getWorldQuaternion(q);
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  }

  getMuzzleWorld(target = new THREE.Vector3()) { return this.muzzle.getWorldPosition(target); }
  get turretWorldYaw() { return this.heading + this.turretYaw; }

  _spread(dir, s) {
    if (!s) return dir;
    const d = dir.clone();
    d.x += randRange(-s, s);
    d.y += randRange(-s, s) * 0.5;
    d.z += randRange(-s, s);
    return d.normalize();
  }

  update(dt) {
    if (this.reloadTimer > 0) this.reloadTimer -= dt;
    if (this.mgTimer > 0) this.mgTimer -= dt;
    if (this.burning && this.alive) {
      this.health -= CONFIG.rules.crit.burnDps * dt;
      if (this.health <= 0) { this.health = 0; this.alive = false; }
    }
    // 起火冒黑烟（从炮塔顶部冒出）
    if (this.burning && this.alive && this.em) {
      this.smokeTimer = (this.smokeTimer || 0) - dt;
      if (this.smokeTimer <= 0) {
        const p = this.position.clone().add(new THREE.Vector3(randRange(-1, 1), 2.4, randRange(-1, 1)));
        this.em.addEffect(new Smoke(p, 0x2b2820, 0.7, 1.5, 1.6));
        this.smokeTimer = 0.07;
      }
    }
    if (this.extCooldown > 0) this.extCooldown -= dt;
    // 模块损伤自动修复（倒数）
    if (this.modules) for (const k in this.modules) if (this.modules[k] > 0) this.modules[k] = Math.max(0, this.modules[k] - dt);
    // 履带差速滚动：左履带=油门-转向、右履带=油门+转向
    if (this.trackMatL) this.trackMatL.map.offset.y += ((this.lastThrottle || 0) * 1.5 - (this._lastTurn || 0) * 1.2) * dt;
    if (this.trackMatR) this.trackMatR.map.offset.y += ((this.lastThrottle || 0) * 1.5 + (this._lastTurn || 0) * 1.2) * dt;
    // 炮塔反旋转：抵消车体贴坡倾斜，让炮塔在世界系保持水平、按 heading+turretYaw 朝向（瞄准不受地形影响）
    _tankWQ.setFromAxisAngle(_tankY, this.heading + this.turretYaw);
    this.turret.quaternion.copy(_tankQ.copy(this.group.quaternion).invert()).multiply(_tankWQ);
    this.barrelPivot.rotation.x = this.barrelPitch;
    const frac = Math.max(0, this.health / this.maxHealth);
    this.healthFg.scale.x = frac;
    this.healthFg.position.x = -(1 - frac) * 1.5;
  }

  canFire() { return this.alive && this.reloadTimer <= 0 && this.modules.barrel <= 0; }

  tryFire(em) {
    if (!this.canFire()) return false;
    const muzzleWorld = this.getMuzzleWorld();
    const dir = this._spread(this.getBarrelDir(), this.fireSpread);
    em.addProjectile(new Projectile({
      position: muzzleWorld, direction: dir,
      speed: CONFIG.tank.shellSpeed, damage: this.shellDamage,
      owner: this, ownerTeam: this.team,
      gravity: CONFIG.tank.shellGravity, life: CONFIG.tank.shellLife,
      color: this.team === 'blue' ? 0xffe08a : 0xff7755, size: 0.45,
    }));
    em.addEffect(new MuzzleFlash(muzzleWorld));
    this.reloadTimer = this.reloadTime;
    return true;
  }

  tryFireMG(em) {
    if (!this.alive || this.mgTimer > 0) return false;
    const muzzleWorld = this.getMuzzleWorld();
    const dir = this._spread(this.getBarrelDir(), this.fireSpread);
    em.addProjectile(new Projectile({
      position: muzzleWorld, direction: dir,
      speed: 160, damage: 4, owner: this, ownerTeam: this.team,
      gravity: 4, life: 1.2, color: 0xffe9a0, size: 0.18,
    }));
    this.mgTimer = 0.1;
    return true;
  }

  // 战争雷霆式命中：弹药殉爆（秒杀）/起火/模块损坏，否则普通扣血。
  onHit(damage) {
    if (!this.alive) return;
    const r = Math.random();
    const c = CONFIG.rules.crit;
    if (r < c.tankInstant) { this.lastCrit = '弹药殉爆'; this.takeDamage(this.health); }
    else {
      this.takeDamage(damage);
      if (r < c.tankFire) { this.burning = true; this.lastCrit = '起火'; }
      else {
        // 模块损伤：履带/炮管/发动机，命中即损坏、若干秒后自动修复
        const m = Math.random();
        if (m < 0.22) { this.modules.track = 6; this.lastCrit = '履带断裂'; }
        else if (m < 0.36) { this.modules.barrel = 5; this.lastCrit = '炮管卡死'; }
        else if (m < 0.46) { this.modules.engine = 7; this.lastCrit = '发动机受损'; }
        else this.lastCrit = null;
      }
    }
  }

  takeDamage(d) {
    this.health -= d;
    if (this.health <= 0) { this.health = 0; this.alive = false; }
  }

  // 灭火：起火时使用，8 秒冷却。返回 true=已灭火，false=未起火，null=冷却中。
  tryExtinguish() {
    if (this.extCooldown > 0) return null;
    if (!this.burning) return false;
    this.burning = false;
    this.extCooldown = 8;
    return true;
  }

  isDead() { return this.health <= 0; }
  get reloadFraction() { return clamp(1 - this.reloadTimer / this.reloadTime, 0, 1); }

  faceCamera(camera) {
    this.healthBar.lookAt(camera.position);
    this.healthBar.visible = this.health < this.maxHealth;
  }
}


// ===== js/entities/Plane.js =====





const INST = {
  bankK: 1.3, maxBank: 1.15, rollK: 3.0, rollRate: 3.2,
  yawGain: 1.7, pitchK: 3.0, pitchRate: 2.2, maxPitch: 0.7,
};

// 飞机：街机飞行 + 飞行教官（鼠标指哪飞哪、自动改平）。
// team: 'blue' | 'red'。type 决定型号（造型 + 性能）。

// 每种型号的几何：fuse[机身长,半径]、wing 翼展、sweep 后掠、prop 螺旋桨、engines 发动机数。
const PGEOM = {
  fighter:   { fuse:[6.5, 0.55], wing:8.5,  sweep:0.0,  prop:true,  engines:1 },
  trainer:   { fuse:[5.5, 0.45], wing:7.5,  sweep:0.0,  prop:true,  engines:1 },
  intercept: { fuse:[8.0, 0.55], wing:9.5,  sweep:0.35, prop:true,  engines:1 },
  heavy:     { fuse:[8.5, 0.7 ], wing:12.0, sweep:0.1,  prop:true,  engines:2 },
  attacker:  { fuse:[6.0, 0.78], wing:10.5, sweep:0.0,  prop:true,  engines:1 },
  jet:       { fuse:[8.5, 0.5 ], wing:9.0,  sweep:0.6,  prop:false, engines:1 },
};
class Plane {
  constructor({ side = 'player', team = 'blue', color = 0x3a6b9e, type = 'fighter' } = {}) {
    this.side = side;
    this.team = team;
    this.color = color;
    this.type = type;
    const pt = planeTypeById(type);
    this.typeName = pt.name;
    this.group = new THREE.Group();

    const isEnemy = team === 'red';
    this.maxHealth = (isEnemy ? CONFIG.plane.enemyHealth : CONFIG.plane.maxHealth) * pt.hp;
    this.health = this.maxHealth;
    this.speedMult = pt.speed;
    this.speed = (CONFIG.plane.minSpeed + CONFIG.plane.maxSpeed) / 2 * pt.speed;
    this.agility = pt.agi;
    this.throttle = 0.6;
    this.reloadTimer = 0;
    this.alive = true;
    this.radius = CONFIG.plane.radius;
    this.worldSize = CONFIG.plane.worldSize;
    this.propSpin = 0;
    this.burning = false;
    this.lastCrit = null;
    this.extCooldown = 0;
    this._lastAttacker = null;

    this.fireCooldown = isEnemy ? CONFIG.plane.enemyFireCooldown : CONFIG.plane.fireCooldown;
    this.bulletDamage = (isEnemy ? CONFIG.plane.enemyBulletDamage : CONFIG.plane.bulletDamage) * pt.dmg;
    this.fireSpread = isEnemy ? CONFIG.plane.enemySpread : (side === 'ally' ? 0.02 : 0);

    // 导弹（仅玩家的喷气机）：敌方/队友一律无机弹
    const mc = CONFIG.plane.missile;
    this.maxMissiles = (type === 'jet' && side === 'player') ? mc.count : 0;
    this.missiles = this.maxMissiles;
    this.missileCooldown = 0;
    this.missileRegen = 0;

    this._build();
  }

  _build() {
    const g = PGEOM[this.type] || PGEOM.fighter;
    const mat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.5, metalness: 0.4, map: camoTexture() });
    this.bodyMat = mat; // 损伤可视化：起火时把机身材质焦化
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x232323, roughness: 0.7, metalness: 0.3 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xb8e0f0, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.65 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.9 });
    const redMat = new THREE.MeshBasicMaterial({ color: 0xff3333 });
    const grnMat = new THREE.MeshBasicMaterial({ color: 0x33ff66 });

    const [fuseL, fuseR] = g.fuse;
    const halfL = fuseL / 2;
    const sweep = g.sweep;
    const dihedral = 0.2; // 上反角（翼尖上翘，更有战机感）

    // 机身（更尖的尾锥度）+ 加长机头锥
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(fuseR * 0.96, fuseR * 0.62, fuseL, 16), mat);
    fuselage.rotation.x = Math.PI / 2; fuselage.castShadow = true; this.group.add(fuselage);
    const noseLen = fuseR * 2.6;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(fuseR * 0.96, noseLen, 16), mat);
    nose.rotation.x = Math.PI / 2; nose.position.z = halfL + noseLen / 2; nose.castShadow = true; this.group.add(nose);

    // 流线座舱（拉长水滴形）+ 暗色舱框
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(fuseR * 1.0, 14, 10), glassMat);
    canopy.position.set(0, fuseR * 0.85, halfL * 0.18); canopy.scale.set(0.72, 0.62, 1.9); this.group.add(canopy);
    const canopyRail = new THREE.Mesh(new THREE.BoxGeometry(fuseR * 1.5, 0.06, fuseR * 3.4), darkMat);
    canopyRail.position.set(0, fuseR * 0.62, halfL * 0.16); this.group.add(canopyRail);

    // 梯形翼几何：根部翼弦长、翼尖翼弦短（mkWing 半翼从 x=0 延伸到 x=span）
    const rootChord = fuseL * 0.26, tipChord = rootChord * 0.38, thick = Math.max(0.14, fuseR * 0.42);
    const halfSpan = g.wing / 2;
    const mkWing = (span, rc, tc, t) => {
      const geo = new THREE.BufferGeometry();
      const yb = -t / 2, yt = t / 2;
      const v = [
        [0, yb, rc / 2], [0, yb, -rc / 2], [span, yb, -tc / 2], [span, yb, tc / 2],
        [0, yt, rc / 2], [0, yt, -rc / 2], [span, yt, -tc / 2], [span, yt, tc / 2],
      ];
      const arr = []; for (const p of v) arr.push(p[0], p[1], p[2]);
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      geo.setIndex([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 2, 7, 3, 2, 6, 7, 1, 6, 2, 1, 5, 6, 0, 3, 7, 0, 7, 4]);
      geo.computeVertexNormals();
      return geo;
    };
    // 单侧主翼：外层管上反角（≈世界 Z 轴），内层管后掠；翼尖灯与翼下挂架都挂在翼上随之变形
    const addWing = (side) => {
      const geo = mkWing(halfSpan, rootChord, tipChord, thick);
      if (side < 0) { geo.scale(-1, 1, 1); geo.computeVertexNormals(); }
      const wing = new THREE.Mesh(geo, mat); wing.castShadow = true;
      const dih = new THREE.Group(); dih.rotation.z = side * dihedral;
      const swp = new THREE.Group(); swp.rotation.y = side * sweep;
      swp.add(wing); dih.add(swp); this.group.add(dih);
      // 翼尖航行灯：左红右绿
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), side < 0 ? redMat : grnMat);
      tip.position.set(side * halfSpan, 0, 0); swp.add(tip);
      // 翼下挂架 + 导弹（每侧两枚）
      for (let k = 0; k < 2; k++) {
        const px = side * halfSpan * (0.45 + k * 0.32);
        const y0 = -thick - 0.2;
        const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.5), darkMat);
        pylon.position.set(px, y0, 0); swp.add(pylon);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.6, 10), darkMat);
        body.rotation.x = Math.PI / 2; body.position.set(px, y0 - 0.35, 0); swp.add(body);
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 10), darkMat);
        head.rotation.x = Math.PI / 2; head.position.set(px, y0 - 0.35, 0.9); swp.add(head);
        const ffin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.5), darkMat);
        ffin.position.set(px, y0 - 0.25, -0.7); swp.add(ffin);
      }
    };
    addWing(1); addWing(-1);

    // 平尾：单片矩形翼（翼弦均匀、零后掠），从任何角度看都是一块横平的长方形，不歪
    const tChord = rootChord * 0.7, tThick = Math.max(0.13, fuseR * 0.3), tSpan = g.wing * 0.36;
    const tailH = new THREE.Mesh(new THREE.BoxGeometry(tSpan, tThick, tChord), mat);
    tailH.position.set(0, 0, -halfL * 0.78); tailH.castShadow = true;
    this.group.add(tailH);

    // 垂尾：以底边为支点绕 X 轴后掠（真后掠，不再用 Y 旋转把它 yaw 歪）+ 背鳍
    const finGroup = new THREE.Group();
    finGroup.position.set(0, fuseR * 0.55, -halfL * 0.74);
    const finH = fuseR * 2.4, finRC = fuseL * 0.2, finTC = finRC * 0.45;
    const finGeo = mkWing(finH, finRC, finTC, Math.max(0.12, fuseR * 0.34));
    finGeo.rotateZ(Math.PI / 2);          // 从水平转到竖直平面
    finGeo.translate(0, finRC * 0.5, 0);  // 底边放到支点
    const fin = new THREE.Mesh(finGeo, mat); fin.castShadow = true; finGroup.add(fin);
    const dorsalGeo = mkWing(fuseL * 0.16, fuseR * 0.7, fuseR * 0.25, Math.max(0.1, fuseR * 0.28));
    dorsalGeo.rotateZ(Math.PI / 2);
    const dorsal = new THREE.Mesh(dorsalGeo, mat); // 小件不投影，省阴影开销
    dorsal.position.set(0, 0, fuseL * 0.12); finGroup.add(dorsal);
    finGroup.rotation.x = -0.3 - sweep * 0.5; // 整组后掠随机型：直翼机垂尾也少后掠
    this.group.add(finGroup);

    // 螺旋桨（三叶 + 整流罩）/ 喷气（喷管 + 加力焰）
    if (g.prop) {
      this.propeller = new THREE.Group();
      const br = fuseR * 2.2;
      for (let i = 0; i < 3; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.16, br, 0.09), darkMat);
        blade.position.y = br / 2;
        const hub = new THREE.Group(); hub.rotation.z = (i / 3) * Math.PI * 2; hub.add(blade);
        this.propeller.add(hub);
      }
      const spinner = new THREE.Mesh(new THREE.ConeGeometry(fuseR * 0.55, fuseR * 1.3, 16), mat);
      spinner.rotation.x = Math.PI / 2; spinner.position.z = fuseR * 0.55; this.propeller.add(spinner);
      this.propeller.position.z = halfL + fuseR * 0.2;
      this.group.add(this.propeller);
      this.afterburner = null;
    } else {
      this.propeller = null;
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(fuseR * 0.62, fuseR * 0.42, fuseR * 1.8, 12), darkMat);
      ex.rotation.x = Math.PI / 2; ex.position.z = -halfL - fuseR * 0.5; this.group.add(ex);
      const ab = new THREE.Mesh(new THREE.ConeGeometry(fuseR * 0.42, fuseR * 2.4, 12), glowMat);
      ab.rotation.x = -Math.PI / 2; ab.position.z = -halfL - fuseR * 1.5; this.group.add(ab);
      this.afterburner = ab;
    }

    // 双发机型：翼下发动机舱
    if (g.engines === 2) {
      for (const sx of [-1, 1]) {
        const nac = new THREE.Mesh(new THREE.CylinderGeometry(fuseR * 0.55, fuseR * 0.45, fuseL * 0.42, 12), darkMat);
        nac.rotation.x = Math.PI / 2; nac.position.set(sx * g.wing * 0.3, -fuseR * 0.35, 0); nac.castShadow = true; this.group.add(nac);
      }
    }

    // 机翼机枪口（双翼机炮向 120m 处汇聚）
    this.muzzleL = new THREE.Object3D(); this.muzzleL.position.set(-g.wing * 0.4, 0, halfL * 0.2);
    this.muzzleR = new THREE.Object3D(); this.muzzleR.position.set( g.wing * 0.4, 0, halfL * 0.2);
    this.group.add(this.muzzleL, this.muzzleR);
  }

  get position() { return this.group.position; }
  forwardVector() { return new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion); }
  getPitch() { return Math.asin(clamp(this.forwardVector().y, -1, 1)); }
  getBank() {
    const q = this.group.quaternion;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    return Math.atan2(-right.y, up.y);
  }
  setThrottleInput(delta, dt) { this.throttle = clamp(this.throttle + delta * dt, 0, 1); }

  aimToward(desiredDir, dt, bankScale = 1) {
    const fwd = this.forwardVector();
    const desiredYaw = Math.atan2(desiredDir.x, desiredDir.z);
    const curYaw = Math.atan2(fwd.x, fwd.z);
    let yawErr = desiredYaw - curYaw;
    yawErr = Math.atan2(Math.sin(yawErr), Math.cos(yawErr));
    const targetBank = clamp(yawErr * INST.bankK, -INST.maxBank, INST.maxBank) * bankScale;
    const targetPitch = clamp(Math.asin(clamp(desiredDir.y, -1, 1)), -INST.maxPitch, INST.maxPitch);
    const bank = this.getBank();
    const pitch = this.getPitch();
    const q = this.group.quaternion;
    const rot = (axis, ang) => q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
    rot(new THREE.Vector3(0, 0, 1), -clamp((targetBank - bank) * INST.rollK, -1, 1) * INST.rollRate * (this.agility || 1) * dt);
    // 协调转弯：绕世界竖直轴偏航，避免侧滑掉高度（保证转向时仍能爬升）
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bank * INST.yawGain * (this.agility || 1) * dt));
    rot(new THREE.Vector3(1, 0, 0), -clamp((targetPitch - pitch) * INST.pitchK, -1, 1) * INST.pitchRate * (this.agility || 1) * dt);
    q.normalize();
  }

  // 玩家用：直接由光标相对屏幕中心的偏移驱动（右移→右滚右转，上移→抬头，回中→自动改平）。
  // nx 右为正、ny 上为正，范围 -1..1。方向明确，不依赖相机射线。
  mouseAim(nx, ny, dt) {
    const targetBank = clamp(nx, -1, 1) * INST.maxBank;
    const targetPitch = clamp(ny, -1, 1) * INST.maxPitch;
    const bank = this.getBank();
    const pitch = this.getPitch();
    const q = this.group.quaternion;
    const rot = (axis, ang) => q.multiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
    rot(new THREE.Vector3(0, 0, 1), -clamp((targetBank - bank) * INST.rollK, -1, 1) * INST.rollRate * (this.agility || 1) * dt);
    // 协调转弯：绕世界竖直轴偏航，避免侧滑掉高度（保证转向时仍能爬升）
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), bank * INST.yawGain * (this.agility || 1) * dt));
    rot(new THREE.Vector3(1, 0, 0), -clamp((targetPitch - pitch) * INST.pitchK, -1, 1) * INST.pitchRate * (this.agility || 1) * dt);
    q.normalize();
  }

  update(dt) {
    if (this.reloadTimer > 0) this.reloadTimer -= dt;
    if (this.missileCooldown > 0) this.missileCooldown -= dt;
    // 导弹自动补充：每 regen 秒 +1（不超过上限）
    if (this.maxMissiles > 0 && this.missiles < this.maxMissiles) {
      this.missileRegen += dt;
      if (this.missileRegen >= CONFIG.plane.missile.regen) {
        this.missileRegen = 0;
        this.missiles = Math.min(this.maxMissiles, this.missiles + 1);
      }
    }
    if (this.burning && this.alive) {
      this.health -= CONFIG.rules.crit.burnDps * dt;
      if (this.health <= 0) { this.health = 0; this.alive = false; }
    }
    if (this.extCooldown > 0) this.extCooldown -= dt;
    const target = lerp(CONFIG.plane.minSpeed, CONFIG.plane.maxSpeed, this.throttle) * this.speedMult;
    this.speed += (target - this.speed) * Math.min(1, 1.5 * dt);
    const forward = this.forwardVector();
    this.group.position.addScaledVector(forward, this.speed * dt);
    const liftFactor = clamp(this.speed / CONFIG.plane.maxSpeed, 0, 1);
    this.group.position.y -= CONFIG.plane.gravity * dt * (1 - liftFactor) * 0.5;
    const gnd = terrainHeight(this.group.position.x, this.group.position.z) + 2;
    if (this.group.position.y <= gnd) { this.group.position.y = gnd; this.health = 0; this.alive = false; }
    if (this.group.position.y > CONFIG.plane.ceiling) this.group.position.y = CONFIG.plane.ceiling;
    // 边界夹紧（不能飞出地图）
    const lim = this.worldSize;
    if (this.group.position.x > lim) this.group.position.x = lim;
    if (this.group.position.x < -lim) this.group.position.x = -lim;
    if (this.group.position.z > lim) this.group.position.z = lim;
    if (this.group.position.z < -lim) this.group.position.z = -lim;
    if (this.propeller) {
      this.propSpin += dt * (8 + this.throttle * 30);
      this.propeller.rotation.z = this.propSpin;
    }
    // 加力焰随油门：慢车几乎不见、加力时拉长抖动
    if (this.afterburner) {
      this.abPhase = (this.abPhase || 0) + dt * 22;
      const thr = 0.35 + this.throttle * 0.65;
      this.afterburner.scale.z = thr * (0.75 + Math.sin(this.abPhase) * 0.2 + Math.random() * 0.12);
      this.afterburner.material.opacity = 0.25 + this.throttle * 0.6;
    }
    // 损伤可视化：起火时机身焦化（颜色压暗 + 微红灼热），灭火后还原
    if (this.bodyMat) {
      if (!this._origColor) this._origColor = new THREE.Color(this.color);
      const target = this.burning ? 0x2a1a14 : this._origColor.getHex();
      this.bodyMat.color.lerp(new THREE.Color(target), Math.min(1, 4 * dt));
      this.bodyMat.emissive.setHex(this.burning ? 0x3a0a00 : 0x000000);
    }
    // 烟雾：起火冒黑烟；喷气机高油门高空时拉白色凝结尾迹
    if (this.em && this.alive) {
      this.smokeTimer = (this.smokeTimer || 0) - dt;
      if (this.smokeTimer <= 0) {
        const tail = this.position.clone().addScaledVector(this.forwardVector(), -this.radius * 1.6);
        if (this.burning) {
          this.em.addEffect(new Smoke(tail.clone().add(new THREE.Vector3(0, 0.6, 0)), 0x2b2820, 0.5, 1.3, 1.8));
          this.smokeTimer = 0.06;
        } else if (!this.propeller && this.throttle > 0.6 && this.group.position.y > 20) {
          this.em.addEffect(new Smoke(tail, 0xdfe8ee, 0.26, 1.1, 0.2));
          this.smokeTimer = 0.08;
        } else this.smokeTimer = 0.12;
      }
    }
  }

  _spread(dir, s) {
    if (!s) return dir;
    const d = dir.clone();
    d.x += randRange(-s, s); d.y += randRange(-s, s) * 0.5; d.z += randRange(-s, s);
    return d.normalize();
  }

  canFire() { return this.alive && this.reloadTimer <= 0; }

  tryFire(em) {
    if (!this.canFire()) return false;
    const fwd = this.forwardVector();
    const converge = this.position.clone().addScaledVector(fwd, 120); // 双翼机炮向 120m 处汇聚
    const mL = new THREE.Vector3(); this.muzzleL.getWorldPosition(mL);
    const mR = new THREE.Vector3(); this.muzzleR.getWorldPosition(mR);
    const mk = (pos) => {
      const dir = this._spread(converge.clone().sub(pos).normalize(), this.fireSpread);
      return new Projectile({
        position: pos, direction: dir,
        speed: CONFIG.plane.bulletSpeed, damage: this.bulletDamage,
        owner: this, ownerTeam: this.team,
        gravity: 0, life: CONFIG.plane.bulletLife,
        color: this.team === 'blue' ? 0xfff2a0 : 0xff8855, size: 0.22,
      });
    };
    em.addProjectile(mk(mL)); em.addProjectile(mk(mR));
    em.addEffect(new MuzzleFlash(mL, 0x222222)); em.addEffect(new MuzzleFlash(mR, 0x222222));
    this.reloadTimer = this.fireCooldown;
    return true;
  }

  // 灭火：起火时使用，8 秒冷却。返回 true=已灭火，false=未起火，null=冷却中。
  tryExtinguish() {
    if (this.extCooldown > 0) return null;
    if (!this.burning) return false;
    this.burning = false;
    this.extCooldown = 8;
    return true;
  }

  // 导弹：追踪前方最近的敌机（仅喷气机有）。返回 true=已发射。
  tryFireMissile(em, targets) {
    if (!this.alive || this.missiles <= 0 || this.missileCooldown > 0) return false;
    const fwd = this.forwardVector();
    let best = null, bestD = Infinity;
    for (const t of (targets || [])) {
      if (!t.alive || t.team === this.team) continue;
      const to = t.position.clone().sub(this.position);
      const d = to.length();
      if (d > 700) continue;
      if (fwd.dot(to.clone().normalize()) < 0.4) continue; // 需大致在前方
      if (d < bestD) { bestD = d; best = t; }
    }
    const mc = CONFIG.plane.missile;
    const dir = best ? best.position.clone().sub(this.position).normalize() : fwd;
    const proj = new Projectile({
      position: this.position.clone().addScaledVector(fwd, 2), direction: dir,
      speed: mc.speed, damage: mc.damage, owner: this, ownerTeam: this.team,
      gravity: 0, life: mc.life, color: 0xff5544, size: mc.radius,
    });
    proj.target = best; proj.homing = mc.homing;
    em.addProjectile(proj);
    this.missiles -= 1; this.missileCooldown = mc.cooldown;
    return true;
  }

  onHit(damage) {
    if (!this.alive) return;
    const r = Math.random();
    const c = CONFIG.rules.crit;
    if (r < c.planeInstant) { this.lastCrit = '飞行员阵亡'; this.takeDamage(this.health); }
    else {
      this.takeDamage(damage);
      if (r < c.planeFire) { this.burning = true; this.lastCrit = '起火'; } else this.lastCrit = null;
    }
  }

  takeDamage(d) { this.health -= d; if (this.health <= 0) { this.health = 0; this.alive = false; } }
  isDead() { return this.health <= 0; }
  get reloadFraction() { return clamp(1 - this.reloadTimer / this.fireCooldown, 0, 1); }
}


// ===== js/ai/TankAI.js =====



// 敌方坦克 AI：朝玩家移动并保持距离、绕开障碍、瞄准开火。
// 每帧由 Game 调用 update()，驱动所绑定的 Tank 实例。
class TankAI {
  constructor(tank) {
    this.tank = tank;
    this.fireDelay = 1.0 + Math.random() * 1.5; // 反应时间
  }

  update(dt, ctx) {
    const { target, entityManager: em, obstacles = [] } = ctx;
    const tank = this.tank;
    if (!tank.alive || !target || !target.alive) {
      tank.drive(0, 0, dt);
      return;
    }

    const toT = new THREE.Vector3().subVectors(target.position, tank.position);
    toT.y = 0;
    const dist = toT.length();
    const desiredHeading = Math.atan2(toT.x, toT.z);
    let headingDiff = desiredHeading - tank.heading;
    headingDiff = Math.atan2(Math.sin(headingDiff), Math.cos(headingDiff));

    // 低血撤退：背对目标、倒车拉开距离（边退边还击）
    if (tank.health / tank.maxHealth < 0.33) {
      const flee = desiredHeading + Math.PI;
      let hd = flee - tank.heading; hd = Math.atan2(Math.sin(hd), Math.cos(hd));
      tank.drive(-0.9, clamp(hd * 2, -1, 1), dt);
      tank.aimTurretAt(target.position, dt);
      if (tank.canFire() && dist < 130 && Math.random() < 0.5) tank.tryFire(em);
      return;
    }

    let turn = clamp(headingDiff * 2, -1, 1);
    // 距离控制：远了冲，近了退
    let throttle = dist > 45 ? 1 : dist > 22 ? 0.4 : -0.4;

    // 边界回拉：接近地图边缘时朝中心修正
    const lim = tank.worldSize - 40;
    if (Math.abs(tank.position.x) > lim || Math.abs(tank.position.z) > lim) {
      const toC = new THREE.Vector3(-tank.position.x, 0, -tank.position.z).normalize();
      const fwdC = new THREE.Vector3(Math.sin(tank.heading), 0, Math.cos(tank.heading));
      const rightC = new THREE.Vector3(fwdC.z, 0, -fwdC.x);
      turn += clamp(toC.dot(rightC) * 2, -1, 1);
    }

    // 障碍规避：前方近距离有障碍则转向避让
    const fwd = new THREE.Vector3(Math.sin(tank.heading), 0, Math.cos(tank.heading));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    for (const ob of obstacles) {
      const d = new THREE.Vector3().subVectors(ob.position, tank.position);
      d.y = 0;
      const dd = d.length();
      if (dd < 14) {
        const dotFwd = d.dot(fwd);
        if (dotFwd > 0) {
          const sideDist = d.dot(right);
          if (Math.abs(sideDist) < (ob.radius || 3) + 3) {
            turn += sideDist >= 0 ? -1 : 1;
            throttle *= 0.4;
          }
        }
      }
    }

    tank.drive(throttle, turn, dt);
    tank.aimTurretAt(target.position, dt);

    // 瞄准差不多了且在射程内则开火（敌方更不准）
    const worldHeading = tank.heading + tank.turretYaw;
    let aimDiff = desiredHeading - worldHeading;
    aimDiff = Math.atan2(Math.sin(aimDiff), Math.cos(aimDiff));
    const isEnemy = tank.team === 'red';
    const aimThresh = isEnemy ? 0.06 : 0.10;
    const fireChance = isEnemy ? CONFIG.tank.enemyFireChance : 0.85;
    if (tank.canFire() && dist < 160 && Math.abs(aimDiff) < aimThresh && Math.random() < fireChance) {
      tank.tryFire(em);
    }
  }
}


// ===== js/ai/PlaneAI.js =====


// 敌方飞机 AI：复用与玩家相同的"飞行教官"接口，把目标方向喂给 aimToward。
// 追到一定距离后收油门避免越过，对齐且在射程内时开火。
class PlaneAI {
  constructor(plane) {
    this.plane = plane;
  }

  update(dt, ctx) {
    const { target, entityManager: em } = ctx;
    const plane = this.plane;
    if (!plane.alive) return;
    if (!target || !target.alive) {
      plane.aimToward(new THREE.Vector3(0, -0.2, 1).normalize(), dt); // 没目标就平飞略带下俯
      return;
    }

    const toT = new THREE.Vector3().subVectors(target.position, plane.position);
    const dist = toT.length() || 1;
    const desired = toT.multiplyScalar(1 / dist);

    // 略提前量：瞄向目标稍前方
    const lead = target.forwardVector().multiplyScalar(Math.min(dist * 0.15, 20));
    const aimPt = target.position.clone().add(lead);
    const aimDir = aimPt.sub(plane.position).normalize();

    // 低血规避：周期性侧滑（jink），让玩家更难追瞄
    if (plane.health / plane.maxHealth < 0.4) {
      this._jink = (this._jink || 0) + dt * 2.2;
      const side = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0)).normalize();
      aimDir.addScaledVector(side, Math.sin(this._jink) * 0.5).normalize();
    }

    plane.aimToward(aimDir, dt, 0.6); // 敌机用更柔的坡度，便于玩家追瞄
    plane.throttle = dist > 70 ? 1 : 0.7;

    // 对齐且在射程内开火（敌方更不准）
    const fwd = plane.forwardVector();
    const isEnemy = plane.team === 'red';
    const dotThresh = isEnemy ? 0.996 : 0.99;
    const fireChance = isEnemy ? CONFIG.plane.enemyFireChance : 0.9;
    if (dist < 280 && fwd.dot(aimDir) > dotThresh && Math.random() < fireChance) {
      plane.tryFire(em);
    }
  }
}


// ===== js/world/Scene.js =====

// 创建灯光、雾、天空背景，挂到给定 scene 上。
function setupEnvironment(scene, mode) {
  // 天空色与雾
  const skyColor = mode === 'plane' ? 0x9ec9e8 : 0xbfd3c4;
  scene.background = new THREE.Color(skyColor);
  scene.fog = new THREE.Fog(skyColor, 120, mode === 'plane' ? 700 : 450);

  // 渐变天穹（天顶更深）+ 散落云团
  const top = mode === 'plane' ? 0x3f74ad : 0x6fa0c8;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1600, 24, 16),
    new THREE.MeshBasicMaterial({ map: makeSkyTexture(top, skyColor), side: THREE.BackSide, fog: false, depthWrite: false })
  );
  scene.add(dome);
  const cloudMat = new THREE.SpriteMaterial({ map: makeCloudTexture(), transparent: true, opacity: 0.85, fog: false, depthWrite: false });
  const cloudN = mode === 'plane' ? 28 : 16;
  for (let i = 0; i < cloudN; i++) {
    const s = new THREE.Sprite(cloudMat);
    const r = 120 + Math.random() * (mode === 'plane' ? 650 : 250);
    const a = Math.random() * Math.PI * 2;
    s.position.set(Math.cos(a) * r, mode === 'plane' ? 70 + Math.random() * 95 : 95 + Math.random() * 55, Math.sin(a) * r);
    const sc = 45 + Math.random() * 75; s.scale.set(sc * 1.6, sc, 1);
    scene.add(s);
  }

  // 环境光（填充阴影）
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  // 太阳（方向光），投射阴影
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.1);
  sun.position.set(80, 140, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 400;
  const s = 120;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.bias = -0.0005;
  sun.shadow.camera.updateProjectionMatrix(); // 改过视景边界后必须更新投影矩阵
  scene.add(sun);
  // 方向光目标默认在原点，跟随太阳方向照射

  // 半球光让天空与地面色调更自然
  scene.add(new THREE.HemisphereLight(skyColor, 0x55502a, 0.4));
}


// ===== js/world/Terrain.js =====



// 创建地面 + 障碍物 + 边界，返回 { group, obstacles, half }。
function createTerrain(scene, mode) {
  const group = new THREE.Group();
  const obstacles = [];

  const half = (mode === 'plane' ? CONFIG.plane.worldSize : CONFIG.tank.worldSize);

  // 地面（细分高度场 + 顶点色：低处绿、高处棕）
  const groundSize = half * 2 + 400;
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, 120, 120);
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position;
  const gcol = [];
  for (let i = 0; i < gpos.count; i++) {
    const y = terrainHeight(gpos.getX(i), gpos.getZ(i));
    gpos.setY(i, y);
    const t = clamp((y + 15) / 30, 0, 1); // -15..15 → 0..1
    gcol.push(0.36 + t * 0.30, 0.50 - t * 0.15, 0.25);
  }
  gpos.needsUpdate = true;
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gcol, 3));
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  group.add(ground);

  // 活动区域边框线
  const edgeGeo = new THREE.BufferGeometry();
  const pts = [];
  const e = half;
  pts.push(-e, 0.2, -e, e, 0.2, -e, e, 0.2, e, -e, 0.2, e, -e, 0.2, -e);
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.Line(edgeGeo, new THREE.LineBasicMaterial({ color: 0x335533 })));

  // 可见边界墙（半透明圆柱围栏）
  const wallH = mode === 'plane' ? 220 : 14;
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(half, half, wallH, 64, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x88ff99, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
  );
  wall.position.y = wallH / 2;
  group.add(wall);

  // 障碍物（数量随地图面积放大）
  const obstacleCount = Math.round((mode === 'plane' ? 24 : 40) * (half / (mode === 'plane' ? 400 : 260)));
  for (let i = 0; i < obstacleCount; i++) {
    const x = randRange(-half + 10, half - 10);
    const z = randRange(-half + 10, half - 10);
    // 避开出生点中心
    if (Math.abs(x) < 18 && Math.abs(z) < 18) continue;
    const type = Math.random();
    let mesh, radius;
    if (type < 0.4) {
      // 建筑
      const w = randRange(6, 14), h = randRange(5, 16), d = randRange(6, 14);
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: 0x8a7f6b, roughness: 0.9 })
      );
      mesh.position.set(x, h / 2 + terrainHeight(x, z), z);
      radius = Math.max(w, d) / 2;
    } else if (type < 0.7) {
      // 岩石
      const r = randRange(2, 5);
      mesh = new THREE.Mesh(
        new THREE.DodecahedronGeometry(r, 0),
        new THREE.MeshStandardMaterial({ color: 0x807872, roughness: 1, flatShading: true })
      );
      mesh.position.set(x, r * 0.7 + terrainHeight(x, z), z);
      mesh.rotation.set(randRange(0, 1), randRange(0, 1), randRange(0, 1));
      radius = r;
    } else {
      // 树（圆锥树冠 + 圆柱树干）
      const tree = new THREE.Group();
      const trunkH = randRange(3, 5);
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.7, trunkH, 6),
        new THREE.MeshStandardMaterial({ color: 0x5b4127, roughness: 1 })
      );
      trunk.position.y = trunkH / 2;
      trunk.castShadow = true;
      const leaves = new THREE.Mesh(
        new THREE.ConeGeometry(randRange(2.5, 4), randRange(5, 8), 7),
        new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 1, flatShading: true })
      );
      leaves.position.y = trunkH + 3;
      leaves.castShadow = true;
      tree.add(trunk, leaves);
      tree.position.set(x, terrainHeight(x, z), z);
      mesh = tree;
      radius = 2.5;
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    obstacles.push({ position: new THREE.Vector3(x, 0, z), radius });
  }

  scene.add(group);
  return { group, obstacles, half };
}


// ===== js/Game.js =====













// 核心引擎：战争雷霆式操控（鼠标瞄准光标）+ 规则（殉爆/起火、多条命、敌方票数与刷新波次）。
// 入口：new Game({ canvas, mode, hudContainer, onExit })。
// ===== 设置（localStorage 持久化） =====
const SETTINGS_KEY = 'wt_settings';
const DEFAULT_SETTINGS = { volume: 0.8, shadows: true, invertY: false, planeGain: 1.0 };
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

// ===== 音效（WebAudio 合成，零素材） =====
// 引擎嗡鸣（频率随油门/速度）+ 主炮/机枪/爆炸/导弹/命中/击杀/UI。一次性音按距离衰减。
class Sfx {
  constructor() {
    this.ctx = null; this.master = null; this.vol = 0.8;
    this.engine = null; this.listener = null; this.muted = false;
  }
  _ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.vol;
      this.master.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
  }
  resume() { this._ensure(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = v; }
  _distGain(pos) {
    if (!this.listener || !pos) return 1;
    const d = pos.distanceTo(this.listener.position);
    return Math.max(0, 1 - d / 240);
  }
  _noiseBuf(dur) {
    const sr = this.ctx.sampleRate, n = Math.max(1, Math.floor(sr * dur));
    const b = this.ctx.createBuffer(1, n, sr), a = b.getChannelData(0);
    for (let i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
    return b;
  }
  _oneshot(dur, type, freq, gain, pos, freqEnd) {
    if (this.muted) return;
    this._ensure(); if (!this.ctx) return;
    if (pos && this.listener && this._distGain(pos) <= 0.02) return; // 太远不发音，省节点
    const src = this.ctx.createBufferSource(); src.buffer = this._noiseBuf(dur);
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, this.ctx.currentTime);
    if (freqEnd != null) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), this.ctx.currentTime + dur);
    const g = this.ctx.createGain();
    const dg = this._distGain(pos);
    g.gain.setValueAtTime(gain * dg, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); src.stop(this.ctx.currentTime + dur);
  }
  gunshot(pos) { this._oneshot(0.22, 'lowpass', 1400, 0.55, pos, 300); }
  mg(pos) { this._oneshot(0.06, 'lowpass', 2600, 0.22, pos, 1200); }
  explosion(pos) { this._oneshot(0.7, 'lowpass', 600, 1.0, pos, 80); }
  missile(pos) { this._oneshot(0.45, 'bandpass', 900, 0.4, pos, 300); }
  _blip(freq0, freq1, dur, gain, type) {
    if (this.muted) return;
    this._ensure(); if (!this.ctx) return;
    const o = this.ctx.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(freq0, this.ctx.currentTime);
    if (freq1 != null) o.frequency.exponentialRampToValueAtTime(freq1, this.ctx.currentTime + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(gain, this.ctx.currentTime + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
    o.connect(g); g.connect(this.master); o.start(); o.stop(this.ctx.currentTime + dur + 0.02);
  }
  hit() { this._blip(900, 700, 0.08, 0.25, 'sine'); }
  kill() { this._blip(660, 990, 0.18, 0.3, 'triangle'); }
  ui() { this._blip(520, 520, 0.05, 0.18, 'square'); }
  startEngine() {
    this._ensure(); if (!this.ctx || this.engine) return;
    const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 60;
    const g = this.ctx.createGain(); g.gain.value = 0;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
    o.connect(g); g.connect(lp); lp.connect(this.master); o.start();
    this.engine = { osc: o, gain: g };
  }
  updateEngine(throttle, speed01, mode) {
    if (!this.engine) return;
    const base = mode === 'plane' ? 80 : 42;
    const f = base + throttle * 150 + speed01 * 70;
    this.engine.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.1);
    this.engine.gain.gain.setTargetAtTime(0.05 + throttle * 0.06, this.ctx.currentTime, 0.15);
  }
  stopEngine() { if (this.engine) { try { this.engine.osc.stop(); } catch (e) {} this.engine = null; } }
}

class Game {
  constructor({ canvas, mode = 'tank', difficulty = 'normal', tankType = 'medium', planeType = 'fighter', endless = false, hudContainer, onExit, onResult } = {}) {
    this.canvas = canvas;
    this.mode = mode;
    this.difficulty = difficulty;
    this.tankType = tankType;
    this.planeType = planeType;
    this.endless = endless;
    this.onExit = onExit;
    this.onResult = onResult;
    this.state = 'playing';
    this.settings = loadSettings();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 3000);

    setupEnvironment(this.scene, mode);

    this.input = new Input(canvas);
    // 两种模式都：点击画面进入指针锁定，光标不会飞出窗口
    // （坦克=炮塔无限转；飞机=虚拟瞄准点指哪飞哪）。
    // 监听 document 上的 mousedown，确保点击 HUD 覆盖区域也能锁定（HUD 本身 pointer-events:none）。
    this._pointerLocked = false;
    // 用 click（而非 mousedown）请求指针锁：mousedown 触发的 requestPointerLock 在
    // Chromium/Electron 首次常因焦点/手势时序失败（静默 reject）；click 是完整手势、首次即锁，
    // 也和本 app 其他游戏一致（它们用 click，无需点两次）。
    this._onDocClickPL = (e) => {
      if (this.state !== 'playing' || this._disposed) return;
      if (document.pointerLockElement === this.canvas) return;
      if (e.button !== 0) return; // 只响应左键（右键 click 不会触发，防御一下）
      try {
        const p = this.canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {}); // 失败则下次点击重试
      } catch (err) {}
    };
    document.addEventListener('click', this._onDocClickPL);
    // 指针锁定状态变化跟踪：用于在坦克模式显示/隐藏"点击锁定"提示，
    // 并按真实锁定状态切换光标——没锁上时显示十字光标，玩家能立刻看出"还没锁、需再点"
    // （原来 CSS 永久 cursor:none，锁失败也看不见，造成"以为锁了却转不动"）。
    this.canvas.style.cursor = 'crosshair';
    this._onPLChange = () => {
      this._pointerLocked = (document.pointerLockElement === this.canvas);
      this.canvas.style.cursor = this._pointerLocked ? 'none' : 'crosshair';
      if (this._pointerLocked) {
        // 刚锁定：清掉锁定前累积的鼠标移动 + 重置基点，避免第一帧炮塔/瞄准跳变
        this.input.mvX = 0; this.input.mvY = 0;
        this._lastMx = this.input.mouseX; this._lastMy = this.input.mouseY;
      }
    };
    document.addEventListener('pointerlockchange', this._onPLChange);
    this.hud = new HUD(hudContainer);
    this.em = new EntityManager(this.scene);
    this.sfx = new Sfx();
    this.sfx.setVolume(this.settings.volume);
    this.sfx.listener = this.camera;
    this.em.sfx = this.sfx;
    this.em.listener = this.camera;

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._tmpDir = new THREE.Vector3();

    this._onResize = () => this._handleResize();
    window.addEventListener('resize', this._onResize);

    this._setupHint();
    this.clock = new THREE.Clock();
    this._initMatch(mode);

    this._raf = requestAnimationFrame(this._animate);
  }

  _setupHint() {
    if (this.mode === 'tank') {
      this.hud.setHint('<b>点击画面锁定鼠标</b>（炮塔可无限转，Esc 解锁）· <b>WASD</b> 车体 · <b>左键</b>主炮 · <b>空格</b>机枪 · <b>C</b>瞄准镜 · <b>F</b>灭火');
    } else {
      this.hud.setHint('<b>点击画面锁定鼠标</b>（指哪飞哪，自动改平，Esc 解锁）· <b>W/S</b>油门 · <b>Shift</b>加力 · <b>左键</b>开火 · <b>右键/X</b>导弹(喷气机) · <b>F</b>灭火');
    }
  }

  _entityLabel() { return this.mode === 'tank' ? '坦克' : '飞机'; }

  // 按键“按下边沿”检测（按住只触发一次），避免连发。
  _consumePress(inp, code) {
    const key = '_prev_' + code;
    const now = inp.isDown(code);
    const edge = now && !this[key];
    this[key] = now;
    return edge;
  }

  _extinguish(v) {
    const r = v.tryExtinguish();
    if (r === true) this.hud.addFeed('🔥 已灭火', 'info');
    else if (r === null) this.hud.addFeed('灭火器冷却中', 'info');
  }

  // —— 比赛初始化 ——
  _initMatch(mode) {
    applyDifficulty(this.difficulty); // 按难度重算 CONFIG
    this.terrain = createTerrain(this.scene, mode);
    const R = CONFIG.rules;
    this.kills = 0;
    this.playerLives = R.playerLives;
    this.enemyTickets = this.endless ? Infinity : (mode === 'tank' ? R.tankTickets : R.planeTickets);
    this.enemiesToSpawn = this.enemyTickets;
    this.respawnTimer = -1;       // 玩家重生倒计时，-1 表示无
    this._enemySpawnTimer = -1;   // 敌方刷新倒计时
    this._allySpawnTimer = -1;    // 队友刷新倒计时
    this.allyCount = R.allyCount; // 同屏队友数（受难度影响）
    this._snapCam = true;
    this.state = 'playing';
    this.enemies = [];
    this.allies = [];

    this._makePlayer();

    // 初始铺一波敌人
    const initial = Math.min(R.maxConcurrentEnemies, this.enemyTickets);
    for (let i = 0; i < initial; i++) this._spawnEnemy();
    this.enemiesToSpawn = this.enemyTickets - initial;

    // 初始队友
    for (let i = 0; i < this.allyCount; i++) this._spawnAlly();

    this.hud.setCenterMessage('');
    this.hud.addFeed('战斗开始 · 队友已就位', 'info');
  }

  _playerBasePos() {
    if (this.mode === 'tank') return new THREE.Vector3(0, 0, 0);
    return new THREE.Vector3(0, CONFIG.plane.spawnAltitude, 0);
  }

  _makePlayer() {
    const base = this._playerBasePos();
    if (this.mode === 'tank') {
      this.player = new Tank({ side: 'player', color: 0x4f7a3a, type: this.tankType });
      this.player.group.position.copy(base);
      this.player.heading = 0;
      this.em.addTank(this.player);
    } else {
      this.player = new Plane({ side: 'player', color: 0x3a6b9e, type: this.planeType });
      this.player.group.position.copy(base);
      this.player.group.quaternion.identity();
      this.em.addPlane(this.player);
    }
    this.gunnerView = false;
    this._snapCam = true;
    // 预置相机位置，避免第一帧输入用到默认相机（0,0,0）
    if (this.mode === 'tank') this._updateCameraTank(0.016);
    else this._updateCameraPlane(0.016);
    this.hud.showCrosshair();               // 出生/复活：准星回来
  }

  _spawnEnemy() {
    if (this.mode === 'tank') {
      const ang = randRange(0, Math.PI * 2);
      const dist = randRange(80, 140);
      const e = new Tank({ side: 'enemy', team: 'red', color: 0x9a7b3e, type: randomTankType().id });
      e.group.position.set(Math.sin(ang) * dist, 0, Math.cos(ang) * dist);
      e.heading = Math.atan2(-e.group.position.x, -e.group.position.z);
      e.ai = new TankAI(e);
      this.em.addTank(e);
      this.enemies.push(e);
    } else {
      const ang = randRange(0, Math.PI * 2);
      const dist = randRange(150, 220);
      const e = new Plane({ side: 'enemy', team: 'red', color: 0xb5462e, type: randomPlaneType().id });
      e.group.position.set(Math.sin(ang) * dist, CONFIG.plane.spawnAltitude + randRange(-10, 12), Math.cos(ang) * dist);
      const toCenter = this._playerBasePos().clone().sub(e.group.position).normalize();
      e.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toCenter);
      e.ai = new PlaneAI(e);
      this.em.addPlane(e);
      this.enemies.push(e);
    }
    // 无尽模式：随击杀数提升敌方血量（递增难度）
    if (this.endless) {
      const k = 1 + Math.floor(this.kills / 12) * 0.15;
      const e = this.enemies[this.enemies.length - 1];
      if (e) { e.maxHealth *= k; e.health = e.maxHealth; }
    }
  }

  // 精英/Boss 敌方载具：体型更大、血量/伤害更高。
  _spawnBoss() {
    this._spawnEnemy();
    const e = this.enemies[this.enemies.length - 1];
    if (!e) return;
    e.isBoss = true;
    e.maxHealth *= 5; e.health = e.maxHealth;
    e.group.scale.setScalar(1.6);
    if (this.mode === 'tank') { e.maxSpeed *= 1.15; if (e.shellDamage != null) e.shellDamage *= 1.5; }
    else { e.speedMult *= 1.15; if (e.bulletDamage != null) e.bulletDamage *= 1.5; }
    this.hud.addFeed('⚠ 精英敌方载具出现！', 'kill');
  }
  _spawnAlly() {
    if (this.mode === 'tank') {
      const e = new Tank({ side: 'ally', team: 'blue', color: 0x3a6b8a, type: randomTankType().id });
      e.group.position.set(randRange(-18, 18), 0, randRange(-18, 18));
      e.heading = randRange(0, Math.PI * 2);
      e.ai = new TankAI(e);
      this.em.addTank(e);
      this.allies.push(e);
    } else {
      const e = new Plane({ side: 'ally', team: 'blue', color: 0x5a8eb8, type: randomPlaneType().id });
      e.group.position.set(randRange(-30, 30), CONFIG.plane.spawnAltitude + randRange(-8, 8), randRange(-30, 30));
      e.group.quaternion.identity();
      e.ai = new PlaneAI(e);
      this.em.addPlane(e);
      this.allies.push(e);
    }
  }

  _nearest(pos, list) {
    let best = null, bestD = Infinity;
    for (const c of list) {
      if (!c || !c.alive) continue;
      const d = pos.distanceToSquared(c.position);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  // —— 输入 ——
  _handleInputTank(dt) {
    const inp = this.input;
    const t = this.player;
    if (!t.alive) return;
    let throttle = 0, turn = 0;
    if (inp.isDown('KeyW')) throttle += 1;
    if (inp.isDown('KeyS')) throttle -= 1;
    if (inp.isDown('KeyA')) turn += 1;
    if (inp.isDown('KeyD')) turn -= 1;
    t.drive(throttle, turn, dt);

    // 战争雷霆炮手式：鼠标按"增量"移动瞄准点（从当前瞄准处平滑旋转，不跳到绝对世界点）。
    // 指针锁定时用 movement（无限旋转）；未锁定时用 clientX 差值（保证总能转，只是到屏幕边缘为止）。
    const YAW_SENS = 0.0026, H_SENS = 0.06, R = 90;
    let mdx, mdy;
    if (document.pointerLockElement === this.canvas) {
      const mv = inp.consumeMovement(); mdx = mv.x; mdy = mv.y;
    } else {
      inp.consumeMovement(); // 清掉残留
      mdx = inp.mouseX - (this._lastMx ?? inp.mouseX);
      mdy = inp.mouseY - (this._lastMy ?? inp.mouseY);
    }
    this._lastMx = inp.mouseX; this._lastMy = inp.mouseY;
    this._aimYaw = (this._aimYaw ?? t.heading) - mdx * YAW_SENS;       // 鼠标左右 → 瞄准方位
    this._aimHeight = clamp((this._aimHeight ?? 0) - mdy * H_SENS, -28, 28); // 鼠标上下 → 抬炮/压炮
    this._tankAimPt = t.position.clone().add(new THREE.Vector3(Math.sin(this._aimYaw) * R, 2 + this._aimHeight, Math.cos(this._aimYaw) * R));
    t.aimTurretAt(this._tankAimPt, dt, 0);

    if (inp.mouseDown) t.tryFire(this.em);
    if (inp.isDown('Space')) t.tryFireMG(this.em);
    if (this._consumePress(inp, 'KeyF')) this._extinguish(t);
    this.gunnerView = inp.isDown('KeyC');
  }

  _handleInputPlane(dt) {
    const inp = this.input;
    const p = this.player;
    if (!p.alive) return;
    // 指针锁定时用"虚拟瞄准点"（累积鼠标移动，光标不会飞出窗口）；未锁定时用光标绝对位置。
    let ndc;
    if (document.pointerLockElement === this.canvas) {
      const mv = inp.consumeMovement();
      ndc = inp.aimVirtualNDC(mv.x, mv.y, 0.003);
    } else {
      inp.consumeMovement();
      ndc = inp.getNDC();
    }
    this._planeAimNDC = ndc;   // 供 _animate 把准星画在虚拟瞄准点（指针锁定后 clientX/Y 会冻结）
    const ny = this.settings.invertY ? -ndc.y : ndc.y;
    p.mouseAim(-ndc.x * this.settings.planeGain, ny * this.settings.planeGain, dt); // 水平方向校准：光标左移→左转

    if (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) {
      p.throttle = 1;
    } else {
      let td = 0;
      if (inp.isDown('KeyW')) td += 1;
      if (inp.isDown('KeyS')) td -= 1;
      p.setThrottleInput(td, dt);
    }
    if (inp.mouseDown) p.tryFire(this.em);
    if (this._consumePress(inp, 'KeyF')) this._extinguish(p);
    // 导弹（喷气机）：右键或 X
    if ((inp.rightMouseDown || inp.isDown('KeyX')) && p.missiles > 0) {
      if (p.tryFireMissile(this.em, this.enemies)) { this.hud.addFeed(`🚀 导弹 ${p.missiles}/${p.maxMissiles}`, 'info'); this.sfx.missile(p.position); }
    }
  }

  // 光标射线打地面，返回相机前方的命中点（用于坦克炮塔瞄准）。
  _groundAimPoint() {
    const ndc = this.input.getNDC();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    this.camera.getWorldDirection(this._tmpDir);
    if (this._tmpDir.dot(hit.clone().sub(this.camera.position)) <= 0) return null; // 落在相机后方则忽略
    return hit;
  }

  // —— 相机 ——
  _setFov(target, dt) {
    this.camera.fov += (target - this.camera.fov) * Math.min(1, 12 * dt);
    this.camera.updateProjectionMatrix();
  }

  _updateCameraTank(dt) {
    const t = this.player;
    if (this.gunnerView) {
      const muzzle = t.getMuzzleWorld();
      const dir = t.getBarrelDir();
      const desired = muzzle.clone().addScaledVector(dir, -1.8).add(new THREE.Vector3(0, 0.15, 0));
      if (this._snapCam) { this.camera.position.copy(desired); this._snapCam = false; }
      else this.camera.position.lerp(desired, 0.5);
      this.camera.lookAt(muzzle.clone().addScaledVector(dir, 60));
      this._setFov(26, dt);
    } else {
      // 相机跟炮塔方位(turretWorldYaw)并贴坡倾斜；瞄准方向=炮膛指向(再叠加炮管俯仰 barrelPitch)，
      // 使屏幕正中十字随抬炮/压炮上下移动（正中准星=炮口指向）。
      const tw = t.turretWorldYaw;
      const bp = t.barrelPitch || 0;          // 正值=炮口下压
      const tp = t.position;
      const dd = 1.2;
      _tankN.set(terrainHeight(tp.x - dd, tp.z) - terrainHeight(tp.x + dd, tp.z), 2 * dd, terrainHeight(tp.x, tp.z - dd) - terrainHeight(tp.x, tp.z + dd)).normalize();
      _tankFwd.set(Math.sin(tw), 0, Math.cos(tw));
      _tankFwd.addScaledVector(_tankN, -_tankFwd.dot(_tankN)).normalize(); // 投到坡面（影响相机位置）
      const desired = tp.clone().addScaledVector(_tankFwd, -12).add(new THREE.Vector3(0, 4.5, 0));
      desired.y = Math.max(desired.y, terrainHeight(desired.x, desired.z) + 2);
      if (this._snapCam) { this.camera.position.copy(desired); this._snapCam = false; }
      else this.camera.position.lerp(desired, 0.2);
      // 炮膛指向（方位+俯仰，炮塔已被反旋转保持水平）：从炮塔高度看向远处，正中十字即炮口指向
      const boreDir = new THREE.Vector3(Math.sin(tw) * Math.cos(bp), -Math.sin(bp), Math.cos(tw) * Math.cos(bp));
      this.camera.lookAt(tp.clone().add(new THREE.Vector3(0, 2.0, 0)).addScaledVector(boreDir, 60));
      this._setFov(62, dt);
    }
  }

  // 阵亡观战相机：相机停在原地，平滑转向最近的存活敌人，让玩家看清战场机头朝向。
  _updateCameraDeath(dt) {
    const candidates = this.enemies ? this.enemies.filter((e) => e.alive) : [];
    if (candidates.length === 0) return;      // 没人可看：保持上一帧视角
    if (!this._deathCamTarget || !this._deathCamTarget.alive) {
      let best = null, bestD = Infinity;
      for (const e of candidates) {
        const d = e.position.distanceToSquared(this.camera.position);
        if (d < bestD) { bestD = d; best = e; }
      }
      this._deathCamTarget = best;
    }
    if (!this._deathCamTarget) return;
    const tgt = this._deathCamTarget.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const cur = this.camera.position.clone().addScaledVector(fwd, 30);
    cur.lerp(tgt, Math.min(1, 3 * dt));       // 平滑转向目标
    this.camera.lookAt(cur);
  }

  _updateCameraPlane(dt) {
    const p = this.player;
    const offset = new THREE.Vector3(0, 3.5, -16).applyQuaternion(p.group.quaternion);
    const desired = p.position.clone().add(offset);
    if (this._snapCam) { this.camera.position.copy(desired); this._snapCam = false; }
    else this.camera.position.lerp(desired, 1 - Math.pow(0.0001, dt));
    const fwd = p.forwardVector();
    const look = p.position.clone().addScaledVector(fwd, 14).add(new THREE.Vector3(0, 1.5, 0));
    this.camera.lookAt(look);
    this._setFov(70, dt);
  }

  _resolveObstacles() {
    if (!this.terrain) return;
    for (const t of this.em.tanks) {
      for (const ob of this.terrain.obstacles) {
        const dx = t.position.x - ob.position.x;
        const dz = t.position.z - ob.position.z;
        const min = (t.radius || 3) + (ob.radius || 3);
        const d2 = dx * dx + dz * dz;
        if (d2 < min * min && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const push = (min - d) / d;
          t.position.x += dx * push;
          t.position.z += dz * push;
        }
      }
    }
  }

  _animate = () => {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (this.mode === 'tank' && this.player && this.player.alive) {
      // 战争雷霆炮手式：十字准星固定屏幕中央（=炮口指向），圆环跟随世界锁定瞄准点；
      // 炮塔转到对准它时，圆环滑到屏幕中央与十字重合，炮塔就停。
      this.hud.positionCrosshair(window.innerWidth / 2, window.innerHeight / 2);
      if (this._tankAimPt) {
        const sp = this._tankAimPt.clone().project(this.camera);
        this.hud.positionAimCircle(sp.x, sp.y, sp.z < 1);
      } else this.hud.positionAimCircle(0, 0, false);
      // 未锁定指针时显示"点击锁定"提示：锁定后炮塔可无限旋转（movementX/Y 累积），
      // 否则鼠标碰到屏幕边缘就停（clientX 差值被窗口宽度限死）。
      if (this.state === 'playing' && !this._pointerLocked) this.hud.showLockPrompt();
      else this.hud.hideLockPrompt();
    } else if (this.mode === 'plane' && this.player && this.player.alive) {
      // 飞机：准星跟随虚拟瞄准点 NDC（指针锁定后 clientX/Y 冻结，必须用累积的虚拟点，否则准星钉死）
      const ndc = this._planeAimNDC || { x: 0, y: 0 };
      this.hud.positionCrosshair((ndc.x * 0.5 + 0.5) * window.innerWidth, (-ndc.y * 0.5 + 0.5) * window.innerHeight);
      this.hud.positionAimCircle(0, 0, false);
      this.hud.hideLockPrompt();
    } else {
      this.hud.positionCrosshair(this.input.mouseX, this.input.mouseY);
      this.hud.positionAimCircle(0, 0, false);
      this.hud.hideLockPrompt();
    }
    this.sfx.resume();
    const pl = this.player;
    if (pl && pl.alive) {
      if (!this.sfx.engine) this.sfx.startEngine();
      if (this.mode === 'plane') this.sfx.updateEngine(pl.throttle, clamp(pl.speed / CONFIG.plane.maxSpeed, 0, 1), 'plane');
      else this.sfx.updateEngine(Math.abs(pl.lastThrottle || 0), Math.abs(pl.lastThrottle || 0), 'tank');
    } else if (this.sfx.engine) {
      this.sfx.stopEngine();
    }

    if (this.state === 'playing') {
      if (this.player && this.player.alive) {
        if (this.mode === 'tank') this._handleInputTank(dt);
        else this._handleInputPlane(dt);
      }

      // AI 按队伍选目标：敌人锁定蓝队（玩家/队友），队友锁定红队
      const obstacles = this.terrain && this.terrain.obstacles;
      const blueAlive = (this.player && this.player.alive ? [this.player] : []).concat(this.allies.filter((a) => a.alive));
      const redAlive = this.enemies.filter((e) => e.alive);
      for (const e of this.enemies) {
        if (!e.ai) continue;
        e.ai.update(dt, { target: this._nearest(e.position, blueAlive), entityManager: this.em, obstacles });
      }
      for (const a of this.allies) {
        if (!a.ai) continue;
        a.ai.update(dt, { target: this._nearest(a.position, redAlive), entityManager: this.em, obstacles });
      }

      this.em.update(dt);
      if (this.mode === 'tank') this._resolveObstacles();

      const targets = this.mode === 'tank' ? this.em.tanks : this.em.planes;
      const hits = this.em.checkCollisions(targets);
      for (const h of hits) {
        if (h.owner === this.player) {
          this.hud.flashHit(h.killed ? 'kill' : (h.crit ? 'crit' : 'hit'));
          if (h.killed) this.sfx.kill(); else this.sfx.hit();
        }
      }

      const removed = this.em.cullDead();
      this._handleDeaths(removed);
      this.enemies = this.enemies.filter((e) => e.alive);
      this.allies = this.allies.filter((a) => a.alive);

      this._updatePlayerRespawn(dt);
      this._updateEnemySpawns(dt);
      this._updateAllySpawns(dt);

      if (this.player && this.player.alive) {
        if (this.mode === 'tank') this._updateCameraTank(dt);
        else this._updateCameraPlane(dt);
        for (const t of this.em.tanks) t.faceCamera(this.camera);
      } else {
        this._updateCameraDeath(dt);          // 阵亡观战：看向最近敌人，告诉玩家战场朝向
      }

      this._updateHUD();
      this._checkEnd();
    }

    this.renderer.render(this.scene, this.camera);
  };

  _handleDeaths(removed) {
    const label = this._entityLabel();
    for (const r of removed) {
      const scale = this.mode === 'tank' ? 3.5 : 2.5;
      this.em.addEffect(new Explosion(r.position.clone().add(new THREE.Vector3(0, 1.5, 0)), scale, 0xffa040));
      const tag = r.lastCrit ? ` · ${r.lastCrit}` : '';
      if (r === this.player) {
        this.hud.addFeed(`你的${label}被击毁${tag}`, 'death');
        this.hud.hideCrosshair();            // 阵亡：藏掉准星，别让它留在屏上误导
        this._deathCamTarget = null;          // 观战目标重新选
        this.player = null;
        this.playerLives -= 1;
        if (this.playerLives > 0) this.respawnTimer = CONFIG.rules.respawnDelay;
      } else if (r.team === 'red') {
        const wasBoss = r.isBoss;
        this.kills += 1;
        if (this.endless && this.kills % 10 === 0) this._spawnBoss(); // 每 10 击杀出一只精英
        const atk = r._lastAttacker;
        const who = atk === this.player ? '你击毁 ' : (atk && atk.team === 'blue' ? '友方击毁 ' : '击毁 ');
        this.hud.addFeed(`${who}敌方${label}${tag}`, 'kill');
      } else if (r.team === 'blue') {
        this.hud.addFeed(`友方${label}被击毁${tag}`, 'death');
      }
    }
  }

  _updatePlayerRespawn(dt) {
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      this.hud.setCenterMessage(`被击毁 · 复活中 ${Math.ceil(this.respawnTimer)}`);
      if (this.respawnTimer <= 0) {
        this.respawnTimer = -1;
        this._makePlayer();
        this.hud.setCenterMessage('');
        this.hud.addFeed(`已重生（剩余命数 ${this.playerLives}）`, 'info');
      }
    } else if (this.player && this.player.alive) {
      this.hud.setCenterMessage('');
    }
  }

  _updateEnemySpawns(dt) {
    const aliveEnemies = this.enemies.length;
    // 无尽模式随击杀数增兵（越打越难）
    const maxC = this.endless
      ? Math.min(8, CONFIG.rules.maxConcurrentEnemies + Math.floor(this.kills / 8))
      : CONFIG.rules.maxConcurrentEnemies;
    // 维持场上敌人数：若有空位且还有配额，安排一次刷新
    if (this._enemySpawnTimer <= 0 &&
        aliveEnemies < maxC &&
        this.enemiesToSpawn > 0 &&
        this.kills + aliveEnemies < this.enemyTickets) {
      this._enemySpawnTimer = CONFIG.rules.enemyRespawnDelay;
    }
    if (this._enemySpawnTimer > 0) {
      this._enemySpawnTimer -= dt;
      if (this._enemySpawnTimer <= 0) {
        this._enemySpawnTimer = -1;
        if (this.enemiesToSpawn > 0) {
          this._spawnEnemy();
          this.enemiesToSpawn -= 1;
        }
      }
    }
  }

  // 维持队友数量：阵亡后补充（无票数上限，纯辅助）。
  _updateAllySpawns(dt) {
    if (this._allySpawnTimer <= 0 && this.allies.length < this.allyCount) {
      this._allySpawnTimer = CONFIG.rules.enemyRespawnDelay;
    }
    if (this._allySpawnTimer > 0) {
      this._allySpawnTimer -= dt;
      if (this._allySpawnTimer <= 0) {
        this._allySpawnTimer = -1;
        if (this.allies.length < this.allyCount) this._spawnAlly();
      }
    }
  }

  _updateHUD() {
    const enemiesLeft = this.enemies.length + this.enemiesToSpawn;
    if (this.player && this.player.alive) {
      this.hud.update({
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        reloadFraction: this.player.reloadFraction,
        kills: this.kills,
        tickets: this.enemyTickets,
        lives: Math.max(0, this.playerLives),
        enemiesLeft,
      });
      this.hud.setMissiles(this.player.missiles ?? 0, this.player.maxMissiles ?? 0);
      // 小地图：玩家居中、朝上为前进方向；敌人画红点
      const f = this.mode === 'tank' ? null : this.player.forwardVector();
      const heading = this.mode === 'tank' ? this.player.heading : Math.atan2(f.x, f.z);
      this.hud.drawMinimap({
        playerPos: this.player.position,
        playerHeading: heading,
        enemies: this.enemies.filter((e) => e.alive).map((e) => e.position),
        allies: this.allies.filter((a) => a.alive).map((a) => a.position),
        range: this.mode === 'tank' ? 220 : 340,
      });
      // 模块损伤提示（坦克）/ 提前量瞄准具（飞机）
      this.hud.setModules(this.mode === 'tank' ? this.player.modules : null);
      if (this.mode === 'plane') this._updateLeadReticle(); else this.hud.positionLead(0, 0, false);
    } else {
      this.hud.update({ kills: this.kills, tickets: this.enemyTickets, lives: Math.max(0, this.playerLives), enemiesLeft });
      this.hud.setModules(null);
      this.hud.positionLead(0, 0, false);
    }
  }

  // 提前量瞄准具：给前方敌机算拦截解（子弹速度+敌速），把命中点画到屏幕上。
  _updateLeadReticle() {
    if (!this.player || !this.player.alive) { this.hud.positionLead(0, 0, false); return; }
    const p = this.player;
    const B = CONFIG.plane.bulletSpeed;
    const fwd = p.forwardVector();
    let best = null, bestScore = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const R = e.position.clone().sub(p.position);
      const dist = R.length();
      if (dist > 700 || dist < 1) continue;
      if (fwd.dot(R.clone().multiplyScalar(1 / dist)) < 0.3) continue; // 只算前方的目标
      const Vt = e.forwardVector().multiplyScalar(e.speed);
      const a = Vt.lengthSq() - B * B, b = 2 * R.dot(Vt), c = R.lengthSq();
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      const cand = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)].filter((t) => t > 0).sort((x, y) => x - y);
      if (!cand.length) continue;
      const sp = e.position.clone().addScaledVector(Vt, cand[0]).project(this.camera);
      if (sp.z > 1) continue;
      const score = Math.abs(sp.x) + Math.abs(sp.y);
      if (score < bestScore) { bestScore = score; best = sp; }
    }
    if (best) this.hud.positionLead(best.x, best.y, true);
    else this.hud.positionLead(0, 0, false);
  }

  _checkEnd() {
    if (this.state !== 'playing') return;
    if (!this.endless && this.kills >= this.enemyTickets) { this._end(true); return; }
    if (this.playerLives <= 0 && this.respawnTimer <= 0 && !(this.player && this.player.alive)) {
      this._end(false);
    }
  }

  _end(win) {
    this.state = 'over';
    // 一局结束：释放指针锁让光标出现（点"再来一局/返回菜单"），并藏掉准星。
    // 程序化退出无 ESC 冷却，也顺带消除下一局开局"要点两次才锁上"的问题。
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.hideCrosshair();
    this.hud.setCenterMessage('');
    this.hud.showResult({
      win,
      kills: this.kills,
      endless: this.endless,
      onAgain: () => this.restart(this.mode),
      onMenu: () => { if (this.onExit) this.onExit(); },
    });
    if (this.onResult) this.onResult({ win, kills: this.kills, endless: this.endless });
  }

  restart(mode) {
    this.mode = mode;
    this.em.clear();
    if (this.terrain) this.scene.remove(this.terrain.group);
    this.hud.setCenterMessage('');
    this._setupHint();
    this._initMatch(mode);
  }

  _handleResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this._onDocClickPL) document.removeEventListener('click', this._onDocClickPL);
    if (this._onPLChange) document.removeEventListener('pointerlockchange', this._onPLChange);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.dispose();
    this.hud.dispose();
    this.sfx.stopEngine();
    this.em.clear();
    if (this.terrain) this.scene.remove(this.terrain.group);
    this.renderer.dispose();
  }
}


// ===== js/main.js =====


const canvas = document.getElementById('game-canvas');
const menu = document.getElementById('menu');
const loadoutEl = document.getElementById('loadout');
const hudContainer = document.getElementById('hud');
const moneyEl = document.getElementById('money');
const rpEl = document.getElementById('rp');
const techtreeEl = document.getElementById('techtree');
const techtreeBtn = document.getElementById('btn-tech');

// 出战选择页元素
const loEls = {
  mode: document.getElementById('lo-mode'),
  icon: document.getElementById('lo-icon'),
  name: document.getElementById('lo-name'),
  weapon: document.getElementById('lo-weapon'),
  stats: document.getElementById('lo-stats'),
  summary: document.getElementById('lo-summary'),
  prev: document.getElementById('lo-prev'),
  next: document.getElementById('lo-next'),
  back: document.getElementById('lo-back'),
  start: document.getElementById('lo-start'),
};
let pendingMode = 'tank';

let game = null;
let difficulty = 'normal';
let endless = false;
const bestEl = document.getElementById('best');
const endlessBtn = document.getElementById('btn-endless');

// —— 存档：金币 / 已拥有坦克 / 当前选用 ——
const STORAGE_KEY = 'warthunder_meta_v1';

function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (m && Array.isArray(m.owned)) {
      m.rp = m.rp || 0;
      m.researched = Array.isArray(m.researched) ? m.researched : [];
      m.researchedPlanes = Array.isArray(m.researchedPlanes) ? m.researchedPlanes : [];
      m.ownedPlanes = Array.isArray(m.ownedPlanes) ? m.ownedPlanes : ['fighter', 'trainer'];
      m.selectedPlane = m.selectedPlane || 'fighter';
      return m;
    }
  } catch {}
  return {
    money: 1500, rp: 0,
    owned: ['medium', 'light'], selected: 'medium', researched: [],
    ownedPlanes: ['fighter', 'trainer'], selectedPlane: 'fighter', researchedPlanes: [],
    bestTankEndless: 0, bestPlaneEndless: 0,
  };
}
let meta = loadMeta();
function saveMeta() { localStorage.setItem(STORAGE_KEY, JSON.stringify(meta)); }

function renderMoney() {
  if (moneyEl) moneyEl.textContent = '💰 ' + meta.money;
  if (rpEl) rpEl.textContent = '🔬 ' + meta.rp;
}
function renderBest() {
  if (!bestEl) return;
  bestEl.textContent = `🏆 无尽最佳 · 坦克 ${meta.bestTankEndless || 0} · 飞机 ${meta.bestPlaneEndless || 0}`;
}
function renderEndlessBtn() {
  if (!endlessBtn) return;
  endlessBtn.textContent = `♾ 无尽模式：${endless ? '开启' : '关闭'}`;
  endlessBtn.classList.toggle('active', endless);
}

// —— 科技树 ——
// 载具状态：locked（前置未完成）/ researchable（可花 RP 研发）/ researched（可花钱购买）/ owned
function vehicleState(t, isTank) {
  const owned = isTank ? meta.owned : meta.ownedPlanes;
  const researched = isTank ? meta.researched : meta.researchedPlanes;
  if (owned.includes(t.id)) return 'owned';
  if (researched.includes(t.id)) return 'researched';
  const prereqDone = !t.prereq || owned.includes(t.prereq) || researched.includes(t.prereq);
  return prereqDone ? 'researchable' : 'locked';
}
function typeName(isTank, id) {
  const t = (isTank ? TANK_TYPES : PLANE_TYPES).find((x) => x.id === id);
  return t ? t.name : id;
}
function techTreeCard(t, isTank) {
  const st = vehicleState(t, isTank);
  const owned = isTank ? meta.owned : meta.ownedPlanes;
  const sel = isTank ? meta.selected : meta.selectedPlane;
  let action = '';
  if (st === 'owned') action = sel === t.id ? '✓ 已选用' : '点击选用';
  else if (st === 'researched') action = `💰 ${t.price} 购买`;
  else if (st === 'researchable') action = `🔬 ${t.rp} 研发`;
  else action = `🔒 需 ${typeName(isTank, t.prereq)}`;
  const cls = 'tt-card ' + st + (st === 'owned' && sel === t.id ? ' selected' : '');
  return `<div class="${cls}" data-tank="${isTank ? 1 : 0}" data-id="${t.id}">
    <div class="tt-rank">R${t.rank}</div><div class="g-icon">${t.icon}</div>
    <div class="g-name">${t.name}</div><div class="tt-action">${action}</div></div>`;
}
function renderTechTree() {
  if (!techtreeEl) return;
  const sec = (title, types, isTank) =>
    `<div class="tt-section"><div class="tt-title">${title}</div><div class="tt-row">${types.map((t) => techTreeCard(t, isTank)).join('')}</div></div>`;
  techtreeEl.innerHTML =
    `<div class="tt-head"><h2>🔬 科技树</h2><button id="tt-close" class="lo-btn">返回</button></div>` +
    sec('🛠 坦克', TANK_TYPES, true) + sec('✈️ 飞机', PLANE_TYPES, false) +
    `<p class="tip">打仗赚 🔬研发点 与 💰金币 → 研发（解锁购买权）→ 购买 → 出战选用</p>`;
  const close = document.getElementById('tt-close');
  if (close) close.addEventListener('click', closeTechTree);
}
function techTreeClick(isTank, id) {
  const types = isTank ? TANK_TYPES : PLANE_TYPES;
  const t = types.find((x) => x.id === id);
  if (!t) return;
  const st = vehicleState(t, isTank);
  const owned = isTank ? meta.owned : meta.ownedPlanes;
  const researched = isTank ? meta.researched : meta.researchedPlanes;
  if (st === 'owned') { if (isTank) meta.selected = id; else meta.selectedPlane = id; saveMeta(); renderTechTree(); }
  else if (st === 'researched') {
    if (meta.money >= t.price) { meta.money -= t.price; owned.push(id); if (isTank) meta.selected = id; else meta.selectedPlane = id; saveMeta(); renderMoney(); renderTechTree(); }
    else flashMsg('💰 金币不足');
  } else if (st === 'researchable') {
    if (meta.rp >= t.rp) { meta.rp -= t.rp; researched.push(id); saveMeta(); renderMoney(); renderTechTree(); flashMsg(`🔬 已研发 ${t.name}`); }
    else flashMsg('🔬 研发点不足');
  }
}
function openTechTree() { renderTechTree(); menu.classList.add('hidden'); techtreeEl.classList.remove('hidden'); }
function closeTechTree() { techtreeEl.classList.add('hidden'); menu.classList.remove('hidden'); renderMoney(); renderBest(); }

function flashMsg(text) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text; el.classList.add('show');
  clearTimeout(flashMsg._t);
  flashMsg._t = setTimeout(() => el.classList.remove('show'), 1200);
}

// —— 出战选择页 ——
function weaponDesc(isTank, t) {
  if (isTank) {
    const cal = t.dmg >= 2.5 ? '重型主炮（一击必杀）' : t.dmg >= 1.5 ? '大口径主炮' : t.dmg >= 1 ? '标准主炮' : '轻型主炮';
    return `🔫 ${cal}　·　同轴机枪`;
  }
  const g = t.dmg >= 1.3 ? '20mm 机炮 ×2' : t.dmg >= 1 ? '12.7mm 机枪 ×2' : '7.7mm 机枪 ×2';
  return `🔫 ${g}`;
}
function statBars(isTank, t) {
  const items = isTank
    ? [['血量', t.hp], ['速度', t.speed], ['火力', t.dmg], ['机动', (t.turn + t.turret) / 2]]
    : [['血量', t.hp], ['速度', t.speed], ['机动', t.agi], ['火力', t.dmg]];
  const pips = (v) => Math.max(1, Math.min(5, Math.round(v * 2.5)));
  return items.map(([lbl, v]) => {
    const p = pips(v);
    let dots = '';
    for (let i = 0; i < 5; i++) dots += `<span class="pip ${i < p ? 'on' : ''}"></span>`;
    return `<div class="stat"><span class="stat-lbl">${lbl}</span><span class="stat-pips">${dots}</span></div>`;
  }).join('');
}
function loadoutTypes() {
  return pendingMode === 'tank'
    ? { types: TANK_TYPES, owned: meta.owned, sel: meta.selected, set: (id) => { meta.selected = id; } }
    : { types: PLANE_TYPES, owned: meta.ownedPlanes, sel: meta.selectedPlane, set: (id) => { meta.selectedPlane = id; } };
}
function renderLoadout() {
  const isTank = pendingMode === 'tank';
  const { types, owned, sel } = loadoutTypes();
  const t = types.find((x) => x.id === sel) || types[0];
  loEls.mode.textContent = isTank ? '陆战 · 坦克' : '空战 · 飞机';
  loEls.icon.textContent = t.icon;
  loEls.name.textContent = t.name;
  loEls.weapon.textContent = weaponDesc(isTank, t);
  loEls.stats.innerHTML = statBars(isTank, t);
  loEls.summary.textContent = `难度：${DIFFICULTY_LABELS[difficulty]}　·　无尽：${endless ? '开' : '关'}　·　💰 ${meta.money}`;
  const cycling = owned.length > 1;
  loEls.prev.disabled = !cycling;
  loEls.next.disabled = !cycling;
}
function showLoadout(mode) {
  pendingMode = mode;
  renderLoadout();
  menu.classList.add('hidden');
  loadoutEl.classList.remove('hidden');
}
function hideLoadout() {
  loadoutEl.classList.add('hidden');
  menu.classList.remove('hidden');
  renderMoney(); renderGarage(); renderGaragePlane();
}
function cycleLoadout(dir) {
  const { types, owned, sel, set } = loadoutTypes();
  if (owned.length < 2) return;
  const order = types.map((x) => x.id).filter((id) => owned.includes(id));
  let idx = order.indexOf(sel); if (idx < 0) idx = 0;
  set(order[(idx + dir + order.length) % order.length]); saveMeta(); renderLoadout();
}

function startGame(mode) {
  menu.classList.add('hidden');
  hudContainer.classList.remove('hidden');
  if (game) game.dispose();
  game = new Game({
    canvas, mode, difficulty,
    tankType: meta.selected,
    planeType: meta.selectedPlane,
    endless,
    hudContainer,
    onExit: backToMenu,
    onResult: ({ win, kills, endless: isEndless }) => {
      let reward, rp;
      const sub = hudContainer.querySelector('#result-sub');
      if (isEndless) {
        const key = mode === 'tank' ? 'bestTankEndless' : 'bestPlaneEndless';
        const prev = meta[key] || 0;
        const isBest = kills > prev;
        if (isBest) meta[key] = kills;
        reward = kills * 150; rp = kills * 50;
        meta.money += reward; meta.rp += rp; saveMeta();
        if (sub) sub.textContent = `击毁 ${kills} · +${reward}💰 +${rp}🔬${isBest ? ' · 🏆 新纪录！' : ''} · 最佳 ${meta[key]}`;
      } else {
        reward = (win ? 600 : 0) + kills * 120; rp = (win ? 300 : 80) + kills * 40;
        meta.money += reward; meta.rp += rp; saveMeta();
        if (sub) sub.textContent = `击毁 ${kills} · +${reward}💰 +${rp}🔬 · 余额 ${meta.money} · 研发 ${meta.rp}`;
      }
    },
  });
  window.__game = game;
}

function backToMenu() {
  if (game) { game.dispose(); game = null; }
  hudContainer.classList.add('hidden');
  menu.classList.remove('hidden');
  renderMoney(); renderBest(); renderEndlessBtn();
}

document.getElementById('btn-tank').addEventListener('click', () => showLoadout('tank'));
document.getElementById('btn-plane').addEventListener('click', () => showLoadout('plane'));

loEls.back.addEventListener('click', hideLoadout);
loEls.start.addEventListener('click', () => { loadoutEl.classList.add('hidden'); startGame(pendingMode); });
loEls.prev.addEventListener('click', () => cycleLoadout(-1));
loEls.next.addEventListener('click', () => cycleLoadout(1));

document.querySelectorAll('.diff-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.level;
    document.querySelectorAll('.diff-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

if (endlessBtn) endlessBtn.addEventListener('click', () => { endless = !endless; renderEndlessBtn(); });
if (techtreeBtn) techtreeBtn.addEventListener('click', openTechTree);
if (techtreeEl) techtreeEl.addEventListener('click', (e) => {
  const card = e.target.closest('.tt-card');
  if (!card) return;
  techTreeClick(card.dataset.tank === '1', card.dataset.id);
});

renderMoney();
renderBest();
renderEndlessBtn();

// —— 设置面板 ——
(() => {
  const el = document.getElementById('settings');
  const openBtn = document.getElementById('btn-settings');
  const sVol = document.getElementById('set-volume'), sVolV = document.getElementById('set-volume-v');
  const sSh = document.getElementById('set-shadows'), sShV = document.getElementById('set-shadows-v');
  const sIv = document.getElementById('set-inverty'), sIvV = document.getElementById('set-inverty-v');
  const sPg = document.getElementById('set-planegain'), sPgV = document.getElementById('set-planegain-v');
  let cur = loadSettings();
  const refresh = () => {
    sVol.value = cur.volume; sVolV.textContent = Math.round(cur.volume * 100) + '%';
    sSh.value = cur.shadows ? 1 : 0; sShV.textContent = cur.shadows ? '开' : '关';
    sIv.value = cur.invertY ? 1 : 0; sIvV.textContent = cur.invertY ? '开' : '关';
    sPg.value = cur.planeGain; sPgV.textContent = cur.planeGain.toFixed(2);
  };
  refresh();
  if (openBtn) openBtn.addEventListener('click', () => { refresh(); el.classList.remove('hidden'); });
  document.getElementById('set-close').addEventListener('click', () => el.classList.add('hidden'));
  sVol.addEventListener('input', () => { cur.volume = parseFloat(sVol.value); saveSettings(cur); if (window.__game) window.__game.sfx.setVolume(cur.volume); sVolV.textContent = Math.round(cur.volume * 100) + '%'; });
  sSh.addEventListener('input', () => { cur.shadows = sSh.value === '1'; saveSettings(cur); sShV.textContent = cur.shadows ? '开' : '关'; });
  sIv.addEventListener('input', () => { cur.invertY = sIv.value === '1'; saveSettings(cur); sIvV.textContent = cur.invertY ? '开' : '关'; });
  sPg.addEventListener('input', () => { cur.planeGain = parseFloat(sPg.value); saveSettings(cur); sPgV.textContent = cur.planeGain.toFixed(2); });
})();

// 冒烟测试入口：URL 带 ?auto=tank / ?auto=plane 时跳过菜单直接开局（便于回归测试）
(() => {
  const m = new URLSearchParams(location.search).get('auto');
  if (m === 'tank' || m === 'plane') startGame(m);
})();


