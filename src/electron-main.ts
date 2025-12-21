import { app, BrowserWindow, ipcMain, Tray, Menu } from 'electron';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';
import { connect, Socket } from 'net';
import { randomUUID } from 'crypto';

// Types (simplified for IPC)
interface IpcResponse {
    type: string;
    id?: string;
    data?: any;
    success?: boolean;
    stats?: any;
}

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clientSocket: Socket | null = null;
const PIPE_NAME = '\\\\.\\pipe\\sync-client-ipc';
const pendingRequests = new Map<string, (value: any) => void>();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    show: false 
  });

  mainWindow.loadFile(join(__dirname, '..', 'src', 'ui', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function connectToService() {
    console.log('connecting to service at', PIPE_NAME);
    clientSocket = connect(PIPE_NAME);

    clientSocket.on('connect', () => {
        console.log('✅ Connected to Background Service');
        // Request initial status
        sendToService('get-status', {});
    });

    clientSocket.on('data', (buffer) => {
        const lines = buffer.toString().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line) as IpcResponse;
                
                // Handle Pending Requests (RPC pattern)
                if (msg.type === 'res' && msg.id && pendingRequests.has(msg.id)) {
                    const resolve = pendingRequests.get(msg.id);
                    if (resolve) resolve(msg.data || msg); // Resolve with data or full msg
                    pendingRequests.delete(msg.id);
                }

                // Handle Broadcasts
                if (msg.type === 'status') {
                     // Forward to UI
                     // We might need to map it to what UI expects? 
                     // UI likely polls or expects specific events?
                     // Currently UI uses ipcRenderer.invoke('get-status')
                }
                
                if (msg.type === 'event') {
                    // Forward file/dir events to UI
                     const eventType = msg.data?.type || 'unknown'; // msg.data is { type, data, stats }
                     // msg.data comes from SyncClient broadcast('event', { type: event, data: args[0], stats: args[1] })
                     // So msg.data.type is 'file:added' etc.
                     // msg.data.data is path.
                     
                     // Helper: map 'file:added' -> 'add' for UI compatibility if needed?
                     // Old code: mainWindow.webContents.send('sync-event', { type: 'add', data })
                     
                     if (msg.data && typeof msg.data === 'object' && msg.data.type) {
                         const rawType = msg.data.type;
                         const fileData = msg.data.data;
                         
                         let uiType = '';
                         if (rawType === 'file:added') uiType = 'add';
                         else if (rawType === 'file:changed') uiType = 'change';
                         else if (rawType === 'file:removed') uiType = 'remove';
                         // else if (rawType === 'dir:added') ...
                         
                         if (uiType) {
                            mainWindow?.webContents.send('sync-event', { type: uiType, data: fileData });
                         }
                         
                         // Forward ALL raw events too for debug logs?
                         mainWindow?.webContents.send('log', `Event: ${rawType} ${JSON.stringify(fileData)}`);
                     }
                }

                if (msg.type === 'log') {
                    // Forward logs
                    console.log('[Service Log]:', msg.data);
                    mainWindow?.webContents.send('log', msg.data);
                }

            } catch (e) {
                console.error('Error parsing IPC message:', e);
            }
        }
    });

    clientSocket.on('error', (e) => {
        console.log('⚠️ Service not found/error. Retrying in 2s...');
    });

    clientSocket.on('close', () => {
        console.log('❌ Service disconnected. Reconnecting...');
        clientSocket = null;
        setTimeout(connectToService, 2000);
    });
}

function sendToService(cmd: string, args: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        if (!clientSocket) {
             // Mock response if disconnected
             return resolve({ isRunning: false, error: 'disconnected' });
        }
        const id = randomUUID();
        // Set timeout
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Request timed out'));
            }
        }, 5000);

        pendingRequests.set(id, (data) => {
            clearTimeout(timeout);
            resolve(data);
        });

        clientSocket.write(JSON.stringify({ cmd, id, ...args }) + '\n');
    });
}

function createTray() {
  tray = new Tray(join(__dirname, '..', 'assets', 'icon.png')); 
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
     if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
     }
  });
}

// IPC Handlers bridged to Service
ipcMain.handle('get-status', async () => {
    try {
        const res = await sendToService('get-status');
        return res; // data part
    } catch (e) {
        return { isRunning: false, error: 'timeout' };
    }
});

ipcMain.handle('start-sync', async () => {
  return await sendToService('start-sync');
});

ipcMain.handle('stop-sync', async () => {
  return await sendToService('stop-sync');
});


app.whenReady().then(() => {
  createWindow();
  // createTray(); 
  connectToService();
  
  mainWindow?.show();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

declare global {
  namespace Electron {
    interface App {
      isQuiting: boolean;
    }
  }
}
app.isQuiting = false;
