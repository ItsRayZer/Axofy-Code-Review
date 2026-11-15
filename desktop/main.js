// main.js — Axofy Code Review desktop app (Electron).
// Starts the local AxoReview server as a child process (Electron binary run
// as Node via ELECTRON_RUN_AS_NODE), waits for /health, then shows it in a
// window. The server binds to 127.0.0.1 only. No keys are ever logged.
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { loadSettings, saveSettings, clearKeys, publicSettings, serverEnv } = require('./settings-store');
const { startServer, stopServer, isRunning } = require('./server-launcher');
const { checkForUpdate } = require('./update-check');

const APP_NAME = 'Axofy Code Review';
const APP_VERSION = app.getVersion();
const WEBSITE_URL = 'https://codereview.axofy.shop';
const GITHUB_URL = 'https://github.com/ItsRayZer/axoreview';

let mainWindow = null;
let settingsWindow = null;
let server = null; // { child, port, url, health }
let settings = null;

function userDataDir() {
  return app.getPath('userData');
}

function iconPath() {
  return path.join(__dirname, 'assets', 'marco.png');
}

function loadingHtml(message) {
  const safe = String(message).replace(/</g, '&lt;');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#F5F3FF;color:#1e1b2e;font-family:system-ui,sans-serif}h1{font-size:20px;margin:0 0 8px}p{color:#6b6580;margin:0}.bar{width:180px;height:4px;background:#ddd6fe;border-radius:2px;margin-top:20px;overflow:hidden}.bar i{display:block;height:100%;width:40%;background:#7C3AED;border-radius:2px;animation:slide 1.2s infinite}@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}</style></head><body><h1>Axofy Code Review</h1><p>${safe}</p><div class="bar"><i></i></div></body></html>`
  )}`;
}

async function restartServer() {
  if (server) {
    await stopServer(server.child);
    server = null;
  }
  const cacheFile = path.join(userDataDir(), 'cache.json');
  server = await startServer({
    extraEnv: serverEnv(settings),
    preferredPort: 3000,
    cacheFile,
  });
  return server;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: '#F5F3FF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(loadingHtml('Starting the local review server…'));
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 680,
    minWidth: 480,
    minHeight: 560,
    title: APP_NAME + ' — Settings',
    icon: iconPath(),
    parent: mainWindow || undefined,
    modal: false,
    backgroundColor: '#F5F3FF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function openExternal(url) {
  // Allowlist only — never open arbitrary URLs from page content.
  const allowed = ['https://codereview.axofy.shop', 'https://github.com/', 'https://axofy.shop'];
  if (allowed.some((prefix) => url.startsWith(prefix))) {
    shell.openExternal(url);
  }
}

async function showUpdateCheck() {
  const result = await checkForUpdate(APP_VERSION, settings.githubRepo || 'ItsRayZer/axoreview');
  if (result.error) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Check for updates',
      message: 'Could not check for updates.',
      detail: result.error,
      buttons: ['OK'],
    });
    return;
  }
  if (result.updateAvailable) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update available',
      message: result.message,
      detail: 'Axofy Code Review never installs updates automatically. Download the new installer from GitHub Releases.',
      buttons: ['Open release page', 'Later'],
      defaultId: 0,
    });
    if (response === 0 && result.url) openExternal(result.url);
  } else {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Check for updates',
      message: result.message,
      buttons: ['OK'],
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Review',
          accelerator: 'Ctrl+N',
          click: () => { if (mainWindow && server) mainWindow.loadURL(server.url + '#app'); },
        },
        {
          label: 'Settings…',
          accelerator: 'Ctrl+,',
          click: openSettingsWindow,
        },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Ctrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Ctrl+R', click: () => mainWindow && mainWindow.reload() },
        { label: 'Toggle Developer Tools', accelerator: 'Ctrl+Shift+I', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'Ctrl+Plus', click: () => mainWindow && mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5) },
        { label: 'Zoom Out', accelerator: 'Ctrl+-', click: () => mainWindow && mainWindow.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5) },
        { label: 'Reset Zoom', accelerator: 'Ctrl+0', click: () => mainWindow && mainWindow.webContents.setZoomLevel(0) },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: showUpdateCheck,
        },
        {
          label: 'Open codereview.axofy.shop',
          click: () => openExternal(WEBSITE_URL),
        },
        {
          label: 'View on GitHub',
          click: () => openExternal(GITHUB_URL),
        },
        { type: 'separator' },
        {
          label: `About ${APP_NAME}`,
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: `About ${APP_NAME}`,
            message: `${APP_NAME} ${APP_VERSION}`,
            detail: 'Free AI code review — the free alternative to CodeRabbit.\n\nEvery feature free, $0, no seat billing. Reviews run on your own computer using free LLM tiers (NVIDIA Nemotron first) or your own key. No code is sent anywhere except the LLM provider you choose.\n\nAxofy Code Review is independent and not affiliated with CodeRabbit.',
            buttons: ['OK'],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings(settings));
  ipcMain.handle('settings:save', async (_event, patch) => {
    settings = saveSettings(userDataDir(), patch || {});
    // New keys need a server restart to take effect.
    try {
      await restartServer();
      if (mainWindow) mainWindow.loadURL(server.url);
    } catch (e) {
      dialog.showErrorBox('Server restart failed', 'Settings were saved, but the local server could not be restarted: ' + e.message);
    }
    return publicSettings(settings);
  });
  ipcMain.handle('settings:clear-keys', () => {
    settings = clearKeys(userDataDir());
    return publicSettings(settings);
  });
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: APP_VERSION,
    serverUrl: server ? server.url : null,
    llmMode: server && server.health ? server.health.llm : 'unknown',
  }));
  ipcMain.handle('update:check', async () => checkForUpdate(APP_VERSION, settings.githubRepo || 'ItsRayZer/axoreview'));
  ipcMain.handle('shell:open-external', (_event, url) => { openExternal(String(url || '')); return true; });
  ipcMain.handle('settings:close', () => { if (settingsWindow) settingsWindow.close(); return true; });
}

async function init() {
  settings = loadSettings(userDataDir());
  buildMenu();
  registerIpc();
  createMainWindow();
  try {
    await restartServer();
    if (mainWindow) mainWindow.loadURL(server.url);
  } catch (e) {
    if (mainWindow) {
      mainWindow.loadURL(loadingHtml('Could not start the local server: ' + e.message + ' — quit and try again.'));
    }
    dialog.showErrorBox('Axofy Code Review could not start', e.message);
  }
}

app.whenReady().then(init);

// Smoke-test mode: --smoke-test loads the app, waits for /health + window,
// prints SMOKE_OK and quits. Used by the headless CI check.
if (process.argv.includes('--smoke-test')) {
  app.whenReady().then(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (server && mainWindow) {
        const url = mainWindow.webContents.getURL();
        if (url.startsWith('http://127.0.0.1:')) {
          console.log('SMOKE_OK url=' + url + ' llm=' + (server.health && server.health.llm));
          app.quit();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    console.error('SMOKE_FAIL server did not come up in time');
    process.exitCode = 1;
    app.quit();
  });
}

app.on('window-all-closed', () => {
  // Quit on all platforms (single-window desktop app).
  app.quit();
});

app.on('before-quit', async (event) => {
  if (server && isRunning(server.child)) {
    event.preventDefault();
    await stopServer(server.child);
    server = null;
    app.quit();
  }
});
