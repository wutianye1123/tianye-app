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
  // HTTPS 页面必须用 wss（否则 Mixed Content 被浏览器拦截）；
  // HTTP / file:// / Electron 内部用直连 IP。
  var RELAY_WS_URL = (function() {
    if (location.protocol === 'https:') {
      // 走 nginx 反代 wss://<host>/ws → ws://127.0.0.1:18766
      return 'wss://' + location.host + '/ws';
    }
    return 'ws://81.70.199.45:18766';
  })();
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
  var relayIntentionalClose = false;  // mpStop 主动关闭，不触发自动重连
  var relayReconnectAttempts = 0;
  var RELAY_MAX_RECONNECT = 4;        // 服务器主机重连窗口 30s，最多重试几次

  // === 好友 / 身份（网页版用 localStorage 持久化）===
  function loadFrProfile() {
    try { return JSON.parse(localStorage.getItem('gc_profile') || 'null'); } catch(e) { return null; }
  }
  function saveFrProfile(p) {
    try { localStorage.setItem('gc_profile', JSON.stringify(p)); } catch(e) {}
  }
  var frProfile = loadFrProfile();
  var frMessageCallback = null;

  function clearPendingSends() { pendingSends = []; }

  var connectRelayPromise = null;
  function connectRelay() {
    // 复用已开连接；并发调用共享同一个"进行中"的连接，避免创建多个 WebSocket 导致状态错乱
    if (relayWs && relayWs.readyState === 1) return Promise.resolve(relayWs);
    if (connectRelayPromise) return connectRelayPromise;
    connectRelayPromise = new Promise(function(resolve, reject) {
      relayWs = new WebSocket(RELAY_WS_URL);
      relayWs.onopen = function() {
        connectRelayPromise = null;
        resolve(relayWs);
        // 仅在仍处于联机状态时 flush 队列，避免跨房间污染
        if (mpState !== 'idle') {
          while (pendingSends.length > 0) {
            try { relayWs.send(JSON.stringify({ type: 'relay', data: pendingSends.shift() })); } catch(e) {}
          }
        } else {
          clearPendingSends();
        }
        // 免密重连：仅当本地已有 code（之前注册/登录过）才发身份；否则等用户注册/登录
        if (frProfile && frProfile.code) {
          try { relayWs.send(JSON.stringify({ type: 'identity-register', code: frProfile.code, name: frProfile.name })); } catch(e) {}
        }
        // 断线重连后重新加入房间（joiner 用普通 join；host 带 token 抢回）
        if (mpRoomId && !mpIsHost) {
          try { relayWs.send(JSON.stringify({ type: 'join', roomId: mpRoomId, name: mpMyName })); } catch(e) {}
        }
        if (mpRoomId && mpIsHost && mpHostToken) {
          try { relayWs.send(JSON.stringify({ type: 'join', roomId: mpRoomId, token: mpHostToken, name: mpMyName })); } catch(e) {}
        }
      };
      relayWs.onerror = function() { connectRelayPromise = null; reject(new Error('无法连接中转服务器')); };
      relayWs.onclose = function() {
        // 先捕获重连身份（在清空状态之前）
        var canReclaim = !relayIntentionalClose && mpState === 'hosting' && mpHostToken && mpRoomId;
        var token = mpHostToken, roomId = mpRoomId, name = mpMyName;
        var intentional = relayIntentionalClose;
        relayWs = null;
        relayIntentionalClose = false;
        clearPendingSends();

        // 主机意外断线：在服务器的 30s 窗口内用 token 抢回主机身份
        if (canReclaim && relayReconnectAttempts < RELAY_MAX_RECONNECT) {
          relayReconnectAttempts++;
          var delay = Math.min(1000 * relayReconnectAttempts, 4000);
          setTimeout(function() { relayReclaimHost(roomId, token, name); }, delay);
          return;  // 重连中，暂不通知断开
        }

        // 真正断开：不清 mpState（保留联机意图），发 disconnected + 状态灯
        relayReconnectAttempts = 0;
        if (mpState !== 'idle' && mpMessageCallback) mpMessageCallback({ type: 'disconnected' });
        if (frMessageCallback) frMessageCallback({ type: 'relay-status', online: false });
      };
      relayWs.onmessage = function(e) {
        var data;
        try { data = JSON.parse(e.data); } catch(err) { return; }

        // 好友/身份/presence 事件：路由到 frMessageCallback，不进 mp/iframe 流程
        if (data.type === 'identity-registered') {
          if (data.code && (!frProfile || frProfile.code !== data.code)) {
            frProfile = frProfile || {};
            frProfile.code = data.code;
            saveFrProfile(frProfile);
          }
          if (frMessageCallback) frMessageCallback(data);
          return;
        }
        if (data.type === 'identity-rejected') {
          if (frMessageCallback) frMessageCallback(data);
          return;
        }
        if (data.type === 'friend-online' || data.type === 'friend-offline' ||
            data.type === 'friend-name-change' || data.type === 'incoming-request' ||
            data.type === 'request-accepted' || data.type === 'friend-added' ||
            data.type === 'friend-removed' || data.type === 'incoming-invite' ||
            data.type === 'friends-presence-snapshot' || data.type === 'friend-request-result' ||
            data.type === 'friend-rejected-result' || data.type === 'friend-removed-result' ||
            data.type === 'invite-result' || data.type === 'name-updated' || data.type === 'leave-room-ok' || data.type === 'account-deleted' || data.type === 'auth-error') {
          if (frMessageCallback) frMessageCallback(data);
          return;
        }

        if (data.type === 'hosted') {
          mpMyId = data.playerId; mpRoomId = data.roomId;
          mpHostToken = data.token || null;
          mpState = 'hosting'; mpIsHost = true;
          relayReconnectAttempts = 0;
        } else if (data.type === 'joined') {
          mpMyId = data.playerId; mpRoomId = data.roomId;
          relayReconnectAttempts = 0;
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
          if (mpMessageCallback) mpMessageCallback(data);
        }
        // 关键：所有联机相关消息都要转发到 iframe 内的游戏页面，
        // 否则游戏页面收不到 player-join / your-id / player-list，
        // 进入游戏后看不到其他玩家。
        broadcastToIframe(data);
      };
    });
    return connectRelayPromise;
  }

  // 主机意外断线后，用 token 抢回主机身份（服务器保留 30s 重连窗口）
  function relayReclaimHost(roomId, token, name) {
    connectRelay().then(function(ws) {
      if (relayWs === ws) {
        ws.send(JSON.stringify({ type: 'join', roomId: roomId, token: token, name: name }));
      }
    }).catch(function() {
      // 连接本身失败：connectRelay 的 onclose 会继续驱动重连或放弃
    });
  }

  // === 好友：连接 / 收发辅助 ===
  function ensureRelayConnected() {
    if (relayWs && relayWs.readyState === 1) return Promise.resolve(relayWs);
    return connectRelay().catch(function() { return null; });
  }
  function frSend(msg) {
    ensureRelayConnected().then(function(ws) {
      if (ws && ws.readyState === 1) try { ws.send(JSON.stringify(msg)); } catch(e) {}
    });
  }
  function frSendAndAwait(msg, responseType, timeoutMs) {
    return ensureRelayConnected().then(function(ws) {
      if (!ws) return null;
      return new Promise(function(resolve) {
        var done = false;
        var h = function(e) {
          var d; try { d = JSON.parse(e.data); } catch(_) { return; }
          if (d.type === responseType && !done) {
            done = true; ws.removeEventListener('message', h); resolve(d);
          }
        };
        ws.addEventListener('message', h);
        try { ws.send(JSON.stringify(msg)); } catch(err) { done = true; ws.removeEventListener('message', h); resolve(null); }
        setTimeout(function() { if (!done) { done = true; ws.removeEventListener('message', h); resolve(null); } }, timeoutMs || 4000);
      });
    });
  }

  // === iframe 管理 ===
  var gameIframe = null;
  var isLauncher = location.pathname === '/' ||
                   location.pathname === '/index.html' ||
                   location.pathname.endsWith('/launcher.html');

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
      // 主动离开房间，但保持 presence 连接（不断开 relayWs，好友仍看到在线）
      if (relayWs && relayWs.readyState === 1 && mpState !== 'idle') {
        try { relayWs.send(JSON.stringify({ type: 'leave-room' })); } catch(e) {}
      }
      relayReconnectAttempts = 0;
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

    mpRelayRooms: function() {
      var url = location.protocol === 'https:' ? '/rooms' : 'http://81.70.199.45:18766/rooms';
      return fetch(url).then(function(r) { return r.json(); }).catch(function() { return []; });
    },

    onMpMessage: function(callback) { mpMessageCallback = callback; },

    // 好友系统 API（与 preload.js 保持一致 // PARITY）
    frGetProfile: function() { return Promise.resolve(frProfile); },
    frSetProfile: function(name) {
      frProfile = frProfile || {};
      frProfile.name = name;
      saveFrProfile(frProfile);
      return Promise.resolve(frProfile);
    },
    frSaveCode: function(code) {
      frProfile = frProfile || {};
      frProfile.code = code;
      saveFrProfile(frProfile);
      return Promise.resolve({ ok: true });
    },
    frConnect: function() { return ensureRelayConnected().then(function() { return { ok: true }; }); },
    frList: function() {
      // 不自动重连：连接断了就返回空列表，避免 identity-registered → refreshFriends → 重连 的风暴
      if (!relayWs || relayWs.readyState !== 1) return Promise.resolve({ list: [] });
      return frSendAndAwait({ type: 'friends-presence' }, 'friends-presence-snapshot', 4000)
        .then(function(d) { return d ? { list: d.list } : { list: [] }; });
    },
    frAddRequest: function(code) { frSend({ type: 'friend-request', code: code }); return Promise.resolve({ ok: true }); },
    frAccept: function(code) { frSend({ type: 'friend-accept', code: code }); return Promise.resolve({ ok: true }); },
    frReject: function(code) { frSend({ type: 'friend-reject', code: code }); return Promise.resolve({ ok: true }); },
    frRemove: function(code) { frSend({ type: 'friend-remove', code: code }); return Promise.resolve({ ok: true }); },
    frInvite: function(code) { frSend({ type: 'invite', code: code }); return Promise.resolve({ ok: true }); },
    frJoin: function(roomId, name) {
      return window.electronAPI.mpJoin(roomId, 0, name || (frProfile && frProfile.name) || '玩家');
    },
    frRegister: function(name, password) { frSend({ type: 'account-register', name: name, password: password }); return Promise.resolve({ ok: true }); },
    frLogin: function(name, password) { frSend({ type: 'account-login', name: name, password: password }); return Promise.resolve({ ok: true }); },
    frDeleteAccount: function() { frSend({ type: 'delete-account' }); return Promise.resolve({ ok: true }); },
    frClearProfile: function() { frProfile = null; try { localStorage.removeItem('gc_profile'); } catch(e) {} return Promise.resolve({ ok: true }); },
    frLogout: function() {
      frProfile = null;
      try { localStorage.removeItem('gc_profile'); } catch(e) {}
      if (relayWs) { relayIntentionalClose = true; try { relayWs.close(); } catch(e){} relayWs = null; }
      mpState = 'idle'; mpIsHost = false; mpMyId = null; mpRoomId = null; mpHostToken = null; mpPeers = [];
      clearPendingSends();
      return Promise.resolve({ ok: true });
    },
    frIsConnected: function() { return Promise.resolve(!!(relayWs && relayWs.readyState === 1)); },
    onFrMessage: function(cb) { frMessageCallback = cb; }
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
        // 支持多次注册：用 callback 数组而不是单例
        window._mpCallbacks = window._mpCallbacks || [];
        window._mpCallbacks.push(callback);
        if (!window._mpProxyInstalled) {
          window._mpProxyInstalled = true;
          window.addEventListener('message', function(e) {
            if (e.data && e.data.type === 'mp-message') {
              (window._mpCallbacks || []).forEach(function(cb) {
                try { cb(e.data.data); } catch (err) {}
              });
            }
          });
        }
      }
    };

    // F2 返回
    document.addEventListener('keydown', function(e) {
      if (e.key === 'F2') { e.preventDefault(); window.parent.postMessage({ type: 'mp-back' }, '*'); }
    });
  }
})();
