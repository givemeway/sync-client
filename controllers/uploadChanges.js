const uploadFile = (file) => new Promise(async (resolve, reject) => {
  try {

    let fileStat = {
      atimeMs: file.lastModified,
      mtimeMs: file.lastModified,
      mtime: file.lastModified,
      modified: file.modified,
      size: file.size,
      socket_main_id: null,
      name: file.name,
      idx: file.idx,
      type: file.type,
      id:
        file.webkitRelativePath === "" ? file.name : file.webkitRelativePath,
    };

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
