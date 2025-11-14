import { createReadStream } from "node:fs";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { getPathTree } from "./buildSyncFolderDB.js";
import { prisma } from "../Config/prismaDBConfig.js";
import os from "os";
const SEP = os.platform() === "win32" ? "\\" : "/";
const MAC_PATH = "/users/sandeep/desktop/sync-folder";
const WIN_PATH = "C:\\Users\\Sandeep Kumar\\Desktop\\sync_folder";
export const SYNC_PATH = os.platform() === "win32" ? WIN_PATH : MAC_PATH;

export const _get_metadata = (filesObj, dirObj) =>
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

// const _get_dirs_queue_db = (db, paths) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       let dirs = [];
//       for (const path of paths) {
//         const { device, folder, relPath } = get_folder_device_path(
//           join(SYNC_PATH, path[1]),
//           false
//         );
//         const dir = await db.directory.findUnique({
//           where: {
//             device_folder_path: {
//               device,
//               folder,
//               path: relPath,
//             },
//           },
//           select: {
//             uuid: true,
//             created_at: true,
//             path: true,
//             device: true,
//             folder: true,
//           },
//         });
//         if (!dir) {
//           reject(null);
//         }
//         dirs.push(dir);
//       }
//       resolve(dirs);
//     } catch (err) {
//       reject(err);
//     }
//   });

// const _insert_dirs_main_db = (prisma, dirs) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       for (const dir of dirs) {
//         await prisma.directory.upsert({
//           where: {
//             device_folder_path: {
//               device: dir.device,
//               folder: dir.folder,
//               path: dir.path,
//             },
//           },
//           update: { ...dir },
//           create: { ...dir },
//         });
//       }
//       resolve();
//     } catch (err) {
//       console.log(err);
//       reject(err);
//     }
//   });
// const _insert_file_main_db = (prisma, fileObj) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       // const dir = await prisma.directory.findFirst({
//       //   where: {
//       //     path: fileObj.path,
//       //   },
//       // });
//       await prisma.file.upsert({
//         where: {
//           path_filename: {
//             path: fileObj.path,
//             filename: fileObj.filename,
//           },
//         },
//         update: {
//           ...fileObj,
//         },
//         create: { ...fileObj },
//       });
//       resolve();
//     } catch (err) {
//       console.error(err);
//       reject(err);
//     }
//   });

// export const _insert_file_folder_main_db = (
//   fileObj,
//   isFile,
//   device = null,
//   folder = null,
//   path = null
// ) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       if (isFile) {
//         const pathParts = fileObj.path.split("/");
//         const paths = await getPathTree(pathParts);
//         const dirs = await _get_dirs_queue_db(prisma_queue, paths);
//         await prisma.$transaction(async (db) => {
//           const fileObjCopy = { ...fileObj };
//           delete fileObjCopy["sync_status"];
//           await _insert_dirs_main_db(db, dirs);
//           await _insert_file_main_db(db, fileObjCopy);
//         });
//       } else {
//         const dir = await prisma_queue.directory.findUniqueOrThrow({
//           where: {
//             device_folder_path: {
//               device,
//               folder,
//               path,
//             },
//           },
//           select: {
//             uuid: true,
//             created_at: true,
//             device: true,
//             folder: true,
//             path: true,
//           },
//         });
//         await prisma.directory.upsert({
//           where: {
//             device_folder_path: { device, folder, path },
//           },
//           update: { ...dir },
//           create: { ...dir },
//         });
//       }
//       resolve();
//     } catch (err) {
//       console.error(err);
//       reject(err);
//     }
//   });

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

