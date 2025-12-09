
import dotenv from 'dotenv';
import { ApiClient } from '../src/core/ApiClient.js';

dotenv.config();

const config = {
  apiBaseUrl: process.env.API_BASE_URL || '',
  userEmail: process.env.USER_EMAIL || ''
};

async function testConnection() {
  console.log('🧪 Testing connection to:', config.apiBaseUrl);
  console.log('👤 User:', config.userEmail);

  if (!config.apiBaseUrl || !config.userEmail) {
    console.error('❌ Missing configuration!');
    return;
  }

  const client = new ApiClient(config.apiBaseUrl, config.userEmail);
  
  try {
    const start = Date.now();
    const metadata = await client.getMetadata();
    const duration = Date.now() - start;

    if (metadata.success) {
      console.log(`✅ Connection Successful! (${duration}ms)`);
      if (metadata.files) console.log(`📄 Files on server: ${metadata.files.length}`);
      if (metadata.directories) console.log(`📁 Directories on server: ${metadata.directories.length}`);
    } else {
      console.error('❌ Connection Failed (API Error):', metadata.error);
    }
  } catch (error: any) {
    console.error('❌ Connection Failed (Exception):', error.message);
    if (error.code === 'ECONNREFUSED') {
       console.error('   -> Check if the server is running at ' + config.apiBaseUrl);
    }
  }
}

testConnection();
