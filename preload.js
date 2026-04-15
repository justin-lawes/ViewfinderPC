const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewfinder', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFile: (filename, content) => ipcRenderer.invoke('save-file', filename, content),
  saveScreenshot: (dataUrl, filename) => ipcRenderer.invoke('save-screenshot', dataUrl, filename),
  writeFileDirect: (filePath, content) => ipcRenderer.invoke('write-file-direct', filePath, content),
  readFileDirect: (filePath) => ipcRenderer.invoke('read-file-direct', filePath),
  onOpenFile: (callback) => ipcRenderer.on('open-file', (event, filePath) => callback(filePath)),
  onMenuCommand: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(...args)),
  resizeWindow: (w, h) => ipcRenderer.invoke('resize-window', w, h),
  openRecentFile: () => ipcRenderer.invoke('open-recent-file'),
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  // Window controls (for custom Windows titlebar)
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  onMaximizeChange: (callback) => ipcRenderer.on('window-maximized', (event, isMax) => callback(isMax)),
  getUsername: () => ipcRenderer.invoke('get-username'),
  setAspectRatio: (ratio, extraH) => ipcRenderer.invoke('set-aspect-ratio', ratio, extraH),
  clearAspectRatio: () => ipcRenderer.invoke('clear-aspect-ratio'),
  isElectron: true,
  platform: process.platform,
});
