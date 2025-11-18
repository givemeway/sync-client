type FileObj = {
  size: number,
  filename: string,
  last_modified: Date,
  path: string,
  hashvalue: string,
  dirID: string,
  inode: string
}

type Files = {
  [path: string]: {
    [filename: string]: FileObj
  }
}

type DirObj = {
  path: string,
  folder: string,
  device: string,
  uuid: string,
  created_at: Date
}

type Directory = {
  [path: string]: DirObj
}

export const compare_local_cloud_files = (cloudFiles: Files, localFiles: Files) => new Promise<{ localFilesToSync: Files; cloudFilesToSync: Files }>(async (resolve, reject) => {
  try {
    let localFilesToSync = { ...localFiles };
    let cloudFilesToSync = { ...cloudFiles }
    for (const [path, files] of Object.entries(cloudFiles)) {
      for (const [filename, _] of Object.entries(files)) {
        if (localFilesToSync[path] && localFilesToSync[path][filename]) {
          delete localFilesToSync[path][filename]
        }
      }
    }
    for (const [path, files] of Object.entries(localFiles)) {
      for (const [filename, _] of Object.entries(files)) {
        if (cloudFilesToSync[path] && cloudFilesToSync[path][filename]) {
          delete cloudFilesToSync[path][filename]
        }
      }
    }
    resolve({ localFilesToSync, cloudFilesToSync })
  } catch (err) {
    console.log(err);
    reject(err)
  }
});
