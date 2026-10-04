// net-stub.js — 联机本地测试钩子：URL 带 ?stub=1 时注入 window.electronAPI 假实现（连本地中转 :8124）
// 不带参数时完全空转，不影响正常游戏/打包。仅供 E2E 调试联机逻辑使用。
// 附带测试驱动（?stub=1 自动激活）：关键节点打点到 /__st__（http.server 日志可读），
// 主机端自动开局，双端自动开火，轮询错误面板——两个独立 Chrome 进程即可完成 E2E。
(function () {
  const q = new URLSearchParams(location.search);
  // probe 模式：单机自动验证（不注入 electronAPI）：满油门滑跑→带杆起飞→验证起落架收放；
  // URL tank=m109 时预置车库选中 M109（验证曲射炮半血语义）
  if (q.get('probe') === '1') {
    if (q.get('tank') === 'm109') {
      try {
        const m = JSON.parse(localStorage.getItem('warthunder_meta_v1') || '{}');
        m.owned = m.owned || ['medium']; if (!m.owned.includes('m109')) m.owned.push('m109');
        m.selected = 'm109'; m.money = m.money || 0;
        localStorage.setItem('warthunder_meta_v1', JSON.stringify(m));
      } catch (e) {}
    }
    const beacon = (s) => { try { fetch('/__st__?s=P:' + encodeURIComponent(s)).catch(() => {}); } catch (e) {} };
    let phase = 0, artyTested = false;
    setInterval(() => {
      const g = window.__game;
      if (!g || !g.player) { if (Math.random() < 0.2) beacon('wait'); return; }
      const p = g.player;
      if (g.mode === 'plane') {   // —— 起落架验证流程 ——
        if (phase === 0) {
          beacon('spawn-onGround' + (p.onGround ? 1 : 0) + '-gearVis' + (p.gearGroup && p.gearGroup.visible ? 1 : 0) + '-anim' + (p.gearAnim != null ? +p.gearAnim.toFixed(2) : '-') + '-gearH' + (p.gearHeight != null ? +p.gearHeight.toFixed(2) : '-'));
          if (p.onGround) { phase = 1; p.throttle = 1; }
        } else if (phase === 1) {
          p.throttle = 1;
          if (p.onGround && p.speed > 45) { p.onGround = false; p.group.rotateX(-0.3); beacon('manual-liftoff-speed' + Math.round(p.speed)); }
          if (!p.onGround) { phase = 2; beacon('liftoff-speed' + Math.round(p.speed) + '-y' + Math.round(p.group.position.y)); }
        } else if (phase === 2) {
          p.throttle = 1;
          p.group.position.y = Math.min(p.group.position.y + 6, 60);   // 注入爬升（鼠标无法模拟，直接抬高度验证收起）
          if (Math.random() < 0.3) beacon('flying-gearVis' + (p.gearGroup && p.gearGroup.visible ? 1 : 0) + '-anim' + (p.gearAnim != null ? +p.gearAnim.toFixed(2) : '-') + '-y' + Math.round(p.group.position.y) + '-alive' + (p.alive ? 1 : 0));
        }
        return;
      }
      // —— 坦克/M109 曲射炮验证 ——
      if (!artyTested && g.enemies && g.enemies.length) {
        const e0 = g.enemies[0];
        artyTested = true;
        beacon('m109-isArty' + (p.isArty ? 1 : 0) + '-ringVis' + (g._artyAimRing && g._artyAimRing.visible ? 1 : 0));
        try {
          // 导引头验证（无锁定场景）：敌 0 放到准星落点侧方 80m（12° 锁定锥外→不锁定），
          // 朝地面点开火——弹自带导引头应捕获瞄准点旁 90m 内的它并追踪命中
          if (g._aimHitPt && e0) {
            e0.group.position.set(g._aimHitPt.x + 80, e0.group.position.y, g._aimHitPt.z + 15);
            beacon('seekSetup-e0Lateral80');
          }
        } catch (err) { beacon('LOCKSETUP-THROW-' + err.message); }
      }
      // 无锁定也开火（验证导引头自动捕获），观察弹是否自己咬住侧方敌并命中半血
      if (artyTested && !window.__firedOnce && p.reloadTimer <= 0 && p.alive) {
        window.__firedOnce = true;
        const r = p.tryFire(g.em);
        const lastP = g.em.projectiles[g.em.projectiles.length - 1];
        window.__fireTgt = lastP && lastP.target;
        beacon('guidedFire-' + r + '-guided' + (lastP && lastP.guided ? 1 : 0) + '-lockedAtFire' + (g._artyLock ? 1 : 0) + '-preTgt' + (lastP && lastP.target ? 1 : 0) + '-seekFn' + (lastP && lastP.seekFn ? 1 : 0));
      }
      if (artyTested && Math.random() < 0.4) {
        const ft = window.__fireTgt;
        beacon('tgtResult-' + (ft ? ('hp' + Math.round(ft.health) + '-max' + Math.round(ft.maxHealth) + '-alive' + (ft.alive ? 1 : 0) + '-' + (ft.displayName || '?')) : 'none')
          + '-projN' + g.em.projectiles.length
          + (() => { const q = g.em.projectiles[0]; return q && q.target ? '-chasing' + (q.target.displayName || '?') : ''; })());
      }
    }, 1000);
    window.addEventListener('error', (e) => beacon('WINERR-' + (e.message || '').slice(0, 120)));
    return;
  }
  if (q.get('stub') !== '1') return;
  const WS_URL = q.get('ws') || 'ws://localhost:8124';
  const name = q.get('name') || ('测试' + Math.floor(Math.random() * 90 + 10));
  const isHost = q.get('host') === '1';
  const tag = isHost ? 'H' : 'G';
  const beacon = (s) => { try { fetch('/__st__?s=' + tag + ':' + encodeURIComponent(s)).catch(() => {}); } catch (e) {} };
  let ws = null, myId = isHost ? 0 : null, peers = [];
  const cbs = [];
  const ready = new Promise((resolve) => {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', name })); beacon('ws-open'); };
    let msgN = 0;
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (msgN < 3) beacon('msg-' + (d.type || '?') + '-id' + d.id);
      msgN++;
      if (d.type === 'your-id') {
        myId = d.id;
        beacon('got-id-' + d.id);
        ws.send(JSON.stringify({ type: 'list' }));
        setTimeout(() => { beacon('ready-go'); resolve(); }, 400);
      } else if (d.type === 'player-list') {
        peers = (d.players || []).filter((p) => p.id !== myId);
      }
      for (const cb of cbs) { try { cb(d); } catch (e) { console.error('[stub cb]', e); } }
    };
    ws.onclose = () => { beacon('ws-close'); for (const cb of cbs) { try { cb({ type: 'disconnected' }); } catch (e) {} } };
    let fb = 0;
    const fbiv = setInterval(() => { fb++; if (fb >= 3) { clearInterval(fbiv); beacon('ready-fallback'); resolve(); } }, 1000);
  });
  window.electronAPI = {
    mpGetState: async () => { await ready; beacon('state-myId' + myId + '-peers' + peers.length); return { active: true, isHost, myId, myName: name, roomId: 'LOCAL', peers }; },
    mpSend: (d) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'relay', data: d })); } catch (e) {} },
    mpStop: async () => ({}),
    onMpMessage: (cb) => { cbs.push(cb); },
  };

  // ===== 测试驱动 =====
  const fatal = () => { const el = document.getElementById('fatal-err'); return el ? el.textContent.slice(0, 300) : ''; };
  // 主机：__mp 就绪 → 自动开局；同时监听关键协议消息（收发审计）；URL vk=plane 时主机选飞机（验证跑道起飞）
  if (isHost) {
    const iv = setInterval(() => {
      if (window.__mp) {
        clearInterval(iv);
        const mp = window.__mp;
        if (q.get('vk') === 'plane') mp.myVk = 'plane';
        const orig = mp._onMsg.bind(mp);
        mp._onMsg = (m) => { if (m.type && m.type.startsWith('wt-') && m.type !== 'wt-state' && m.type !== 'wt-shoot') beacon('rx-' + m.type + (m.tid !== undefined ? '-tid' + m.tid : '') + (m.vid !== undefined ? '-vid' + m.vid : '')); return orig(m); };
        const origSend = mp.send.bind(mp);
        mp.send = (d) => { if (d.type && d.type.startsWith('wt-') && d.type !== 'wt-state' && d.type !== 'wt-shoot') beacon('tx-' + d.type + (d.tid !== undefined ? '-tid' + d.tid : '') + (d.vid !== undefined ? '-vid' + d.vid : '')); return origSend(d); };
        const lo = document.getElementById('loadout');
        beacon('lobby-ok-vehpicker' + (lo && !lo.classList.contains('hidden') ? 1 : 0) + '-bar' + (document.getElementById('mp-lobby') ? 1 : 0));
        mp.mapId = mp.mapId || 'open';
        try { mp.hostStart(); beacon('started'); } catch (e) { beacon('HOSTSTART-THROW-' + e.message); }
      }
    }, 400);
  }
  // 客机：同样装监听
  if (!isHost) {
    const iv2 = setInterval(() => {
      if (window.__mp) {
        clearInterval(iv2);
        const mp = window.__mp;
        const orig = mp._onMsg.bind(mp);
        mp._onMsg = (m) => { if (m.type && m.type.startsWith('wt-') && m.type !== 'wt-state' && m.type !== 'wt-shoot') beacon('rx-' + m.type + (m.tid !== undefined ? '-tid' + m.tid : '') + (m.vid !== undefined ? '-vid' + m.vid : '')); return orig(m); };
        const origSend = mp.send.bind(mp);
        mp.send = (d) => { if (d.type && d.type.startsWith('wt-') && d.type !== 'wt-state' && d.type !== 'wt-shoot') beacon('tx-' + d.type + (d.tid !== undefined ? '-tid' + d.tid : '') + (d.vid !== undefined ? '-vid' + d.vid : '')); return origSend(d); };
      }
    }, 400);
  }
  // 双端：等战斗 → 上报分配后队伍 → 开火三连 → 瞄准幽灵直射弹（验证 hit→dmg→kill 全链路）
  let fired = 0, teamReported = false, killShot = 0;
  setInterval(() => {
    const mp = window.__mp, g = window.__game;
    if (mp && g && g.player && !teamReported) { teamReported = true; beacon('myteam-' + mp.myTeam); }
    // 飞机端：上报跑道出生/起落架状态（验证 MP 机场起飞）
    if (mp && g && g.player && g.mode === 'plane' && !window.__mpSpawnReported) {
      window.__mpSpawnReported = true;
      const p = g.player;
      beacon('mpPlaneSpawn-onGround' + (p.onGround ? 1 : 0) + '-gearVis' + (p.gearGroup && p.gearGroup.visible ? 1 : 0) + '-y' + Math.round(p.group.position.y) + '-z' + Math.round(p.group.position.z));
    }
    if (!mp || !g || !g.player) {
      const f = fatal();
      const bootFail = document.body && document.body.innerHTML && document.body.innerHTML.indexOf('启动失败') >= 0 ? 'BOOTFAIL' : '';
      if (f || bootFail || Math.random() < 0.1) beacon('wait-mp' + !!mp + '-game' + !!g + (f ? '-FATAL:' + f : '') + (bootFail ? '-' + bootFail : ''));
      return;
    }
    if (mp.ghosts.size > 0 && fired < 2 && g.player.alive && g.player.reloadTimer <= 0) {
      fired++;
      try {
        const r = g.player.tryFire(g.em);
        beacon('fire-' + fired + '-' + r + '-ghosts' + mp.ghosts.size);
        // 同帧瞄准击杀弹（借刚生成的弹丸拿构造器，朝第一个幽灵直射）
        beacon('ks-proj' + g.em.projectiles.length);
        if (killShot < 2 && g.em.projectiles.length > 0) {
          killShot++;
          const PC = Object.getPrototypeOf(g.em.projectiles[g.em.projectiles.length - 1]).constructor;
          const gh = mp.ghosts.values().next().value;
          beacon('ks-pc' + (PC ? 1 : 0) + '-gh' + (gh ? 1 : 0) + (gh && gh.ent ? '-alive' + (gh.ent.alive ? 1 : 0) : ''));
          if (gh && gh.ent.alive) {
            const from = g.player.position.clone(); from.y += 4;
            const aim = gh.ent.position.clone(); aim.y += 1.5;
            const dir = aim.sub(from).normalize();
            const kp = new PC({
              position: from, direction: dir, speed: 900, damage: 200,
              owner: g.player, ownerTeam: g.player.team, gravity: 0, life: 4,
              color: 0xffffff, size: 0.45, pen: 9999,
              shellDef: { id: 'ap', name: 'ap', penMul: 1, dmgMul: 1, bounceDeg: 89, noBounce: true },
            });
            g.em.addProjectile(kp);
            beacon('killshot-' + killShot + '-aimed');
          }
        }
      } catch (e) { beacon('FIRE-THROW-' + e.message); }
    }
    if (killShot >= 1 && Math.random() < 0.35) {
      let ghHp = 'none', ghAlive = '-', ghN = 0, ghTeam = '?';
      for (const [gid, gg] of mp.ghosts) { ghHp = Math.round(gg.ent.health); ghAlive = gg.ent.alive ? 1 : 0; ghN++; ghTeam = gg.ent.team; break; }
      const inTanks = g.em.tanks.some((t) => t.netGhost);
      const inPlanes = g.em.planes.some((t) => t.netGhost);
      beacon('status-alive' + (g.player && g.player.alive ? 1 : 0) + '-hp' + Math.round(g.player ? g.player.health : -1) + '-gh' + ghHp + '-' + ghAlive + '-myk' + ((mp.scores.get(mp.myId) || {}).k || 0) + '-ghN' + ghN + ghTeam + '-emT' + (inTanks ? 1 : 0) + '-emP' + (inPlanes ? 1 : 0) + '-proj' + g.em.projectiles.length + (fatal() ? '-FATAL:' + fatal() : ''));
    }
    // 手动链路测试（一次性）：直接调幽灵 onHit（fake 带 owner=本机玩家）——
    // 验证 wrapper→reportHit→主机判定→wt-dmg 广播→各方应用 全链路（与弹道无关）
    if (killShot >= 1 && !window.__manualHitDone && mp.ghosts.size > 0) {
      window.__manualHitDone = true;
      try {
        const gh = mp.ghosts.values().next().value;
        const V = g.player.position.constructor;   // THREE.Vector3（借真实对象拿构造器）
        const fake = {
          damage: 150, pen: 9999, owner: g.player,   // ★ owner=本机玩家：满足 wrapper 上报条件
          shellDef: { id: 'ap', name: 'ap', penMul: 1, dmgMul: 1, bounceDeg: 89, noBounce: true, effCap: 9999 },
          velocity: new V(0, 0, 900),
          radius: 0.4, launchPos: gh.ent.position.clone(),
        };
        const hp0 = gh.ent.health;
        const v = gh.ent.onHit(150, fake, gh.ent.position.clone());
        beacon('manualhit-verdict' + v + '-hp' + hp0 + '>' + Math.round(gh.ent.health));
      } catch (e) { beacon('MANUALHIT-THROW-' + e.message); }
    }
  }, 2000);
  // 未捕获异常（页面级兜底面板之外的多一层保险）
  window.addEventListener('error', (e) => beacon('WINERR-' + (e.message || '').slice(0, 160)));
  window.addEventListener('unhandledrejection', (e) => beacon('REJ-' + String(e.reason).slice(0, 160)));
  console.log('[net-stub] active', { name, isHost, WS_URL });
})();
