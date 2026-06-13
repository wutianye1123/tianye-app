const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const { exec } = require('child_process');
const dgram = require('dgram');

let win;
let firstLoad = true;
let port = 0;

// 自动存档：在页面导航前调用游戏的保存函数
async function triggerAutoSave() {
  // 先记录游玩结束时间（不计入后续清理耗时）
  try { recordGameEnd(); } catch (e) {}
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    const url = win.webContents.getURL();
    if (!url || url.includes('launcher.html')) return;
    await win.webContents.executeJavaScript(`
      if (typeof saveGame === 'function') saveGame();
      else if (typeof saveGameMC === 'function') saveGameMC();
      else if (typeof saveGameGoat === 'function') saveGameGoat();
      else if (typeof saveGameTB === 'function') saveGameTB();
      else if (window.game && typeof window.game.saveGame === 'function') window.game.saveGame();
      if (typeof mpStopAll === 'function') mpStopAll();
      // 清理Three.js资源，防止GPU内存泄漏
      (function cleanupThreeJS() {
        var r = typeof renderer !== 'undefined' ? renderer
              : (window.game && window.game.renderer);
        if (r && typeof r.dispose === 'function') {
          try {
            var s = typeof scene !== 'undefined' ? scene
                  : (window.game && window.game.scene);
            if (s && s.traverse) {
              s.traverse(function(obj) {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                  var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                  mats.forEach(function(m) {
                    if (m.map) m.map.dispose();
                    if (m.normalMap) m.normalMap.dispose();
                    if (m.roughnessMap) m.roughnessMap.dispose();
                    if (m.metalnessMap) m.metalnessMap.dispose();
                    if (m.aoMap) m.aoMap.dispose();
                    if (m.emissiveMap) m.emissiveMap.dispose();
                    m.dispose();
                  });
                }
              });
            }
            r.dispose();
            if (r.forceContextLoss) r.forceContextLoss();
          } catch(e) { console.error('ThreeJS cleanup error:', e); }
        }
      })();
    `);
  } catch (e) {
    console.error('triggerAutoSave executeJavaScript failed:', e);
  }
  // 注意：不要在这里调用 mpStop()/relayStop()。
  // 切换游戏（launch-game / back-to-launcher / F2）时应保持联机会话，
  // 游戏页面通过 mpGetState() 恢复联机状态。
  // 只有用户主动点"关闭房间"或退出整个应用时才真正断开。
}

// 导航后清理渲染进程缓存，释放残留内存
function purgeAfterNavigation() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.session.clearCache(() => {});
  } catch (e) {}
}

// 游玩时长追踪
const playTimesFile = path.join(app.getPath('userData'), 'playtimes.json');
let playTimes = {};
let currentGameId = null;
let gameStartTime = null;

function loadPlayTimes() {
  try {
    if (fs.existsSync(playTimesFile)) {
      playTimes = JSON.parse(fs.readFileSync(playTimesFile, 'utf8'));
    }
  } catch (e) { playTimes = {}; }
}

function savePlayTimes() {
  try {
    fs.writeFileSync(playTimesFile, JSON.stringify(playTimes, null, 2), 'utf8');
  } catch (e) {}
}

function recordGameStart(gameId) {
  currentGameId = gameId;
  gameStartTime = Date.now();
}

function recordGameEnd() {
  if (!currentGameId || !gameStartTime) return;
  const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
  if (elapsed > 0) {
    playTimes[currentGameId] = (playTimes[currentGameId] || 0) + elapsed;
    savePlayTimes();
  }
  currentGameId = null;
  gameStartTime = null;
}

// 每30秒自动保存一次游玩时长（防止崩溃丢失）
function tickPlayTime() {
  if (!currentGameId || !gameStartTime) return;
  const now = Date.now();
  const elapsed = Math.floor((now - gameStartTime) / 1000);
  if (elapsed > 0) {
    playTimes[currentGameId] = (playTimes[currentGameId] || 0) + elapsed;
    savePlayTimes();
    gameStartTime = now; // 重置起点，避免重复累加
  }
}
setInterval(tickPlayTime, 30000);

