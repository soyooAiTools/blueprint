/**
 * Cleanup old WebGL builds
 * Usage: node engine/cleanup-old-builds.cjs [--days 7] [--dry-run]
 */

var fs = require('fs');
var path = require('path');

var WEBGL_DIR = path.join(__dirname, '..', 'server-data', 'webgl');

function cleanup(maxAgeDays, dryRun) {
  maxAgeDays = maxAgeDays || 7;
  var cutoff = Date.now() - maxAgeDays * 86400000;
  var removed = 0;
  var freed = 0;

  if (!fs.existsSync(WEBGL_DIR)) return { scanned: 0, removed: 0, freedMB: 0 };

  var dirs = fs.readdirSync(WEBGL_DIR);
  for (var i = 0; i < dirs.length; i++) {
    var dirPath = path.join(WEBGL_DIR, dirs[i]);
    try {
      var stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs >= cutoff) continue;

      // Calculate size
      var size = 0;
      var files = fs.readdirSync(dirPath);
      for (var f = 0; f < files.length; f++) {
        try { size += fs.statSync(path.join(dirPath, files[f])).size; } catch(e) {}
      }

      if (dryRun) {
        console.log('[dry-run] Would remove: ' + dirs[i] + ' (' + (size / 1048576).toFixed(1) + 'MB, ' +
          Math.round((Date.now() - stat.mtimeMs) / 86400000) + ' days old)');
      } else {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      removed++;
      freed += size;
    } catch(e) {}
  }

  return { scanned: dirs.length, removed: removed, freedMB: (freed / 1048576).toFixed(1) };
}

if (require.main === module) {
  var args = process.argv.slice(2);
  var days = 7;
  var dryRun = false;
  for (var a = 0; a < args.length; a++) {
    if (args[a] === '--days' && args[a + 1]) { days = parseInt(args[a + 1], 10); a++; }
    if (args[a] === '--dry-run') dryRun = true;
  }
  var result = cleanup(days, dryRun);
  console.log((dryRun ? '[DRY RUN] ' : '') + 'Cleanup: removed ' + result.removed + '/' + result.scanned +
    ' builds older than ' + days + ' days, freed ' + result.freedMB + 'MB');
}

module.exports = { cleanup: cleanup };
