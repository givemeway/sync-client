import { prisma, prisma_queue } from "../Config/prismaDBConfig.js";
import { get_directory_status } from "./get_file_folder_metadata.js";

export const update_main_queue_db = (files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      await prisma.$transaction(async (prisma) => {
        await update_db(prisma, files, dirs);
      });
      await prisma_queue.$transaction(async (prisma) => {
        await update_db(prisma, files, dirs);
      });
      resolve();
    } catch (err) {
      reject(err);
    }
  });

export const buildSyncFolderDB = (files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      // read the local DB
      const [filesObj, dirsObj] = await readSyncDB(prisma);
      const updatedFiles = await get_modified_files(filesObj, files);
      // compare the scanned files/folders with the local DB and find which are new or modified

      const [changedFiles, changedDirs] = await compareChangesWithLocalDB(
        prisma,
        filesObj,
        dirsObj,
        files,
        dirs,
        updatedFiles
      );
      // create a new DB with the identified files / folders
      // Build the sync DB that will be used to sync to cloud
      await update_queue_db(changedFiles, changedDirs);
      // After these files/folders are synced to cloud update the main DB
      await build_main_sync_db(prisma, changedFiles, changedDirs);
      // empty the temp DB that holds the files/folders to be uploaded;
      // await delete_db_files_folders(prisma_queue);
      // Monitor the FileSystem and any changes detected update in new DB
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

const delete_db_files_folders = (dbCursor) =>
  new Promise(async (resolve, reject) => {
    try {
      await dbCursor.$transaction([
        dbCursor.file.deleteMany({}),
        dbCursor.directory.deleteMany({}),
      ]);
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

const build_main_sync_db = (db, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      const toBeDeletedFiles = Object.entries(files)
        .flatMap(([path, filesObj]) =>
          Object.entries(filesObj)
            .filter(([filename, fileObj]) => fileObj.sync_status === "delete")
            .map((a) => ({ ...a[1] }))
        )
        .flat();
      const tobeDeletedDirs = Object.entries(dirs)
        .filter(([_, dirObj]) => dirObj.sync_status === "delete")
        .map((a) => ({ ...a[1] }));
      const toBeInsertfiles = Object.entries(files)
        .flatMap(([_, filesObj]) =>
          Object.entries(filesObj)
            .filter(([_, fileObj]) => fileObj.sync_status !== "delete")
            .map(([_, obj]) => ({
              filename: obj.filename,
              path: obj.path,
              dirID: obj.dirID,
              hashvalue: obj.hashvalue,
              size: obj.size,
              last_modified: obj.last_modified,
            }))
        )
        .flat();
      const toBeInsertedDirs = Object.entries(dirs)
        .filter(([_, dirObj]) => dirObj.sync_status !== "delete")
        .map(([_, obj]) => ({
          uuid: obj.uuid,
          device: obj.device,
          folder: obj.device,
          path: obj.path,
          created_at: obj.created_at,
        }));
      console.log("toBeDeletedFiles: ", toBeDeletedFiles);
      console.log("tobeDeletedDirs : ", tobeDeletedDirs);
      console.log("toBeInsertfiles : ", toBeInsertfiles);
      console.log("toBeInsertedDirs: ", toBeInsertedDirs);
      await db.$transaction(async (prisma) => {
        await delete_fileItems_db(prisma, toBeDeletedFiles);
        await delete_dirItems_db(prisma, tobeDeletedDirs);
        await update_db(prisma, toBeInsertfiles, toBeInsertedDirs);
      });
      resolve();
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

const readSyncDB = (prisma) =>
  new Promise(async (resolve, reject) => {
    try {
      const [files, dirs] = await prisma.$transaction([
        prisma.file.findMany({}),
        prisma.directory.findMany({}),
      ]);
      let filesObj = {};
      let dirsObj = {};
      for (const file of files) {
        if (filesObj[file.path]) {
          filesObj[file.path] = {
            ...filesObj[file.path],
            [file.filename]: { ...file },
          };
        } else {
          filesObj[file.path] = { [file.filename]: { ...file } };
        }
      }
      for (const dir of dirs) {
        if (dirsObj[dir.path]) {
          dirsObj[dir.path] = {
            ...dirsobj[dir.path],
            [dir.path]: { ...dir },
          };
        } else {
          dirsObj[dir.path] = { [dir.path]: { ...dir } };
        }
      }
      resolve([filesObj, dirsObj, files.length, dirs.length]);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

const get_modified_files = (dbFiles, files) =>
  new Promise(async (resolve, reject) => {
    try {
      let updatedFiles = {};
      for (const [path, filesObj] of Object.entries(files)) {
        for (const [filename, fileObj] of Object.entries(filesObj)) {
          if (
            dbFiles[path] &&
            dbFiles[path][filename] &&
            dbFiles[path][filename].hashvalue !== fileObj.hashvalue
          ) {
            if (updatedFiles[path]) {
              updatedFiles[path][filename] = {
                ...fileObj,
                sync_status: "modified",
              };
            } else {
              updatedFiles[path] = {
                [filename]: { ...fileObj, sync_status: "modified" },
              };
            }
          }
        }
      }
      resolve({ ...files, ...updatedFiles });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

const get_files_dirID = (db, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      let filesCopy = { ...files };
      for (const [path, filesObj] of Object.entries(files)) {
        const parts = path.split("/");
        const device = parts[1] === "" ? "/" : parts[1];
        const folder = parts.at(-1) === "" ? "/" : parts.at(-1);
        const dir = await prisma.directory.findUnique({
          where: {
            device_folder_path: {
              device,
              folder,
              path,
            },
          },
          select: {
            uuid: true,
          },
        });
        if (dir) {
          for (const [filename, fileObj] of Object.entries(filesObj)) {
            filesCopy[path][filename] = { ...fileObj, dirID: dir.uuid };
          }
        } else {
          for (const [filename, fileObj] of Object.entries(filesObj)) {
            filesCopy[path][filename] = {
              ...fileObj,
              dirID: dirs[path]["uuid"],
            };
          }
        }
      }
      resolve(filesCopy);
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

const compareChangesWithLocalDB = (
  prisma,
  dbFiles,
  dbDirs,
  files,
  dirs,
  updatedFiles
) =>
  new Promise(async (resolve, reject) => {
    try {
      let changedFiles = {};
      let changedDirs = {};
      let dbFilesCopy = { ...dbFiles };
      let filesCopy = { ...files };
      let dirsCopy = { ...dirs };
      let dbDirsCopy = { ...dbDirs };
      let keystoDeleteDbFilesCopy = [];
      let keystoDeleteFilesCopy = [];
      let keystoDeleteDbDirsCopy = [];
      let keystoDeleteDirsCopy = [];

      for (const [path, fileList] of Object.entries(dbFiles)) {
        for (const [filename, obj] of Object.entries(fileList)) {
          if (files[path] && files[path][filename]) {
            delete dbFilesCopy[path][filename];
            delete filesCopy[path][filename];
          }
        }

        if (dbFilesCopy[path] && Object.entries(dbFilesCopy[path]).length === 0)
          keystoDeleteDbFilesCopy.push(path);
        if (filesCopy[path] && Object.entries(filesCopy[path]).length === 0)
          keystoDeleteFilesCopy.push(path);
      }
      for (const key of keystoDeleteDbFilesCopy) {
        delete dbFilesCopy[key];
      }
      for (const key of keystoDeleteFilesCopy) {
        delete filesCopy[key];
      }

      for (const [path, fileList] of Object.entries(dbFilesCopy)) {
        for (const [filename, obj] of Object.entries(fileList)) {
          let sync_status = "delete";
          dbFilesCopy[path][filename] = { ...obj, sync_status };
        }
      }
      for (const [path, fileList] of Object.entries(filesCopy)) {
        for (const [filename, obj] of Object.entries(fileList)) {
          let sync_status = "new";
          filesCopy[path][filename] = { ...obj, sync_status };
        }
      }

      for (const [path, fileList] of Object.entries(filesCopy)) {
        changedFiles[path] = { ...changedFiles[path], ...fileList };
      }
      for (const [path, fileList] of Object.entries(dbFilesCopy)) {
        changedFiles[path] = { ...changedFiles[path], ...fileList };
      }
      for (const [path, fileList] of Object.entries(updatedFiles)) {
        changedFiles[path] = { ...changedFiles[path], ...fileList };
      }

      for (const [path, fileList] of Object.entries(changedFiles)) {
        if (Object.entries(fileList).length === 0) {
          delete changedFiles[path];
        }
      }
      for (const [path, dirList] of Object.entries(dbDirs)) {
        for (const [folder, _] of Object.entries(dirList)) {
          if (dirs[path] && dirs[path][folder]) {
            delete dbDirsCopy[path][folder];
            delete dirsCopy[path][folder];
          }
        }
        if (dbDirsCopy[path] && Object.entries(dbDirsCopy[path]).length === 0) {
          keystoDeleteDbDirsCopy.push(path);
        }
        if (dirsCopy[path] && Object.entries(dirsCopy[path]).length === 0) {
          keystoDeleteDirsCopy.push(path);
        }
      }

      for (const key of keystoDeleteDbDirsCopy) {
        delete dbDirsCopy[key];
      }
      for (const key of keystoDeleteDirsCopy) {
        delete dirsCopy[key];
      }
      for (const [path, fileList] of Object.entries(dirsCopy)) {
        changedDirs[path] = { ...changedDirs[path], ...fileList };
      }
      for (const [path, fileList] of Object.entries(dbDirsCopy)) {
        changedDirs[path] = { ...changedDirs[path], ...fileList };
      }

      changedDirs = Object.fromEntries(
        Object.entries(changedDirs).map(([p, f]) => [p, f[p]])
      );

      let orphanPathArr = [];
      for (const path of Object.keys(changedFiles)) {
        if (!changedDirs[path]) {
          const parts = path.split("/");
          const device = parts[1] === "" ? "/" : parts[1];
          const pathparts = getPathTree(parts);
          const orphanPath = await get_orphan_file_directory(
            prisma,
            pathparts,
            device
          );
          orphanPathArr.push(...orphanPath);
        }
      }
      for (const dirObj of orphanPathArr) {
        if (!changedDirs[dirObj.path]) {
          changedDirs[dirObj.path] = dirObj;
        }
      }
      changedDirs = await get_directory_status(changedDirs);
      changedFiles = await get_files_dirID(prisma, changedFiles, changedDirs);
      resolve([changedFiles, changedDirs]);
    } catch (err) {
      console.log(err);
      resolve(err);
    }
  });

const update_db = (db, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      for (const dir of dirs) {
        await db.directory.upsert({
          where: {
            device_folder_path: {
              device: dir.device,
              folder: dir.folder,
              path: dir.path,
            },
          },
          update: { ...dir },
          create: { ...dir },
        });
      }
      for (const file of files) {
        await db.file.upsert({
          where: {
            path_filename: {
              filename: file.filename,
              path: file.path,
            },
          },
          update: {
            ...file,
          },
          create: {
            ...file,
          },
        });
      }
      resolve();
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

const update_queue_db = (files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      await prisma_queue.$transaction(async (prisma) => {
        const filesArray = Object.entries(files).flatMap(([_, filesObj]) =>
          Object.entries(filesObj).flatMap(([_, fileObj]) => ({
            ...fileObj,
          }))
        );
        const dirsArray = Object.entries(dirs).flatMap(([_, dirObj]) => ({
          ...dirObj,
        }));
        await update_db(prisma, filesArray, dirsArray);
      });
      resolve();
    } catch (error) {
      console.log(error);
      reject(error);
    }
  });

const insertFiles = (files) =>
  new Promise(async (resolve, reject) => {
    try {
    } catch (err) { }
  });

const delete_dirItems_db = (db, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      for (const dir of dirs) {
        await prisma.file.deleteMany({
          where: {
            path: dir.path,
          },
        });
        await prisma.directory.delete({
          where: {
            uuid: dir.uuid,
          },
        });
      }

      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

const delete_fileItems_db = (db, files) =>
  new Promise(async (resolve, reject) => {
    try {
      for (const file of files) {
        await db.file.delete({
          where: {
            path_filename: {
              path: file.path,
              filename: file.filename,
            },
          },
        });
      }
      resolve();
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });

const insert_file_directory = (db, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      const dirsArr = Object.entries(dirs);
      for (const [path, dir] of dirsArr) {
        let dirFiles = files[path];
        try {
          await db.directory.create({ data: { ...dir } });
          if (dirFiles) {
            dirFiles = Object.entries(dirFiles).map(([_, file]) => ({
              ...file,
              dirID: dir.uuid,
            }));
            await db.file.createMany({
              data: dirFiles,
            });
          }
        } catch (err) {
          if (err.code === "P2002") {
            const parts = path.split("/");
            const device = parts[1] === "" ? "/" : parts[1];
            const folder = parts.at(-1) === "" ? "/" : parts.at(-1);

            const { uuid } = await db.directory.findUnique({
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
            dirFiles = Object.entries(dirFiles).map(([_, file]) => ({
              ...file,
              dirID: uuid,
            }));
            await db.file.createMany({
              data: dirFiles,
            });
          } else {
            reject(err);
            break;
          }
        }
      }
      resolve();
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });

const insertFile = async (prisma, data) => {
  const { device, folder, path, insertData } = data;
  const directory = await prisma.directory.findUnique({
    where: {
      username_device_folder_path: {
        device,
        path,
        folder: folder,
      },
    },
    select: {
      uuid: true,
    },
  });
  if (directory !== null) {
    await prisma.file.create({
      data: {
        ...insertData,
        directoryID: {
          connect: {
            uuid: directory.uuid,
          },
        },
      },
    });
  }
};

export const getPathTree = (pathParts) => {
  return pathParts
    .map((part, idx) => [
      part === "" ? "/" : part,
      pathParts.slice(0, idx + 1).join("/"),
    ])
    .slice(1);
};

export const get_orphan_file_directory = (prisma, paths, device) =>
  new Promise(async (resolve, reject) => {
    try {
      let pathsToInsert = [];
      for (const pth of paths) {
        const dir = await prisma.directory.findUnique({
          where: {
            device_folder_path: {
              device: device,
              path: pth[1],
              folder: pth[0],
            },
          },
          select: {
            uuid: true,
            created_at: true,
          },
        });

        const dirObj = {
          uuid: dir.uuid,
          device,
          folder: pth[0],
          path: pth[1],
          created_at: dir.created_at,
        };
        pathsToInsert.push(dirObj);
      }
      resolve(pathsToInsert);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
