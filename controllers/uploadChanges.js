import axios from "axios";
import mimetype from "mime-types";
import dotenv from "dotenv";
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

export const uploadFile = (file) => new Promise(async (resolve, reject) => {
  try {
    const { directory, device } = get_dir_device_path(file.path)
    let filestat = {
      mtime: file.last_modified,
      size: parseInt(file.size),
      type: mimetype.lookup(file.filename),
      checksum: file.hashvalue,
      isModified: false,
      device: device,
      version: 1,
      username: "sand.kumar.gr@gmail.com",
      filename: file.filename,
      directory: directory,
      height: file?.height,
      width: file?.width
    };
    console.log(filestat)
    const config = {
      headers: {
        "Content-Type": "application/json",
      },
    }
    await axios.post(process.env.FILE_SYNC_UP_API, { filestat }, config);

  } catch (err) {
    console.log(err)
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
