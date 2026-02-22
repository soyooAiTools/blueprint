// Cocos Creator build via command-line (replaces Luna bridge build)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

var COCOS_CREATOR = process.env.COCOS_CREATOR || 'D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe';

function findCocosCreator() {
  if (fs.existsSync(COCOS_CREATOR)) return COCOS_CREATOR;
  var paths = ['D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe', 'D:\\CocosCreator\\CocosCreator.exe', 'C:\\Program Files\\Cocos\\CocosCreator\\CocosCreator.exe'];
  for (var i = 0; i < paths.length; i++) { if (fs.existsSync(paths[i])) return paths[i]; }
  return COCOS_CREATOR;
}

async function runCocosBuild(projectDir, log, taskId) {
  log = log || console.log;
  var startTime = Date.now();
  var cocosExe = findCocosCreator();
  log('[cocos-build] Using: ' + cocosExe, taskId);
  if (!fs.existsSync(cocosExe)) return { ok: false, error: 'Cocos Creator not found at ' + cocosExe };

  var buildDir = path.join(projectDir, 'build', 'web-mobile');
  if (fs.existsSync(buildDir)) { try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {} }

  log('[cocos-build] Running build...', taskId);
  return new Promise(function(resolve) {
    var child = spawn(cocosExe, ['--project', projectDir, '--build', 'platform=web-mobile;debug=false'], { stdio: ['ignore','pipe','pipe'] });
    var stdout = '', stderr = '', lastLog = Date.now();

    child.stdout.on('data', function(data) {
      stdout += data.toString();
      if (Date.now() - lastLog > 15000) { log('[cocos-build] Still running... (' + Math.floor((Date.now()-startTime)/1000) + 's)', taskId); lastLog = Date.now(); }
    });
    child.stderr.on('data', function(data) { stderr += data.toString(); });

    child.on('close', function(code) {
      var buildTime = Math.floor((Date.now() - startTime) / 1000);
      var hasOutput = fs.existsSync(path.join(buildDir, 'index.html'));
      if (hasOutput) {
        // Build produced output — treat as success even with non-zero exit code
        // (Cocos may exit with code 36 due to missing assets warnings)
        if (code !== 0) log('[cocos-build] Warning: exit code ' + code + ' but output exists, treating as success', taskId);
        log('[cocos-build] Done in ' + buildTime + 's', taskId);
        resolve({ ok: true, buildTime: buildTime, outputDir: buildDir });
      } else {
        var errorLines = (stdout+'\n'+stderr).split('\n').filter(function(l) { return /fail|error/i.test(l); }).slice(-5);
        resolve({ ok: false, error: 'Exit ' + code + ': ' + (errorLines.join('; ') || stderr.slice(-500)), buildTime: buildTime });
      }
    });
    setTimeout(function() { child.kill(); resolve({ ok: false, error: 'Build timed out after 600s' }); }, 600000);
  });
}

module.exports = { runCocosBuild, findCocosCreator };

if (require.main === module) {
  (async function() {
    var result = await runCocosBuild(process.argv[2] || 'D:\\work\\test-cocos', console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}
