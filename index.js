import { prisma_queue } from "./Config/prismaDBConfig.js";
import { watcherFn } from "./controllers/MonitorFileSystem.js";
import {
  buildSyncFolderDB,
  getPathTree,
} from "./controllers/buildSyncFolderDB.js";
import {
  get_metadata,
  _get_file_metadata,
  _insert_file_queue_db,
  get_folder_device_path,
  _get_dirID,
  _insert_file_folder_main_db,
  _insert_dirs_queue_db,
  _delete_file_main_db,
  _delete_dir_main_db,
  get_file_metadata,
} from "./controllers/get_file_folder_metadata.js";
import { updateFileQueue, updateDirQueue } from "./controllers/fileQueue.js";
import { SYNC_PATH } from "./controllers/get_file_folder_metadata.js";
console.log("Sync Path: ", SYNC_PATH);
const log = console.log.bind(console);

const watcher = watcherFn(SYNC_PATH);
let INITIAL_SCAN_COMPLETE = false;
export let fileQueue = {};
export let directoryQueue = {};
let fileQueueArr = [];
let directoryQueueArr = [];
let deleteFileQueue = [];
let deleteDirQueue = [];
let modifiedFileQueue = [];
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
  try {
    for (const obj of fileQueueArr) {
      for (const [path, fileObj] of Object.entries(obj)) {
        const file = await _get_file_metadata(path, fileObj);
        const { relPath } = get_folder_device_path(path, true);
        const dbFile = await _insert_file_queue_db(file, relPath, "new");
        await _insert_file_folder_main_db(dbFile, true);
      }
    }
    fileQueueArr = [];
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceAddDir = debounce(async () => {
  console.log("Callback for Dir add");
  try {
    for (const path of directoryQueueArr) {
      const { relPath, device, folder } = get_folder_device_path(path, false);
      const treePaths = await getPathTree(relPath.split("/"));
      await _insert_dirs_queue_db(prisma_queue, treePaths, "new");
      await _insert_file_folder_main_db(path, false, device, folder, relPath);
    }
    directoryQueueArr = [];
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceRemoveDir = debounce(async () => {
  console.log("CallBack for Dir Remove");
  try {
    for (const path of deleteDirQueue) {
      const { relPath, device, folder } = get_folder_device_path(path, false);
      const treePaths = await getPathTree(relPath.split("/"));
      await _insert_dirs_queue_db(prisma_queue, treePaths, "delete");
      await _delete_dir_main_db(relPath, device, folder);
    }
    deleteDirQueue = [];
  } catch (err) {
    console.log(err);
  }
}, 500);

const debouncedModified = debounce(async () => {
  try {
    for (const obj of modifiedFileQueue) {
      for (const [path, fileObj] of Object.entries(obj)) {
        const file = await _get_file_metadata(path, fileObj);

      }
    }
  } catch (error) {
    console.log(error)
  }
});

const debounceRemoveFile = debounce(async () => {
  console.log("CallBack for File remove");
  try {
    for (const path of deleteFileQueue) {
      const file = await _get_file_metadata(path, null);
      const { relPath, device, folder } = get_folder_device_path(path, true);
      await _insert_file_queue_db(file, relPath, "delete");
      await _delete_file_main_db(file);
    }
    deleteFileQueue = [];
  } catch (err) {
    console.log(err);
  }
}, 500);

watcher
  .on("add", async (path, stats) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Add File  -> ", path);
        fileQueueArr.push({ [path]: stats });
        console.log(stats);
        debouncedAddFile(fileQueueArr);
      } else {
        updateFileQueue(path, fileQueue, stats);
      }
    } catch (err) { }
  })
  .on("change", async (path, stats) => {
    if (INITIAL_SCAN_COMPLETE) {
      console.log("Change File -> ", path);
      updateFileQueue(path, fileQueue, stats);
    } else {
      modifiedFileQueue.push({ [path]: stats })
    }
  })
  .on("unlink", async (path, stats) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Delete File -> ", path);
        deleteFileQueue.push(path);
        debounceRemoveFile(deleteFileQueue);
      }
    } catch (err) {
      console.error(err);
    }
  })
  .on("addDir", async (path) => {
    try {
      if (INITIAL_SCAN_COMPLETE) {
        console.log("Add Dir -> ", path);
        directoryQueueArr.push(path);
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
      deleteDirQueue.push(path);
      debounceRemoveDir(deleteDirQueue);
    }
  })
  .on("error", (error) => log(`Watcher error: ${error}`))
  .on("ready", async () => {
    INITIAL_SCAN_COMPLETE = true;
    log("Initial scan complete. Ready for changes");
    try {
      const { files, dirs } = await get_metadata(fileQueue, directoryQueue);
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
