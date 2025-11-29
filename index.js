import { prisma } from "./Config/prismaDBConfig.js";
import { watcherFn } from "./controllers/MonitorFileSystem.js";
import { buildSyncFolderDB, readSyncDB } from "./controllers/buildSyncFolderDB.js";
import {
  getMetadata,
  getFileMetadata,
  addDirQueueDb,
  addDirMainDb,
  addFileQueueDb,
  addFileMainDb,
  removeDirQueueDb,
  removeDirMainDb,
  removeFileQueueDb,
  removeFileMainDb,
  updateFileQueueDb,
  updateFileMainDb,
  renameFileQueueDb,
  renameFileMainDb,
  renameDirQueueDb,
  renameDirMainDb,
} from "./controllers/get_file_folder_metadata.js";
import { updateFileQueue, updateDirQueue } from "./controllers/fileQueue.js";
import { toFilesDirObj, getToBeSyncedItems, getCloudFilesFoldersMetadata } from "./controllers/sync.js"
import { SYNC_PATH } from "./controllers/get_file_folder_metadata.js";
import { uploadFiles, updateFolders, deleteFiles } from "./controllers/uploadChanges.js";
console.log("Sync Path: ", SYNC_PATH);
const log = console.log.bind(console);
let isUploading = false;
const watcher = watcherFn(SYNC_PATH);
let INITIAL_SCAN_COMPLETE = false;
let fileQueue = {};
let directoryQueue = {};
let fileQueueArr = [];
let directoryQueueArr = [];
let deleteFileQueue = [];
let deleteDirQueue = [];
let modifiedFileQueue = [];
let pendingRenames = new Map(); // Key: Inode, Value: Array of { path, fileObj, timestamp }
let pendingDirRenames = new Map(); // Key: created_at (string), Value: Array of { path, dirObj, timestamp }

// Cleanup pending dir renames
setInterval(() => {
  const now = Date.now();
  for (const [key, dirs] of pendingDirRenames.entries()) {
    const expired = dirs.filter(d => now - d.timestamp > 1000);
    const active = dirs.filter(d => now - d.timestamp <= 1000);

    if (expired.length > 0) {
      for (const d of expired) {
        console.log("Pending dir rename expired, treating as delete:", d.path);
        deleteDirQueue.push(d.path);
      }
      debounceRemoveDir(deleteDirQueue);
    }

    if (active.length > 0) {
      pendingDirRenames.set(key, active);
    } else {
      pendingDirRenames.delete(key);
    }
  }
}, 1000);

// Cleanup pending renames every 1 second
setInterval(() => {
  const now = Date.now();
  for (const [inode, files] of pendingRenames.entries()) {
    const expired = files.filter(f => now - f.timestamp > 1000);
    const active = files.filter(f => now - f.timestamp <= 1000);

    if (expired.length > 0) {
      for (const f of expired) {
        console.log("Pending rename expired, treating as delete:", f.path);
        deleteFileQueue.push(f.path);
      }
      debounceRemoveFile(deleteFileQueue);
    }

    if (active.length > 0) {
      pendingRenames.set(inode, active);
    } else {
      pendingRenames.delete(inode);
    }
  }
}, 1000);
const debounce = (cb, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      cb(...args);
    }, delay);
  };
};