loadPlayTimes();

// === 联机系统 ===
let mpWss = null;       // WebSocket 服务器（主机模式）
let mpClient = null;    // WebSocket 客户端（加入模式）
let mpClients = new Map(); // 客户端连接映射（主机模式）id -> { ws, name }
let mpNextId = 1;
let mpIsHost = false;
let mpMyPlayerId = null;   // 本机在联机中的 ID
let mpMyPlayerName = '';   // 本机玩家名
let mpLastGameStart = null; // 缓存game-start消息，供joiner页面恢复用

// === 互联网联机（中转服务器）===
const RELAY_SERVER = 'ws://81.70.199.45:18766';
const RELAY_HOST_TIMEOUT = 5000;
let relayWs = null;
let relayMode = false;
let relayRoomId = null;
let relayHostToken = null;  // 主机重连用 token
let relayPeers = [];  // 中继模式下的其他玩家

// === LAN Discovery (HTTP 扫描) ===
const DISCOVERY_PORT = 19876;
const DISCOVERY_INTERVAL = 1500;
const DISCOVERY_TIMEOUT = 10000;
const FIXED_PORT = 18765; // HTTP服务器固定端口，需在使用前声明
let discoverySocket = null;
let discoveryBroadcastTimer = null;
let discoveryListening = false;
let discoveredServers = new Map();
let discoveryCleanupTimer = null;

// 发送广播用的 socket（独立于监听 socket）
let broadcastSocket = null;

// HTTP 发现：主机注册游戏信息，客户端扫描局域网 IP
let hostedGameInfo = null; // { name, ip, port, game }

function discoveryStartBroadcasting(wsPort, hostName, gameName) {
  const localIP = getLocalIP();
  hostedGameInfo = { name: hostName, ip: localIP, port: wsPort, game: gameName };
  // 同时用 UDP 广播（如果网络允许）
  if (!broadcastSocket) {
    broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    broadcastSocket.on('error', () => {});
    const payload = Buffer.from(JSON.stringify({ type: 'game-center', name: hostName, ip: localIP, port: wsPort, game: gameName }));
    broadcastSocket.bind(0, () => {
      broadcastSocket.setBroadcast(true);
      broadcastSocket.send(payload, DISCOVERY_PORT, '255.255.255.255');
      discoveryBroadcastTimer = setInterval(() => {
        try { broadcastSocket.send(payload, DISCOVERY_PORT, '255.255.255.255'); } catch (e) {}
      }, DISCOVERY_INTERVAL);
    });
  }
}

function discoveryStopBroadcasting() {
  hostedGameInfo = null;
  if (discoveryBroadcastTimer) { clearInterval(discoveryBroadcastTimer); discoveryBroadcastTimer = null; }
  if (broadcastSocket) {
    try { broadcastSocket.close(); } catch (e) {}
    broadcastSocket = null;
  }
}

