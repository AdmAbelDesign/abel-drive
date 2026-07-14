'use strict';

// Ponte segura entre o renderer (UI) e o processo principal.
// Expõe só o necessário; o renderer não tem acesso a Node nem à rede direta.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('abel', {
  getState:    ()               => ipcRenderer.invoke('app:getState'),
  version:     ()               => ipcRenderer.invoke('app:version'),
  identify:    (email)          => ipcRenderer.invoke('auth:identify', email),
  requestPin:  (email, companyId) => ipcRenderer.invoke('auth:requestPin', { email, companyId }),
  verifyPin:   (email, pin, totp) => ipcRenderer.invoke('auth:verifyPin', { email, pin, totp }),
  setProfile:  (profile)        => ipcRenderer.invoke('auth:setProfile', profile),
  logout:      ()               => ipcRenderer.invoke('auth:logout'),

  // Drive
  driveConnect:    () => ipcRenderer.invoke('drive:connect'),
  driveDisconnect: () => ipcRenderer.invoke('drive:disconnect'),
  driveStatus:     () => ipcRenderer.invoke('drive:status'),
  driveOpen:       () => ipcRenderer.invoke('drive:open'),
  onDriveState: (cb) => ipcRenderer.on('drive:state', (_e, s) => cb(s)),
  onDriveToast: (cb) => ipcRenderer.on('drive:toast', (_e, t) => cb(t)),
});
