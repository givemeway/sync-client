import { createReadStream } from "node:fs";
import { generateHash } from "./generateHash.js";
import { v4 as uuidv4 } from "uuid";
import { SYNC_PATH } from "./get_file_folder_metadata.js";
import { prisma } from "../Config/prismaDBConfig.js";
import os from "os";
const SEP = os.platform() === "win32" ? "\\" : "/";

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
    try {
      const relPathParts = path.split(SYNC_PATH).slice(1).join("/").split(SEP);
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
      const dir = await prisma.directory.findUnique({
        where: {
          device_folder_path: {
            device: device,
            folder: folder,
            path: path,
          },
        },
        select: {
          uuid: true,
        },
      });
      let obj = {
        uuid: dir ? dir.uuid : uuidv4(),
        folder: folder,
        device: device,
        path: relPath,
        absPath: path,
      };
      if (relPath !== "/") directoryQueue[relPath] = { ...obj };
      else directoryQueue["/"] = { ...obj };
      resolve();
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

export const get_file_obj = (path, stats) =>
  new Promise(async (resolve, reject) => {
    try {
      const pathParts = path.split(SYNC_PATH).slice(1).join("/").split(SEP);
      const fileName = pathParts.at(-1);
      let relPath = pathParts.slice(1, -1).join("/");
      relPath = relPath === "" ? "/" : "/" + relPath;
      if (stats) {
        const obj = {
          filename: fileName,
          last_modified: stats.mtime,
          size: stats.size,
          path: relPath,
          absPath: path,
        };
        resolve(obj);
      } else {
      }
    } catch (err) { }
  });

export const updateFileQueue = (path, fileQueueObj, stats) =>
  new Promise(async (resolve, reject) => {
    const pathParts = path.split(SYNC_PATH).slice(1).join("/").split(SEP);
    const fileName = pathParts.at(-1);
    let relPath = pathParts.slice(1, -1).join("/");
    relPath = relPath === "" ? "/" : "/" + relPath;

    try {
      if (stats) {
        const obj = {
          filename: fileName,
          last_modified: stats.mtime,
          size: stats.size,
          path: relPath,
          absPath: path,
          inode: stats.ino.toString()
        };
        console.log("obj: ", obj)
        if (fileQueueObj[relPath]) {
          fileQueueObj[relPath] = {
            ...fileQueueObj[relPath],
            [obj.filename]: { ...obj },
          };
        } else {
          fileQueueObj[relPath] = { [obj.filename]: { ...obj } };
        }
      } else {
        const file = await prisma.file.findUnique({
          where: {
            path_filename: {
              path: relPath,
              filename: fileName,
            },
          },
        });

        const obj = {
          filename: fileName,
          last_modified: file ? file.last_modified : null,
          size: file ? file.size : null,
          path: relPath,
          absPath: path,
        };
      }
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