function discoveryStartListening() {
  if (discoveryListening) return;
  discoveryListening = true;
  discoveredServers.clear();

  // HTTP 扫描局域网
  const localIP = getLocalIP();
  const parts = localIP.split('.');
  if (parts.length === 4) {
    const subnet = parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
    // 扫描整个 /24 子网
    for (let i = 1; i <= 254; i++) {
      const targetIP = subnet + i;
      if (targetIP === localIP) continue;
      const url = 'http://' + targetIP + ':' + FIXED_PORT + '/mp-host-info';
      fetch(url, { signal: AbortSignal.timeout(800) })
        .then(r => r.json())
        .then(data => {
          if (data.name) {
            discoveredServers.set(data.ip + ':' + data.port, { ...data, lastSeen: Date.now() });
            discoverySendList();
          }
        })
        .catch(() => {});
    }
  }

  // 同时 UDP 监听（作为补充）
  if (!discoverySocket) {
    discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discoverySocket.on('error', () => {});
    discoverySocket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'game-center') {
          discoveredServers.set(data.ip + ':' + data.port, { ...data, lastSeen: Date.now() });
          discoverySendList();
        }
      } catch (e) {}
    });
    try {
      discoverySocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        try { discoverySocket.setBroadcast(true); } catch (e) {}
      });
    } catch (e) {}
  }

  // 定期清理过期条目并重新扫描（外层 setInterval 已是 5s，无需额外条件）
  discoveryCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, server] of discoveredServers) {
      if (now - server.lastSeen > DISCOVERY_TIMEOUT) discoveredServers.delete(key);
    }
    discoverySendList();
    const parts2 = localIP.split('.');
    if (parts2.length === 4) {
      const subnet2 = parts2[0] + '.' + parts2[1] + '.' + parts2[2] + '.';
      for (let i = 1; i <= 254; i++) {
        const targetIP = subnet2 + i;
        if (targetIP === localIP) continue;
        const url = 'http://' + targetIP + ':' + FIXED_PORT + '/mp-host-info';
        fetch(url, { signal: AbortSignal.timeout(800) })
          .then(r => r.json())
          .then(data => {
            if (data.name) {
              discoveredServers.set(data.ip + ':' + data.port, { ...data, lastSeen: Date.now() });
              discoverySendList();
            }
          })
          .catch(() => {});
      }
    }
  }, 5000);

  discoverySendList();
}

function discoverySendList() {
  if (win && !win.isDestroyed()) {
    const servers = Array.from(discoveredServers.values()).map(s => ({
      name: s.name, ip: s.ip, port: s.port, game: s.game
    }));
    win.webContents.send('mp-discover', servers);
  }
}

function discoveryStopListening() {
  discoveryListening = false;
  if (discoveryCleanupTimer) { clearInterval(discoveryCleanupTimer); discoveryCleanupTimer = null; }
  discoveredServers.clear();
  if (discoverySocket) {
    try { discoverySocket.close(); } catch (e) {}
    discoverySocket = null;
  }
}

function discoveryCleanup() {
  discoveryStopBroadcasting();
  discoveryStopListening();
}

function mpGetState() {
  const active = !!(mpWss || mpClient);
  return {
    active,
    isHost: mpIsHost,
    myId: mpMyPlayerId,
    myName: mpMyPlayerName,
    peers: active ? Array.from(mpClients.entries()).map(([id, c]) => ({ id, name: c.name })) : [],
    lastGameStart: mpLastGameStart || null
  };
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.')) {
          return net.address;
        }
      }
    }
  }
  return '127.0.0.1';
}

