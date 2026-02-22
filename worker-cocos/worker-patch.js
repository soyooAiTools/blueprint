// Cocos project pre-build patch
const fs = require('fs');
const path = require('path');

function detectScenes(projectDir) {
  var scenes = [];
  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    try {
      var entries = fs.readdirSync(dir, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        if (['build','temp','node_modules','library'].indexOf(entries[i].name) >= 0) continue;
        var full = path.join(dir, entries[i].name);
        var rel = prefix + '/' + entries[i].name;
        if (entries[i].isDirectory()) walk(full, rel);
        else if (entries[i].name.endsWith('.scene')) scenes.push(rel);
      }
    } catch(e) {}
  }
  walk(path.join(projectDir, 'assets'), 'assets');
  return scenes;
}

function fixProjectSettings(projectDir, scenes) {
  var settingsPath = path.join(projectDir, 'settings', 'builder.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    var settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    console.log('[patch] Project settings found, scenes: ' + scenes.join(', '));
    return true;
  } catch(e) { console.log('[patch] Could not read settings: ' + e.message); return false; }
}

module.exports = { detectScenes, fixProjectSettings };

if (require.main === module) {
  var dir = process.argv[2] || 'D:\\work\\test-cocos';
  console.log('Scenes:', detectScenes(dir));
}