// export const _delete_directory = (db, path) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       const relPathParts = path.split(SYNC_PATH).slice(1).join("/").split(SEP);
//       let folder = relPathParts.at(-1);
//       let relPath = relPathParts.slice(1).join("/");
//       let device = relPathParts.at(1);
//       if (relPath === "") {
//         folder = "/";
//         device = "/";
//         relPath = "/";
//       } else {
//         relPath = "/" + relPath;
//       }
//       await db.$transaction(async (prisma) => {
//         await prisma.file.deleteMany({
//           where: {
//             path: relPath,
//           },
//         });
//         await prisma.directory.delete({
//           where: {
//             device_folder_path: {
//               device,
//               folder,
//               path: relPath,
//             },
//           },
//         });
//       });
//       resolve();
//     } catch (err) {
//       console.log(err);
//       reject(err);
//     }
//   });

// export const _get_dirID = (device, folder, relPath, status) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       const dir = await prisma.directory.findUnique({
//         where: {
//           device_folder_path: {
//             device,
//             folder,
//             path: relPath,
//           },
//         },
//         select: {
//           uuid: true,
//         },
//       });
//       if (dir) {
//         resolve({ uuid: dir.uuid });
//       } else {
//         const dir = await prisma_queue.directory.findUnique({
//           where: {
//             device_folder_path: {
//               device,
//               folder,
//               path: relPath,
//             },
//           },
//         });
//         if (dir) {
//           resolve({ uuid: dir.uuid });
//         } else {
//           const treePaths = await getPathTree(relPath.split("/"));
//           const uuid = await _insert_dir_paths(treePaths, status);
//           resolve(uuid);
//         }
//       }
//     } catch (err) {
//       console.error(err);
//       reject(err);
//     }
//   });

// export const _insert_directory_tree = (path, isFile, status) =>
//   new Promise(async (resolve, reject) => {
//     const { device, folder, relPath } = get_folder_device_path(path, isFile);

//     try {
//       const treePaths = await getPathTree(relPath.split("/"));
//       await _insert_dir_paths(treePaths, status);
//       resolve();
//     } catch (err) {
//       console.error(err);
//       reject(err);
//     }
//   });

// export const _delete_file_main_db = (file) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       await prisma.file.delete({
//         where: {
//           path_filename: {
//             path: file.path,
//             filename: file.filename,
//           },
//         },
//       });
//       resolve();
//     } catch (err) {
//       reject(err);
//     }
//   });

// export const _delete_dir_main_db = (path, device, folder) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       await prisma.$transaction(async (prisma) => {
//         await prisma.file.deleteMany({
//           where: {
//             OR: [{ path: path }, { path: { startsWith: path + "/" } }],
//           },
//         });
//         await prisma.directory.delete({
//           where: {
//             device_folder_path: {
//               path,
//               device,
//               folder,
//             },
//           },
//         });
//       });

//       resolve();
//     } catch (err) {
//       console.log(err);
//       reject(err);
//     }
//   });

// export const _insert_file_queue_db = (fileObj, relPath, status) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       let dirID = null;
//       let obj_copy = { ...fileObj, dirID, sync_status: status };
//       delete obj_copy["absPath"];

//       if (status === "delete") {
//         const file = await prisma.file.findUnique({
//           where: {
//             path_filename: {
//               path: fileObj.path,
//               filename: fileObj.filename,
//             },
//           },
//         });
//         obj_copy = { ...obj_copy, ...file };
//       }

//       await prisma_queue.$transaction(async (db) => {
//         // if (!dirID) {
//         const treePaths = await getPathTree(relPath.split("/"));
//         const dir = await _insert_dirs_queue_db(db, treePaths, status, false);
//         dirID = dir.uuid;
//         // }
//         obj_copy.dirID = dirID;
//         await db.file.upsert({
//           where: {
//             path_filename: {
//               path: obj_copy.path,
//               filename: obj_copy.filename,
//             },
//           },
//           update: { ...obj_copy },
//           create: { ...obj_copy },
//         });
//       });

//       resolve(obj_copy);
//     } catch (err) {
//       reject(err);
//       console.log(err);
//     }
//   });