function mpHostGame(lobbyInfo) {
  return new Promise((resolve, reject) => {
    if (mpWss) { mpStop(); }
    mpIsHost = true;
    mpClients.clear();
    mpNextId = 1;
    mpMyPlayerId = 0;
    mpMyPlayerName = (lobbyInfo && lobbyInfo.name) || '玩家1';
    mpWss = new WebSocketServer({ port: 0 }, () => {
      const addr = mpWss.address();
      const ip = getLocalIP();
      // 自动添加防火墙规则
      tryAddFirewallRule(addr.port);
      discoveryStartBroadcasting(addr.port, mpMyPlayerName, lobbyInfo && lobbyInfo.gameName || '');
      resolve({ ip, port: addr.port });
    });
    mpWss.on('connection', (ws) => {
      const id = mpNextId++;
      let name = 'Player ' + id;
      mpClients.set(id, { ws, name });
      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'player-join') {
            name = data.name || name;
            mpClients.get(id).name = name;
            // 发送玩家 ID 给新客户端
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'your-id', id }));
              // 一次性发送完整玩家列表（包含主机和所有已连接客户端）
              const allPlayers = [{ id: 0, name: mpMyPlayerName }];
              for (const [pid, pclient] of mpClients) {
                if (pid !== id) allPlayers.push({ id: pid, name: pclient.name });
              }
              ws.send(JSON.stringify({ type: 'player-list', players: allPlayers }));
              // 如果游戏已经开始，补发 game-start
              if (mpLastGameStart && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ...mpLastGameStart }));
              }
            }
            // 通知 renderer
            if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'player-join', id, name });
            // 广播给其他客户端
            mpBroadcast({ type: 'player-join', id, name }, id);
          } else {
            // 转发到 renderer，附带来源 id（游戏统一用 data.id 识别发送者）
            if (win && !win.isDestroyed()) win.webContents.send('mp-message', { ...data, id: id });
            // 转发给其他客户端（让非主机玩家也能看到彼此的状态/射击等）
            mpBroadcast({ ...data, id: id }, id);
          }
        } catch (e) {}
      });
      ws.on('close', () => {
        mpClients.delete(id);
        mpBroadcast({ type: 'player-leave', id });
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'player-leave', id });
      });
    });
    mpWss.on('error', (err) => reject(err));
  });
}

function mpJoinGame(hostIp, hostPort, playerName) {
  return new Promise((resolve, reject) => {
    if (mpClient) { mpStop(); }
    mpIsHost = false;
    const url = `ws://${hostIp}:${hostPort}`;
    mpClient = new WebSocket(url);
    let settled = false;
    mpClient.on('open', () => {
      mpClient.send(JSON.stringify({ type: 'player-join', name: playerName }));
    });
    mpClient.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', data);
        // 跟踪已知玩家（用于 mpGetState 恢复联机状态）
        if (data.type === 'player-list') {
          // 一次性接收完整玩家列表
          for (const p of data.players) {
            mpClients.set(p.id, { name: p.name });
          }
        } else if (data.type === 'player-join') {
          mpClients.set(data.id, { name: data.name });
        } else if (data.type === 'player-leave') {
          mpClients.delete(data.id);
        } else if (data.type === 'game-start') {
          // 缓存game-start，joiner页面加载后可恢复
          mpLastGameStart = data;
        }
        // 等服务器分配 ID 后才算真正加入成功
        if (!settled && data.type === 'your-id') {
          settled = true;
          mpMyPlayerId = data.id;
          mpMyPlayerName = playerName;
          resolve({ connected: true, id: data.id });
        }
      } catch (e) {}
    });
    mpClient.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('连接被关闭，请检查地址是否正确'));
      }
      if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'disconnected' });
      mpClient = null;
    });
    mpClient.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error('无法连接到 ' + hostIp + ':' + hostPort));
      }
    });
    // 超时：5秒没收到 your-id 则失败
    setTimeout(() => {
      if (!settled) {
        settled = true;
        mpStop();
        reject(new Error('连接超时，请检查地址和防火墙'));
      }
    }, 5000);
  });
}

function mpBroadcast(data, excludeId) {
  if (!mpWss) return;
  const msg = JSON.stringify(data);
  for (const [id, client] of mpClients) {
    if (id !== excludeId && client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(msg);
    }
  }
}

function mpStop() {
  if (mpWss) {
    for (const [, client] of mpClients) {
      if (client.ws && client.ws.readyState === WebSocket.OPEN) client.ws.close();
    }
    mpClients.clear();
    mpWss.close();
    mpWss = null;
  }
  if (mpClient) {
    if (mpClient.readyState === WebSocket.OPEN) mpClient.close();
    mpClient = null;
  }
  mpClients.clear(); // 清除客户端追踪的玩家列表，避免重连后残留旧数据
  mpIsHost = false;
  mpLastGameStart = null;
  discoveryCleanup();
}

