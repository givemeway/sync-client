// src/core/FileSystemWatcher.ts - Monitors file system changes with rename detection
import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import { dirname, join } from 'path';
import { Stats } from "node:fs"
import { Directory, DirectoryQueue } from "../../DB/prisma-client/index.js"
import type {
  WatcherOptions,
  FileMetadata,
  ScannedDirectory,
  DirectoryMetadata,
  SyncClientConfig
} from '../types/index.js';
import type { DatabaseManager } from './DatabaseManager.js';
import type { FilesystemScanner } from '../utils/FilesystemScanner.js';

/**
 * FileSystemWatcher class handles file system monitoring with intelligent rename detection
 * @extends EventEmitter
 * @fires FileSystemWatcher#file:add
 * @fires FileSystemWatcher#file:change
 * @fires FileSystemWatcher#file:remove
 * @fires FileSystemWatcher#file:rename
 * @fires FileSystemWatcher#dir:add
 * @fires FileSystemWatcher#dir:remove
 * @fires FileSystemWatcher#dir:rename
 * @fires FileSystemWatcher#rename:detected
 */
export class FileSystemWatcher extends EventEmitter {
  private watcher?: FSWatcher;
  private syncPath: string;
  private options: WatcherOptions;
  private dbManager?: DatabaseManager;
  private fsScanner?: FilesystemScanner;
  private dirRemoveQueue: string[] = [];
  // Rename detection
  // We use immediate detection in bufferFileRemoval instead of timing-based buffering
  private debouncedRemoveDir: (...args: any[]) => void;

  constructor(syncPath: string, options: WatcherOptions = {}, dbManager?: DatabaseManager, fsScanner?: FilesystemScanner) {
    super();
    this.syncPath = syncPath;
    this.dbManager = dbManager;
    this.debouncedRemoveDir = this.debounce(this.processDirRemoveQueue.bind(this), 500);
    this.fsScanner = fsScanner;
    this.options = {
      //    ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: false,
      usePolling: true,  // Use polling for better compatibility
      ...options
    };
  }

