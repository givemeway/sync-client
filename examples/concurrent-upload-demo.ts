// examples/concurrent-upload-demo.ts - Example showing concurrent uploads

import { ApiClient } from '../src/core/ApiClient.js';
import { UploadPool } from '../src/utils/UploadPool.js';
import type { FileMetadata } from '../src/types/index.js';

// Mock file data for demonstration
const mockFiles: FileMetadata[] = [
  {
    filename: 'file1.txt',
    path: '/documents',
    hashvalue: 'abc123',
    size: 1024,
    inode: '12345',
    last_modified: new Date(),
    absPath: '/path/to/file1.txt',
    sync_status: 'new'
  },
  // ... more files
];

async function demonstrateConcurrentUploads() {
  // Create API client
  const apiClient = new ApiClient(
    process.env.API_BASE_URL || 'https://api.example.com',
    process.env.USER_EMAIL || 'user@example.com'
  );
  
  // Create upload pool with 5 concurrent uploads
  const uploadPool = new UploadPool(5);
  
  console.log('🚀 Starting concurrent uploads...');
  console.log(`Concurrency: ${uploadPool.getConcurrency()}`);
  
  // Upload all files concurrently
  const uploadPromises = mockFiles.map(file => 
    uploadPool.upload(file, (f) => apiClient.uploadFile(f))
  );
  
  // Monitor progress
  const progressInterval = setInterval(() => {
    const stats = uploadPool.getStats();
    console.log(`📊 Progress: ${stats.completed}/${stats.total} | ` +
                `In Progress: ${stats.inProgress} | Failed: ${stats.failed}`);
  }, 1000);
  
  try {
    // Wait for all uploads to complete
    const results = await Promise.all(uploadPromises);
    
    clearInterval(progressInterval);
    
    // Final stats
    const finalStats = uploadPool.getStats();
    console.log('\n✅ All uploads complete!');
    console.log(`Total: ${finalStats.total}`);
    console.log(`Success: ${finalStats.completed}`);
    console.log(`Failed: ${finalStats.failed}`);
    
    return results;
  } catch (error) {
    clearInterval(progressInterval);
    console.error('❌ Upload error:', error);
    throw error;
  }
}

// Comparison with sequential uploads
async function sequentialVsConcurrent() {
  console.log('\n📊 Performance Comparison:\n');
  
  // Sequential (old way)
  console.time('Sequential');
  for (const file of mockFiles) {
    // await uploadFile(file); // One at a time
  }
  console.timeEnd('Sequential');
  
  // Concurrent (new way)
  console.time('Concurrent');
  const pool = new UploadPool(5);
  await Promise.all(
    mockFiles.map(f => pool.upload(f, async (file) => ({
      success: true,
      fileId: 'mock-id'
    })))
  );
  console.timeEnd('Concurrent');
  
  console.log('\n💡 Concurrent is typically 5x faster for I/O-bound uploads!');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateConcurrentUploads()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
