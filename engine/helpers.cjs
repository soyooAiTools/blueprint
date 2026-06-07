/**
 * Pipeline Helpers — shared utilities for stage implementations
 * Extracted from worker/linux-worker-client.js for reuse across stages
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var visualAssetExtractor = null;
var fieldDiffLib = null;

// v1.2 plumbing: the writer reads window.__BLUEPRINT_VISUAL_ASSETS__.fidelityContract
// to discover phases[i].projectedAnchors. If the in-memory visualAssets manifest
// doesn't carry fidelityContract, load it from the canonical contract path so the
// worker writer has a non-empty contract to surface.
var DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD = path.join(__dirname, '..', 'work',
  'task25-sam-delivery-verify', 'unpacked', 'space-ranger-v0.5-fidelity-delivery',
  'unity-project', 'Assets', 'Fidelity', 'fidelityContract.json');

function unwrapSplitPackContract(raw) {
  // Jonny split-pack: `{writer, contract: {entities, phases, ...}}` — unwrap so
  // the writer-side sees `manifest.fidelityContract.phases` directly.
  if (raw && raw.contract && Array.isArray(raw.contract.entities) && Array.isArray(raw.contract.phases)) {
    return raw.contract;
  }
  return raw;
}

function contractHasProjectedAnchors(contract) {
  if (!contract || !Array.isArray(contract.phases)) return false;
  for (var i = 0; i < contract.phases.length; i++) {
    var p = contract.phases[i];
    if (p && p.projectedAnchors && typeof p.projectedAnchors === 'object') return true;
  }
  return false;
}

function cloneJson(value) {
  if (!value || typeof value !== 'object') return value || null;
  return JSON.parse(JSON.stringify(value));
}

function logVisualAssets(ctx, msg) {
  try {
    if (ctx && typeof ctx.addLog === 'function') ctx.addLog('visual-assets', msg);
  } catch(e) {}
}

function loadVisualAssetExtractor() {
  if (visualAssetExtractor) return visualAssetExtractor;
  visualAssetExtractor = require('../adapters/demo2spec/visual-assets.js');
  return visualAssetExtractor;
}

function loadFieldDiffLib() {
  if (fieldDiffLib) return fieldDiffLib;
  fieldDiffLib = require('./stages/lib/field-diff.cjs');
  return fieldDiffLib;
}

function resolveSourceHtmlPath(ctx, va) {
  var bp = ctx && ctx.blueprint || {};
  var task = ctx && ctx.task || {};
  var candidates = [
    ctx && ctx.sourceHtmlPath,
    bp.sourceHtmlPath,
    task.sourceHtmlPath,
    task.source_html_path,
    va && va.source,
    bp.storyboard && bp.storyboard.htmlPath,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (!value || !/\.html?$/i.test(String(value))) continue;
    var abs = path.resolve(String(value));
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch(e) {}
  }
  return null;
}

function collectVisualEntityNames(ctx, va) {
  var out = [];
  function add(value) {
    if (!value) return;
    var text = String(value || '').trim();
    if (text && out.indexOf(text) < 0) out.push(text);
  }
  function addEntities(list) {
    if (!Array.isArray(list)) return;
    list.forEach(function(e) {
      if (!e) return;
      add(typeof e === 'string' ? e : (e.name || e.id || e.entityName));
    });
  }
  var bp = ctx && ctx.blueprint || {};
  addEntities(bp.entities);
  addEntities(bp.blueprint && bp.blueprint.entities);
  addEntities(ctx && ctx.task && ctx.task.entities);
  addEntities(va && va.sourceEntityContract && va.sourceEntityContract.entities);
  addEntities(va && va.fidelityContract && va.fidelityContract.entities);
  return out;
}

function hasSourceVisualSurface(va) {
  if (!va || typeof va !== 'object') return false;
  var sec = va.sourceEntityContract || {};
  var spc = va.sourcePhaseContract || {};
  var bindings = va.entityBindings || {};
  var entityCount = Array.isArray(sec.entities) ? sec.entities.length : Object.keys(sec.entityStyles || {}).length;
  var phaseCount = Array.isArray(spc.phases) ? spc.phases.length : 0;
  return entityCount > 0 && phaseCount > 0 && Object.keys(bindings).length > 0;
}

function mergeVisualManifest(base, fallback) {
  var out = cloneJson(base) || {};
  fallback = fallback || {};
  [
    'visualAssetsSchemaVersion',
    'kind',
    'assetLicenseContractVersion',
    'source',
    'project',
    'fidelityTarget',
    'assetMetadata',
    'sourceEntityContract',
    'sourceSceneContract',
    'sourcePhaseContract',
    'visualRuntimeContract',
    'extractionSummary',
    'assets',
    'entityBindings',
    'unsupported',
  ].forEach(function(key) {
    var cur = out[key];
    var missing = cur == null
      || (Array.isArray(cur) && cur.length === 0)
      || (typeof cur === 'object' && !Array.isArray(cur) && Object.keys(cur).length === 0);
    if (missing && fallback[key] != null) out[key] = cloneJson(fallback[key]);
  });
  return out;
}

function synthesizeVisualAssetsFromSourceHtml(ctx, existingVa) {
  var sourceHtmlPath = resolveSourceHtmlPath(ctx, existingVa);
  if (!sourceHtmlPath) return null;
  var extractor = loadVisualAssetExtractor();
  var html = fs.readFileSync(sourceHtmlPath, 'utf8');
  var manifest = extractor.extractVisualAssetManifest(html, {
    source: sourceHtmlPath,
    project: ctx && (ctx.taskId || ctx.id) || null,
    entityNames: collectVisualEntityNames(ctx, existingVa),
  });
  extractor.validateVisualAssetManifest(manifest);
  if (!hasSourceVisualSurface(manifest)) {
    throw new Error('visualAssets synthesis failed: source HTML did not yield sourceEntityContract/sourcePhaseContract/entityBindings for ' + sourceHtmlPath);
  }
  logVisualAssets(ctx, 'Synthesized visualAssets from source HTML: entities=' +
    ((manifest.sourceEntityContract && manifest.sourceEntityContract.entities || []).length) +
    ', phases=' + ((manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || []).length) +
    ', bindings=' + Object.keys(manifest.entityBindings || {}).length);
  return manifest;
}

function resolveFidelityContractForBuild(ctx) {
  var contract = null;
  var contractSource = null;
  if (ctx && ctx.fidelityFieldDiffTemplate && ctx.fidelityFieldDiffTemplate.contract) {
    contract = ctx.fidelityFieldDiffTemplate.contract;
    contractSource = 'ctx.fidelityFieldDiffTemplate';
  } else if (ctx && ctx.blueprint && ctx.blueprint.fidelityContract) {
    contract = ctx.blueprint.fidelityContract;
    contractSource = 'ctx.blueprint.fidelityContract';
  } else {
    var candidates = [];
    if (ctx && ctx.fidelityContractPath) candidates.push(ctx.fidelityContractPath);
    if (ctx && ctx.blueprint && ctx.blueprint.fidelityContractPath) candidates.push(ctx.blueprint.fidelityContractPath);
    if (process.env.BLUEPRINT_USE_DEFAULT_FIDELITY_FIXTURE === '1') {
      candidates.push(DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD);
    }
    for (var i = 0; i < candidates.length; i++) {
      var p = candidates[i];
      try {
        if (p && fs.existsSync(p)) {
          contract = JSON.parse(fs.readFileSync(p, 'utf8'));
          contractSource = p;
          break;
        }
      } catch(e) {}
    }
  }
  return { contract: unwrapSplitPackContract(contract), source: contractSource };
}

function sanitizeFidelityContractAnchorsForBuild(contract) {
  var out = cloneJson(unwrapSplitPackContract(contract));
  var stats = { phases: 0, kept: 0, removed: 0 };
  if (!out || !Array.isArray(out.phases)) return { contract: out, stats: stats };
  var filterComparableAnchors = loadFieldDiffLib().filterComparableAnchors;
  for (var i = 0; i < out.phases.length; i++) {
    var phase = out.phases[i];
    if (!phase || !phase.projectedAnchors || typeof phase.projectedAnchors !== 'object') continue;
    var before = Object.keys(phase.projectedAnchors).length;
    var filtered = filterComparableAnchors(phase.projectedAnchors);
    var after = Object.keys(filtered).length;
    phase.projectedAnchors = filtered;
    stats.phases++;
    stats.kept += after;
    stats.removed += Math.max(0, before - after);
  }
  return { contract: out, stats: stats };
}

function buildVisualAssetsForRequest(ctx) {
  var bp = ctx && ctx.blueprint || {};
  var va = (ctx && ctx.visualAssets) || bp.visualAssets || (ctx && ctx.task && ctx.task.visualAssets) || null;
  va = cloneJson(va);
  var sourceHtmlPath = resolveSourceHtmlPath(ctx, va);
  if ((!va || !hasSourceVisualSurface(va)) && sourceHtmlPath) {
    va = mergeVisualManifest(va, synthesizeVisualAssetsFromSourceHtml(ctx, va));
  }
  if (!va) return null;
  var resolved = va.fidelityContract
    ? { contract: va.fidelityContract, source: 'visualAssets.fidelityContract' }
    : resolveFidelityContractForBuild(ctx);
  var contract = unwrapSplitPackContract(resolved.contract);
  var contractSource = resolved.source;
  if (!contract) {
    if (sourceHtmlPath && process.env.BLUEPRINT_VISUAL_ASSETS_STRICT !== '0') {
      throw new Error('visualAssets strict gate: source HTML is bound but no fidelityContract is available for build injection: ' + sourceHtmlPath);
    }
    return va;
  }
  // Fail-loud: v1.0/v1.1 contracts have no projectedAnchors. Returning visualAssets
  // WITHOUT fidelityContract triggers the writer's empty-anchors path, which the
  // fidelity-source-diff stage then surfaces as a single blocking
  // `anchor-bridge-missing` entry — instead of silently shipping a v1.0 contract
  // that the writer would treat as valid input.
  if (!contractHasProjectedAnchors(contract)) {
    var msg = '[buildVisualAssetsForRequest] FAIL-LOUD: contract from ' + contractSource +
      ' has schemaVersion=' + (contract.schemaVersion || 'unknown') +
      ' with NO phases[].projectedAnchors — refusing to inject. Run scripts/migrate-v1.1-to-v1.2.cjs ' +
      'or set ctx.fidelityContractPath to a v1.2 migrated contract.';
    console.error(msg);
    if (sourceHtmlPath && process.env.BLUEPRINT_VISUAL_ASSETS_STRICT !== '0') throw new Error(msg);
    return va;
  }
  var sanitized = sanitizeFidelityContractAnchorsForBuild(contract);
  contract = sanitized.contract;
  if (sanitized.stats.removed > 0) {
    logVisualAssets(ctx, 'Dropped ' + sanitized.stats.removed +
      ' non-comparable projectedAnchors from ' + contractSource +
      ' before build injection (kept=' + sanitized.stats.kept + ')');
  }
  va = Object.assign({}, va, { fidelityContract: contract });
  if (sourceHtmlPath && process.env.BLUEPRINT_VISUAL_ASSETS_STRICT !== '0' && !hasSourceVisualSurface(va)) {
    throw new Error('visualAssets strict gate: build manifest missing source visual surface for ' + sourceHtmlPath);
  }
  return va;
}

// ============ File Helpers ============

function buildGameStateBridgeScript() {
  return `<script>
(function(){
  window.__BLUEPRINT_GAMESTATE_BRIDGE_VERSION__='manual-default-autoplay-param-v1';
  // Public preview is manual by default. CUA/diagnostic observe runs must opt in
  // with ?autoplay=1 so the user-facing URL cannot silently self-play.
  var _autoPlayFlagCreated=false;
  var _observerReadyFlagCreated=false;
  var _params=new URLSearchParams(window.location.search);
  var _autoplayParam=_params.get('autoplay');
  var _manualRequested=_autoplayParam==='0'||_params.get('manual')==='1'||_params.get('interactive')==='1';
  var _cuaAutoPlayRequested=_autoplayParam==='1'&&!_manualRequested;
  var _observerReadyRequested=_params.get('observerReady')==='1'||_params.get('cuaObserverReady')==='1';
  var _autoPlayRequested=_cuaAutoPlayRequested;
  window.__CUA_OBSERVER_READY__ = !!window.__CUA_OBSERVER_READY__ || _observerReadyRequested;
  function syncUnityAbsoluteUrl(){
    try{
      if(typeof UnityEngine!=='undefined'&&UnityEngine.Application){
        UnityEngine.Application.absoluteURL=window.location.href;
      }
    }catch(e){}
  }
  syncUnityAbsoluteUrl();
  function createRuntimeFlag(name){
    var made=false;
    syncUnityAbsoluteUrl();
    try{
      if(typeof UnityEngine!=='undefined'&&UnityEngine.GameObject){
        try{ if(UnityEngine.GameObject.Find&&UnityEngine.GameObject.Find(name)!=null) return true; }catch(e){}
        if(UnityEngine.GameObject.$ctor2){ new UnityEngine.GameObject.$ctor2(name); made=true; }
        else if(UnityEngine.GameObject.ctor){ new UnityEngine.GameObject.ctor(name); made=true; }
      }
    }catch(e){}
    try{
      var appForFlag=pc.app||pc.Application.getApplication();
      if(appForFlag&&appForFlag.root){var fe=new pc.Entity(name);appForFlag.root.addChild(fe);made=true;}
    }catch(e){}
    return made;
  }
  setInterval(function(){
    try{
      var app=pc.app||pc.Application.getApplication();
      // Create autoPlay flag entity once (C# reads via GameObject.Find("__AUTOPLAY_ON__"))
      if(_autoPlayRequested&&!_autoPlayFlagCreated){
        _autoPlayFlagCreated=createRuntimeFlag('__AUTOPLAY_ON__');
      }
      if(window.__CUA_OBSERVER_READY__&&!_observerReadyFlagCreated){
        _observerReadyFlagCreated=createRuntimeFlag('__CUA_OBSERVER_READY__');
      }
      if(!app||!app.root)return;
      if(window.__CUA_OBSERVER_READY__&&!_observerReadyFlagCreated){
        _observerReadyFlagCreated=createRuntimeFlag('__CUA_OBSERVER_READY__');
      }
      // Scan all children recursively and choose the freshest GFM state.
      // Some Luna exports keep stale renamed entities around; taking the first
      // GFM| node can freeze CUA coverage on an older phase.
      function scoreState(s){
        if(!s)return -1;
        var completed=Array.isArray(s.completedPhases)?s.completedPhases.length:0;
        var timer=s.variables&&typeof s.variables.gameTimer==='number'?s.variables.gameTimer:0;
        var ts=0;
        var stamps=s.phaseTimestamps||{};
        for(var k in stamps){if(Object.prototype.hasOwnProperty.call(stamps,k)){var v=Number(stamps[k])||0;if(v>ts)ts=v;}}
        return completed*1000000+ts*1000+timer;
      }
      function consider(raw,best){
        try{
          var state=JSON.parse(raw.substring(4));
          var score=scoreState(state);
          if(!best||score>best.score)return{state:state,score:score};
        }catch(e){}
        return best;
      }
      function scan(node,best){
        if(!node)return best;
        var n=node._name||node.name||'';
        if(n.indexOf('GFM|')===0)best=consider(n,best);
        var c=node._children||node.children||[];
        for(var i=0;i<c.length;i++){best=scan(c[i],best);}
        return best;
      }
      var best=scan(app.root,null);
      if(best&&best.state){window.__gameState=best.state;}
    }catch(e){}
  },500);
})();
<\/script>`;
}

function injectGameStateBridgeHtml(html) {
  var inputIsBuffer = Buffer.isBuffer(html);
  var text = inputIsBuffer ? html.toString('utf8') : String(html || '');
  if (!text) return inputIsBuffer ? Buffer.from('') : '';
  var hasAutoPlayBridge = text.indexOf('var _autoPlayFlagCreated=false;') >= 0;
  var hasObserverBridge = text.indexOf('var _observerReadyFlagCreated=false;') >= 0 ||
    text.indexOf('window.__CUA_OBSERVER_READY__ = !!window.__CUA_OBSERVER_READY__;') >= 0;
  var hasGameStateBridge = text.indexOf('window.__gameState=best.state') >= 0;
  var hasManualDefaultBridge = text.indexOf('manual-default-autoplay-param-v1') >= 0;
  if (hasManualDefaultBridge && hasAutoPlayBridge && hasObserverBridge && hasGameStateBridge) {
    return html;
  }
  text = text.replace(
    /<script>\s*\(function\(\)\{\s*window\.__BLUEPRINT_GAMESTATE_BRIDGE_VERSION__='public-preview-autoplay-v1';[\s\S]*?\}\)\(\);\s*<\/script>/,
    ''
  );
  var bridge = buildGameStateBridgeScript();
  if (text.indexOf('</body>') >= 0) {
    text = text.replace('</body>', bridge + '</body>');
  } else {
    text += bridge;
  }
  return inputIsBuffer ? Buffer.from(text, 'utf8') : text;
}

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
function buildRequest(buildUrl, endpoint, csCode, extraFiles, options) {
  var buildOptions = options || {};
  // /build-html legacy adapter: current API only has /build but returns htmlBase64.
  if (endpoint === '/build-html') {
    return buildRequest(buildUrl, '/build', csCode, extraFiles, buildOptions).then(function(result) {
      if (result && result.htmlBase64) {
        return injectGameStateBridgeHtml(Buffer.from(result.htmlBase64, 'base64'));
      }
      if (result && Buffer.isBuffer(result)) return injectGameStateBridgeHtml(result); // legacy server already returned raw HTML
      var msg = (result && result.error) ? result.error : 'HTML not in build response';
      throw new Error(msg);
    });
  }

  var MAX_RETRIES = 2;

  function doRequest(attempt) {
    return new Promise(function(resolve, reject) {
      var parsedUrl = new (require('url').URL)(buildUrl + endpoint);
      // Send both `csCode` (new API) and `code` (legacy API) for compatibility.
      var body = JSON.stringify({
        csCode: csCode,
        code: csCode,
        className: 'GameFlowManagerMain',
        extraFiles: extraFiles,
        visualAssets: buildOptions.visualAssets || null,
      });
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
  if (issues.includes('signal-coverage') || issues.includes('missing expected signals')) return 'signal-coverage';
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
  var HIGH = ['phase-coverage', 'entity-incomplete', 'stuck', 'engine-not-ready', 'no-content', 'stuck-pattern', 'no-coverage', 'signal-coverage'];
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
    'batch-completion': 'Multiple phases completed in a single poll interval. Each phase must hold a distinct visual state for the AutoPlay dwell gate (12s normal, 20s high complexity). Check that CheckEventRules uses PhaseDwellReady(Nf) and that AutoPlay dwell is backed by phaseRealTimer/Time.realtimeSinceStartup, not accelerated phaseTimer.' + LUNA_REMINDERS,
    'signal-coverage': 'Phase IDs may complete, but required module contracts did not emit observable signals. Fix the specific runtime modules tied to the missing signals: build_progress should drive built state, guide_ui should update guideText, score_feedback should update scoreText, floating_text_feedback should emit floatingText, camera_* modules should update camera variables. Do not only flip phase flags — make the underlying state/UI/camera effects observable via __gameState.' + LUNA_REMINDERS,
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

  // A.1 (2026-04-20): enrich feedback with 6 cuaResult fields that
  // buildStructuredFeedback previously dropped. Claude needs these to find
  // root cause on round 1 — before A.1 it saw only issues + gameState + code
  // snippets, often not enough. Placed at text END so spec prefix stays in
  // prompt cache.
  var report = (cuaResult && cuaResult.report) || {};
  var diagLines = [];

  // Exit reason (always print if present — short and always informative)
  if (report.exitReason) {
    diagLines.push('Exit: ' + String(report.exitReason).slice(0, 200));
  }

  // Autoplay detection (only when true — observe mode exists by design)
  if (report.autoplay_detected === true) {
    var ar = report.autoplay_reason || report.autoplayReason || '';
    diagLines.push('Autoplay: detected' + (ar ? ' (reason: ' + String(ar).slice(0, 200) + ')' : ''));
  }

  // Script coverage — only list uncovered steps
  if (Array.isArray(report.scriptCoverage) && report.scriptCoverage.length > 0) {
    var total = report.scriptCoverage.length;
    var uncovered = report.scriptCoverage.filter(function(s) { return s && !s.covered; });
    var covered = total - uncovered.length;
    var pct = total > 0 ? Math.round(covered / total * 100) : 0;
    var covLine = 'Script coverage: ' + covered + '/' + total + ' (' + pct + '%)';
    if (uncovered.length > 0) {
      covLine += '. Uncovered:';
      diagLines.push(covLine);
      var shown = uncovered.slice(0, 6);
      for (var ui = 0; ui < shown.length; ui++) {
        var s = shown[ui];
        var evidence = s.evidence ? String(s.evidence).slice(0, 80) : '';
        diagLines.push('  - ' + (s.step || '(unnamed)') + (evidence ? ': ' + evidence : ''));
      }
      if (uncovered.length > 6) diagLines.push('  ... ' + (uncovered.length - 6) + ' more');
    } else {
      diagLines.push(covLine);
    }
  }

  // Visual fails (VLM reasons)
  if (Array.isArray(report.visual_fail_reasons) && report.visual_fail_reasons.length > 0) {
    diagLines.push('Visual fails (VLM):');
    var vshown = report.visual_fail_reasons.slice(0, 5);
    for (var vi = 0; vi < vshown.length; vi++) {
      diagLines.push('  - ' + String(vshown[vi]).slice(0, 120));
    }
    if (report.visual_fail_reasons.length > 5) {
      diagLines.push('  ... ' + (report.visual_fail_reasons.length - 5) + ' more');
    }
  }

  // Phase timing (derived from phaseTimestamps)
  var specPhases = (blueprint && Array.isArray(blueprint.specs))
    ? blueprint.specs.map(function(sp) { return sp && sp.phaseId; }).filter(Boolean)
    : [];
  var phaseTs = (report.gameState && report.gameState.phaseTimestamps) || report.phaseTimestamps || null;
  if (phaseTs && specPhases.length > 0) {
    var durations = extractPhaseDurations(phaseTs, specPhases);
    if (durations.length > 0) {
      diagLines.push('Phase timing:');
      var dshown = durations.slice(0, 6);
      for (var di = 0; di < dshown.length; di++) {
        var d = dshown[di];
        var deltaStr = d.deltaSec === null ? 'n/a' : d.deltaSec + 's';
        diagLines.push('  - ' + d.from + '→' + d.to + ': ' + deltaStr + ' [' + d.flag + ']');
      }
      if (durations.length > 6) diagLines.push('  ... ' + (durations.length - 6) + ' more phases');
    }
  }

  // Missing phases — skip if issues already enumerate them (phase-coverage issue)
  if (Array.isArray(report.missingPhases) && report.missingPhases.length > 0) {
    var issueHasMissing = (cuaResult.issues || []).some(function(it) {
      return typeof it === 'string' && it.toLowerCase().indexOf('missing') >= 0;
    });
    if (!issueHasMissing) {
      diagLines.push('Missing phases: ' + report.missingPhases.join(', '));
    }
  }

  // Plan / signal coverage — assembly-first specific diagnostics
  if (report.planCoverage) {
    diagLines.push('Plan coverage: ' + String(report.planCoverage));
  }
  if (report.signalCoverage) {
    var signalLine = 'Signal coverage: ' + String(report.signalCoverage);
    if (report.signalValidationPassed === false) signalLine += ' (FAILED)';
    diagLines.push(signalLine);
  }
  if (Array.isArray(report.missingSignals) && report.missingSignals.length > 0) {
    diagLines.push('Missing signals:');
    var missingShown = report.missingSignals.slice(0, 8);
    for (var ms = 0; ms < missingShown.length; ms++) {
      diagLines.push('  - ' + String(missingShown[ms]).slice(0, 120));
    }
    if (report.missingSignals.length > 8) {
      diagLines.push('  ... ' + (report.missingSignals.length - 8) + ' more');
    }
  }
  if (Array.isArray(report.unsupportedSignals) && report.unsupportedSignals.length > 0) {
    diagLines.push('Unsupported signals (non-blocking): ' + report.unsupportedSignals.slice(0, 6).join(', '));
  }

  if (diagLines.length > 0) {
    text += '\n\n=== CUA DIAGNOSTICS (round ' + round + ') ===\n' + diagLines.join('\n');
  }

  // Token guard: cap total feedback text at 8KB. Protects recode prompt
  // against pathologically long visual_fail_reasons / entity lists.
  if (text.length > 8000) {
    text = text.slice(0, 7800) + '\n... [truncated]';
  }

  return { text: text, structured: structured };
}

/**
 * A.3 (2026-04-20): derive per-phase dwell deltas from phaseTimestamps.
 *
 * phaseTimestamps is { phaseId: secondsSinceStart } keyed by phase. We
 * walk specPhases in declared order and emit adjacent-pair deltas with
 * flags to tell Claude WHICH phase broke and HOW. Mirrors the dwell
 * formula in worker/worker-cua-verify.js:1418-1422.
 *
 * Flags:
 *   batch-fired     delta < 1.0s (multi-phase same-tick completion — trigger likely wrong)
 *   ok              1.0s <= delta <= 30s
 *   slow            delta > 30s (autoPlay gate is 12s, 2x+ is suspicious)
 *   never-completed ts missing but previous phase completed (stuck here)
 *   never-reached   ts missing and previous also missing (pipeline never got here)
 */