  private async processDirRemoveQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.dirRemoveQueue];
    this.dirRemoveQueue = [];

    try {
      const renameCandidates = this.identifyDirRenameCandidates(currentQueue);
      console.log("Renamed watcher Candidates: ", renameCandidates);
      for (const path of renameCandidates) {
        const absPath = join(this.syncPath, path);
        this.bufferDirRemoval(absPath);
      }
    } catch (err) {
      console.error("Error in processDirRemoveQueue:", err);
    }
  }
  private normalizeToRelPath(abspath: string, isFile: boolean = false): string {
    const normalizedPath = abspath.replace(/\\/g, '/');
    const normalizedSyncPath = this.syncPath.replace(/\\/g, '/');
    const relPathSubString = normalizedPath.substring(normalizedSyncPath.length);
    let relPath = isFile ? relPathSubString.split("/").slice(0, -1).join("/") : relPathSubString;
    if (!relPath.startsWith('/')) relPath = '/' + relPath;
    return relPath === "" ? "/" : relPath;
  }


  private identifyDirRenameCandidates(dirRemoveQueue: string[]): string[] {
    // split the path with / to find the depth of the path
    // one with the least depth is the parent node that is a potential renamed candidate
    const pathDepth = dirRemoveQueue
      .map(p => ({ path: p, depth: p.split(/[/\\]/g).length }))
      .sort((a, b) => a.depth - b.depth);
    const candidates: string[] = [];
    for (const { path } of pathDepth) {
      // Check if this path is a child of any existing candidate
      const isChild = candidates.some(candidate => {
        // Normalize for comparison
        const pNorm = path.replace(/[/\\]/g, "/");
        const cNorm = candidate.replace(/[/\\]/g, "/");
        // Exact match (duplicate) or Child
        if (pNorm === cNorm) return true;

        // Check if pNorm starts with cNorm + '/'
        // Handle case where cNorm ends with / (e.g. root)
        const prefix = cNorm.endsWith('/') ? cNorm : cNorm + '/';
        return pNorm.startsWith(prefix);
      });
      if (!isChild) {
        candidates.push(path);
      }
    }

    return candidates.map(path => this.normalizeToRelPath(path));
  }


  private debounce(cb: (...args: any[]) => void, delay: number) {
    let timeout: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        cb(...args);
      }, delay);
    };
  }


  /**
   * Start watching the file system
   */
  start(): void {
    if (this.watcher) {
      throw new Error('Watcher is already running');
    }

    this.watcher = chokidar.watch(this.syncPath, this.options);

    this.watcher
      .on('ready', () => {
        console.log('✅ Initial scan complete. Now watching for changes...');
        this.emit("ready");
      })
      .on('add', (path, stats) => this.handleFileAdd(path, stats))
      .on('change', (path, stats) => this.handleFileChange(path, stats))
      .on('unlink', (path) => this.handleFileRemove(path))
      .on('addDir', (path, stats) => this.handleDirAdd(path, stats))
      .on('unlinkDir', (path) => this.handleDirRemove(path))
      .on('error', (error) => this.emit('error', error));
  }

  /**
   * Stop watching the file system
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  /**
   * Handle file addition
   */
  private handleFileAdd(path: string, stats?: Stats): void {
    // During initial scan, just emit (don't show individual logs)
    //console.log('Add File  ->', path);
    this.emit('file:add', path, stats);
  }

  /**
   * Handle file change
   */
  private handleFileChange(path: string, stats?: Stats): void {
    //console.log('Change File ->', path);
    this.emit('file:change', path, stats);
  }

  /**
   * Handle file removal
   */
  private async handleFileRemove(path: string): Promise<void> {
    console.log('Delete File (Pending) ->', path);
    //this.emit("file:remove", path);
    await this.bufferFileRemoval(path);
  }

  /**
   * Handle directory addition
   */
  private handleDirAdd(path: string, stats?: Stats): void {
    // During initial scan, just emit (don't show individual logs)
    //console.log('Add Dir ->', path);
    this.emit('dir:add', path, stats);
  }

  /**
   * Handle directory removal
   */
  private async handleDirRemove(path: string): Promise<void> {
    /*    console.log('Delete Dir ->', path);
        this.dirRemoveQueue.push(path);
        this.debouncedRemoveDir()
    */
    this.emit('dir:remove', path);
  }


  private async bufferDirRemoval(path: string): Promise<void> {
    try {
      if (!this.dbManager || !this.fsScanner) {
        this.emit("dir:remove", path);
        return;
      }
      // after renaming - /users/sandeep/desktop/sync_folder/sandeep --> /users/sandeep/desktop/sync_folder/sandeepkumar
      // find all the folders in the parent path i.e /users/sandeep/desktop/sync_folder
      // After pulling details it should look like this
      // sandeep (deleted in FS)
      // sandeepkumar (renamed in FS)
      // 1. Get the Parent directory of the deleted folder. 
      // 2. Fetch all the folders in the Parent directory with identical INODE 
      //     a) Fetch the list from FS & filter by idential inode
      //            sandeepkumar - this would be fetched
      //     b) fetch the list from DB DirectoryQueue & filter by idential inode;
      //            sandeep & sandeepkumar - these two would be fetched \
      // 3. Find the difference between 2 a) and 2 b) list.
      //     a) Missing Directory - sandeep 
      //     b) Directory to Add - sandeepkumar
      // 4. if count of 3 a) and 3 b) is exactly 1 - we find out original folder and renamed folder
      console.log("ABSPath inside DirRemoval: ", path);
      const normalizedSyncPath = this.syncPath.replace(/[/\\]/g, "/");
      const normalizedABSPath = path.replace(/[/\\]/g, "/");
      let relPath = normalizedABSPath.substring(normalizedSyncPath.length)
      relPath = relPath === "" ? "/" : relPath;
      let deletedDir = await this.dbManager?.getDirFromMain(relPath);
      if (!deletedDir) {
        deletedDir = await this.dbManager?.getDirFromQueue(relPath);
      }
      if (!deletedDir || !deletedDir.inode) {
        this.emit("dir:remove", path);
        return;
      }
      console.log("Deleted Dir: ", deletedDir);
      console.log("relPath: ", relPath)
      let dbFoldersMain = await this.dbManager?.getDirSubFoldersFromMain(relPath, deletedDir?.inode);
      let dbFoldersQueue = await this.dbManager?.getDirSubFoldersFromQueue(relPath, deletedDir?.inode);
      const parentDir = path.replace(/[/\\]/g, "/").split(/[/\\]/g).slice(0, -1).join("/");
      const fsDirs = await this.fsScanner?.scanSubdirectories(parentDir, deletedDir?.inode);
      //
      // path: string;
      // name: string;
      // inode: string;
      // mtime: Date;
      // absPath: string;
      //
      let dbFoldersMap = new Map<string, DirectoryMetadata>();
      let fsFoldersMap = new Map<string, ScannedDirectory>();
      if (dbFoldersMain) {
        for (const f of dbFoldersMain) {
          const dirMetaData: DirectoryMetadata = {
            uuid: f.uuid,
            absPath: f.absPath,
            created_at: f.created_at,
            device: f.device,
            old_path: "",
            sync_status: "rename",
            path: f.path,
            folder: f.folder,
            inode: f.inode || "",
          }
          dbFoldersMap.set(f.path, dirMetaData);
        }
      }
      if (dbFoldersQueue) {
        for (const f of dbFoldersQueue) {
          const dirMetaData: DirectoryMetadata = {
            uuid: f.uuid,
            absPath: f.absPath,
            created_at: f.created_at,
            device: f.device,
            old_path: "",
            sync_status: "rename",
            path: f.path,
            folder: f.folder,
            inode: f.inode || ""
          }
          dbFoldersMap.set(f.path, dirMetaData)
        }
      }
      if (fsDirs) {
        for (const f of fsDirs) {
          fsFoldersMap.set(f.path, f);
        }
      }
      const dbFolders = Array.from(dbFoldersMap.values());
      const fsFolders = Array.from(fsFoldersMap.values());
      const dbPaths = new Set(dbFolders.map(f => f.path));
      const fsPaths = new Set(fsFolders.map(f => f.path));
      console.log("DBFolders: ", dbFolders);
      console.log("FSFolders: ", fsFolders);
      console.log("dbPaths: ", dbPaths);
      console.log("fsPaths: ", fsPaths);
      const missingFolders = dbFolders.filter(f => !fsPaths.has(f.path));
      const addedFolders = fsFolders.filter(f => !dbPaths.has(f.path));
      console.log("Missing folders: ", missingFolders);
      console.log("Added Folders: ", addedFolders);
      if (missingFolders.length === 1 && addedFolders.length === 1) {
        const oldDir = missingFolders[0];
        const newDir = addedFolders[0];
        const newFolder: DirectoryMetadata = {
          uuid: oldDir.uuid, folder: newDir.name,
          device: oldDir.device,
          inode: newDir.inode,
          created_at: newDir.mtime,
          absPath: newDir.absPath,
          path: newDir.path,
          sync_status: "rename"
        }
        console.log(`✨ Folder Rename detected: ${oldDir.folder} → ${newFolder.folder}`);
        this.emit("dir:rename", oldDir, newFolder)
      }
    } catch (err) {
      this.emit("dir:remove", path);
    }


  }

  /**
   * Buffer file removal and check for rename
   * Uses inode + hash-based detection with set-difference algorithm
   */
  private async bufferFileRemoval(path: string): Promise<void> {
    if (!this.dbManager || !this.fsScanner) {
      // Fallback: emit remove event if dependencies not available
      this.emit('file:remove', path);
      return;
    }

    try {
      // Extract filename and parent directory
      const filename = path.split(/[/\\]/).pop() || '';
      const parentDir = dirname(path);
      let relativePath = path.substring(this.syncPath.length).replace(/\\/g, "/").split("/").slice(0, -1).join("/");
      relativePath = relativePath === "" ? "/" : relativePath;
      // 1. Get deleted file info from Main DB or Queue
      let deletedFile = await this.dbManager.getFileFromMain(relativePath, filename);
      if (!deletedFile) {
        // Try getting from queue if not in main DB
        deletedFile = await this.dbManager.getFileFromQueue(relativePath, filename);
      }

      if (!deletedFile) {
        // File never existed in main DB or queue, just emit remove
        this.emit('file:remove', path);
        return;
      }
      const { inode, hashvalue } = deletedFile;
      // 2. Get all files with same inode + hash from Main DB AND Queue
      const dbFilesMain = await this.dbManager.findFilesByInodeInParent(
        parentDir.substring(this.syncPath.length),
        inode,
        hashvalue
      );
      const dbFilesQueue = await this.dbManager.findFilesByInodeInQueue(
        parentDir.substring(this.syncPath.length),
        inode,
        hashvalue
      );
      // Merge and deduplicate files (Queue takes precedence)
      const dbFilesMap = new Map<string, FileMetadata>();
      for (const f of dbFilesMain) dbFilesMap.set(f.filename, f);
      for (const f of dbFilesQueue) dbFilesMap.set(f.filename, f);
      const dbFiles = Array.from(dbFilesMap.values());
      // 3. Scan filesystem for current files with same inode + hash
      const fsFiles = await this.fsScanner.findFilesByInode(parentDir, inode, hashvalue);
      // 4. Perform set difference
      const dbPaths = new Set(dbFiles.map(f => f.path !== "/" ? f.path + '/' + f.filename : '/' + f.filename));
      const fsPaths = new Set(fsFiles.map(f => f.path !== "/" ? f.path + '/' + f.filename : "/" + f.filename));
      // Files in DB but not in filesystem (deleted/renamed)
      const missingFiles = dbFiles.filter(f => !fsPaths.has(f.path !== "/" ? f.path + "/" + f.filename : "/" + f.filename));
      // Files in filesystem but not in DB (new/renamed)
      const addedFiles = fsFiles.filter(f => !dbPaths.has(f.path !== "/" ? f.path + '/' + f.filename : '/' + f.filename));
      // 5. If exactly 1 missing and 1 added → RENAME!

      if (missingFiles.length === 1 && addedFiles.length === 1) {
        const oldFile = missingFiles[0];
        const newFile = addedFiles[0];

        console.log(`✨ Rename detected: ${oldFile.filename} → ${newFile.filename}`);

        // Convert scanned file to FileMetadata
        const newMetadata = this.fsScanner.toFileMetadata(newFile, relativePath);
        // Emit rename event
        this.emit('file:rename', path, join(parentDir, newFile.filename), {
          ino: parseInt(inode),
          mtime: newFile.mtime,
          size: newFile.size
        });
        return;
      }
      // Not a simple rename, emit remove
      this.emit('file:remove', path);
    } catch (err) {
      console.error('Error in rename detection:', err);
      this.emit('file:remove', path);
    }
  }
}
