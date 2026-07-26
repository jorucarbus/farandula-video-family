const fs = require('fs');
const path = require('path');

const INSUMOS_DIR = 'temp-insumos';
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// Create insumos directory if it doesn't exist
function ensureInsumosDir() {
  if (!fs.existsSync(INSUMOS_DIR)) {
    fs.mkdirSync(INSUMOS_DIR, { recursive: true });
  }
}

// Cleanup old insumos folders
async function cleanupOldInsumos() {
  try {
    ensureInsumosDir();

    const now = Date.now();
    const files = fs.readdirSync(INSUMOS_DIR);

    let deletedCount = 0;
    for (const file of files) {
      const filePath = path.join(INSUMOS_DIR, file);
      const stat = fs.statSync(filePath);
      const age = now - stat.mtimeMs;

      if (age > MAX_AGE) {
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
        deletedCount++;
        console.log(`🗑️  Cleanup: deleted ${file} (age: ${(age / 1000 / 60 / 60).toFixed(1)}h)`);
      }
    }

    if (deletedCount === 0) {
      console.log('✅ Cleanup: no old insumos found');
    } else {
      console.log(`✅ Cleanup: deleted ${deletedCount} items`);
    }
  } catch (error) {
    console.error('❌ Cleanup error:', error.message);
  }
}

// Start periodic cleanup
function start() {
  console.log('🔄 Cleanup cron started (interval: 6h, max age: 24h)');

  // Run immediately on startup
  cleanupOldInsumos();

  // Then run periodically
  setInterval(cleanupOldInsumos, CLEANUP_INTERVAL);
}

module.exports = {
  start,
  cleanupOldInsumos,
  ensureInsumosDir,
};
