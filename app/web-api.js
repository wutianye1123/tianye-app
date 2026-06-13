// web-api.js — 浏览器兼容层（iframe 方案，WebSocket 不断）
(function() {
  if (window.electronAPI) return;

  // 游玩时长
  function loadPlayTimes() {
    try { return JSON.parse(localStorage.getItem('playTimes') || '{}'); } catch(e) { return {}; }
  }
  function savePlayTimes(d) {
    try { localStorage.setItem('playTimes', JSON.stringify(d)); } catch(e) {}
  }
  var playTimes = loadPlayTimes();
  var currentGameId = null;
  var gameStartTime = null;
  function recordGameStart(id) { currentGameId = id; gameStartTime = Date.now(); }
  function recordGameEnd() {
    if (!currentGameId || !gameStartTime) return;
    var el = Math.floor((Date.now() - gameStartTime) / 1000);
    if (el > 0) { playTimes[currentGameId] = (playTimes[currentGameId] || 0) + el; savePlayTimes(playTimes); }
    currentGameId = null; gameStartTime = null;
  }
  window.addEventListener('beforeunload', recordGameEnd);

  // === 联机系统 ===
  var RELAY_HOST_TIMEOUT = 5000;
  var relayWs = null;
  var mpState = 'idle';
  var mpMyId = null;
  var mpMyName = '';
  var mpRoomId = null;
  var mpHostToken = null;  // 主机重连 token
  var mpIsHost = false;
  var mpMessageCallback = null;
  var pendingSends = [];
  var mpPeers = [];  // 已知的其他玩家

  function clearPendingSends() { pendingSends = []; }

  function connectRelay() {
    return new Promise(function(resolve, reject) {
      if (relayWs && relayWs.readyState === 1) { resolve(relayWs); return; }
      relayWs = new WebSocket('ws://81.70.199.45:18766');
      relayWs.onopen = function() {
        resolve(relayWs);
        // 仅在仍处于联机状态时 flush 队列，避免跨房间污染
        if (mpState !== 'idle') {
          while (pendingSends.length > 0) {
            try { relayWs.send(JSON.stringify({ type: 'relay', data: pendingSends.shift() })); } catch(e) {}
          }
        } else {
          clearPendingSends();
        }
      };
      relayWs.onerror = function() { reject(new Error('无法连接中转服务器')); };
      relayWs.onclose = function() {
        relayWs = null;
        clearPendingSends();
        if (mpState !== 'idle' && mpMessageCallback) mpMessageCallback({ type: 'disconnected' });
      };
      relayWs.onmessage = function(e) {
        var data;
        try { data = JSON.parse(e.data); } catch(err) { return; }
        if (data.type === 'hosted') {
          mpMyId = data.playerId; mpRoomId = data.roomId;
          mpHostToken = data.token || null;
        } else if (data.type === 'joined') {
          mpMyId = data.playerId; mpRoomId = data.roomId;
          // 收到玩家列表
          if (data.players) {
            mpPeers = data.players.filter(function(p) { return p.id !== mpMyId; });
          }
        } else if (data.type === 'player-join') {
          if (data.id !== mpMyId && !mpPeers.some(function(p) { return p.id === data.id; })) {
            mpPeers.push({ id: data.id, name: data.name });
          }
          if (mpMessageCallback) mpMessageCallback(data);
        } else if (data.type === 'player-leave') {
          mpPeers = mpPeers.filter(function(p) { return p.id !== data.id; });
          if (mpMessageCallback) mpMessageCallback(data);
        } else if (data.type === 'player-list') {
          if (data.players) {
            mpPeers = data.players.filter(function(p) { return p.id !== mpMyId; });
          }
          if (mpMessageCallback) mpMessageCallback(data);
        } else if (data.type === 'host-disconnected') {
          mpState = 'idle'; mpHostToken = null;
          mpPeers = [];
          if (mpMessageCallback) mpMessageCallback({ type: 'disconnected' });
        } else if (data.type === 'host-paused' || data.type === 'host-reconnected') {
          if (mpMessageCallback) mpMessageCallback(data);
        } else {
          // 转发到 iframe 或 callback
          if (mpMessageCallback) mpMessageCallback(data);
          broadcastToIframe(data);
        }
      };
    });
  }

  // === iframe 管理 ===
  var gameIframe = null;
  var isLauncher = location.pathname.includes('launcher.html') || location.pathname === '/';

  // 向 iframe 广播消息
  function broadcastToIframe(data) {
    if (!gameIframe || !gameIframe.contentWindow) return;
    gameIframe.contentWindow.postMessage({ type: 'mp-message', data: data }, '*');
  }

  // 监听 iframe 发来的消息
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'mp-send') {
      if (relayWs && relayWs.readyState === 1) {
        relayWs.send(JSON.stringify({ type: 'relay', data: e.data.data }));
      } else {
        pendingSends.push(e.data.data);
      }
    } else if (e.data.type === 'mp-back') {
      window.electronAPI.backToLauncher();
    } else if (e.data.type === 'mp-get-state') {
      // 游戏页面请求当前联机状态
      if (gameIframe && gameIframe.contentWindow) {
        gameIframe.contentWindow.postMessage({
          type: 'mp-state-result',
          state: {
            active: mpState !== 'idle',
            isHost: mpIsHost,
            myId: mpMyId,
            myName: mpMyName,
            roomId: mpRoomId,
            peers: mpPeers,
            lastGameStart: null
          }
        }, '*');
      }
    } else if (e.data.type === 'mp-stop') {
      window.electronAPI.mpStop();
    } else if (e.data.type === 'mp-launch') {
      window.electronAPI.launchGame(e.data.gamePath);
    }
  });

  // launcher 页面的 API
  window.electronAPI = {
    launchGame: function(gamePath) {
      recordGameEnd();
      var parts = gamePath.split('/');
      if (parts.length >= 2) recordGameStart(parts[1]);

      // 广播 game-start 给其他玩家（带 PvP 设置）
      if (relayWs && relayWs.readyState === 1 && mpRoomId) {
        var pvp = gamePath.indexOf('pvp=1') >= 0;
        relayWs.send(JSON.stringify({ type: 'relay', data: { type: 'game-start', gamePath: gamePath, pvp: pvp } }));
      }

      // 用 iframe 加载游戏，不断开 WebSocket
      if (!gameIframe) {
        gameIframe = document.createElement('iframe');
        gameIframe.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;z-index:99999;';
        document.body.appendChild(gameIframe);
      }
      gameIframe.src = gamePath;
      gameIframe.style.display = 'block';
    },
    backToLauncher: function() {
      recordGameEnd();
      if (gameIframe) {
        gameIframe.style.display = 'none';
        gameIframe.src = 'about:blank';
      }
    },
    isFirstLoad: function() {
      var v = sessionStorage.getItem('firstLoad');
      if (v === null) { sessionStorage.setItem('firstLoad', '0'); return true; }
      return false;
    },
    getPlayTimes: function() { return loadPlayTimes(); },
    readFile: function() { return null; },
    resetCursor: function() {},
    toggleFullScreen: function() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },

    mpHost: function(lobbyInfo) {
      return connectRelay().then(function(ws) {
        return new Promise(function(resolve, reject) {
          var settled = false;
          var handler = function(e) {
            var d; try { d = JSON.parse(e.data); } catch(err) { return; }
            if (d.type === 'hosted' && !settled) {
              settled = true;
              ws.removeEventListener('message', handler);
              mpState = 'hosting'; mpIsHost = true;
              mpMyName = (lobbyInfo && lobbyInfo.name) || '主机';
              resolve({ ip: location.hostname, port: 18766, roomId: d.roomId });
            } else if (d.type === 'error' && !settled) {
              settled = true;
              ws.removeEventListener('message', handler);
              reject(new Error(d.msg));
            }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ type: 'host', name: (lobbyInfo && lobbyInfo.name) || '主机', gameName: (lobbyInfo && lobbyInfo.gameName) || '' }));
          setTimeout(function() {
            if (!settled) {
              settled = true;
              ws.removeEventListener('message', handler);
              reject(new Error('创建房间超时，请检查网络'));
            }
          }, RELAY_HOST_TIMEOUT);
        });
      });
    },

    mpJoin: function(ip, port, name) {
      var roomId = String(ip).trim();
      return connectRelay().then(function(ws) {
        return new Promise(function(resolve, reject) {
          var settled = false;
          var handler = function(e) {
            var d; try { d = JSON.parse(e.data); } catch(err) { return; }
            if (d.type === 'joined' && !settled) {
              settled = true; ws.removeEventListener('message', handler);
              mpState = 'joined'; mpIsHost = false; mpMyName = name || '玩家';
              resolve({ connected: true, id: d.playerId });
            } else if (d.type === 'error' && !settled) {
              settled = true; ws.removeEventListener('message', handler);
              reject(new Error(d.msg));
            }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({ type: 'join', roomId: roomId, name: name || '玩家' }));
          setTimeout(function() { if (!settled) { settled = true; reject(new Error('连接超时')); } }, 5000);
        });
      });
    },

    mpSend: function(data) {
      if (relayWs && relayWs.readyState === 1) {
        relayWs.send(JSON.stringify({ type: 'relay', data: data }));
      } else {
        pendingSends.push(data);
      }
    },

    mpStop: function() {
      if (relayWs) { relayWs.close(); relayWs = null; }
      mpState = 'idle'; mpMyId = null; mpRoomId = null;
      mpHostToken = null; mpIsHost = false;
      clearPendingSends();
      mpPeers = [];
      return Promise.resolve({ stopped: true });
    },

    mpGetIP: function() { return Promise.resolve(location.hostname); },

    mpGetState: function() {
      return Promise.resolve({
        active: mpState !== 'idle',
        isHost: mpIsHost,
        myId: mpMyId,
        myName: mpMyName,
        roomId: mpRoomId,
        peers: mpPeers,
        lastGameStart: null
      });
    },

    mpAddFirewall: function() { return Promise.resolve({ ok: true }); },

    onMpMessage: function(callback) { mpMessageCallback = callback; }
  };

  // iframe 内的游戏页面：代理 electronAPI（只在游戏页面生效，不在 launcher）
  if (!isLauncher) {
    // 游戏页面（在 iframe 内）
    window.electronAPI = {
      launchGame: function(gamePath) { window.parent.postMessage({ type: 'mp-launch', gamePath: gamePath }, '*'); },
      backToLauncher: function() { window.parent.postMessage({ type: 'mp-back' }, '*'); },
      isFirstLoad: function() { return false; },
      getPlayTimes: function() {
        try { return JSON.parse(localStorage.getItem('playTimes') || '{}'); } catch(e) { return {}; }
      },
      readFile: function() { return null; },
      resetCursor: function() {},
      toggleFullScreen: function() {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen();
      },
      mpHost: function() { return Promise.resolve({ error: '请从游戏中心创建房间' }); },
      mpJoin: function() { return Promise.resolve({ error: '请从游戏中心加入房间' }); },
      mpSend: function(data) { window.parent.postMessage({ type: 'mp-send', data: data }, '*'); },
      mpStop: function() { window.parent.postMessage({ type: 'mp-stop' }, '*'); return Promise.resolve({ stopped: true }); },
      mpGetIP: function() { return Promise.resolve(location.hostname); },
      mpGetState: function() {
        return new Promise(function(resolve) {
          window.parent.postMessage({ type: 'mp-get-state' }, '*');
          var handler = function(e) {
            if (e.data && e.data.type === 'mp-state-result') {
              window.removeEventListener('message', handler);
              resolve(e.data.state);
            }
          };
          window.addEventListener('message', handler);
          setTimeout(function() {
            window.removeEventListener('message', handler);
            resolve({ active: false });
          }, 1000);
        });
      },
      mpAddFirewall: function() { return Promise.resolve({ ok: true }); },
      onMpMessage: function(callback) {
        window.removeEventListener('message', window._mpProxyHandler || function(){});
        window._mpProxyHandler = function(e) {
          if (e.data && e.data.type === 'mp-message') callback(e.data.data);
        };
        window.addEventListener('message', window._mpProxyHandler);
      }
    };

    // F2 返回
    document.addEventListener('keydown', function(e) {
      if (e.key === 'F2') { e.preventDefault(); window.parent.postMessage({ type: 'mp-back' }, '*'); }
    });
  }
})();
