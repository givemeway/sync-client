import { EventEmitter } from 'events';
import { join } from 'path';
import { createRequire } from 'module';
import { stat } from 'fs/promises';

const require = createRequire(import.meta.url);
// Try to load the addon; handle failure gracefully for environments without it
let AddonWatcher: any;
try {
  const addon = require('../../native-watcher/build/Release/watcher.node');
  AddonWatcher = addon.Watcher;
} catch (err) {
  console.warn("⚠️ Native Watcher addon not found. Ensure it is built in 'native-watcher/'");
}

export class NativeWatcher extends EventEmitter {
  private watcher?: any;
  private rootPath: string;
  private pendingEvents = new Map<string, { action: number, timeout: NodeJS.Timeout }>();
  private pendingRename: { filename: string, timeout: NodeJS.Timeout } | null = null;
  private readonly DEBOUNCE_MS = 200;

  constructor(path: string, options: any = {}) {
    super();
    this.rootPath = path;
    
    if (AddonWatcher) {
      this.watcher = new AddonWatcher(path, (event: { filename: string, action: number }) => {
        this.handleRawEvent(event);
      });
    }
  }

  start(): void {
    if (this.watcher) {
      this.watcher.start();
      console.log('✅ Native Watcher started on:', this.rootPath);
      this.emit('ready');
    } else {
        this.emit('error', new Error("Native Watcher not loaded"));
    }
  }

  async close(): Promise<void> {
    if (this.watcher) {
        // C++ stop is synchronous in our binding
        this.watcher.stop();
        this.watcher = undefined;
    }
    this.pendingEvents.clear();
    if (this.pendingRename) {
        clearTimeout(this.pendingRename.timeout);
        this.pendingRename = null;
    }
  }

  // Compatible API with chokidar.watch() result
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private handleRawEvent(event: { filename: string, action: number }) {
    const key = event.filename;
    
    // RENAME HANDLING
    // Windows guarantees Action 4 (Old) followed immediately by Action 5 (New)
    if (event.action === 4) {
        if (this.pendingRename) {
            // flushed previous pending as unlink
            this.emitDebounced(this.pendingRename.filename, 2); 
        }
        this.pendingRename = {
            filename: key,
            timeout: setTimeout(() => {
                // Timeout waiting for 5 -> assume delete (moved out of scope)
                if (this.pendingRename && this.pendingRename.filename === key) {
                     this.emitDebounced(key, 2); // Treat as remove
                     this.pendingRename = null;
                }
            }, 1000)
        };
        return;
    }
    
    if (event.action === 5) {
        if (this.pendingRename) {
             // MATCH! Atomic Rename
             const oldName = this.pendingRename.filename;
             const newName = key;
             clearTimeout(this.pendingRename.timeout);
             this.pendingRename = null;
             
             // Emit special RENAME event
             this.emitRename(oldName, newName);
             return;
        }
        // Fallthrough: Action 5 without 4 -> Treat as ADD (Moved into scope)
        event.action = 1; 
    }

    // Flush any pending rename if we see other events (interrupted sequence?)
    if (this.pendingRename) {
         this.emitDebounced(this.pendingRename.filename, 2);
         this.pendingRename = null;
    }

    // NORMAL DEBOUNCING (ADD/REMOVE/MODIFY)
    if (this.pendingEvents.has(key)) {
      const pending = this.pendingEvents.get(key)!;
      clearTimeout(pending.timeout);

      // Simple coalescing logic
      if (pending.action === 1 && event.action === 3) {
        // Keep ADD, ignore MODIFY
      } else if (event.action === 2) {
         // Overwrite with REMOVE
         pending.action = 2;
      } else {
         pending.action = event.action;
      }

      pending.timeout = setTimeout(() => this.emitDebounced(key, pending.action), this.DEBOUNCE_MS);
    } else {
      this.pendingEvents.set(key, {
        action: event.action,
        timeout: setTimeout(() => this.emitDebounced(key, event.action), this.DEBOUNCE_MS)
      });
    }
  }

  private async emitRename(oldFilename: string, newFilename: string) {
      const oldPath = join(this.rootPath, oldFilename);
      const newPath = join(this.rootPath, newFilename);
      
      try {
          const stats = await stat(newPath); // We use FS stat because native event doesn't tell us type
          if (stats.isDirectory()) {
              // Construct minimal DirectoryMetadata if needed by listener?
              // The SyncClient expects (DirectoryMetadata, DirectoryMetadata) for dir:rename
              // But FileSystemWatcher creates them. 
              // FileSystemWatcher emits: 'dir:rename', oldFolder, newFolder
              // Here we emit raw paths/stats, and rely on FileSystemWatcher to adapt?
              // Or we emit matching signature?
              // Let's emit raw paths and let FileSystemWatcher adapter handle it.
              this.emit('dir:rename', oldPath, newPath, stats);
          } else {
              this.emit('file:rename', oldPath, newPath, stats);
          }
      } catch (err) {
          console.error("Failed to stat renamed item:", newPath, err);
      }
  }

  private async emitDebounced(filename: string, action: number) {
    this.pendingEvents.delete(filename);
    const fullPath = join(this.rootPath, filename);

    try {
        switch (action) {
          case 1: // Add
            {
               const stats = await stat(fullPath);
               if (stats.isDirectory()) {
                   this.emit('addDir', fullPath, stats);
               } else {
                   this.emit('add', fullPath, stats); 
               }
            }
            break;
          case 2: // Remove
            // For removal, we can't get stats as file is gone.
            // Chokidar doesn't pass stats for unlink either usually.
            // But we need to distinguish file vs dir? 
            // Native event doesn't give us type for removed items easily.
            // We just emit 'unlink' aka file remove by default?
            // Or we check if we tracked it as a dir previously?
            // For now, let's just emit 'unlink' which is safer.
            // If SyncClient needs 'unlinkDir', it might be tricky without tracking.
            // But 'unlink' works for both in many watchers or generic handling.
            // Wait, FileSystemWatcher maps this.
            // Let's stick to 'unlink' for now.
            this.emit('unlink', fullPath);
            break;
          case 3: // Modify
            {
                const stats = await stat(fullPath);
                // Modify typically implies file.
                this.emit('change', fullPath, stats);
            }
            break;
          // Cases 4/5 handled by handleRawEvent now
        }
    } catch (err: any) {
        // Race condition: File deleted before we could stat it?
        if (err.code === 'ENOENT') {
            // If we tried to Add/Modify but it's gone, maybe emit unlink?
            // Or just ignore.
            if (action === 1 || action === 3) {
                 // It was added then deleted instantly.
                 // safe to ignore or emit unlink?
                 // Ignoring is safer to avoid 'unlink' for a file never reported 'added'.
                 console.warn(`[NativeWatcher] File disappeared before stat: ${filename}`);
            }
        } else {
            console.error(`[NativeWatcher] Error in emitDebounced for ${filename}:`, err);
        }
    }
  }
}