function extractPhaseDurations(phaseTimestamps, specPhases) {
  if (!phaseTimestamps || !Array.isArray(specPhases) || specPhases.length === 0) return [];
  var out = [];
  var prevReached = true; // start is implicitly reached
  var prevTs = 0;
  for (var i = 0; i < specPhases.length; i++) {
    var pid = specPhases[i];
    var ts = (pid in phaseTimestamps) ? phaseTimestamps[pid] : null;
    var fromId = i === 0 ? 'start' : specPhases[i - 1];
    var entry = { from: fromId, to: pid, deltaSec: null, flag: 'never-reached' };
    if (ts !== null && ts !== undefined) {
      var delta = ts - prevTs;
      entry.deltaSec = Math.round(delta * 10) / 10;
      if (delta < 1.0) entry.flag = 'batch-fired';
      else if (delta > 30) entry.flag = 'slow';
      else entry.flag = 'ok';
      prevReached = true;
      prevTs = ts;
    } else {
      entry.flag = prevReached ? 'never-completed' : 'never-reached';
      prevReached = false;
    }
    out.push(entry);
  }
  return out;
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
  injectGameStateBridgeHtml: injectGameStateBridgeHtml,
  reportStatus: reportStatus,
  categorizeIssue: categorizeIssue,
  extractPhaseFromConsole: extractPhaseFromConsole,
  extractPhaseCoverage: extractPhaseCoverage,
  getIssueSeverity: getIssueSeverity,
  getFixHint: getFixHint,
  extractCodeContext: extractCodeContext,
  buildStructuredFeedback: buildStructuredFeedback,
  extractPhaseDurations: extractPhaseDurations,
  buildVisualAssetsForRequest: buildVisualAssetsForRequest,
};
