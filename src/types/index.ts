// src/types/index.ts - Type definitions for the sync client

export interface SyncClientConfig {
  syncPath: string;
  apiBaseUrl: string;
  userEmail: string;
  dbPath?: string;
  poolSize?: number;
  pollingInterval?: number;
}

export interface RenameCandidate {
  path: string;
  inode: number;
  timestamp: number;
}

export interface initialScannedGlobalFileQueue {
  [path: string]: {
    [filename: string]: FileMetadata
  }
}

export interface initialScannedGlobalDirQueue {
  [path: string]: DirectoryMetadata
}

export interface FileMetadata {
  filename: string;
  path: string;
  hashvalue: string;
  size: number;
  inode: string;
  last_modified: Date;
  absPath: string;
  sync_status: 'new' | 'modified' | 'delete' | 'rename' | 'DIR_RENAMED';
  old_path?: string;
  old_filename?: string;
  dirID?: string;
  uuid?: string;
}

export interface DirectoryMetadata {
  uuid: string;
  path: string;
  device: string;
  folder: string;
  created_at: Date;
  absPath: string;
  sync_status: 'new' | 'delete' | 'rename' | 'FILE_LINKED';
  old_path?: string;
  inode?: string;
}

export type SyncEvent =
  | 'sync:started'
  | 'sync:completed'
  | 'file:uploaded'
  | 'file:downloaded'
  | 'file:added'
  | 'file:changed'
  | 'file:removed'
  | 'dir:added'
  | 'dir:removed'
  | 'rename:detected'
  | 'error';

export interface SyncStatus {
  isRunning: boolean;
  lastSync?: Date;
  filesInQueue: number;
  dirsInQueue: number;
}

export interface WatcherOptions {
  ignored?: string | string[] | RegExp;
  persistent?: boolean;
  ignoreInitial?: boolean;
  usePolling?: boolean;
}

export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  failed: number;
  errors?: Error[];
}

export interface UploadResult {
  success: boolean;
  fileId?: string;
  error?: string;
}

export interface CloudMetadata {
  files: FileMetadata[];
  directories: DirectoryMetadata[];
}

export interface Conflict {
  localFile: FileMetadata;
  cloudFile: FileMetadata;
  resolutionStrategy: 'keepBoth' | 'keepLocal' | 'keepCloud';
}

export interface FileFilter {
  path?: string;
  sync_status?: string;
}

export interface ScannedFile {
  path: string;
  filename: string;
  inode: string;
  hash: string;
  size: number;
  mtime: Date;
  absPath: string;
}

export interface ScannedDirectory {
  path: string;
  name: string;
  inode: string;
  mtime: Date;
  absPath: string;
}