// === 互联网中转联机 ===
function relayConnect() {
  return new Promise((resolve, reject) => {
    relayWs = new WebSocket(RELAY_SERVER);
    relayWs.on('open', () => resolve(relayWs));
    relayWs.on('error', () => reject(new Error('无法连接中转服务器')));
    relayWs.on('close', () => {
      relayWs = null;
      relayMode = false;
      relayPeers = [];
      // 保留 mpMyPlayerId/mpMyPlayerName 让 UI 知道刚断开，但下次 host/join 会重置
      if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'disconnected' });
    });
    relayWs.on('message', (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch(e) { return; }
      if (data.type === 'hosted') {
        relayRoomId = data.roomId;
        relayHostToken = data.token || null;
        mpMyPlayerId = 0;
      } else if (data.type === 'joined') {
        mpMyPlayerId = data.playerId;
        relayRoomId = data.roomId;
        if (data.players) {
          relayPeers = data.players.filter(p => p.id !== mpMyPlayerId);
        }
      } else if (data.type === 'player-join') {
        if (data.id !== mpMyPlayerId && !relayPeers.some(p => p.id === data.id)) {
          relayPeers.push({ id: data.id, name: data.name });
        }
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', data);
      } else if (data.type === 'player-leave') {
        relayPeers = relayPeers.filter(p => p.id !== data.id);
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', data);
      } else if (data.type === 'player-list') {
        if (data.players) {
          relayPeers = data.players.filter(p => p.id !== mpMyPlayerId);
        }
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', data);
      } else if (data.type === 'host-disconnected') {
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'disconnected' });
        relayMode = false;
        relayPeers = [];
      } else if (data.type === 'host-paused') {
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'host-paused' });
      } else if (data.type === 'host-reconnected') {
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', { type: 'host-reconnected' });
      } else {
        // 转发所有其他消息到 renderer
        if (win && !win.isDestroyed()) win.webContents.send('mp-message', data);
      }
    });
  });
}

function relayHost(lobbyInfo) {
  return relayConnect().then(ws => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const handler = (raw) => {
        let data; try { data = JSON.parse(raw.toString()); } catch(e) { return; }
        if (data.type === 'hosted' && !settled) {
          settled = true;
          ws.removeEventListener('message', handler);
          relayMode = true;
          mpIsHost = true;
          mpMyPlayerName = (lobbyInfo && lobbyInfo.name) || '主机';
          resolve({ roomId: data.roomId, ip: '81.70.199.45', port: 18766 });
        } else if (data.type === 'error' && !settled) {
          settled = true;
          ws.removeEventListener('message', handler);
          reject(new Error(data.msg));
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ type: 'host', name: (lobbyInfo && lobbyInfo.name) || '主机', gameName: (lobbyInfo && lobbyInfo.gameName) || '' }));
      setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.removeEventListener('message', handler);
          reject(new Error('创建房间超时，请检查网络'));
        }
      }, RELAY_HOST_TIMEOUT);
    });
  });
}

function relayJoin(roomId, playerName) {
  return relayConnect().then(ws => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const handler = (raw) => {
        let data; try { data = JSON.parse(raw.toString()); } catch(e) { return; }
        if (data.type === 'joined' && !settled) {
          settled = true;
          ws.removeEventListener('message', handler);
          relayMode = true;
          mpMyPlayerName = playerName || '玩家';
          resolve({ connected: true, id: data.playerId });
        } else if (data.type === 'error' && !settled) {
          settled = true;
          ws.removeEventListener('message', handler);
          reject(new Error(data.msg));
        }
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ type: 'join', roomId: String(roomId), name: playerName || '玩家' }));
      setTimeout(() => { if (!settled) { settled = true; reject(new Error('连接超时')); } }, 5000);
    });
  });
}

function relaySend(data) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;
  relayWs.send(JSON.stringify({ type: 'relay', data }));
}

