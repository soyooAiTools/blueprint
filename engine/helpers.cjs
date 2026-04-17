/**
 * Pipeline Helpers — shared utilities for stage implementations
 * Extracted from worker/linux-worker-client.js for reuse across stages
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');

// ============ File Helpers ============

/**
 * Recursively find files by extension in a directory
 */
function findFiles(dir, ext) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) {
        results = results.concat(findFiles(fp, ext));
      } else if (entries[i].name.endsWith(ext)) {
        results.push(fp);
      }
    }
  } catch(e) {}
  return results;
}

// ============ HTTP Helpers ============

function handleResponse(resolve, reject) {
  return function(res) {
    var chunks = [];
    res.on('data', function(c) { chunks.push(c); });
    res.on('end', function() {
      if (res.statusCode === 204) return resolve(null);
      var buf = Buffer.concat(chunks);
      if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + buf.toString().slice(0, 200)));
      try { resolve(JSON.parse(buf.toString())); } catch(e) { resolve(buf.toString()); }
    });
  };
}

/**
 * Send build request to Bridge.NET build server
 * @param {string} buildUrl - Base URL of build server (e.g. http://127.0.0.1:18860)
 * @param {string} endpoint - e.g. '/build' or '/build-html'
 * @param {string} csCode - C# source code
 * @param {object} extraFiles - Additional files map
 * @returns {Promise}
 *
 * Compatibility shim for two build-api shapes:
 *   - Legacy (worker/linux-bridge-build.js): expects `code`, has /build + /build-html.
 *   - Current (/opt/luna-poc/build-api.js at 127.0.0.1:18860): expects `csCode`,
 *     only /build, returns `htmlBase64` inline.
 * We send BOTH field names and translate /build-html → /build + base64 decode,
 * so both servers keep working and stage code is untouched.
 */
function buildRequest(buildUrl, endpoint, csCode, extraFiles) {
  // /build-html legacy adapter: current API only has /build but returns htmlBase64.
  if (endpoint === '/build-html') {
    return buildRequest(buildUrl, '/build', csCode, extraFiles).then(function(result) {
      if (result && result.htmlBase64) {
        return Buffer.from(result.htmlBase64, 'base64');
      }
      if (result && Buffer.isBuffer(result)) return result; // legacy server already returned raw HTML
      var msg = (result && result.error) ? result.error : 'HTML not in build response';
      throw new Error(msg);
    });
  }

  var MAX_RETRIES = 2;

  function doRequest(attempt) {
    return new Promise(function(resolve, reject) {
      var parsedUrl = new (require('url').URL)(buildUrl + endpoint);
      // Send both `csCode` (new API) and `code` (legacy API) for compatibility.
      var body = JSON.stringify({ csCode: csCode, code: csCode, className: 'GameFlowManagerMain', extraFiles: extraFiles });
      var req = http.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 120000,
      }, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          var buf = Buffer.concat(chunks);
          try { resolve(JSON.parse(buf.toString())); } catch(e) { reject(new Error('Bad response: ' + buf.toString().slice(0, 200))); }
        });
      });
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('Build timeout')); });
      // Socket-level timeout: destroy if no data for 60s (catches socket hang up)
      req.setTimeout(60000, function() { req.destroy(new Error('Socket timeout (60s no data)')); });
      req.write(body);
      req.end();
    }).catch(function(err) {
      // Retry on timeout/connection errors (not on HTTP 4xx/5xx which are code issues)
      var isTransient = err.message.indexOf('timeout') >= 0 || err.message.indexOf('ECONNREFUSED') >= 0 || err.message.indexOf('ECONNRESET') >= 0 || err.message.indexOf('socket hang up') >= 0;
      if (isTransient && attempt < MAX_RETRIES) {
        return new Promise(function(resolve) { setTimeout(resolve, 2000 * attempt); }).then(function() {
          return doRequest(attempt + 1);
        });
      }
      throw err;
    });
  }

  return doRequest(1);
}

/**
 * Report task status to blueprint server
 */