const debouncedAddFile = debounce(async () => {
  console.log("CallBack for File Add");
  const currentQueue = [...fileQueueArr];
  fileQueueArr = [];
  try {
    for (const obj of currentQueue) {
      for (const [path, fileObj] of Object.entries(obj)) {
        const file = await getFileMetadata(path, fileObj);
        if (file) {
          await prisma.$transaction(async (prisma) => {
            const dirs = await addFileQueueDb(prisma, file);
            await addFileMainDb(prisma, dirs, file);
          });
        }
      }
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceAddDir = debounce(async () => {
  console.log("Callback for Dir add");
  const currentQueue = [...directoryQueueArr];
  directoryQueueArr = [];
  try {
    for (const path of currentQueue) {
      await prisma.$transaction(async (prisma) => {
        const dirObj = await addDirQueueDb(prisma, path);
        await addDirMainDb(prisma, dirObj);
      });
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceRemoveDir = debounce(async () => {
  console.log("CallBack for Dir Remove");
  const currentQueue = [...deleteDirQueue];
  deleteDirQueue = [];
  try {
    for (const path of currentQueue) {
      await prisma.$transaction(async (prisma) => {
        await removeDirQueueDb(prisma, path);
        await removeDirMainDb(prisma, path);
      });
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

const debouncedModified = debounce(async () => {
  const currentQueue = [...modifiedFileQueue];
  modifiedFileQueue = [];
  try {
    for (const obj of currentQueue) {
      for (const [path, fileObj] of Object.entries(obj)) {
        const file = await getFileMetadata(path, fileObj);
        await prisma.$transaction(async (prisma) => {
          await updateFileQueueDb(prisma, file);
          await updateFileMainDb(prisma, file);
        });
      }
    }
  } catch (error) {
    console.log(error);
  }
});

const debounceRemoveFile = debounce(async () => {
  console.log("CallBack for File remove");
  const currentQueue = [...deleteFileQueue];
  deleteFileQueue = [];
  try {
    for (const path of currentQueue) {
      const file = await getFileMetadata(path, null);
      if (file) {
        await prisma.$transaction(async (prisma) => {
          await removeFileQueueDb(prisma, file);
          await removeFileMainDb(prisma, file);
        });
      }
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

watcher
  .on("add", async (path, stats) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Add File  -> ", path);

        // Check for rename
        const inode = stats.ino.toString();
        if (pendingRenames.has(inode)) {
          const potentialRenames = pendingRenames.get(inode);
          // Simple heuristic: Match size. 
          // Ideally we check hash, but that requires reading the new file.
          // Let's assume Inode + Size is strong enough for local moves.
          const matchIndex = potentialRenames.findIndex(f => f.fileObj.size === stats.size);

          if (matchIndex !== -1) {
            const match = potentialRenames[matchIndex];
            console.log(`Rename Detected: ${match.path} -> ${path}`);

            // Remove from pending
            potentialRenames.splice(matchIndex, 1);
            if (potentialRenames.length === 0) pendingRenames.delete(inode);

            // Execute Rename
            const newFileObj = await getFileMetadata(path, stats);
            await prisma.$transaction(async (prisma) => {
              await renameFileQueueDb(prisma, match.fileObj, newFileObj);
              await renameFileMainDb(prisma, match.fileObj, newFileObj);
            });
            return; // Skip normal add
          }
        }

        fileQueueArr.push({ [path]: stats });
        console.log("Stats: ", stats);
        debouncedAddFile(fileQueueArr);
      } else {
        updateFileQueue(path, fileQueue, stats);
      }
    } catch (err) { console.error(err); }
  })
  .on("change", async (path, stats) => {
    console.log("Change File -> ", path);
    try {
      modifiedFileQueue.push({ [path]: stats });
      debouncedModified();
    } catch (err) { }
  })
  .on("unlink", async (path, stats) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Delete File (Pending) -> ", path);
        // Get metadata from DB to have Inode/Hash
        const file = await getFileMetadata(path, null);
        if (file) {
          const inode = file.inode || "unknown"; // Ensure we have inode in DB
          if (!pendingRenames.has(inode)) {
            pendingRenames.set(inode, []);
          }
          pendingRenames.get(inode).push({
            path,
            fileObj: file,
            timestamp: Date.now()
          });
        } else {
          // If not in DB, just delete
          deleteFileQueue.push(path);
          debounceRemoveFile(deleteFileQueue);
        }
      }
    } catch (err) {
      console.error(err);
    }
  })
  .on("addDir", async (path, stats) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Add Dir -> ", path);

        // Check for rename (using created_at/mtime as heuristic since we don't store inode for dirs)
        // stats might not be passed for addDir in some chokidar versions, but usually is.
        // If stats is missing, we might need to stat manually.
        let dirStats = stats;
        if (!dirStats) {
          try { dirStats = await import("node:fs/promises").then(fs => fs.stat(path)); } catch (e) { }
        }

        if (dirStats) {
          const createdAt = dirStats.mtime.getTime().toString();
          if (pendingDirRenames.has(createdAt)) {
            const potentialRenames = pendingDirRenames.get(createdAt);
            const matchIndex = 0; // Take first match
            const match = potentialRenames[matchIndex];

            console.log(`Folder Rename Detected: ${match.path} -> ${path}`);

            potentialRenames.splice(matchIndex, 1);
            if (potentialRenames.length === 0) pendingDirRenames.delete(createdAt);

            await prisma.$transaction(async (prisma) => {
              await renameDirQueueDb(prisma, match.path, path);
              await renameDirMainDb(prisma, match.path, path);
            });
            return;
          }
        }

        directoryQueueArr.push(path);
        console.log("Dir Stats: ", stats);
        debounceAddDir(directoryQueueArr);
      } else {
        updateDirQueue(path, directoryQueue);
      }
    } catch (err) {
      console.error(err);
    }
  })
  .on("unlinkDir", async (path) => {
    if (INITIAL_SCAN_COMPLETE) {
      console.log("Delete Dir -> ", path);
      // Check DB for metadata to buffer
      try {
        const { relPath } = getFolderDevicePath(path, false);
        const dir = await prisma.directory.findFirst({
          where: { path: relPath }
        });
        if (dir) {
          const key = dir.created_at.getTime().toString();
          if (!pendingDirRenames.has(key)) {
            pendingDirRenames.set(key, []);
          }
          pendingDirRenames.get(key).push({
            path,
            dirObj: dir,
            timestamp: Date.now()
          });
          return;
        }
      } catch (e) { console.error(e); }

      deleteDirQueue.push(path);
      debounceRemoveDir(deleteDirQueue);
    }
  })
  .on("error", (error) => log(`Watcher error: ${error}`))
  .on("ready", async () => {
    INITIAL_SCAN_COMPLETE = true;
    log("Initial scan complete. Ready for changes");
    try {
      const { files, dirs } = await getMetadata(fileQueue, directoryQueue);
      await buildSyncFolderDB(files, dirs);
      fileQueue = {};
      directoryQueue = {};
    } catch (err) {
      console.log(err);
    }
  });
// .on("raw", (event, path, details) => {
//   // internal
//   log("Raw event info:", event, path, details);
// });
const rearrangeDirObj = (dirsObj) => {
  return Object.fromEntries(
    Object.entries(dirsObj).map(([p, f]) => [p, f[p]])
  );

}

const getFilesToSyncUp = (filesObj) => {
  const filesToUpload = Object.entries(filesObj)
    .flatMap(([_, filesObj]) =>
      Object.entries(filesObj)
        .filter(([_, fileObj]) => fileObj.sync_status !== "delete")
        .map((a) => ({ ...a[1] }))
    )
    .flat();

  const filesToDelete = Object.entries(filesObj)
    .flatMap(([_, filesObj]) =>
      Object.entries(filesObj)
        .filter(([_, fileObj]) => fileObj.sync_status === "delete")
        .map(a => ({ ...a[1] }))
    )
    .flat();
  return [filesToUpload, filesToDelete]
}

const pollingServer = async () => {
  try {
    console.log("Polling server");
    isUploading = true;
    const cloudItems = await getCloudFilesFoldersMetadata();
    const [files, dirs, queuedFiles, queuedDirs] = await readSyncDB(prisma);
    const { filesObj, dirsObj } = toFilesDirObj(cloudItems.items);

    const [a, b, c, d] = getToBeSyncedItems(files, dirs, filesObj, dirsObj, queuedFiles, queuedDirs)

    const items = await getMetadata(a, rearrangeDirObj(b));
    console.log("****************************************")
    const [filesToUpload, filesToDelete] = getFilesToSyncUp(items.files);
    await deleteFiles(filesToDelete);
    const [success, failure] = await uploadFiles(filesToUpload);
    console.log("****************************************")
    console.log("files Successfully Uploaded: ", success)
    console.log("files Failed Upload: ", failure);
    console.log("****************************************")
    const [dirSuccess, dirFailure] = await updateFolders(rearrangeDirObj(items.dirs))
    console.log("****************************************")
    console.log("Dirs Successfully Uploaded: ", dirSuccess);
    console.log("Dirs Failed Upload: ", dirFailure);
    console.log("****************************************")
    isUploading = false
  } catch (err) {
    console.log(err);
  }
}
setInterval(() => {
  if (!isUploading) {
    pollingServer()
  }

}, 30000000)
