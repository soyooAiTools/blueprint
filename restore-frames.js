// Run on ECS: node /tmp/restore-frames.js
// Read current project, check frame count, if < 15 restore from API backup
const http = require('http');
const fs = require('fs');

const projFile = '/opt/blueprint-editor/server-data/projects/proj_1772461528991_tqa3gq.json';
const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
console.log('Current frames:', (proj.storyboardFrames || []).length);

if ((proj.storyboardFrames || []).length >= 15) {
  console.log('Already 15+ frames, no restore needed');
  process.exit(0);
}

// Backup current
fs.writeFileSync(projFile + '.bak', JSON.stringify(proj, null, 2), 'utf8');
console.log('Backed up current to .bak');

// We need to reconstruct from the images that still exist
const imgDir = '/opt/blueprint-editor/server-data/images/proj_1772461528991_tqa3gq';
const images = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).sort() : [];
console.log('Images on disk:', images.length, images);

console.log('\nFrame 1 data preserved. Need to re-parse to restore remaining 14 frames.');
console.log('Recommend: re-run parse-storyboard with same PDF to regenerate all 15 frames.');
