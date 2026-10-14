'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal bridge for the device-chooser window.
contextBridge.exposeInMainWorld('sknChooser', {
  onDevices(callback) {
    ipcRenderer.on('chooser:devices', (_event, devices) => callback(devices));
    ipcRenderer.send('chooser:ready');
  },
  pick(deviceId) {
    ipcRenderer.send('chooser:pick', deviceId);
  },
  cancel() {
    ipcRenderer.send('chooser:cancel');
  },
});