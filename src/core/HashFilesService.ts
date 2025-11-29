import { File } from '../../DB/prisma-client/index.js';
import { ScannedFile } from '../types/index.js';
import { HashWorkerPool } from '../utils/HashWorkerPool.js';

export class HashFilesService {

  /**
   * Compute hashes for scanned files.
   * Checks against existing DB files to skip hashing if size/mtime matches.
   * Updates the hash property of the ScannedFile objects in place.
   */
  async computeHashes(
    scannedFiles: ScannedFile[],
    dbFiles: File[],
    hashPool: HashWorkerPool
  ): Promise<void> {
    // Index DB files for fast lookup
    const dbFilesMap = new Map<string, File>();
    for (const f of dbFiles) {
      dbFilesMap.set(`${f.path}/${f.filename}`, f);
    }

    const filesToHash: ScannedFile[] = [];

    for (const sFile of scannedFiles) {
      // Normalize path to match DB key format
      let path = sFile.path;
      if (!path.startsWith('/')) path = '/' + path;
      const key = `${path}/${sFile.filename}`;

      const dbFile = dbFilesMap.get(key);

      if (!dbFile) {
        // New file -> Needs hash
        filesToHash.push(sFile);
      } else {
        // Existing file -> Check if modified
        // Note: dbFile.size is BigInt
        const sizeChanged = dbFile.size !== BigInt(sFile.size);
        // Compare timestamps
        const mtimeChanged = dbFile.last_modified.getTime() !== sFile.mtime.getTime();

        if (sizeChanged || mtimeChanged) {
          // Modified -> Needs hash
          filesToHash.push(sFile);
        } else {
          // Unchanged -> Reuse hash from DB
          sFile.hash = dbFile.hashvalue;
        }
      }
    }

    if (filesToHash.length > 0) {
      console.log(`Computing hashes for ${filesToHash.length} files using worker pool...`);
      await Promise.all(filesToHash.map(async (f) => {
        try {
          f.hash = await hashPool.run(f.absPath);
        } catch (err) {
          console.error(`Failed to hash file ${f.absPath}:`, err);
          f.hash = "";
        }
      }));
    }
  }
}
