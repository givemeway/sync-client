import { recordFileChange } from "./controllers/fileQueue.js";
import { watcherFn } from "./controllers/MonitorFileSystem.js";
import {buildSyncFolderDB} from "./controllers/buildSyncFolderDB.js";
import {get_metadata} from "./controllers/get_file_folder_metadata.js";
import {updateFileQueue,updateDirQueue} from "./controllers/fileQueue.js";
import {SYNC_PATH} from "./controllers/get_file_folder_metadata.js";
const log = console.log.bind(console);

const watcher = watcherFn(SYNC_PATH);
let INITIAL_SCAN_COMPLETE = false;
let fileQueue = {}
let directoryQueue = {}
watcher
  .on("add", async (path, stats) => {
    updateFileQueue(path,fileQueue,stats); 

    if (INITIAL_SCAN_COMPLETE) {
      await recordFileChange(path, stats);
    }else{
    }
  })
  .on("change", async (path, stats) => {
    if (INITIAL_SCAN_COMPLETE) {
      await recordFileChange(path, stats);
    }
  })
  .on("unlink", async (path, stats) => {
    if (INITIAL_SCAN_COMPLETE) {
      await recordFileChange(path, stats);
    }
  })
  .on("addDir", async (path) => {
   updateDirQueue(path,directoryQueue); 
   if (INITIAL_SCAN_COMPLETE) {
    }
  })
  .on("unlinkDir", (path) => { 
    if (INITIAL_SCAN_COMPLETE) {
    }
  })
  .on("error", (error) => log(`Watcher error: ${error}`))
  .on("ready", async () => {
    INITIAL_SCAN_COMPLETE = true;
   log("Initial scan complete. Ready for changes");
    try{
     const {files,dirs} = await get_metadata(fileQueue,directoryQueue);
     await buildSyncFolderDB(files,dirs);
    }catch(err){
      console.log(err)
    }

  });
// .on("raw", (event, path, details) => {
//   // internal
//   log("Raw event info:", event, path, details);
// });