function reportStatus(baseUrl, workerId, taskId, status, extra) {
  return new Promise(function(resolve, reject) {
    var data = { workerId: workerId, taskId: taskId, status: status, message: (extra && extra.message) || '' };
    if (extra && extra.previewUrl) data.previewUrl = extra.previewUrl;
    if (extra && extra.qualityData) data.qualityData = extra.qualityData;
    var body = JSON.stringify(data);
    var parsedUrl = new (require('url').URL)(baseUrl + '/api/worker/status');
    var mod = parsedUrl.protocol === 'https:' ? https : http;
    var req = mod.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, handleResponse(resolve, reject));
    req.on('error', function(e) { resolve(null); }); // don't fail on status report errors
    req.on('timeout', function() { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ============ CUA Issue Analysis ============

/**
 * Categorize CUA issues into a short tag for consecutive-same-issue detection
 */
function categorizeIssue(cuaResult) {
  if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) return 'solid-color';
  var issues = (cuaResult.issues || []).join(' ').toLowerCase();
  if (issues.includes('solid color') || issues.includes('纯色')) return 'solid-color';
  if (issues.includes('visual-freeze') || issues.includes('visual frozen')) return 'visual-freeze';
  if (issues.includes('variable-stagnation') || issues.includes('variable change')) return 'variable-stagnation';
  if (issues.includes('batch-completion') || issues.includes('batch phase')) return 'batch-completion';
  if (issues.includes('phase-skipped') || issues.includes('phases were skipped')) return 'phase-skipped';
  if (issues.includes('autoplay')) return 'autoplay';
  if (issues.includes('entity-incomplete')) return 'entity-incomplete';
  if (issues.includes('quick-test') || issues.includes('quick test')) return 'quick-test';
  // Distinguish stuck types: waiting-for-input vs deadlock
  if (issues.includes('stuck')) {
    // Check if game state shows phase > 0 (got past init) — likely waiting for input
    var coverage = extractPhaseCoverage(cuaResult);
    if (coverage && coverage.completed > 0) return 'stuck-waiting-input';
    // Phase 0 stuck — likely deadlock (never initialized properly)
    return 'stuck-deadlock';
  }
  if (issues.includes('[cta]') || issues.includes('cta')) return 'cta-missing';
  if (issues.includes('[uncovered]') || issues.includes('not covered')) return 'uncovered-shots';
  if (issues.includes('engine-not-ready')) return 'engine-not-ready';
  if (issues.includes('phase-coverage')) return 'phase-coverage';
  return (cuaResult.issues && cuaResult.issues[0]) ? cuaResult.issues[0].substring(0, 50) : 'unknown';
}

/**
 * Extract phase coverage numbers from CUA result
 */
function extractPhaseCoverage(cuaResult) {
  // Source 1: structured report data (most reliable — direct from Python agent)
  if (cuaResult.report) {
    var completedPhases = cuaResult.report.completedPhases;
    var scriptCoverage = cuaResult.report.scriptCoverage;
    if (Array.isArray(completedPhases) && Array.isArray(scriptCoverage)) {
      return { completed: completedPhases.length, total: scriptCoverage.length, phases: completedPhases };
    }
    if (Array.isArray(completedPhases) && completedPhases.length > 0) {
      return { completed: completedPhases.length, total: completedPhases.length, phases: completedPhases };
    }
  }
  // Source 2: issue text parsing (handles both old [phase-coverage] and new [spec-phase-skipped] formats)
  var issues = cuaResult.issues || [];
  for (var i = 0; i < issues.length; i++) {
    var m = issues[i].match(/\[phase-coverage\]\s*(\d+)\/(\d+)/);
    if (m) return { completed: parseInt(m[1]), total: parseInt(m[2]) };
    var m2 = issues[i].match(/\[spec-phase-skipped\]\s*Phases not completed\s*\((\d+)\/(\d+)\)/);
    if (m2) return { completed: parseInt(m2[2]) - parseInt(m2[1]), total: parseInt(m2[2]) };
  }
  return null;
}

/**
 * Map issue type to severity level
 */
function getIssueSeverity(type) {
  var HIGH = ['phase-coverage', 'entity-incomplete', 'stuck', 'engine-not-ready', 'no-content', 'stuck-pattern', 'no-coverage'];
  var MEDIUM = ['uncovered', 'cta', 'solid-color', 'interaction', 'suspicious-script'];
  if (HIGH.indexOf(type) >= 0) return 'high';
  if (MEDIUM.indexOf(type) >= 0) return 'medium';
  return 'low';
}

/**
 * Generate a fix hint based on issue type
 */
function getFixHint(type) {
  var LUNA_REMINDERS = '\nLuna SDK reminders: NEVER use SetActive() (causes objects to vanish). NEVER use CreatePrimitive(). ' +
    'Pool objects are named __Pool_{Shape}_{Color}_{NN} and start at (0,-999,0). Move to visible position with transform.position = new Vector3(x, y, z). ' +
    'loadSettings may be null — always null-check. Call Luna.Unity.Playable.InstallFullGame() for CTA.';
  var hints = {
    'phase-coverage': 'Ensure all phases are reachable via player interaction. Check trigger conditions and interaction radius. Every phase must have working transition logic.' + LUNA_REMINDERS,
    'entity-incomplete': 'Buildable entities must reach state=2 (built). Check build triggers and resource requirements. Ensure entity state variables are actually modified in the interaction handler.' + LUNA_REMINDERS,
    'stuck': 'Game is stuck with no state changes. Common causes: (1) player can\'t reach interaction target (check positions), (2) trigger condition never evaluates true (check variable names), (3) timer never fires (check Update loop).' + LUNA_REMINDERS,
    'stuck-pattern': 'Game is stuck with no state changes. Common causes: (1) player can\'t reach interaction target, (2) trigger condition uses wrong variable name, (3) missing Update() loop for timers.' + LUNA_REMINDERS,
    'uncovered': 'Some blueprint shots were not reached. Check phase transitions. Each phase must connect to the next via triggerNext condition.' + LUNA_REMINDERS,
    'cta': 'CTA button was not reached or unresponsive. Ensure final phase completes and CTA calls Luna.Unity.Playable.InstallFullGame(). The CTA must be triggered after the last gameplay phase.' + LUNA_REMINDERS,
    'no-content': 'Game content not visible. Objects must be moved from pool position (y=-999) to visible positions (y>=0). Use transform.position = new Vector3(x, 0, z). Ensure at least 3 objects are visible.' + LUNA_REMINDERS,
    'solid-color': 'Screen is single color. Ground plane must exist at y=0. Move >=3 different-colored __Pool_ objects to y>=0 positions in the first phase\'s Start or initialization.' + LUNA_REMINDERS,
    'visual-freeze': 'Game screen is visually STATIC despite phases completing. AutoPlay transitions must produce VISIBLE changes: (1) move entities via transform.Translate or transform.position, (2) show/hide objects via SetActive (toggle, not one-way), (3) change colors via GetComponent<Renderer>().material.color, (4) update UI text. Phases that only increment counters with no visual side effects will fail this check.' + LUNA_REMINDERS,
    'variable-stagnation': 'All game variables (gold, score, count, etc.) remained at initial values throughout gameplay. Phase logic must UPDATE variables: gold += reward on delivery, score++ on completion, count-- on consumption. Variables must be exposed via __gameState so the observer can verify them. Empty phase transitions that just advance phaseTimer are not real gameplay.' + LUNA_REMINDERS,
    'batch-completion': 'Multiple phases completed in a single poll interval. Each phase must run for at least 20 seconds with visible gameplay. Check that autoPlay duration gate (phaseTimer >= 20f) is enforced for every phase transition.' + LUNA_REMINDERS,
    'engine-not-ready': 'Luna engine failed to initialize. Check for JS errors. Common cause: calling loadSettings on a null reference, or using unsupported C# features that Bridge.NET compiles incorrectly.' + LUNA_REMINDERS,
  };
  return hints[type] || '';
}


/**
 * Extract relevant code sections based on CUA issue type.
 * Returns code snippets with line numbers so AI can do surgical fixes.
 */
function extractCodeContext(csCode, cuaResult) {
  if (!csCode) return '';
  var lines = csCode.split('\n');
  var sections = [];

  var gameState = (cuaResult.report && cuaResult.report.gameState) || {};
  var stuckPhase = gameState.currentPhase || '';
  var issues = (cuaResult.issues || []).join(' ').toLowerCase();

  // Find phase transition code for the stuck/failing phase
  if (stuckPhase) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(stuckPhase) >= 0 || lines[i].indexOf('"' + stuckPhase + '"') >= 0) {
        var start = Math.max(0, i - 5);
        var end = Math.min(lines.length, i + 20);
        var snippet = [];
        for (var j = start; j < end; j++) {
          snippet.push('L' + (j + 1) + ': ' + lines[j]);
        }
        sections.push('--- Code near phase "' + stuckPhase + '" (line ' + (i + 1) + ') ---\n' + snippet.join('\n'));
        break;
      }
    }
  }

  // Find entity state code for incomplete entities
  if (issues.indexOf('entity-incomplete') >= 0) {
    var entityStates = gameState.entityStates || {};
    for (var entity in entityStates) {
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(entity) >= 0 && (lines[i].indexOf('state') >= 0 || lines[i].indexOf('State') >= 0 || lines[i].indexOf('build') >= 0 || lines[i].indexOf('Build') >= 0)) {
          var start = Math.max(0, i - 3);
          var end = Math.min(lines.length, i + 10);
          var snippet = [];
          for (var j = start; j < end; j++) {
            snippet.push('L' + (j + 1) + ': ' + lines[j]);
          }
          sections.push('--- Entity "' + entity + '" state code (line ' + (i + 1) + ') ---\n' + snippet.join('\n'));
          break;
        }
      }
    }
  }

  // Find trigger/transition code for phase-coverage issues
  if (issues.indexOf('phase-coverage') >= 0 || issues.indexOf('phase-skipped') >= 0) {
    for (var i = 0; i < lines.length; i++) {
      if ((lines[i].indexOf('triggerNext') >= 0 || lines[i].indexOf('NextPhase') >= 0 || lines[i].indexOf('nextPhase') >= 0 || lines[i].indexOf('TransitionTo') >= 0) && lines[i].indexOf('//') !== 0) {
        var start = Math.max(0, i - 2);
        var end = Math.min(lines.length, i + 8);
        var snippet = [];
        for (var j = start; j < end; j++) {
          snippet.push('L' + (j + 1) + ': ' + lines[j]);
        }
        sections.push('--- Phase transition code (line ' + (i + 1) + ') ---\n' + snippet.join('\n'));
      }
    }
  }

  // Find CTA code
  if (issues.indexOf('cta') >= 0) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('InstallFullGame') >= 0 || lines[i].indexOf('CTA') >= 0 || lines[i].indexOf('cta') >= 0) {
        var start = Math.max(0, i - 3);
        var end = Math.min(lines.length, i + 10);
        var snippet = [];
        for (var j = start; j < end; j++) {
          snippet.push('L' + (j + 1) + ': ' + lines[j]);
        }
        sections.push('--- CTA code (line ' + (i + 1) + ') ---\n' + snippet.join('\n'));
        break;
      }
    }
  }

  // Find pool object initialization (for solid-color / no-content)
  if (issues.indexOf('solid-color') >= 0 || issues.indexOf('no-content') >= 0) {
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('__Pool_') >= 0 || (lines[i].indexOf('position') >= 0 && lines[i].indexOf('Vector3') >= 0)) {
        var start = Math.max(0, i - 2);
        var end = Math.min(lines.length, i + 8);
        var snippet = [];
        for (var j = start; j < end; j++) {
          snippet.push('L' + (j + 1) + ': ' + lines[j]);
        }
        sections.push('--- Object positioning code (line ' + (i + 1) + ') ---\n' + snippet.join('\n'));
        if (sections.length > 5) break; // cap snippets
      }
    }
  }

  if (sections.length === 0) return '';
  return '\n\n=== RELEVANT CODE SECTIONS (fix these specific lines) ===\n' + sections.slice(0, 6).join('\n\n');
}

