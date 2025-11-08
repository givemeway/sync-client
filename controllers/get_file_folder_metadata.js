import { createReadStream } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getPathTree } from "./buildSyncFolderDB.js";
import { prisma, prisma_queue } from "../Config/prismaDBConfig.js";
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

const _insert_file_folder_metadata_main_db = (fileObj) =>
  new Promise(async (resolve, reject) => {
    try {
      const file = await prisma_queue.file.findUnique({
        where: {
          path_filename: { filename: fileObj.filename, path: fileObj.path },
        },
        select: { uuid: true, path: true },
      });
      if (file) {
      } else {
        reject(null);
      }
    } catch (err) {}
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

export const _delete_directory = (db, path) =>
  new Promise(async (resolve, reject) => {
    try {
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
      await db.$transaction(async (prisma) => {
        await prisma.file.deleteMany({
          where: {
            path: relPath,
          },
        });
        await prisma.directory.delete({
          where: {
            device_folder_path: {
              device,
              folder,
              path: relPath,
            },
          },
        });
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _get_dirID = (device, folder, relPath, status) =>
  new Promise(async (resolve, reject) => {
    try {
      const dir = await prisma.directory.findUnique({
        where: {
          device_folder_path: {
            device,
            folder,
            path: relPath,
          },
        },
        select: {
          uuid: true,
        },
      });
      if (dir) {
        resolve({ uuid: dir.uuid });
      } else {
        const dir = await prisma_queue.directory.findUnique({
          where: {
            device_folder_path: {
              device,
              folder,
              path: relPath,
            },
          },
        });
        if (dir) {
          resolve({ uuid: dir.uuid });
        } else {
          const treePaths = await getPathTree(relPath.split("/"));
          const uuid = await _insert_dir_paths(treePaths, status);
          resolve(uuid);
        }
      }
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

export const _insert_directory_tree = (path, isFile, status) =>
  new Promise(async (resolve, reject) => {
    const { device, folder, relPath } = get_folder_device_path(path, isFile);

    try {
      const treePaths = await getPathTree(relPath.split("/"));
      await _insert_dir_paths(treePaths, status);
      resolve();
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

export const _insert_file = (fileObj, status) =>
  new Promise(async (resolve, reject) => {
    try {
      const obj_copy = { ...fileObj, sync_status: status };
      delete obj_copy["absPath"];
      await prisma_queue.file.create({
        data: obj_copy,
      });
      resolve(obj_copy);
    } catch (err) {
      reject(err);
      console.log(err);
    }
  });

const _insert_dir_paths = (paths, status) =>
  new Promise(async (resolve, reject) => {
    try {
      let dirs = {};
      for (const path of paths) {
        const absPath = join(SYNC_PATH, path[1]);
        const device =
          path[1].split("/").at(1) === "" ? "/" : path[1].split("/").at(1);
        let dirObj = {
          uuid: uuidv4(),
          folder: path[0],
          path: path[1],
          device: device,
          sync_status: status,
        };

        if (status === "delete") {
          const dir = await prisma.directory.findUnique({
            where: {
              device_folder_path: {
                device,
                folder: path[0],
                path: path[1],
              },
            },
            select: {
              uuid: true,
              created_at: true,
            },
          });
          console.log("Inside the Delete--> and Dir value", dir);
          if (dir) {
            dirObj = { ...dirObj, ...dir };
            dirs[path] = { ...dirObj };
          } else {
            reject(null);
          }
        } else {
          const dir = await prisma_queue.directory.findUnique({
            where: {
              device_folder_path: {
                device,
                folder: path[0],
                path: path[1],
              },
            },
            select: {
              uuid: true,
              created_at: true,
            },
          });
          if (dir) {
            dirObj = { ...dirObj, ...dir };
          } else {
            const created_at = (await stat(absPath)).mtime;
            await prisma_queue.directory.upsert({
              where: {
                device_folder_path: {
                  device,
                  folder: path[0],
                  path: path[1],
                },
              },
              update: { ...dirObj, created_at },
              create: { ...dirObj, created_at },
            });
          }
          dirs[path] = { ...dirObj };
        }
      }

      resolve({ uuid: Object.entries(dirs).at(-1)[1].uuid });
    } catch (err) {
      reject(err);
    }
  });

export const get_folder_device_path = (path, isFile) => {
  const relPathParts = path.split(SYNC_PATH).slice(1).join("/").split("\\");
  let folder = isFile ? relPathParts.at(-2) : relPathParts.at(-1);
  let relPath = !isFile
    ? relPathParts.slice(1).join("/")
    : relPathParts.slice(1, -1).join("/");
  let device = relPathParts.at(1);
  if (relPath === "") {
    folder = "/";
    device = "/";
    relPath = "/";
  } else {
    relPath = "/" + relPath;
  }
  return { folder, device, relPath };
};

export const _get_file_metadata = (path, stats) =>
  new Promise(async (resolve, reject) => {
    const pathParts = path.split(SYNC_PATH).slice(1).join("/").split("\\");
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
          hashvalue: await getFileHash(path),
        };
        resolve(obj);
      } else {
        const file = await prisma.file.findUnique({
          where: {
            path_filename: {
              filename: fileName,
              path: relPath,
            },
          },
        });
        if (file) {
          resolve(file);
        } else {
          reject(null);
        }
      }
    } catch (err) {
      reject(err);
    }
  });

export const get_file_metadata = (obj) =>
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
