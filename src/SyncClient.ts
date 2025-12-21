// src/SyncClient.ts - Main entry point for the sync client

import { EventEmitter } from "events";
import { createServer, Server, Socket } from "net";
import { Stats } from "node:fs";
import { PrismaClient } from "../DB/prisma-client/index.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { FileSystemWatcher } from "./core/FileSystemWatcher.js";
import { HashFilesService } from "./core/HashFilesService.js";
import { DatabaseManager } from "./core/DatabaseManager.js";
import { HashWorkerPool } from "./utils/HashWorkerPool.js";
import { FilesystemScanner } from "./utils/FilesystemScanner.js";
import { progress } from "./utils/ProgressDisplay.js";
import { CloudSyncManager } from "./core/CloudSyncManager.js";
import { ApiClient } from "./core/ApiClient.js";
import { v4 as uuidv4 } from "uuid";
import type {
  SyncClientConfig,
  SyncStatus,
  SyncEvent,
  FileMetadata,
  DirectoryMetadata,
  ScannedFile,
  ScannedDirectory,
} from "./types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Main SyncClient class that orchestrates file synchronization
 * @extends EventEmitter
 */

export class SyncClient extends EventEmitter {
  private config: SyncClientConfig;
  private isRunning: boolean = false;
  private lastSync?: Date;
  private watcher?: FileSystemWatcher;
  // ... other props ...
  private prisma?: PrismaClient;
  private dbManager?: DatabaseManager;
  private hashPool?: HashWorkerPool;
  private hashFiles?: HashFilesService;
  private fsScanner?: FilesystemScanner;
  private cloudSyncManager?: CloudSyncManager;
  private apiClient?: ApiClient;

  // IPC
  private ipcServer?: Server;
  private ipcClients: Set<Socket> = new Set();
  private readonly PIPE_NAME = "\\\\.\\pipe\\sync-client-ipc";

  private stats = {
    files: 0,
    dirs: 0,
    changes: 0,
  };

  // ... queues ...
  private fileAddQueue: { path: string; stats: Stats }[] = [];
  private dirAddQueue: { path: string; stats: Stats }[] = [];
  private fileRemoveQueue: string[] = [];
  private dirRemoveQueue: string[] = [];
  private fileChangeQueue: { path: string; stats: Stats }[] = [];

  // ... debouncers ...
  private debouncedAddFile: (...args: any[]) => void;
  private debouncedAddDir: (...args: any[]) => void;
  private debouncedRemoveFile: (...args: any[]) => void;
  private debouncedRemoveDir: (...args: any[]) => void;
  private debouncedFileChange: (...args: any[]) => void;

