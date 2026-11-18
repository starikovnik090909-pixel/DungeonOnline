const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  hostStart: (port, resume) => ipcRenderer.invoke('host:start', port, resume),
  hostSaved: () => ipcRenderer.invoke('host:saved'),
  quit: () => ipcRenderer.invoke('app:quit'),
  hostStop: () => ipcRenderer.invoke('host:stop'),
});
