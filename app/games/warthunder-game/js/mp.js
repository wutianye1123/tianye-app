// js/mp.js —— 联机对战模块（PvP）
// 参考狩猎游戏的接入模式：启动器建房（局域网 ws / 互联网中转）→ 主机点开始 →
// 所有玩家带 ?pvp=1&team=red|blue 进入本页 → 本模块恢复联机状态、显示大厅、同步战斗。
//
// 架构（主机权威伤害，与狩猎游戏一致）：
//   - 每个客户端只模拟自己的载具（坦克/飞机/直升机），12Hz 广播 wt-state；
//   - 远端玩家 = 本地"幽灵"实体（Tank/Plane/Heli 实例，netGhost 标记）：
//     位置/姿态由网络插值驱动，本地弹丸可命中（完整弹道/装甲判定做视觉反馈），
//     但不扣血——伤害数值上报主机；
//   - 主机收到 wt-hit 后在自己的幽灵副本（或本机玩家）上跑 onHit 完整装甲判定，
//     广播 wt-dmg（权威血量）→ 血尽广播 wt-kill（计分）→ 5s 后 wt-respawn；
//   - 胜负：率先打满目标击杀数的队伍获胜（主机判胜并广播 wt-end）。
//
// 消息协议（wt- 前缀，避免与其他游戏的联机消息冲突）：
//   wt-hello    { }                        迟到者页面加载后请求战局信息（主机应答 wt-start）
//   wt-start    { mapId, tk, scores }      主机广播：开局/重开局（所有人按同一地图开局）
//   wt-state    { id, nm, tm, vk, vt, p, q, hd, ty, th, sp, hp, al }  12Hz 玩家状态
//   wt-shoot    { id, k, p, d, sp, g, sh, tid, br }  开火（视觉弹：远端重建纯视觉弹丸）
//   wt-hit      { id, tid, dmg, pen, sh, d, hp }     射手→主机：命中上报（主机权威判定）
//   wt-dmg      { tid, hp, dmg, verdict, crit, fid } 主机→全员：权威伤害
//   wt-kill     { vid, kid, vn, kn, scores, vteam }  主机→全员：击杀与计分
//   wt-died     { id, fid }                受害者→主机：烧尽/坠机等本地死亡（主机补发击杀）
//   wt-respawn  { id }                     主机→全员：重生
//   wt-end      { winner, scores }         主机→全员：终局

import * as THREE from 'three';

const STATE_HZ = 1 / 12;          // 状态同步频率
const MG_SHOOT_MIN_GAP = 0.09;    // 机枪类视觉弹广播限流（曳光本就断续）
const RESPAWN_DELAY = 5;          // 重生倒计时（秒）
const TEAM_SPAWN = { blue: -1, red: 1 };   // 绝对队伍出生边（blue=南 red=北，与单机一致）

export class MPNet {
  constructor(F) {
    // F = 依赖注入表（main.js 传入，避免循环 import）：
    // { Tank, Plane, Heli, tankTypeById, planeTypeById, MAPS, CONFIG, terrainHeight, randRange }
    this.F = F;
    this.active = true;
    this.isHost = false;
    this.myId = null;
    this.myName = '玩家';
    this.myTeam = 'blue';         // 绝对队伍（URL team 参数；决定出生边与计分组）
    this.mapId = null;
    this.targetKills = 15;
    this.game = null;             // attachGame 后的 Game 实例
    this.ghosts = new Map();      // peerId -> { ent, name, team, vk, vt, tPos, tQuat, tHd, tTy, lastSeen }
    this.scores = new Map();      // playerId -> { n, k, d, t }
    this.inBattle = false;
    this._stateT = 0;
    this.myVk = 'tank';           // 我的出战载具类别（大厅可切：tank | plane）
    this._lobbyEl = null;
    this._scoreEl = null;
    this._lastMgShoot = 0;
    this._ended = false;
    this._listenersBound = false;
  }

  // —— 创建：从启动器跳转进来时恢复联机状态。失败（无 electronAPI / 未联机）返回 null ——
  static async create(F) {
    if (!window.electronAPI || !window.electronAPI.mpGetState) return null;
    const q = new URLSearchParams(location.search);
    if (q.get('pvp') !== '1') return null;
    let st = null;
    try { st = await window.electronAPI.mpGetState(); } catch (e) { return null; }
    if (!st || !st.active) return null;
    const mp = new MPNet(F);
    mp.isHost = !!st.isHost;
    mp.myId = st.myId != null ? st.myId : (mp.isHost ? 0 : null);
    mp.myName = st.myName || '玩家';
    mp.myTeam = null;   // 队伍由系统分配（开局时主机按加入顺序交替分；忽略 URL team 参数）
    mp.scores.set(mp.myId, { n: mp.myName, k: 0, d: 0, t: null });
    for (const p of (st.peers || [])) {
      if (p.id === mp.myId) continue;
      if (!mp.scores.has(p.id)) mp.scores.set(p.id, { n: p.name || ('玩家' + p.id), k: 0, d: 0, t: null });
    }
    mp._bind();
    return mp;
  }

  // —— 网络收发 ——
  send(data) {
    if (window.electronAPI && window.electronAPI.mpSend) {
      try { window.electronAPI.mpSend(data); } catch (e) {}
    }
  }

