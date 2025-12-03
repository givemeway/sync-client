import { watch } from "node:fs/promises";
import chokidar from "chokidar";

const ac = new AbortController();

const { signal } = ac;

export const watcherFn = (SYNC_PATH) => {
  return chokidar.watch(SYNC_PATH, {
    persistent: true,
    usePolling: true,
    alwaysStat: true,
    atomic: true,
  });
};

export const monitorFileSystem = async (SYNC_PATH, signal) => {
  try {
    const watcher = watch(SYNC_PATH, {
      recursive: true,
      signal,
    });
    for await (const event of watcher) {
      console.log("event", event);
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    throw err;
  }
};

export { ac as abortController };
