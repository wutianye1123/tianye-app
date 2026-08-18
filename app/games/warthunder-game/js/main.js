import * as THREE from 'three';
import { clamp, lerp, lerpAngle, randRange, randInt, makeSkyTexture, makeCloudTexture, camoTexture, makeTrackTexture, terrainHeight, setTerrainScale } from './lib.js';

// 坦克贴地姿态用的临时对象（避免每帧分配）
const _tankN = new THREE.Vector3(), _tankFwd = new THREE.Vector3(), _tankRight = new THREE.Vector3();
const _kcTmp = new THREE.Vector3();   // X 光回放临时量（免每帧 new）
const _scLook = new THREE.Vector3();   // 回放相机平滑视线
const _scSide = new THREE.Vector3();   // 回放弹道侧向
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
    allySpread: 0.03,     // 友军炮弹散布（独立于难度，固定；原硬编码在 Tank 构造里）
    enemyFireChance: 0.4, // 敌方瞄准后单次开火概率
    shellSpeed: 150,           // 炮弹更快（世界大战打飞机时追得上）
    shellDamage: 35,      // 玩家炮弹伤害
    enemyShellDamage: 14, // 敌方炮弹伤害较低
    shellGravity: 6,
    shellLife: 3.5,
    radius: 3.0,
    captureRadius: 22,    // 占领模式据点半径（_setupObjective 与 inZ 判定共用，改一处即可，原两处硬编码 22）
    worldSize: 450,
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
    radius: 10,
    gravity: 12,
    worldSize: 800,
    ceiling: 350,
    spawnAltitude: 70,
    missile: { count: 6, damage: 55, speed: 120, cooldown: 0.8, homing: 3.0, life: 5, radius: 0.5, regen: 7 },
    bomb: { count: 8, damage: 800, gravity: 25, radius: 40, life: 12, regen: 6 },
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
  // Rank 1
  { id:'medium',  name:'T-34-85',     icon:'🇷🇺', scale:1.0,  hp:1.0,  speed:1.0,  turn:1.0,  turret:1.0,  reload:1.0, dmg:1.0,  armor:[90,60,45], pen:135, rank:1, rp:0,    prereq:null,      price:0 },
  { id:'m4',      name:'M4A3 谢尔曼',  icon:'🇺🇸', scale:1.0,  hp:1.15, speed:0.95, turn:1.0,  turret:1.0,  reload:1.1, dmg:0.95, armor:[100,60,45], pen:110, rank:1, rp:200,  prereq:null,      price:800 },
  // Rank 2
  { id:'panzer2', name:'II 号坦克',    icon:'🇩🇪', scale:0.78, hp:0.6,  speed:1.4,  turn:1.6,  turret:1.6,  reload:0.7, dmg:0.6,  armor:[30,20,15], pen:55, rank:2, rp:300,  prereq:'medium',  price:1000 },
  { id:'light',   name:'M24 霞飞',     icon:'🇺🇸', scale:0.85, hp:0.75, speed:1.5,  turn:1.5,  turret:1.7,  reload:0.7, dmg:0.8,  armor:[38,25,19], pen:60, rank:2, rp:300,  prereq:'medium',  price:1500 },
  { id:'scout',   name:'234/2 美洲狮', icon:'🇩🇪', scale:0.8,  hp:0.5,  speed:1.7,  turn:1.8,  turret:1.8,  reload:0.6, dmg:0.5,  armor:[30,20,15], pen:65, rank:2, rp:350,  prereq:'medium',  price:1200 },
  // Rank 3
  { id:'td',      name:'SU-100',      icon:'🇷🇺', scale:1.05, hp:1.1,  speed:0.9,  turn:0.8,  turret:0.7,  reload:1.4, dmg:2.8,  armor:[75,45,45], pen:185, rank:3, rp:800,  prereq:'light',   price:3500 },
  { id:'panther', name:'黑豹 V',       icon:'🇩🇪', scale:1.1,  hp:1.3,  speed:1.05, turn:0.85, turret:0.9,  reload:1.1, dmg:1.9,  armor:[120,60,50], pen:160, rank:3, rp:900,  prereq:'td',      price:4200 },
  // Rank 4
  { id:'heavy',   name:'虎 I',        icon:'🇩🇪', scale:1.2,  hp:2.0,  speed:0.7,  turn:0.7,  turret:0.9,  reload:1.3, dmg:2.2,  armor:[110,80,80], pen:165, rank:4, rp:1600, prereq:'panther', price:4500 },
  { id:'is2',     name:'IS-2',        icon:'🇷🇺', scale:1.2,  hp:2.2,  speed:0.65, turn:0.65, turret:0.8,  reload:1.5, dmg:2.6,  armor:[120,90,60], pen:190, rank:4, rp:2000, prereq:'heavy',   price:5500 },
  // Rank 5
  { id:'t80',     name:'T-80U',       icon:'🇷🇺', scale:1.1,  hp:2.4,  speed:1.2,  turn:1.1,  turret:1.3,  reload:0.9, dmg:2.5,  armor:[200,120,70], pen:450, rank:5, rp:3000, prereq:'is2',     price:8800 },
  { id:'assault', name:'鼠式',        icon:'🇩🇪', scale:1.3,  hp:2.6,  speed:0.6,  turn:0.6,  turret:0.85, reload:1.6, dmg:3.4,  armor:[240,185,160], pen:245, rank:5, rp:3200, prereq:'is2',     price:9500 },
  { id:'m1a2',    name:'M1A2 艾布拉姆斯', icon:'🇺🇸', scale:1.4,  hp:3.5, speed:1.9, turn:2.0, turret:2.0,  reload:0.5, dmg:3.6, armor:[380,150,90], pen:600, rank:6, rp:6000, prereq:'is2', price:20000 }, // 满级终极坦克：每一项都拉到全场最高
  { id:'aa',      name:'ZSU-23-4 石勒喀河', icon:'🇷🇺', scale:0.85, hp:0.7, speed:1.2, turn:1.5, turret:2.0, reload:0.1, dmg:0.4, armor:[15,15,15], pen:20, rank:2, rp:400, prereq:'medium', price:1500 }, // 防空坦克：高仰角速射打飞机
];
// —— 弹种 ——（战争雷霆式：1/2/3 切换，中文名）
// penMul:穿深倍率(乘载具 pen)；dmgMul:后效倍率(乘 shellDamage)；bounceDeg:跳弹角(入射角超过即跳)。
// 榴弹不跳弹(0=禁用)，未击穿仍溅射 25% 伤害（打薄皮好用）。
const SHELLS = [
  { id:'ap',   name:'穿甲榴弹',   penMul:1.0,  dmgMul:1.0,  bounceDeg: 70 },
  { id:'apcr', name:'硬芯穿甲弹', penMul:1.45, dmgMul:0.55, bounceDeg: 62 },
  { id:'he',   name:'榴弹',       penMul:0.35, dmgMul:1.8,  bounceDeg: 0, noBounce: true },
];
function shellById(id) { return SHELLS.find((s) => s.id === id) || SHELLS[0]; }

function tankTypeById(id) { return TANK_TYPES.find((t) => t.id === id) || TANK_TYPES[0]; }
function randomTankType() { return TANK_TYPES[Math.floor(Math.random() * TANK_TYPES.length)]; }

