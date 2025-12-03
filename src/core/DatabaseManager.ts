import { PrismaClient, File, Directory, FileQueue, DirectoryQueue } from '../../DB/prisma-client/index.js';
import { join, sep } from 'path';
import { stat } from 'fs/promises';
import { Stats } from "node:fs"
import { v4 as uuidv4 } from 'uuid';
import { HashWorkerPool } from '../utils/HashWorkerPool.js';
import { FileMetadata, DirectoryMetadata, ScannedFile, ScannedDirectory } from '../types/index.js';

export class DatabaseManager {
  private prisma: PrismaClient;
  private syncPath: string;
  private operationQueue: Promise<any> = Promise.resolve();

  constructor(prisma: PrismaClient, syncPath: string) {
    this.prisma = prisma;
    this.syncPath = syncPath;
  }

  private toDBPath(osPath: string): string {
    const parts = osPath.split(/[/\\]/).filter(p => p.length > 0);
    return parts.length > 0 ? '/' + parts.join('/') : '/';
  }

  private getFolderDevicePath(path: string, isFile: boolean) {
    const substringArr = path.replace(/[/\\]/g, "/").substring(this.syncPath.replace(/[/\\]/g, "/").length).split("/");
    const pathPart = isFile ? substringArr.slice(0, -1).join("/") : substringArr.join("/");
    const relPath = pathPart === "" ? "/" : pathPart;
    const device = isFile ? substringArr.slice(0, -1).at(1) : substringArr.at(1);
    const folder = isFile ? substringArr.slice(0, -1).at(-1) : substringArr.at(-1)
    return { folder: folder || "/", device: device || "/", relPath };
    /*
        let relPath = path;
        if (path.startsWith(this.syncPath)) {
          relPath = path.substring(this.syncPath.length);
        }
        let parts = relPath.split(/[/\\]/).filter(p => p.length > 0);
        if (parts.length === 0) {
          return { folder: '/', device: '/', relPath: '/' };
        }
        const device = parts[0];
        const folder = isFile ? (parts.length > 1 ? parts[parts.length - 2] : '/') : parts[parts.length - 1];
    
        const relPathParts = isFile ? parts.slice(0, -1) : parts;
        const relPathStr = relPathParts.length > 0 ? '/' + relPathParts.join('/') : '/';
    
        return { folder: folder || '/', device: device || '/', relPath: relPathStr }; */
  }

