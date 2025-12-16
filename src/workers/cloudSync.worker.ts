import { parentPort, workerData } from "worker_threads";
import { PrismaClient, File, Directory } from "../../DB/prisma-client/index.js";
import { ApiClient } from "../core/ApiClient.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { ReconciliationService } from "../core/ReconciliationService.js";
import type { DirectoryMetadata } from "../types/index.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import { join, parse, dirname } from "node:path";
import os from "node:os";
// Configuration from main thread
const { apiUrl, userEmail, syncPath } = workerData;
// Initialize services
const prisma = new PrismaClient();
const apiClient = new ApiClient(apiUrl, userEmail);
const dbManager = new DatabaseManager(prisma, syncPath);
const reconciliationService = new ReconciliationService(
  apiClient,
  dbManager,
  prisma,
  syncPath
);

let isSyncing: boolean = false;
const POLLING_INTERVAL = 30000; // 30 seconds

function getDirDevicePath(path: string): {
  directory: string;
  folder: string;
  device: string;
} {
  if (typeof path === "string") {
    let directory, device, folder;
    const deviceParts = path.split(/[/\\]/g).slice(1);
    device = deviceParts[0] === "" ? "/" : deviceParts[0];
    folder = deviceParts.at(-1) === "" ? "/" : deviceParts.at(-1);
    const dirParts = path.split(/[/\\]/g).slice(2).join("/");
    directory = dirParts === "" ? "/" : dirParts;
    return { directory, folder: folder || "/", device };
  } else {
    throw Error("Path should be a string");
  }
}

async function log(message: string) {
  parentPort?.postMessage({ type: "log", message });
}

async function error(message: string) {
  parentPort?.postMessage({ type: "error", message });
}