  _bind() {
    if (this._listenersBound || !window.electronAPI || !window.electronAPI.onMpMessage) return;
    this._listenersBound = true;
    window.electronAPI.onMpMessage((data) => this._onMsg(data));
    // 迟到者：请求战局信息（主机应答 wt-start）
    this.send({ type: 'wt-hello' });
  }

  _onMsg(m) {
    switch (m.type) {
      case 'player-join':
        if (m.id !== this.myId && !this.scores.has(m.id)) {
          this.scores.set(m.id, { n: m.name || ('玩家' + m.id), k: 0, d: 0, t: null });   // 队伍等系统分配
          if (this.inBattle) this._feed(`👤 ${m.name || '玩家'} 加入战斗`);
        }
        this._refreshLobby();
        break;
      case 'player-leave': {
        if (m.id === 0 && !this.isHost) {   // 主机跑了（房没了）：联机不可继续
          this._feed('⚠ 主机已离开，联机结束');
          this.active = false;
          this.inBattle = false;
          if (this.game) { try { this.game._end(false); } catch (e) {} }
          this.showLobby();
          return;
        }
        const s = this.scores.get(m.id);
        if (this.inBattle && s) this._feed(`👋 ${s.n} 离开了战斗`);
        this.scores.delete(m.id);
        this.removeGhost(m.id);
        this._refreshLobby();
        break;
      }
      case 'player-list':
        for (const p of (m.players || [])) {
          if (p.id === this.myId || this.scores.has(p.id)) continue;
          this.scores.set(p.id, { n: p.name || ('玩家' + p.id), k: 0, d: 0, t: p.id === 0 ? 'blue' : 'red' });
        }
        this._refreshLobby();
        break;
      case 'your-id':
        if (this.myId == null) this.myId = m.id;
        break;
      case 'disconnected':
        this._feed('⚠ 联机已断开');
        this.active = false;
        this.inBattle = false;
        if (this.game) { try { this.game._end(false); } catch (e) {} }
        this.showLobby();
        break;
      case 'wt-start': this._onStart(m); break;
      case 'wt-hello':
        // 迟到者请求战局：主机在对战中就回发 wt-start（含地图/计分/队伍），对方直接进场；
        // 迟到者由系统分到人数少的队（保持阵营平衡）
        if (this.isHost && this.inBattle && this.mapId) {
          const teams = Object.assign({}, this._pendingTeams || {});
          if (m.id != null && m.id !== this.myId && !teams[m.id]) {
            let b = 0, r = 0;
            for (const t of Object.values(teams)) (t === 'blue' ? b++ : r++);
            teams[m.id] = (b <= r ? 'blue' : 'red');
            this._pendingTeams = teams;   // 记入分配表：后续迟到者继续在此基础上平衡
          }
          this.send({ type: 'wt-start', mapId: this.mapId, tk: this.targetKills, scores: this._scoresObj(), teams });
        }
        break;
      case 'wt-state': this._onState(m); break;
      case 'wt-shoot': this._onShoot(m); break;
      case 'wt-hit': if (this.isHost) this._hostHit(m); break;
      case 'wt-dmg': this._onDmg(m); break;
      case 'wt-kill': this._onKill(m); break;
      case 'wt-died': if (this.isHost) this._hostDied(m); break;
      case 'wt-respawn': this._onRespawn(m); break;
      case 'wt-end': this._onEnd(m); break;
    }
  }

  // —— 大厅：顶部房间状态栏（悬浮，不挡画面）＋ 完整出战配置面板（main.js 注入 openVehPicker）——
  showLobby() {
    this.hideLobby();
    const el = document.createElement('div');
    el.id = 'mp-lobby';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:8000;display:flex;align-items:center;gap:10px;padding:8px 14px;background:linear-gradient(180deg,rgba(10,14,10,.94),rgba(10,14,10,.78));border-bottom:1px solid rgba(120,160,120,.25);font-family:sans-serif;color:#eee;font-size:14px';
    document.body.appendChild(el);
    this._lobbyEl = el;
    this._refreshLobby();
    // 打开出战配置（联机的载具选择界面）
    if (this._openVehPicker) this._openVehPicker(this.myVk);
  }

  hideLobby() {
    if (this._lobbyEl) { this._lobbyEl.remove(); this._lobbyEl = null; }
  }

