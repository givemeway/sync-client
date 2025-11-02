import { prisma, prisma_queue } from "../Config/prismaDBConfig.js";
import { v4 as uuidv4 } from "uuid";

export const buildSyncFolderDB = (files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      // read the local DB
      const [filesObj, dirsObj, filesLength, dirsLength] = await readSyncDB(
        prisma
      );
      // compare the scanned files/folders with the local DB and find which are new or modified
      const [changedFiles, changedDirs] = await compareChangesWithLocalDB(
        prisma,
        filesObj,
        dirsObj,
        files,
        dirs
      );
      // create a new DB with the identified files / folders
      await buildSyncDB(prisma_queue, changedFiles, changedDirs);
      // After these files/folders are synced to cloud update the main DB
      await buildSyncDB(prisma, changedFiles, changedDirs);
      // empty the temp DB that holds the files/folders to be uploaded;
      await delete_db_files_folders(prisma_queue);
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

const buildSyncDB = (db, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      await db.$transaction(async (dbcursor) => {
        await insert_file_directory(dbcursor, files, dirs);
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

const compareChangesWithLocalDB = (prisma, dbFiles, dbDirs, files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      let changedFiles = {};
      let changedDirs = {};
      let dbFilesCopy = { ...dbFiles };
      let filesCopy = { ...files };
      let dirsCopy = { ...dirs };
      let dbDirsCopy = { ...dbDirs };

      for (const [path, fileList] of Object.entries(dbFiles)) {
        for (const [filename, obj] of Object.entries(fileList)) {
          if (files[path] && files[path][filename]) {
            delete dbFilesCopy[path][filename];
            delete filesCopy[path][filename];
            if (Object.entries(dbFilesCopy[path]).length === 0)
              delete dbFilesCopy[path];
            if (Object.entries(filesCopy[path]).length === 0)
              delete filesCopy[path];
          }
        }
      }
      changedFiles = { ...filesCopy, ...dbFilesCopy };
      for (const [path, dirList] of Object.entries(dbDirs)) {
        for (const [folder, obj] of Object.entries(dirList)) {
          if (dirs[path] && dirs[path][folder]) {
            delete dbDirsCopy[path][folder];
            delete dirsCopy[path][folder];
            if (Object.entries(dbDirsCopy[path]).length === 0)
              delete dbDirsCopy[path];
            if (Object.entries(dirsCopy[path]).length === 0)
              delete dirsCopy[path];
          }
        }
      }
      changedDirs = { ...dirsCopy, ...dbDirsCopy };
      changedDirs = Object.fromEntries(
        Object.entries(changedDirs).map(([p, f]) => [p, f[p]])
      );
      let orphanPathArr = [];
      for (const path of Object.keys(changedFiles)) {
        if (!changedDirs[path]) {
          const parts = path.split("/");
          const device = parts[1] === "" ? "/" : parts[1];
          const folder = parts.at(-1) === "" ? "/" : parts.at(-1);
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
      resolve([changedFiles, changedDirs]);
    } catch (err) {
      console.log(err);
      resolve(err);
    }
  });

const createDBWithLocalChanges = (files, dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      await prisma_queue.$transaction(async (prisma) => {
        await insert_file_directory(prisma, files, dirs);
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
    } catch (err) {}
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
        const { uuid, created_at } = await prisma.directory.findUnique({
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
          uuid,
          device,
          folder: pth[0],
          path: pth[1],
          created_at: created_at,
        };
        pathsToInsert.push(dirObj);
      }
      resolve(pathsToInsert);
    } catch (err) {
      console.log(err);
      reject(err);
    }
  });
