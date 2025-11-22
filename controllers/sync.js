import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
const username = "sand.kumar.gr@gmail.com";

//query the server to get all file metadata
//query the local Main DB.
//compare the local and cloud DB
//identify the files/folders that needs to be sycned to local machine.
//identify the files/folders that needs to be synced to cloud.
//check if the files that needs to be synced to local machine is conflicting with the local changes that needs to be sent to cloud
//If conflict rename the files/folders downloaded from the cloud to preserve the cloud and local changes
//sync the changes to the cloud
//keep polling the server regularly to check for changes in the cloud and to sync the local changes to cloud

const _delete_duplicates = (localItems, cloudItems, queuedItems) => {
  let syncUp = { ...localItems, ...queuedItems };
  let syncDown = { ...cloudItems }

  for (const [path, objs] of Object.entries(localItems)) {
    for (const [name, _] of Object.entries(objs)) {
      if (cloudItems[path] && cloudItems[path][name]) {
        if (!queuedItems[path] || !queuedItems[path][name]) {
          delete syncUp[path][name]
          delete syncDown[path][name]
        }
      }
      //if (syncUp[path][name] && queuedItems[path] && queuedItems[path][name]) {
      //  syncUp[path][name] = { ...queuedItems[path][name] }
      //}
    }
  }

  //for (const [path, objs] of Object.entries(queuedItems)) {
  //for (const [name, _] of Object.entries(objs)) {
  //if (cloudItems[path] && cloudItems[path][name] && queuedItems[path][name]["sync_status"] === "delete") {
  //delete syncDown[path][name]
  //}
  //}
  //}

  return [remove_empty_key(syncUp), remove_empty_key(syncDown)]
}

const _find_conflict_items = (localItems, queuedItems) => {
  let sync = { ...localItems }
  for (const [path, objs] of Object.entries(localItems)) {
    for (const [name, _] of Object.entries(objs)) {
      if (queuedItems[path] && queuedItems[path][name]) {
        sync[path][name] = { ...sync[path][name], isConflict: true }
      } else {
        sync[path][name] = { ...sync[path][name], isConflict: false }
      }
    }
  }
  return sync
}

const remove_empty_key = (obj) => {
  const objCopy = { ...obj }
  for (const [k, v] of Object.entries(objCopy)) {
    if (Object.entries(v).length === 0) {
      delete objCopy[k]
    }
  }
  return objCopy
}

export const _get_to_be_synced_items = (localFiles, localDirs, cloudFiles, cloudDirs, queuedFiles, queuedDirs) => {
  let [localFilesSyncUp, cloudFilesSyncDown] = _delete_duplicates(localFiles, cloudFiles, queuedFiles);
  let [localDirsSyncUp, cloudDirsSyncDown] = _delete_duplicates(localDirs, cloudDirs, queuedDirs);
  cloudFilesSyncDown = _find_conflict_items(cloudFilesSyncDown, queuedFiles);
  cloudDirsSyncDown = _find_conflict_items(cloudDirsSyncDown, queuedDirs);
  return [localFilesSyncUp, localDirsSyncUp, cloudFilesSyncDown, cloudDirsSyncDown]
}

export const _to_files_Dir_obj = (cloudItems) => {
  const filesObj = {}
  const dirsObj = {}
  for (const item of cloudItems) {
    if (item.type === "file") {
      if (filesObj[item.path]) {
        filesObj[item.path] = { ...filesObj[item.path], [item.filename]: { ...item } }
      } else {
        filesObj[item.path] = { [item.filename]: { ...item } }
      }
    }
    else if (item.type === "folder") {
      if (dirsObj[item.path]) {
        dirsObj[item.path] = { ...dirsObj[item.path], [item.path]: { ...item } }
      } else {
        dirsObj[item.path] = { [item.path]: { ...item } }
      }
    }
  }
  return { filesObj, dirsObj }
}

export const get_cloud_files_folders_metadata = () => new Promise(async (resolve, reject) => {
  try {
    const response = await axios.get(process.env.SYNC_METADATA_API + username);
    resolve(response.data);
  } catch (err) {
    console.error(err);
  }
});
