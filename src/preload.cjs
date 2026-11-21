const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('relay', {
  getState: () => ipcRenderer.invoke('relay:get-state'),
  onState: (callback) => subscribe('relay:state', callback),
  onCommand: (callback) => subscribe('relay:command', callback),
  onFind: (callback) => subscribe('relay:find', callback),
  action: (name, payload) => ipcRenderer.invoke('relay:action', name, payload),
  setViewport: (bounds) => ipcRenderer.send('relay:viewport', bounds)
});
