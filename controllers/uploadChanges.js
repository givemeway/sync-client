import axios from "axios";
import mime from "mime-types";
import { createReadStream } from "node:fs"
import FormData from "form-data";
import dotenv from "dotenv";
import sharp from "sharp";
import { _remove_file_queue_db } from "./get_file_folder_metadata.js";
import { prisma } from "../Config/prismaDBConfig.js";
dotenv.config();

const get_dir_device_path = (path) => {
  if (typeof path === "string") {
    let directory, device;
    const deviceParts = path.split("/").slice(1);
    device = deviceParts[0] === "" ? "/" : deviceParts[0];
    const dirParts = path.split("/").slice(2).join("/");
    directory = dirParts === "" ? "/" : dirParts
    return { directory, device }
  } else {
    throw Error("Path should be a string");
  }
}

export const uploadFiles = (files) => new Promise(async (resolve, reject) => {
  const successUpload = []
  const failedUpload = []
  for (const file of files) {
    try {
      const response = await uploadFile(file);
      successUpload.push(response)
      await _remove_file_queue_db(prisma, file, true);
    } catch (err) {
      failedUpload.push({ [file.filename]: false, err: err })

    }
  }
  resolve([successUpload, failedUpload])

})

export const uploadFile = (file) => new Promise(async (resolve, reject) => {
  try {
    const { directory, device } = get_dir_device_path(file.path)
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
      username: "sand.kumar.gr@gmail.com",
      filename: file.filename,
      directory: directory,
      height: file?.height,
      width: file?.width
    };
    if (type.split("/")[0] === "image") {
      const image = sharp(file.absPath)
      const { height, width } = await image.metadata()
      filestat.height = parseInt(height);
      filestat.width = parseInt(width);
    } else {
      filestat.type = file.filename.split(".").at(-1);
    }
    const form = new FormData()
    const fileStream = createReadStream(file.absPath)
    form.append("file", fileStream)
    form.append("filestat", JSON.stringify(filestat));
    const headers = { ...form.getHeaders(), filestat: JSON.stringify(filestat) }
    const response = await axios.post(process.env.FILE_SYNC_UP_API, form, { headers: { ...headers }, maxContentLength: Infinity, maxBodyLength: Infinity });
    resolve(response.data);
  } catch (err) {
    reject(err)
  }
});

const deleteItem = () => new Promise(async (resolve, reject) => {
  try {

  } catch (err) {
    console.log(err)
    reject(err)
  }
});

const createFolder = () => new Promise(async (resolve, reject) => {
  try {

  } catch (err) {
    console.log(err)
    reject(err)
  }
});
