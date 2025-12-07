// src/index.ts - Package entry point

// Main classes
export { SyncClient } from './SyncClient.js';
export { FileSystemWatcher } from './core/FileSystemWatcher.js';
export { ApiClient } from './core/ApiClient.js';
export { HashWorkerPool } from './utils/HashWorkerPool.js';
export { UploadPool } from './utils/UploadPool.js';

// Types
export type {
  SyncClientConfig,
  FileMetadata,
  DirectoryMetadata,
  SyncStatus,
  SyncEvent,
  SyncResult,
  WatcherOptions,
  SyncUploadResult,
  CloudFileMetadata
} from './types/index.js';
