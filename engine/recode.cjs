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

function collectManagerPartialOutputs(rootDir) {
  var out = {};
  if (!rootDir || !fs.existsSync(rootDir)) return out;
  var allCs = helpers.findFiles(rootDir, '.cs');
  for (var i = 0; i < allCs.length; i++) {
    var file = allCs[i];
    var base = path.basename(file);
    if (!/^GameFlowManagerMain(?:\.[A-Za-z0-9_]+)?\.cs$/.test(base)) continue;
    if (base === 'GameFlowManagerMain.cs') continue;
    out[base] = fs.readFileSync(file, 'utf-8');
  }
  return out;
}

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

  // Resolve generator through the unified Codex entry.
  var generator;
  try {
    generator = require('../worker/codex-coder.js').generateWithCodex;
  } catch(e) {
    cleanup(tempDir);
    // Throw instead of returning ok:false — this is FATAL, fix-loop should not retry
    return Promise.reject(new Error('FATAL: no codex generator available (' + e.message + ')'));
  }

  return generator(opts.blueprint, tempDir, opts.log, opts.taskId, 'unity')
    .then(function(result) {
      if (!result.ok) {
        cleanup(tempDir);
        // MODEL_FATAL errors must throw — not be returned as {ok:false} — otherwise
        // the calling stage's `if (!recodeResult.ok)` swallows them and the fix-loop
        // keeps burning more rounds against a dead model backend. Throwing lets
        // error-classifier route this to cancel-task.
        var errMsg = result.error || 'generator failed';
        if (/MODEL_FATAL/i.test(errMsg)) {
          throw new Error(errMsg);
        }
        return { ok: false, error: errMsg };
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

      // Collect all partial class files from recode output. Assembly-first tasks
      // now split logic across Flow/Input/Resource/UI/Scene/System partials, so
      // returning only Systems.cs causes compile-fix to silently drop edits or
      // reason against stale partial ownership.
      var recodedExtras = collectManagerPartialOutputs(tempDir);
      cleanup(tempDir);
      return { ok: true, code: code, extraFiles: recodedExtras };
    })
    .catch(function(err) {
      cleanup(tempDir);
      // MODEL_FATAL propagates so error-classifier can cancel the task.
      if (err && /MODEL_FATAL/i.test(err.message || '')) {
        throw err;
      }
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
/**
 * Extract C# method signatures from source — used by patchRecode to summarize
 * partial class files instead of sending the entire file body.
 *
 * Heuristic: a method signature line has `(...)` with a name token immediately
 * before the `(`, optionally followed by `{` or end of line. We skip control-flow
 * keywords, string-method-calls, and assignment expressions.
 *
 * Returns an array of trimmed signature lines (no body, no braces).
 */
function extractMethodSignatures(code) {
  if (!code) return [];
  var out = [];
  var lines = code.split('\n');
  var CONTROL_KW = ['if', 'for', 'foreach', 'while', 'switch', 'using', 'lock', 'catch', 'fixed', 'return', 'throw', 'new'];
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    // Strip trailing line comments
    var commentIdx = raw.indexOf('//');
    var line = commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
    var trimmed = line.replace(/\s+$/, '').replace(/^\s+/, '');
    if (!trimmed) continue;
    var openParen = trimmed.indexOf('(');
    if (openParen < 0) continue;
    var closeParen = trimmed.lastIndexOf(')');
    if (closeParen <= openParen) continue;
    var tail = trimmed.slice(closeParen + 1).replace(/\s/g, '');
    // Must be a top-of-method declaration: ends with `{`, `;` (abstract/interface), or empty (brace on next line)
    if (tail !== '' && tail !== '{' && tail !== ';') continue;
    // Skip arrow functions / lambdas
    if (trimmed.indexOf('=>') >= 0) continue;
    var leading = trimmed.split(/[\s(]/)[0];
    var skip = false;
    for (var ci = 0; ci < CONTROL_KW.length; ci++) {
      if (leading === CONTROL_KW[ci]) { skip = true; break; }
    }
    if (skip) continue;
    // Skip lines that are clearly assignments or method calls (have `=` before `(` but not `==`)
    var beforeParen = trimmed.slice(0, openParen);
    if (beforeParen.indexOf('=') >= 0 && beforeParen.indexOf('==') < 0) continue;
    // Char immediately before `(` must look like an identifier end
    var nameChar = trimmed.charAt(openParen - 1);
    if (!/[A-Za-z0-9_>]/.test(nameChar)) continue;
    // Must contain at least one space (return type + name) OR start with the constructor name pattern
    if (beforeParen.indexOf(' ') < 0) continue;
    // Strip trailing `{` for cleaner output
    var sig = trimmed.replace(/\s*\{?\s*$/, '');
    out.push('  ' + sig);
  }
  return out;
}

function patchRecode(opts) {
  // 2026-04-16: switched from direct Claude API (ClaudeProvider.generateWithRetry)
  // to spawn the CLI text runner via runCodexText.
  // Reason: unify all Claude calls through the CC CLI relay so failure modes,
  // MODEL_FATAL detection, and billing are consistent with codegen/review-fix.
  // The prompt/contract is unchanged — we only swap the transport layer.
  var codexCoder = require('../worker/codex-coder.js');

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
    var ruleTag = issue.rule ? '[' + issue.rule + '] ' : '';
    issueDescriptions.push(
      '--- Issue ' + (i + 1) + ' ---\n' +
      'Line: ' + issueLine + '\n' +
      'Problem: ' + ruleTag + (issue.message || issue.text || '') + '\n' +
      (snippetParts.length > 0 ? 'Code context:\n' + snippetParts.join('\n') : '')
    );
  }

  // Include partial class method signatures so Claude knows which methods already
  // exist elsewhere — sending only signatures (not full bodies) saves ~20-40KB per call.
  // The model only needs to know the *names* to avoid CS0111 redefinition errors;
  // it does NOT need the implementations (it's not editing those files).
  var extraFilesContext = '';
  if (opts.extraFiles) {
    for (var efKey in opts.extraFiles) {
      if (opts.extraFiles.hasOwnProperty(efKey)) {
        var sigs = extractMethodSignatures(opts.extraFiles[efKey]);
        if (sigs.length > 0) {
          extraFilesContext += '\n\nPARTIAL CLASS FILE (' + efKey + ') already defines these methods (compiled together — do NOT redefine, causes CS0111):\n' + sigs.join('\n');
        }
      }
    }
  }

  var systemPrompt = 'You are fixing specific issues in a Luna playable ad C# file. Output ONLY the complete corrected file. No explanations, no markdown fences.';
  var userPrompt = 'CURRENT FULL CODE:\n' + opts.currentCode + '\n\n' +
    (extraFilesContext ? extraFilesContext + '\n\n' : '') +
    'ISSUES TO FIX (do NOT modify any other code):\n' + issueDescriptions.join('\n\n') + '\n\n' +
    'Output the COMPLETE corrected file. Only modify lines related to the issues above.\n' +
    'Do NOT add new features, refactor, or change working code.\n' +
    'CRITICAL: Do NOT rename or change any existing phaseId strings in AddCompletedPhase(), ReportPhase(), or CheckEventRules() calls. The phase IDs in the existing code are CANONICAL — changing them will break phase tracking.' +
    (extraFilesContext ? '\nCRITICAL: Do NOT duplicate any method already defined in the partial class files above — this causes CS0111.' : '');

  opts.log('patchRecode: fixing ' + opts.issues.length + ' issues via Codex text runner (Sonnet)');

  return codexCoder.runCodexText({
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    timeoutMs: 240000,
    minOutputLen: 100,
    taskId: opts.taskId || 'patch',
    log: opts.log,
  }).then(function(result) {
    if (!result.ok) {
      // MODEL_FATAL propagates so error-classifier can cancel the task.
      if (result.error && /MODEL_FATAL/i.test(result.error)) {
        throw new Error(result.error);
      }
      opts.log('patchRecode failed: ' + result.error);
      return { ok: false, error: result.error, patchApplied: false };
    }
    var text = (result.text || '').trim();
    // Strip markdown fences if present
    if (text.indexOf('```') === 0) {
      text = text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
    }
    if (text.length < 100) {
      opts.log('patchRecode: response too short (' + text.length + ' chars)');
      return { ok: false, error: 'patch response too short', patchApplied: false };
    }
    // No-op detection: Sonnet sometimes returns byte-identical input when the
    // issue context is too thin (e.g. semantic rules with hardcoded line:1 that
    // point at the file header) combined with the "do NOT modify other code"
    // prompt constraint — the safest action becomes "return input unchanged".
    // Without this check the review fix-loop hammers patchRecode 3-4 rounds with
    // the same ~48K-char payload before exhausting rounds (see proj_1776266310700_2p50o1
    // postmortem, INCIDENTS.md 2026-04-16). Treat as patch failure so the caller
    // falls back to full recode(), which has the complete V5 prompt (entity tables,
    // skeleton, feedbackHistory) and can reason about phase structure.
    if (text === opts.currentCode) {
      opts.log('patchRecode: Sonnet returned byte-identical code (' + text.length + ' chars) — no-op, forcing fallback to full recode');
      return { ok: false, error: 'patch no-op: byte-identical output', patchApplied: false };
    }
    opts.log('patchRecode: got ' + text.length + ' chars');
    return { ok: true, code: text, patchApplied: true };
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

module.exports = {
  recode: recode,
  patchRecode: patchRecode,
  _collectManagerPartialOutputs: collectManagerPartialOutputs,
};
