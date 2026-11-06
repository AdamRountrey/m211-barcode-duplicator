const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('A callback is required.');
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('desktop', {
  onDevices: callback => subscribe('bluetooth-devices', callback),
  chooseDevice: id => { if (typeof id === 'string') ipcRenderer.send('choose-device', id); },
  cancelDiscovery: () => ipcRenderer.send('cancel-discovery'),
  onDiscoveryState: callback => subscribe('discovery-state', callback),
  onPairing: callback => subscribe('pairing-request', callback),
  answerPairing: response => ipcRenderer.send('answer-pairing', {
    confirmed: response?.confirmed === true,
    ...(typeof response?.pin === 'string' ? { pin: response.pin.slice(0, 32) } : {}),
  }),
  log: entry => ipcRenderer.send('renderer-log', entry),
});
