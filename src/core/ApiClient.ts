// src/core/ApiClient.ts - Handles API communication with the sync server

import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'node:fs';
import mime from 'mime-types';
import sharp from 'sharp';
import type {
  FileMetadata,
  DirectoryMetadata,
  UploadResult,
  CloudMetadata
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
  
  /**
   * Upload a file to the server
   */
  async uploadFile(file: FileMetadata): Promise<UploadResult> {
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
      
      const response = await this.client.post('/api/file/upload', form, {
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
  
  /**
   * Delete a file from the server
   */
  async deleteFile(file: FileMetadata): Promise<void> {
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
    
    await this.client.delete('/api/file/delete', {
      data: { fileIds: [data], directories: [] }
    });
  }
  
  /**
   * Create a folder on the server
   */
  async createFolder(dir: DirectoryMetadata): Promise<void> {
    const params = new URLSearchParams({
      path: dir.path,
      device: dir.device,
      created_at: dir.created_at.toISOString(),
      username: this.userEmail
    });
    
    await this.client.post(`/api/folder/create?${params}`);
  }
  
  /**
   * Delete a folder from the server
   */
  async deleteFolder(dir: DirectoryMetadata): Promise<void> {
    const { directory } = this.parsePath(dir.path);
    const params = new URLSearchParams({
      path: dir.path,
      folder: dir.folder,
      directory: directory,
      username: this.userEmail,
      device: dir.device
    });
    
    await this.client.delete(`/api/folder/delete?${params}`);
  }
  
  /**
   * Get metadata from cloud
   */
  async getMetadata(): Promise<CloudMetadata> {
    const response = await this.client.get(`/api/metadata/${this.userEmail}`);
    
    return {
      files: response.data.files || [],
      directories: response.data.directories || []
    };
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
