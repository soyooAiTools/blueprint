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

/**
 * Patch-based recode — fix specific issues without full regeneration.
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.currentCode   — current C# code
 * @param {Array}  opts.issues        — structured issues [{line, message, text}]
 * @param {object} opts.blueprint     — full blueprint
 * @param {string} opts.label         — short label for logs
 * @param {number} opts.round         — current fix round number
 * @param {Function} opts.log         — logging callback(msg)
 * @returns {Promise<{ok:boolean, code?:string, patchApplied?:boolean, error?:string}>}
 */
function patchRecode(opts) {
  var createProvider = require('../lib/model-provider.cjs').createProvider;
  var provider = createProvider('claude', {});

  var codeLines = opts.currentCode.split('\n');
  var issueDescriptions = [];
  for (var i = 0; i < opts.issues.length; i++) {
    var issue = opts.issues[i];
    var issueLine = issue.line || 0;
    var snippetParts = [];
    if (issueLine > 0 && issueLine <= codeLines.length) {
      var start = Math.max(0, issueLine - 5);
      var end = Math.min(codeLines.length, issueLine + 5);
      for (var s = start; s < end; s++) {
        snippetParts.push('L' + (s + 1) + (s + 1 === issueLine ? ' >>>' : '    ') + ': ' + codeLines[s]);
      }
    }
    issueDescriptions.push(
      '--- Issue ' + (i + 1) + ' ---\n' +
      'Line: ' + issueLine + '\n' +
      'Problem: ' + (issue.message || issue.text || '') + '\n' +
      (snippetParts.length > 0 ? 'Code context:\n' + snippetParts.join('\n') : '')
    );
  }

  // Include partial class files so Claude knows which methods already exist elsewhere
  var extraFilesContext = '';
  if (opts.extraFiles) {
    for (var efKey in opts.extraFiles) {
      if (opts.extraFiles.hasOwnProperty(efKey)) {
        extraFilesContext += '\n\nPARTIAL CLASS FILE (' + efKey + ') — compiled together, do NOT redefine methods from this file:\n' + opts.extraFiles[efKey];
      }
    }
  }

  var prompt = {
    system: 'You are fixing specific issues in a Luna playable ad C# file. Output ONLY the complete corrected file. No explanations, no markdown fences.',
    user: 'CURRENT FULL CODE:\n' + opts.currentCode + '\n\n' +
      (extraFilesContext ? extraFilesContext + '\n\n' : '') +
      'ISSUES TO FIX (do NOT modify any other code):\n' + issueDescriptions.join('\n\n') + '\n\n' +
      'Output the COMPLETE corrected file. Only modify lines related to the issues above.\n' +
      'Do NOT add new features, refactor, or change working code.' +
      (extraFilesContext ? '\nCRITICAL: Do NOT duplicate any method already defined in the partial class files above — this causes CS0111.' : '')
  };

  opts.log('patchRecode: fixing ' + opts.issues.length + ' issues via Claude Sonnet');

  return provider.generateWithRetry(prompt, { model: 'claude-sonnet-4-6', maxTokens: 30000, timeoutMs: 180000 }, 2)
    .then(function(result) {
      var text = (result.text || '').trim();
      // Strip markdown fences if present
      if (text.indexOf('```') === 0) {
        text = text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
      }
      if (text.length < 100) {
        opts.log('patchRecode: response too short (' + text.length + ' chars)');
        return { ok: false, error: 'patch response too short', patchApplied: false };
      }
      opts.log('patchRecode: got ' + text.length + ' chars');
      return { ok: true, code: text, patchApplied: true };
    })
    .catch(function(err) {
      opts.log('patchRecode failed: ' + err.message);
      return { ok: false, error: err.message, patchApplied: false };
    });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

module.exports = { recode: recode, patchRecode: patchRecode };