/**
 * Build structured CUA feedback object
 * Now includes code-location references for surgical fixes.
 */
function buildStructuredFeedback(round, cuaResult, blueprint, fixHistory, csCode) {
  var issues = (cuaResult.issues || []).map(function(issueStr) {
    var match = issueStr.match(/^\[([^\]]+)\]\s*(.*)/s);
    var type = match ? match[1] : 'unknown';
    var message = match ? match[2] : issueStr;
    var issue = {
      type: type,
      severity: getIssueSeverity(type),
      message: message,
      details: {},
      fix_hint: getFixHint(type),
    };
    if (type === 'phase-coverage') {
      var coverageMatch = message.match(/(\d+)\/(\d+) phases completed/);
      if (coverageMatch) {
        issue.details.covered = parseInt(coverageMatch[1]);
        issue.details.total = parseInt(coverageMatch[2]);
      }
      var missingMatch = message.match(/Missing: (.+?)(?:\. |$)/);
      if (missingMatch) {
        issue.details.missing = missingMatch[1].split('; ').map(function(m) {
          var parts = m.match(/(.+?) \(trigger: (.+?)\)/);
          return parts ? { phaseId: parts[1].trim(), trigger: parts[2].trim() } : { phaseId: m.trim() };
        });
      }
    } else if (type === 'entity-incomplete') {
      var entityMatches = message.match(/(\w+)=(\d+)\s*\(expected (\d+)=(\w+)\)/g) || [];
      issue.details.entities = entityMatches.map(function(em) {
        var parts = em.match(/(\w+)=(\d+)\s*\(expected (\d+)=(\w+)\)/);
        return parts ? { entity: parts[1], currentState: parseInt(parts[2]), requiredState: parseInt(parts[3]), stateLabel: parts[4] } : {};
      });
    }
    return issue;
  });

  var gameState = {};
  if (cuaResult.report && cuaResult.report.gameState) {
    var gs = cuaResult.report.gameState;
    gameState.currentPhase = gs.currentPhase || 'unknown';
    gameState.completedPhases = gs.completedPhases || [];
    gameState.entityStates = gs.entityStates || {};
    gameState.variables = gs.variables || {};
  }

  var consoleErrors = [];
  if (cuaResult.report && cuaResult.report.diagnostics && cuaResult.report.diagnostics.consoleErrors) {
    for (var i = 0; i < Math.min(cuaResult.report.diagnostics.consoleErrors.length, 10); i++) {
      consoleErrors.push(cuaResult.report.diagnostics.consoleErrors[i]);
    }
  }

  var fixHistorySummary = (fixHistory || []).slice(-3).map(function(h) {
    return { round: h.round, category: h.issueCategory, topIssue: (h.issues && h.issues[0]) || 'unknown' };
  });

  var structured = {
    round: round,
    summary: issues.length + ' issue(s): ' + issues.map(function(i) { return i.type; }).join(', '),
    issues: issues,
    gameState: gameState,
    consoleErrors: consoleErrors,
    fixHistory: fixHistorySummary,
  };

  var text = 'CUA blueprint flow verification failed (round ' + round + '):\n' + (cuaResult.issues || []).join('\n');
  if (consoleErrors.length > 0) {
    text += '\nConsole errors:\n' + consoleErrors.map(function(e) { return '  - ' + e; }).join('\n');
  }
  if (cuaResult.report && cuaResult.report.gameState) {
    var gs2 = cuaResult.report.gameState;
    text += '\n\nGame State at failure:';
    text += '\n  Current Phase: ' + (gs2.currentPhase || 'unknown');
    text += '\n  Completed Phases: ' + ((gs2.completedPhases || []).join(', ') || 'none');
    if (gs2.variables) text += '\n  Variables: ' + JSON.stringify(gs2.variables);
    if (gs2.entityStates) text += '\n  Entity States: ' + JSON.stringify(gs2.entityStates);
  }
  var codeCtx = extractCodeContext(csCode, cuaResult);
  if (codeCtx) text += codeCtx;
  text += '\n\nPlease fix the code to ensure blueprint flow works. Focus on the specific code sections shown above.';
  if (fixHistory && fixHistory.length > 1) {
    text += '\n\nFix history (do not repeat):';
    for (var hi = Math.max(0, fixHistory.length - 5); hi < fixHistory.length; hi++) {
      var h = fixHistory[hi];
      text += '\n  Round ' + h.round + ': ' + h.issueCategory + ' — ' + ((h.issues && h.issues[0]) || 'unknown');
    }
    text += '\nTry a different fix strategy.';
  }

  return { text: text, structured: structured };
}

/**
 * Extract phase IDs from console messages with __PHASE__: prefix
 */
function extractPhaseFromConsole(consoleMessages) {
    var phases = [];
    for (var i = 0; i < consoleMessages.length; i++) {
        var text = consoleMessages[i];
        if (typeof text === 'string' && text.indexOf('__PHASE__:') === 0) {
            phases.push(text.substring(10));
        }
    }
    return phases;
}

module.exports = {
  findFiles: findFiles,
  buildRequest: buildRequest,
  reportStatus: reportStatus,
  categorizeIssue: categorizeIssue,
  extractPhaseFromConsole: extractPhaseFromConsole,
  extractPhaseCoverage: extractPhaseCoverage,
  getIssueSeverity: getIssueSeverity,
  getFixHint: getFixHint,
  extractCodeContext: extractCodeContext,
  buildStructuredFeedback: buildStructuredFeedback,
};
