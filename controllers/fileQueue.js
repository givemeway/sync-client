import { createReadStream } from "node:fs";
import { generateHash } from "./generateHash.js";
import { v4 as uuidv4 } from "uuid";
import { SYNC_PATH } from "./get_file_folder_metadata.js";

export const recordFileChange = async (filePath, fileStat) => {
  try {
    const input = createReadStream(filePath);
    input.on("readable", async () => {
      const chunk = input.read();
      if (chunk !== null) {
        const hashValue = generateHash(chunk);
      }
    });
    input.on("error", (err) => {
      console.error("Error reading file:", err.message);
    });
  } catch (err) {
    console.error("Error recording file change:", err);
  }
};

export const updateDirQueue = (path, directoryQueue) =>
  new Promise(async (resolve, reject) => {
    const relPathParts = path.split(SYNC_PATH).slice(1).join("/").split("\\");
    let folder = relPathParts.at(-1);
    let relPath = relPathParts.slice(1).join("/");
    let device = relPathParts.at(1);
    if (relPath === "") {
      folder = "/";
      device = "/";
      relPath = "/";
    } else {
      relPath = "/" + relPath;
    }
    let obj = {
      uuid: uuidv4(),
      folder: folder,
      device: device,
      path: relPath,
      absPath: path,
    };
    if (relPath !== "/") directoryQueue[relPath] = { ...obj };
    else directoryQueue["/"] = { ...obj };
  });

export const updateFileQueue = (path, fileQueueObj, stats) => {
  const pathParts = path.split(SYNC_PATH).slice(1).join("/").split("\\");
  const fileName = pathParts.at(-1);
  let relPath = pathParts.slice(1, -1).join("/");
  relPath = relPath === "" ? "/" : "/" + relPath;
  const obj = {
    filename: fileName,
    last_modified: stats.mtime,
    size: stats.size,
    path: relPath,
    absPath: path,
  };
  if (fileQueueObj[relPath]) {
    fileQueueObj[relPath] = {
      ...fileQueueObj[relPath],
      [obj.filename]: { ...obj },
    };
  } else {
    fileQueueObj[relPath] = { [obj.filename]: { ...obj } };
  }
};
