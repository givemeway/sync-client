import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

parentPort.on("message", async (filePath) => {
  try {
    const hash = await getFileHash(filePath);
    parentPort.postMessage({ status: "success", hash });
  } catch (error) {
    parentPort.postMessage({ status: "error", error: error.message });
  }
});

const getFileHash = (filePath) =>
  new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    let hash = createHash("sha256");
    stream.on("data", (data) => {
      hash.update(data);
    });
    stream.on("error", (err) => {
      reject(err);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
