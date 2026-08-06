const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchGame: (gamePath) => ipcRenderer.send('launch-game', gamePath),
  backToLauncher: () => ipcRenderer.send('back-to-launcher'),
  isFirstLoad: () => ipcRenderer.sendSync('is-first-load'),
  getPlayTimes: () => ipcRenderer.sendSync('get-play-times'),
  readFile: (filePath) => ipcRenderer.sendSync('read-file', filePath),
  resetCursor: () => ipcRenderer.send('reset-cursor'),
  // 局域网联机 API
  mpHost: (lobbyInfo) => ipcRenderer.invoke('mp-host', lobbyInfo),
  mpJoin: (ip, port, name) => ipcRenderer.invoke('mp-join', ip, port, name),
  mpSend: (data) => ipcRenderer.send('mp-send', data),
  mpStop: () => ipcRenderer.invoke('mp-stop'),
  mpGetIP: () => ipcRenderer.invoke('mp-get-ip'),
  mpAddFirewall: () => ipcRenderer.invoke('mp-add-firewall'),
  mpGetState: () => ipcRenderer.invoke('mp-get-state'),
  toggleFullScreen: () => ipcRenderer.send('toggle-fullscreen'),
  onMpMessage: (callback) => {
    ipcRenderer.removeAllListeners('mp-message');
    ipcRenderer.on('mp-message', (event, data) => callback(data));
  },
  // 互联网联机 API（中转服务器）
  mpRelayHost: (lobbyInfo) => ipcRenderer.invoke('mp-relay-host', lobbyInfo),
  mpRelayJoin: (roomId, name) => ipcRenderer.invoke('mp-relay-join', roomId, name),
  mpRelaySend: (data) => ipcRenderer.send('mp-relay-send', data),
  mpRelayRooms: () => ipcRenderer.invoke('mp-relay-rooms'),
  mpDiscoverStart: () => ipcRenderer.invoke('mp-discover-start'),
  mpDiscoverStop: () => ipcRenderer.invoke('mp-discover-stop'),
  onMpDiscover: (callback) => {
    ipcRenderer.removeAllListeners('mp-discover');
    ipcRenderer.on('mp-discover', (event, servers) => callback(servers));
  },
  // 好友系统 API（与 web-api.js 保持一致 // PARITY）
  frGetProfile: () => ipcRenderer.invoke('fr-get-profile'),
  frSetProfile: (name) => ipcRenderer.invoke('fr-set-profile', name),
  frSaveCode: (code) => ipcRenderer.invoke('fr-save-code', code),
  frConnect: () => ipcRenderer.invoke('fr-connect'),
  frList: () => ipcRenderer.invoke('fr-list'),
  frAddRequest: (code) => ipcRenderer.invoke('fr-add-request', code),
  frAccept: (code) => ipcRenderer.invoke('fr-accept', code),
  frReject: (code) => ipcRenderer.invoke('fr-reject', code),
  frRemove: (code) => ipcRenderer.invoke('fr-remove', code),
  frInvite: (code) => ipcRenderer.invoke('fr-invite', code),
  frJoin: (roomId, name) => ipcRenderer.invoke('fr-join', roomId, name),
  frRegister: (name, password) => ipcRenderer.invoke('fr-register', name, password),
  frLogin: (name, password) => ipcRenderer.invoke('fr-login', name, password),
  frDeleteAccount: () => ipcRenderer.invoke('fr-delete-account'),
  frClearProfile: () => ipcRenderer.invoke('fr-clear-profile'),
  frLogout: () => ipcRenderer.invoke('fr-logout'),
  frIsConnected: () => ipcRenderer.invoke('fr-is-connected'),
  onFrMessage: (callback) => {
    ipcRenderer.removeAllListeners('fr-message');
    ipcRenderer.on('fr-message', (event, data) => callback(data));
  },
});
