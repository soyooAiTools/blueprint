/**
 * Stage: clone — Git clone base Unity template
 *
 * Reads: ctx.task
 * Writes: ctx.workDir (temp directory with cloned template)
 */

var fs = require('fs');
var path = require('path');
var os = require('os');

var TEMPLATE_CACHE_DIR = path.join(os.tmpdir(), 'luna-base-cache');
var TEMPLATE_CACHE_MAX_AGE = 3600 * 1000; // 1 hour

function getBaseTemplate(targetDir, log, taskId) {
  var execSync = require('child_process').execSync;
  var cacheValid = fs.existsSync(TEMPLATE_CACHE_DIR)
    && fs.existsSync(path.join(TEMPLATE_CACHE_DIR, '.git'))
    && (Date.now() - fs.statSync(TEMPLATE_CACHE_DIR).mtimeMs) < TEMPLATE_CACHE_MAX_AGE;

  if (!cacheValid) {
    if (fs.existsSync(TEMPLATE_CACHE_DIR)) fs.rmSync(TEMPLATE_CACHE_DIR, { recursive: true, force: true });
    var repo = process.env.BASE_TEMPLATE_REPO || 'https://github.com/soyooAiTools/luna-base-template.git';
    execSync('git clone --depth 1 ' + repo + ' "' + TEMPLATE_CACHE_DIR + '"', { timeout: 60000, stdio: 'pipe' });
    log('[cache] Base template cache refreshed');
  } else {
    log('[cache] Using cached base template');
  }

  execSync('cp -r "' + TEMPLATE_CACHE_DIR + '/." "' + targetDir + '"', { timeout: 30000, stdio: 'pipe' });
}

module.exports = {
  name: 'clone',
  canRetry: true,
  maxRetries: 2,
  assertBefore: function(ctx) {
    if (!ctx.taskId) throw new Error('No taskId — cannot clone template');
  },
  execute: function(ctx) {
    var tempDir = path.join(os.tmpdir(), 'linux-task-' + ctx.taskId);

    // Clean up previous run if exists
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    ctx.addLog('clone', 'Preparing base template...');
    if (ctx.reportStatus) {
      ctx.reportStatus('processing', { message: '[Linux] Preparing base template...' });
    }

    getBaseTemplate(tempDir, function(msg) { ctx.addLog('clone', msg); }, ctx.taskId);

    // Verify template integrity — must have Assets dir and key files
    if (!fs.existsSync(path.join(tempDir, 'Assets'))) {
      throw new Error('Template clone corrupted: Assets/ directory missing');
    }

    ctx.workDir = tempDir;
    ctx.addLog('clone', 'Base template ready at ' + tempDir);

    // Ensure script output directory exists
    var assetsDir = path.join(tempDir, 'Assets', 'Program', 'Script', 'Manager');
    fs.mkdirSync(assetsDir, { recursive: true });

    // Load canonical GFM_Tools.cs
    var workerDir = path.join(__dirname, '..', '..', 'worker');
    var canonicalGfm = path.join(workerDir, 'GFM_Tools.cs');
    if (fs.existsSync(canonicalGfm)) {
      ctx.extraFiles['GFM_Tools.cs'] = fs.readFileSync(canonicalGfm, 'utf-8');
    }

    return Promise.resolve({ workDir: tempDir });
  },
};

module.exports.getBaseTemplate = getBaseTemplate;