function relayStop() {
  if (relayWs) { relayWs.close(); relayWs = null; }
  relayMode = false;
  relayRoomId = null;
  relayHostToken = null;
  relayPeers = [];
}

// 防火墙：启动时静默添加端口规则（不弹窗）
function addFirewallPortRule() {
  if (process.platform !== 'win32') return;
  const ruleName = 'GameCenter_LAN_HTTP';
  const cmd = `netsh advfirewall firewall delete rule name="${ruleName}" >nul 2>&1 & netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${FIXED_PORT} >nul 2>&1`;
  exec(cmd, { windowsHide: true });
}

// 防火墙：自动添加入站规则（仅 Windows 需要，macOS 默认允许）
let firewallRuleAdded = false;
function tryAddFirewallRule(port) {
  if (firewallRuleAdded) return;
  if (process.platform !== 'win32') {
    firewallRuleAdded = true;
    return;
  }
  const exePath = process.execPath;
  const ruleName = 'GameCenter_Multiplayer';
  // 先删除旧规则（忽略错误），再添加新规则（TCP + UDP）
  const cmd = `netsh advfirewall firewall delete rule name="${ruleName}" >nul 2>&1 & netsh advfirewall firewall delete rule name="${ruleName}_UDP" >nul 2>&1 & netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${exePath}" enable=yes protocol=TCP & netsh advfirewall firewall add rule name="${ruleName}_UDP" dir=in action=allow program="${exePath}" enable=yes protocol=UDP`;
  exec(cmd, { windowsHide: true }, (err) => {
    if (!err) {
      firewallRuleAdded = true;
      console.log('防火墙规则已添加:', ruleName);
    } else {
      // 没有管理员权限，尝试仅开放端口
      const portCmd = `netsh advfirewall firewall add rule name="${ruleName}_port" dir=in action=allow protocol=TCP localport=${port} & netsh advfirewall firewall add rule name="${ruleName}_port_UDP" dir=in action=allow protocol=UDP localport=${DISCOVERY_PORT}`;
      exec(portCmd, { windowsHide: true }, (err2) => {
        if (!err2) {
          firewallRuleAdded = true;
          console.log('防火墙端口规则已添加:', port);
        } else {
          console.log('防火墙规则添加失败（需要管理员权限）');
        }
      });
    }
  });
}

// 本地HTTP服务器 - 解决file://协议安全限制
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  // LAN发现：返回本机主机信息
  if (req.url.split('?')[0] === '/mp-host-info') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(hostedGameInfo ? JSON.stringify(hostedGameInfo) : '{}');
    return;
  }
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/launcher.html';
  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; worker-src 'self' blob:",
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: '游戏中心',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadURL('http://localhost:' + port + '/launcher.html');
  win.setMenu(null);
  // F11全屏，F12开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11' && input.type === 'keyDown') {
      win.setFullScreen(!win.isFullScreen());
    }
    if (input.key === 'F12' && input.type === 'keyDown') {
      win.webContents.toggleDevTools();
    }
    // F2返回启动器
    if (input.key === 'F2' && input.type === 'keyDown') {
      const url = win.webContents.getURL();
      if (!url.includes('launcher.html')) {
        firstLoad = false;
        triggerAutoSave().then(() => {
          win.loadURL('http://localhost:' + port + '/launcher.html');
          purgeAfterNavigation();
        });
      }
    }
  });

  // 窗口关闭前自动存档
  let canClose = false;
  win.on('close', (e) => {
    if (canClose) return;
    e.preventDefault();
    // 同步保存游玩时长（确保不丢失）
    try { recordGameEnd(); } catch (e) {}
    triggerAutoSave().then(() => {
      canClose = true;
      win.close();
    }).catch(() => {
      canClose = true;
      win.close();
    });
  });
}

// IPC: 切换全屏
ipcMain.on('toggle-fullscreen', () => {
  win.setFullScreen(!win.isFullScreen());
});