  _refreshLobby() {
    const el = this._lobbyEl;
    if (!el) return;
    const players = [...this.scores.entries()]
      .map(([id, s]) => ({ id, ...s }))
      .sort((a, b) => (a.t === 'blue' ? -1 : 1) - (b.t === 'blue' ? -1 : 1) || a.id - b.id);
    const chips = players.map((p) => {
      const me = p.id === this.myId ? '（你）' : '';
      const host = p.id === 0 ? ' 🖥' : '';
      const col = p.t === 'blue' ? '#8ecbff' : (p.t === 'red' ? '#ff9d8a' : '#b9c4b9');
      const dot = p.t === 'blue' ? '🔵' : (p.t === 'red' ? '🔴' : '⚪');
      return `<span style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:2px 10px;white-space:nowrap;color:${col}">${dot}${p.n}${me}${host} <b style="color:#ffe08a">${p.k}</b></span>`;
    }).join('');
    let ctl = '';
    if (this.isHost && !this.inBattle) {
      const maps = this.F.MAPS.map((mm) => `<option value="${mm.id}" ${mm.id === this.mapId ? 'selected' : ''}>${mm.name}</option>`).join('');
      ctl = `<select id="mp-map" style="background:#1c2418;color:#eee;border:1px solid #3a4a34;border-radius:6px;padding:4px 8px;font-size:13px">${maps}</select>
        <button id="mp-start" style="background:linear-gradient(135deg,#3f7a3f,#2c5a2c);color:#fff;border:none;border-radius:8px;padding:6px 20px;font-size:14px;font-weight:700;cursor:pointer">🚀 开始对战</button>`;
    } else if (!this.inBattle) {
      ctl = `<span style="color:#c9b96a">⏳ 等待主机开始对战…</span>`;
    }
    el.innerHTML =
      `<span style="font-weight:800;color:#cfe8c0;white-space:nowrap">🌐 联机对战</span>` +
      `<span id="mp-myteam" style="white-space:nowrap;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:2px 10px;color:${this.myTeam === 'blue' ? '#8ecbff' : this.myTeam === 'red' ? '#ff9d8a' : '#b9c4b9'}">${this.myTeam === 'blue' ? '🔵 蓝军·南' : this.myTeam === 'red' ? '🔴 红军·北' : '⚪ 队伍系统分配'}</span>` +
      `<div style="flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0;overflow:hidden">${chips}</div>` +
      ctl +
      `<button id="mp-veh" style="background:#233823;border:1px solid #3f5f3f;color:#bfe8a0;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap">🛠 更换载具</button>` +
      `<button id="mp-leave" style="background:none;border:1px solid #5a3a3a;color:#c88;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer">退出联机</button>`;
    const vehBtn = el.querySelector('#mp-veh');
    if (vehBtn) vehBtn.addEventListener('click', () => { if (this._openVehPicker) this._openVehPicker(this.myVk); });
    const lvBtn = el.querySelector('#mp-leave');
    if (lvBtn) lvBtn.addEventListener('click', async () => {
      try { if (window.electronAPI && window.electronAPI.mpStop) await window.electronAPI.mpStop(); } catch (e) {}
      this.dispose();
      location.href = location.pathname;   // 去掉 ?pvp=1 重新加载 → 单机菜单
    });
    if (this.isHost) {
      const sel = el.querySelector('#mp-map');
      if (sel) { if (!this.mapId) this.mapId = sel.value; sel.value = this.mapId; sel.addEventListener('change', () => { this.mapId = sel.value; }); }
      const btn = el.querySelector('#mp-start');
      if (btn) btn.addEventListener('click', () => this.hostStart());
    }
  }

  hostStart() {
    if (!this.mapId) this.mapId = this.F.MAPS[0].id;
    this._ended = false;
    // —— 队伍分配（主机权威·系统分配）：不问玩家偏好，按加入顺序交替分红蓝（0,2,4…蓝 / 1,3,5…红）——
    const ids = [...this.scores.keys()].sort((a, b) => a - b);
    const teams = {};
    ids.forEach((id, i) => { teams[id] = (i % 2 === 0 ? 'blue' : 'red'); });
    for (const [id, t] of Object.entries(teams)) {
      const s = this.scores.get(Number(id));
      if (s) { s.t = t; this.scores.set(Number(id), s); }
    }
    this._pendingTeams = teams;
    const scores = this._scoresObj();
    this.send({ type: 'wt-start', mapId: this.mapId, tk: this.targetKills, scores, teams });
    this._onStart({ mapId: this.mapId, tk: this.targetKills, scores, teams });
  }

  _onStart(m) {
    if (this.inBattle) return;   // 战斗中收到重复 wt-start 忽略
    this.mapId = m.mapId || this.mapId;
    this.targetKills = m.tk || this.targetKills;
    if (m.scores) for (const [id, s] of Object.entries(m.scores)) this.scores.set(Number(id), s);
    // 队伍分配（主机权威·系统分配）：更新自己与计分板的队伍
    if (m.teams) {
      for (const [id, t] of Object.entries(m.teams)) {
        const pid = Number(id);
        const s = this.scores.get(pid);
        if (s) { s.t = t; this.scores.set(pid, s); }
        if (pid === this.myId && t !== this.myTeam) {
          this.myTeam = t;
          if (this._feed) this._feed(`🔀 系统分配：你加入 ${t === 'blue' ? '🔵 蓝军（南侧出生）' : '🔴 红军（北侧出生）'}`);
        }
      }
    }
    this._ended = false;
    this.hideLobby();
    this.inBattle = true;
    if (this._onStartBattle) this._onStartBattle(this.mapId);   // main.js 回调：切地图并 startGame
  }

  // —— 战斗挂接（Game 侧调用） ——
  attachGame(game) {
    this.game = game;
    // 主机重开局时把上一局幽灵清干净
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    this._ensureScoreBanner();
  }

  detachGame() {
    this.game = null;
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
    if (this._scoreEl) { this._scoreEl.remove(); this._scoreEl = null; }
    this.inBattle = false;
  }