  private async getPathTree(pathParts: string[]) {
    const tree: [string, string][] = [];
    let currentPath = "";
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      if (!part) continue;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      tree.push([part, currentPath]);
    }
    return tree;
  }

  // --- Queue Operations ---

  async addFileQueue(prisma: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      const fileExists = await prisma.fileQueue.findUnique({
        where: { path_filename: { path: file.path, filename: file.filename } }
      });
      if (fileExists && fileExists.hashvalue === file.hashvalue &&
        fileExists.inode === file.inode &&
        fileExists.sync_status === "rename") {
        return;
      };
      const { relPath } = this.getFolderDevicePath(file.absPath, true);
      const parts = relPath.split(/[/\\]/).filter(p => p.length > 0);
      const parentParts = parts.slice(0);
      const parentPath = parentParts.length > 0 ? '/' + parentParts.join('/') : '/';

      const dirParts = await this.getPathTree(parentParts);
      const dirObjArr = [];

      for (const [folder, path] of dirParts) {
        const absPath = join(this.syncPath, ...path.split('/'));
        const { device } = this.getFolderDevicePath(absPath, false);

        const dirMain = await prisma.directory.findUnique({
          where: {
            device_folder_path: { device, folder, path: '/' + path }
          }
        });

        let dirObj: any = {
          uuid: uuidv4(),
          path: '/' + path,
          device,
          folder,
          sync_status: "FILE_LINKED"
        };

        if (dirMain) {
          dirObj = { ...dirMain, sync_status: "FILE_LINKED" };
        } else {
          const dirQueue = await prisma.directoryQueue.findUnique({
            where: {
              device_folder_path: { device, folder, path: '/' + path }
            }
          });

          if (dirQueue) {
            dirObj = { ...dirQueue };
          } else {
            try {
              const stats = await stat(absPath);
              dirObj.created_at = stats.mtime;
              dirObj.absPath = absPath;
              dirObj.inode = stats.ino.toString();
            } catch (e) {
              dirObj.created_at = new Date();
              dirObj.absPath = absPath;
            }
          }
        }

        const dir = await prisma.directoryQueue.upsert({
          where: {
            device_folder_path: { device, folder, path: '/' + path }
          },
          update: { ...dirObj },
          create: { ...dirObj }
        });
        dirObjArr.push(dir);
      }

      // Handle root directory if file is in root
      if (dirObjArr.length === 0) {
        const { device, folder } = this.getFolderDevicePath(this.syncPath, false);
        // Check if root dir exists in Main DB
        const rootDirMain = await prisma.directory.findUnique({
          where: {
            device_folder_path: { device, folder, path: '/' }
          }
        });

        let rootDirObj: any = {
          uuid: uuidv4(),
          path: '/',
          device,
          folder,
          sync_status: "FILE_LINKED",
          created_at: new Date(),
          absPath: this.syncPath
        };

        if (rootDirMain) {
          rootDirObj = { ...rootDirMain, sync_status: "FILE_LINKED" };
        } else {
          const rootDirQueue = await prisma.directoryQueue.findUnique({
            where: {
              device_folder_path: { device, folder, path: '/' }
            }
          });
          if (rootDirQueue) rootDirObj = { ...rootDirQueue };
        }

        const rootDir = await prisma.directoryQueue.upsert({
          where: {
            device_folder_path: { device, folder, path: '/' }
          },
          update: { ...rootDirObj },
          create: { ...rootDirObj }
        });
        dirObjArr.push(rootDir);
      }

      const dirID = dirObjArr.at(-1)?.uuid || uuidv4();

      const fileCopy = {
        path: parentPath,
        filename: file.filename,
        last_modified: file.last_modified,
        hashvalue: file.hashvalue,
        size: BigInt(file.size),
        inode: file.inode,
        absPath: file.absPath,
        sync_status: "new",
        dirID
      };

      const upsertedFile = await prisma.fileQueue.upsert({
        where: {
          path_filename: {
            path: fileCopy.path,
            filename: fileCopy.filename
          }
        },
        update: fileCopy,
        create: fileCopy
      });
      return dirObjArr;
    } catch (err) {
      console.error("Error in addFileQueue:", err);
      throw err;
    }
  }

  async updateFileQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      let relPath = file.path;
      if (file.path.startsWith(this.syncPath)) {
        relPath = file.path.substring(this.syncPath.length);
      }
      const parts = relPath.split(/[/\\]/).filter(p => p.length > 0);
      const parentParts = parts.slice(0);
      const parentPath = parentParts.length > 0 ? '/' + parentParts.join('/') : '/';

      // First check if the file is already in the queue
      const queuedFile = await tx.fileQueue.findUnique({
        where: {
          path_filename: {
            path: parentPath,
            filename: file.filename
          }
        }
      });

      // If file is in queue, update it with modified status
      if (queuedFile) {
        const fileCopy = {
          path: parentPath,
          filename: file.filename,
          last_modified: file.last_modified,
          hashvalue: file.hashvalue,
          size: BigInt(file.size),
          inode: file.inode,
          absPath: file.absPath,
          sync_status: "modified",
          dirID: queuedFile.dirID
        };

        await tx.fileQueue.update({
          where: {
            path_filename: {
              path: parentPath,
              filename: file.filename
            }
          },
          data: fileCopy
        });
        return;
      }

      // Check if file exists in main DB
      const existingFile = await tx.file.findUnique({
        where: {
          path_filename: {
            path: parentPath,
            filename: file.filename
          }
        },
        select: { dirID: true }
      });

      // If not in main DB either, treat as new file
      if (!existingFile) {
        return this.addFileQueue(tx, file);
      }

      // File exists in main DB. We need to ensure the parent directory is in DirectoryQueue.
      const dirID = existingFile.dirID;

      // Check if directory exists in DirectoryQueue
      const dirInQueue = await tx.directoryQueue.findUnique({
        where: { uuid: dirID }
      });

      if (!dirInQueue) {
        // Get directory from Main DB
        const dirInMain = await tx.directory.findUnique({
          where: { uuid: dirID }
        });

        if (dirInMain) {
          // Insert into DirectoryQueue
          await tx.directoryQueue.upsert({
            where: {
              device_folder_path: {
                device: dirInMain.device,
                folder: dirInMain.folder,
                path: dirInMain.path
              }
            },
            update: { uuid: dirInMain.uuid, created_at: dirInMain.created_at, absPath: dirInMain.absPath, sync_status: "FILE_LINKED" },
            create: { uuid: dirInMain.uuid, device: dirInMain.device, folder: dirInMain.folder, path: dirInMain.path, created_at: dirInMain.created_at, absPath: dirInMain.absPath, sync_status: "FILE_LINKED" }
          });
        } else {
          // This is a weird case: File exists in Main DB but its parent directory doesn't?
          // Should not happen with foreign keys, but just in case.
          console.warn(`Parent directory with ID ${dirID} not found in Main DB for file ${file.filename}`);
          // We might want to fall back to addFileQueue logic to recreate the directory structure?
          // For now, let's proceed, but it might fail FK constraint if we insert into FileQueue.
        }
      }

      // File exists in main DB, create queue entry with modified status
      const fileCopy = {
        path: parentPath,
        filename: file.filename,
        last_modified: file.last_modified,
        hashvalue: file.hashvalue,
        size: BigInt(file.size),
        inode: file.inode,
        absPath: file.absPath,
        sync_status: "modified",
        dirID: existingFile.dirID
      };

      await tx.fileQueue.create({
        data: fileCopy
      });
    } catch (err) {
      console.error("Error in updateFileQueue:", err);
      throw err;
    }
  }

  async removeFileQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      // First, check if the file exists in the main DB
      const existingFile = await tx.file.findUnique({
        where: { path_filename: { path: file.path, filename: file.filename } }
      });

      // If the file doesn't exist in main DB, check if it's in the queue
      if (!existingFile) {
        // Try to find it in the queue
        const queuedFile = await tx.fileQueue.findUnique({
          where: { path_filename: { path: file.path, filename: file.filename } }
        });

        if (queuedFile) {
          // File is in queue, mark it as deleted
          await tx.fileQueue.update({
            where: { path_filename: { path: file.path, filename: file.filename } },
            data: { sync_status: "delete" }
          });
        }
        // If file doesn't exist in main DB or queue, nothing to delete
        return;
      }

      // File exists in main DB, so we need to mark it for deletion in the queue
      // Ensure the parent directory exists in DirectoryQueue
      const dirID = existingFile.dirID;

      // Check if the directory exists in DirectoryQueue
      const dirInQueue = await tx.directoryQueue.findUnique({
        where: { uuid: dirID }
      });

      if (!dirInQueue) {
        // Get the directory from main DB
        const dirInMain = await tx.directory.findUnique({
          where: { uuid: dirID }
        });

        if (dirInMain) {
          // Add the directory to the queue
          await tx.directoryQueue.upsert({
            where: {
              device_folder_path: {
                device: dirInMain.device,
                folder: dirInMain.folder,
                path: dirInMain.path
              }
            },
            update: { uuid: dirInMain.uuid, created_at: dirInMain.created_at, absPath: dirInMain.absPath, sync_status: "FILE_LINKED" },
            create: { uuid: dirInMain.uuid, device: dirInMain.device, folder: dirInMain.folder, path: dirInMain.path, created_at: dirInMain.created_at, absPath: dirInMain.absPath, sync_status: "FILE_LINKED" }
          });
        }
      }

      // Now create/update the file queue entry
      const queueData = {
        path: file.path,
        filename: file.filename,
        last_modified: existingFile.last_modified,
        hashvalue: existingFile.hashvalue,
        size: existingFile.size,
        inode: existingFile.inode,
        absPath: existingFile.absPath,
        dirID: existingFile.dirID,
        sync_status: "delete"
      };

      await tx.fileQueue.upsert({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename
          }
        },
        update: queueData,
        create: queueData
      });
    } catch (err) {
      console.error("Error in removeFileQueue:", err);
      throw err;
    }
  }

  async addDirQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, path: string, stats: Stats): Promise<DirectoryQueue> {
    try {
      const { device, folder, relPath } = this.getFolderDevicePath(path, false);
      let dirObj: DirectoryQueue = {
        uuid: uuidv4(),
        path: relPath,
        folder,
        device,
        old_path: "",
        sync_status: "new",
        created_at: stats.mtime,
        absPath: path,
        inode: stats.ino.toString()
      };
      // Use _count instead of include to avoid loading all files (performance optimization)
      const dirMain = await tx.directory.findUnique({
        where: {
          device_folder_path: { device, folder, path: relPath }
        },
        select: {
          uuid: true,
          device: true,
          folder: true,
          path: true,
          created_at: true,
          absPath: true,
          inode: true,
          _count: {
            select: { files: true }
          }
        }
      });

      if (dirMain && dirMain._count.files > 0) {
        // Directory exists in main DB and has files, mark as FILE_LINKED
        dirObj = {
          uuid: dirMain.uuid,
          device: dirMain.device,
          folder: dirMain.folder,
          path: dirMain.path,
          created_at: dirMain.created_at,
          absPath: dirMain.absPath,
          inode: dirMain.inode,
          old_path: "",
          sync_status: "FILE_LINKED"
        };
      } else {
        // Check if already exists in queue
        const dirQueue = await tx.directoryQueue.findUnique({
          where: { device_folder_path: { device, folder, path: relPath } }
        });
        if (dirQueue) dirObj = { ...dirQueue };
      }
      return await tx.directoryQueue.upsert({
        where: {
          device_folder_path: { device, folder, path: relPath }
        },
        update: dirObj,
        create: dirObj
      });
    } catch (err) {
      console.error("Error in addDirQueue:", err);
      throw err;
    }
  }

  async removeDirQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, path: string) {
    try {
      const { relPath } = this.getFolderDevicePath(path, false);

      const files = await tx.file.findMany({
        where: { path: relPath }
      });

      const dirs = await tx.directory.findMany({
        where: {
          OR: [
            { path: relPath },
            { path: { startsWith: relPath + '/' } }
          ]
        }
      });

      for (const dir of dirs) {
        await tx.directoryQueue.upsert({
          where: {
            device_folder_path: {
              device: dir.device,
              folder: dir.folder,
              path: dir.path
            }
          },
          update: { ...dir, sync_status: "delete" },
          create: { ...dir, sync_status: "delete" }
        });
      }

      for (const file of files) {
        await tx.fileQueue.upsert({
          where: {
            path_filename: {
              path: file.path,
              filename: file.filename
            }
          },
          update: { ...file, sync_status: "delete" },
          create: { ...file, sync_status: "delete" }
        });
      }
    } catch (err) {
      console.error("Error in removeDirQueue:", err);
      throw err;
    }
  }

  async renameFileQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, oldFile: FileMetadata, newFile: FileMetadata) {
    try {
      // 1. Check if destination already exists (from 'add' event) and delete it
      const existingDest = await tx.fileQueue.findUnique({
        where: { path_filename: { path: newFile.path, filename: newFile.filename } }
      });

      if (existingDest) {
        console.log(`Removing existing destination file from queue (race condition fix): ${newFile.filename}`);
        await tx.fileQueue.delete({
          where: { path_filename: { path: newFile.path, filename: newFile.filename } }
        });
      }

      const file = await tx.fileQueue.findUnique({ where: { path_filename: { path: oldFile.path, filename: oldFile.filename } } });
      const dirID = file?.dirID || newFile.dirID;

      if (!dirID) {
        console.warn(`Cannot rename file in queue: dirID not found for ${oldFile.filename}`);
        return;
      }

      const fileData = {
        path: newFile.path,
        filename: newFile.filename,
        last_modified: newFile.last_modified,
        hashvalue: newFile.hashvalue,
        size: BigInt(newFile.size),
        inode: newFile.inode,
        absPath: newFile.absPath,
        sync_status: "rename",
        old_path: oldFile.path,
        old_filename: oldFile.filename,
        dirID
      };
      await tx.fileQueue.upsert({
        where: { path_filename: { path: oldFile.path, filename: oldFile.filename } },
        update: fileData,
        create: fileData
      })
      return;
    } catch (err) {
      console.error("Error in renameFileQueue:", err);
      throw err;
    }
  }

  async renameDirMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, oldPath: string, newPath: string): Promise<void> {
    try {
      const childrenDirs = await tx.directory.findMany({
        where: {
          OR: [{ path: oldPath }, { path: { startsWith: oldPath } }]
        }
      });
      //update children dirs
      for (const dir of childrenDirs) {
        const newChildPath = dir.path.replace(oldPath, newPath);
        const { device, folder } = this.getFolderDevicePath(join(this.syncPath, newChildPath), false);
        await tx.directory.upsert({
          where: { device_folder_path: { device: dir.device, path: dir.path, folder: dir.folder } },
          update: { ...dir, device, folder, path: newChildPath },
          create: { ...dir, device, folder, path: newChildPath }
        })
      }
      // Update children files
      const childrenFiles = await tx.file.findMany({
        where: {
          OR: [{ path: oldPath }, { path: { startsWith: oldPath } }]
        }
      });

      for (const file of childrenFiles) {
        /* /users/sand/desktop/sync_folder/original/test1/test2
            /users/sand/desktop/sync_folder/renamed
            /users/sand/desktop/sync_folder/renamed/test1
            /users/sand/desktop/sync_folder/renamed/test1/test2
         */
        const newChildPath = file.path.replace(oldPath, newPath);
        await tx.file.upsert({
          where: { path_filename: { path: file.path, filename: file.filename } },
          update: { ...file, path: newChildPath },
          create: { ...file, path: newChildPath }
        })
      }

    } catch (err) {
      throw err
    }
  }

  async renameDirQueue(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">,
    oldPath: string, newPath: string) {
    try {
      // Update children dirs
      const childrenDirs = await tx.directoryQueue.findMany({
        where: {
          OR: [{ path: oldPath }, { path: { startsWith: oldPath } }]
        }
      });
      /*
        /test/test1/test2
        /test/test1
        /test 
        -->test -->test_rename 
        /test_rename/test1/test2
        /test_rename/test1
        /test_rename 
        oldPath => /test 
        newPath => /test_rename

      */
      for (const dir of childrenDirs) {
        const newChildPath = dir.path.replace(oldPath, newPath);
        const { device, folder } = this.getFolderDevicePath(join(this.syncPath, newChildPath), false);
        let dirObj: DirectoryQueue = { ...dir, device, folder, sync_status: "rename", path: newChildPath, old_path: oldPath }
        return await tx.directoryQueue.upsert({
          where: { device_folder_path: { device: dir.device, path: dir.path, folder: dir.folder } },
          update: dirObj,
          create: dirObj
        });
      }
      // Update children files
      const childrenFiles = await tx.fileQueue.findMany({
        where: {
          OR: [{ path: oldPath }, { path: { startsWith: oldPath } }]
        }
      });

      for (const file of childrenFiles) {
        /* /users/sand/desktop/sync_folder/original/test1/test2
            /users/sand/desktop/sync_folder/renamed
            /users/sand/desktop/sync_folder/renamed/test1
            /users/sand/desktop/sync_folder/renamed/test1/test2
         */
        const newChildPath = file.path.replace(oldPath, newPath);
        await tx.fileQueue.upsert({
          where: { path_filename: { path: file.path, filename: file.filename } },
          update: { ...file, sync_status: "DIR_RENAMED", path: newChildPath },
          create: { ...file, sync_status: "DIR_RENAMED", path: newChildPath }
        })
      }
    } catch (err) {
      console.error("Error in renameDirQueue:", err);
      throw err;
    }
  }

  // --- Main DB Operations ---

  async addFileMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      const insertedDirs = [];
      const parts = await this.getPathTree(file.path.split(/[/\\]/))
      let dirID: string | undefined = "";
      if (file.path !== "/") {
        for (const [folder, subPath] of parts) {
          const { device, relPath } = this.getFolderDevicePath(join(this.syncPath, subPath), false);
          const dirObj = {
            uuid: uuidv4(),
            path: relPath,
            device,
            folder,
            created_at: new Date(),
            absPath: join(this.syncPath, subPath)
          };

          const upsertDir = await tx.directory.upsert({
            where: {
              device_folder_path: {
                device,
                folder,
                path: relPath
              }
            },
            update: dirObj,
            create: dirObj
          });
          insertedDirs.push(upsertDir);
        }
        dirID = insertedDirs.at(-1)?.uuid
      } else {
        const dirObj = {
          uuid: uuidv4(),
          path: "/",
          device: "/",
          folder: "/",
          created_at: new Date(),
          absPath: join(this.syncPath)
        };

        const upsertDir = await tx.directory.upsert({
          where: {
            device_folder_path: {
              device: "/",
              folder: "/",
              path: "/"
            }
          },
          update: dirObj,
          create: dirObj
        });
        dirID = upsertDir?.uuid
      }
      if (!dirID) {
        console.error(`Error in addFileMain: dirID is undefined for file ${file.filename}`);
        throw new Error(`Cannot create file without a valid directory ID`);
      }

      const fileObj = {
        path: file.path,
        filename: file.filename,
        last_modified: file.last_modified,
        hashvalue: file.hashvalue,
        size: BigInt(file.size),
        inode: file.inode,
        absPath: file.absPath,
        dirID
      };

      await tx.file.upsert({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename
          }
        },
        update: fileObj,
        create: fileObj
      });

    } catch (err) {
      console.error("Error in addFileMain:", err);
      throw err;
    }
  }

  async addDirMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, dir: Directory) {
    try {
      // const { device, folder, relPath } = this.getFolderDevicePath(dir.absPath, false);
      await tx.directory.upsert({
        where: {
          device_folder_path: { device: dir.device, folder: dir.folder, path: dir.path }
        },
        update: dir,
        create: dir
      });
    } catch (err) {
      console.error("Error in addDirMain:", err);
      throw err;
    }
  }

  async removeFileMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      await tx.file.delete({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename
          }
        }
      });
    } catch (err) {
      console.error("Error in removeFileMain:", err);
    }
  }

  async removeDirMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, path: string) {
    try {
      const { relPath } = this.getFolderDevicePath(path, false);

      await tx.file.deleteMany({
        where: {
          OR: [{ path: relPath }, { path: { startsWith: relPath + "/" } }]
        }
      });

      await tx.directory.deleteMany({
        where: {
          OR: [{ path: relPath }, { path: { startsWith: relPath + "/" } }]
        }
      });
    } catch (err) {
      console.error("Error in removeDirMain:", err);
      throw err;
    }
  }

  async updateFileMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, file: FileMetadata) {
    try {
      const existing = await tx.file.findUnique({
        where: { path_filename: { path: file.path, filename: file.filename } },
        select: { dirID: true }
      });

      if (!existing) return;

      const fileObj = {
        path: file.path,
        filename: file.filename,
        last_modified: file.last_modified,
        hashvalue: file.hashvalue,
        size: BigInt(file.size),
        inode: file.inode,
        absPath: file.absPath,
        dirID: existing.dirID
      };

      await tx.file.update({
        where: {
          path_filename: {
            path: file.path,
            filename: file.filename
          }
        },
        data: fileObj
      });
    } catch (err) {
      console.error("Error in updateFileMain:", err);
      throw err;
    }
  }

  async renameFileMain(tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">, oldFile: FileMetadata, newFile: FileMetadata) {
    try {
      const existing = await tx.file.findUnique({
        where: { path_filename: { path: oldFile.path, filename: oldFile.filename } }
      });

      if (existing) {
        await tx.file.delete({
          where: { path_filename: { path: oldFile.path, filename: oldFile.filename } }
        });

        const fileObj = {
          path: newFile.path,
          filename: newFile.filename,
          last_modified: newFile.last_modified,
          hashvalue: newFile.hashvalue,
          size: BigInt(newFile.size),
          inode: newFile.inode,
          absPath: newFile.absPath,
          dirID: existing.dirID,
        };

        await tx.file.upsert({
          where: { path_filename: { path: newFile.path, filename: newFile.filename } },
          update: { ...fileObj },
          create: { ...fileObj }
        });
      }
    } catch (err) {
      console.error("Error in renameFileMain:", err);
      throw err;
    }
  }

  // --- Rename Detection Helper Methods ---

  /**
   * Find all files with matching inode (and optionally hash) in a parent directory
   * Used for rename detection
   */
  async findFilesByInodeInParent(parentPath: string, inode: string, hash?: string): Promise<FileMetadata[]> {
    try {
      // parentPath comes from FileSystemWatcher, which is OS relative path
      const dbPath = this.toDBPath(parentPath);

      const files = await this.prisma.file.findMany({
        where: {
          path: dbPath,
          inode: inode,
          ...(hash && { hashvalue: hash })
        }
      });

      return files.map(f => ({
        path: f.path,
        filename: f.filename,
        hashvalue: f.hashvalue,
        size: Number(f.size),
        inode: f.inode,
        last_modified: f.last_modified,
        absPath: f.absPath,
        sync_status: 'new' as const,
        dirID: f.dirID
      }));
    } catch (err) {
      console.error("Error in findFilesByInodeInParent:", err);
      return [];
    }
  }

  /**
   * Get file metadata from main database by path and filename
   */
  async getDirSubFoldersFromMain(relPath: string, inode: string): Promise<Directory[] | null> {
    try {
      return await this.prisma.directory.findMany({
        where: { path: relPath, inode }
      })
    } catch (err) {
      return []
    }
  }

  async getDirSubFoldersFromQueue(relPath: string, inode: string): Promise<DirectoryQueue[] | null> {
    try {
      return await this.prisma.directoryQueue.findMany({ where: { path: relPath, inode } })
    } catch (err) {
      return []
    }
  }

  async getFileFromMain(path: string, filename: string): Promise<FileMetadata | null> {
    try {
      // path comes from FileSystemWatcher, which is OS relative path
      const dbPath = this.toDBPath(path);

      const file = await this.prisma.file.findUnique({
        where: {
          path_filename: {
            path: dbPath,
            filename: filename
          }
        }
      });

      if (!file) return null;

      return {
        path: file.path,
        filename: file.filename,
        hashvalue: file.hashvalue,
        size: Number(file.size),
        inode: file.inode,
        last_modified: file.last_modified,
        absPath: file.absPath,
        sync_status: 'new' as const,
        dirID: file.dirID
      };
    } catch (err) {
      console.error("Error in getFileFromMain:", err);
      return null;
    }
  }

  /**
   * Get file metadata from queue database by path and filename
   * Used for rename detection when file hasn't been synced to main DB yet
   */
  async getFileFromQueue(path: string, filename: string): Promise<FileMetadata | null> {
    try {
      // path comes from FileSystemWatcher, which is OS relative path
      const dbPath = this.toDBPath(path);

      const file = await this.prisma.fileQueue.findUnique({
        where: {
          path_filename: {
            path: dbPath,
            filename: filename
          }
        }
      });

      if (!file) return null;

      return {
        path: file.path,
        filename: file.filename,
        hashvalue: file.hashvalue,
        size: Number(file.size),
        inode: file.inode,
        last_modified: file.last_modified,
        absPath: file.absPath,
        sync_status: file.sync_status as any,
        dirID: file.dirID
      };
    } catch (err) {
      console.error("Error in getFileFromQueue:", err);
      return null;
    }
  }

  /**
   * Find all files with matching inode (and optionally hash) in a parent directory in the Queue
   * Used for rename detection
   */
  async findFilesByInodeInQueue(parentPath: string, inode: string, hash?: string): Promise<FileMetadata[]> {
    try {
      // parentPath comes from FileSystemWatcher, which is OS relative path
      const dbPath = this.toDBPath(parentPath);

      const files = await this.prisma.fileQueue.findMany({
        where: {
          path: dbPath,
          inode: inode,
          ...(hash && { hashvalue: hash }),
          sync_status: { not: 'delete' } // Ignore deleted files in queue
        }
      });

      return files.map(f => ({
        path: f.path,
        filename: f.filename,
        hashvalue: f.hashvalue,
        size: Number(f.size),
        inode: f.inode,
        last_modified: f.last_modified,
        absPath: f.absPath,
        sync_status: f.sync_status as any,
        dirID: f.dirID
      }));
    } catch (err) {
      console.error("Error in findFilesByInodeInQueue:", err);
      return [];
    }
  }
  async getDirFromMain(relPath: string): Promise<DirectoryMetadata | null> {
    try {
      //const dbPath = this.toDBPath(relPath);
      // We need to construct absolute path to get correct device/folder if logic depends on it,
      // or just trust getFolderDevicePath handles relative paths correctly as seen in analysis.
      // However, to be safe and consistent with addFileQueue which uses syncPath for root:
      // If relPath is just '/', use syncPath.
      // Otherwise join.

      let absPath = this.syncPath;
      if (relPath !== '/') {
        absPath = join(this.syncPath, ...relPath.split('/'));
      }

      const { device, folder } = this.getFolderDevicePath(absPath, false);
      const dir = await this.prisma.directory.findUnique({
        where: {
          device_folder_path: {
            device,
            folder,
            path: relPath
          }
        }
      });

      if (!dir) return null;

      return {
        path: dir.path,
        device: dir.device,
        folder: dir.folder,
        sync_status: 'FILE_LINKED',
        created_at: dir.created_at,
        absPath: dir.absPath,
        uuid: dir.uuid,
        inode: dir.inode || undefined
      } as DirectoryMetadata;
    } catch (err) {
      console.error("Error in getDirFromMain:", err);
      return null;
    }
  }

  async getDirFromQueue(dbPath: string): Promise<DirectoryMetadata | null> {
    try {
      //const dbPath = this.toDBPath(relPath);

      let absPath = this.syncPath;
      if (dbPath !== '/') {
        absPath = join(this.syncPath, ...dbPath.split('/'));
      }

      const { device, folder } = this.getFolderDevicePath(absPath, false);

      const dir = await this.prisma.directoryQueue.findUnique({
        where: {
          device_folder_path: {
            device,
            folder,
            path: dbPath
          }
        }
      });

      if (!dir) return null;

      return {
        path: dir.path,
        device: dir.device,
        folder: dir.folder,
        sync_status: dir.sync_status,
        created_at: dir.created_at,
        absPath: dir.absPath,
        uuid: dir.uuid,
        inode: dir.inode || undefined
      } as DirectoryMetadata;
    } catch (err) {
      console.error("Error in getDirFromQueue:", err);
      return null;
    }
  }


  // --- Reconciliation Operations ---

  async getAllFiles(): Promise<File[]> {
    return this.prisma.file.findMany();
  }

  async getAllDirectories(): Promise<Directory[]> {
    return this.prisma.directory.findMany();
  }

  /**
   * Reconcile the database with the current filesystem state.
   * This is used during the initial scan to ensure the DB matches reality.
   * It updates both the Main DB (snapshot) and Queue DB (changes).
   */
  async reconcileDatabaseWithFileSystem(
    scannedFiles: ScannedFile[],
    scannedDirs: ScannedDirectory[],
    dbFiles: File[]
  ) {
    console.log('Reconciling database with filesystem...');

    // 1. Fetch current DB state (Directories only, files are passed in)
    const dbDirs = await this.getAllDirectories();
    // 2. Index DB items for fast lookup
    // Key: path/filename
    const dbFilesMap = new Map<string, File>();
    for (const f of dbFiles) {
      dbFilesMap.set(`${f.path}/${f.filename}`, f);
    }

    // Key: path (relative)
    const dbDirsMap = new Map<string, Directory>();
    for (const d of dbDirs) {
      dbDirsMap.set(d.path, d);
    }

    // 3. Index Scanned items
    const scannedFilesMap = new Map<string, ScannedFile>();
    for (const f of scannedFiles) {
      // Ensure path starts with /
      let path = f.path;
      if (!path.startsWith('/')) path = '/' + path;
      scannedFilesMap.set(`${path}/${f.filename}`, { ...f, path });
    }

    const scannedDirsMap = new Map<string, ScannedDirectory>();
    for (const d of scannedDirs) {
      let path = d.path;
      if (!path.startsWith('/')) path = '/' + path;
      const fullPath = path === '/' ? `/${d.name}` : `${path}/${d.name}`;
      scannedDirsMap.set(fullPath, { ...d, path });
    }

    // 4. Identify Changes

    // Files
    const filesToAdd: ScannedFile[] = [];
    const filesToUpdate: ScannedFile[] = [];
    const filesToDelete: File[] = [];

    for (const [key, sFile] of scannedFilesMap) {
      const dbFile = dbFilesMap.get(key);
      if (!dbFile) {
        filesToAdd.push(sFile);
      } else {
        // Check for modifications (hash or size or mtime)
        // We prioritize hash if available, otherwise size+mtime
        if (sFile.hash && dbFile.hashvalue !== sFile.hash) {
          filesToUpdate.push(sFile);
        }
      }
    }

    for (const [key, dbFile] of dbFilesMap) {
      if (!scannedFilesMap.has(key)) {
        filesToDelete.push(dbFile);
      }
    }

    // Directories
    const dirsToAdd: ScannedDirectory[] = [];
    const dirsToDelete: Directory[] = [];

    // Helper to construct full path for scanned dir
    const getFullDirPath = (d: ScannedDirectory) => {
      let p = d.path;
      if (!p.startsWith('/')) p = '/' + p;
      return p === '/' ? `/${d.name}` : `${p}/${d.name}`;
    };

    for (const sDir of scannedDirs) {
      const fullPath = getFullDirPath(sDir);
      if (!dbDirsMap.has(fullPath)) {
        dirsToAdd.push({
          path: sDir.path.startsWith('/') ? sDir.path : '/' + sDir.path,
          name: sDir.name,
          inode: sDir.inode,
          mtime: sDir.mtime,
          absPath: sDir.absPath
        });
      }
    }

    for (const [key, dbDir] of dbDirsMap) {
      // Root dir '/' is special, might not be in scannedDirs if we scanned contents
      if (key === '/') continue;

      // Check if this dbDir exists in scannedDirs
      // We need to reverse lookup or iterate
      let exists = false;
      for (const sDir of scannedDirs) {
        if (getFullDirPath(sDir) === key) {
          exists = true;
          break;
        }
      }

      if (!exists) {
        dirsToDelete.push(dbDir);
      }
    }
    console.log(`Reconciliation: +${filesToAdd.length} files, ~${filesToUpdate.length} files, -${filesToDelete.length} files`);
    console.log(`Reconciliation: +${dirsToAdd.length} dirs, -${dirsToDelete.length} dirs`);

    // 5. Execute Transaction
    await this.prisma.$transaction(async (tx) => {
      // --- Deletions ---
      // Delete files first to avoid FK constraints
      for (const f of filesToDelete) {
        // Delete directories (reverse order of depth to avoid FK issues?)
        // Actually Prisma handles cascading deletes if configured, but let's be safe.
        // We'll just mark them as deleted in Queue. Main DB deletion might fail if not empty.
        // But we already deleted files. What about subdirectories?
        // We should sort dirsToDelete by depth descending.
        const { device, folder, relPath } = this.getFolderDevicePath(f.absPath, true)
        const queueDirExists = await tx.directoryQueue.findUnique({
          where: { device_folder_path: { device, folder, path: relPath } },
        });
        let dirID: string | undefined;
        if (queueDirExists)
          dirID = queueDirExists.uuid;
        else {
          const dirExists = await tx.directory.findUnique({
            where: { device_folder_path: { device, folder, path: relPath } }
          });
          if (dirExists && !queueDirExists) {
            dirID = dirExists.uuid;
            await tx.directoryQueue.upsert({
              where: { device_folder_path: { device, folder, path: relPath } },
              update: { ...dirExists, sync_status: "FILE_LINKED" },
              create: { ...dirExists, sync_status: "FILE_LINKED" }
            });
          }
        }

        if (dirID) {
          // Add to Queue as delete
          await tx.fileQueue.upsert({
            where: { path_filename: { path: f.path, filename: f.filename } },
            update: { filename: f.filename, path: f.path, dirID, absPath: f.absPath, inode: f.inode, last_modified: f.last_modified, hashvalue: f.hashvalue, size: BigInt(f.size), sync_status: "delete" },
            create: { filename: f.filename, path: f.path, dirID, absPath: f.absPath, inode: f.inode, last_modified: f.last_modified, hashvalue: f.hashvalue, size: BigInt(f.size), sync_status: "delete" },
          });
        } else {
          console.warn(`Could not find parent directory for deleted file ${f.path}/${f.filename}`);
        }
        // Remove from Main
        await tx.file.delete({
          where: { path_filename: { path: f.path, filename: f.filename } }
        });
      }
      dirsToDelete.sort((a, b) => b.path.length - a.path.length);
      for (const d of dirsToDelete) {
        // Add to Queue
        await tx.directoryQueue.upsert({
          where: { device_folder_path: { device: d.device, folder: d.folder, path: d.path } },
          update: {
            uuid: d.uuid, device: d.device, folder: d.folder, path: d.path,
            sync_status: 'delete', inode: d.inode, created_at: d.created_at, absPath: d.absPath
          },
          create: {
            uuid: d.uuid, device: d.device, inode: d.inode, folder: d.folder, path: d.path,
            sync_status: 'delete', created_at: d.created_at, absPath: d.absPath
          }
        });
        // Remove from Main
        try {
          await tx.directory.delete({ where: { uuid: d.uuid } });
        } catch (e) {
          console.warn(`Could not delete directory ${d.path} from Main DB (might not be empty): ${e}`);
        }
      }
      // --- Additions (Directories first) ---
      // Sort by depth ascending
      dirsToAdd.sort((a, b) => a.path.length - b.path.length);
      for (const d of dirsToAdd) {
        const { device, folder, relPath } = this.getFolderDevicePath(d.path === '/' ? `/${d.name}` : `${d.path}/${d.name}`, false);
        const uuid = uuidv4();
        // Add to Main
        const dirObj = {
          uuid,
          path: relPath,
          device,
          folder,
          created_at: d.mtime,
          absPath: d.absPath,
          inode: d.inode
        };
        await tx.directory.upsert({
          where: { device_folder_path: { device, folder, path: relPath } },
          update: dirObj,
          create: dirObj
        });
        // Add to Queue
        await tx.directoryQueue.upsert({
          where: { device_folder_path: { device, folder, path: relPath } },
          update: { ...dirObj, sync_status: 'new' },
          create: { ...dirObj, sync_status: 'new' }
        });
      }
      // --- Additions (Files) ---
      for (const f of filesToAdd) {
        // Find parent dir UUID
        const parentPath = f.path.startsWith('/') ? f.path : '/' + f.path;
        const { device, folder } = this.getFolderDevicePath(join(this.syncPath, ...parentPath.split('/')), false);

        let parentDir = await tx.directory.findUnique({
          where: { device_folder_path: { device, folder, path: parentPath } }
        });
        if (!parentDir) {
          console.error(`Parent directory not found for file ${f.filename} at ${parentPath}`);
          const { mtime, ino } = await stat(f.absPath)
          const uuid = uuidv4();
          parentDir = await tx.directory.upsert({
            where: { device_folder_path: { device, folder, path: f.path } },
            update: { uuid, device, folder, path: f.path, created_at: mtime, absPath: f.path, inode: ino.toString() },
            create: { uuid, device, folder, path: f.path, created_at: mtime, absPath: f.path, inode: ino.toString() },
          });
        }

        // CRITICAL: Ensure parent directory exists in DirectoryQueue before inserting file
        // FileQueue has a foreign key constraint to DirectoryQueue, not Directory
        await tx.directoryQueue.upsert({
          where: { device_folder_path: { device, folder, path: parentPath } },
          update: { uuid: parentDir.uuid, sync_status: 'FILE_LINKED' },
          create: {
            uuid: parentDir.uuid,
            device,
            folder,
            path: parentPath,
            created_at: parentDir.created_at,
            absPath: parentDir.absPath,
            inode: parentDir.inode,
            sync_status: 'FILE_LINKED'
          },
        });

        const fileObj = {
          path: parentPath,
          filename: f.filename,
          hashvalue: f.hash,
          size: BigInt(f.size),
          inode: f.inode,
          last_modified: f.mtime,
          absPath: f.absPath,
          dirID: parentDir.uuid
        };
        // Add to Main
        await tx.file.upsert({
          where: { path_filename: { path: parentPath, filename: f.filename } },
          update: fileObj,
          create: fileObj
        });
        // Add to Queue
        await tx.fileQueue.upsert({
          where: { path_filename: { path: parentPath, filename: f.filename } },
          update: { ...fileObj, sync_status: 'new' },
          create: { ...fileObj, sync_status: 'new' }
        });
      }
      // --- Updates (Files) ---
      for (const f of filesToUpdate) {
        // Find parent dir UUID (should exist)
        const parentPath = f.path.startsWith('/') ? f.path : '/' + f.path;
        const { device, folder } = this.getFolderDevicePath(join(this.syncPath, ...parentPath.split('/')), false);

        let parentDir = await tx.directory.findUnique({
          where: { device_folder_path: { device, folder, path: parentPath } }
        });

        if (!parentDir) {
          console.error(`Parent directory not found for file ${f.filename} at ${parentPath}`);
          const { mtime, ino } = await stat(f.absPath)
          const uuid = uuidv4();
          parentDir = await tx.directory.upsert({
            where: { device_folder_path: { device, folder, path: f.path } },
            update: { uuid, device, folder, path: f.path, created_at: mtime, absPath: f.path, inode: ino.toString() },
            create: { uuid, device, folder, path: f.path, created_at: mtime, absPath: f.path, inode: ino.toString() },
          });
        }

        // CRITICAL: Ensure parent directory exists in DirectoryQueue before inserting file
        // FileQueue has a foreign key constraint to DirectoryQueue, not Directory
        await tx.directoryQueue.upsert({
          where: { device_folder_path: { device, folder, path: parentPath } },
          update: { uuid: parentDir.uuid, sync_status: 'FILE_LINKED' },
          create: {
            uuid: parentDir.uuid,
            device,
            folder,
            path: parentPath,
            created_at: parentDir.created_at,
            absPath: parentDir.absPath,
            inode: parentDir.inode,
            sync_status: 'FILE_LINKED'
          },
        });
        const fileObj = {
          path: parentPath,
          filename: f.filename,
          hashvalue: f.hash,
          size: BigInt(f.size),
          inode: f.inode,
          last_modified: f.mtime,
          absPath: f.absPath,
          dirID: parentDir.uuid
        };
        // Update Main
        await tx.file.upsert({
          where: { path_filename: { path: parentPath, filename: f.filename } },
          update: fileObj,
          create: fileObj
        });
        // Update Queue
        await tx.fileQueue.upsert({
          where: { path_filename: { path: parentPath, filename: f.filename } },
          update: { ...fileObj, sync_status: 'modified' },
          create: { ...fileObj, sync_status: 'modified' }
        });
      }
    });

    console.log('Reconciliation complete.');
  }



  // --- Transaction Wrapper Methods ---
  // These methods encapsulate transaction logic for SyncClient

  /**
   * Add file to both Queue and Main DB within a transaction
   */
  async addFileWithTransaction(file: FileMetadata): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.addFileQueue(tx, file);
      await this.addFileMain(tx, file);
    });
  }

  /**
   * Update file in both Queue and Main DB within a transaction
   */
  async updateFileWithTransaction(file: FileMetadata): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.updateFileQueue(tx, file);
      await this.updateFileMain(tx, file);
    });
  }

  /**
   * Remove file from both Queue and Main DB within a transaction
   */
  async removeFileWithTransaction(file: FileMetadata): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.removeFileQueue(tx, file);
      await this.removeFileMain(tx, file);
    });
  }

  /**
   * Rename file in both Queue and Main DB within a transaction
   */
  async renameFileWithTransaction(oldFile: FileMetadata, newFile: FileMetadata): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.renameFileQueue(tx, oldFile, newFile);
      await this.renameFileMain(tx, oldFile, newFile);
    });
  }

  /**
   * Add directory to Queue within a transaction
   */
  async addDirWithTransaction(path: string, stats: Stats): Promise<void> {
    // Queue this operation to prevent concurrent transaction conflicts
    this.operationQueue = this.operationQueue.then(async () => {
      await this.prisma.$transaction(async (tx) => {
        const dirMetaData = await this.addDirQueue(tx, path, stats);
        const dir: Directory = {
          uuid: dirMetaData.uuid,
          device: dirMetaData.device,
          folder: dirMetaData.folder,
          path: dirMetaData.path,
          created_at: dirMetaData.created_at,
          absPath: dirMetaData.absPath,
          inode: dirMetaData.inode,
        }
        await this.addDirMain(tx, dir)
      });
    }).catch(err => {
      console.error(`Error in queued addDirWithTransaction for ${path}:`, err);
      throw err;
    });

    return this.operationQueue;
  }

  /**
   * Remove directory from Queue within a transaction
   */
  async removeDirWithTransaction(path: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.removeDirQueue(tx, path);
      await this.removeDirMain(tx, path);
    });
  }

  // rename directory from queue within a transaction


  async renameDirWithTransaction(oldPath: string, newPath: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.renameDirQueue(tx, oldPath, newPath)
      await this.renameDirMain(tx, oldPath, newPath)
    });
  }
}
