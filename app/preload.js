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
});
