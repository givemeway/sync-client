// src/utils/FilesystemScanner.ts - Utility to scan directories for rename detection

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { HashWorkerPool } from './HashWorkerPool.js';
import { FileMetadata } from '../types/index.js';
import type { ScannedFile, ScannedDirectory } from "../types/index.ts"

/**
 * FilesystemScanner utility
 * Scans a directory and returns files with metadata (inode, hash, etc.)
 * Used for rename detection set-difference algorithm
 */
export class FilesystemScanner {
  private hashPool: HashWorkerPool;
  private syncPath: string;

  constructor(hashPool: HashWorkerPool, syncPath: string) {
    this.hashPool = hashPool;
    this.syncPath = syncPath;
  }

  private toRelativePath(absPath: string): string {
    // Normalize both paths to forward slashes before substring
    const normalizedPath = absPath.replace(/\\/g, '/');
    const normalizedSyncPath = this.syncPath.replace(/\\/g, '/');

    const parts = normalizedPath.split(normalizedSyncPath);
    if (parts.length > 1) {
      let rel = parts[1];
      // Ensure leading slash
      if (!rel.startsWith('/')) rel = '/' + rel;
      return rel;
    }
    return absPath;
  }

  /**
   * Scan a directory and return all files with their metadata
   * @param dirPath - Absolute path to directory
   * @param filterInode - Optional inode to filter by
   * @param filterHash - Optional hash to filter by
   * @returns Array of scanned files with metadata
   */
  async scanDirectory(
    dirPath: string,
    filterInode?: string,
    filterHash?: string
  ): Promise<ScannedFile[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const files: ScannedFile[] = [];
      const relDirPath = this.toRelativePath(dirPath);
      for (const entry of entries) {

        if (!entry.isFile()) continue;

        const absPath = join(dirPath, entry.name);

        try {
          const stats = await stat(absPath);
          const inode = stats.ino.toString();

          // Apply inode filter if specified
          if (filterInode && inode !== filterInode) continue;

          // Calculate hash
          const hash = await this.hashPool.run(absPath);

          // Apply hash filter if specified
          if (filterHash && hash !== filterHash) continue;

          files.push({
            path: relDirPath,
            filename: entry.name,
            inode: inode,
            hash: hash,
            size: stats.size,
            mtime: stats.mtime,
            absPath: absPath
          });
        } catch (err) {
          console.error(`Error scanning file ${absPath}:`, err);
          // Skip files that can't be read
          continue;
        }

      }
      return files;
    } catch (err) {
      console.error(`Error scanning directory ${dirPath}:`, err);
      return [];
    }
  }

  /**
   * Scan a directory and return all subdirectories with their metadata
   * @param dirPath - Absolute path to directory
   * @returns Array of scanned subdirectories with metadata
   */
  async scanSubdirectories(dirPath: string, filterInode?: string): Promise<ScannedDirectory[] | []> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const dirs: ScannedDirectory[] = [];
      const relDirPath = this.toRelativePath(dirPath);

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const absPath = join(dirPath, entry.name);

        try {
          const stats = await stat(absPath);
          const inode = stats.ino.toString();
          if (filterInode === inode) {
            dirs.push({
              path: relDirPath === "/" ? "/" + entry.name : relDirPath + "/" + entry.name,
              name: entry.name,
              inode: inode,
              mtime: stats.mtime,
              absPath: absPath
            });
          }

        } catch (err) {
          console.error(`Error scanning directory ${absPath}:`, err);
          continue;
        }
      }

      return dirs;
    } catch (err) {
      console.error(`Error scanning directory ${dirPath}:`, err);
      return [];
    }
  }

  /**
   * Find files in directory with specific inode
   * @param dirPath - Absolute path to directory
   * @param inode - Inode to search for
   * @param hash - Optional hash to also match
   * @returns Array of matching files
   */
  async findFilesByInode(
    dirPath: string,
    inode: string,
    hash?: string
  ): Promise<ScannedFile[]> {
    return this.scanDirectory(dirPath, inode, hash);
  }

  /**
   * Recursively scan a directory and return all files and directories
   * @param dirPath - Absolute path to directory (defaults to syncPath)
   * @returns Object containing all files and directories found
   */
  async scan(dirPath: string = this.syncPath): Promise<{ files: ScannedFile[], dirs: ScannedDirectory[] }> {
    const result = {
      files: [] as ScannedFile[],
      dirs: [] as ScannedDirectory[]
    };

    try {
      // Get files in current directory
      const files = await this.scanDirectory(dirPath);
      result.files.push(...files);

      // Get subdirectories
      const dirs = await this.scanSubdirectories(dirPath);
      result.dirs.push(...dirs);

      // Recursively scan subdirectories
      for (const dir of dirs) {
        const subResult = await this.scan(dir.absPath);
        result.files.push(...subResult.files);
        result.dirs.push(...subResult.dirs);
      }
    } catch (err) {
      console.error(`Error recursively scanning ${dirPath}:`, err);
    }

    return result;
  }

  /**
   * Convert ScannedFile to FileMetadata format
   */
  toFileMetadata(scanned: ScannedFile, relativePath: string): FileMetadata {
    return {
      path: relativePath,
      filename: scanned.filename,
      hashvalue: scanned.hash,
      size: scanned.size,
      inode: scanned.inode,
      last_modified: scanned.mtime,
      absPath: scanned.absPath,
      sync_status: 'new'
    };
  }
}