async function processQueue() {
  try {
    // 1. Process Directory Queue (Create/Delete folders)
    const dirQueue = await prisma.directoryQueue.findMany({
      orderBy: { created_at: "asc" },
    });

    for (const dir of dirQueue) {
      if (dir.sync_status === "new") {
        await log(`Creating folder on cloud: ${dir.path}`);
        try {
          // map DirectoryQueue to DirectoryMetadata
          const dirMeta: DirectoryMetadata = {
            uuid: dir.uuid,
            path: dir.path,
            folder: dir.folder,
            device: dir.device,
            created_at: dir.created_at,
            absPath: dir.absPath,
            inode: dir.inode || undefined,
            sync_status: "new",
            old_path: dir.old_path || undefined,
          };
          await apiClient.createFolder(dirMeta);
          // Update status to synced (remove from queue or mark as synced)
          // For now, let's assume we remove from queue and add to main DB if not exists
          await prisma.directoryQueue.delete({ where: { uuid: dir.uuid } });
          // Upsert to main DB is handled by DatabaseManager usually, but here we might need to do it manually or assume it's already there?
          // Actually, the queue is for pending actions. Once done, we remove.
        } catch (err: any) {
          await error(`Failed to create folder ${dir.path}: ${err.message}`);
        }
      } else if (dir.sync_status === "delete") {
        await log(`Deleting folder on cloud: ${dir.path}`);
        try {
          const dirMeta: DirectoryMetadata = {
            uuid: dir.uuid,
            path: dir.path,
            folder: dir.folder,
            device: dir.device,
            created_at: dir.created_at,
            absPath: dir.absPath,
            inode: dir.inode || undefined,
            sync_status: "delete",
            old_path: dir.old_path || undefined,
          };
          await apiClient.deleteFolder(dirMeta);
          await prisma.fileQueue.deleteMany({
            where: { dirID: dir.uuid },
          });
          await prisma.directoryQueue.delete({ where: { uuid: dir.uuid } });
        } catch (err: any) {
          await error(`Failed to delete folder ${dir.path}: ${err.message}`);
        }
      } else if (dir.sync_status === "FILE_LINKED") {
        const filesInQueue = await prisma.fileQueue.findMany({ where: { dirID: dir.uuid } })
        if (filesInQueue.length === 0) {
          await prisma.directoryQueue.delete({ where: { uuid: dir.uuid } })
        }
      }
    }

    // 2. Process File Queue (Upload/Delete)
    const fileQueue = await prisma.fileQueue.findMany({
      orderBy: { last_modified: "asc" },
    });
    for (const file of fileQueue) {
      // Map Prisma FileQueue to FileMetadata
      if (file.sync_status === "new" || file.sync_status === "modified") {
        try {
          await log(`Uploading file: ${file.filename}`);
          const result = await apiClient.uploadFile(file);
          if (result.success) {
            await log(`✅ Uploaded: ${file.filename}`);
            // Remove from queue
            await prisma.file.update({
              where: { path_filename: { path: file.path, filename: file.filename } },
              data: { lastSyncedHashValue: file.hashvalue }
            });
            await prisma.fileQueue.delete({
              where: {
                path_filename: {
                  path: file.path,
                  filename: file.filename,
                },
              },
            });
            const filesInQueue = await prisma.fileQueue.findMany({ where: { dirID: file.dirID } })
            if (filesInQueue.length === 0) {
              await prisma.directoryQueue.delete({ where: { uuid: file.dirID } });
            }
            // Ensure it's in main DB (it should be added by DatabaseManager already, but we confirm sync)
          } else {
            await error(
              `❌ Upload failed for ${file.filename}: ${result.error}`
            );
          }
        } catch (err: any) {
          await error(`❌ Delete failed for ${file.filename}: ${err.message}`);
        }
      } else if (file.sync_status === "delete") {
        await log(`Deleting file from cloud: ${file.filename}`);
        try {
          const result = await apiClient.deleteFile(file);
          if (result.success) {
            await log(`✅ Deleted from cloud: ${file.filename}`);
            await prisma.fileQueue.delete({
              where: {
                path_filename: {
                  path: file.path,
                  filename: file.filename,
                },
              },
            });
          } else {
            await error(
              `❌ File Delete from cloud failed for ${file.filename}: ${result.error}`
            );
          }
        } catch (err: any) {
          await error(`❌ Delete failed for ${file.filename}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    await error(`Queue processing error: ${err.message}`);
  }
  isSyncing = false;
}
async function pollCloud() {
  try {
    // await log('Polling cloud for changes...');
    const metadata = await apiClient.getMetadata();

    if (metadata.success && metadata.files && metadata.directories) {
      // Get local state
      const dbFiles = await prisma.file.findMany();
      const dbDirs = await prisma.directory.findMany();
      console.log("dBFiles count: ", dbFiles.length);
      console.log("CloudFiles count: ", metadata.files.length);
      // Run Reconciliation
      const {
        filesToDownload,
        filesToDeleteLocal,
        foldersToCreateLocal,
        foldersToDeleteLocal,
        filesInConflict,
        filesToUpdate,
      } = await reconciliationService.reconcile(
        metadata.files,
        metadata.directories,
        dbFiles,
        dbDirs
      );
      console.log("FoldersToDelete: ", foldersToDeleteLocal);
      // Handle Reconciliation Results
      // 1. Download Files
      if (filesToDownload && filesToDownload.length > 0) {
        for (const file of filesToDownload) {
          const localPath = join(syncPath, file.path);
          const { device, folder } = getDirDevicePath(file.path);
          // Ensure directory exists
          await fs.promises.mkdir(localPath, { recursive: true });
          const { ino, mtime } = await fs.promises.stat(localPath);
          await log(`⬇️ Downloading: ${file.filename}`);
          const dstPath = join(syncPath, file.path, file.filename);
          try {
            const status = await apiClient.downloadFile(file, dstPath);
            if (status && status.success) {
              await log(`✅ Downloaded: ${file.filename}`);
              let fileObj = {
                path: file.path,
                filename: file.filename,
                absPath: dstPath,
                size: file.size,
                last_modified: file.last_modified,
                hashvalue: file.hashvalue || "",
                inode: status.ino.toString(), // Placeholder
                uuid: file.uuid || uuidv4(),
                origin: file.origin,
                versions: file.versions,
                lastSyncedHashValue: file.hashvalue,
              };
              const fileExists = await prisma.file.findUnique({
                where: {
                  path_filename: { path: file.path, filename: file.filename },
                },
              });

              if (!fileExists) {
                await prisma.file.create({
                  data: {
                    ...fileObj,
                    directoryID: {
                      connectOrCreate: {
                        where: {
                          device_folder_path: {
                            device: device, // Placeholder
                            folder: folder, // Placeholder
                            path: file.path,
                          },
                        },
                        create: {
                          uuid: uuidv4(),
                          device: device, // Placeholder
                          folder: folder, // Placeholder
                          path: file.path,
                          created_at: mtime,
                          inode: ino.toString(),
                          absPath: localPath,
                        },
                      },
                    },
                  },
                });
              }
              if (fileExists) {
                fileObj = { ...fileObj, ...fileExists };
                await prisma.file.update({
                  where: {
                    path_filename: { path: file.path, filename: file.filename },
                  },
                  data: { ...fileObj },
                });
              }
            } else {
              await error(`❌ Failed to download: ${file.filename}`);
              await fs.promises.unlink(localPath);
            }
          } catch (err: any) {
            await error(
              `❌ Exception during download ${file.filename}: ${err.message}`
            );
          }
          console.log("File downloaded: ", file.filename, file.path);
        }
      }
      if (filesToUpdate && filesToUpdate.length > 0) {
        for (const file of filesToUpdate) {
          const localPath = join(syncPath, file.path);
          const { device, folder } = getDirDevicePath(file.path);
          // Ensure directory exists
          await fs.promises.mkdir(localPath, { recursive: true });
          const { ino, mtime } = await fs.promises.stat(localPath);
          await log(`⬇️ Downloadng updated File: ${file.filename}`);
          const dstPath = join(syncPath, file.path, file.filename);
          try {
            //const deleted = await prisma.file.delete({ where: { path_filename: { path: file.path, filename: file.filename } } })
            //await fs.promises.unlink(dstPath);
            const status = await apiClient.downloadFile(file, dstPath);
            if (status && status.success) {
              let fileObj = {
                path: file.path,
                filename: file.filename,
                absPath: dstPath,
                size: file.size,
                last_modified: file.last_modified,
                hashvalue: file.hashvalue || "",
                inode: status.ino.toString(), // Placeholder
                uuid: file.uuid || uuidv4(),
                origin: file.origin,
                versions: file.versions,
                lastSyncedHashValue: file.hashvalue,
              };
              const upserted = await prisma.file.upsert({
                where: {
                  path_filename: { path: file.path, filename: file.filename },
                },
                update: {
                  ...fileObj,
                  directoryID: {
                    connectOrCreate: {
                      where: {
                        device_folder_path: {
                          device: device, // Placeholder
                          folder: folder, // Placeholder
                          path: file.path,
                        },
                      },
                      create: {
                        uuid: uuidv4(),
                        device: device, // Placeholder
                        folder: folder, // Placeholder
                        path: file.path,
                        created_at: mtime,
                        inode: ino.toString(),
                        absPath: localPath,
                      },
                    },
                  },
                },
                create: {
                  ...fileObj,
                  directoryID: {
                    connectOrCreate: {
                      where: {
                        device_folder_path: {
                          device: device, // Placeholder
                          folder: folder, // Placeholder
                          path: file.path,
                        },
                      },
                      create: {
                        uuid: uuidv4(),
                        device: device, // Placeholder
                        folder: folder, // Placeholder
                        path: file.path,
                        created_at: mtime,
                        inode: ino.toString(),
                        absPath: localPath,
                      },
                    },
                  },
                },
              });
              await log(`✅ Updated: ${file.filename}`);
            } else {
              await error(`❌ Failed to download: ${file.filename}`);
              await fs.promises.unlink(localPath);
            }
          } catch (err: any) {
            await error(
              `❌ Exception during download ${file.filename}: ${err.message}`
            );
          }
        }
      }

      // 2. Delete Local Files
      if (filesToDeleteLocal && filesToDeleteLocal.length > 0) {
        for (const file of filesToDeleteLocal) {
          await log(`🗑️ Deleting local file: ${file.filename}`);
          try {
            await fs.promises.unlink(file.absPath);
            // Remove from Main DB immediately to keep state consistent?
            await prisma.file.delete({
              where: {
                path_filename: { path: file.path, filename: file.filename },
              },
            });
          } catch (err: any) {
            await error(
              `Failed to delete local file ${file.filename}: ${err.message}`
            );
          }
        }
      }
      // 3. Create Local Folders
      if (foldersToCreateLocal && foldersToCreateLocal.length > 0) {
        for (const f of foldersToCreateLocal) {
          const localPath = f.absPath;
          await log(`📁 Creating local folder: ${f.folder}`);
          try {
            await fs.promises.mkdir(localPath, { recursive: true });
            const absPath = join(syncPath, f.path);
            const { device } = getDirDevicePath(f.path);
            const { ino, mtime } = await fs.promises.stat(absPath);
            let dirObj: Directory = {
              absPath,
              device: device || "/",
              inode: ino.toString(),
              created_at: mtime,
              path: f.path,
              folder: f.folder,
              uuid: uuidv4(),
            };
            const dirExists = await prisma.directory.findUnique({
              where: {
                device_folder_path: {
                  device: device || "/",
                  folder: f.folder,
                  path: f.path,
                },
              },
            });
            if (dirExists) dirObj.uuid = dirExists.uuid;
            await prisma.directory.upsert({
              where: {
                device_folder_path: {
                  device: device || "/",
                  folder: f.folder,
                  path: f.path,
                },
              },
              update: {},
              create: dirObj,
            });
          } catch (err: any) {
            await error(`Failed to create folder ${f.path}: ${err.message}`);
          }
        }
      }
      // 4. Delete Local Folders
      if (foldersToDeleteLocal && foldersToDeleteLocal.length > 0) {
        for (const f of foldersToDeleteLocal) {
          await log(`🗑️ Deleting local folder: ${f.folder}`);
          try {
            // Actually, skipping queue logic for folders for now as it's complex.
            await fs.promises.rm(f.absPath, { force: true, recursive: true });
            const { device } = getDirDevicePath(f.path);
            await prisma.file.deleteMany({
              where: { path: f.path },
            });
            await prisma.directory.delete({
              where: {
                device_folder_path: { device, folder: f.folder, path: f.path },
              },
            });
          } catch (err: any) {
            await error(`Failed to delete folder ${f.folder}: ${err.message}`);
          }
        }
      }
      if (filesInConflict && filesInConflict.length > 0) {
        for (const file of filesInConflict) {
          try {
            const inQueue = await prisma.fileQueue.findUnique({
              where: {
                path_filename: { path: file.path, filename: file.filename },
                AND: { sync_status: "modified" },
              },
            });
            if (!inQueue) continue;
            const { ext, name } = parse(file.filename);
            const abspath = join(syncPath, file.path, file.filename);
            const path = dirname(abspath);
            const hostname = os.hostname();
            const timestamp = new Date().toTimeString();
            const conflictedName = `${name}(Conflicted Copy) - ${hostname} - ${timestamp} ${ext}`;
            const newPath = join(path, conflictedName);
            const localDirPath = join(syncPath, file.path);
            await log(`⬇️ Renaming Conflicted Copy: ${conflictedName}`);
            await fs.promises.mkdir(localDirPath, { recursive: true });
            const fileExists = fs.existsSync(abspath);
            console.log("FileExists: ", fileExists, abspath, newPath);
            if (fileExists) {
              await fs.promises.rename(abspath, newPath);
              await prisma.file.delete({
                where: {
                  path_filename: { path: file.path, filename: file.filename },
                },
              });
              const { device, folder } = getDirDevicePath(file.path);
              // Ensure directory exists
              const { ino, mtime } = await fs.promises.stat(localDirPath);
              const status = await apiClient.downloadFile(file, abspath);
              if (status && status.success) {
                await log(
                  `✅ Downloaded Cloud Conflicted Copy: ${file.filename}`
                );
                let fileObj = {
                  path: file.path,
                  filename: file.filename,
                  absPath: newPath,
                  size: file.size,
                  last_modified: file.last_modified,
                  hashvalue: file.hashvalue || "",
                  inode: status.ino.toString(), // Placeholder
                  uuid: file.uuid,
                  origin: file.origin,
                  versions: file.versions,
                  lastSyncedHashValue: file.hashvalue,
                };
                fileObj.origin = fileObj.uuid;
                await prisma.$transaction(async (prisma) => {
                  await prisma.file.create({
                    data: {
                      ...fileObj,
                      directoryID: {
                        connectOrCreate: {
                          where: {
                            device_folder_path: {
                              device: device, // Placeholder
                              folder: folder, // Placeholder
                              path: file.path,
                            },
                          },
                          create: {
                            uuid: uuidv4(),
                            device: device, // Placeholder
                            folder: folder, // Placeholder
                            path: file.path,
                            created_at: mtime,
                            inode: ino.toString(),
                            absPath: localDirPath,
                          },
                        },
                      },
                    },
                  });
                  await prisma.fileQueue.delete({
                    where: {
                      path_filename: {
                        path: file.path,
                        filename: file.filename,
                      },
                    },
                  });
                });
              } else {
                await error(
                  `❌ Failed to download Conflicted Copy : ${conflictedName}`
                );
                await fs.promises.unlink(newPath);
              }
            }
          } catch (err: any) {
            console.error(err);
          }
        }
      }
      return {
        filesToDeleteLocal,
        filesToDownload,
        foldersToDeleteLocal,
        foldersToCreateLocal,
      };
    }
  } catch (err: any) {
    console.error(err);
    return;
    // await error(`Cloud polling error: ${err.message}`);
  }
}

async function start() {
  await log("Cloud Sync Worker started");
  // Initial connection check
  try {
    await prisma.$connect();
    await log("DB Connected");
    setInterval(async () => {
      if (!isSyncing) {
        isSyncing = true;
        await pollCloud();
        await processQueue();
      }
    }, POLLING_INTERVAL);
  } catch (err: any) {
    await error(`DB Connection failed: ${err.message}`);
    return;
  }
}

start();
