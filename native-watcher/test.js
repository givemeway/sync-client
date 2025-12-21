const { Watcher } = require("./build/Release/watcher");
const path = require("path");
const fs = require("fs");

// Target the real sync folder
const targetDir = "C:\\Users\\Sandeep Kumar\\Desktop\\sync_folder";

if (!fs.existsSync(targetDir)) {
  console.log(
    `Directory ${targetDir} does not exist. Please create it or change the path.`
  );
  process.exit(1);
}

console.log("Starting Native Watcher on:", targetDir);
console.log("Try creating, renaming, or deleting files in that folder now.");

const watcher = new Watcher(targetDir, (event) => {
  const actionNames = {
    1: "ADD",
    2: "REMOVE",
    3: "MODIFY",
    4: "RENAME OLD",
    5: "RENAME NEW",
  };

  const actionStr = actionNames[event.action] || `UNKNOWN (${event.action})`;
  console.log(`[RAW] ${actionStr} -> ${event.filename}`);
});

watcher.start();

// Keep process alive
setInterval(() => {}, 1000);