// —— 飞机型号 ——（hp 血量、speed 速度、agi 机动、dmg 火力；均为相对倍率）
const PLANE_TYPES = [
  // Rank 1（初始）
  { id:'trainer',   name:'初教-6',        icon:'🇨🇳', hp:0.6,  speed:0.95, agi:1.15, dmg:0.7,  rank:1, rp:0,    prereq:null,      price:0 },
  { id:'fighter',   name:'F-16 战隼',     icon:'🇺🇸', hp:1.0,  speed:1.05, agi:1.1,  dmg:1.0,  rank:1, rp:0,    prereq:null,      price:0 },
  // Rank 2
  { id:'mig29',     name:'MiG-29 支点',   icon:'🇷🇺', hp:0.9,  speed:1.1,  agi:1.15, dmg:0.95, rank:2, rp:400,  prereq:'fighter', price:2200 },
  { id:'j10',       name:'歼-10 猛龙',    icon:'🇨🇳', hp:0.95, speed:1.15, agi:1.1,  dmg:1.0,  rank:2, rp:500,  prereq:'fighter', price:2600 },
  { id:'intercept', name:'MiG-31 捕狐犬', icon:'🇷🇺', hp:0.9,  speed:1.35, agi:0.75, dmg:1.15, rank:3, rp:900,  prereq:'mig29',   price:3800 },
  // Rank 3
  { id:'rafale',    name:'阵风 Rafale',   icon:'🇫🇷', hp:1.1,  speed:1.1,  agi:1.15, dmg:1.1,  rank:3, rp:1000, prereq:'j10',     price:4200 },
  { id:'heavy',     name:'F-15 鹰',       icon:'🇺🇸', hp:1.4,  speed:1.05, agi:0.85, dmg:1.25, rank:3, rp:1100, prereq:'mig29',   price:4500 },
  { id:'attacker',  name:'A-10 雷电II',   icon:'🇺🇸', hp:1.8,  speed:0.7,  agi:0.6,  dmg:1.7,  rank:4, rp:1600, prereq:'heavy',   price:6000 },
  // Rank 4
  { id:'su35',      name:'Su-35 侧卫',    icon:'🇷🇺', hp:1.5,  speed:1.25, agi:1.05, dmg:1.35, rank:4, rp:2200, prereq:'heavy',   price:7500 },
  { id:'typhoon',   name:'台风 Typhoon',  icon:'🇪🇺', hp:1.25, speed:1.2,  agi:1.2,  dmg:1.2,  rank:4, rp:2400, prereq:'rafale',  price:8000 },
  { id:'bomber',    name:'Tu-22M 逆火',   icon:'🇷🇺', hp:1.5, speed:0.9,  agi:0.8,  dmg:2.5, missiles:true, fastMissile:true, rank:4, rp:2000, prereq:'heavy', price:7000 }, // 轰炸机：导弹+炸弹，转向快，血量适中
  // Rank 5（顶）
  { id:'jet',       name:'F-22 猛禽',     icon:'🇺🇸', hp:1.3,  speed:1.45, agi:1.3,  dmg:1.4, missiles:true, rank:5, rp:3200, prereq:'su35',    price:10000 },
  { id:'j20',       name:'歼-20 威龙',    icon:'🇨🇳', hp:1.3,  speed:1.5,  agi:1.25, dmg:1.4,  rank:5, rp:3500, prereq:'typhoon', price:11000 },
  { id:'f35',       name:'F-35 闪电II',   icon:'🇺🇸', hp:2.0,  speed:1.6,  agi:1.5,  dmg:1.8, missiles:true, fastMissile:true, rank:6, rp:6000, prereq:'j20', price:20000 }, // 满级终极战机：每一项都拉到全场最高+导弹
  { id:'f35b',      name:'B-21 突袭者',   icon:'🇺🇸', hp:2.2,  speed:1.65, agi:1.55, dmg:1.85, missiles:true, fastMissile:true, bombs:true, rank:6, rp:8000, prereq:'f35', price:28000 }, // 满级隐身轰炸机：全满+导弹+炸弹，极贵
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
      <div id="lead-reticle" style="display:none"></div>
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
      <div id="capture-bar" style="position:absolute;top:54px;left:50%;transform:translateX(-50%);width:340px;max-width:80vw;height:20px;background:rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.3);border-radius:10px;overflow:hidden;display:none;"><div id="capture-fill" style="position:absolute;left:0;top:0;bottom:0;width:50%;background:#9a8a4a;transition:width .1s,background .2s;"></div><span id="capture-label" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:12px/1 sans-serif;color:#fff;text-shadow:0 1px 2px #000;">占领</span></div>
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
    if (!mods) { this.modulesEl.innerHTML = ''; return; }
    const col = (v) => v > 0 ? '#f44' : '#4f4';
    const label = (v) => v > 0 ? `${Math.ceil(v)}s` : 'OK';
    this.modulesEl.innerHTML =
      `<span style="color:${col(mods.track)}">🛞履带 ${label(mods.track)}</span> ` +
      `<span style="color:${col(mods.barrel)};margin-left:8px">🎯炮管 ${label(mods.barrel)}</span> ` +
      `<span style="color:${col(mods.engine)};margin-left:8px">⚙️发动机 ${label(mods.engine)}</span>`;
  }

  // 命中反馈：在准星处闪一个标记。hit=击穿(金)，crit=致命(橙)，kill=击毁(红)，
  // nopen=未击穿(灰蓝)，bounce=跳弹(白)。
  flashHit(kind = 'hit') {
    if (!this.hitmarker) return;
    this.hitmarker.classList.toggle('kill', kind === 'kill');
    this.hitmarker.classList.toggle('crit', kind === 'crit');
    this.hitmarker.classList.toggle('nopen', kind === 'nopen');
    this.hitmarker.classList.toggle('bounce', kind === 'bounce');
    this.hitmarker.style.opacity = '1';
    clearTimeout(this._hitTO);
    this._hitTO = setTimeout(() => { this.hitmarker.style.opacity = '0'; }, 180);
  }

  // 弹种显示（坦克）：当前弹名+1/2/3 切换指示，挂 HUD 左下。
  hideShell() { if (this._shellEl) this._shellEl.style.display = 'none'; }
  setShell(shell, pen) {
    if (this._shellEl) this._shellEl.style.display = '';
    if (!this._shellEl) {
      const el = document.createElement('div');
      // 放右下角：不挡左下 stats（血量/装填/计分）和小地图区域，紧凑单行
      el.style.cssText = 'position:absolute;bottom:14px;right:178px;font:13px/1.4 sans-serif;color:#ddd;text-shadow:0 1px 2px #000;background:rgba(0,0,0,.4);padding:4px 10px;border-radius:8px;pointer-events:none;white-space:nowrap;';
      this.container.appendChild(el);
      this._shellEl = el;
    }
    this._shellEl.innerHTML = `${shell.icon}${shell.name} <span style="color:#9fd0ff">${Math.round(pen)}mm</span>` +
      `<span style="color:#888;font-size:11px"> (1/2/3切换)</span>`;
  }

  // 受击方向指示：屏幕边缘按方位角闪红色弧形提示（angle=入射相对玩家朝向的角，0=正前）。
  // 用一个旋转的渐变弧 div，闪 0.5s 后淡出；多次受击刷新角度与计时。
  flashDamageDir(angle) {
    if (!this._dmgDir) {
      const el = document.createElement('div');
      // 80px 红色弧（radial-gradient 环 + 只留 60° 扇区可见），挂在 HUD 容器外圈、随受击角旋转
      el.style.cssText = 'position:fixed;left:50%;top:50%;width:520px;height:520px;margin:-260px 0 0 -260px;' +
        'pointer-events:none;z-index:50;opacity:0;transition:opacity .25s;' +
        'background:radial-gradient(circle, transparent 190px, rgba(255,40,20,.75) 218px, rgba(255,40,20,.75) 234px, transparent 258px);' +
        '-webkit-mask-image:conic-gradient(from -30deg, transparent 0deg, #000 15deg, #000 60deg, transparent 75deg, transparent 360deg);' +
        'mask-image:conic-gradient(from -30deg, transparent 0deg, #000 15deg, #000 60deg, transparent 75deg, transparent 360deg);';
      this.container.appendChild(el);
      this._dmgDir = el;
    }
    this._dmgDir.style.transform = `rotate(${angle}rad)`;
    this._dmgDir.style.opacity = '1';
    clearTimeout(this._dmgTO);
    this._dmgTO = setTimeout(() => { this._dmgDir.style.opacity = '0'; }, 500);
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

  // 占领进度条：progress -100(红满)..+100(蓝满)，传 null 隐藏。
  setCapture(progress) {
    if (!this.captureBar) {
      this.captureBar = this.container.querySelector('#capture-bar');
      this.captureFill = this.container.querySelector('#capture-fill');
      this.captureLabel = this.container.querySelector('#capture-label');
    }
    if (!this.captureBar) return;
    if (progress == null) { this.captureBar.style.display = 'none'; return; }
    this.captureBar.style.display = 'block';
    this.captureFill.style.width = ((progress + 100) / 2) + '%';
    this.captureFill.style.background = progress > 1 ? '#5da94a' : progress < -1 ? '#c14a4a' : '#9a8a4a';
    this.captureLabel.textContent = progress >= 100 ? '已占领！'
      : progress <= -100 ? '敌方占领！'
      : (progress > 1 ? `占领中 ${Math.floor(progress)}%` : progress < -1 ? `敌方占领 ${Math.floor(-progress)}%` : '争夺中');
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

  // 炸弹/核弹计数（左下角和导弹一起）
  setBombs(bombs, maxBombs) {
    if (!this.missilesEl) this.missilesEl = this.container.querySelector('#missiles');
    if (!this.missilesEl) return;
    let txt = this.missilesEl.textContent || '';
    // 先清除旧的炸弹/核弹文字
    txt = txt.replace(/　💣.*$/, '').replace(/　☢️.*$/, '');
    if (maxBombs > 0) {
      txt += `　💣 炸弹 ${bombs}/${maxBombs}`;
      const nukes = Math.floor(bombs / 3);
      if (nukes > 0) txt += `　☢️ 核弹 ${nukes}`;
    }
    this.missilesEl.textContent = txt;
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
    // 玩家前进方向 = (sin h, cos h)；分解到"前进/右侧"分量再画（原旋转矩阵算式会变成 2 倍角、全错）
    const hs = Math.sin(playerHeading), hc = Math.cos(playerHeading);
    const project = (p) => {
      const dx = p.x - playerPos.x;
      const dz = p.z - playerPos.z;
      const fwd = dx * hs + dz * hc;          // 沿前进方向（>0 在前方）
      const rgt = dx * hc - dz * hs;          // 沿右侧（>0 在右边）
      return { px: cx - rgt * scale, py: cy - fwd * scale }; // 屏右=世界-x(朝+z时手性翻转)，与3D追尾视角左右一致
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
// 弹丸几何/材质缓存：每发弹丸原先各 new 一份 SphereGeometry+Material，机枪密集场景
// 分配/GC 开销大；改为按 size/color 全局缓存复用（弹丸不改 scale/opacity，共享安全）。
// ⚠️ 因此弹丸销毁时不能 dispose 共享资源（见 EntityManager.update 的 projectiles 清理）。
const _projGeoCache = new Map();
const _projMatCache = new Map();
function projGeo(size) {
  let g = _projGeoCache.get(size);
  if (!g) { g = new THREE.SphereGeometry(size, 8, 8); _projGeoCache.set(size, g); }
  return g;
}
function projMat(color) {
  let m = _projMatCache.get(color);
  if (!m) { m = new THREE.MeshBasicMaterial({ color }); _projMatCache.set(color, m); }
  return m;
}

// 爆炸光源池：每个爆炸原先 new 一个 PointLight，同屏多个动态光源会逼 GPU 对所有受光材质
// (坦克/飞机/建筑/地形) 重算 fragment，是密集交战掉帧主因。改为全局上限个 PointLight 借用——
// 池里有空闲就取，没有且未到上限就新建，到上限就返回 null（该爆炸不挂光源，靠 core 闪光球；
// core 是 MeshBasicMaterial 永亮、不受光，足够亮）。Explosion.dispose 时归还复用。
const _MAX_EXPLO_LIGHTS = 4;
const _exploLightPool = [];   // { light: PointLight, inUse: boolean }
function acquireExplosionLight() {
  for (const h of _exploLightPool) if (!h.inUse) { h.inUse = true; return h; }
  if (_exploLightPool.length < _MAX_EXPLO_LIGHTS) {
    const h = { light: new THREE.PointLight(0xffa040, 0, 40), inUse: true };
    _exploLightPool.push(h);
    return h;
  }
  return null;
}

class Projectile {
  constructor({ position, direction, speed, damage, owner = null, ownerTeam, color = 0xffe08a, size = 0.35, gravity = 0, life = 3 }) {
    this.mesh = new THREE.Mesh(projGeo(size), projMat(color));
    this.mesh.position.copy(position);
    this.radius = size;
    this.velocity = direction.clone().normalize().multiplyScalar(speed);
    this.launchPos = position.clone();   // 击杀回放：出膛点快照（按真实弹道慢放重演）
    this.launchVel = this.velocity.clone();
    this.maxLife = life;
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

    // 爆炸闪光（从全局光源池借用：池满则不挂，靠 core 闪光球——多动态光源是 GPU 杀手）
    const _lh = acquireExplosionLight();
    if (_lh) {
      this._lightHandle = _lh;
      this.light = _lh.light;
      this.light.color.setHex(color);
      this.light.distance = 30 * s;
      this.light.intensity = 4;
      this.group.add(this.light);
    }

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
    if (this.light) this.light.intensity = Math.max(0, 4 * (1 - t * 1.5));
    if (this.life <= 0) this.alive = false;
  }

  // 归还光源到池（摘下、归零、标记可用），并释放独立几何/材质。
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._lightHandle) {
      this.group.remove(this.light);
      this.light.intensity = 0;
      this._lightHandle.inUse = false;
      this._lightHandle = null; this.light = null;
    }
    this.core.geometry.dispose();
    this.core.material.dispose();
    this.smoke.geometry.dispose();
    this.smoke.material.dispose();
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

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
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

  // 几何 _smokeGeo 全局共享，不释放；只 dispose 独立 material。
  dispose() { this.mesh.material.dispose(); }
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
    this.obstacles = [];   // 障碍物列表（Game 从 terrain 注入，供炮弹碰撞检测）
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
      if (old) { if (old.dispose) old.dispose(); if (old.mesh) this.scene.remove(old.mesh); }
    }
  }

  update(dt) {
    for (const t of this.tanks) if (t.alive) t.update(dt);
    for (const p of this.planes) if (p.alive) p.update(dt);
    for (const p of this.projectiles) p.update(dt);
    for (const e of this.effects) e.update(dt);

    // 炮弹 vs 障碍物（楼房/树等）：穿不过，命中销毁 + 小火花（炸弹靠落点爆炸，不拦）
    if (this.obstacles && this.obstacles.length) {
      for (const p of this.projectiles) {
        if (!p.alive || p.isBomb) continue;
        for (const ob of this.obstacles) {
          const dx = p.mesh.position.x - ob.position.x;
          const dz = p.mesh.position.z - ob.position.z;
          const rr = (ob.radius || 3) + (p.radius || 0.4);
          if (dx * dx + dz * dz < rr * rr) { p.alive = false; this.addEffect(new Explosion(p.mesh.position.clone(), 1.2, 0xffa040)); break; }
        }
      }
    }

    // 清理失效弹丸
    this.projectiles = this.projectiles.filter((p) => {
      if (!p.alive) {
        this.scene.remove(p.mesh);
        // 几何/材质已全局缓存共享（projGeo/projMat），不在此 dispose（否则毁掉缓存）
        if (p.isBomb) {   // 炸弹落地/命中：范围爆炸（冲击波）
          const _bp = p.mesh.position.clone();
          const _nuke = p.isNuke;
          this.addEffect(new Explosion(_bp.clone().add(new THREE.Vector3(0, _nuke ? 10 : 2, 0)), _nuke ? 40 : 14, _nuke ? 0xff2200 : 0xff6600));
          if (_nuke) this.addEffect(new Explosion(_bp.clone().add(new THREE.Vector3(0, 20, 0)), 60, 0xff8800));   // 核弹蘑菇云
          const _R = p.bombRadius || 20;
          for (const t of [...this.tanks, ...this.planes]) {
            if (!t.alive || t === p.owner) continue;
            const _d = t.position.distanceTo(_bp);
            if (_d < _R) { t.onHit(p.damage * (_nuke ? Math.max(0.7, 1 - _d / _R) : Math.max(0.6, 1 - _d / _R))); t._lastAttacker = p.owner; }
          }
        }
        return false;
      }
      return true;
    });
    // 清理失效特效（统一走 dispose：归还光源/释放几何材质；Smoke 共享几何不在 dispose 里释放）
    this.effects = this.effects.filter((e) => {
      if (!e.alive) { if (e.dispose) e.dispose(); if (e.mesh) this.scene.remove(e.mesh); return false; }
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
          const verdict = t.onHit(p.damage, p);   // p 传入供装甲判定（穿深/弹种/发射者/发射者方位）
          const hitPoint = p.mesh.position.clone();   // X 光回放用：弹着点（爆炸/移除前留住）
          p.alive = false;
          this.addEffect(new Explosion(hitPoint, t.radius ? t.radius * 0.6 : 1, 0xffa040));
          hits.push({ owner: p.owner, target: t, proj: p, killed: wasAlive && !t.alive, crit: t.lastCrit, verdict, hitPoint });
          break;
        }
      }
    }
    return hits;
  }

  // 从场景与列表中移除已死亡载具，返回本次移除的列表（供 Game 计分 / 判定）。
  // hold：X 光回放期间要保留展示的受害车（回放结束后下一帧再移除）。
  cullDead(hold = null) {
    const removed = [];
    const _dispose = (g) => { g.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) { Array.isArray(c.material) ? c.material.forEach((m) => m.dispose()) : c.material.dispose(); } }); };
    this.tanks = this.tanks.filter((t) => {
      if (!t.alive) {
        if (t === hold) return true;   // 保留：X 光回放正在展示这辆车
        _dispose(t.group); this.scene.remove(t.group); removed.push(t); return false;
      }
      return true;
    });
    this.planes = this.planes.filter((p) => {
      if (!p.alive) { _dispose(p.group); this.scene.remove(p.group); removed.push(p); return false; }
      return true;
    });
    return removed;
  }

  clear() {
    for (const e of this.effects) { if (e.dispose) e.dispose(); if (e.mesh) this.scene.remove(e.mesh); }   // 先归还光源/释放资源
    for (const t of this.tanks) this.scene.remove(t.group);
    for (const p of this.planes) this.scene.remove(p.group);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.tanks = []; this.planes = []; this.projectiles = []; this.effects = [];
  }
}


// ===== js/entities/Tank.js =====





// 坦克：车体 + 可独立旋转炮塔 + 可俯仰炮管 + 履带。
// 战争雷霆式鼠标瞄准（炮塔偏航+炮管仰角跟随光标），WASD 独立开车体。
// team: 'blue'(玩家/队友) | 'red'(敌方)。按队伍区分伤害/装填/散布。

