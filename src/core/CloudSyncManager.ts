import { Worker } from 'worker_threads';
import { join } from 'path';
import { EventEmitter } from 'events';

export class CloudSyncManager extends EventEmitter {
  private worker?: Worker;
  private workerPath: string;
  private config: {
    apiUrl: string;
    userEmail: string;
    syncPath: string;
  };

  constructor(config: { apiUrl: string; userEmail: string; syncPath: string }) {
    super();
    this.config = config;
    // Assuming the worker file will be compiled to dist/workers/cloudSync.worker.js
    // Adjust path based on your build structure
    this.workerPath = join(process.cwd(), 'dist', 'workers', 'cloudSync.worker.js');
  }

  start() {
    if (this.worker) {
      console.warn('Cloud Sync Worker is already running.');
      return;
    }

    console.log('🚀 Starting Cloud Sync Worker...');
    this.worker = new Worker(this.workerPath, {
      workerData: this.config
    });

    this.worker.on('message', (message) => {
      this.handleMessage(message);
    });

    this.worker.on('error', (err) => {
      console.error('❌ Cloud Sync Worker Error:', err);
      this.emit('error', err);
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Cloud Sync Worker stopped with exit code ${code}`);
        this.emit('error', new Error(`Worker stopped with exit code ${code}`));
      } else {
        console.log('Cloud Sync Worker stopped gracefully.');
      }
      this.worker = undefined;
    });
  }

  stop() {
    if (this.worker) {
      console.log('Stopping Cloud Sync Worker...');
      this.worker.terminate();
      this.worker = undefined;
    }
  }

  private handleMessage(message: any) {
    switch (message.type) {
      case 'log':
        console.log(`[CloudWorker] ${message.message}`);
        break;
      case 'error':
        console.error(`[CloudWorker] ${message.message}`);
        break;
      case 'sync:progress':
        this.emit('progress', message.data);
        break;
      default:
      // console.log('Unknown message from worker:', message);
    }
  }
}
