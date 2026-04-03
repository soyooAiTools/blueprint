/**
 * Recode — shared "clone template → write code → AI re-generate → extract main CS" helper
 *
 * Used by compile, visual-check, and cua-verify stages to eliminate duplicated
 * clone+write+generate+find logic, and to isolate worker/ dependencies behind
 * a single adapter boundary.
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var helpers = require('./helpers.cjs');
var cloneStage = require('./stages/clone.cjs');

/**
 * Re-generate code in a fresh template directory.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.currentCode   — current C# code to seed the template
 * @param {object} opts.blueprint     — full blueprint with feedbackHistory
 * @param {string} opts.label         — short label for temp dir & logs (e.g. 'buildfix', 'vfix', 'cuafix')
 * @param {number} opts.round         — current fix round number
 * @param {Function} opts.log         — logging callback(msg)
 * @returns {Promise<{ok:boolean, code?:string, error?:string}>}
 */
function recode(opts) {
  var tempDir = path.join(os.tmpdir(), 'linux-' + opts.label + '-' + opts.taskId + '-' + opts.round);
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });

  // Clone base template
  try {
    cloneStage.getBaseTemplate(tempDir, opts.log, opts.taskId);
  } catch(cloneErr) {
    opts.log(opts.label + ' git clone failed: ' + cloneErr.message);
    return Promise.resolve({ ok: false, error: 'clone failed: ' + cloneErr.message });
  }

  // Seed current code into the template
  var assetsDir = path.join(tempDir, 'Assets', 'Program', 'Script', 'Manager');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'GameFlowManagerMain.cs'), opts.currentCode);

  // Seed partial class files (multi-file support)
  if (opts.extraFiles) {
    for (var efName in opts.extraFiles) {
      if (opts.extraFiles.hasOwnProperty(efName)) {
        fs.writeFileSync(path.join(assetsDir, efName), opts.extraFiles[efName]);
      }
    }
  }

  // Resolve generator
  var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
  var generator;
  try {
    if (USE_CLAUDE_CODE) {
      generator = require('../worker/claude-code-coder.js').generateWithClaudeCode;
    } else {
      generator = require('../worker/worker-coder.js').generateCodeV5;
    }
  } catch(e) {
    cleanup(tempDir);
    // Throw instead of returning ok:false — this is FATAL, fix-loop should not retry
    return Promise.reject(new Error('FATAL: no code generator available (' + e.message + ')'));
  }

  return generator(opts.blueprint, tempDir, opts.log, opts.taskId, 'unity')
    .then(function(result) {
      if (!result.ok) {
        cleanup(tempDir);
        return { ok: false, error: result.error || 'generator failed' };
      }

      var allCs = helpers.findFiles(tempDir, '.cs');
      var mainCs = null;
      for (var i = 0; i < allCs.length; i++) {
        if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) { mainCs = allCs[i]; break; }
      }
      if (!mainCs) {
        cleanup(tempDir);
        return { ok: false, error: 'no GameFlowManagerMain.cs found after recode' };
      }

      var code = fs.readFileSync(mainCs, 'utf-8');

      // Collect partial class files from recode output
      var recodedExtras = {};
      var partialNames = ['GameFlowManagerMain.Systems.cs'];
      for (var pi = 0; pi < partialNames.length; pi++) {
        for (var ci = 0; ci < allCs.length; ci++) {
          if (allCs[ci].indexOf(partialNames[pi]) !== -1) {
            recodedExtras[partialNames[pi]] = fs.readFileSync(allCs[ci], 'utf-8');
          }
        }
      }
      cleanup(tempDir);
      return { ok: true, code: code, extraFiles: recodedExtras };
    })
    .catch(function(err) {
      cleanup(tempDir);
      return { ok: false, error: err.message };
    });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

module.exports = { recode: recode };