  constructor(config: SyncClientConfig) {
    super();
    this.config = config;
    this.validateConfig();

    // Initialize debounced handlers
    this.debouncedAddFile = this.debounce(
      this.processFileAddQueue.bind(this),
      500
    );
    this.debouncedAddDir = this.debounce(
      this.processDirAddQueue.bind(this),
      500
    );
    this.debouncedRemoveFile = this.debounce(
      this.processFileRemoveQueue.bind(this),
      500
    );
    this.debouncedRemoveDir = this.debounce(
      this.processDirRemoveQueue.bind(this),
      500
    );
    this.debouncedFileChange = this.debounce(
      this.processFileChangeQueue.bind(this),
      500
    );
    this.apiClient = new ApiClient(
      this.config.apiBaseUrl,
      this.config.userEmail
    );

    this.setupIPC();
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

  private async processFileAddQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.fileAddQueue];
    this.fileAddQueue = [];
    try {
      for (const { path, stats } of currentQueue) {
        const hash = await this.hashPool!.run(path);
        // Normalize both paths to forward slashes before substring
        const relPath = this.normalizeToRelPath(path, true);
        let fileMeta: FileMetadata = {
          path: relPath,
          filename: path.split(/[/\\]/).pop() || "",
          last_modified: stats.mtime,
          size: stats.size,
          inode: stats.ino.toString(),
          absPath: path,
          hashvalue: hash,
          sync_status: "new",
          uuid: uuidv4(),
          origin: "",
          versions: 1,
          dirID: ""
        };
        fileMeta.origin = fileMeta.uuid;
        await this.dbManager.addFileWithTransaction(fileMeta);
        this.emit("file:added", { path, stats });
      }
    } catch (err) {
      console.error("Error in processFileAddQueue:", err);
    }
  }

  private async processDirAddQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.dirAddQueue];
    this.dirAddQueue = [];

    try {
      for (const { path, stats } of currentQueue) {
        await this.dbManager.addDirWithTransaction(path, stats);
        this.emit("dir:added", { path, stats });

        // NATIVE WATCHER ONLY: Recursive Scan
        // Because Windows native watcher might result in a "one folder added" event for a Move/Copy,
        // we must manually ensure all children are scanned and added.
        if (
          process.env.USE_NATIVE_WATCHER === "true" &&
          this.fsScanner &&
          this.hashPool
        ) {
          try {
            // Determine relative path for scan
            const scanResult = await this.fsScanner.scan(path);

            // Add all found Sub-Directories
            for (const subDir of scanResult.dirs) {
              // subDir.path is relative to sync root (e.g. /sync/folder/sub)
              // We need to format it for DB methods if they expect specific inputs?
              // addDirWithTransaction expects (absPath, stats). ScannedDirectory has absPath.
              // We don't have full stats object, but ScannedDirectory has mtime.
              // Let's manually construct a minimal stats-like object or modify addDirWithTransaction?
              // Safe bet: usage of fsScanner means file exists, we can stat it or just trust metadata.
              // Actually, dbManager.addDirWithTransaction takes (absPath, stats).
              // Let's create a fake stats object.
              const fakeStats: any = {
                mtime: subDir.mtime,
                birthtime: subDir.mtime,
                ino: parseInt(subDir.inode || "0"),
              };
              await this.dbManager.addDirWithTransaction(
                subDir.absPath,
                fakeStats
              );
            }

            // Add all found Files
            for (const file of scanResult.files) {
              // Similar logic to processFileAddQueue
              const relPath = file.path; // ScannedFile path is relative
              let fileMeta: FileMetadata = {
                path: relPath,
                filename: file.filename,
                last_modified: file.mtime,
                size: file.size,
                inode: file.inode,
                absPath: file.absPath,
                hashvalue: file.hash,
                sync_status: "new",
                uuid: uuidv4(),
                origin: "",
                versions: 1,
                dirID: "",
              };
              fileMeta.origin = fileMeta.uuid || "";
              await this.dbManager.addFileWithTransaction(fileMeta);
              // Emit event so UI sees it
              this.emit("file:added", {
                path: file.absPath,
                stats: {
                  size: file.size,
                  mtime: file.mtime,
                  ino: parseInt(file.inode),
                } as any,
              });
            }

            if (scanResult.files.length > 0 || scanResult.dirs.length > 0) {
              console.log(
                `[NativeWatcher] Recursively added ${scanResult.files.length} files and ${scanResult.dirs.length} dirs for ${path}`
              );
            }
          } catch (scanErr) {
            console.error(
              `[NativeWatcher] Recursive scan failed for ${path}:`,
              scanErr
            );
          }
        }
      }
    } catch (err) {
      console.error("Error in processDirAddQueue:", err);
    }
  }

  private async processFileRemoveQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.fileRemoveQueue];
    this.fileRemoveQueue = [];

    try {
      for (const path of currentQueue) {
        // Normalize both paths to forward slashes before substring
        const relPath = this.normalizeToRelPath(path, true);
        const fileMeta: FileMetadata = {
          path: relPath,
          filename: path.split(/[/\\]/).pop() || "",
          last_modified: new Date(),
          size: 0,
          inode: "",
          absPath: path,
          hashvalue: "",
          sync_status: "delete",
          origin: "",
          versions: 1,
          dirID: "",
          uuid: uuidv4(),
        };
        await this.dbManager.removeFileWithTransaction(fileMeta);
        this.emit("file:removed", { path });
      }
    } catch (err) {
      console.error("Error in processFileRemoveQueue:", err);
    }
  }

  private async processDirRemoveQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.dirRemoveQueue];
    this.dirRemoveQueue = [];

    try {
      const shortestDirPaths = this.identifyDirRenameCandidates(currentQueue);
      for (const path of shortestDirPaths) {
        const absPath = join(this.config.syncPath, path);
        await this.dbManager.removeDirWithTransaction(absPath);
        this.emit("dir:removed", { path });
      }
    } catch (err) {
      console.error("Error in processDirRemoveQueue:", err);
    }
  }

  private async processFileChangeQueue() {
    if (!this.dbManager) return;
    const currentQueue = [...this.fileChangeQueue];
    this.fileChangeQueue = [];

    try {
      for (const { path, stats } of currentQueue) {
        const hash = await this.hashPool!.run(path);
        // Normalize both paths to forward slashes before substring
        const relPath = this.normalizeToRelPath(path, true);
        let fileMeta: FileMetadata = {
          path: relPath,
          filename: path.split(/[/\\]/).pop() || "",
          last_modified: stats.mtime,
          size: stats.size,
          inode: stats.ino.toString(),
          absPath: path,
          hashvalue: hash,
          sync_status: "modified",
          uuid: uuidv4(),
          origin: "",
          versions: 1,
          dirID: "",
        };
        //        fileMeta.origin = fileMeta.uuid || "";
        await this.dbManager.updateFileWithTransaction(fileMeta);
        this.emit("file:changed", { path, stats });
      }
    } catch (err) {
      console.error("Error in processFileChangeQueue:", err);
    }
  }

  private normalizeToRelPath(abspath: string, isFile: boolean = false): string {
    const normalizedPath = abspath.replace(/\\/g, "/");
    const normalizedSyncPath = this.config.syncPath.replace(/\\/g, "/");
    const relPathSubString = normalizedPath.substring(
      normalizedSyncPath.length
    );
    let relPath = isFile
      ? relPathSubString.split("/").slice(0, -1).join("/")
      : relPathSubString;
    if (!relPath.startsWith("/")) relPath = "/" + relPath;
    return relPath === "" ? "/" : relPath;
  }

  private validateConfig(): void {
    if (!this.config.syncPath) {
      throw new Error("syncPath is required");
    }

    // Warnings for optional config (not blocking)
    if (!this.config.apiBaseUrl) {
      console.warn(
        "⚠️  Warning: apiBaseUrl is not set. Syncing to cloud will not work."
      );
    }
    if (!this.config.userEmail) {
      console.warn(
        "⚠️  Warning: userEmail is not set. Syncing to cloud will not work."
      );
    }
  }
  private identifyDirRenameCandidates(dirRemoveQueue: string[]): string[] {
    // split the path with / to find the depth of the path
    // one with the least depth is the parent node that is a potential renamed candidate
    const pathDepth = dirRemoveQueue
      .map((p) => ({ path: p, depth: p.split(/[/\\]/g).length }))
      .sort((a, b) => a.depth - b.depth);
    const candidates: string[] = [];
    for (const { path } of pathDepth) {
      // Check if this path is a child of any existing candidate
      const isChild = candidates.some((candidate) => {
        // Normalize for comparison
        const pNorm = path.replace(/[/\\]/g, "/");
        const cNorm = candidate.replace(/[/\\]/g, "/");
        // Exact match (duplicate) or Child
        if (pNorm === cNorm) return true;

        // Check if pNorm starts with cNorm + '/'
        // Handle case where cNorm ends with / (e.g. root)
        const prefix = cNorm.endsWith("/") ? cNorm : cNorm + "/";
        return pNorm.startsWith(prefix);
      });
      if (!isChild) {
        candidates.push(path);
      }
    }

    return candidates.map((path) => this.normalizeToRelPath(path));
  }

  /**
   * Start the sync client
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Sync client is already running");
    }

    this.emit("sync:started");
    this.isRunning = true;

    // Initialize Prisma with increased transaction timeout
    this.prisma = new PrismaClient({
      transactionOptions: {
        maxWait: 30000, // 30 seconds max wait time
        timeout: 30000, // 30 seconds timeout
      },
    });

    // Initialize Worker Pool
    const workerPath = join(
      __dirname,
      "..",
      "dist",
      "workers",
      "hash.worker.js"
    );
    this.hashPool = new HashWorkerPool(workerPath);

    // Initialize Database Manager
    this.dbManager = new DatabaseManager(this.prisma, this.config.syncPath);

    // Initialize Filesystem Scanner
    this.fsScanner = new FilesystemScanner(this.hashPool, this.config.syncPath);
    this.hashFiles = new HashFilesService();
    // Start file system watcher with dependencies for rename detection
    this.watcher = new FileSystemWatcher(
      this.config.syncPath,
      {},
      this.dbManager,
      this.fsScanner
    );
    // Initialize Cloud Sync Manager
    this.cloudSyncManager = new CloudSyncManager({
      apiUrl: this.config.apiBaseUrl,
      userEmail: this.config.userEmail,
      syncPath: this.config.syncPath,
    });
    this.cloudSyncManager.start();
    // Initial scan buffers
    const initialScanFiles: ScannedFile[] = [];
    const initialScanDirs: ScannedDirectory[] = [];
    let isReady = false;

    // Handle watcher ready event
    this.watcher.on("ready", async () => {
      progress.log(
        `✅ Initial scan complete via Watcher. Reconciling ${initialScanFiles.length} files and ${initialScanDirs.length} directories...`
      );

      if (this.dbManager && this.hashPool) {
        const dbFiles = await this.dbManager.getAllFiles();
        const metadata = await this.apiClient?.getMetadata();
        if (metadata && metadata.success) {
          const { files, directories } = metadata;
          if (files && directories) {
            await this.hashFiles?.computeHashes(
              initialScanFiles,
              dbFiles,
              this.hashPool
            );
            await this.dbManager.reconcileDatabaseWithFileSystem(
              initialScanFiles,
              initialScanDirs,
              dbFiles,
              files,
              directories
            );
          }
        }
      }

      isReady = true;

      // Clear buffers to free memory
      initialScanFiles.length = 0;
      initialScanDirs.length = 0;

      progress.log(
        "✅ Reconciliation complete. Sync client fully operational."
      );
    });

    // Wire up watcher events with clean progress display and DB updates
    this.watcher.on("file:add", async (path, stats) => {
      this.stats.files++;
      // Don't increment changes during initial scan
      if (isReady) this.stats.changes++;

      const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
      if (isReady) progress.updateAction("📄 File added: " + path, statusLine);

      try {
        if (this.dbManager) {
          if (!isReady) {
            // Normalize both paths to forward slashes before substring
            const normalizedPath = path.replace(/\\/g, "/");
            const normalizedSyncPath = this.config.syncPath.replace(/\\/g, "/");
            let relPath = normalizedPath
              .substring(normalizedSyncPath.length)
              .split("/")
              .slice(0, -1)
              .join("/");
            if (!relPath.startsWith("/")) relPath = "/" + relPath;
            relPath = relPath === "" ? "/" : relPath;
            // Buffer for initial scan reconciliation
            initialScanFiles.push({
              path: relPath, // Note: ScannedFile expects relative path from sync root
              filename: path.split(/[/\\]/).pop() || "",
              inode: stats.ino.toString(),
              hash: "", // Defer hashing to reconciliation
              size: stats.size,
              mtime: stats.mtime,
              absPath: path,
            });
          } else {
            // Normal operation - Debounced
            this.fileAddQueue.push({ path, stats });
            this.debouncedAddFile();
          }
        }
      } catch (err) {
        console.error(`Error processing file add: ${path}`, err);
      }
    });

    this.watcher.on("file:change", async (path, stats) => {
      if (!isReady) return; // Ignore changes during initial scan

      this.stats.changes++;
      const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
      progress.updateAction("📝 File changed: " + path, statusLine);

      try {
        if (this.dbManager) {
          this.fileChangeQueue.push({ path, stats });
          this.debouncedFileChange();
        }
      } catch (err) {
        console.error(`Error processing file change: ${path}`, err);
      }
    });

    this.watcher.on("file:remove", async (path) => {
      if (!isReady) return; // Ignore removals during initial scan (shouldn't happen usually)

      this.stats.files--;
      this.stats.changes++;
      const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
      progress.updateAction("🗑️  File removed: " + path, statusLine);

      try {
        if (this.dbManager) {
          this.fileRemoveQueue.push(path);
          this.debouncedRemoveFile();
        }
      } catch (err) {
        console.error(`Error processing file remove: ${path}`, err);
      }
    });

    this.watcher.on(
      "file:rename",
      async (oldPath: string, newPath: string, stats: any) => {
        if (!isReady) return;
        this.stats.changes++;
        const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
        progress.updateAction(
          `🔄 File renamed: ${oldPath.split(/[/\\]/).pop()} → ${newPath
            .split(/[/\\]/)
            .pop()}`,
          statusLine
        );

        try {
          if (this.dbManager) {
            const hash = await this.hashPool!.run(newPath);
            // Normalize both paths to forward slashes before substring
            const normalizedOldPath = oldPath.replace(/\\/g, "/");
            const normalizedNewPath = newPath.replace(/\\/g, "/");
            const normalizedSyncPath = this.config.syncPath.replace(/\\/g, "/");

            let oldRelPath = normalizedOldPath
              .substring(normalizedSyncPath.length)
              .split("/")
              .slice(0, -1)
              .join("/");
            if (!oldRelPath.startsWith("/")) oldRelPath = "/" + oldRelPath;

            let newRelPath = normalizedNewPath
              .substring(normalizedSyncPath.length)
              .split("/")
              .slice(0, -1)
              .join("/");
            if (!newRelPath.startsWith("/")) newRelPath = "/" + newRelPath;
            oldRelPath = oldRelPath === "" ? "/" : oldRelPath;
            newRelPath = newRelPath === "" ? "/" : newRelPath;
            let oldMeta: FileMetadata = {
              path: oldRelPath,
              filename: oldPath.split(/[/\\]/).pop() || "",
              last_modified: stats.mtime,
              size: stats.size,
              inode: stats.ino.toString(),
              absPath: oldPath,
              hashvalue: hash,
              sync_status: "rename",
              uuid: uuidv4(),
              origin: "",
              versions: 1,
              dirID: "",
            };
            let newMeta: FileMetadata = {
              path: newRelPath,
              filename: newPath.split(/[/\\]/).pop() || "",
              last_modified: stats.mtime,
              size: stats.size,
              inode: stats.ino.toString(),
              absPath: newPath,
              hashvalue: hash,
              sync_status: "rename",
              origin: "",
              uuid: "",
              versions: 1,
              dirID: "",
            };
            newMeta.origin = oldMeta.uuid || "";
            newMeta.uuid = oldMeta.uuid;
            oldMeta.origin = oldMeta.uuid || "";
            await this.dbManager.renameFileWithTransaction(oldMeta, newMeta);
          }
        } catch (err) {
          console.error(
            `Error processing file rename: ${oldPath} -> ${newPath}`,
            err
          );
        }

        this.emit("rename:detected", { oldPath, newPath });
      }
    );

    this.watcher.on(
      "dir:rename",
      async (oldFolder: DirectoryMetadata, newFolder: DirectoryMetadata) => {
        if (isReady) this.stats.changes++;
        const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
        if (isReady)
          progress.updateAction(
            "📁 Directory renamed: " + oldFolder.folder,
            statusLine
          );
        try {
          if (this.dbManager) {
            await this.dbManager.renameDirWithTransaction(
              oldFolder.path,
              newFolder.path
            );
          }
        } catch (err) {
          console.error("Error in dir:rename ", err);
        }
      }
    );

    this.watcher.on("dir:add", async (path: string, stats: Stats) => {
      this.stats.dirs++;
      // Don't increment changes during initial scan
      if (isReady) this.stats.changes++;

      const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
      if (isReady)
        progress.updateAction("📁 Directory added: " + path, statusLine);

      try {
        if (this.dbManager) {
          if (!isReady) {
            // Buffer for initial scan
            // Normalize both paths to forward slashes before substring
            const normalizedPath = path.replace(/\\/g, "/");
            const normalizedSyncPath = this.config.syncPath.replace(/\\/g, "/");
            let relPath = normalizedPath.substring(normalizedSyncPath.length);
            if (!relPath.startsWith("/")) relPath = "/" + relPath;

            // ScannedDirectory needs path to be parent path
            // But here relPath is the full path of the directory
            // Let's split it
            const parts = relPath.split("/");
            const name = parts.pop() || "";
            const parentPath = parts.join("/") || "/";

            initialScanDirs.push({
              path: parentPath,
              name: name,
              inode: stats.ino.toString(), // We don't get inode for dirs from watcher easily, and maybe not needed for reconciliation
              mtime: stats.mtime, // We don't get mtime for dirs from watcher addDir
              absPath: path,
            });
          } else {
            // Normal operation - Debounced
            this.dirAddQueue.push({ path, stats });
            this.debouncedAddDir();
          }
        }
      } catch (err) {
        console.error(`Error processing dir add: ${path}`, err);
      }
    });

    this.watcher.on("dir:remove", async (path) => {
      if (!isReady) return;

      this.stats.dirs--;
      this.stats.changes++;
      const statusLine = `👀 Watching: ${this.stats.files} files, ${this.stats.dirs} dirs | Changes: ${this.stats.changes}`;
      progress.updateAction("🗂️  Directory removed: " + path, statusLine);

      try {
        if (this.dbManager) {
          this.dirRemoveQueue.push(path);
          this.debouncedRemoveDir();
        }
      } catch (err) {
        console.error(`Error processing dir remove: ${path}`, err);
      }
    });

    this.watcher.on("error", (error) => {
      progress.log("❌ Watcher error: " + error.message);
      this.emit("error", error);
    });

    // Start watching!
    this.watcher.start();

    progress.log("✅ Sync client started. Waiting for initial scan...");
    progress.watching(this.config.syncPath, this.stats);
  }

  /**
   * Stop the sync client
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Sync client is not running");
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = undefined;
    }

    if (this.hashPool) {
      this.hashPool.close();
      this.hashPool = undefined;
    }

    if (this.prisma) {
      await this.prisma.$disconnect();
      this.prisma = undefined;
    }

    if (this.cloudSyncManager) {
      this.cloudSyncManager.stop();
      this.cloudSyncManager = undefined;
    }

    this.isRunning = false;
    progress.clear();
    progress.log("✅ Sync client stopped");
  }

  /**
   * Manually trigger a sync
   */
  async sync(): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Sync client is not running");
    }

    this.lastSync = new Date();
    // TODO: Implement sync logic
    this.emit("sync:completed");
  }

  /**
   * Get current status
   */
  getStatus(): SyncStatus {
    return {
      isRunning: this.isRunning,
      lastSync: this.lastSync,
      filesInQueue: 0, // TODO: Get actual count from DB
      dirsInQueue: 0, // TODO: Get actual count from DB
    };
  }

  /**
   * Setup Internal IPC Server for UI communication
   */
  private setupIPC() {
    this.ipcServer = createServer((socket) => {
      this.ipcClients.add(socket);

      // Send initial status
      socket.write(
        JSON.stringify({ type: "status", data: this.getStatus() }) + "\n"
      );
      // Send log
      socket.write(
        JSON.stringify({ type: "log", data: "Connected to Sync Service" }) +
        "\n"
      );

      socket.on("data", async (chunk) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.cmd === "start-sync") {
              if (!this.isRunning) await this.start();
              socket.write(
                JSON.stringify({ type: "res", id: msg.id, success: true }) +
                "\n"
              );
              this.broadcastStatus();
            }
            if (msg.cmd === "stop-sync") {
              if (this.isRunning) await this.stop();
              socket.write(
                JSON.stringify({ type: "res", id: msg.id, success: true }) +
                "\n"
              );
              this.broadcastStatus();
            }
            if (msg.cmd === "get-status") {
              socket.write(
                JSON.stringify({
                  type: "res",
                  id: msg.id,
                  data: this.getStatus(),
                }) + "\n"
              );
            }
          } catch (e) {
            console.error("IPC Message Error", e);
          }
        }
      });

      socket.on("close", () => this.ipcClients.delete(socket));
      socket.on("error", () => this.ipcClients.delete(socket));
    });

    this.ipcServer.listen(this.PIPE_NAME, () => {
      console.log(`📡 IPC Server listening on ${this.PIPE_NAME}`);
    });

    this.ipcServer.on("error", (e) => {
      console.warn(`IPC Server error (maybe pipe exists?): ${(e as any).code}`);
    });
  }

  private broadcast(type: string, data: any) {
    const msg = JSON.stringify({ type, data }) + "\n";
    for (const client of this.ipcClients) {
      client.write(msg);
    }
  }

  private broadcastStatus() {
    this.broadcast("status", this.getStatus());
  }

  /**
   * Type-safe event emitter override to broadcast events
   */
  emit(event: SyncEvent, ...args: any[]): boolean {
    // Broadcast relevant events to UI
    if (
      event.startsWith("file:") ||
      event.startsWith("dir:") ||
      event.startsWith("sync:")
    ) {
      this.broadcast("event", { type: event, data: args[0], stats: args[1] });
    }
    if (event === "error") {
      this.broadcast("log", `❌ Error: ${args[0].message || args[0]}`);
    }

    return super.emit(event, ...args);
  }

  /**
   * Type-safe event listener
   */
  on(event: SyncEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