// 每种型号的几何规格：hull[宽,高,长]、炮塔样式与尺寸、炮管[半径,长]、负重轮数、是否有炮口制退器。
const GEOM = {
  medium:  { hull:[3.4, 1.0, 5.4], turret:'dome',     turretSize:[2.3, 1.0 ], barrel:[0.17, 3.6], wheels:5, brake:false, slope:0.85 }, // T-34-85
  m4:      { hull:[3.2, 1.5, 5.2], turret:'dome',     turretSize:[2.2, 1.1 ], barrel:[0.16, 3.0], wheels:6, brake:false, slope:0.45 }, // M4A3 谢尔曼（高）
  panzer2: { hull:[2.6, 0.95,4.0], turret:'box',      turretSize:[1.6, 0.7 ], barrel:[0.08, 1.8], wheels:5, brake:false, slope:0.40 }, // II 号（小）
  light:   { hull:[2.9, 1.0, 4.6], turret:'dome',     turretSize:[1.9, 0.9 ], barrel:[0.14, 2.6], wheels:5, brake:false, slope:0.60 }, // M24 霞飞
  scout:   { hull:[2.6, 0.9, 4.0], turret:'box',      turretSize:[1.5, 0.6 ], barrel:[0.12, 2.2], wheels:8, brake:false, slope:0.50 }, // 234/2 美洲狮（8 轮）
  td:      { hull:[3.6, 1.1, 6.2], turret:'casemate', turretSize:[3.0, 1.0 ], barrel:[0.26, 4.8], wheels:6, brake:true,  slope:0.70 }, // SU-100
  panther: { hull:[3.6, 1.2, 6.0], turret:'box',      turretSize:[2.6, 1.1 ], barrel:[0.18, 5.0], wheels:7, brake:true,  slope:0.95 }, // 黑豹 V（长炮管、陡前装甲）
  heavy:   { hull:[3.9, 1.5, 6.4], turret:'box',      turretSize:[3.0, 1.25], barrel:[0.24, 3.8], wheels:8, brake:true,  slope:0.40 }, // 虎 I（方正高大）
  is2:     { hull:[3.6, 1.3, 6.0], turret:'dome',     turretSize:[2.8, 1.15], barrel:[0.30, 4.2], wheels:6, brake:true,  slope:0.85 }, // IS-2（122mm 粗管）
  t80:     { hull:[3.6, 1.1, 6.0], turret:'flat',     turretSize:[3.0, 0.9 ], barrel:[0.22, 4.4], wheels:6, brake:false, slope:0.90 }, // T-80U（现代低矮）
  assault: { hull:[4.6, 1.8, 7.4], turret:'massive',  turretSize:[3.6, 1.6 ], barrel:[0.34, 3.8], wheels:8, brake:true,  slope:0.50 }, // 鼠式（巨大）
  m1a2:    { hull:[4.2, 1.4, 6.8], turret:'flat',     turretSize:[3.2, 1.0], barrel:[0.30, 4.6], wheels:7, brake:true,  slope:0.85 }, // M1A2 现代主战坦克
  aa:      { hull:[3.0, 1.0, 5.0], turret:'box',      turretSize:[2.2, 1.0], barrel:[0.06, 2.0], wheels:6, brake:false, slope:0.50 }, // 防空坦克
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
    if (!isEnemy && tt.dmg >= 2.5) this.shellDamage = 99999;   // 玩家方"一击必杀"型号(SU-100/IS-2/T-80U/鼠式)：一炮秒杀，不管打哪
    this.turretSpeed = CONFIG.tank.turretSpeed * tt.turret;
    this.turnSpeed = CONFIG.tank.turnSpeed * tt.turn;
    if (!isEnemy && type === 'aa') { this.turretSpeed *= 2.5; this.reloadTime *= 0.3; this.maxSpeed *= 1.8; this.turnSpeed *= 1.5; }   // 玩家防空炮：炮塔更快+射速更快+跑得更快+转向更快（buff 须在赋值之后，否则 *= 被下方赋值覆盖失效）
    this.fireSpread = isEnemy ? CONFIG.tank.enemySpread : (side === 'ally' ? CONFIG.tank.allySpread : 0);
    // 装甲/穿深（战争雷霆式：armor[前,侧,后]mm，pen 穿深 mm；老型号无则退化弱值，行为兜底）
    this.armor = tt.armor || [30, 20, 15];
    this.pen = tt.pen || 60;
    this.shellKind = 'ap';   // 当前弹种（玩家 1/2/3 切换；AI 用默认穿甲榴弹）

    this._build();
  }

  _build() {
    const g = GEOM[this.type] || GEOM.medium;
    const [hw, hh, hl] = g.hull;
    const bodyMat = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.55, metalness: 0.35, map: camoTexture() });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4, metalness: 0.65 });

    // 车体：按真实侧影挤出（倾斜前装甲 + 平车顶 + 倾斜车尾），不再是方块
    const hullY = hh * 0.5 + 0.4;
    const slope = g.slope ?? 0.5;
    const G = clamp(slope * hl * 0.5, hl * 0.15, hl * 0.55);   // 前装甲水平投影（越陡越长）
    const R = hl * 0.18;                                        // 车尾斜面投影
    const prof = new THREE.Shape();
    prof.moveTo(-hl / 2, 0); prof.lineTo(hl / 2, 0); prof.lineTo(hl / 2, hh * 0.35);
    prof.lineTo(hl / 2 - G, hh); prof.lineTo(-hl / 2 + R, hh); prof.lineTo(-hl / 2, hh * 0.55);
    prof.closePath();
    const hullGeo = new THREE.ExtrudeGeometry(prof, { depth: hw, bevelEnabled: false, steps: 1 });
    hullGeo.translate(0, 0, -hw / 2);   // 宽度居中
    hullGeo.rotateY(-Math.PI / 2);       // length→+Z(朝前)，宽度→X
    this.hull = new THREE.Mesh(hullGeo, bodyMat);
    this.hull.position.y = 0.4;          // 底贴履带
    this.hull.castShadow = true; this.hull.receiveShadow = true;
    this.group.add(this.hull);

    // 履带 + 负重轮 + 主动轮 + 托带轮 + 翼子板（按车体大小缩放，小车小履带）
    const ts = clamp(hh / 1.1, 0.72, 1.05);   // 履带尺寸系数：小车(II号/霞飞/美洲狮)缩小
    const wheelR = 0.62 * ts;
    for (const sx of [-1, 1]) {
      const tmat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1, map: makeTrackTexture() });
      if (sx < 0) this.trackMatL = tmat; else this.trackMatR = tmat;
      const track = new THREE.Mesh(new THREE.BoxGeometry(0.85, wheelR * 2.2, hl * 1.05), tmat);
      track.position.set(sx * (hw / 2 + 0.35), wheelR, 0);
      track.castShadow = true; this.group.add(track);
      const span = hl * 0.82;
      for (let i = 0; i < g.wheels; i++) {   // 负重轮
        const z = -span / 2 + (span * i) / Math.max(1, g.wheels - 1);
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, 0.5, 12), darkMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(sx * (hw / 2 + 0.35), wheelR, z);
        wheel.castShadow = true; this.group.add(wheel);
      }
      const sprocket = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 1.3, wheelR * 1.3, 0.5, 10), darkMat);  // 主动轮（车头）
      sprocket.rotation.z = Math.PI / 2; sprocket.position.set(sx * (hw / 2 + 0.35), wheelR * 1.05, span / 2 + 0.5); this.group.add(sprocket);
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(wheelR * 0.35, wheelR * 0.35, 0.5, 8), darkMat);   // 托带轮（车顶）
      roller.rotation.z = Math.PI / 2; roller.position.set(sx * (hw / 2 + 0.35), wheelR * 2.0, 0); this.group.add(roller);
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
    // 防空坦克(ZSU-23-4)：双管
    if (this.type === 'aa') {
      const barrel2 = barrel.clone();
      barrel2.position.x = br * 3;
      this.barrelPivot.add(barrel2);
      barrel.position.x = -br * 3;
    }
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
      case 'dome': { // 铸造圆炮塔（T-34/谢尔曼/IS-2）：旋转曲面，光滑圆润
        const pts = [[tw*0.55,0],[tw*0.52,th*0.25],[tw*0.46,th*0.5],[tw*0.36,th*0.75],[tw*0.22,th*0.92],[tw*0.08,th*1.02],[0,th*1.05]]
          .map(([x, y]) => new THREE.Vector2(x, y));
        add(new THREE.Mesh(new THREE.LatheGeometry(pts, 18), bodyMat));
        break;
      }
      case 'cyl': { // 圆柱炮塔也走旋转面（更圆润）
        const pts = [[tw*0.5,0],[tw*0.5,th*0.8],[tw*0.42,th*0.95],[0,th*0.98]].map(([x, y]) => new THREE.Vector2(x, y));
        add(new THREE.Mesh(new THREE.LatheGeometry(pts, 16), bodyMat));
        break;
      }
      case 'box':   // 焊接方炮塔（虎I/黑豹）：带斜前装甲（真实就是 welded 方块）
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 1.1), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 0.85, th * 0.7, tw * 0.25), bodyMat), 0, 0, tw * 0.55, -0.5);
        break;
      case 'flat':  // 现代低矮方炮塔（T-80U）
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 1.0), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 0.5, th * 0.6, tw * 0.3), bodyMat), 0, th * 0.2, tw * 0.5);
        break;
      case 'casemate': // 歼击车固定战斗室
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.7), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 0.9, th * 0.85, tw * 0.18), bodyMat), 0, 0, tw * 0.42, -0.5);
        break;
      case 'massive': // 巨型炮塔（鼠式）
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.85), bodyMat));
        add(new THREE.Mesh(new THREE.BoxGeometry(tw * 1.05, th * 0.5, tw * 0.2), bodyMat), 0, -th * 0.2, tw * 0.45);
        break;
      case 'open': // 开顶侦察
        add(new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * 0.8), bodyMat));
        break;
    }
    // 炮盾：炮管根部圆柱
    if (g.turret !== 'casemate' && g.turret !== 'open') {
      add(new THREE.Mesh(new THREE.CylinderGeometry(tw * 0.24, tw * 0.26, th * 0.55, 12), bodyMat), 0, th * 0.08, tw * 0.42, Math.PI / 2);
    }
    // 车长指挥塔（顶部小圆罩）
    if (g.turret !== 'open' && g.turret !== 'casemate') {
      const cupola = new THREE.Mesh(new THREE.CylinderGeometry(tw*0.14, tw*0.15, th*0.22, 10), bodyMat);
      cupola.position.set(tw*0.2, (g.turret==='dome' || g.turret==='cyl') ? th*0.95 : th*0.62, -tw*0.12);
      cupola.castShadow = true; turret.add(cupola);
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
    const targetPitch = clamp(Math.atan2(muzzleY - worldPoint.y, horiz), -1.4, 0.4);   // 上仰放宽到~80°(打飞机)；正值=压炮
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
    // 模块损伤自动修复（倒数，慢速）
    if (this.modules) for (const k in this.modules) if (this.modules[k] > 0) this.modules[k] = Math.max(0, this.modules[k] - dt * 0.5);
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
    const sh = shellById(this.shellKind);   // 弹种参数随弹丸下发
    em.addProjectile(new Projectile({
      position: muzzleWorld, direction: dir,
      speed: CONFIG.tank.shellSpeed, damage: this.shellDamage * sh.dmgMul,
      owner: this, ownerTeam: this.team,
      gravity: CONFIG.tank.shellGravity, life: CONFIG.tank.shellLife,
      color: this.team === 'blue' ? 0xffe08a : 0xff7755, size: 0.45,
      pen: this.pen * sh.penMul, shellDef: sh,
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
      pen: 12, shellDef: { id: 'mg', name: '机枪弹', penMul: 1, dmgMul: 1, bounceDeg: 74, noBounce: false },   // 轻弹：走装甲判定(基本打不穿坦克,只能蹭侦察车/防空炮薄皮)
    }));
    this.mgTimer = 0.1;
    return true;
  }

  // 战争雷霆式命中：穿深判定 → 跳弹/未击穿/击穿；击穿后弹药殉爆/起火/模块损坏。
  // projectile 参数由 EntityManager.checkCollisions 传入（含 pen 穿深与弹种定义）。
  // 返回 'bounce' | 'nopen' | 'pen'，供击杀反馈区分（跳弹叮/未击穿闷响）。
  onHit(damage, projectile) {
    if (!this.alive) return 'pen';
    // —— 装甲判定（仅带穿深的炮弹走；机枪弹/炸弹冲击波直接进伤害）——
    let mult = 1;
    if (projectile && projectile.pen) {
      const sh = projectile.shellDef || shellById('ap');
      // 命中方位：来弹水平方向相对车体朝向的夹角 → 前甲/侧甲/后甲分区
      // 用弹丸实际飞行方向（velocity）算入射方位——发射者开火后移走不影响（原来用 owner 位置会偏）
      const vlen = projectile.velocity.length();
      if (vlen > 1) {
        const dx = projectile.velocity.x;
        const dz = projectile.velocity.z;
        const rel = Math.atan2(-dx, -dz) - this.heading;   // 来弹方向取反=指向来处；0=正前
        const a = Math.abs(Math.atan2(Math.sin(rel), Math.cos(rel)));
        // 0..π：前 60°→前甲；60..120°→侧甲；120..π→后甲（斜穿法线增量并入入射角）
        const plate = a < Math.PI / 3 ? this.armor[0] : (a < 2 * Math.PI / 3 ? this.armor[1] : this.armor[2]);
        // 入射角：来弹方位与装甲法线的水平夹角（近似：侧甲/后甲垂直面直接用方位角偏移）
        let incidence = a < Math.PI / 3 ? a : Math.abs(a - Math.PI / 2) * (a < 2 * Math.PI / 3 ? 1 : 0); // 侧甲以接近法线入射为主
        if (a >= 2 * Math.PI / 3) incidence = Math.abs(a - Math.PI);  // 后甲
        const incDeg = Math.min(80, incidence * 180 / Math.PI);
        // 跳弹：入射角超过弹种跳弹角（榴弹 noBounce 不跳）
        if (!sh.noBounce && incDeg > sh.bounceDeg) {
          this.lastCrit = null;
          return 'bounce';
        }
        // 等效装甲 = 厚度 / cos(入射角)（80° 封顶防除零，最坏 ×5.7）
        const eff = plate / Math.max(0.18, Math.cos(incDeg * Math.PI / 180));
        if (projectile.pen < eff) {
          // 未击穿：榴弹溅射 25%，其他弹种只留弹坑
          if (sh.noBounce) { this.takeDamage(damage * 0.25); }
          this.lastCrit = null;
          return 'nopen';
        }
        // 击穿：穿深富余越多后效越足（≤1.3 倍封顶）
        mult = 1 + Math.min(0.3, (projectile.pen / eff - 1) * 0.3);
      }
    }
    const r = Math.random();
    const c = CONFIG.rules.crit;
    if (r < c.tankInstant) { this.lastCrit = '弹药殉爆'; this.takeDamage(this.health); }
    else {
      this.takeDamage(damage * mult);
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
    return 'pen';
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
  trainer:   { fuse:[5.5, 0.45], wing:7.5,  sweep:0.0,  prop:true,  engines:1 },  // 初教-6（螺旋桨教练机）
  fighter:   { fuse:[7.0, 0.5 ], wing:9.0,  sweep:0.3,  prop:false, engines:1 },  // F-16
  mig29:     { fuse:[7.5, 0.5 ], wing:9.5,  sweep:0.35, prop:false, engines:2 },  // MiG-29
  j10:       { fuse:[7.5, 0.5 ], wing:9.0,  sweep:0.4,  prop:false, engines:1 },  // 歼-10
  intercept: { fuse:[9.0, 0.55], wing:10.0, sweep:0.35, prop:false, engines:2 },  // MiG-31
  rafale:    { fuse:[7.5, 0.5 ], wing:9.5,  sweep:0.45, prop:false, engines:2 },  // 阵风
  heavy:     { fuse:[9.0, 0.65], wing:13.0, sweep:0.25, prop:false, engines:2 },  // F-15
  attacker:  { fuse:[6.5, 0.8 ], wing:11.0, sweep:0.1,  prop:false, engines:2 },  // A-10
  su35:      { fuse:[9.5, 0.55], wing:11.5, sweep:0.3,  prop:false, engines:2 },  // Su-35
  typhoon:   { fuse:[8.0, 0.5 ], wing:10.0, sweep:0.4,  prop:false, engines:2 },  // 台风
  jet:       { fuse:[9.0, 0.5 ], wing:10.0, sweep:0.6,  prop:false, engines:2 },  // F-22
  j20:       { fuse:[10.0,0.55], wing:11.0, sweep:0.55, prop:false, engines:2 },  // 歼-20
  f35:       { fuse:[9.0, 0.6 ], wing:9.5,  sweep:0.5,  prop:false, engines:1 },  // F-35
  bomber:    { fuse:[13.0,0.8 ], wing:18.0, sweep:0.3,  prop:false, engines:2 }, // 轰炸机（大型双发）
  f35b:      { fuse:[9.5, 0.55], wing:10.5, sweep:0.55, prop:false, engines:1 }, // B-21 隐身轰炸机（小而快）
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
    const _pt = planeTypeById(type);
    this.maxMissiles = (_pt.missiles && side === 'player') ? mc.count : 0;
    this.missileSpeedMul = _pt.fastMissile ? 4.5 : 1;   // F-35/轰炸机：导弹 4.5 倍速
    this.missiles = this.maxMissiles;
    const bc = CONFIG.plane.bomb;
    this.maxBombs = ((type === 'bomber' || _pt.bombs) && side === 'player') ? bc.count : 0;
    this.bombs = this.maxBombs;
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
    // 炸弹自动补充：每 regen 秒 +1
    if (this.maxBombs > 0 && this.bombs < this.maxBombs) {
      this.bombRegen = (this.bombRegen || 0) + dt;
      if (this.bombRegen >= CONFIG.plane.bomb.regen) {
        this.bombRegen = 0;
        this.bombs = Math.min(this.maxBombs, this.bombs + 1);
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
    if (this.group.position.y <= gnd) {
      this.group.position.y = gnd; this.health = 0; this.alive = false;
      // 坠机爆炸：伤害附近实体（冲击波，像炸弹）
      if (this.em && !this._crashed) {
        this._crashed = true;
        const _pos = this.position.clone();
        this.em.addEffect(new Explosion(_pos.clone().add(new THREE.Vector3(0, 2, 0)), 10, 0xff6600));
        const _R = 28, _dmg = 100;
        for (const t of [...this.em.tanks, ...this.em.planes]) {
          if (t === this || !t.alive || t.team === this.team) continue;   // 不伤同队（坠机不误伤友军，与子弹/炸弹一致）
          const _d = t.position.distanceTo(_pos);
          if (_d < _R) { t.onHit(_dmg * (1 - _d / _R)); t._lastAttacker = this; }
        }
      }
    }
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
      this._lerpColor = this._lerpColor || new THREE.Color();   // 缓存 Color 实例，避免每帧 new（起火/灭火颜色过渡）
      this._lerpColor.setHex(target);
      this.bodyMat.color.lerp(this._lerpColor, Math.min(1, 4 * dt));
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
        pen: 25, shellDef: { id: 'cannon', name: '航炮弹', penMul: 1, dmgMul: 1, bounceDeg: 74, noBounce: false },   // 航炮：对坦克走装甲判定(25mm级,撕得动薄皮撕不动重甲)
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
      if (fwd.dot(to.clone().normalize()) < 0) continue; // 只锁前半球目标（含下方地面坦克），跳过正后方避免朝后发射浪费导弹
      if (d < bestD) { bestD = d; best = t; }
    }
    const mc = CONFIG.plane.missile;
    const dir = best ? best.position.clone().sub(this.position).normalize() : fwd;
    const proj = new Projectile({
      position: this.position.clone().addScaledVector(fwd, 2), direction: dir,
      speed: mc.speed * (this.missileSpeedMul || 1), damage: mc.damage, owner: this, ownerTeam: this.team,
      gravity: 0, life: mc.life, color: 0xff5544, size: mc.radius,
    });
    proj.target = best; proj.homing = mc.homing;
    em.addProjectile(proj);
    this.missiles -= 1; this.missileCooldown = mc.cooldown;
    return true;
  }

  // 投炸弹（无追踪、有重力、落地范围爆炸）
  tryDropBomb(em) {
    if (!this.alive || this.bombs <= 0) return false;
    const bc = CONFIG.plane.bomb;
    const fwd = this.forwardVector();
    const proj = new Projectile({
      position: this.position.clone().addScaledVector(fwd, -2).add(new THREE.Vector3(0, -1, 0)),
      direction: new THREE.Vector3(0, -1, 0), speed: 1,
      damage: bc.damage, owner: this, ownerTeam: this.team,
      gravity: bc.gravity, life: bc.life, color: 0x555555, size: 0.6,
    });
    proj.velocity.copy(fwd.clone().multiplyScalar(this.speed * 1.2).add(new THREE.Vector3(0, -5, 0)));
    proj.isBomb = true; proj.bombRadius = bc.radius;
    em.addProjectile(proj);
    this.bombs -= 1;
    return true;
  }

  // 投核弹（消耗3颗普通炸弹，威力巨大）—仅 B-21
  tryDropNuke(em) {
    if (!this.alive || this.bombs < 3) return false;
    const fwd = this.forwardVector();
    const proj = new Projectile({
      position: this.position.clone().addScaledVector(fwd, -2).add(new THREE.Vector3(0, -1, 0)),
      direction: new THREE.Vector3(0, -1, 0), speed: 1,
      damage: 3000, owner: this, ownerTeam: this.team,
      gravity: 18, life: 15, color: 0xff2200, size: 1.2,
    });
    proj.velocity.copy(fwd.clone().multiplyScalar(this.speed * 0.8).add(new THREE.Vector3(0, -3, 0)));
    proj.isBomb = true; proj.isNuke = true; proj.bombRadius = 80;
    em.addProjectile(proj);
    this.bombs -= 3;
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
      if (tank.canFire() && dist < 130 && Math.random() < 0.25) tank.tryFire(em);   // 撤退时开火更保守（原 0.5 比正常 enemyFireChance 0.4 还高，反直觉）
      return;
    }

    let turn = clamp(headingDiff * 2, -1, 1);
    // 距离控制：远了冲，中距停射、近了退、太近倒车+侧移（不再只往前冲）
    let throttle;
    if (dist > 55) throttle = 1;            // 远：冲
    else if (dist > 30) throttle = 0.2;     // 中距：慢慢靠近
    else if (dist > 15) throttle = -0.2;     // 偏近：微退
    else throttle = -0.8;                    // 太近：倒车
    // 侧向移动（增加横向位移，避免直线冲脸）：周期性左右偏转
    this._strafeTimer = (this._strafeTimer || 0) + dt;
    if (this._strafeTimer > 2.5 + Math.random() * 2) { this._strafeDir = (this._strafeDir || 1) * -1; this._strafeTimer = 0; }
    turn += (this._strafeDir || 0) * 0.3;

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
    const isAirTarget = typeof target.forwardVector === 'function';   // 目标是飞机
    if (!target.isZone && tank.canFire() && dist < 160 && Math.abs(aimDiff) < aimThresh && Math.random() < fireChance) {
      tank.tryFire(em);
    }
    // 打飞机时额外用机枪（密集火力追着飞机打）；敌方不用（太超模）
    if (isAirTarget && !isEnemy && dist < 120 && Math.abs(aimDiff) < 0.15) {
      tank.tryFireMG(em);
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
      plane.throttle = 0.8;   // 保持速度（原不设油门→低速重力下沉，残局敌机自己摔死）
      plane.aimToward(new THREE.Vector3(0, 0.02, 1).normalize(), dt); // 近似平飞微抬，不再下俯
      return;
    }

    const toT = new THREE.Vector3().subVectors(target.position, plane.position);
    const dist = toT.length() || 1;
    const desired = toT.multiplyScalar(1 / dist);

    // 略提前量：瞄向目标稍前方（跨类型：飞机用 forwardVector，坦克用 heading 算前向）
    const tgtFwd = (typeof target.forwardVector === 'function')
      ? target.forwardVector()
      : new THREE.Vector3(Math.sin(target.heading || 0), 0, Math.cos(target.heading || 0));
    const lead = tgtFwd.multiplyScalar(Math.min(dist * 0.15, 20));
    const aimPt = target.position.clone().add(lead);
    const aimDir = aimPt.sub(plane.position).normalize();

    // 低血规避：周期性侧滑（jink），让玩家更难追瞄
    if (plane.health / plane.maxHealth < 0.4) {
      this._jink = (this._jink || 0) + dt * 2.2;
      const side = new THREE.Vector3().crossVectors(aimDir, new THREE.Vector3(0, 1, 0)).normalize();
      aimDir.addScaledVector(side, Math.sin(this._jink) * 0.5).normalize();
    }

    // 地形规避：低空时强制上仰（世界大战打地面目标时防坠机）
    const groundClear = plane.position.y - terrainHeight(plane.position.x, plane.position.z);
    if (groundClear < 5) { aimDir.y = Math.max(aimDir.y, 0.2 + (5 - groundClear) * 0.05); aimDir.normalize(); }   // 低空限制降到5：飞机能贴近地面扫射坦克

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
  sun.shadow.mapSize.set(4096, 4096);
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



// 地图主题：不同地形（色调 / 雾 / 密度 / 城镇街区 / 起伏）。菜单"🗺 地图"按钮在这些里循环。
const MAPS = [
  { id:'city',    name:'城镇巷战', urban:'block', towns:0, density:1.0, build:0x7c7268, fog:0x706a62, bg:0x8a847c, gLow:[0.30,0.29,0.26], gHigh:[0.42,0.40,0.36], leaf:0x3a4030, wall:0x5a544c, height:0.45, wallColor:0x9aa0a0 },
  { id:'open',    name:'旷野',     urban:false, towns:2, density:1.3, fog:0xbfd3c4, bg:0xbfd3c4, gLow:[0.34,0.48,0.24], gHigh:[0.50,0.45,0.27], leaf:0x3f6b35, wall:0x6b5d3f, height:1.0, wallColor:0x88ff99 },
  { id:'hills',   name:'丘陵山地', urban:false, towns:1, density:1.0, fog:0xaab39a, bg:0xbfd3c4, gLow:[0.28,0.43,0.20], gHigh:[0.46,0.42,0.26], leaf:0x356b30, wall:0x6b5d3f, height:1.6, wallColor:0x88ff99 },
  { id:'desert',  name:'沙漠',     urban:false, towns:1, density:0.85,fog:0xd8c994, bg:0xe8d7a8, gLow:[0.76,0.66,0.40], gHigh:[0.88,0.78,0.52], leaf:0x6b6030, wall:0x8a7a4a, height:0.7, wallColor:0xe0c878 },
  { id:'forest',  name:'密林',     urban:false, towns:0, density:1.7, fog:0x8fae84, bg:0xaec5a4, gLow:[0.15,0.32,0.13], gHigh:[0.30,0.40,0.20], leaf:0x2a5a25, wall:0x4a4030, height:1.0, wallColor:0x88ff99 },
  { id:'factory', name:'工业厂区', urban:'shed', towns:0, density:1.0, build:0x56565c, fog:0x6f6f74, bg:0x808086, gLow:[0.26,0.26,0.28], gHigh:[0.37,0.37,0.40], leaf:0x3a4030, wall:0x4a4a4e, height:0.5, wallColor:0xaaaaaa },
  { id:'snow',    name:'雪原',     urban:false, towns:1, density:1.1, fog:0xd6dfe6, bg:0xe8eef2, gLow:[0.80,0.84,0.88], gHigh:[0.92,0.94,0.97], leaf:0x3a5a40, wall:0x6a6a6a, height:1.1, wallColor:0xc0d0e0 },
];

// 创建地面 + 障碍物 + 边界，返回 { group, obstacles, half }。mapId 决定地形主题。
function createTerrain(scene, mode, mapId) {
  const group = new THREE.Group();
  const obstacles = [];

  const half = (mode === 'plane' ? CONFIG.plane.worldSize : CONFIG.tank.worldSize);
  const theme = MAPS.find((m) => m.id === mapId) || MAPS[1];
  if (theme.height != null) setTerrainScale(theme.height);   // 按地图调整起伏
  if (mode === 'tank') {                                     // 仅陆战按地图覆盖天空/雾（空战保留蓝色天空）
    scene.background = new THREE.Color(theme.bg);
    scene.fog = new THREE.Fog(theme.fog, 120, 450);
  }

  // 地面（细分高度场 + 顶点色：按地图调色板，低处→高处渐变）
  const groundSize = half * 2 + 400;
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, 120, 120);
  groundGeo.rotateX(-Math.PI / 2);
  const gpos = groundGeo.attributes.position;
  const gcol = [];
  const [loR, loG, loB] = theme.gLow, [hiR, hiG, hiB] = theme.gHigh;
  for (let i = 0; i < gpos.count; i++) {
    const y = terrainHeight(gpos.getX(i), gpos.getZ(i));
    gpos.setY(i, y);
    const t = clamp((y + 15) / 30, 0, 1); // -15..15 → 0..1
    gcol.push(loR + (hiR - loR) * t, loG + (hiG - loG) * t, loB + (hiB - loB) * t);
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
    new THREE.MeshBasicMaterial({ color: theme.wallColor || 0x88ff99, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
  );
  wall.position.y = wallH / 2;
  group.add(wall);

  // —— 障碍物：集中在交战区(±spread)，按地图主题生成 ——
  const spread = mode === 'tank' ? half - 30 : half;
  const baseCount = (mode === 'plane' ? 24 : 46) * (spread / 260);
  const obstacleCount = Math.round(baseCount * (theme.density || 1));
  const buildPal = theme.build || 0x80766a;
  const addBuilding = (x, z, pal, big) => {
    const w = randRange(big ? 11 : 7, big ? 22 : 16), h = randRange(big ? 9 : 6, big ? 26 : 18), d = randRange(big ? 11 : 7, big ? 22 : 16);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: pal, roughness: 0.9 }));
    m.position.set(x, h / 2 + terrainHeight(x, z), z);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    obstacles.push({ position: new THREE.Vector3(x, 0, z), radius: Math.max(w, d) / 2 });
  };

  // 城镇(街区网格) / 工厂(大片厂房)——密集巷战
  if (theme.urban && mode === 'tank') {
    if (theme.urban === 'shed') {
      // 工厂：宽矮大厂房 + 小铁棚
      const cell = 70, street = 14;
      for (let bx = -spread; bx < spread; bx += cell + street) {
        for (let bz = -spread; bz < spread; bz += cell + street) {
          if (Math.hypot(bx, bz) < 75) continue;
          const w = randRange(20, 32), h = randRange(8, 14), d = randRange(18, 30);
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: buildPal, roughness: 0.85, metalness: 0.2 }));
          m.position.set(bx + randRange(-6, 6), h / 2 + terrainHeight(bx, bz), bz + randRange(-6, 6));
          m.castShadow = true; m.receiveShadow = true; group.add(m);
          obstacles.push({ position: new THREE.Vector3(m.position.x, 0, m.position.z), radius: Math.max(w, d) / 2 });
          if (Math.random() < 0.6) addBuilding(bx + randRange(-cell / 2, cell / 2), bz + randRange(-cell / 2, cell / 2), 0x4a4a50);
        }
      }
    } else {
      // 城镇：街区四边大楼（同街区差不多高，像真街区）
      const cell = 62, street = 14;
      for (let bx = -spread; bx < spread; bx += cell + street) {
        for (let bz = -spread; bz < spread; bz += cell + street) {
          if (Math.hypot(bx, bz) < 78) continue;   // 中央战场/占领点留空
          const ph = randRange(11, 26);
          const place = (ox, oz) => {
            const w = randRange(10, 18), h = ph + randRange(-3, 3), d = randRange(10, 18);
            const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: buildPal, roughness: 0.9 }));
            m.position.set(bx + ox, h / 2 + terrainHeight(bx + ox, bz + oz), bz + oz);
            m.castShadow = true; m.receiveShadow = true; group.add(m);
            obstacles.push({ position: new THREE.Vector3(bx + ox, 0, bz + oz), radius: Math.max(w, d) / 2 });
          };
          place(randRange(-cell / 3, cell / 3), -cell / 2 + randRange(-3, 3));
          place(randRange(-cell / 3, cell / 3), cell / 2 + randRange(-3, 3));
          place(-cell / 2 + randRange(-3, 3), randRange(-cell / 3, cell / 3));
          place(cell / 2 + randRange(-3, 3), randRange(-cell / 3, cell / 3));
          if (Math.random() < 0.6) place(randRange(-8, 8), randRange(-8, 8));
        }
      }
    }
  }

  // 小镇群（散落村镇）
  for (let c = 0; c < (theme.towns || 0); c++) {
    const cx = randRange(-spread * 0.8, spread * 0.8), cz = randRange(-spread * 0.8, spread * 0.8);
    if (Math.hypot(cx, cz) < 60) continue;
    for (let k = 0; k < randInt(6, 10); k++) {
      const x = cx + randRange(-26, 26), z = cz + randRange(-26, 26);
      if (Math.abs(x) < 24 && Math.abs(z) < 24) continue;
      addBuilding(x, z, buildPal, true);
    }
  }

  // 散落掩体：类型按地图 mix 配比；位置在 ±spread 内
  const mix = theme.mix || { building: 0.3, rock: 0.25, tree: 0.3, wall: 0.15 };
  const types = Object.keys(mix);
  const pickType = () => { const r = Math.random(); let acc = 0; for (const t of types) { acc += mix[t]; if (r < acc) return t; } return types[0]; };
  for (let i = 0; i < obstacleCount; i++) {
    const x = randRange(-spread, spread), z = randRange(-spread, spread);
    if (Math.abs(x) < 24 && Math.abs(z) < 24) continue;
    const type = pickType();
    let mesh, radius;
    if (type === 'building') {
      const w = randRange(8, 18), h = randRange(7, 22), d = randRange(8, 18);
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: buildPal, roughness: 0.9 }));
      mesh.position.set(x, h / 2 + terrainHeight(x, z), z); radius = Math.max(w, d) / 2;
    } else if (type === 'rock') {
      const r = randRange(2, 6);
      mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), new THREE.MeshStandardMaterial({ color: 0x807872, roughness: 1, flatShading: true }));
      mesh.position.set(x, r * 0.7 + terrainHeight(x, z), z); mesh.rotation.set(randRange(0, 1), randRange(0, 1), randRange(0, 1)); radius = r;
    } else if (type === 'tree') {
      const tree = new THREE.Group();
      const trunkH = randRange(3, 5);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, trunkH, 6), new THREE.MeshStandardMaterial({ color: 0x5b4127, roughness: 1 }));
      trunk.position.y = trunkH / 2; trunk.castShadow = true;
      const leaves = new THREE.Mesh(new THREE.ConeGeometry(randRange(2.5, 4), randRange(5, 8), 7), new THREE.MeshStandardMaterial({ color: theme.leaf || 0x3f6b35, roughness: 1, flatShading: true }));
      leaves.position.y = trunkH + 3; leaves.castShadow = true;
      tree.add(trunk, leaves); tree.position.set(x, terrainHeight(x, z), z); mesh = tree; radius = 2.5;
    } else if (type === 'wall') {
      const w = randRange(8, 16), h = randRange(1.6, 2.4), d = randRange(1.5, 2.5);
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: theme.wall || 0x6b5d3f, roughness: 1, flatShading: true }));
      mesh.position.set(x, h / 2 + terrainHeight(x, z), z); mesh.rotation.y = randRange(0, Math.PI); radius = w / 2;
    } else { // ruin
      const w = randRange(3, 6);
      mesh = new THREE.Mesh(new THREE.BoxGeometry(w, w, w * 1.4), new THREE.MeshStandardMaterial({ color: 0x3a3530, roughness: 1, metalness: 0.3, flatShading: true }));
      mesh.position.set(x, w * 0.5 + terrainHeight(x, z), z); mesh.rotation.set(randRange(-0.4, 0.4), randRange(0, 6.28), randRange(-0.4, 0.4)); radius = w;
    }
    mesh.castShadow = true; mesh.receiveShadow = true;
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
  // 被击中闷响：低频下坠 + 短促重击，与"打中敌人"的高频叮区分开（战场受击感）。
  // 两层：200→60Hz 低音坠落(主体) + 90Hz 三角波垫底(金属钝响)。
  hitTaken() {
    this._blip(200, 60, 0.22, 0.5, 'sine');
    this._blip(90, 70, 0.14, 0.25, 'triangle');
  }
  // 跳弹：金属"叮"（高频快衰减）。未击穿：闷"咚"（中低频短促）。
  bounce() { this._blip(2400, 1200, 0.09, 0.3, 'square'); }
  nopen() { this._blip(160, 110, 0.1, 0.35, 'sine'); }
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
  constructor({ canvas, mode = 'tank', difficulty = 'normal', tankType = 'medium', planeType = 'fighter', endless = false, objective = 'battle', mapId = 'open', worldwar = false, ownedTanks = ['medium'], ownedPlanes = ['fighter'], hudContainer, onExit, onResult } = {}) {
    this.canvas = canvas;
    this.mode = mode;
    this.difficulty = difficulty;
    this.tankType = tankType;
    this.planeType = planeType;
    this.endless = endless;
    this.objective = mode === 'tank' ? objective : 'battle';   // 'battle'(歼灭) | 'capture'(占领，仅陆战)
    this.mapId = mode === 'tank' ? mapId : 'open';             // 地图主题（仅陆战）
    this.worldwar = worldwar;                                  // 世界大战：混合作战（坦克+飞机同场）
    this.ownedTanks = ownedTanks;                              // 已拥有的坦克型号（选载具面板用）
    this.ownedPlanes = ownedPlanes;                            // 已拥有的飞机型号
    this.onExit = onExit;
    this.onResult = onResult;
    this.state = 'playing';
    this.settings = loadSettings();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

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
      if (this.state !== 'playing' || this._disposed || this.paused) return;   // 暂停中不锁（遮罩在用光标）
      if (document.pointerLockElement === this.canvas) return;
      if (e.button !== 0) return; // 只响应左键（右键 click 不会触发，防御一下）
      try {
        const p = this.canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(() => {}); // 失败则下次点击重试
      } catch (err) {}
    };
    document.addEventListener('click', this._onDocClickPL);
    // Esc 暂停/恢复（常驻）：指针锁定时 Esc 被浏览器消费（走 _onPLChange 暂停），页面收不到
    // keydown；这里只处理"未锁定/已暂停"状态的 Esc。
    this._onEscKey = (e) => {
      if (e.code !== 'Escape' || e.repeat) return;
      if (this.state !== 'playing' || this._disposed || this._wwPick) return;
      this._togglePause();
    };
    window.addEventListener('keydown', this._onEscKey);
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
      } else if (this.state === 'playing' && !this.paused && !this._wwPick && !this._disposed) {
        // 指针锁定时按 Esc：浏览器直接退出锁定、页面收不到 keydown Escape → 顺势暂停。
        // 程序化退锁的场景各自有状态守卫：_pause 自身（paused 已 true）、_end（state=over）、
        // 世界大战选载具（_wwPick 先置 true 再退锁）、dispose（_disposed 先置 true）。
        this._pause();
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
      this.hud.setHint('<b>点击画面锁定鼠标</b>（炮塔可无限转，Esc 暂停）· <b>WASD</b> 车体 · <b>左键</b>主炮 · <b>1/2/3</b>切弹种 · <b>空格</b>机枪 · <b>Shift</b>瞄准镜 · <b>R</b>修车 · <b>F</b>灭火');
    } else {
      this.hud.setHint('<b>点击画面锁定鼠标</b>（指哪飞哪，自动改平，Esc 暂停）· <b>W/S</b>油门 · <b>Shift</b>加力 · <b>左键</b>开火 · <b>右键/X</b>导弹(喷气机) · <b>F</b>灭火');
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
    this.terrain = createTerrain(this.scene, this.worldwar ? 'tank' : mode, this.mapId);   // 世界大战永远用坦克地形（不管玩家选飞机还是坦克）
    if (this.em && this.terrain && this.terrain.obstacles) this.em.obstacles = this.terrain.obstacles;   // 障碍物注入 em，供炮弹碰撞检测
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

    this._setupObjective();
    this.hud.setCenterMessage('');
    this.hud.addFeed(this.worldwar ? '世界大战 · 坦克+飞机混合作战！死后按 T/P 选新载具' : (this.objective === 'capture' ? '战斗开始 · 占领中央据点！' : '战斗开始 · 队友已就位'), 'info');
  }

  // 占领模式：据点设置/清理。中央圆柱+光环，蓝南红北出生。
  _setupObjective() {
    this._clearCapture();
    this.captureProgress = 0;
    if (this.objective !== 'capture') { if (this.hud) this.hud.setCapture(null); return; }
    const r = CONFIG.tank.captureRadius;
    this.captureZone = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.4, 40),
      new THREE.MeshBasicMaterial({ color: 0x554a2a, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    this.captureZone.position.set(0, 0.3, 0);
    this.captureZoneRing = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.9, 8, 48),
      new THREE.MeshBasicMaterial({ color: 0xffdd44 })
    );
    this.captureZoneRing.rotation.x = Math.PI / 2;
    this.captureZoneRing.position.set(0, 1.2, 0);
    this.scene.add(this.captureZone, this.captureZoneRing);
    this._zoneTarget = { position: new THREE.Vector3(0, 0, 0), alive: true, isZone: true };
    this.hud.addFeed('占领模式 · 控制中央据点，进度先满 100% 获胜', 'info');
  }
  _clearCapture() {
    for (const m of [this.captureZone, this.captureZoneRing]) {
      if (m) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    }
    this.captureZone = null; this.captureZoneRing = null; this._zoneTarget = null;
  }

  _playerBasePos() {
    if (this.mode === 'tank') return new THREE.Vector3(0, 0, -(CONFIG.tank.worldSize - 45));   // 南侧边缘
    return new THREE.Vector3(0, CONFIG.plane.spawnAltitude, 0);
  }

  _makePlayer() {
    const base = this._playerBasePos();
    if (this.mode === 'tank') {
      this.player = new Tank({ side: 'player', color: 0x4f7a3a, type: this.tankType });
      if (this._shellPref) this.player.shellKind = this._shellPref;   // 弹种偏好跨重生保留
      this.player.group.position.copy(base);
      this.player.heading = 0;
      this.em.addTank(this.player);
    } else {
      this.player = new Plane({ side: 'player', color: 0x3a6b9e, type: this.planeType });
      this.player.group.position.copy(base);
      this.player.group.quaternion.identity();
      this.em.addPlane(this.player);
      if (this.worldwar) this.player.worldSize = CONFIG.tank.worldSize;
    }
    this.gunnerView = false;
    this._snapCam = true;
    // 预置相机位置，避免第一帧输入用到默认相机（0,0,0）
    if (this.mode === 'tank') this._updateCameraTank(0.016);
    else this._updateCameraPlane(0.016);
    this.hud.showCrosshair();               // 出生/复活：准星回来
  }

  _spawnEnemy() {
    const asTank = this.worldwar ? Math.random() < 0.5 : (this.mode === 'tank');
    if (asTank) {
      const e = new Tank({ side: 'enemy', team: 'red', color: 0x9a7b3e, type: randomTankType().id });
      const h = CONFIG.tank.worldSize;
      // 红方一律从地图北侧边缘出生（和蓝方南北对角）
      e.group.position.set(randRange(-h * 0.4, h * 0.4), 0, randRange(h * 0.55, h - 45));
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
      if (this.worldwar) e.worldSize = CONFIG.tank.worldSize;   // 世界大战：飞机用坦克地图大小，不飞出地图
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
    const asTank = this.worldwar ? Math.random() < 0.5 : (this.mode === 'tank');
    if (asTank) {
      const e = new Tank({ side: 'ally', team: 'blue', color: 0x3a6b8a, type: randomTankType().id });
      const h = CONFIG.tank.worldSize;
      // 蓝方(玩家队)从南侧边缘出生，和玩家一起
      e.group.position.set(randRange(-40, 40), 0, randRange(-(h - 45), -(h * 0.55)));
      e.heading = Math.atan2(-e.group.position.x, -e.group.position.z);
      e.ai = new TankAI(e);
      this.em.addTank(e);
      this.allies.push(e);
    } else {
      const e = new Plane({ side: 'ally', team: 'blue', color: 0x5a8eb8, type: randomPlaneType().id });
      e.group.position.set(randRange(-30, 30), CONFIG.plane.spawnAltitude + randRange(-8, 8), randRange(-30, 30));
      e.group.quaternion.identity();
      e.ai = new PlaneAI(e);
      this.em.addPlane(e);
      if (this.worldwar) e.worldSize = CONFIG.tank.worldSize;
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
    const YAW_SENS = 0.0026, H_SENS = this.worldwar ? 0.15 : 0.06, R = 90;
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
    this._aimHeight = clamp((this._aimHeight ?? 0) - mdy * H_SENS, -28, this.worldwar ? 120 : 28); // 世界大战抬高到120：能瞄天上飞机
    this._tankAimPt = t.position.clone().add(new THREE.Vector3(Math.sin(this._aimYaw) * R, 2 + this._aimHeight, Math.cos(this._aimYaw) * R));
    t.aimTurretAt(this._tankAimPt, dt, 0);

    // 修车（按住 R）：不能动但可以开火/灭火，消耗时间修血+模块
    this._repairing = inp.isDown('KeyR') && t.health < t.maxHealth;
    if (this._repairing) {
      t.drive(0, 0, dt);   // 修车时不能移动（覆盖上面的 drive）
      t.health = Math.min(t.maxHealth, t.health + 15 * dt);
      if (t.modules) {
        if (t.modules.track > 0) t.modules.track = Math.max(0, t.modules.track - dt * 3);
        if (t.modules.barrel > 0) t.modules.barrel = Math.max(0, t.modules.barrel - dt * 3);
        if (t.modules.engine > 0) t.modules.engine = Math.max(0, t.modules.engine - dt * 3);
      }
      this.hud.setCenterMessage(`🔧 修车中… ${Math.floor(t.health)}/${t.maxHealth}`);
    }

    if (inp.mouseDown) t.tryFire(this.em);
    if (inp.isDown('Space')) t.tryFireMG(this.em);
    if (this._consumePress(inp, 'KeyF')) this._extinguish(t);
    // 弹种切换（1/2/3）：偏好存 this._shellPref，跨重生/换车保留
    for (let i = 0; i < SHELLS.length; i++) {
      if (this._consumePress(inp, 'Digit' + (i + 1))) {
        this._shellPref = SHELLS[i].id;
        t.shellKind = SHELLS[i].id;
        this.hud.addFeed(`已切换：${SHELLS[i].icon} ${SHELLS[i].name}`, 'info');
        this.sfx.ui();
      }
    }
    this.hud.setShell(shellById(t.shellKind), t.pen * shellById(t.shellKind).penMul);
    this.gunnerView = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
  }

  _handleInputPlane(dt) {
    this.hud.hideShell();   // 开飞机时藏掉坦克弹种框（worldwar 切载具后不残留）
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
    // 修车（按住 R）：飞机也能修，但减速
    this._repairing = inp.isDown('KeyR') && p.health < p.maxHealth;
    if (this._repairing) {
      p.health = Math.min(p.maxHealth, p.health + 12 * dt);
      this.hud.setCenterMessage(`🔧 维修中… ${Math.floor(p.health)}/${p.maxHealth}`);
    }

    if (inp.mouseDown) p.tryFire(this.em);
    if (this._consumePress(inp, 'KeyF')) this._extinguish(p);
    // 导弹（喷气机）：右键或 X
    if ((inp.rightMouseDown || inp.isDown('KeyX')) && p.missiles > 0) {
      if (p.tryFireMissile(this.em, this.enemies)) { this.hud.addFeed(`🚀 导弹 ${p.missiles}/${p.maxMissiles}`, 'info'); this.sfx.missile(p.position); }
    }
    if (this._consumePress(inp, 'KeyB') && p.bombs > 0) {
      if (p.tryDropBomb(this.em)) { this.hud.addFeed(`💣 炸弹 ${p.bombs}/${p.maxBombs}`, 'info'); }
    }
    if (this._consumePress(inp, 'KeyL') && p.bombs >= 3) {
      if (p.tryDropNuke(this.em)) { this.hud.addFeed(`☢️ 核弹！消耗3颗炸弹`, 'kill'); }
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
      const desired = muzzle.clone().addScaledVector(dir, -2.0).add(new THREE.Vector3(0, 0.6, 0));   // 抬到炮管上方，避免被炮管遮挡
      if (this._snapCam) { this.camera.position.copy(desired); this._snapCam = false; }
      else this.camera.position.lerp(desired, 0.5);
      this.camera.lookAt(muzzle.clone().addScaledVector(dir, 60));
      this._setFov(26, dt);
    } else {
      // 相机跟"鼠标瞄准方位"(_aimYaw)，不再跟炮塔方位——鼠标一动相机立刻转，炮塔随后 slew 对齐。
      const ay = this._aimYaw ?? t.heading;
      const tp = t.position;
      const dd = 1.2;
      _tankN.set(terrainHeight(tp.x - dd, tp.z) - terrainHeight(tp.x + dd, tp.z), 2 * dd, terrainHeight(tp.x, tp.z - dd) - terrainHeight(tp.x, tp.z + dd)).normalize();
      _tankFwd.set(Math.sin(ay), 0, Math.cos(ay));
      _tankFwd.addScaledVector(_tankN, -_tankFwd.dot(_tankN)).normalize(); // 投到坡面（影响相机位置）
      const desired = tp.clone().addScaledVector(_tankFwd, -12).add(new THREE.Vector3(0, 4.5, 0));
      desired.y = Math.max(desired.y, terrainHeight(desired.x, desired.z) + 2);
      if (this._snapCam) { this.camera.position.copy(desired); this._snapCam = false; }
      else this.camera.position.lerp(desired, 0.2);
      // 视角看向鼠标瞄准点：屏幕正中十字 = 鼠标指向（炮塔随后转过来对齐，炮膛=十字）
      const look = this._tankAimPt ? this._tankAimPt.clone() : tp.clone().addScaledVector(_tankFwd, 60).add(new THREE.Vector3(0, 2, 0));
      this.camera.lookAt(look);
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
    try {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    // Esc 暂停/恢复统一走常驻 _onEscKey（锁定时 Esc 由浏览器退锁、_onPLChange 暂停）。
    if (this.paused) { this.renderer.render(this.scene, this.camera); return; }
    if (this.mode === 'tank' && this.player && this.player.alive) {
      // 十字准星 = 炮膛实际指向（炮口 + 炮管方向投影到屏幕）：随炮塔转，不锁屏幕中央。
      // 相机跟鼠标、炮塔随后 slew 对齐时，准星从偏处滑向中央（与红环重合即对准）。
      const _bore = this.player.getMuzzleWorld(new THREE.Vector3()).addScaledVector(this.player.getBarrelDir(), 80).project(this.camera);
      this.hud.positionCrosshair((_bore.x * 0.5 + 0.5) * window.innerWidth, (-_bore.y * 0.5 + 0.5) * window.innerHeight);
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
      // 世界大战：死后选载具面板
      if (this._wwPick) {
        if (!this._wwPanel) this._showWWPanel();
      } else if (this._wwPanel) {
        this._wwPanel.remove(); this._wwPanel = null;
        if (this.input) this.input.canvas.style.cursor = 'none';
      }
      if (this.player && this.player.alive) {
        if (this.mode === 'tank') this._handleInputTank(dt);
        else this._handleInputPlane(dt);
        // 长按 J 3秒自爆（世界大战：快速换载具）
        if (this.worldwar && this.input.isDown('KeyJ')) {
          this._jHold = (this._jHold || 0) + dt;
          this.hud.setCenterMessage(`💥 自爆倒计时 ${Math.max(0, Math.ceil(3 - this._jHold))}s`);
          if (this._jHold >= 3) {
            this.player.health = 0; this.player.alive = false;
            this._jHold = 0;
            this.hud.addFeed('💥 已自爆', 'info');
          }
        } else if (this._jHold) {
          this._jHold = 0;
          if (this.player && this.player.alive) this.hud.setCenterMessage('');
        }
      }

      // AI 按队伍选目标：敌人锁定蓝队（玩家/队友），队友锁定红队
      const obstacles = this.terrain && this.terrain.obstacles;
      const blueAlive = (this.player && this.player.alive ? [this.player] : []).concat(this.allies.filter((a) => a.alive));
      const redAlive = this.enemies.filter((e) => e.alive);
      const zoneT = (this.objective === 'capture') ? this._zoneTarget : null;
      for (const e of this.enemies) {
        if (!e.ai) continue;
        let t = this._nearest(e.position, blueAlive);
        if (zoneT && (!t || e.position.distanceTo(t.position) > 75)) t = zoneT;   // 没附近敌人就抢点
        e.ai.update(dt, { target: t, entityManager: this.em, obstacles });
      }
      for (const a of this.allies) {
        if (!a.ai) continue;
        let t = this._nearest(a.position, redAlive);
        if (zoneT && (!t || a.position.distanceTo(t.position) > 75)) t = zoneT;
        a.ai.update(dt, { target: t, entityManager: this.em, obstacles });
      }

      this.em.update(dt);
      if (this.mode === 'tank') this._resolveObstacles();

      const targets = this.worldwar ? [...this.em.tanks, ...this.em.planes] : (this.mode === 'tank' ? this.em.tanks : this.em.planes);
      const hits = this.em.checkCollisions(targets);
      for (const h of hits) {
        if (h.owner === this.player) {
          // 击杀回放：玩家炮弹命中敌【坦克】即触发右上角慢动作回放（重演出膛→飞行→穿入→内部爆炸）
          if (h.target && typeof h.target.forwardVector !== 'function') {
            this._startKillReplay(h.target, h.hitPoint, h.killed, h.verdict, h.proj);
          }
          // 命中反馈按判定结果分级：击毁(红)/致命(橙)/击穿(金)/未击穿(灰蓝)/跳弹(白闪)
          if (h.verdict === 'bounce') {
            this.hud.flashHit('bounce'); this.sfx.bounce();
            this.hud.addFeed('⤺ 跳弹', 'death');   // 明确文字提示：装甲弹开
          }
          else if (h.verdict === 'nopen' && !h.killed) {
            this.hud.flashHit('nopen'); this.sfx.nopen();
            this.hud.addFeed('✋ 未击穿', 'death');
          }
          else {
            this.hud.flashHit(h.killed ? 'kill' : (h.crit ? 'crit' : 'hit'));
            if (h.killed) this.sfx.kill(); else this.sfx.hit();
          }
        } else if (h.target === this.player && this.player && this.player.alive) {
          // 被击中：低沉闷响 + 屏幕边缘受击方向红弧（与"打中敌人"的清脆音区分，紧张感）
          this.sfx.hitTaken();
          // 方向：入射位置(敌弹命中点≈玩家自身)的来源 = 弹丸 owner 方位，转成相对玩家朝向的角
          const src = h.owner && h.owner.position ? h.owner.position : null;
          if (src) {
            const toSrc = src.clone().sub(this.player.position);
            const myFwd = this.mode === 'plane' ? this.player.forwardVector() : new THREE.Vector3(Math.sin(this.player.heading), 0, Math.cos(this.player.heading));
            const myRight = new THREE.Vector3(myFwd.z, 0, -myFwd.x);
            // 屏幕弧指向：angle=0 正前；atan2(x=右分量, y=前分量)，正=右侧
            this.hud.flashDamageDir(Math.atan2(toSrc.dot(myRight), toSrc.dot(myFwd)));
          }
        }
      }

      this._updateShellcam(dt);   // 击杀回放小窗（克隆车在渲染层1，与真车销毁互不影响）
      const removed = this.em.cullDead(null);
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

      if (this.objective === 'capture' && this.captureZone) {
        let blue = 0, red = 0;
        // 高度门槓：飞机（有 forwardVector）须离地 <15m 才算占点（贴地压制）；掠过头顶不算
        const inZ = (t) => t && t.alive && t.position.distanceTo(this._zoneTarget.position) < CONFIG.tank.captureRadius
          && (typeof t.forwardVector !== 'function' || t.position.y - terrainHeight(t.position.x, t.position.z) < 15);
        if (inZ(this.player)) blue++;
        for (const a of this.allies) if (inZ(a)) blue++;
        for (const e of this.enemies) if (inZ(e)) red++;
        const rate = (100 / 25) * dt;   // 无争议 ~25s 占满
        if (blue > red) this.captureProgress = Math.min(100, this.captureProgress + rate);
        else if (red > blue) this.captureProgress = Math.max(-100, this.captureProgress - rate);
        const lead = this.captureProgress;
        this.captureZone.material.color.setHex(lead > 1 ? 0x4f7a3a : lead < -1 ? 0x7a2a2a : 0x554a2a);
        this.captureZoneRing.material.color.setHex(lead > 1 ? 0x66ff66 : lead < -1 ? 0xff6666 : 0xffdd44);
        this.hud.setCapture(lead);
      }

      this._updateHUD();
      // 炸弹落点标记（CCIP）：用 3D 地面圆环+竖直光柱标记落点（稳定不卡，不用屏幕投影）
      if (this.mode === 'plane' && this.player && this.player.alive && this.player.maxBombs > 0) {
        const _pfwd = this.player.forwardVector();
        const bp = this.player.position.clone().addScaledVector(_pfwd, -2).add(new THREE.Vector3(0, -1, 0));
        const bv = _pfwd.clone().multiplyScalar(this.player.speed * 1.2).add(new THREE.Vector3(0, -5, 0));
        const bg = CONFIG.plane.bomb.gravity;
        let _hitGround = false;
        const _BSTEP = 0.04;   // 弹道预测步长：0.04s × 400 = 16s，覆盖炸弹(12s)/核弹(15s)寿命；原 0.016×1500=24s 每帧多跑 ~3 倍
        for (let i = 0; i < 400; i++) {
          bv.y -= bg * _BSTEP;
          bp.addScaledVector(bv, _BSTEP);
          if (bp.y <= terrainHeight(bp.x, bp.z) + 0.1) { _hitGround = true; break; }
        }
        if (!this._bombRing) {
          this._bombRing = new THREE.Mesh(new THREE.RingGeometry(5, 7, 24), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
          this._bombRing.rotation.x = -Math.PI / 2;
          this.scene.add(this._bombRing);
          this._bombPole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 50, 6), new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.4 }));
          this.scene.add(this._bombPole);
        }
        if (_hitGround && isFinite(bp.x) && isFinite(bp.z)) {
          const gy = terrainHeight(bp.x, bp.z);
          this._bombRing.position.set(bp.x, gy + 0.5, bp.z);
          this._bombRing.visible = true;
          this._bombPole.position.set(bp.x, gy + 25, bp.z);
          this._bombPole.visible = true;
        } else {
          this._bombRing.visible = false;
          this._bombPole.visible = false;
        }
      } else {
        if (this._bombRing) this._bombRing.visible = false;
        if (this._bombPole) this._bombPole.visible = false;
      }
      this._checkEnd();
    }

    } catch (err) { console.error('⚠ _animate:', err); if (!this._aErr) { this._aErr = true; try { this.hud.addFeed('⚠ ' + (err.message || err), 'info'); } catch (e) {} } }
    // CCIP 炸弹落点标记的计算已合并到上方主 try 内（原此处重复了一份 1500 步模拟，每帧白跑一遍，已删）
    this.renderer.render(this.scene, this.camera);
    this._renderShellcam();   // 右上角跟拍小窗（scissor 二次渲染，无小窗时零开销）
  };

  // —— 右上角击杀回放（战雷式）——
  // 命中敌坦克瞬间才显示。全部回放对象(重演弹丸/克隆车/内部模块/内部爆炸)放【渲染层1】，
  // 回放相机只看层1+层0(场景)，主相机不开层1 → 玩家视角永远看不到任何"幽灵"。
  // 弹道用弹丸出生快照(launchPos/launchVel)按同一物理公式(v=v0+g·t)慢放，完美复现真实轨迹含下坠。
  _startKillReplay(tank, hitPoint, killed, verdict, proj) {
    if (this._shellcam) this._endShellcam();   // 连杀：新击杀替换当前回放，总播最新一发
    const sc = {
      t: 0, cam: new THREE.PerspectiveCamera(48, 1.6, 0.5, 3000),
      killed, verdict,
      hit: hitPoint ? hitPoint.clone() : tank.position.clone(),
      p0: proj && proj.launchPos ? proj.launchPos.clone() : null,
      v0: proj && proj.launchVel ? proj.launchVel.clone() : null,
      g: proj && proj.gravity ? proj.gravity : CONFIG.tank.shellGravity,
      replayFly: 1.6, replayIn: 0.9, replayBoom: 1.8,
      group: new THREE.Group(),
      upY: new THREE.Vector3(0, 1, 0),
    };
    if (!sc.p0 || !sc.v0) return;
    // 真实飞行时长：8ms 细步长扫描整条抛物线，取离弹着点最近的时刻（数值稳定）
    {
      const h = 0.008;
      const v = sc.v0.clone(); const p = sc.p0.clone();
      let bestT = 0.8, bestD = Infinity;
      for (let t = 0; t <= 4; t += h) {
        const d = p.distanceToSquared(sc.hit);
        if (d < bestD) { bestD = d; bestT = t; }
        v.y -= sc.g * h; p.addScaledVector(v, h);
      }
      sc.realT = Math.max(0.3, bestT);
    }
    // —— 克隆受害车：战雷 X 光观感=半透明车壳+可见内部 ——
    const clone = tank.group.clone(true);
    clone.traverse((c) => {
      if (c.material) { c.material = c.material.clone(); c.material.transparent = true; c.material.opacity = 0.26; c.material.depthWrite = false; }
      c.castShadow = false; c.receiveShadow = false;
    });
    sc.group.add(clone);
    sc.clone = clone;
    // —— 内部模块：半透明暗色块 + 亮色描边（工程图感，不再纯色积木）——
    const modGroup = new THREE.Group();
    modGroup.position.copy(tank.position);
    modGroup.rotation.y = tank.heading;
    modGroup.scale.setScalar((tankTypeById(tank.type) || {}).scale || 1);
    sc.group.add(modGroup);
    const mk = (x, y, z, sx, sy, sz, color) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false }));
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1 })));
      m.position.set(x, y, z); modGroup.add(m); return m;
    };
    mk(0, 1.0, -1.8, 1.6, 1.0, 1.6, 0x7dffb0);     // 乘员舱（绿）
    mk(0, 1.2, 0.9, 1.6, 1.0, 1.2, 0xffe066);      // 弹药架（黄）
    mk(0, 1.1, 2.6, 1.8, 1.0, 1.4, 0xffa96b);      // 发动机（橙）
    mk(-1.0, 0.9, 0.2, 0.5, 0.7, 1.0, 0xff7d7d);   // 油箱（红）
    modGroup.visible = false;
    // —— 重演弹丸：胶囊弹体（沿速度方向），不再发光金球 ——
    sc.bullet = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 1.0, 4, 8), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }));
    sc.group.add(sc.bullet);
    // —— 出膛枪口闪光 ——
    sc.muzzleFlash = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffdd88, transparent: true, opacity: 0.9 }));
    sc.muzzleFlash.position.copy(sc.p0);
    sc.group.add(sc.muzzleFlash);
    // —— 层1（主相机不可见）——
    sc.group.traverse((c) => c.layers && c.layers.set(1));
    this.scene.add(sc.group);
    sc.cam.layers.enable(1);
    // 相机平滑状态：位置+视线各自指数平滑，阶段切换零跳变
    sc._look = sc.p0.clone();
    sc.cam.position.copy(sc.p0).add(new THREE.Vector3(0, 3, -6));
    this._shellcam = sc;
  }
  _updateShellcam(dt) {
    const sc = this._shellcam;
    if (!sc) return;
    sc.t += dt;
    const speedup = sc.realT / sc.replayFly;
    if (!sc.dirEnd) {
      const vEnd = sc.v0.clone(); vEnd.y -= sc.g * sc.realT;
      sc.dirEnd = vEnd.normalize();
      sc.vpos = sc.hit.clone().addScaledVector(sc.dirEnd, -2.5);
      sc.a0 = Math.atan2(sc.hit.x - sc.vpos.x, sc.hit.z - sc.vpos.z);
    }
    // 每阶段只产出"期望位置 dPos + 期望视线 dLook"，统一指数平滑（帧率无关）→ 相机永不跳变
    const dPos = _kcTmp, dLook = _scLook;
    let phase = 0;
    if (sc.t < sc.replayFly) phase = 1;
    else if (sc.t < sc.replayFly + sc.replayIn) phase = 2;
    else if (sc.t < sc.replayFly + sc.replayIn + sc.replayBoom) phase = 3;
    else { this._endShellcam(); return; }

    if (phase === 1) {
      if (sc.muzzleFlash) {
        sc.muzzleFlash.material.opacity = Math.max(0, 0.9 * (1 - sc.t / 0.25));
        sc.muzzleFlash.scale.setScalar(1 + sc.t * 3);
        if (sc.t > 0.25) sc.muzzleFlash.visible = false;
      }
      const tt = sc.t * speedup;
      sc.bullet.position.copy(sc.p0)
        .addScaledVector(sc.v0, tt)
        .add(new THREE.Vector3(0, -0.5 * sc.g * tt * tt, 0));
      const vNow = sc.v0.clone(); vNow.y -= sc.g * tt;
      const dir = vNow.normalize();
      sc.bullet.quaternion.setFromUnitVectors(sc.upY, dir);   // 弹体沿速度方向
      const side = _scSide.set(-dir.z, 0, dir.x).normalize();
      dPos.copy(sc.bullet.position).addScaledVector(dir, -8).addScaledVector(side, 5); dPos.y += 2.2;
      // 视线=弹丸与目标(弹着点)的中点：弹和敌坦克始终同框，不会飞出小窗视野
      dLook.copy(sc.bullet.position).add(sc.hit).multiplyScalar(0.5);
    } else if (phase === 2) {
      const dir = sc.dirEnd;
      const tIn = sc.t - sc.replayFly;
      const mg = sc.group.children[1];
      const isPen = sc.verdict !== 'bounce' && sc.verdict !== 'nopen';
      if (mg) mg.visible = isPen;
      // 特写机位（跳弹/未击穿略远一点）
      const dist = isPen ? 9 : 10;
      dPos.set(sc.vpos.x + Math.sin(sc.a0 + 1.0) * dist, sc.vpos.y + 3.5, sc.vpos.z + Math.cos(sc.a0 + 1.0) * dist);
      if (isPen) {
        const IN_STALL = 0.12, IN_DIST = 3.5;
        let p;
        if (tIn < IN_STALL) {
          p = 0;
          sc.bullet.position.copy(sc.hit).addScaledVector(dir, 0.3);
          if (!sc._stallSfx) { sc._stallSfx = true; if (this.sfx) this.sfx.bounce(); }
        } else {
          p = Math.min(1, (tIn - IN_STALL) / (sc.replayIn - IN_STALL));
          const ease = 1 - Math.pow(1 - p, 3);
          sc.bullet.position.copy(sc.hit).addScaledVector(dir, 0.3 + ease * IN_DIST);
        }
        sc.bullet.quaternion.setFromUnitVectors(sc.upY, dir);
        dLook.copy(sc.vpos); dLook.y += 1.2;
        if (p >= 1 && !sc.boom) { this._spawnReplayBoom(sc, sc.bullet.position, sc.killed ? 1.4 : 0.9); sc.bullet.visible = false; }
      } else if (sc.verdict === 'bounce') {
        if (!sc._stallSfx) { sc._stallSfx = true; if (this.sfx) this.sfx.bounce(); }
        const p = Math.min(1, tIn / sc.replayIn);
        if (!sc.ricochetDir) {
          const n = sc.dirEnd.clone().negate();
          const v = sc.dirEnd.clone().multiplyScalar(60);
          sc.ricochetDir = v.sub(n.multiplyScalar(2 * v.dot(n))).normalize();
          sc.ricochetDir.y = Math.abs(sc.ricochetDir.y) * 0.5 + 0.3;
          sc.ricochetDir.normalize();
        }
        sc.bullet.position.copy(sc.hit).addScaledVector(sc.ricochetDir, p * 14);
        sc.bullet.quaternion.setFromUnitVectors(sc.upY, sc.ricochetDir);
        sc.bullet.material.transparent = true;
        sc.bullet.material.opacity = 1 - p * 0.9;
        dLook.copy(sc.bullet.position);   // 视线跟着弹开的弹走
      } else {
        const p = Math.min(1, tIn / Math.min(0.4, sc.replayIn));
        if (!sc._stallSfx) { sc._stallSfx = true; if (this.sfx) this.sfx.nopen(); }
        sc.bullet.position.copy(sc.hit).addScaledVector(dir, 0.3 * p);
        sc.bullet.quaternion.setFromUnitVectors(sc.upY, dir);
        dLook.copy(sc.hit);
        if (p >= 1 && !sc.boom) { this._spawnReplayBoom(sc, sc.hit, 0.7); }   // 车外小爆(榴弹溅射)
      }
    } else {
      const p = (sc.t - sc.replayFly - sc.replayIn) / sc.replayBoom;
      const s = 0.5 + Math.pow(Math.min(1, p * 1.8), 0.5) * (sc.killed ? 6 : (sc.verdict === 'nopen' ? 2 : 3));
      if (sc.boom) {
        sc.boom.scale.setScalar(s);
        if (sc.boom.userData.outer) sc.boom.userData.outer.material.opacity = Math.max(0, 1 - p * 1.15);
        if (sc.boom.userData.inner) sc.boom.userData.inner.material.opacity = Math.max(0, 1 - p * 2.2);
      }
      if (sc.killed && sc.clone) {
        const lift = Math.sin(Math.min(1, p * 1.4) * Math.PI);
        sc.clone.rotation.x = lift * 0.12;
        sc.clone.position.y = lift * 0.5;
      }
      if (sc.killed && !sc.jet && p > 0.15) {
        sc.jet = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.2, 8, 10), new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.95 }));
        sc.jet.position.copy(sc.vpos); sc.jet.position.y += 5;
        sc.jet.layers.set(1);
        sc.group.add(sc.jet);
      }
      if (sc.jet) { sc.jet.scale.y = 1 + p * 1.5; sc.jet.material.opacity = Math.max(0, 0.95 * (1 - p)); }
      const ang = sc.a0 + 1.0 + p * 0.45;
      const d = 9 + p * 8;
      dPos.set(sc.vpos.x + Math.sin(ang) * d, sc.vpos.y + 4 + p * 3, sc.vpos.z + Math.cos(ang) * d);
      dLook.copy(sc.vpos); dLook.y += 1.5;
    }
    // 统一指数平滑（~0.15s 收敛）：位置和视线都连续，阶段切换不跳不晃
    const kp = 1 - Math.exp(-7 * dt);
    sc.cam.position.lerp(dPos, kp);
    sc._look.lerp(dLook, kp);
    sc.cam.lookAt(sc._look);
  }
  // 回放火球：双层（内白亮焰心+外橙焰），比单色球有层次
  _spawnReplayBoom(sc, at, scale) {
    sc.boom = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.SphereGeometry(1.2, 14, 14), new THREE.MeshBasicMaterial({ color: sc.killed ? 0xff7733 : 0xd96b2f, transparent: true, opacity: 0.85 }));
    const inner = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 10), new THREE.MeshBasicMaterial({ color: 0xfff3cf, transparent: true, opacity: 1 }));
    sc.boom.add(outer, inner);
    sc.boom.userData.outer = outer; sc.boom.userData.inner = inner;
    sc.boom.position.copy(at);
    sc.boom.scale.setScalar(scale);
    sc.boom.traverse((c) => c.layers && c.layers.set(1));
    sc.group.add(sc.boom);
    if (this.sfx && !sc.killed) this.sfx.explosion(at);
  }
  _endShellcam() {
    const sc = this._shellcam;
    if (!sc) return;
    sc.group.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    this.scene.remove(sc.group);
    this._shellcam = null;
  }
  // PiP 渲染：主画面后 scissor 出右上角小窗再渲一遍回放相机
  _renderShellcam() {
    const sc = this._shellcam;
    if (!sc) return;
    const w = window.innerWidth, h = window.innerHeight;
    const pw = Math.round(Math.min(380, w * 0.30)), ph = Math.round(pw / 1.6);
    const r = this.renderer;
    r.setScissorTest(true);
    r.setScissor(w - pw - 14, h - ph - 46, pw, ph);
    r.setViewport(w - pw - 14, h - ph - 46, pw, ph);
    sc.cam.aspect = pw / ph; sc.cam.updateProjectionMatrix();
    r.render(this.scene, sc.cam);
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
  }

  // —— 暂停 ——
  _togglePause() {
    if (this.paused) this._resume();
    else this._pause();
  }
  _pause() {
    this.paused = true;
    if (document.pointerLockElement) document.exitPointerLock();   // 释放指针锁，光标能点遮罩按钮
    if (this.input) this.input.canvas.style.cursor = 'auto';
    if (this.sfx) this.sfx.stopEngine();   // 暂停引擎音
    this._showPauseOverlay();
    // 暂停期间按任意键恢复（Esc 走 _onEscKey）。关键：非 Esc 键的 keydown 算用户手势，
    // _resume 里能直接重新锁上指针——浏览器把 Escape 豁免在手势之外（防恶意页锁死用户），
    // 纯 Esc 恢复永远锁不上，只能靠点击兜底；其他键/点击则全自动。
    this._onAnyKey = (e) => {
      if (e.repeat || e.code === 'Escape') return;
      this._resume();
    };
    window.addEventListener('keydown', this._onAnyKey);
  }
  _resume() {
    this.paused = false;
    if (this._onAnyKey) { window.removeEventListener('keydown', this._onAnyKey); this._onAnyKey = null; }
    this._hidePauseOverlay();
    this.clock.getDelta();   // 丢弃暂停期间累积的 dt，避免恢复瞬间一帧大跳
    // 光标立刻视觉消失（不等锁定成功）：Esc 不算用户手势、锁定请求必被浏览器拒，
    // 但未锁定状态本就有"鼠标差值瞄准"模式照常可玩；玩家第一次点击开火（click 是手势，
    // 走 _onDocClickPL）即真正锁定——全程无感，只是锁定前鼠标到屏幕边缘炮塔会停转。
    this.canvas.style.cursor = 'none';
    this._relockPointer();
  }
  // 重新请求指针锁。Esc 退锁后浏览器有 ~1.25s 冷却期，期间请求会被拒 → 1.3s 后自动重试
  // （按键/点击的 transient activation 窗口约 5s，重试时仍在窗口内，无需玩家再点击）。
  // 重试上限 2 次：Esc 恢复路径无手势、锁定必然被拒，无限重试会在玩家后续操作产生手势时
  // 突然锁鼠（点击路径本来就会锁），还每 1.3s 白打一次请求。
  _relockPointer() {
    if (this._disposed || this.state !== 'playing' || this.paused) return;
    if (document.pointerLockElement === this.canvas) return;
    let tries = 0;
    const attempt = () => {
      if (this._disposed || this.state !== 'playing' || this.paused) return;
      if (document.pointerLockElement === this.canvas) return;
      try {
        const p = this.canvas.requestPointerLock();
        if (p && typeof p.catch === 'function') p.catch(retryLater);
      } catch (e) { retryLater(); }
    };
    const retryLater = () => {
      if (tries++ >= 2) return;
      clearTimeout(this._relockTO);
      this._relockTO = setTimeout(attempt, 1300);
    };
    attempt();
  }
  _showPauseOverlay() {
    if (this._pauseEl) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:200;font-family:sans-serif';
    el.innerHTML = `<div style="background:rgba(20,28,20,.95);border:2px solid rgba(100,180,100,.4);border-radius:14px;padding:28px 40px;text-align:center;color:#eee;min-width:240px">
      <div style="font-size:26px;margin-bottom:6px">⏸ 已暂停</div>
      <div style="font-size:13px;color:#aab;margin-bottom:20px">按 <b>任意键</b>（W/空格…）或点击任意处恢复</div>
      <button id="pause-resume" style="display:block;width:100%;margin:6px 0;padding:10px;font-size:15px;background:rgba(80,140,80,.9);color:#fff;border:none;border-radius:8px;cursor:pointer">继续</button>
      <button id="pause-menu" style="display:block;width:100%;margin:6px 0;padding:10px;font-size:15px;background:rgba(120,60,60,.9);color:#fff;border:none;border-radius:8px;cursor:pointer">返回主菜单</button>
    </div>`;
    document.body.appendChild(el);
    this._pauseEl = el;
    el.addEventListener('click', (e) => { if (e.target === el) this._resume(); });   // 点遮罩背景任意处也恢复（click 手势可重锁）
    el.querySelector('#pause-resume').addEventListener('click', () => this._resume());   // _resume 内自动重新锁定
    el.querySelector('#pause-menu').addEventListener('click', () => {
      this._hidePauseOverlay(); this.paused = false;
      if (this.onExit) this.onExit();
    });
  }
  _hidePauseOverlay() {
    if (this._pauseEl) { this._pauseEl.remove(); this._pauseEl = null; }
  }

  _handleDeaths(removed) {
    const playerRef = this.player;   // 缓存本帧玩家引用：同批死亡里玩家先死时 this.player 已置 null，后续敌人击杀归属会误判为"友方击毁"
    for (const r of removed) {
      const isPlane = typeof r.forwardVector === 'function';
      const label = isPlane ? '飞机' : '坦克';   // 按实体类型定标签（世界大战里坦克/飞机混编）
      const scale = isPlane ? 2.5 : 3.5;
      this.em.addEffect(new Explosion(r.position.clone().add(new THREE.Vector3(0, 1.5, 0)), scale, 0xffa040));
      const tag = r.lastCrit ? ` · ${r.lastCrit}` : '';
      if (r === this.player) {
        this.hud.addFeed(`你的${label}被击毁${tag}`, 'death');
        this.hud.hideCrosshair();            // 阵亡：藏掉准星，别让它留在屏上误导
        this._deathCamTarget = null;          // 观战目标重新选
        this.player = null;
        this.playerLives -= 1;
        if (this.playerLives > 0) this.respawnTimer = this.worldwar ? CONFIG.rules.respawnDelay * 1.8 : CONFIG.rules.respawnDelay;
      } else if (r.team === 'red') {
        const wasBoss = r.isBoss;
        this.kills += 1;
        if (this.endless && this.kills % 10 === 0) this._spawnBoss(); // 每 10 击杀出一只精英
        const atk = r._lastAttacker;
        const who = atk === playerRef ? '你击毁 ' : (atk && atk.team === 'blue' ? '友方击毁 ' : '击毁 ');
        // 玩家击杀即时奖励提示：金额=外部结算公式的逐杀值（无尽 150/50，普通 120/40），只提前显示、结算不变
        const bonus = atk === playerRef ? ` +${this.endless ? 150 : 120}💰+${this.endless ? 50 : 40}🔬` : '';
        this.hud.addFeed(`${who}敌方${label}${tag}${bonus}`, 'kill');
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
        if (this.worldwar) {
          this._wwPick = true;
          // 死亡时立即释放指针锁，让鼠标出现可以直接点载具面板
          if (document.pointerLockElement) document.exitPointerLock();
          if (this.input) this.input.canvas.style.cursor = 'auto';
          this.hud.setCenterMessage('点击选择新载具');
        } else {
          this._makePlayer();
          this.hud.setCenterMessage('');
          this.hud.addFeed(`已重生（剩余命数 ${this.playerLives}）`, 'info');
        }
      }
    } else if (this._wwPick) {
      this.hud.setCenterMessage('点击选择新载具');
    } else if (this.player && this.player.alive) {
      this.hud.setCenterMessage('');
    }
  }

  // 世界大战载具选择面板：列出已拥有的坦克+飞机，点击选一辆重生
  _showWWPanel() {
    if (this._wwPanel) this._wwPanel.remove();
    if (this.input) this.input.canvas.style.cursor = 'auto';
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.9);border:2px solid rgba(100,180,100,.4);border-radius:12px;padding:20px 24px;z-index:100;max-width:80vw;max-height:80vh;overflow-y:auto;font-family:sans-serif;color:#eee';
    let html = '<div style="text-align:center;font-size:18px;margin-bottom:14px">选择载具（剩余 ' + Math.max(0, this.playerLives) + ' 命）</div>';
    html += '<div style="display:flex;gap:20px">';
    // 坦克
    html += '<div><div style="font-size:14px;color:#8f8;margin-bottom:8px">🛡 坦克</div>';
    for (const id of this.ownedTanks) {
      const t = tankTypeById(id);
      const sel = (this.mode === 'tank' && this.tankType === id) ? 'border:2px solid #6f6' : 'border:1px solid #555';
      html += `<div data-mode="tank" data-id="${id}" style="margin:4px 0;padding:8px 14px;background:rgba(40,60,40,.6);border-radius:6px;cursor:pointer;${sel}">${t.icon} ${t.name}</div>`;
    }
    html += '</div>';
    // 飞机
    html += '<div><div style="font-size:14px;color:#8af;margin-bottom:8px">✈ 飞机</div>';
    for (const id of this.ownedPlanes) {
      const p = planeTypeById(id);
      const sel = (this.mode === 'plane' && this.planeType === id) ? 'border:2px solid #6f6' : 'border:1px solid #555';
      html += `<div data-mode="plane" data-id="${id}" style="margin:4px 0;padding:8px 14px;background:rgba(40,50,70,.6);border-radius:6px;cursor:pointer;${sel}">${p.icon} ${p.name}</div>`;
    }
    html += '</div></div>';
    panel.innerHTML = html;
    document.body.appendChild(panel);
    this._wwPanel = panel;
    panel.querySelectorAll('[data-mode]').forEach((el) => {
      const hoverBg = el.dataset.mode === 'tank' ? 'rgba(60,100,60,.85)' : 'rgba(60,80,110,.85)';
      const idleBg = el.dataset.mode === 'tank' ? 'rgba(40,60,40,.6)' : 'rgba(40,50,70,.6)';
      el.onmouseenter = () => { el.style.background = hoverBg; };
      el.onmouseleave = () => { el.style.background = idleBg; };
      el.ontouchstart = () => { el.style.background = hoverBg; };   // 触屏无 hover 态：按下即时高亮给反馈
      el.onclick = () => {
        this.mode = el.dataset.mode;
        if (this.mode === 'tank') this.tankType = el.dataset.id;
        else this.planeType = el.dataset.id;
        this._wwPick = false;
        panel.remove(); this._wwPanel = null;
        if (this.input) this.input.canvas.style.cursor = 'none';
        this._makePlayer();
        this.hud.setCenterMessage('');
        const name = el.textContent.replace(/^\S+\s/, '');
        this.hud.addFeed(`已重生：${name}（剩余 ${this.playerLives}）`, 'info');
      };
    });
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
      this.hud.setBombs(this.player.bombs ?? 0, this.player.maxBombs ?? 0);
      // 小地图：玩家居中、朝上为前进方向；敌人画红点
      const f = this.mode === 'tank' ? null : this.player.forwardVector();
      const heading = this.mode === 'tank' ? (this._aimYaw ?? this.player.heading) : Math.atan2(f.x, f.z);   // 小地图跟瞄准方向（跟相机一致），不跟车身
      this.hud.drawMinimap({
        playerPos: this.player.position,
        playerHeading: heading,
        enemies: this.enemies.filter((e) => e.alive).map((e) => e.position),
        allies: this.allies.filter((a) => a.alive).map((a) => a.position),
        range: this.mode === 'tank' ? 300 : 340,
      });
      // 模块损伤提示（坦克）/ 提前量瞄准具（飞机）
      this.hud.setModules(this.mode === 'tank' ? this.player.modules : null);
      // 按载具实体类型判（worldwar 下 this.mode 可能与玩家实际载具不同步；坦克实体永远不显示 lead 提前量环）
      if (!this.worldwar && typeof this.player.forwardVector === 'function') this._updateLeadReticle(); else this.hud.positionLead(0, 0, false);   // worldwar 混战不显示 lead 提前量环（玩家反馈不需要）；纯飞机模式才显示
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
      const Vt = (typeof e.forwardVector === 'function') ? e.forwardVector().multiplyScalar(e.speed) : new THREE.Vector3();   // Tank 无 forwardVector（worldwar 陆空混编），用零向量=不提前量
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
    if (this.objective === 'capture') {
      // 占领模式：进度先满 100% 的一方获胜
      if (this.captureProgress >= 100) { this._end(true); return; }
      if (this.captureProgress <= -100) { this._end(false); return; }
    } else if (!this.endless && this.kills >= this.enemyTickets) { this._end(true); return; }
    if (this.playerLives <= 0 && this.respawnTimer <= 0 && !(this.player && this.player.alive)) {
      this._end(false);
    }
  }

  _end(win) {
    this.state = 'over';
    this._endShellcam();   // 结束比赛：关掉回放小窗，别冻在结算界面旁
    // 一局结束：释放指针锁让光标出现（点"再来一局/返回菜单"），并藏掉准星。
    // 程序化退出无 ESC 冷却，也顺带消除下一局开局"要点两次才锁上"的问题。
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.hideCrosshair();
    this.hud.positionLead(0, 0, false);   // 结束时清提前量瞄准环，防卡屏残留
    if (this._bombX) this._bombX.style.display = 'none';
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
    // 重置上一局残留的 per-match 状态（避免瞄准角/错误标志/观战目标串到新局）
    this._aimYaw = null;
    this._aimHeight = null;
    this._jHold = false;
    this._aErr = false;
    this._deathCamTarget = null;
    this._wwPick = false;
    this.paused = false;
    this._hidePauseOverlay();
    this._endShellcam();   // 重开：清掉跟拍小窗/X 光组/还原材质
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
    clearTimeout(this._relockTO);
    this._endShellcam();   // 清理跟拍小窗/X 光组/还原材质
    window.removeEventListener('resize', this._onResize);
    if (this._onDocClickPL) document.removeEventListener('click', this._onDocClickPL);
    if (this._onEscKey) window.removeEventListener('keydown', this._onEscKey);
    if (this._onAnyKey) window.removeEventListener('keydown', this._onAnyKey);
    if (this._onPLChange) document.removeEventListener('pointerlockchange', this._onPLChange);
    if (document.pointerLockElement) document.exitPointerLock();
    if (this._wwPanel) { this._wwPanel.remove(); this._wwPanel = null; }
    if (this._pauseEl) { this._pauseEl.remove(); this._pauseEl = null; }
    if (this._bombX) { this._bombX.remove(); this._bombX = null; }
    this.input.dispose();
    this.hud.dispose();
    this.sfx.stopEngine();
    this._clearCapture();
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
let objective = 'battle';   // 陆战目标：'battle'(歼灭) | 'capture'(占领)
let mapIndex = 0;           // 陆战地图主题索引（MAPS[0]='city' 默认）
let worldwar = false;        // 世界大战模式（坦克+飞机混合作战）
const bestEl = document.getElementById('best');
const endlessBtn = document.getElementById('btn-endless');
const objectiveBtn = document.getElementById('btn-objective');
const mapBtn = document.getElementById('btn-map');
const worldwarBtn = document.getElementById('btn-worldwar');

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
function renderObjectiveBtn() {
  if (!objectiveBtn) return;
  objectiveBtn.textContent = `🎯 占领模式：${objective === 'capture' ? '开启' : '关闭'}`;
  objectiveBtn.classList.toggle('active', objective === 'capture');
  objectiveBtn.style.display = (worldwar || pendingMode === 'tank') ? '' : 'none';   // 世界大战时也显示
}
function renderMapBtn() {
  if (!mapBtn) return;
  mapBtn.textContent = `🗺 地图：${MAPS[mapIndex].name}`;
  mapBtn.style.display = (worldwar || pendingMode === 'tank') ? '' : 'none';   // 世界大战时也显示
}
function renderWorldwarBtn() {
  if (!worldwarBtn) return;
  worldwarBtn.textContent = `🌍 世界大战：${worldwar ? '开启' : '关闭'}`;
  worldwarBtn.classList.toggle('active', worldwar);
  worldwarBtn.style.display = (worldwar || pendingMode === 'tank') ? '' : 'none';   // 世界大战时始终显示
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
  loEls.summary.textContent = `难度：${DIFFICULTY_LABELS[difficulty]}　·　无尽：${endless ? '开' : '关'}${isTank ? `　·　目标：${objective === 'capture' ? '占领' : '歼灭'}　·　🗺 ${MAPS[mapIndex].name}` : ''}${worldwar ? '　·　🌍世界大战' : ''}　·　💰 ${meta.money}`;
  renderEndlessBtn();
  renderObjectiveBtn();
  renderMapBtn();
  renderWorldwarBtn();
  // 世界大战：允许在出战页切换坦克/飞机
  if (!loEls.swapType) {
    const btn = document.createElement('button');
    btn.className = 'lo-btn';
    btn.style.cssText = 'display:none;padding:6px 14px;font-size:13px;';
    btn.textContent = '切换飞机';
    loEls.back.parentNode.insertBefore(btn, loEls.start);
    loEls.swapType = btn;
    btn.addEventListener('click', () => {
      pendingMode = pendingMode === 'tank' ? 'plane' : 'tank';
      renderLoadout();
    });
  }
  if (worldwar) {
    loEls.swapType.style.display = '';
    loEls.swapType.textContent = isTank ? '切换飞机 →' : '← 切换坦克';
  } else {
    loEls.swapType.style.display = 'none';
  }
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
  try { game = new Game({
    canvas, mode, difficulty,
    tankType: meta.selected,
    planeType: meta.selectedPlane,
    endless,
    objective,
    mapId: MAPS[mapIndex].id,
    worldwar,
    ownedTanks: meta.owned,
    ownedPlanes: meta.ownedPlanes,
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
  }); } catch (err) {
    document.body.innerHTML = '<pre style="color:#f66;padding:20px;font:14px monospace;white-space:pre-wrap">❌ 启动失败: ' + err.message + '\n\n' + err.stack + '</pre>';
    console.error(err);
  }
  window.__game = game;
}

function backToMenu() {
  if (game) { game.dispose(); game = null; }
  hudContainer.classList.add('hidden');
  menu.classList.remove('hidden');
  renderMoney(); renderBest(); renderEndlessBtn(); renderObjectiveBtn(); renderWorldwarBtn();
}

document.getElementById('btn-tank').addEventListener('click', () => { worldwar = false; showLoadout('tank'); });
document.getElementById('btn-plane').addEventListener('click', () => { worldwar = false; showLoadout('plane'); });
document.getElementById('btn-worldwar-mode').addEventListener('click', () => { worldwar = true; endless = true; renderEndlessBtn(); showLoadout('tank'); });   // 世界大战默认开启无尽模式（玩家可手动关）

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
if (objectiveBtn) objectiveBtn.addEventListener('click', () => { objective = objective === 'capture' ? 'battle' : 'capture'; renderObjectiveBtn(); renderLoadout(); });
if (mapBtn) mapBtn.addEventListener('click', () => { mapIndex = (mapIndex + 1) % MAPS.length; renderMapBtn(); renderLoadout(); });
if (worldwarBtn) worldwarBtn.addEventListener('click', () => { worldwar = !worldwar; renderWorldwarBtn(); renderLoadout(); });
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