// export const _insert_dirs_queue_db = (db, paths, status, isFolder = true) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       let dirs = {};
//       for (const [folder, path] of paths) {
//         const absPath = join(SYNC_PATH, path);
//         const device =
//           path.split("/").at(1) === "" ? "/" : path.split("/").at(1);
//         let dirObj = {
//           uuid: uuidv4(),
//           folder: folder,
//           path: path,
//           device: device,
//           sync_status: status,
//         };
//         const dir = await db.directory.findUnique({
//           where: {
//             device_folder_path: {
//               device,
//               folder: folder,
//               path: path,
//             },
//           },
//           select: {
//             uuid: true,
//             created_at: true,
//           },
//         });
//         if (dir) {
//           dirObj = { ...dirObj, ...dir };
//         } else {
//           const created_at = (await stat(absPath)).mtime;
//           await db.directory.upsert({
//             where: {
//               device_folder_path: {
//                 device,
//                 folder: folder,
//                 path: path,
//               },
//             },
//             update: { ...dirObj, created_at },
//             create: { ...dirObj, created_at },
//           });
//         }
//         if (isFolder) {
//           const files = await db.file.findMany({
//             where: { path: path },
//           });

//           for (const file of files) {
//             await db.file.update({
//               where: {
//                 path_filename: {
//                   path: file.path,
//                   filename: file.filename,
//                 },
//               },
//               data: { ...file, sync_status: status },
//             });
//           }
//         }
//         dirs[path] = { ...dirObj };
//       }
//       resolve({ uuid: Object.entries(dirs).at(-1)[1].uuid });
//     } catch (err) {
//       reject(err);
//     }
//   });

// export const _insert_dir_paths = (paths, status) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       let dirs = {};
//       for (const path of paths) {
//         const absPath = join(SYNC_PATH, path[1]);
//         const device =
//           path[1].split("/").at(1) === "" ? "/" : path[1].split("/").at(1);
//         let dirObj = {
//           uuid: uuidv4(),
//           folder: path[0],
//           path: path[1],
//           device: device,
//           sync_status: status,
//         };

//         if (status === "delete") {
//           const dir = await prisma.directory.findUnique({
//             where: {
//               device_folder_path: {
//                 device,
//                 folder: path[0],
//                 path: path[1],
//               },
//             },
//             select: {
//               uuid: true,
//               created_at: true,
//             },
//           });
//           if (dir) {
//             dirObj = { ...dirObj, ...dir };
//             dirs[path] = { ...dirObj };
//           } else {
//             reject(null);
//           }
//         } else {
//           const dir = await prisma_queue.directory.findUnique({
//             where: {
//               device_folder_path: {
//                 device,
//                 folder: path[0],
//                 path: path[1],
//               },
//             },
//             select: {
//               uuid: true,
//               created_at: true,
//             },
//           });
//           if (dir) {
//             dirObj = { ...dirObj, ...dir };
//           } else {
//             const created_at = (await stat(absPath)).mtime;
//             await prisma_queue.directory.upsert({
//               where: {
//                 device_folder_path: {
//                   device,
//                   folder: path[0],
//                   path: path[1],
//                 },
//               },
//               update: { ...dirObj, created_at },
//               create: { ...dirObj, created_at },
//             });
//           }
//           dirs[path] = { ...dirObj };
//         }
//       }

//       resolve({ uuid: Object.entries(dirs).at(-1)[1].uuid });
//     } catch (err) {
//       reject(err);
//     }
//   });

export const get_folder_device_path = (path, isFile) => {
  const relPathParts = path.split(SYNC_PATH).slice(1).join("/").split(SEP);
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
          hashvalue: await getFileHash(path),
          inode: stats.ino.toString(),
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
        resolve(file);
      }
    } catch (err) {
      reject(err);
    }
  });

