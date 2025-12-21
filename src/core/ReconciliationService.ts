import { ApiClient } from './ApiClient.js';
import { join, parse } from "node:path"
import { rename } from "node:fs/promises"
import { DatabaseManager } from './DatabaseManager.js';
import { PrismaClient, File, Directory, DirectoryQueue } from '../../DB/prisma-client/index.js';
import {
  LocalFolderCreateMetadata,
  LocalFolderDeleteMetadata,
  CloudFileMetadata,
  CloudFolderMetadata,
  LocalFileRenameMetadata,
} from '../types/index.js';

type RenameInfo = {
  inode: string;
  uuid: string;
  folder: string;
  created_at: Date;
  device: string;
  depth: number;              // 0-based segment index where rename starts
  oldSegment: string | null;  // e.g. "4-renamed"
  newSegment: string | null;  // e.g. "4-renamed-sandeep"
  oldPath: string;
  newPath: string;
}
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

  private splitDbPath(p: string): string[] {
    // "/4-renamed/New folder" -> ["4-renamed", "New folder"]
    return p.split('/').filter(Boolean);
  }

  private findRenameDepthFromPath(oldPath: string, newPath: string) {
    const oldSegs = this.splitDbPath(oldPath);
    const newSegs = this.splitDbPath(newPath);

    const len = Math.min(oldSegs.length, newSegs.length);
    let idx = 0;

    while (idx < len && oldSegs[idx] === newSegs[idx]) {
      idx++;
    }

    if (idx === len && oldSegs.length === newSegs.length) {
      // No difference → no rename.
      return null;
    }

    return {
      depth: idx,
      oldSegment: oldSegs[idx] ?? null,
      newSegment: newSegs[idx] ?? null,
    };
  }

  private detectDirRenames(entries: DirectoryQueue[]): RenameInfo[] {
    const byInode = new Map<string, DirectoryQueue[]>();

    // Group by inode.
    for (const e of entries) {
      if (!byInode.has(e.inode)) byInode.set(e.inode, []);
      byInode.get(e.inode)!.push(e);
    }

    const renames: RenameInfo[] = [];

    for (const [inode, group] of byInode.entries()) {
      // Explicitly enforce 1+ delete and 1+ new for this inode.
      const deletes = group.filter(e => e.sync_status === 'delete');
      const news = group.filter(e => e.sync_status === 'new');

      if (!deletes.length || !news.length) {
        // No valid delete/new pair → not a rename.
        continue;
      }

      // Choose shortest paths as the representative pair (top-most dir).
      const oldEntry = deletes.reduce((a, b) =>
        a.path.length <= b.path.length ? a : b
      );
      const newEntry = news.reduce((a, b) =>
        a.path.length <= b.path.length ? a : b
      );

      const info = this.findRenameDepthFromPath(oldEntry.path, newEntry.path);
      if (!info) continue;
      renames.push({
        inode,
        uuid: newEntry.uuid,
        device: newEntry.device,
        folder: newEntry.folder,
        created_at: newEntry.created_at,
        depth: info.depth,
        oldSegment: info.oldSegment,
        newSegment: info.newSegment,
        oldPath: oldEntry.path,
        newPath: newEntry.path,
      })
    }

    return renames;
  }

  private collapseDirRenames(renames: RenameInfo[]): RenameInfo[] {
    // Key on the actual segment rename, e.g. "4-renamed-sandeep=>4-renamed-sandeep-kumar"
    const bySegmentChange = new Map<string, RenameInfo>();

    for (const r of renames) {
      const key = `${r.oldSegment}=>${r.newSegment}`;

      const existing = bySegmentChange.get(key);
      if (!existing) {
        bySegmentChange.set(key, r);
        continue;
      }

      // Keep the one with the shortest oldPath (top-most directory)
      if (r.oldPath.length < existing.oldPath.length) {
        bySegmentChange.set(key, r);
      }
    }

    return Array.from(bySegmentChange.values());
  }

  private async reconcileDirRenamedCandidates(localFoldersRenamed: RenameInfo[]): Promise<void> {
    console.log(localFoldersRenamed);
    for (const dir of localFoldersRenamed) {
      try {
        await this.prisma.$transaction(async (prisma) => {
          await prisma.fileQueue.deleteMany({
            where: {
              OR: [{ path: dir.newPath }, { path: { startsWith: dir.newPath + "/" } }],
              AND: { OR: [{ sync_status: "delete" }, { sync_status: "new" }] }
            }
          });
          await prisma.directoryQueue.deleteMany({
            where: {
              OR: [{ path: dir.newPath }, { path: { startsWith: dir.newPath + "/" } }],
              AND: { OR: [{ sync_status: "delete" }, { sync_status: "new" }] }
            }
          });
          await prisma.fileQueue.deleteMany({
            where: {
              OR: [{ path: dir.oldPath }, { path: { startsWith: dir.oldPath + "/" } }],
              AND: { OR: [{ sync_status: "delete" }, { sync_status: "new" }] }
            }
          });
          await prisma.directoryQueue.deleteMany({
            where: {
              OR: [{ path: dir.oldPath }, { path: { startsWith: dir.oldPath + "/" } }],
              AND: { OR: [{ sync_status: "delete" }, { sync_status: "new" }] }
            }
          });
          const dirObj: DirectoryQueue = {
            uuid: dir.uuid,
            created_at: dir.created_at,
            inode: dir.inode,
            device: dir.device,
            folder: dir.newSegment || dir.folder,
            path: dir.newPath,
            old_path: dir.oldPath,
            sync_status: "rename",
            absPath: join(this.syncPath, dir.newPath)
          }
          await prisma.directoryQueue.upsert({
            where: { device_folder_path: { device: dirObj.device, folder: dirObj.folder, path: dirObj.path } },
            update: dirObj,
            create: dirObj
          });
        });
      } catch (err: any) {
        console.error(err.message);
      }

    }

  }

  async reconcile(
    cloudFiles: CloudFileMetadata[],
    cloudDirs: CloudFolderMetadata[],
    dbFiles: File[],
    dbDirs: Directory[]
  ): Promise<{
    filesToDownload: CloudFileMetadata[],
    filesToDeleteLocal: File[],
    foldersToCreateLocal: LocalFolderCreateMetadata[],
    foldersToDeleteLocal: LocalFolderDeleteMetadata[],
    filesInConflict: CloudFileMetadata[],
    filesToUpdate: CloudFileMetadata[],
    filesToRename: LocalFileRenameMetadata[]
  }> {
    try {
      console.log('Starting robust reconciliation...');

      const filesToDownload: CloudFileMetadata[] = [];
      const filesToDeleteLocal: File[] = [];
      const foldersToCreateLocal: LocalFolderCreateMetadata[] = [];
      const foldersToDeleteLocal: LocalFolderDeleteMetadata[] = [];
      const filesInConflict: CloudFileMetadata[] = [];
      const filesToUpdate: CloudFileMetadata[] = [];
      const filesToRename: LocalFileRenameMetadata[] = [];

      // 1. Indexing for multidimensional matching (Origin, UUID, and Path)
      const cloudByOrigin = new Map(cloudFiles.map(f => [f.origin, f]));
      const cloudByUuid = new Map(cloudFiles.map(f => [f.uuid, f]));
      const cloudPathMap = new Map(cloudFiles.map(f => [this.getUniqueKey(f.path, f.filename), f]));

      const dbByOrigin = new Map(dbFiles.map(f => [f.origin, f]));
      const dbByUuid = new Map(dbFiles.map(f => [f.uuid, f]));
      const dbPathMap = new Map(dbFiles.map(f => [this.getUniqueKey(f.path, f.filename), f]));

      // 2. Load Local Queue to respect in-progress local work
      const localFileQueue = await this.prisma.fileQueue.findMany();
      const localDirQueue = await this.prisma.directoryQueue.findMany();
      // Filter out invalid/empty origins if necessary, but prioritize correct mapping
      const localQueueByOrigin = new Map(localFileQueue.filter(q => q.origin).map(q => [q.origin, q]));
      const localQueueByUuid = new Map(localFileQueue.map(q => [q.uuid, q]));
      const localQueueByPath = new Map(localFileQueue.map(q => [this.getUniqueKey(q.path, q.filename), q]));
      let localDirQueueByInode: Map<string, DirectoryQueue[]> = new Map();

      // 3. Process Cloud State (Authoritative for shared identity)
      for (const cloudFile of cloudFiles) {
        // Match by Identity (Origin or UUID)
        const localFile = dbByOrigin.get(cloudFile.origin) || dbByUuid.get(cloudFile.uuid);

        // Check if there is local work pending for this file (at ANY path)
        const localInQueue = this.localInQueueByAnyPath(
          cloudFile,
          dbByOrigin,
          dbByUuid,
          localQueueByOrigin,
          localQueueByUuid,
          localQueueByPath
        );
        const isLocalModified = localInQueue?.sync_status === 'modified';
        const isLocalRenamed = localInQueue?.sync_status === 'rename';
        const isLocalDeleted = localInQueue?.sync_status === 'delete';
        const isLocalProcessing = !!localInQueue;
        const isCloudModified = localFile ? cloudFile.hashvalue !== localFile.lastSyncedHashValue : true;
        const isPathDifferent = localFile ? (localFile.path !== cloudFile.path || localFile.filename !== cloudFile.filename) : false;

        /*
        TODO: CONFLICT scenario
        1. cloud file renamed --> local file renamed 
        2. cloud file renamed --> local file updated
        3. cloud file renamed --> local file renamed & updated
        4. cloud file renamed && modified --> local file renamed
        5. cloud file renamed && modified --> local file updated
        6. cloud file renamed && modified --> local file renamed & updated
        7. cloud file renamed && modified --> local file deleted
        8. cloud file deleted --> local file renamed
        9. cloud file deleted --> local file updated
       10. cloud file modified --> local file renamed 
       11. Cloud file modified --> local file modified
        */

        if (!localFile) {
          // New file in cloud - Only download if we aren't already creating it locally
          if (!isLocalProcessing) {
            filesToDownload.push(cloudFile);
          }
          continue;
        }
        if (isPathDifferent && isLocalRenamed && !isCloudModified && !isLocalModified) {
          filesToRename.push({ oldFile: localFile, newFile: cloudFile });
          continue;
        }
        // CONFLICT: Simultaneous changes on both sides
        if (isCloudModified && isLocalModified && !isLocalRenamed && !isPathDifferent) {
          console.log(`[Conflict] Diverged state for ${cloudFile.filename}. Cloud hash changed AND local is ${localInQueue?.sync_status}.`);
          filesInConflict.push(cloudFile);
          continue;
        }
        // Apply Cloud Changes (if cloud is modified or renamed)
        if (isCloudModified) {
          if (isPathDifferent) {
            filesToRename.push({ oldFile: localFile, newFile: cloudFile });
          }
          filesToUpdate.push(cloudFile);
          continue;
        } else if (isPathDifferent) {
          // Just a cloud rename
          filesToRename.push({ oldFile: localFile, newFile: cloudFile });
          continue;
        }

        // IMPORTANT FIX: If local rename or modification is pending, do NOT force 
        // the cloud's old path or version back onto the local file yet. 
        // Let the local changes push to cloud first.
        if (isLocalProcessing && !isCloudModified) {
          continue;
        }

      }

      // 4. Handle Deletions (Cloud -> Local) with Resurrection logic
      for (const dbFile of dbFiles) {
        const cloudMatch = cloudByOrigin.get(dbFile.origin) || cloudByUuid.get(dbFile.uuid);

        if (!cloudMatch) {
          // Check if it's currently being modified or was renamed locally (prevent deleting local work)
          const localInQueue = localQueueByOrigin.get(dbFile.origin) || localQueueByUuid.get(dbFile.uuid);

          if (localInQueue && (localInQueue.sync_status === 'modified' || localInQueue.sync_status === 'rename' || localInQueue.sync_status === 'new')) {
            console.log(`[Resurrection] ${dbFile.filename} not in cloud but has local work pending. Preserving.`);
            continue;
          }

          filesToDeleteLocal.push(dbFile);
        }
      }

      // 5. Final Safety Filter - Remove from deletion if being renamed
      const filesToDeleteMap = new Map(filesToDeleteLocal.map(f => [this.getUniqueKey(f.path, f.filename), f]));
      for (const { oldFile, newFile } of filesToRename) {
        const key = this.getUniqueKey(oldFile.path, oldFile.filename);
        if (filesToDeleteMap.has(key)) {
          const dbFile = filesToDeleteMap.get(key);
          // If it's the same object (identity), it's definitely just a rename, not a delete+new
          if (dbFile && (dbFile.uuid === newFile.uuid || dbFile.origin === newFile.origin)) {
            filesToDeleteMap.delete(key);
          }
        }
      }

      // 6. Process Directories (Paths are authoritative)
      const cloudDirMap = new Map(cloudDirs.map(d => [d.path, d]));
      const dbDirMap = new Map(dbDirs.map(d => [d.path, d]));

      for (const cloudDir of cloudDirs) {
        if (cloudDir.path === '/') continue;
        if (!dbDirMap.has(cloudDir.path)) {
          const inQueue = await this.prisma.directoryQueue.findUnique({
            where: { device_folder_path: { device: cloudDir.device, folder: cloudDir.folder, path: cloudDir.path } }
          });
          if (!inQueue) {
            foldersToCreateLocal.push({
              absPath: join(this.syncPath, cloudDir.path),
              path: cloudDir.path,
              folder: cloudDir.folder,
              uuid: cloudDir.uuid,
              device: cloudDir.device,
              created_at: cloudDir.created_at
            });
          }
        }
      }

      for (const dbDir of dbDirs) {
        if (dbDir.path === '/') continue;
        if (!cloudDirMap.has(dbDir.path)) {
          const inQueue = await this.prisma.directoryQueue.findUnique({
            where: { device_folder_path: { device: dbDir.device, folder: dbDir.folder, path: dbDir.path } }
          });
          if (!inQueue) {
            foldersToDeleteLocal.push({
              absPath: dbDir.absPath,
              path: dbDir.path,
              folder: dbDir.folder
            });
          }
        }
      }
      //IMPORTANT: identify rename candidate, and remove their redundant new & delete entries in the dirQueue with a single rename entry 
      for (const e of localDirQueue) {
        if (!localDirQueueByInode.has(e.inode)) localDirQueueByInode.set(e.inode, []);
        localDirQueueByInode.get(e.inode)!.push(e);
      }
      const dirRenameCandidates = Array.from(localDirQueueByInode.values()).filter(a => a.length === 2);
      const flatEntries = dirRenameCandidates.flat();
      const renames = this.detectDirRenames(flatEntries);
      const localFoldersRenamed = this.collapseDirRenames(renames);

      await this.reconcileDirRenamedCandidates(localFoldersRenamed);
      console.log("****************************************************************************")
      console.log("foldersToDeleteLocal : ", foldersToDeleteLocal);
      console.log("foldersToCreateLocal : ", foldersToCreateLocal);
      console.log("filesToDeleteLocal : ", filesToDeleteLocal);
      console.log("filesToDownload : ", filesToDownload);
      console.log("****************************************************************************")
      return {
        filesToDownload,
        filesToDeleteLocal: Array.from(filesToDeleteMap.values()),
        foldersToCreateLocal,
        foldersToDeleteLocal,
        filesInConflict,
        filesToUpdate,
        filesToRename
      };

    } catch (error: any) {
      console.error('Reconciliation failed:', error);
      throw error;
    }
  }

  private localInQueueByAnyPath(
    cloudFile: CloudFileMetadata,
    dbByOrigin: Map<string, File>,
    dbByUuid: Map<string, File>,
    localQueueByOrigin: Map<string, any>,
    localQueueByUuid: Map<string, any>,
    localQueueByPath: Map<string, any>
  ) {
    // 1. Check by Origin
    const byOrigin = localQueueByOrigin.get(cloudFile.origin);
    if (byOrigin) return byOrigin;

    // 2. Check by UUID
    const byUuid = localQueueByUuid.get(cloudFile.uuid);
    if (byUuid) return byUuid;

    // 3. Check by Path (Current path)
    const byPath = localQueueByPath.get(this.getUniqueKey(cloudFile.path, cloudFile.filename));
    if (byPath) return byPath;

    // 4. Check by Path (Old path of a renamed file if we find the local file)
    const localFile = dbByOrigin.get(cloudFile.origin) || dbByUuid.get(cloudFile.uuid);
    if (localFile) {
      const byOldPath = localQueueByPath.get(this.getUniqueKey(localFile.path, localFile.filename));
      if (byOldPath) return byOldPath;
    }

    return null;
  }

  private getUniqueKey(dir: string, filename: string): string {
    // Ensure consistent path format
    const normalizedDir = dir.endsWith('/') ? dir : dir + '/';
    return `${normalizedDir}${filename}`;
  }


}
