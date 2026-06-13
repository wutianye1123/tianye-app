const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = 18766;
const MAX_PAYLOAD = 256 * 1024; // 单条消息上限 256KB
const HOST_RECONNECT_WINDOW = 30000;
const ROOMS_RATE_LIMIT_MS = 2000; // /rooms 接口每个 IP 最小间隔
const rooms = new Map();
const roomsLastQuery = new Map(); // ip -> timestamp

const server = http.createServer((req, res) => {
  if (req.url === '/rooms') {
    // 简单节流，防止枚举扫房
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const now = Date.now();
    const last = roomsLastQuery.get(ip) || 0;
    if (now - last < ROOMS_RATE_LIMIT_MS) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('{"error":"rate_limited"}');
      return;
    }
    roomsLastQuery.set(ip, now);
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

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
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
          reconnectTimer: null
        });
        ws.roomId = roomId;
        ws.playerId = 0;
        ws.isHost = true;
        send(ws, { type: 'hosted', roomId, playerId: 0, token: hostToken });
        log('房间 ' + roomId + ' 创建 by ' + data.name);
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
        for (const [pid, c] of room.clients) {
          if (pid !== id) send(c.ws, { type: 'player-join', id, name });
        }
        log(name + ' 加入房间 ' + roomId);
        break;
      }

      case 'relay': {
        const room2 = rooms.get(ws.roomId);
        if (!room2) return;
        const msg = { ...data.data, id: ws.playerId };
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
    }
  });

  ws.on('close', () => {
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
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Relay server running on port', PORT);
});
