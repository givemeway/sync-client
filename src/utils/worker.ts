// src/utils/worker.ts - Worker thread for file hashing

import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

parentPort.on('message', async (filePath: string) => {
  try {
    const hash = await getFileHash(filePath);
    parentPort!.postMessage({ status: 'success', hash });
  } catch (error: any) {
    parentPort!.postMessage({ status: 'error', error: error.message });
  }
});

function getFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const hash = createHash('sha256');

    stream.on('data', (data) => {
      hash.update(data);
    });

    stream.on('error', (err) => {
      reject(err);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}
