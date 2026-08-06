const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./relay-store');   // 档案 / 好友 / 请求 持久化

const PORT = 18766;
const MAX_PAYLOAD = 256 * 1024; // 单条消息上限 256KB
const HOST_RECONNECT_WINDOW = 300000; // 5 分钟宽限（用户的网络会频繁断线，给足重连时间）
// /rooms 不做 rate limit：房间号 6 位（90 万种）本身已足够防枚举扫描
const rooms = new Map();
const onlineClients = new Map();   // friendCode -> Set<ws>（一个账号可多设备/多浏览器同时在线，仅内存）
const lastIdentityAt = new Map();  // friendCode -> 上次 identity-register 时间，用于防重连风暴

const server = http.createServer((req, res) => {
  if (req.url === '/rooms') {
    const list = [];
    for (const [id, r] of rooms) {
      list.push({ roomId: id, hostName: r.hostName, gameName: r.gameName, players: r.clients.size });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(list));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end('{"ok":true}');
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

function genRoomId() {
  let id;
  do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(id));
  return id;
}

// 8 位好友码，与已存在档案去重
function genFriendCode() {
  let code;
  do { code = String(10000000 + Math.floor(Math.random() * 90000000)); } while (store.getProfile(code));
  return code;
}

function nameOf(code) {
  const p = store.getProfile(code);
  return p ? p.name : code;
}
// 给某个好友码发消息（仅在线时）。返回是否送达。
function notifyIfOnline(code, msg) {
  const s = onlineClients.get(code);
  if (!s) return false;
  for (const w of s) send(w, msg);
  return true;
}
// 一个账号可多设备/多浏览器同时在线：onlineClients 维护 code -> Set<ws>
function addSession(code, ws) {
  let s = onlineClients.get(code);
  if (!s) { s = new Set(); onlineClients.set(code, s); }
  s.add(ws);
}
function removeSession(code, ws) {
  const s = onlineClients.get(code);
  if (s) { s.delete(ws); if (s.size === 0) onlineClients.delete(code); }
}
// 该账号任一在线会话所在的房间（用于好友"加入"），无则 null
function sessionRoomId(code) {
  const s = onlineClients.get(code);
  if (!s) return null;
  for (const w of s) if (w.roomId) return w.roomId;
  return null;
}
// 给我的所有在线好友广播（上线/下线/改名/进房间 等）
function broadcastToFriends(code, msg) {
  for (const fcode of store.listFriends(code)) notifyIfOnline(fcode, msg);
}

// 密码哈希（sha256(salt:password)）。salt 随机。Node crypto 已 require。
function hashPassword(pw, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex');
}
// 账号上线：设身份、投递积压的好友请求、通知在线好友。注册/登录/重连统一走这里。
function goOnline(ws, code) {
  ws.friendCode = code;
  addSession(code, ws);
  send(ws, { type: 'identity-registered', code, name: nameOf(code) });
  for (const r of store.getPendingRequests(code)) {
    send(ws, { type: 'incoming-request', from: r.from, fromName: nameOf(r.from), ts: r.ts });
  }
  broadcastToFriends(code, { type: 'friend-online', code, name: nameOf(code), roomId: ws.roomId || null });
}

function send(ws, data) {
  // ws 可能为 null（主机断线期间，其 clients[0] 条目的 ws 被置空），必须防护，
  // 否则 joiner 在此期间发的 relay 消息会触发 null.readyState → 服务器崩溃。
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  log('新连接');

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (data.type) {
      case 'host': {
        const roomId = genRoomId();
        const hostToken = crypto.randomBytes(16).toString('hex');
        const clients = new Map();
        clients.set(0, { ws, name: data.name || '主机' });
        rooms.set(roomId, {
          host: ws, clients,
          gameName: data.gameName || '',
          hostName: data.name || '主机',
          hostToken,                 // 用于校验主机重连身份
          nextPlayerId: 1,
          reconnectTimer: null,
          lastGameStart: null        // 主机开游戏后缓存，晚加入的 joiner 补发
        });
        ws.roomId = roomId;
        ws.playerId = 0;
        ws.isHost = true;
        send(ws, { type: 'hosted', roomId, playerId: 0, token: hostToken });
        log('房间 ' + roomId + ' 创建 by ' + data.name);
        if (ws.friendCode) broadcastToFriends(ws.friendCode, { type: 'friend-online', code: ws.friendCode, name: nameOf(ws.friendCode), roomId });
        break;
      }

      case 'join': {
        const roomId = String(data.roomId);
        const room = rooms.get(roomId);
        if (!room) { send(ws, { type: 'error', msg: '房间不存在' }); return; }

        // 检查是否是主机重连：必须同时匹配 name 和 token
        const isHostReconnect = data.token
          && data.token === room.hostToken
          && data.name === room.hostName;
        if (room.host === null && isHostReconnect) {
          ws.roomId = roomId;
          ws.playerId = 0;
          ws.isHost = true;
          room.host = ws;
          room.clients.set(0, { ws, name: room.hostName });
          // 取消房间关闭定时器
          if (room.reconnectTimer) { clearTimeout(room.reconnectTimer); room.reconnectTimer = null; }
          send(ws, { type: 'joined', playerId: 0, roomId: roomId });
          send(ws, { type: 'your-id', id: 0 });           // 与 LAN 模式协议对齐
          const pl = [];
          for (const [pid, c] of room.clients) pl.push({ id: pid, name: c.name });
          send(ws, { type: 'player-list', players: pl });
          // 通知所有 joiner：主机已恢复
          for (const [pid, c] of room.clients) {
            if (pid !== 0) send(c.ws, { type: 'host-reconnected' });
          }
          log('主机重连，房间 ' + roomId);
          break;
        }
        // 房间处于主机断开状态时不允许新人加入
        if (room.host === null) {
          send(ws, { type: 'error', msg: '主机暂时离线，请稍后重试' });
          return;
        }

        const id = room.nextPlayerId++;
        const name = data.name || ('玩家' + id);
        room.clients.set(id, { ws, name });
        ws.roomId = roomId;
        ws.playerId = id;
        ws.isHost = false;
        send(ws, { type: 'joined', playerId: id, roomId: roomId });
        send(ws, { type: 'your-id', id: id });             // 与 LAN 模式协议对齐
        const playerList = [];
        for (const [pid, c] of room.clients) playerList.push({ id: pid, name: c.name });
        send(ws, { type: 'player-list', players: playerList });
        // 主机已经开始游戏：给晚加入的 joiner 补发 game-start，让它自动进入游戏
        if (room.lastGameStart) send(ws, room.lastGameStart);
        for (const [pid, c] of room.clients) {
          if (pid !== id) send(c.ws, { type: 'player-join', id, name });
        }
        log(name + ' 加入房间 ' + roomId);
        if (ws.friendCode) broadcastToFriends(ws.friendCode, { type: 'friend-online', code: ws.friendCode, name: nameOf(ws.friendCode), roomId });
        break;
      }

      case 'relay': {
        const room2 = rooms.get(ws.roomId);
        if (!room2) return;
        const msg = { ...data.data, id: ws.playerId };
        // 主机开游戏：缓存 game-start，让之后加入的人也能自动进入游戏
        if (ws.isHost && data.data && data.data.type === 'game-start') {
          room2.lastGameStart = msg;
        }
        for (const [pid, c] of room2.clients) {
          if (pid !== ws.playerId) send(c.ws, msg);
        }
        break;
      }

      case 'broadcast': {
        const room3 = rooms.get(ws.roomId);
        if (!room3) return;
        const msg2 = { ...data.data, id: ws.playerId };
        for (const [pid, c] of room3.clients) {
          send(c.ws, msg2);
        }
        break;
      }

      // ===== 好友 / 身份 / presence（身份注册可选；未注册的老客户端仍能 host/join）=====
      case 'identity-register': {
        // 仅用于已登录账号的免密重连（凭本地存储的 code）；不凭昵称自动注册（注册/登录走 account-*）
        const code = (data.code && store.getProfile(String(data.code))) ? String(data.code) : null;
        if (!code) { send(ws, { type: 'identity-rejected', msg: '请先注册或登录' }); break; }
        // 限流：同一 code 1 秒内重复重连直接忽略（防重连风暴）
        const now = Date.now();
        if (lastIdentityAt.has(code) && now - lastIdentityAt.get(code) < 1000) break;
        lastIdentityAt.set(code, now);
        goOnline(ws, code);
        log('重连身份 ' + code + ' (' + nameOf(code) + ')');
        break;
      }

      case 'account-register': {
        const name = String(data.name || '').slice(0, 32).trim();
        const password = String(data.password || '');
        if (!name) { send(ws, { type: 'auth-error', msg: '请输入昵称' }); break; }
        if (password.length < 4) { send(ws, { type: 'auth-error', msg: '密码至少 4 位' }); break; }
        const salt = crypto.randomBytes(8).toString('hex');
        const passHash = hashPassword(password, salt);
        const r = store.registerAccount(name, passHash, salt);
        if (!r.ok) { send(ws, { type: 'auth-error', msg: r.msg }); break; }
        goOnline(ws, r.code);
        log('注册账号 ' + r.code + ' (' + name + ')');
        break;
      }

      case 'account-login': {
        const name = String(data.name || '').slice(0, 32).trim();
        const password = String(data.password || '');
        const code = store.findCodeByName(name);
        if (!code) { send(ws, { type: 'auth-error', msg: '账号不存在' }); break; }
        const p = store.getProfile(code);
        if (!p || !p.passHash) { send(ws, { type: 'auth-error', msg: '该账号尚未设置密码，请先注册' }); break; }
        if (hashPassword(password, p.salt || '') !== p.passHash) { send(ws, { type: 'auth-error', msg: '密码错误' }); break; }
        goOnline(ws, code);
        log('登录 ' + code + ' (' + name + ')');
        break;
      }

      case 'update-name': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const name = String(data.name || '玩家').slice(0, 32);
        store.updateName(ws.friendCode, name);
        broadcastToFriends(ws.friendCode, { type: 'friend-name-change', code: ws.friendCode, name });
        send(ws, { type: 'name-updated', ok: true });
        break;
      }

      case 'friend-request': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const target = String(data.code || '');
        if (!store.getProfile(target)) { send(ws, { type: 'friend-request-result', ok: false, msg: '好友码不存在' }); break; }
        const result = store.addRequest(ws.friendCode, target);
        if (result.ok && result.mutual) {
          notifyIfOnline(target, { type: 'friend-added', code: ws.friendCode, name: nameOf(ws.friendCode) });
          send(ws, { type: 'friend-added', code: target, name: nameOf(target) });
          if (onlineClients.has(target)) send(ws, { type: 'friend-online', code: target, name: nameOf(target), roomId: sessionRoomId(target) });
          notifyIfOnline(target, { type: 'friend-online', code: ws.friendCode, name: nameOf(ws.friendCode), roomId: ws.roomId || null });
        } else if (result.ok) {
          notifyIfOnline(target, { type: 'incoming-request', from: ws.friendCode, fromName: nameOf(ws.friendCode), ts: Date.now() });
          send(ws, { type: 'friend-request-result', ok: true, msg: '请求已发送' });
        } else {
          send(ws, { type: 'friend-request-result', ok: false, msg: result.msg });
        }
        break;
      }

      case 'friend-accept': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const from = String(data.code || '');
        store.acceptRequest(from, ws.friendCode);
        notifyIfOnline(from, { type: 'request-accepted', code: ws.friendCode, name: nameOf(ws.friendCode) });
        send(ws, { type: 'friend-added', code: from, name: nameOf(from) });
        if (onlineClients.has(from)) send(ws, { type: 'friend-online', code: from, name: nameOf(from), roomId: sessionRoomId(from) });
        notifyIfOnline(from, { type: 'friend-online', code: ws.friendCode, name: nameOf(ws.friendCode), roomId: ws.roomId || null });
        break;
      }

      case 'friend-reject': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        store.rejectRequest(String(data.code || ''), ws.friendCode);
        send(ws, { type: 'friend-rejected-result', ok: true });
        break;
      }

      case 'friend-remove': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const other = String(data.code || '');
        store.removeFriend(ws.friendCode, other);
        notifyIfOnline(other, { type: 'friend-removed', code: ws.friendCode });
        send(ws, { type: 'friend-removed-result', ok: true, code: other });
        break;
      }

      case 'friends-presence': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const list = store.listFriends(ws.friendCode).map(code => {
          const s = onlineClients.get(code);
          return { code, name: nameOf(code), online: !!(s && s.size), roomId: sessionRoomId(code) };
        });
        send(ws, { type: 'friends-presence-snapshot', list });
        break;
      }

      case 'invite': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        if (!ws.roomId) { send(ws, { type: 'invite-result', ok: false, msg: '你还没有创建房间' }); break; }
        const target = String(data.code || '');
        if (!store.areFriends(ws.friendCode, target)) { send(ws, { type: 'invite-result', ok: false, msg: '对方不是你的好友' }); break; }
        const delivered = notifyIfOnline(target, { type: 'incoming-invite', from: ws.friendCode, fromName: nameOf(ws.friendCode), roomId: ws.roomId });
        send(ws, { type: 'invite-result', ok: !!delivered, msg: delivered ? '邀请已发送' : '对方不在线' });
        break;
      }

      case 'delete-account': {
        if (!ws.friendCode) { send(ws, { type: 'error', msg: '未注册身份' }); break; }
        const delCode = ws.friendCode;
        // 通知在线好友：对方已删除账号（从好友列表移除）
        broadcastToFriends(delCode, { type: 'friend-removed', code: delCode });
        store.deleteAccount(delCode);
        onlineClients.delete(delCode);
        ws.friendCode = null;
        send(ws, { type: 'account-deleted' });
        log('删除账号 ' + delCode);
        break;
      }

      case 'leave-room': {
        // 主动离开房间但保持 presence 连接（mpStop 用，避免断开好友在线状态）
        const roomId = ws.roomId;
        if (roomId) {
          const room = rooms.get(roomId);
          if (room) {
            if (ws.isHost) {
              for (const [pid, c] of room.clients) {
                if (pid !== 0 && c.ws && c.ws.readyState === 1) {
                  send(c.ws, { type: 'host-disconnected' });
                  try { c.ws.close(); } catch (e) {}
                }
              }
              if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
              rooms.delete(roomId);
              log('主机主动关闭房间 ' + roomId);
            } else {
              room.clients.delete(ws.playerId);
              for (const [pid, c] of room.clients) {
                if (c.ws && c.ws.readyState === 1) send(c.ws, { type: 'player-leave', id: ws.playerId });
              }
            }
          }
          ws.roomId = null;
          ws.isHost = false;
          ws.playerId = null;
        }
        if (ws.friendCode) broadcastToFriends(ws.friendCode, { type: 'friend-online', code: ws.friendCode, name: nameOf(ws.friendCode), roomId: null });
        send(ws, { type: 'leave-room-ok' });
        break;
      }
    }
  });

  ws.on('close', (code, reason) => {
    log('断开 friendCode=' + (ws.friendCode || '-') + ' roomId=' + (ws.roomId || '-') + ' isHost=' + !!ws.isHost + ' closeCode=' + code + ' reason=' + (reason ? Buffer.from(reason).toString() : '-'));
    // 好友在线状态下线（即便不在房间里也要处理）
    if (ws.friendCode) {
      removeSession(ws.friendCode, ws);
      // 该账号所有会话都下线了，才通知好友离线
      if (!onlineClients.has(ws.friendCode)) {
        broadcastToFriends(ws.friendCode, { type: 'friend-offline', code: ws.friendCode });
      }
    }
    const roomId = ws.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (ws.isHost) {
      // 主机断开：给 30 秒宽限期让主机重连（页面跳转时会短暂断开）
      room.host = null;
      // 清理旧 ws 在 clients 中的引用，避免后续 send 失败堆积
      const hostEntry = room.clients.get(0);
      if (hostEntry && hostEntry.ws === ws) {
        room.clients.set(0, { ws: null, name: room.hostName });
      }
      // 立即通知所有 joiner：主机暂时离线（让他们 UI 上提示，但保持连接）
      for (const [pid, c] of room.clients) {
        if (pid !== 0 && c.ws && c.ws.readyState === 1) {
          send(c.ws, { type: 'host-paused' });
        }
      }
      log('主机暂时断开，等待重连，房间 ' + roomId);
      // 取消任何旧的 timer，避免 race（重连→再断→旧 timer 把房间关掉）
      if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
      room.reconnectTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (!r) return;
        if (r.host !== null) return;        // 主机已重连
        log('主机未重连，关闭房间 ' + roomId);
        for (const [pid, c] of r.clients) {
          if (c.ws && c.ws.readyState === 1) {
            send(c.ws, { type: 'host-disconnected' });
            c.ws.close();
          }
        }
        rooms.delete(roomId);
      }, HOST_RECONNECT_WINDOW);
    } else {
      room.clients.delete(ws.playerId);
      for (const [pid, c] of room.clients) {
        if (c.ws && c.ws.readyState === 1) send(c.ws, { type: 'player-leave', id: ws.playerId });
      }
      log('玩家 ' + ws.playerId + ' 离开房间 ' + roomId);
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Relay server running on port', PORT);
});
