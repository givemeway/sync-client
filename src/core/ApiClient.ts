// src/core/ApiClient.ts - Handles API communication with the sync server

import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { createReadStream, createWriteStream } from 'node:fs';
import mime from 'mime-types';
import sharp from 'sharp';
import { join } from "node:path";
import {stat} from "node:fs/promises"
import { FileQueue, File } from '../../DB/prisma-client/index.js'
import type {
  DirectoryMetadata,
  SyncUploadResult,
  SyncFolderCreateResult,
  SyncDeleteResult,
  SyncRenameResult,
  CloudMetadataResult,
  CloudFolderMetadata,
  CloudFileMetadata,
  CloudMetadataResultError
} from '../types/index.js';

/**
 * ApiClient handles all communication with the sync server
 */
export class ApiClient {
  private client: AxiosInstance;
  private userEmail: string;

  constructor(baseUrl: string, userEmail: string) {
    this.userEmail = userEmail;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  }

  private getDirDevice(path: string): { device: string, dir: string } {
    const subPathArr = path.split(/[/\\]/)
    const device = subPathArr[1] === "" ? "/" : subPathArr[1];
    const dir = subPathArr.slice(2).join("/");
    return { device, dir: dir === "" ? "/" : dir }
  }
  /**
   * Download a file from the server
   */
  async downloadFile(file: CloudFileMetadata, absPath: string): Promise<{success: boolean, ino: number} | {success: false, error: string}> {
    try {
      const { dir, device } = this.getDirDevice(file.path);
      const urlParam = new URLSearchParams("")
      urlParam.set("file", file.filename);
      urlParam.set("dir", dir);
      urlParam.set("device", device);
      urlParam.set("uuid", file.uuid);
      urlParam.set("db", "file");
      urlParam.set("username", this.userEmail);
      const queryString = urlParam.toString();

      const response = await this.client.get(`/syncDownFile?${queryString}`, {
        responseType: "stream"
      });
      const writer = createWriteStream(absPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', async () => {
          try {
            const {ino} = await stat(absPath);
            resolve({success: true, ino});
          } catch(err: any) {
             resolve({success: false, error: err.message});
          }
        });
        writer.on('error', (err) => resolve({success: false, error: err.message}));
      });
    } catch (error:any) {
      console.error(`Failed to download file: ${error}`);
      return {success: false, error: error.message};
    }
  }

  /**
   * Upload a file to the server
   */
  async uploadFile(file: FileQueue): Promise<SyncUploadResult> {
    try {
      const { directory, device } = this.parsePath(file.path);
      let type = mime.lookup(file.filename)?.toString() || 'application/octet-stream';
      const filestat: any = {
        mtime: file.last_modified,
        size: parseInt(file.size.toString()),
        type: type,
        checksum: file.hashvalue,
        isModified: file.sync_status === 'modified',
        device: device,
        version: 1,
        username: this.userEmail,
        filename: file.filename,
        directory: directory
      };
      // Get image dimensions if it's an image
      if (type.split('/')[0] === 'image') {
        try {
          const image = sharp(file.absPath);
          const { height, width } = await image.metadata();
          filestat.height = height;
          filestat.width = width;
        } catch (err) {
          // Not a valid image or sharp can't process it
          filestat.type = file.filename.split('.').slice(-1)[0];
        }
      } else {
        filestat.type = file.filename.split('.').slice(-1)[0];
      }

      const form = new FormData();
      const fileStream = createReadStream(file.absPath);
      form.append('file', fileStream);
      form.append('filestat', JSON.stringify(filestat));

      const headers = {
        ...form.getHeaders(),
        filestat: JSON.stringify(filestat)
      };

      const response = await this.client.post('/syncUpFile', form, {
        headers
      });

      return {
        success: true,
        fileId: response.data.id
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  async renameFile(file: FileQueue): Promise<SyncRenameResult> {
    try {
      const { dir, device } = this.getDirDevice(file.path);
      const data = {
        type: 'fi',
        dir, device, filename: file.old_filename, to: file.filename,
        origin: ""
      }
      const response = await this.client.post('/renameItems', { data: { ...data } })
      return {
        success: true,
        type: 'fi',
        oldName: response.data.oldName || "",
        newName: response.data.newName || ""
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  async deleteFile(file: FileQueue): Promise<SyncDeleteResult> {
    try {
      const { directory, device } = this.parsePath(file.path);
      const queryParams = new URLSearchParams({
        device,
        dir: directory,
        file: file.filename
      }).toString();
      const data = {
        id: file.uuid,
        path: queryParams,
        origin: file.uuid,
        dir: directory,
        versions: 1,
        username: this.userEmail
      };
      const response = await this.client.delete('/deleteFiles', {
        data: { fileIds: [data], directories: [], username: this.userEmail }
      });
      return {
        success: true,
        type: "fi",
        itemId: response.data.itemId || file.uuid,
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }

  /**
   * Create a folder on the server
   */
  async createFolder(dir: DirectoryMetadata): Promise<SyncFolderCreateResult> {
    try {
      const params = new URLSearchParams({
        path: dir.path,
        device: dir.device,
        created_at: dir.created_at.toISOString(),
        username: this.userEmail
      });

      const response = await this.client.post(`/createFolder?${params}`);
      return {
        success: true,
        folderCreated: response.data.folderCreated || dir.path,
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }
  /**
   * Delete a folder from the server
   */
  async deleteFolder(dir: DirectoryMetadata): Promise<SyncDeleteResult> {
    try {
      const { directory } = this.parsePath(dir.path);
      const params = new URLSearchParams({
        path: dir.path,
        folder: dir.folder,
        directory: directory,
        username: this.userEmail,
        device: dir.device
      });

      const response = await this.client.delete(`/deleteFolder?${params}`);
      return {
        success: true,
        type: "fo",
        itemId: response.data.itemId || dir.path
      }
    } catch (err: any) {
      return {
        success: false,
        error: err.message
      }
    }
  }
  /**
   * Get metadata from cloud
   */
  async getMetadata(): Promise<CloudMetadataResult | CloudMetadataResultError> {
    try {
      const response = await this.client.get(`/getSyncItems?username=${this.userEmail}`);
      const items = response.data.items;
      const files: CloudFileMetadata[] = items.filter((f: CloudFileMetadata) => f.type === "file");
      const folders: CloudFolderMetadata[] = items.filter((f: CloudFolderMetadata) => f.type !== "file");
      return {
        success: true,
        files: files || [],
        directories: folders || []
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      }
    }
  }
  /**
   * Parse path into directory and device
   */
  private parsePath(path: string): { directory: string; device: string } {
    const deviceParts = path.split('/').slice(1);
    const device = deviceParts[0] === '' ? '/' : deviceParts[0];
    const dirParts = path.split('/').slice(2).join('/');
    const directory = dirParts === '' ? '/' : dirParts;

    return { directory, device };
  }
}