// IPC: 启动游戏
ipcMain.on('launch-game', async (event, gamePath) => {
  await triggerAutoSave();
  const segs = String(gamePath || '').split('/');
  if (segs.length >= 2 && segs[1]) recordGameStart(segs[1]);
  // 中继模式下广播 game-start 给其他玩家
  if (relayMode && relayWs && relayWs.readyState === WebSocket.OPEN) {
    const pvp = gamePath.includes('pvp=1');
    relayWs.send(JSON.stringify({ type: 'relay', data: { type: 'game-start', gamePath: gamePath, pvp: pvp } }));
  }
  win.loadURL('http://localhost:' + port + '/' + gamePath);
  purgeAfterNavigation();
});

// IPC: 返回启动器
ipcMain.on('back-to-launcher', async () => {
  firstLoad = false;
  await triggerAutoSave();
  win.loadURL('http://localhost:' + port + '/launcher.html');
  purgeAfterNavigation();
});

// IPC: 是否首次加载
ipcMain.on('is-first-load', (event) => {
  event.returnValue = firstLoad;
  firstLoad = false;
});

// IPC: 获取游玩时长
ipcMain.on('get-play-times', (event) => {
  event.returnValue = playTimes;
});

// IPC: 读取本地文件（用于游戏加载资源）
ipcMain.on('read-file', (event, relativePath) => {
  try {
    const fullPath = path.join(__dirname, relativePath);
    event.returnValue = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    event.returnValue = null;
  }
});

// IPC: 重置鼠标到窗口中心（用于FPS游戏无pointer lock时）
ipcMain.on('reset-cursor', () => {
  if (win) {
    const bounds = win.getBounds();
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.floor(bounds.width / 2),
      y: Math.floor(bounds.height / 2)
    });
  }
});

// IPC: 联机 - 主机
ipcMain.handle('mp-host', async (event, lobbyInfo) => {
  try {
    // 切换模式时先彻底清理旧会话，避免 LAN/互联网模式残留
    if (relayMode) relayStop();
    mpStop();
    if (lobbyInfo && lobbyInfo.mode === 'internet') {
      const result = await relayHost(lobbyInfo);
      return result;
    }
    const result = await mpHostGame(lobbyInfo);
    return result;
  } catch (e) { return { error: e.message }; }
});

// IPC: 联机 - 加入
ipcMain.handle('mp-join', async (event, ip, port, name) => {
  try {
    if (relayMode) relayStop();
    mpStop();
    // 4-6 位数字房间号 → 互联网中转模式
    if (ip && /^[0-9]{4,6}$/.test(String(ip))) {
      const result = await relayJoin(ip, name);
      return result;
    }
    const result = await mpJoinGame(ip, port, name);
    return result;
  } catch (e) { return { error: e.message }; }
});

// IPC: 联机 - 发送消息
ipcMain.on('mp-send', (event, data) => {
  if (relayMode) {
    // 互联网模式：通过中转服务器转发
    relaySend(data);
  } else if (mpIsHost) {
    // 局域网主机模式：广播给所有客户端
    const msg = JSON.stringify({ ...data, id: mpMyPlayerId });
    for (const [, client] of mpClients) {
      if (client.ws && client.ws.readyState === WebSocket.OPEN) client.ws.send(msg);
    }
    if (data.type === 'game-start') {
      mpLastGameStart = { ...data, id: mpMyPlayerId };
    }
  } else if (mpClient && mpClient.readyState === WebSocket.OPEN) {
    mpClient.send(JSON.stringify(data));
  }
});

// IPC: 联机 - 停止
ipcMain.handle('mp-stop', async () => {
  if (relayMode) relayStop(); else mpStop();
  return { stopped: true };
});

// IPC: 互联网联机 - 创建房间
ipcMain.handle('mp-relay-host', async (event, lobbyInfo) => {
  try {
    const result = await relayHost(lobbyInfo);
    return result;
  } catch (e) { return { error: e.message }; }
});

