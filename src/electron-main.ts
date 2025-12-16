
import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { SyncClient } from './SyncClient.js';
import type { SyncClientConfig } from './types/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let syncClient: SyncClient | null = null;

// Config (Load from env)
const config: SyncClientConfig = {
  syncPath: process.env.SYNC_PATH || join(app.getPath('home'), 'Desktop', 'sync_folder'),
  apiBaseUrl: process.env.API_BASE_URL || '',
  userEmail: process.env.USER_EMAIL || '',
  poolSize: 4
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false // Start hidden (tray only initially?) 
  });

  mainWindow.loadFile(join(__dirname, '..', 'src', 'ui', 'index.html'));

  mainWindow.on('close', (event) => {
    // Prevent closing the app, just hide window
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  // Use a simple icon for now (or placeholder)
  // TODO: Add strict icon path check
  tray = new Tray(join(__dirname, '..', 'assets', 'icon.png')); // Needs valid icon
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Status', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      } 
    }
  ]);
  tray.setToolTip('Sync Client');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    mainWindow?.isVisible() ? mainWindow.hide() : mainWindow?.show();
  });
}

// IPC Handlers
ipcMain.handle('get-status', () => {
  return syncClient ? syncClient.getStatus() : { isRunning: false };
});

ipcMain.handle('start-sync', async () => {
  if (syncClient) return;
  syncClient = new SyncClient(config);
  
  // Forward events to UI
  syncClient.on('file:added', (data) => mainWindow?.webContents.send('sync-event', { type: 'add', data }));
  syncClient.on('file:changed', (data) => mainWindow?.webContents.send('sync-event', { type: 'change', data }));
  syncClient.on('file:removed', (data) => mainWindow?.webContents.send('sync-event', { type: 'remove', data }));
  
  await syncClient.start();
  return { success: true };
});

ipcMain.handle('stop-sync', async () => {
  if (syncClient) {
    await syncClient.stop();
    syncClient = null;
  }
  return { success: true };
});


app.whenReady().then(() => {
  createWindow();
  // createTray(); // Commented out until we have an icon
  
  // For dev, show window immediately
  mainWindow?.show();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// App specific flag
declare global {
  namespace Electron {
    interface App {
      isQuiting: boolean;
    }
  }
}
app.isQuiting = false;