// export const _get_file_change_state = (file) =>
//   new Promise(async (resolve, reject) => {
//     try {
//       const fileObj = await prisma.file.findUnique({
//         where: {},
//       });
//       let fileObjCopy = { ...file };
//       if (
//         fileObj &&
//         fileObj.inode === file.inode &&
//         fileObj.size === file.size &&
//         fileObj.last_modified === file.last_modified &&
//         fileObj.hashvalue === file.hashvalue &&
//         fileObj.filename !== file.filename
//       ) {
//         fileObjCopy["sync_status"] = "renamed";
//       } else if (
//         fileObj &&
//         fileObj.filename === file.filename &&
//         fileObj.hashvalue !== file.hashvalue &&
//         fileObj.inode === file.inode
//       ) {
//         fileObjCopy["sync_status"] = "modified";
//       }
//     } catch (error) {
//       console.log(error);
//     }
//   });

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

export const _remove_file_main_db = (db, file) =>
  new Promise(async (resolve, reject) => {
    try {
      await db.file.delete({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename,
          },
        },
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _remove_dir_main_db = (db, path) =>
  new Promise(async (resolve, reject) => {
    try {
      const { relPath } = get_folder_device_path(path, false);
      await db.file.deleteMany({
        where: {
          OR: [{ path: relPath }, { path: { startsWith: relPath + "/" } }],
        },
      });
      await db.directory.deleteMany({
        where: {
          OR: [{ path: relPath }, { path: { startsWith: relPath + "/" } }],
        },
      });

      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _remove_file_queue_db = (db, file) =>
  new Promise(async (resolve, reject) => {
    try {
      await db.fileQueue.upsert({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename,
          },
        },
        update: { ...file, sync_status: "delete" },
        create: { ...file, sync_status: "delete" },
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _remove_dir_queue_db = (db, path) =>
  new Promise(async (resolve, reject) => {
    try {
      const { relPath } = get_folder_device_path(path, false);
      const queueFiles = await db.fileQueue.findMany({
        where: { path: relPath },
      });
      const queueDirs = await db.directoryQueue.findMany({
        where: {
          OR: [{ path: relPath }, { path: { startsWith: relPath + "/" } }],
        },
      });

      if (queueDirs) {
        for (const queueDir of queueDirs) {
          await db.directoryQueue.upsert({
            where: {
              device_folder_path: {
                device: queueDir.device,
                path: queueDir.path,
                folder: queueDir.folder,
              },
            },
            update: { ...queueDir, sync_status: "delete" },
            create: { ...queueDir, sync_status: "delete" },
          });
        }
      }
      if (queueFiles) {
        for (const file of queueFiles) {
          await db.fileQueue.upsert({
            where: {
              path_filename: {
                path: file.path,
                filename: file.filename,
              },
            },
            update: {
              ...file,
              sync_status: "delete",
            },
            create: {
              ...file,
              sync_status: "delete",
            },
          });
        }
      }

      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _add_dir_main_db = (db, dir) =>
  new Promise(async (resolve, reject) => {
    try {
      const dirObj = { ...dir };
      delete dirObj["sync_status"];
      const upsertDir = await db.directory.upsert({
        where: {
          device_folder_path: {
            device: dir.device,
            folder: dir.device,
            path: dir.path,
          },
        },
        update: { ...dirObj },
        create: { ...dirObj },
      });
      resolve(upsertDir);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _add_file_main_db = (db, dirs, file) =>
  new Promise(async (resolve, reject) => {
    try {
      const insertedDirs = [];
      for (const dir of dirs) {
        const dirCopy = { ...dir };
        delete dirCopy["sync_status"];
        const upsertDir = await db.directory.upsert({
          where: {
            device_folder_path: {
              device: dir.device,
              folder: dir.folder,
              path: dir.path,
            },
          },
          update: { ...dirCopy },
          create: { ...dirCopy },
        });
        insertedDirs.push(upsertDir);
      }
      const dirID = insertedDirs.at(-1).uuid;
      const fileObj = { ...file, dirID };
      delete fileObj["absPath"];

      const upsertFile = await db.file.upsert({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename,
          },
        },
        update: { ...fileObj },
        create: { ...fileObj },
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _add_dir_queue_db = (db, path) =>
  new Promise(async (resolve, reject) => {
    try {
      const { device, folder, relPath } = get_folder_device_path(path, false);
      let dirObj = {
        uuid: uuidv4(),
        path: relPath,
        folder,
        device,
        sync_status: "new",
      };
      const dir = await db.directory.findUnique({
        where: {
          device_folder_path: {
            device,
            folder,
            path: relPath,
          },
        },
      });
      if (dir) {
        dirObj = { ...dir, sync_status: "existing" };
      }
      if (!dir) {
        const dirQueue = await db.directoryQueue.findUnique({
          where: {
            device_folder_path: {
              device,
              folder,
              path: relPath,
            },
          },
        });
        if (dirQueue) dirObj = { ...dirQueue };
        else {
          const absPath = join(SYNC_PATH, relPath);
          dirObj.created_at = (await stat(absPath)).mtime;
        }
      }
      const upsertDir = await db.directoryQueue.upsert({
        where: {
          device_folder_path: {
            device,
            folder,
            path: relPath,
          },
        },
        update: { ...dirObj },
        create: { ...dirObj },
      });
      resolve(upsertDir);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _update_file_queue_db = (db, file) =>
  new Promise(async (resolve, reject) => {
    try {
      const fileCopy = { ...file };
      delete fileCopy["absPath"];
      const { dirID } = await db.file.findUnique({
        where: {
          path_filename: {
            path: fileCopy.path,
            filename: fileCopy.filename,
          },
        },
        select: {
          dirID: true,
        },
      });
      await db.fileQueue.upsert({
        where: {
          path_filename: {
            path: fileCopy.path,
            filename: fileCopy.filename,
          },
        },
        update: {
          ...fileCopy,
          dirID,
          sync_status: "modified",
        },
        create: {
          ...fileCopy,
          dirID,
          sync_status: "modified",
        },
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _update_file_main_db = (db, file) =>
  new Promise(async (resolve, reject) => {
    try {
      const fileCopy = { ...file };
      delete fileCopy["absPath"];
      const { dirID } = await db.file.findUnique({
        where: {
          path_filename: {
            path: fileCopy.path,
            filename: fileCopy.filename,
          },
        },
        select: {
          dirID: true,
        },
      });
      await db.file.upsert({
        where: {
          path_filename: {
            path: fileCopy.path,
            filename: fileCopy.filename,
          },
        },
        update: {
          ...fileCopy,
          dirID,
        },
        create: {
          ...fileCopy,
          dirID,
        },
      });
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

export const _add_file_queue_db = (db, file) =>
  new Promise(async (resolve, reject) => {
    try {
      const pathParts = file.path.split("/");
      const dirParts = await getPathTree(pathParts);
      const dirObjArr = [];
      for (const [folder, path] of dirParts) {
        const { device } = get_folder_device_path(file.absPath, true);
        const dirMain = await db.directory.findUnique({
          where: {
            device_folder_path: {
              device,
              folder,
              path,
            },
          },
        });
        let dirObj = {
          uuid: uuidv4(),
          path,
          device,
          folder,
          sync_status: "new",
        };

        if (dirMain) {
          dirObj = { ...dirMain, sync_status: "existing" };
        }
        if (!dirMain) {
          const dirQueue = await db.directoryQueue.findUnique({
            where: {
              device_folder_path: {
                device,
                folder,
                path,
              },
            },
          });
          if (dirQueue) dirObj = { ...dirQueue };
          else {
            const absPath = join(SYNC_PATH, path);
            dirObj.created_at = (await stat(absPath)).mtime;
          }
        }

        const dir = await db.directoryQueue.upsert({
          where: {
            device_folder_path: {
              device,
              path,
              folder,
            },
          },
          update: {
            ...dirObj,
          },
          create: {
            ...dirObj,
          },
        });
        dirObjArr.push(dir);
      }
      const fileCopy = {
        ...file,
        sync_status: "new",
        dirID: dirObjArr.at(-1).uuid,
      };
      delete fileCopy.absPath;
      await db.fileQueue.upsert({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename,
          },
        },
        update: { ...fileCopy },
        create: { ...fileCopy },
      });
      resolve(dirObjArr);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
