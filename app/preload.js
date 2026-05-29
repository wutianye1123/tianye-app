const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  launchGame: (gamePath) => ipcRenderer.send('launch-game', gamePath),
  backToLauncher: () => ipcRenderer.send('back-to-launcher'),
  isFirstLoad: () => ipcRenderer.sendSync('is-first-load'),
  getPlayTimes: () => ipcRenderer.sendSync('get-play-times'),
  readFile: (filePath) => ipcRenderer.sendSync('read-file', filePath),
  resetCursor: () => ipcRenderer.send('reset-cursor'),
  // 联机 API
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
  }
});
