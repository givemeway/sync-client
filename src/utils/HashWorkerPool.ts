// src/utils/HashWorkerPool.ts - Multi-threaded file hashing using Worker Threads

import { Worker } from 'worker_threads';
import { cpus } from 'os';

interface WorkerTask {
  filePath: string;
  resolve: (value: string) => void;
  reject: (reason?: any) => void;
}

export class HashWorkerPool {
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private tasks: WorkerTask[] = [];
  private workerTaskMap: Map<number, WorkerTask> = new Map(); // Map worker threadId to current task

  constructor(workerScript: string, poolSize: number = Math.max(1, cpus().length - 1)) {
    console.log(`🚀 Initializing HashWorkerPool with ${poolSize} workers...`);
    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(workerScript);
      
      worker.on('message', (message) => {
        this.handleWorkerMessage(worker, message);
      });

      worker.on('error', (err) => {
        console.error(`Worker error:`, err);
        this.handleWorkerError(worker, err);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
        }
        // Remove from lists
        this.workers = this.workers.filter(w => w !== worker);
        this.freeWorkers = this.freeWorkers.filter(w => w !== worker);
        // If we need to replace dead workers, we could do it here
      });

      this.workers.push(worker);
      this.freeWorkers.push(worker);
    }
  }

  /**
   * Run a task (hash a file) using the worker pool
   */
  async run(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const task: WorkerTask = { filePath, resolve, reject };
      
      if (this.freeWorkers.length > 0) {
        const worker = this.freeWorkers.pop()!;
        this.executeTask(worker, task);
      } else {
        this.tasks.push(task);
      }
    });
  }

  private executeTask(worker: Worker, task: WorkerTask) {
    this.workerTaskMap.set(worker.threadId, task);
    worker.postMessage(task.filePath);
  }

  private handleWorkerMessage(worker: Worker, message: any) {
    const task = this.workerTaskMap.get(worker.threadId);
    if (!task) return;

    this.workerTaskMap.delete(worker.threadId);
    this.freeWorkers.push(worker);

    if (message.status === 'success') {
      task.resolve(message.hash);
    } else {
      task.reject(new Error(message.error));
    }

    this.processNextTask();
  }

  private handleWorkerError(worker: Worker, error: Error) {
    const task = this.workerTaskMap.get(worker.threadId);
    if (task) {
      this.workerTaskMap.delete(worker.threadId);
      task.reject(error);
    }
    // Worker might be dead or in bad state, but for now assume it can recover or will exit
    // If it didn't exit, return to pool? 
    // Safest to terminate and replace, but for simplicity let's assume 'error' event doesn't kill it unless 'exit' fires.
    // Actually, usually 'error' means it's dead or dying.
    // Let's not push it back to freeWorkers if it's in error state, wait for exit.
  }

  private processNextTask() {
    if (this.tasks.length > 0 && this.freeWorkers.length > 0) {
      const worker = this.freeWorkers.pop()!;
      const task = this.tasks.shift()!;
      this.executeTask(worker, task);
    }
  }

  /**
   * Close all workers
   */
  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.terminate()));
    this.workers = [];
    this.freeWorkers = [];
    this.tasks = [];
  }
}
