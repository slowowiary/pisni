// Автоматично генерує public/songs/index.json зі списку папок
const fs   = require('fs');
const path = require('path');

const songsDir = path.join(__dirname, 'public', 'songs');
const outFile  = path.join(songsDir, 'index.json');

try {
  const entries = fs.readdirSync(songsDir, { withFileTypes: true });
  const folders = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  fs.writeFileSync(outFile, JSON.stringify(folders, null, 2));
  console.log('✅ songs/index.json:', folders);
} catch(e) {
  console.error('❌ build-index error:', e.message);
  process.exit(1);
}
