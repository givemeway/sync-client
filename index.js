import { prisma } from "./Config/prismaDBConfig.js";
import { watcherFn } from "./controllers/MonitorFileSystem.js";
import { buildSyncFolderDB } from "./controllers/buildSyncFolderDB.js";
import {
  _get_metadata,
  _get_file_metadata,
  _add_dir_queue_db,
  _add_dir_main_db,
  _add_file_queue_db,
  _add_file_main_db,
  _remove_dir_queue_db,
  _remove_dir_main_db,
  _remove_file_queue_db,
  _remove_file_main_db,
  _update_file_queue_db,
  _update_file_main_db,
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
        if (file) {
          await prisma.$transaction(async (prisma) => {
            const dirs = await _add_file_queue_db(prisma, file);
            await _add_file_main_db(prisma, dirs, file);
          });
        }
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
      await prisma.$transaction(async (prisma) => {
        const dirObj = await _add_dir_queue_db(prisma, path);
        await _add_dir_main_db(prisma, dirObj);
      });
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
      await prisma.$transaction(async (prisma) => {
        await _remove_dir_queue_db(prisma, path);
        await _remove_dir_main_db(prisma, path);
      });
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
        await prisma.$transaction(async (prisma) => {
          await _update_file_queue_db(prisma, file);
          await _update_file_main_db(prisma, file);
        });
      }
    }
  } catch (error) {
    console.log(error);
  }
});

const debounceRemoveFile = debounce(async () => {
  console.log("CallBack for File remove");
  try {
    for (const path of deleteFileQueue) {
      const file = await _get_file_metadata(path, null);
      if (file) {
        await prisma.$transaction(async (prisma) => {
          await _remove_file_queue_db(prisma, file);
          await _remove_file_main_db(prisma, file);
        });
      }
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
        debouncedAddFile(fileQueueArr);
      } else {
        updateFileQueue(path, fileQueue, stats);
      }
    } catch (err) {}
  })
  .on("change", async (path, stats) => {
    console.log("Change File -> ", path);
    try {
      modifiedFileQueue.push({ [path]: stats });
      debouncedModified();
    } catch (err) {}
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
      const { files, dirs } = await _get_metadata(fileQueue, directoryQueue);
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
