// Run on ECS: node /tmp/fix-gen-save.js
// Fix: generate-storyboard should merge frames by ID, not overwrite
const fs = require('fs');
const file = '/opt/blueprint-editor/server.cjs';
let code = fs.readFileSync(file, 'utf8');

const old = `// Save to project
      if (projectId) {
        try {
          var proj = readProject(projectId);
          if (proj) {
            proj.storyboardFrames = updatedFrames;
            proj.updatedAt = new Date().toISOString();
            writeProject(proj);
          }
        } catch(saveErr) { console.error('[generate-storyboard] Save error:', saveErr.message); }
      }`;

const fix = `// Save to project (merge by frame ID, don't overwrite all)
      if (projectId) {
        try {
          var proj = readProject(projectId);
          if (proj) {
            var existing = proj.storyboardFrames || [];
            var updateMap = {};
            for (var ui = 0; ui < updatedFrames.length; ui++) {
              updateMap[updatedFrames[ui].id] = updatedFrames[ui];
            }
            // Merge: update existing frames by ID, keep untouched frames intact
            proj.storyboardFrames = existing.map(function(ef) {
              if (updateMap[ef.id]) {
                // Only update imageUrl from generated result, keep other fields from existing
                return Object.assign({}, ef, { imageUrl: updateMap[ef.id].imageUrl || ef.imageUrl });
              }
              return ef;
            });
            proj.updatedAt = new Date().toISOString();
            writeProject(proj);
          }
        } catch(saveErr) { console.error('[generate-storyboard] Save error:', saveErr.message); }
      }`;

if (code.includes(old)) {
  code = code.replace(old, fix);
  fs.writeFileSync(file, code, 'utf8');
  console.log('PATCHED OK');
} else {
  console.log('Pattern not found! Manual check needed.');
  // Show what's around line 870
  const lines = code.split('\n');
  for (let i = 868; i < 885 && i < lines.length; i++) {
    console.log((i+1) + ': ' + lines[i]);
  }
}
