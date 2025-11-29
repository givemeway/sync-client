import { Worker } from "node:worker_threads";
import os from "node:os";


export class WorkerPool {
  constructor(workerScript) {
    this.workerScript = workerScript;
    this.workers = [];
    this.freeWorkers = [];
    this.queue = [];
    this.poolSize = Math.max(1, os.cpus().length - 1); // Leave one core for main thread
    
    this.init();
  }

  init() {
    for (let i = 0; i < this.poolSize; i++) {
      this.addNewWorker();
    }
  }

  addNewWorker() {
    const worker = new Worker(this.workerScript);
    
    worker.on("message", (result) => {
      // Find the task associated with this worker? 
      // Actually, simpler to just have one task per worker at a time.
      // We need to know WHICH task this result is for if we don't track it on the worker object.
      // Let's attach the callback to the worker.
      
      if (worker.currentTask) {
        if (result.status === "success") {
          worker.currentTask.resolve(result.hash);
        } else {
          worker.currentTask.reject(new Error(result.error));
        }
        worker.currentTask = null;
      }
      
      this.freeWorkers.push(worker);
      this.processQueue();
    });

    worker.on("error", (err) => {
      console.error("Worker error:", err);
      if (worker.currentTask) {
        worker.currentTask.reject(err);
      }
      this.replaceWorker(worker);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Worker stopped with exit code ${code}`);
        this.replaceWorker(worker);
      }
    });

    this.workers.push(worker);
    this.freeWorkers.push(worker);
  }

  replaceWorker(worker) {
    const index = this.workers.indexOf(worker);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    // Also remove from freeWorkers if present
    const freeIndex = this.freeWorkers.indexOf(worker);
    if (freeIndex !== -1) {
      this.freeWorkers.splice(freeIndex, 1);
    }
    this.addNewWorker();
    this.processQueue();
  }

  run(taskData) {
    return new Promise((resolve, reject) => {
      const task = { taskData, resolve, reject };
      this.queue.push(task);
      this.processQueue();
    });
  }

  processQueue() {
    if (this.queue.length === 0) return;
    if (this.freeWorkers.length === 0) return;

    const worker = this.freeWorkers.shift();
    const task = this.queue.shift();

    worker.currentTask = task;
    worker.postMessage(task.taskData);
  }
  
  close() {
      for (const worker of this.workers) {
          worker.terminate();
      }
  }
}