  // —— 幽灵实体 ——
  _ensureGhost(id, st) {
    let g = this.ghosts.get(id);
    if (g && (g.vk !== st.vk || g.vt !== st.vt)) {   // 换载具了：重建
      this.removeGhost(id);
      g = null;
    }
    if (!g) {
      const game = this.game;
      if (!game) return null;
      const relTeam = st.tm === this.myTeam ? 'blue' : 'red';   // 相对队伍：我的队=蓝视角
      const side = relTeam === 'red' ? 'enemy' : 'ally';
      let ent;
      if (st.vk === 'tank') {
        ent = new this.F.Tank({ side, team: relTeam, color: relTeam === 'red' ? 0x9a7b3e : 0x3a6b8a, type: st.vt });
      } else {
        const def = this.F.planeTypeById(st.vt);
        ent = (def && def.heli)
          ? new this.F.Heli({ side, team: relTeam, color: relTeam === 'red' ? 0x8a5a42 : 0x3a5a3a, type: st.vt })
          : new this.F.Plane({ side, team: relTeam, color: relTeam === 'red' ? 0xb5462e : 0x3a6b9e, type: st.vt });
        if (ent) {
          ent.worldSize = this.F.CONFIG.tank.worldSize;   // 混合战场：飞机也用坦克地图尺寸
          ent.tailGunOn = false;   // 幽灵尾炮塔关闭（尾炮伤害未经主机权威，v1 不开）
        }
      }
      if (!ent) return null;
      ent.netGhost = true;
      ent.netId = id;
      ent.displayName = st.nm || ('玩家' + id);
      ent.killCount = (this.scores.get(id) || {}).k || 0;
      ent.group.position.set(st.p[0], st.p[1], st.p[2]);
      // 幽灵血量主机管：本地 onHit 只做视觉判定（takeDamage 空转），伤害上报主机；
      // 主机判定时临时换回真 takeDamage（_origTakeDamage），判完再空转。
      ent._origTakeDamage = ent.takeDamage.bind(ent);
      ent.takeDamage = () => {};
      const mp = this;
      const origOnHit = ent.onHit.bind(ent);
      ent.onHit = (damage, proj, hitPoint) => {
        const verdict = origOnHit(damage, proj, hitPoint);
        // 只有"我的弹丸"造成的命中才上报（远端视觉弹/他人弹丸不打伤害）
        if (proj && proj.owner && mp.game && proj.owner === mp.game.player && !proj.netVisual) {
          mp.reportHit(ent, damage, proj, hitPoint);
        }
        return verdict;
      };
      if (st.vk === 'tank') {
        game.em.addTank(ent);
      } else {
        game.em.addPlane(ent);
      }
      (relTeam === 'red' ? game.enemies : game.allies).push(ent);
      g = { ent, name: ent.displayName, team: st.tm, vk: st.vk, vt: st.vt, tPos: new THREE.Vector3(st.p[0], st.p[1], st.p[2]), tQuat: null, tHd: st.hd || 0, tTy: st.ty || 0, lastSeen: performance.now() };
      this.ghosts.set(id, g);
    }
    return g;
  }

