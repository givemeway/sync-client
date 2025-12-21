// src/types/index.ts - Type definitions for the sync client
import { File } from "../../DB/prisma-client/index.js";

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
    [filename: string]: FileMetadata;
  };
}

export interface initialScannedGlobalDirQueue {
  [path: string]: DirectoryMetadata;
}
export interface FileUploadMetadata {
  mtime: Date;
  size: number;
  type: string | undefined;
  checksum: string;
  isModified: boolean;
  device: string;
  version: number;
  username: string;
  filename: string;
  directory: string;
  height?: number;
  width?: number;
}

export interface FileMetadata {
  filename: string;
  path: string;
  hashvalue: string;
  size: number;
  inode: string;
  last_modified: Date;
  absPath: string;
  sync_status:
  | "new"
  | "modified"
  | "delete"
  | "rename"
  | "DIR_RENAMED"
  | "downloading";
  old_path?: string;
  old_filename?: string;
  dirID: string;
  uuid: string;
  height?: number;
  width?: number;
  versions: number;
  origin: string;
}

export interface DirectoryMetadata {
  uuid: string;
  path: string;
  device: string;
  folder: string;
  created_at: Date;
  absPath: string;
  sync_status: "new" | "delete" | "rename" | "FILE_LINKED";
  old_path?: string;
  inode?: string;
}

export type SyncEvent =
  | "sync:started"
  | "sync:completed"
  | "file:uploaded"
  | "file:downloaded"
  | "file:added"
  | "file:changed"
  | "file:removed"
  | "dir:added"
  | "dir:removed"
  | "rename:detected"
  | "error";

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
  alwaysStat?: boolean;
  atomic?: boolean;
  awaitWriteFinish?: {
    stabilityThreshold?: number;
    pollInterval?: number;
  };
}

export interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  failed: number;
  errors?: Error[];
}

export interface SyncUploadResult {
  success: boolean;
  fileId?: string;
  error?: string;
}

export interface SyncDeleteResult {
  success: boolean;
  type?: string;
  itemId?: string;
  error?: string;
}

export interface SyncRenameResult {
  success: boolean;
  type?: string;
  renamedItem?: CloudFolderMetadata[];
  oldName?: string;
  newName?: string;
  error?: string;
}

export interface SyncFolderCreateResult {
  success: boolean;
  folderCreated?: string;
  error?: string;
}

export interface CloudMetadataResult {
  success: boolean;
  files: CloudFileMetadata[];
  directories: CloudFolderMetadata[];
}

export interface CloudMetadataResultError {
  success: boolean;
  error: string;
  files?: CloudFileMetadata[];
  directories?: CloudFolderMetadata[];
}

export interface CloudFileDownloadMetadata {
  file: string;
  uuid: string;
  db: string;
  dir: string;
  device: string;
}

export interface CloudFileMetadata {
  filename: string;
  type: string;
  dirID: string;
  hashvalue: string;
  last_modified: Date;
  path: string;
  size: number;
  uuid: string;
  inode?: string;
  origin: string;
  versions: string;
}
export interface CloudFileDeleteMetadata {
  id: string;
  path: string;
  origin: string;
  dir: string;
  versions: number;
  username: string;
}
export interface CloudFileRenameMetadata {
  type: string;
  dir: string;
  device: string;
  filename: string;
  to: string;
  origin: string;
}
export interface CloudFolderDeleteMetadata {
  path: string;
  folder: string;
  directory: string;
  username: string;
  device: String;
}
export interface CloudFolderRenameMetadata {
  oldPath: string;
  folder: string;
  value: string;
  to: string;
}
export interface LocalFileRenameMetadata {
  oldFile: File;
  newFile: CloudFileMetadata;
}
export interface LocalFileDeleteMetadata {
  filename: string;
  absPath: string;
  path: string;
}
export interface CloudFolderCreateMetadata {
  path: string;
  device: string;
  created_at: Date;
  username: string;
}
export interface CloudFolderMetadata {
  folder: string;
  path: string;
  uuid: string;
  device: string;
  type?: string;
  created_at: Date;
  files?: { uuid: string; filename: string; path: string; origin: string; }[]

}

export interface LocalFolderCreateMetadata {
  absPath: string;
  uuid: string;
  folder: string;
  path: string;
  device: string;
  created_at: Date;
}

export interface LocalFolderDeleteMetadata {
  absPath: string;
  folder: string;
  path: string;
}
export interface Conflict {
  localFile: FileMetadata;
  cloudFile: FileMetadata;
  resolutionStrategy: "keepBoth" | "keepLocal" | "keepCloud";
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
