import { ApiClient } from './ApiClient.js';
import { join, parse } from "node:path"
import { rename } from "node:fs/promises"
import { DatabaseManager } from './DatabaseManager.js';
import { PrismaClient, File, Directory } from '../../DB/prisma-client/index.js';
import {
  LocalFolderCreateMetadata,
  LocalFolderDeleteMetadata,
  CloudFileMetadata,
  CloudFolderMetadata,
  LocalFileDeleteMetadata,
} from '../types/index.js';

export class ReconciliationService {
  private apiClient: ApiClient;
  private dbManager: DatabaseManager;
  private prisma: PrismaClient;
  private syncPath: string;

  constructor(apiClient: ApiClient, dbManager: DatabaseManager, prisma: PrismaClient, syncPath: string) {
    this.apiClient = apiClient;
    this.dbManager = dbManager;
    this.prisma = prisma;
    this.syncPath = syncPath
  }

  async reconcile(
    cloudFiles: CloudFileMetadata[],
    cloudDirs: CloudFolderMetadata[],
    dbFiles: File[],
    dbDirs: Directory[]
  ): Promise<{
    filesToDownload: CloudFileMetadata[],
    filesToDeleteLocal: LocalFileDeleteMetadata[],
    foldersToCreateLocal: LocalFolderCreateMetadata[],
    foldersToDeleteLocal: LocalFolderDeleteMetadata[],
    filesInConflict: CloudFileMetadata[],
    filesToUpdate: CloudFileMetadata[]
  } | any> {

    try {
      console.log('Starting reconciliation...');
      let filesToDownload: CloudFileMetadata[] = [];
      let filesToDeleteLocal: LocalFileDeleteMetadata[] = [];
      let foldersToCreateLocal: LocalFolderCreateMetadata[] = [];
      let foldersToDeleteLocal: LocalFolderDeleteMetadata[] = [];
      let filesInConflict: CloudFileMetadata[] = [];
      let filesToUpdate: CloudFileMetadata[] = [];
      // 1. Indexing for fast lookup
      const cloudFileMap = new Map(cloudFiles.map(f => [this.getUniqueKey(f.path, f.filename), f]));
      const cloudDirMap = new Map(cloudDirs.map(d => [d.path, d]));
      const dbFileMap = new Map(dbFiles.map(f => [this.getUniqueKey(f.path, f.filename), f]));
      const dbDirMap = new Map(dbDirs.map(d => [d.path, d]));
      // 2. Process Cloud Files (Download / Update / Conflict)
      for (const cloudFile of cloudFiles) {
        const key = this.getUniqueKey(cloudFile.path, cloudFile.filename);
        const localFile = dbFileMap.get(key);
        if (!localFile) {
          // Case: New in Cloud -> Download
          // console.log(`[Reconcile] New file in cloud: ${cloudFile.filename}. Downloading...`);
          // TODO: Implement download logic
          // await this.downloadFile(cloudFile);
          const fileInQueue = await this.prisma.fileQueue.findUnique({
            where: {
              path_filename: { path: cloudFile.path, filename: cloudFile.filename },
            }
          });
          if (!fileInQueue)
            filesToDownload.push(cloudFile);
        }
        else {
          // Case: Exists locally -> Check for modifications
          const inQueue = await this.prisma.fileQueue.findUnique({
            where: { path_filename: { path: localFile.path, filename: localFile.filename } }
          });
          if (!inQueue && localFile.hashvalue !== cloudFile.hashvalue) {
            // the file in the cloud is modified has to be downloaded.
            filesToUpdate.push(cloudFile)
          }
          if (inQueue) {
            if (inQueue.lastSyncedHashValue !== cloudFile.hashvalue) {
              console.log(`[Reconcile] File modified in cloud & local: ${cloudFile.filename}. Adding files to conflicts...`);
              filesInConflict.push(cloudFile);
            }
          }

        }
      }
      // 3. Process Cloud Directories (Create locally)
      for (const cloudDir of cloudDirs) {
        if (cloudDir.path === '/') continue; // Skip root        
        if (!dbDirMap.has(cloudDir.path)) {
          //console.log(`[Reconcile] New directory in cloud: ${cloudDir.path}. Creating locally...`);
          // TODO: Implement create directory logic
          const inQueue = await this.prisma.directoryQueue.findUnique({ where: { device_folder_path: { device: cloudDir.device, path: cloudDir.path, folder: cloudDir.folder } } })
          if (!inQueue) {
            foldersToCreateLocal.push({ absPath: join(this.syncPath, cloudDir.path), path: cloudDir.path, folder: cloudDir.folder });
          }
        }
      }
      // 4. Detect Deletions (Cloud -> Local)
      // Iterate local DB files, if not in Cloud Map -> It was deleted on Cloud
      for (const dbFile of dbFiles) {
        const key = this.getUniqueKey(dbFile.path, dbFile.filename);
        if (!cloudFileMap.has(key)) {
          // Check if it's currently being uploaded (in Queue with 'new' status)
          const inQueue = await this.prisma.fileQueue.findUnique({
            where: { path_filename: { path: dbFile.path, filename: dbFile.filename } }
          });
          if (!inQueue) {
            // It's a new local file waiting to be uploaded, so it's expected not to be in cloud yet.
            filesToDeleteLocal.push({ filename: dbFile.filename, absPath: dbFile.absPath, path: dbFile.path })
          }
          // console.log(`[Reconcile] File deleted in cloud: ${dbFile.filename}. Deleting locally...`);
          // TODO: Implement delete local file logic
        }
      }

      // Iterate local DB dirs, if not in Cloud Map -> Deleted on Cloud
      for (const dbDir of dbDirs) {
        if (dbDir.path === '/') continue; // Skip root
        if (!cloudDirMap.has(dbDir.path)) {
          // Check queue
          const inQueue = await this.prisma.directoryQueue.findUnique({
            where: { device_folder_path: { device: dbDir.device, folder: dbDir.folder, path: dbDir.path } }
          });
          if (!inQueue)
            foldersToDeleteLocal.push({ absPath: dbDir.absPath, path: dbDir.path, folder: dbDir.folder });
          // console.log(`[Reconcile] Directory deleted in cloud: ${dbDir.path}. Deleting locally...`);
          // TODO: Implement delete local dir logic
        }
      }
      return { filesToDeleteLocal, filesToDownload, foldersToDeleteLocal, foldersToCreateLocal, filesInConflict, filesToUpdate }
    } catch (error: any) {
      return error?.message;
    }
  }

  private getUniqueKey(dir: string, filename: string): string {
    // Ensure consistent path format
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    return `${normalizedDir}${filename}`;
  }


}