  removeGhost(id) {
    const g = this.ghosts.get(id);
    if (!g) return;
    this.ghosts.delete(id);
    const game = this.game;
    const ent = g.ent;
    if (game) {
      if (game.enemies) game.enemies = game.enemies.filter((e) => e !== ent);
      if (game.allies) game.allies = game.allies.filter((a) => a !== ent);
      if (game.em) {
        game.em.tanks = game.em.tanks.filter((t) => t !== ent);
        game.em.planes = game.em.planes.filter((p) => p !== ent);
        if (ent.dustTrail) { try { ent.dustTrail.dispose(); } catch (e) {} }
      }
      game.scene.remove(ent.group);
    }
    try {
      ent.group.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) { Array.isArray(c.material) ? c.material.forEach((mm) => mm.dispose()) : c.material.dispose(); }
      });
    } catch (e) {}
  }

  // —— 状态同步 ——
  _onState(m) {
    if (m.id === this.myId || !this.inBattle || !this.game) return;
    // 队伍实时同步（wt-state 带各自真实队伍，先于幽灵创建更新计分板）
    {
      const s = this.scores.get(m.id);
      if (s && m.tm && s.t !== m.tm) { s.t = m.tm; this.scores.set(m.id, s); this._refreshLobby(); }
    }
    const g = this._ensureGhost(m.id, m);
    if (!g) return;
    const e = g.ent;
    // 远端已重生但本地幽灵还是死实体（wt-respawn 丢包/迟到兜底）：
    // 死实体已被 cullDead 移出场景列表，原地复活会变"隐形僵尸"——必须销毁重建
    if (m.al === 1 && !e.alive) {
      this.removeGhost(m.id);
      const g2 = this._ensureGhost(m.id, m);
      if (!g2) return;
      this._applyState(g2, m);
      return;
    }
    this._applyState(g, m);
  }

  _applyState(g, m) {
    g.tPos.set(m.p[0], m.p[1], m.p[2]);
    if (m.q && (!g.tQuat)) g.tQuat = new THREE.Quaternion(m.q[0], m.q[1], m.q[2], m.q[3]);
    else if (m.q) g.tQuat.set(m.q[0], m.q[1], m.q[2], m.q[3]);
    g.tHd = m.hd || 0;
    g.tTy = m.ty || 0;
    g.lastSeen = performance.now();
    const e = g.ent;
    e.health = Math.max(0, Math.min(e.maxHealth, m.hp));   // 血量跟随主机（wt-dmg 权威，这里兜底）
    if (m.al === 0 && e.alive) {
      // 远端已死但本地还活着（丢包兜底）：本地击杀视觉
      this._ghostDie(e, e.position.clone());
    }
    if (m.bu) e.burning = true;   // 起火可视
    else if (e.burning && e.alive && m.hp > (e.maxHealth || 1) * 0.999) e.burning = false;   // 满血时灭火（重生）
    if (e.lastThrottle !== undefined) e.lastThrottle = m.th || 0;
    if (g.vk !== 'tank' && m.sp !== undefined) e.speed = m.sp;
  }

  tick(dt) {
    if (!this.game || !this.inBattle) return;
    const g = this.game;
    const player = g.player;
    // 发送自己的状态
    this._stateT -= dt;
    if (this._stateT <= 0 && player) {
      this._stateT = STATE_HZ;
      const vk = g.mode === 'tank' ? 'tank' : (player.isHeli ? 'heli' : 'plane');
      const vt = g.mode === 'tank' ? g.tankType : g.planeType;
      const p = player.group.position;
      const q = player.group.quaternion;
      this.send({
        type: 'wt-state', id: this.myId, nm: this.myName, tm: this.myTeam,
        vk, vt,
        p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
        q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
        hd: +(player.heading || 0).toFixed(3),
        ty: +(player.turretYaw || 0).toFixed(3),
        th: +(player.lastThrottle || 0).toFixed(2),
        sp: +(player.speed || 0).toFixed(1),
        hp: Math.round(player.health),
        al: player.alive ? 1 : 0,
        bu: !!player.burning,
      });
    }
    // 幽灵插值
    const k = Math.min(1, dt * 9);   // 指数平滑（9/s 收敛）
    for (const [, gh] of this.ghosts) {
      const e = gh.ent;
      if (!e.alive) continue;
      e.group.position.lerp(gh.tPos, k);
      if (gh.vk === 'tank') {
        e.heading = this.F._lerpAngle(e.heading, gh.tHd, k);
        e.turretYaw = this.F._lerpAngle(e.turretYaw, gh.tTy, k);
        // Tank.update(dt) 由 EntityManager 驱动（视觉：履带/尘带/炮塔姿态/血条）
      } else {
        if (gh.tQuat) e.group.quaternion.slerp(gh.tQuat, k);
        this._ghostAirVisual(e, dt);
      }
    }
    this._updateScoreBanner();
  }

  // 空中幽灵视觉（EntityManager.update 跳过 netGhost 飞机，这里驱动）：
  // 受损拖烟（与真机一致：半血灰烟/残血黑烟）+ 血量 UI 由名字标签系统承担。
  _ghostAirVisual(e, dt) {
    const g = this.game;
    if (!g || !g.em) return;
    if (e.gearTick) e.gearTick(dt);   // 幽灵飞机起落架（update 被跳过，这里驱动收放）
    const fp = e.health / e.maxHealth;
    if (e.alive && fp < 0.5) {
      e._dmgSmokeT = (e._dmgSmokeT || 0) - dt;
      if (e._dmgSmokeT <= 0) {
        e._dmgSmokeT = fp < 0.25 ? 0.3 : 0.65;
        const p2 = e.group.position.clone().addScaledVector(e.forwardVector ? e.forwardVector() : new THREE.Vector3(0, 0, 1), -3);
        g.em.addEffect(new this.F._Smoke(p2.add(new THREE.Vector3((Math.random() - 0.5), 0, (Math.random() - 0.5))), fp < 0.25 ? 0x17130e : 0x57524b, 0.6 + Math.random() * 0.4, 1.0 + Math.random() * 0.6, 1.3));
      }
    }
    if (e.blobWrap) {   // 接地暗影
      if (!e.blobWrap.parent && e.group.parent) e.group.parent.add(e.blobWrap);
      if (e.blobWrap.parent) {
        const gy = this.F.terrainHeight(e.group.position.x, e.group.position.z);
        e.blobWrap.position.set(e.group.position.x, gy + 0.3, e.group.position.z);
        const hAbove = Math.max(0, e.group.position.y - gy);
        const s = Math.max(0.35, 1 - hAbove / 220);
        e.blobWrap.scale.setScalar(s);
        e.blobWrap.rotation.y = Math.atan2(2 * (e.group.quaternion.y * e.group.quaternion.w + e.group.quaternion.x * e.group.quaternion.z), 1 - 2 * (e.group.quaternion.y * e.group.quaternion.y + e.group.quaternion.z * e.group.quaternion.z));
      }
    }
  }

  // —— 开火广播（EntityManager.addProjectile 挂钩） ——
  onLocalProjectile(p) {
    const g = this.game;
    if (!g || !g.player || p.owner !== g.player || !this.inBattle) return;
    const now = performance.now();
    const isMg = p.shellDef && p.shellDef.id === 'mg';
    if (isMg && now - this._lastMgShoot < MG_SHOOT_MIN_GAP * 1000) return;   // 机枪曳光限流
    this._lastMgShoot = now;
    const pos = p.mesh.position;
    const dir = p.velocity.clone().normalize();
    const spd = p.velocity.length();   // Projectile 不存 this.speed，速度从速度向量取模
    let tid = null;
    if (p.homing && p.target) tid = (p.target === g.player) ? this.myId : (p.target.netId != null ? p.target.netId : null);
    this.send({
      type: 'wt-shoot', id: this.myId,
      k: p.artyShell ? 'arty' : (p.isBomb ? 'bomb' : (p.homing ? 'missile' : (isMg ? 'mg' : (p.isRocket ? 'rocket' : 'cannon')))),
      p: [+pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2)],
      d: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)],
      sp: +spd.toFixed(1),
      g: +(p.gravity || 0).toFixed(2),
      sh: p.shellDef ? p.shellDef.id : null,
      tid, br: p.bombRadius || 0,
      dm: Math.round(p.damage), pn: Math.round(p.pen || 0),
    });
  }

  // 远端开火：重建纯视觉弹（不参与伤害判定——伤害由射手端上报）
  _onShoot(m) {
    const g = this.game;
    if (!g || !this.inBattle || m.id === this.myId) return;
    const gh = this.ghosts.get(m.id);
    if (!gh || !gh.ent.alive) return;
    const P = this.F._Projectile;
    const pos = new THREE.Vector3(m.p[0], m.p[1], m.p[2]);
    const dir = new THREE.Vector3(m.d[0], m.d[1], m.d[2]);
    let target = null;
    if (m.tid != null) {
      if (m.tid === this.myId && g.player) target = g.player;
      else { const tg = this.ghosts.get(m.tid); if (tg) target = tg.ent; }
    }
    const proj = new P({
      position: pos, direction: dir,
      speed: m.sp, damage: 0, owner: gh.ent, ownerTeam: gh.ent.team,
      gravity: m.g, life: m.k === 'bomb' ? 12 : 6,
      color: gh.ent.team === 'blue' ? 0xffe08a : 0xff7755,
      size: m.k === 'bomb' ? 0.5 : (m.k === 'missile' ? 0.5 : 0.3),
      pen: 0, shellDef: null,
    });
    proj.netVisual = true;   // checkCollisions / 范围伤害跳过（纯视觉）
    if (m.k === 'bomb' || m.k === 'arty') { proj.isBomb = true; proj.bombRadius = m.br || 20; proj.damage = 0; }
    if (m.k === 'arty') { proj.artyShell = true; proj.bombRadius = 11; }   // 曲射炮：远端同样按落地爆炸（netVisual 不判伤，仅视觉）
    if (m.k === 'missile' && target) { proj.target = target; proj.homing = 3.0; }
    g.em.addProjectile(proj);
    if (g.sfx) {   // 远端炮声/导弹声（按距离衰减由音效系统处理）
      try {
        if (m.k === 'cannon' || m.k === 'bomb') g.sfx.gunshot(pos, 100);
        else if (m.k === 'missile') g.sfx.missile(pos);
      } catch (e) {}
    }
  }

  // —— 命中上报（射手端 → 主机；主机自己的命中本地直处理，不经网络回环） ——
  reportHit(ghost, damage, proj, hitPoint) {
    const g = this.game;
    if (!g || ghost.netId == null) return;
    const dir = proj.velocity ? proj.velocity.clone().normalize() : new THREE.Vector3(0, -1, 0);
    const msg = {
      type: 'wt-hit', id: this.myId, tid: ghost.netId,
      dmg: Math.round(damage), pen: Math.round(proj.pen || 0),
      sh: proj.shellDef ? proj.shellDef.id : null,
      d: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)],
      sp: Math.round(proj.velocity ? proj.velocity.length() : 300),   // 真实弹速（Projectile 不存 this.speed）
      hp: hitPoint ? [+hitPoint.x.toFixed(2), +hitPoint.y.toFixed(2), +hitPoint.z.toFixed(2)] : null,
      ds: proj.launchPos ? Math.round(proj.launchPos.distanceTo(hitPoint || ghost.position)) : 0,
    };
    if (this.isHost) this._hostHit(msg);   // 主机即裁判：直接判定（wt-hit 广播其他人也不消费）
    else this.send(msg);
  }

  // —— 主机权威：处理命中 ——
  _hostHit(m) {
    const g = this.game;
    if (!g || !this.inBattle) return;
    if (m.dmg == null || m.dmg < 0 || m.dmg > 5000) return;   // 数值 sanity（上限覆盖核弹 3000）
    const shooter = this.scores.get(m.id);
    if (!shooter || shooter.t === (this.scores.get(m.tid) || {}).t) return;   // 打队友：忽略
    let ent = null;
    if (m.tid === this.myId) {
      ent = g.player;   // 打的是主机本人：完整装甲判定直接作用真身
      if (!ent || !ent.alive) return;
    } else {
      const gh = this.ghosts.get(m.tid);
      if (!gh || !gh.ent.alive) return;
      ent = gh.ent;
      // 距离 sanity：射手与目标太远（数据异常）忽略
      const sgh = this.ghosts.get(m.id);
      const spos = sgh ? sgh.ent.position : (g.player ? g.player.position : null);
      if (spos && spos.distanceTo(ent.position) > 1200) return;
    }
    // 重建伪弹丸：让 onHit 走完整装甲/部位判定
    const shellDef = m.sh ? this.F.shellById(m.sh) : null;
    const hitPoint = m.hp ? new THREE.Vector3(m.hp[0], m.hp[1], m.hp[2]) : ent.position.clone();
    const fake = {
      damage: m.dmg, pen: m.pen || 0, shellDef,
      velocity: new THREE.Vector3(m.d[0], m.d[1], m.d[2]).multiplyScalar(m.sp || 300),
      radius: 0.4, isTail: false,
      launchPos: hitPoint.clone().addScaledVector(new THREE.Vector3(m.d[0], m.d[1], m.d[2]), -(m.ds || 0)),   // 穿深衰减用：命中点沿来弹方向倒推
    };
    const wasAlive = ent.alive;
    const hpBefore = ent.health;
    // 幽灵平时 takeDamage 空转（血量不随本地判定变）；主机权威判定时临时换回真实现
    if (ent.netGhost) ent.takeDamage = ent._origTakeDamage;
    const verdict = ent.onHit(m.dmg, fake, hitPoint);
    if (ent.netGhost) ent.takeDamage = () => {};
    // 主机本人被判定致死：_onDmg 会因 p.alive=false 提前 return 设不上 _netDead，这里补标（防 _handleDeaths 多发 wt-died）
    if (!ent.netGhost && wasAlive && !ent.alive) ent._netDead = true;
    const dmgDone = Math.max(0, Math.round(hpBefore - ent.health));
    // 主机本人被打：本地受击反馈由 onHit 管线出；幽灵被打：无
    if (dmgDone > 0 || verdict !== 'pen') {
      this.send({
        type: 'wt-dmg', tid: m.tid, hp: Math.max(0, Math.round(ent.health)),
        dmg: dmgDone, verdict, crit: ent.lastCrit || null, fid: m.id,
      });
      // 主机自己也按广播路径走一遍（统一本地表现）
      this._onDmg({ tid: m.tid, hp: Math.max(0, Math.round(ent.health)), dmg: dmgDone, verdict, crit: ent.lastCrit || null, fid: m.id });
    }
    if (wasAlive && !ent.alive) this._hostKill(m.tid, m.id);
  }

  _hostDied(m) {
    // 受害者本地死亡（烧尽/坠机），主机确认后补发击杀
    if (!this.inBattle) return;
    let ent;
    if (m.id === this.myId) ent = this.game && this.game.player;
    else { const gh = this.ghosts.get(m.id); ent = gh && gh.ent; }
    if (!ent || ent.alive || ent.health > 0) return;   // 不认可：血没空
    this._hostKill(m.id, m.fid != null ? m.fid : m.id);
  }

  _hostKill(victimId, killerId) {
    const v = this.scores.get(victimId) || { n: '玩家' + victimId, k: 0, d: 0, t: 'red' };
    const kk = this.scores.get(killerId) || { n: '玩家' + killerId, k: 0, d: 0, t: this.myTeam === 'blue' ? 'red' : 'blue' };
    v.d = (v.d || 0) + 1;
    if (killerId !== victimId) kk.k = (kk.k || 0) + 1;
    this.scores.set(victimId, v); this.scores.set(killerId, kk);
    const scores = this._scoresObj();
    this.send({ type: 'wt-kill', vid: victimId, kid: killerId, vn: v.n, kn: kk.n, scores, vteam: v.t });
    this._onKill({ vid: victimId, kid: killerId, vn: v.n, kn: kk.n, scores, vteam: v.t });
    setTimeout(() => {
      if (!this.inBattle) return;
      this.send({ type: 'wt-respawn', id: victimId });
      this._onRespawn({ id: victimId });
    }, RESPAWN_DELAY * 1000);
    this._checkWin();
  }

  _checkWin() {
    if (this._ended || !this.isHost) return;
    let blue = 0, red = 0;
    for (const [, s] of this.scores) { if (s.t === 'blue') blue += s.k || 0; else red += s.k || 0; }
    if (blue >= this.targetKills || red >= this.targetKills) {
      this._ended = true;
      const winner = blue >= this.targetKills ? 'blue' : 'red';
      this.send({ type: 'wt-end', winner, scores: this._scoresObj() });
      this._onEnd({ winner, scores: this._scoresObj() });
    }
  }

  // —— 全员：伤害/击杀/重生/终局 ——
  _onDmg(m) {
    const g = this.game;
    if (!g || !this.inBattle) return;
    if (m.tid === this.myId) {
      const p = g.player;
      if (!p || !p.alive) return;
      p.health = Math.max(0, m.hp);
      if (m.crit && typeof m.crit === 'string' && p.burning !== undefined && /起火/.test(m.crit)) p.burning = true;
      g.hud.flashHit(m.hp <= 0 ? 'kill' : 'hit');
      if (m.dmg > 0) g.hud.addFeed(`💥 被 ${this.scores.get(m.fid)?.n || '敌人'} 击中 -${m.dmg}${m.crit ? ' · ' + m.crit : ''}`, 'death');
      g._shake = Math.max(g._shake || 0, 0.35);
      if (p.health <= 0) {
        p._netKillerId = m.fid;
        p._netDead = true;   // 主机确认击杀：_handleDeaths 不再补报 wt-died
        p.alive = false;
        // 爆炸视觉（本机没有命中弹丸，手动补）
        g.em.addEffect(new this.F._Explosion(p.group.position.clone(), (p.radius || 3) * 1.1, 0xffa040));
        p._lastAttacker = null;
      }
    } else {
      const gh = this.ghosts.get(m.tid);
      if (!gh) return;
      gh.ent.health = Math.max(0, Math.min(gh.ent.maxHealth, m.hp));
      if (/起火/.test(String(m.crit || ''))) gh.ent.burning = true;
    }
  }

  _onKill(m) {
    const g = this.game;
    if (m.scores) for (const [id, s] of Object.entries(m.scores)) this.scores.set(Number(id), s);
    if (!g || !this.inBattle) return;
    const meKilled = m.vid === this.myId;
    const iKilled = m.kid === this.myId;
    if (g.player) g.player.killCount = (this.scores.get(this.myId) || {}).k || 0;
    const gh = this.ghosts.get(m.vid);
    if (gh) {
      gh.ent.killCount = (this.scores.get(m.vid) || {}).k || 0;
      this._ghostDie(gh.ent, gh.ent.position.clone());
    }
    g.hud.addFeed(`${iKilled ? '🎯 你击毁' : '⚔ ' + m.kn} ${meKilled ? '了你' : m.vn}${iKilled ? '  +1' : ''}`, iKilled ? 'kill' : (meKilled ? 'death' : 'info'));
    const mm = Math.floor((g.matchT || 0) / 60), ss = String(Math.floor((g.matchT || 0) % 60)).padStart(2, '0');
    g.killLog.push({ t: `${mm}:${ss}`, a: m.kn, v: m.vn, aTeam: (this.scores.get(m.kid) || {}).t === this.myTeam ? 'blue' : 'red' });
    if (g.killLog.length > 30) g.killLog.shift();
    if (iKilled) g.sfx && g.sfx.kill();
  }

  _ghostDie(ent, at) {
    const g = this.game;
    if (!g) return;
    ent.health = 0;
    ent.alive = false;
    if (g.em) {
      g.em.addEffect(new this.F._Explosion(at.clone(), (ent.radius || 3) * 1.2, 0xffa040));
      g.em.addEffect(new this.F._SplashRing(at.clone()));
    }
    // cullDead 下一帧自动收尸（Wreck/CrashFall 残骸表现与单机一致）
  }

  _onRespawn(m) {
    // 本人重生由本地 respawnTimer 驱动；幽灵重生等 wt-state(al=1) 重建
    if (m.id === this.myId) return;
    const gh = this.ghosts.get(m.id);
    if (gh) this.removeGhost(m.id);   // 等 wt-state 重新创建（换载具也能兼容）
  }

  noteRespawn() {
    // 本地重生完成（Game._makePlayer 后调用）：立即广播满血状态
    this._stateT = 0;
  }

  _onEnd(m) {
    this._ended = true;
    if (m.scores) for (const [id, s] of Object.entries(m.scores)) this.scores.set(Number(id), s);
    const g = this.game;
    if (!g || !this.inBattle) return;
    this.inBattle = false;
    const win = m.winner === this.myTeam;
    if (g.state === 'playing') g._end(win);
  }

  // —— 计分板/横幅 ——
  _scoresObj() {
    const o = {};
    for (const [id, s] of this.scores) o[id] = { n: s.n, k: s.k || 0, d: s.d || 0, t: s.t };
    return o;
  }

  _ensureScoreBanner() {
    if (this._scoreEl || !this.game) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:30;pointer-events:none;background:rgba(10,14,10,.62);border:1px solid rgba(120,150,120,.25);border-radius:10px;padding:4px 16px;font:600 14px/1.5 sans-serif;color:#ddd;text-shadow:0 1px 2px #000;display:flex;gap:12px;align-items:center';
    this.game.hudContainer && this.game.hudContainer.appendChild(el);
    this._scoreEl = el;
  }

  _updateScoreBanner() {
    if (!this._scoreEl) return;
    let blue = 0, red = 0;
    for (const [, s] of this.scores) { if (s.t === 'blue') blue += s.k || 0; else red += s.k || 0; }
    const my = this.myTeam;
    this._scoreEl.innerHTML =
      `<span style="color:#8ecbff">🔵 ${my === 'blue' ? '我方' : '敌方'} ${blue}</span>` +
      `<span style="color:#777">:</span>` +
      `<span style="color:#ff9d8a">${red} ${my === 'red' ? '我方' : '敌方'} 🔴</span>` +
      `<span style="color:#8a8;font-size:12px">目标 ${this.targetKills} 杀</span>`;
  }

  // Tab 战绩板数据（Game._scoreData 在 mp 模式委托到这里）
  scoreData(base) {
    const blue = [], red = [];
    const mine = (id, s) => ({ name: s.n + (id === this.myId ? '（你）' : ''), kills: s.k || 0, alive: true, team: 'blue', boss: false, me: id === this.myId });
    if (this.game && this.game.player && this.game.player.alive) {
      const meS = this.scores.get(this.myId) || { n: this.myName, k: 0, d: 0, t: this.myTeam };
      blue.push(mine(this.myId, meS));
    }
    for (const [id, s] of this.scores) {
      if (id === this.myId) continue;
      const row = mine(id, s);
      if (s.t === this.myTeam) { const gh = this.ghosts.get(id); row.alive = gh ? gh.ent.alive : true; blue.push(row); }
      else red.push(row);
    }
    return { time: base.time || 0, mp: true, target: this.targetKills, conquest: false, blueT: null, redT: null, kills: (this.scores.get(this.myId) || {}).k || 0, enemyTickets: null, blue, red, log: this.game ? this.game.killLog : [] };
  }

  _feed(txt) {
    const g = this.game;
    if (g && g.hud) g.hud.addFeed(txt, 'info');
  }

  dispose() {
    this.hideLobby();
    if (this._scoreEl) { this._scoreEl.remove(); this._scoreEl = null; }
    this.ghosts.forEach((g) => { try { g.ent.group.traverse((c) => { if (c.geometry) c.geometry.dispose(); if (c.material) { Array.isArray(c.material) ? c.material.forEach((m) => m.dispose()) : c.material.dispose(); } }); } catch (e) {} });
    this.ghosts.clear();
    this.active = false;
    this.inBattle = false;
  }
}
