import axios from "axios";
import mime from "mime-types";
import { URL } from "node:url";
import { createReadStream } from "node:fs";
import FormData from "form-data";
import dotenv from "dotenv";
import sharp from "sharp";
import { join } from "node:path";
import {
  removeFileQueueDb,
  removeDirQueueDb,
  getFolderDevicePath,
} from "./get_file_folder_metadata.js";
import { prisma } from "../Config/prismaDBConfig.js";
dotenv.config();
import { SYNC_PATH } from "../controllers/get_file_folder_metadata.js";

const getDirDevicePath = (path) => {
  if (typeof path === "string") {
    let directory, device;
    const deviceParts = path.split("/").slice(1);
    device = deviceParts[0] === "" ? "/" : deviceParts[0];
    const dirParts = path.split("/").slice(2).join("/");
    directory = dirParts === "" ? "/" : dirParts;
    return { directory, device };
  } else {
    throw Error("Path should be a string");
  }
};
const _dir_cleanup_queue_db = (prisma) =>
  new Promise(async (resolve, reject) => {
    try {
      const dirs = await prisma.directoryQueue.findMany(
        {});
      for (const dir of dirs) {
        const { device, folder } = getFolderDevicePath(join(SYNC_PATH, dir.path), false);
        const files = await prisma.fileQueue.findMany({
          where: {
            path: dir.path
          }
        });
        if (files.length === 0) {
          await prisma.directoryQueue.delete({
            where: {
              device_folder_path: {
                device, folder, path: dir.path
              }
            }
          })
        }
      }
      resolve()
    } catch (err) {
      reject(err);
    }
  });

const createFolders = (dirs) =>
  new Promise(async (resolve, reject) => {
    const success = [];
    const failure = [];
    for (const dir of dirs) {
      try {
        const url = new URL(process.env.CREATE_FOLDER_API);
        url.searchParams.append("path", dir.path);
        url.searchParams.append("device", dir.device);
        url.searchParams.append("created_at", dir.created_at.toISOString());
        url.searchParams.append("username", process.env.USER_EMAIL);
        const { data } = await axios.post(url.href);
        success.push({ ...data, status: "createFolder_success" });
        await prisma.directoryQueue.delete({
          where: {
            device_folder_path: {
              device: dir.device,
              path: dir.path,
              folder: dir.folder,
            },
          },
        });
      } catch (err) {
        console.error(`Failed to create folder ${dir.path}:`, err.message);
        failure.push({ [dir.path]: false, status: "createFolder_failure" });
      }
    }
    resolve([success, failure]);
  });

const deleteFolder = (foldersToDelete) =>
  new Promise(async (resolve, reject) => {
    const success = [];
    const failure = [];
    for (const dir of foldersToDelete) {
      try {
        const { directory } = getDirDevicePath(dir.path);
        const url = new URL(process.env.DELETE_FOLDER_API);
        url.searchParams.append("path", dir.path);
        url.searchParams.append("folder", dir.folder);
        url.searchParams.append("directory", directory);
        url.searchParams.append("username", process.env.USER_EMAIL);
        url.searchParams.append("device", dir.device);
        const { data } = await axios.delete(url.href);
        success.push({ ...data, status: "delete_success" });
        await prisma.directoryQueue.delete({
          where: {
            device_folder_path: {
              device: dir.device,
              path: dir.path,
              folder: dir.folder,
            },
          },
        });
      } catch (err) {
        console.error(`Failed to delete folder ${dir.path}:`, err.message);
        failure.push({ [dir.path]: false, status: "delete_fail" });
      }
    }
    resolve([success, failure]);
  });

export const updateFolders = (dirs) =>
  new Promise(async (resolve, reject) => {
    try {
      const foldersToCreate = [];
      const foldersToDelete = [];

      console.log("Dirs:: ", dirs);
      for (const [_, dir] of Object.entries(dirs)) {
        if (dir.sync_status === "new") {
          foldersToCreate.push({ ...dir });
        }
        if (dir.sync_status === "delete") {
          foldersToDelete.push({ ...dir });
        }
      }
      const [a, b] = await createFolders(foldersToCreate);
      const [c, d] = await deleteFolder(foldersToDelete);
      resolve([
        [...a, ...c],
        [...b, ...d],
      ]);
    } catch (err) {
      reject(err);
    }
  });

export const uploadFiles = (files) =>
  new Promise(async (resolve, reject) => {
    const successUpload = [];
    const failedUpload = [];
    for (const file of files) {
      try {
        const response = await uploadFile(file);
        successUpload.push(response);
        await prisma.$transaction(async (db) => {
          await removeFileQueueDb(db, file, true);
        });
      } catch (err) {
        console.error(`Failed to upload file ${file.filename}:`, err.message);
        failedUpload.push({ [file.filename]: false, status: "upload_failure" });
      }
    }
    if (files.length > 0) {

      await _dir_cleanup_queue_db(prisma);
    }
    resolve([successUpload, failedUpload]);
  });

export const deleteFiles = (files) => new Promise(async (resolve, reject) => {
  try {
    const filesToDelete = []
    console.log("File: ", files);
    for (const file of files) {
      const { directory, device } = getDirDevicePath(file.path)
      const queryParams = new URLSearchParams({ device, dir: directory, file: file.filename }).toString();
      const data = {
        id: file.uuid,
        path: queryParams,
        origin: file.uuid,
        dir: directory,
        versions: 1,
        username: process.env.USER_EMAIL
      }
      filesToDelete.push(data)
    }
    console.log("Files to Delete : ", filesToDelete);
    if (filesToDelete.length > 0) {
      await axios.delete(process.env.DELETE_FILES_API, { data: { fileIds: filesToDelete, directories: [] } });
    }
    resolve();
  } catch (err) {
    reject(err)
  }
})

export const uploadFile = (file) =>
  new Promise(async (resolve, reject) => {
    try {
      const { directory, device } = getDirDevicePath(file.path);
      let type = mime.lookup(file.filename).toString();
      console.log("Type: ", type.length);
      let filestat = {
        mtime: file.last_modified,
        size: parseInt(file.size),
        type: type,
        checksum: file.hashvalue,
        isModified: file.sync_status === "modified" ? true : false,
        device: device,
        version: 1,
        username: process.env.USER_EMAIL,
        filename: file.filename,
        directory: directory,
        height: file?.height,
        width: file?.width,
      };
      if (type.split("/")[0] === "image") {
        const image = sharp(file.absPath);
        const { height, width } = await image.metadata();
        filestat.height = parseInt(height);
        filestat.width = parseInt(width);
      } else {
        filestat.type = file.filename.split(".").at(-1);
      }
      const form = new FormData();
      const fileStream = createReadStream(file.absPath);
      form.append("file", fileStream);
      form.append("filestat", JSON.stringify(filestat));
      const headers = {
        ...form.getHeaders(),
        filestat: JSON.stringify(filestat),
      };
      const response = await axios.post(process.env.FILE_SYNC_UP_API, form, {
        headers: { ...headers },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      resolve(response.data);
    } catch (err) {
      reject(err);
    }
  });
