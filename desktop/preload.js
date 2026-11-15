// preload.js — Axofy Code Review desktop preload.
// contextBridge only: the web UI never gets Node access. Keys are never
// exposed — settings:get returns key presence, not values.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('axoreviewDesktop', {
  isDesktop: true,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  clearKeys: () => ipcRenderer.invoke('settings:clear-keys'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  closeSettings: () => ipcRenderer.invoke('settings:close'),
});
