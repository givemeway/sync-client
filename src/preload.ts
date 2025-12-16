
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  startSync: () => ipcRenderer.invoke('start-sync'),
  stopSync: () => ipcRenderer.invoke('stop-sync'),
  onSyncEvent: (callback: (event: any, data: any) => void) => 
    ipcRenderer.on('sync-event', callback)
});
