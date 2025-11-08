import { recordFileChange } from "./controllers/fileQueue.js";
import { watcherFn } from "./controllers/MonitorFileSystem.js";
import { buildSyncFolderDB } from "./controllers/buildSyncFolderDB.js";
import {
  get_metadata,
  _get_file_metadata,
  _insert_directory_tree,
  _insert_file,
  get_folder_device_path,
  _get_dirID,
} from "./controllers/get_file_folder_metadata.js";
import { updateFileQueue, updateDirQueue } from "./controllers/fileQueue.js";
import { SYNC_PATH } from "./controllers/get_file_folder_metadata.js";
const log = console.log.bind(console);

const watcher = watcherFn(SYNC_PATH);
let INITIAL_SCAN_COMPLETE = false;
export let fileQueue = {};
export let directoryQueue = {};
let fileQueueArr = [];
let directoryQueueArr = [];
let deleteFileQueue = [];
let deleteDirQueue = [];
const debounce = (cb, delay) => {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      cb(...args);
    }, delay);
  };
};

const debouncedAddFile = debounce(async (fileQueueArr) => {
  console.log("CallBack for File Add");
  try {
    for (const obj of fileQueueArr) {
      for (const [path, fileObj] of Object.entries(obj)) {
        const file = await _get_file_metadata(path, fileObj);
        const { folder, device, relPath } = get_folder_device_path(path, true);
        const { uuid } = await _get_dirID(device, folder, relPath, "new");
        const obj = await _insert_file({ ...file, dirID: uuid }, "new");
      }
    }
    fileQueueArr = [];
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceAddDir = debounce(async (directoryQueueArr) => {
  console.log("Callback for Dir add");
  try {
    for (const path of directoryQueueArr) {
      await _insert_directory_tree(path, false, "new");
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceRemoveDir = debounce(async (directoryQueueArr) => {
  console.log("CallBack for Dir Remove");
  try {
    for (const path of deleteDirQueue) {
      await _insert_directory_tree(path, false, "delete");
    }
  } catch (err) {
    console.log(err);
  }
}, 500);

const debounceRemoveFile = debounce(async (fileQueueArr) => {
  console.log("CallBack for File remove");
  try {
    for (const path of deleteFileQueue) {
      const file = await _get_file_metadata(path, null);

      await _insert_file(file, "delete");
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
        fileQueueArr.push({ [path]: stats });
        debouncedAddFile(fileQueueArr);
      } else {
        updateFileQueue(path, fileQueue, stats);
      }
    } catch (err) {}
  })
  .on("change", async (path, stats) => {
    if (INITIAL_SCAN_COMPLETE) {
      console.log("Change File -> ", path);
      updateFileQueue(path, fileQueue, stats);
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
