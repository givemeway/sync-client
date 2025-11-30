// src/main.ts - Main entry point to run the sync client (like old index.js)

import dotenv from 'dotenv';
import { SyncClient } from './SyncClient.js';
import type { SyncClientConfig } from './types/index.js';
dotenv.config();
// Load configuration from environment variables
const config: SyncClientConfig = {
  syncPath: process.env.SYNC_PATH || 'C:\\Users\\Sandeep Kumar\\Desktop\\sync_folder',
  apiBaseUrl: process.env.API_BASE_URL || '',
  userEmail: process.env.USER_EMAIL || '',
  poolSize: parseInt(process.env.POOL_SIZE || '4')
};

console.log('🚀 Starting Sync Client...');
console.log('Configuration:', {
  syncPath: config.syncPath,
  apiBaseUrl: config.apiBaseUrl,
  userEmail: config.userEmail
});

// Create the sync client
const client = new SyncClient(config);

// Listen to events
client.on('sync:started', () => {
  console.log('✅ Sync started');
});

client.on('sync:completed', () => {
  console.log('✅ Sync completed');
});

client.on('file:uploaded', (file) => {
  console.log('📤 Uploaded:', file);
});

client.on('error', (err) => {
  console.error('❌ Error:', err);
});

// Start the client
async function main() {
  try {
    await client.start();

    // The progress display will show the status automatically
    // Don't print anything here - it interferes with the progress line

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\n🛑 Shutting down...');
      await client.stop();
      console.log('✅ Stopped gracefully');
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n\n🛑 Shutting down...');
      await client.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Failed to start:', error);
    process.exit(1);
  }
}

// Run it!
main();
