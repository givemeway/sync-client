import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getPathTree } from "./buildSyncFolderDB.js";
export const SYNC_PATH =
  "C:\\Users\\Sandeep Kumar\\Desktop\\sync-client\\sync_folder";

export const get_metadata = (filesObj, dirObj) =>
  new Promise(async (resolve, reject) => {
    try {
      const files = await get_file_metadata(filesObj);
      const dirs = await get_folder_metadata(dirObj);
      resolve({ files, dirs });
    } catch (error) {
      reject(error);
    }
  });

const getFileHash = (filePath) =>
  new Promise(async (resolve, reject) => {
    const stream = createReadStream(filePath);
    let hash = createHash("sha256");
    stream.on("data", (data) => {
      hash.update(data);
    });
    stream.on("error", (err) => {
      reject(err);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });

const get_folder_metadata = (dirObj) =>
  new Promise(async (resolve, reject) => {
    const dirArr = Object.entries(dirObj);
    let dirs = {};
    for (const [dir, obj] of dirArr) {
      let dirObj = { ...obj };
      try {
        const created_at = (await stat(dirObj.absPath)).mtime;
        delete dirObj["absPath"];
        dirObj["created_at"] = created_at;
        dirObj["sync_status"] = "exists";
        dirs[dirObj.path] = {
          ...dirs[dirObj.path],
          [dirObj.path]: { ...dirObj },
        };
      } catch (err) {
        console.log(err);
        dirObj["error"] = err;
        dirObj["sync_status"] = "error";
        dirs[dirObj.path] = {
          ...dirs[dirObj.path],
          [dirObj.path]: { ...dirObj },
        };
      }
    }
    resolve(dirs);
  });

export const get_directory_status = (dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      let dirsObj = {};
      for (const [dirPath, dirObj] of Object.entries(dirs)) {
        try {
          const created_at = (await stat(join(SYNC_PATH, dirPath))).mtime;
          const sync_status = "new";
          dirsObj[dirPath] = { ...dirObj, created_at, sync_status };
        } catch (err) {
          const sync_status = "delete";
          dirsObj[dirPath] = { ...dirObj, sync_status };
        }
      }
      resolve(dirsObj);
    } catch (err) {
      reject(err);
    }
  });

const get_file_metadata = (obj) =>
  new Promise(async (resolve, reject) => {
    const filesArray = Object.entries(obj);
    const filesObj = {};
    for (const [path, files] of filesArray) {
      for (let [filename, file] of Object.entries(files)) {
        let fileObj = { ...file };
        const relPath = join(path, file.filename);
        try {
          fileObj["hashvalue"] = await getFileHash(file.absPath);
          delete fileObj["absPath"];
        } catch (err) {
          console.log(err);
          delete fileObj["absPath"];
          fileObj["error"] = err;
        }
        if (filesObj[path]) {
          filesObj[path] = { ...filesObj[path], [filename]: { ...fileObj } };
        } else {
          filesObj[path] = { [filename]: { ...fileObj } };
        }
      }
    }
    resolve(filesObj);
  });
