const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (app.isPackaged) app.setName('M211 Barcode Copy');
const userData = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '.app-data');
const logDirectory = app.isPackaged ? path.join(userData, 'logs') : path.join(__dirname, 'logs');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(logDirectory, { recursive: true });
app.setPath('userData', userData);
app.setAppUserModelId('local.brady.m211-connect');

const entryUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const logFile = path.join(logDirectory, 'm211-connect.jsonl');
let window = null;
let discovery = null;
let pairing = null;
let selectedDeviceId = null;

function clean(value, depth = 0) {
  if (depth > 3) return '[nested]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 20).map(item => clean(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [
      key.slice(0, 80), /password|token|ownership|secret|pin/i.test(key) ? '[redacted]' : clean(item, depth + 1),
    ]));
  }
  return String(value).slice(0, 2000);
}

function log(event, detail = {}) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      fs.renameSync(logFile, path.join(logDirectory, 'm211-connect.previous.jsonl'));
    }
    fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), event, detail: clean(detail) }) + '\n');
  } catch (error) {
    console.error('Could not write application log:', error.message);
  }
}

function send(channel, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function trustedSender(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === entryUrl;
}

function finishDiscovery(deviceId = '', message = 'Discovery cancelled.') {
  if (!discovery) return;
  const pending = discovery;
  discovery = null;
  clearTimeout(pending.timer);
  if (deviceId) selectedDeviceId = deviceId;
  pending.callback(deviceId);
  send('discovery-state', { active: false, message });
  log('discovery-ended', { selected: Boolean(deviceId), message });
}

function finishPairing(response = { confirmed: false }) {
  if (!pairing) return;
  const pending = pairing;
  pairing = null;
  clearTimeout(pending.timer);
  pending.callback(response);
  log('pairing-response', { confirmed: Boolean(response.confirmed) });
}

ipcMain.on('choose-device', (event, deviceId) => {
  if (!trustedSender(event) || !discovery || typeof deviceId !== 'string') return;
  if (!discovery.devices.has(deviceId)) return;
  finishDiscovery(deviceId, 'Connecting to the selected printer…');
});
ipcMain.on('cancel-discovery', event => {
  if (trustedSender(event)) finishDiscovery();
});
ipcMain.on('answer-pairing', (event, response) => {
  if (!trustedSender(event) || !pairing || !response || typeof response !== 'object') return;
  const confirmed = response.confirmed === true;
  if (pairing.kind === 'providePin') {
    const pin = typeof response.pin === 'string' ? response.pin.trim().slice(0, 32) : '';
    finishPairing({ confirmed: confirmed && pin.length > 0, pin: pin || null });
  } else {
    finishPairing({ confirmed });
  }
});
let rendererLogWindowStart = Date.now();
let rendererLogCount = 0;
ipcMain.on('renderer-log', (event, entry) => {
  if (!trustedSender(event)) return;
  if (Date.now() - rendererLogWindowStart > 10000) {
    rendererLogWindowStart = Date.now();
    rendererLogCount = 0;
  }
  if (++rendererLogCount <= 100) log('renderer', entry);
});

function createWindow() {
  window = new BrowserWindow({
    title: 'M211 Barcode Copy',
    width: 1120,
    height: 940,
    minWidth: 760,
    minHeight: 650,
    backgroundColor: '#f3f5f7',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.removeMenu();
  const contents = window.webContents;
  const session = contents.session;
  function allowedPermission(webContents, permission, details) {
    return webContents === contents && contents.getURL() === entryUrl &&
      details?.isMainFrame !== false &&
      (!details?.requestingUrl || details.requestingUrl === entryUrl) &&
      ['bluetooth', 'bluetooth-scanning'].includes(permission);
  }
  session.setPermissionCheckHandler((webContents, permission, origin, details) => {
    const allowed = allowedPermission(webContents, permission, details);
    if (!allowed) log('permission-denied', { permission });
    return allowed;
  });
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = allowedPermission(webContents, permission, details);
    log('permission-request', { permission, allowed });
    callback(allowed);
  });
  // HID, serial and USB are not used; Bluetooth selection uses the handler below.
  session.setDevicePermissionHandler(() => false);
  session.setBluetoothPairingHandler((details, callback) => {
    if (!selectedDeviceId || !details.frame || details.frame !== contents.mainFrame || details.frame.url !== entryUrl) {
      callback({ confirmed: false });
      return;
    }
    finishPairing();
    pairing = {
      callback,
      kind: details.pairingKind,
      timer: setTimeout(() => finishPairing(), 60000),
    };
    send('pairing-request', {
      deviceId: details.deviceId,
      pairingKind: details.pairingKind,
      ...(typeof details.pin === 'string' ? { pin: details.pin } : {}),
    });
    log('pairing-request', { deviceId: details.deviceId, pairingKind: details.pairingKind });
  });

  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault(); // Never let Electron silently select the first nearby device.
    if (contents.getURL() !== entryUrl) {
      callback('');
      return;
    }
    if (!discovery) {
      selectedDeviceId = null;
      discovery = {
        callback,
        devices: new Map(),
        timer: setTimeout(() => finishDiscovery('', 'Scan timed out. Check that the M211 is on and available, then try again.'), 45000),
      };
      send('discovery-state', { active: true, message: 'Looking for an M211…' });
      log('discovery-started');
    }
    discovery.callback = callback;
    // An unnamed advertisement may be the printer before its name is resolved.
    const eligible = devices.filter(device => !device.deviceName?.trim() || /m211/i.test(device.deviceName));
    discovery.devices = new Map(eligible.map(device => [device.deviceId, device]));
    const presented = eligible.map(device => ({ deviceId: device.deviceId, deviceName: device.deviceName || 'Unnamed Bluetooth device' }))
      .sort((a, b) => Number(/m211/i.test(b.deviceName)) - Number(/m211/i.test(a.deviceName)) || a.deviceName.localeCompare(b.deviceName));
    send('bluetooth-devices', presented);
    log('discovery-update', { eligibleDevices: presented, totalCount: devices.length });
  });

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('console-message', (_event, ...args) => {
    const detail = args[0] && typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1], lineNumber: args[2], sourceId: args[3] };
    log('console', detail);
  });
  contents.on('did-fail-load', (_event, code, description) => log('load-failed', { code, description }));
  contents.on('render-process-gone', (_event, details) => log('renderer-exited', details));
  contents.on('did-start-navigation', () => {
    finishDiscovery();
    finishPairing();
  });
  window.once('ready-to-show', () => window.show());
  window.on('close', () => {
    finishDiscovery();
    finishPairing();
  });
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'index.html')).catch(error => log('load-error', error.message));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.whenReady().then(() => {
    log('app-start', { electron: process.versions.electron, chrome: process.versions.chrome });
    createWindow();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('window-all-closed', () => app.quit());
}
