const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const { createServer } = require('./server');

process.on('uncaughtException', (err) => { try { console.error('uncaught:', err && err.stack); } catch {} });
let win = null;
let server = null;

function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let kind = 'Локальная сеть';
      if (/radmin/i.test(name) || a.address.startsWith('26.')) kind = 'Radmin VPN';
      else if (/hamachi/i.test(name) || a.address.startsWith('25.')) kind = 'Hamachi';
      else if (/zerotier/i.test(name)) kind = 'ZeroTier';
      else if (/tailscale/i.test(name) || a.address.startsWith('100.')) kind = 'Tailscale';
      out.push({ name, address: a.address, kind });
    }
  }
  out.sort((a, b) => (a.kind === 'Локальная сеть') - (b.kind === 'Локальная сеть'));
  return out;
}

const saveFile = () => path.join(app.getPath('userData'), 'table.json');
ipcMain.handle('host:saved', () => {
  try {
    const d = JSON.parse(fs.readFileSync(saveFile(), 'utf8'));
    const cm = d.campaign || {}, sc = (cm.scenes || {})[cm.active] || d.scene || {};
    return { exists: true, name: cm.name || '', scenes: Object.keys(cm.scenes || {}).length, maps: Object.keys(sc.maps || {}).length, tokens: Object.keys(sc.tokens || {}).length, players: (d.players || []).length, savedAt: d.savedAt || 0 };
  } catch { return { exists: false }; }
});
ipcMain.handle('host:start', async (_e, port, resume) => {
  if (server) await server.close();
  server = null;
  try {
    server = await createServer({ port: Number(port) || 7777, staticDir: path.join(__dirname, 'dist'), saveFile: saveFile(), resume: !!resume });
  } catch (err) {
    return { error: err.code === 'EADDRINUSE' ? `Порт ${port} уже занят — выберите другой.` : String(err.message || err) };
  }
  return { port: server.port, gmToken: server.gmToken, addresses: addresses() };
});
ipcMain.handle('app:quit', () => app.quit());
ipcMain.handle('host:stop', async () => { if (server) await server.close(); server = null; return true; });

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1920, height: 1080, minWidth: 1100, minHeight: 640, fullscreen: true,
    backgroundColor: '#14110f', title: 'Дайсхолл', autoHideMenuBar: true, icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  // Интерфейс рассчитан на 1920×1080: на других экранах масштабируется целиком.
  const fit = () => { const [w, h] = win.getContentSize(); win.webContents.setZoomFactor(Math.max(0.5, Math.min(w / 1920, h / 1080))); };
  win.on('resize', fit); win.on('enter-full-screen', fit); win.on('leave-full-screen', fit);
  win.webContents.on('did-finish-load', fit);
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
}

app.whenReady().then(createWindow);
app.on('before-quit', () => { try { if (server) server.flushNow && server.flushNow(); } catch {} });
app.on('window-all-closed', async () => { if (server) await server.close(); app.quit(); });
