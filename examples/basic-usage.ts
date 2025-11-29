// examples/basic-usage.ts - Example of how to use the SyncClient

import {Sync Client, type SyncClientConfig } from '../src/index.js';

const config: SyncClientConfig = {
  syncPath: 'C:\\Users\\Sandeep Kumar\\Desktop\\sync_folder',
  apiBaseUrl: process.env.API_BASE_URL || '',
  userEmail: process.env.USER_EMAIL || '',
};

const client = new SyncClient(config);

// Listen to events
client.on('sync:started', () => {
  console.log('✅ Sync started');
});

client.on('sync:completed', () => {
  console.log('✅ Sync completed');
});

client.on('file:uploaded', (file) => {
  console.log('📤 Uploaded:', file.filename);
});

client.on('error', (err) => {
  console.error('❌ Error:', err);
});

// Start the client
async function main() {
  try {
    console.log('🚀 Starting Sync Client...');
    await client.start();
    
    // Get status
    const status = client.getStatus();
    console.log('Status:', status);
    
    // Keep running
    process.on('SIGINT', async () => {
      console.log('\n🛑 Stopping...');
      await client.stop();
      process.exit(0);
    });
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

main();
