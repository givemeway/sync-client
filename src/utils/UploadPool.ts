// src/utils/UploadPool.ts - Concurrent upload pool for parallel file uploads

import type { FileMetadata, UploadResult } from '../types/index.js';

type UploadTask = {
  file: FileMetadata;
  uploadFn: (file: FileMetadata) => Promise<UploadResult>;
  resolve: (result: UploadResult) => void;
  reject: (error: Error) => void;
};

/**
 * UploadPool manages concurrent file uploads with configurable concurrency
 * 
 * Unlike HashWorkerPool which uses threads for CPU-bound hashing,
 * this uses async/await for I/O-bound network uploads.
 * 
 * @example
 * ```typescript
 * const pool = new UploadPool(5); // 5 concurrent uploads
 * const results = await Promise.all(
 *   files.map(f => pool.upload(f, uploadFn))
 * );
 * ```
 */
export class UploadPool {
  private concurrency: number;
  private activeUploads: number = 0;
  private queue: UploadTask[] = [];
  private stats = {
    total: 0,
    completed: 0,
    failed: 0,
    inProgress: 0
  };
  
  /**
   * @param concurrency Maximum number of concurrent uploads (default: 5)
   */
  constructor(concurrency: number = 5) {
    this.concurrency = Math.max(1, concurrency);
  }
  
  /**
   * Upload a file with concurrency control
   */
  upload(
    file: FileMetadata,
    uploadFn: (file: FileMetadata) => Promise<UploadResult>
  ): Promise<UploadResult> {
    return new Promise((resolve, reject) => {
      const task: UploadTask = {
        file,
        uploadFn,
        resolve,
        reject
      };
      
      this.queue.push(task);
      this.stats.total++;
      this.processQueue();
    });
  }
  
  /**
   * Process the upload queue
   */
  private async processQueue(): Promise<void> {
    // Check if we can start more uploads
    while (this.queue.length > 0 && this.activeUploads < this.concurrency) {
      const task = this.queue.shift();
      if (!task) break;
      
      this.activeUploads++;
      this.stats.inProgress++;
      
      // Start upload (don't await - let it run in background)
      this.executeUpload(task);
    }
  }
  
  /**
   * Execute a single upload task
   */
  private async executeUpload(task: UploadTask): Promise<void> {
    try {
      const result = await task.uploadFn(task.file);
      
      if (result.success) {
        this.stats.completed++;
      } else {
        this.stats.failed++;
      }
      
      task.resolve(result);
    } catch (error) {
      this.stats.failed++;
      task.reject(error as Error);
    } finally {
      this.activeUploads--;
      this.stats.inProgress--;
      
      // Process more from queue
      this.processQueue();
    }
  }
  
  /**
   * Wait for all uploads to complete
   */
  async waitForAll(): Promise<void> {
    while (this.activeUploads > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  /**
   * Get current statistics
   */
  getStats() {
    return { ...this.stats };
  }
  
  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: 0
    };
  }
  
  /**
   * Get current concurrency limit
   */
  getConcurrency(): number {
    return this.concurrency;
  }
  
  /**
   * Update concurrency limit
   */
  setConcurrency(concurrency: number): void {
    this.concurrency = Math.max(1, concurrency);
    this.processQueue(); // Process more if we increased concurrency
  }
  
  /**
   * Clear the queue (does not cancel active uploads)
   */
  clearQueue(): void {
    // Reject all queued tasks
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        task.reject(new Error('Upload cancelled - queue cleared'));
      }
    }
  }
}