// IPC: 互联网联机 - 加入房间
ipcMain.handle('mp-relay-join', async (event, roomId, name) => {
  try {
    const result = await relayJoin(roomId, name);
    return result;
  } catch (e) { return { error: e.message }; }
});

// IPC: 互联网联机 - 发送消息
ipcMain.on('mp-relay-send', (event, data) => {
  if (relayMode) relaySend(data);
});

// IPC: 互联网联机 - 获取房间列表
ipcMain.handle('mp-relay-rooms', async () => {
  try {
    const http = require('http');
    return new Promise((resolve) => {
      http.get('http://81.70.199.45:18766/rooms', (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve([]); } });
      }).on('error', () => resolve([]));
    });
  } catch (e) { return []; }
});

// IPC: 联机 - 获取本机IP
ipcMain.handle('mp-get-ip', async () => {
  return getLocalIP();
});

// IPC: 联机 - 获取当前联机状态（游戏页面加载时恢复）
ipcMain.handle('mp-get-state', async () => {
  if (relayMode) {
    return {
      active: true,
      isHost: mpIsHost,
      myId: mpMyPlayerId,
      myName: mpMyPlayerName,
      peers: relayPeers,
      lastGameStart: mpLastGameStart
    };
  }
  return mpGetState();
});

// IPC: LAN发现 - 开始扫描
ipcMain.handle('mp-discover-start', async () => {
  discoveryStartListening();
  return { ok: true };
});

// IPC: LAN发现 - 停止扫描
ipcMain.handle('mp-discover-stop', async () => {
  discoveryStopListening();
  return { ok: true };
});

// IPC: 联机 - 手动添加防火墙规则
ipcMain.handle('mp-add-firewall', async () => {
  // macOS 不需要手动配置防火墙
  if (process.platform === 'darwin') {
    return { ok: true, msg: 'macOS 不需要配置防火墙，默认允许入站连接' };
  }
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ ok: false, msg: '不支持的平台' }); return; }
    const exePath = process.execPath;
    const ruleName = 'GameCenter_Multiplayer';
    const cmd = `netsh advfirewall firewall delete rule name="${ruleName}" >nul 2>&1 & netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow program="${exePath}" enable=yes protocol=TCP`;
    exec(cmd, { windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        firewallRuleAdded = true;
        resolve({ ok: true, msg: '防火墙规则已添加' });
      } else {
        resolve({ ok: false, msg: '需要管理员权限。请右键以管理员身份运行游戏中心。' });
      }
    });
  });
});

// 先启动HTTP服务器，再创建窗口（固定端口保证 localStorage 存档不丢失）
server.listen(FIXED_PORT, '0.0.0.0', () => {
  port = FIXED_PORT;
  console.log('本地服务器启动在端口', port, '(绑定 0.0.0.0)');
  app.whenReady().then(() => {
    createWindow();
    // 启动时添加防火墙规则，确保端口可达
    addFirewallPortRule();
  });
}).on('error', () => {
  // 端口被占用则尝试备选端口
  server.listen(0, '0.0.0.0', () => {
    port = server.address().port;
    console.log('本地服务器启动在端口', port, '(绑定 0.0.0.0)');
    app.whenReady().then(() => {
      createWindow();
      addFirewallPortRule();
    });
  });
});
app.on('window-all-closed', () => {
  try { recordGameEnd(); } catch (e) {}
  server.close();
  app.quit();
});

// app退出前保存
app.on('before-quit', () => {
  try { recordGameEnd(); } catch (e) {}
});

// 进程信号处理（Ctrl+C、终端关闭等）
process.on('SIGTERM', () => {
  try { recordGameEnd(); } catch (e) {}
  app.quit();
});
process.on('SIGINT', () => {
  try { recordGameEnd(); } catch (e) {}
  app.quit();
});
