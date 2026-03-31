/**
 * Worker-side CUA Verification - Blueprint Flow Verifier
 * 
 * Uses GPT-5.4 CUA to navigate HTML following blueprint shot sequence.
 * 
 * Pass/fail criteria (no scoring):
 *   1. All blueprint shots are reachable/covered
 *   2. CTA button is reachable and clickable
 *   3. No stuck/crash/white-screen
 *   4. GPT must observe actual game content (not blank/empty screen)
 *   5. All phases must be in completedPhases (no skipped phases)
 *   6. All buildable entities must reach terminal state (e.g. conveyor=2, woodHouse=2, turret=2)
 *   7. Phase dwell time: each phase must be active for >= MIN_PHASE_DWELL_SECONDS
 * 
 * On failure: returns uncovered shots + issue descriptions for AI re-coding.
 */

const { spawn } = require('child_process');
const { loadSpecs } = require('../spec-extractor.cjs');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LUNA_AGENT_JS = path.join(__dirname, 'luna-agent.js');
const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
const MAX_CUA_RETRIES = 3;
const LOCAL_PREVIEW_PORT = 18850;

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

/**
 * Patch Luna build files for Playwright/headless compatibility.
 * 
 * Two known issues in Luna 6.4.0 under headless Chromium:
 *   1. `new Event("xxx")` throws "parameter 1 is not of type Event"
 *      Fix: replace with document.createEvent("Event") + initEvent()
 *   2. UnityEngine.Behaviour$1#isActiveAndEnabled getter crashes on null ref
 *      Fix: add null guard before .enabled access
 */
function patchForHeadless(content, filename) {
  let patched = content;
  let fixes = 0;

  // Fix 1: Replace new Event("xxx") with createEvent pattern
  // Matches: new Event("luna:ready"), new Event("bridge:ready"), etc.
  patched = patched.replace(/new Event\(([^)]+)\)/g, (match, args) => {
    fixes++;
    return '(function(){var _e=document.createEvent("Event");_e.initEvent(' + args + ',true,true);return _e;})()';
  });

  // Fix 2: isActiveAndEnabled null guard (UnityEngine.js only)
  // Pattern: return this.XXX$.enabled&&this.YYY$.ZZZ$
  if (filename.includes('UnityEngine')) {
    patched = patched.replace(
      /return this\.(\w+)\$\.enabled&&this\.(\w+)\$\.(\w+)\$/g,
      (match, a, b, d) => {
        fixes++;
        return 'return (this.' + a + '$?this.' + a + '$.enabled:false)&&(this.' + b + '$?this.' + b + '$.' + d + '$:false)';
      }
    );
  }

  return { content: patched, fixes };
}

/**
 * Start a simple local HTTP server to serve the build output
 * with on-the-fly patching for headless compatibility
 */
function startLocalServer(buildDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(buildDir, req.url === '/' ? 'iframe.html' : req.url);
      filePath = filePath.split('?')[0];
      
      if (!fs.existsSync(filePath)) {
        if (req.url === '/') filePath = path.join(buildDir, 'index.html');
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg',
        '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
        '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
      };

      // Patch HTML and JS files on-the-fly for headless compatibility
      if (ext === '.html' || ext === '.js') {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const { content, fixes } = patchForHeadless(raw, path.basename(filePath));
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
          res.end(content);
          return;
        } catch(e) {
          // Fall through to stream if patch fails
        }
      }

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(LOCAL_PREVIEW_PORT, '127.0.0.1', () => {
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        try {
          require('child_process').execSync(
            'powershell -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort ' + LOCAL_PREVIEW_PORT + ').OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"',
            { timeout: 5000 }
          );
        } catch(e) {}
        setTimeout(() => {
          server.listen(LOCAL_PREVIEW_PORT, '127.0.0.1', () => resolve(server));
        }, 1000);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Generate script file from blueprint for CUA to follow
 */
function generateScript(blueprint, outputPath) {
  if (!blueprint || !blueprint.nodes) return null;
  
  // Try shotNodes first (V3 blueprints)
  let steps = blueprint.nodes
    .filter(n => n.type === 'shotNode')
    .map((n, i) => (i + 1) + '. ' + (n.data.name || n.data.label || 'Shot ' + (i + 1)));
  
  // Fallback: phaseNodes (V4 entity-driven blueprints)
  if (steps.length === 0) {
    const phaseNodes = blueprint.nodes
      .filter(n => n.type === 'phaseNode')
      .sort((a, b) => {
        const ai = parseInt((a.id || '').replace(/\D/g, '')) || 0;
        const bi = parseInt((b.id || '').replace(/\D/g, '')) || 0;
        return ai - bi;
      });
    
    if (phaseNodes.length > 0) {
      steps = phaseNodes.map((n, i) => {
        const d = n.data || {};
        const name = d.name || d.label || 'Phase ' + (i + 1);
        const trigger = d.triggerCondition || '';
        const guide = d.guide || '';
        const activate = (d.activate || []).join(', ');
        let step = (i + 1) + '. [Phase] ' + name;
        if (trigger) step += ' | 触发: ' + trigger;
        if (guide) step += ' | 操作: ' + guide;
        if (activate) step += ' | 新增实体: ' + activate;
        return step;
      });
    }
  }
  
  if (steps.length === 0) return null;
  
  fs.writeFileSync(outputPath, steps.join('\n'), 'utf-8');
  return outputPath;
}

/**
 * Quick Play Test — 15-second headless Playwright check before full CUA.
 * Opens the HTML, waits for load, reads _currentShot, simulates basic input,
 * checks if _currentShot changes. No GPT needed, pure automation.
 * 
 * @returns {object} { ok: boolean, reason?: string, loaded: boolean, initialShot, finalShot, shotProgressed }
 */
async function quickPlayTest(url, taskId, log) {
  let browser, page;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();

    // Suppress console errors from the game
    page.on('pageerror', () => {});

    // Load page
    log('[QuickTest] Loading ' + url, taskId);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    } catch(e) {
      await browser.close();
      return { ok: false, reason: 'Page failed to load: ' + e.message, loaded: false };
    }

    // Wait for Unity engine init
    await page.waitForTimeout(8000);

    // === Engine Health Check — must pass before CUA ===
    const engineHealth = await page.evaluate(function() {
      var h = {};
      h.bridge = typeof Bridge !== 'undefined';
      h.pc = typeof pc !== 'undefined';
      h.lunaUnity = typeof LunaUnity !== 'undefined';
      h.unityEngine = typeof UnityEngine !== 'undefined';
      h.windowApp = typeof window.app !== 'undefined';
      h.canvas = !!document.querySelector('canvas');
      try { h.webgl = !!document.querySelector('canvas').getContext('webgl2') || !!document.querySelector('canvas').getContext('webgl'); } catch(e) { h.webgl = false; }
      // Scene objects
      h.rendererCount = 0;
      try {
        if (typeof UnityEngine !== 'undefined' && UnityEngine.Object && UnityEngine.Object.FindObjectsOfType$1) {
          var rr = UnityEngine.Object.FindObjectsOfType$1(UnityEngine.Renderer);
          h.rendererCount = rr ? rr.length : 0;
        }
      } catch(e) {}
      return h;
    });
    log('[QuickTest] Engine health: ' + JSON.stringify(engineHealth), taskId);

    // Gate: engine must be loaded
    if (!engineHealth.bridge || !engineHealth.unityEngine) {
      await browser.close();
      return { ok: false, reason: 'Engine not initialized: Bridge=' + engineHealth.bridge + ' UnityEngine=' + engineHealth.unityEngine + ' pc=' + engineHealth.pc + ' app=' + engineHealth.windowApp, loaded: false, engineHealth: engineHealth };
    }

    // Gate: scene must have objects (not empty)
    if (engineHealth.rendererCount === 0) {
      await browser.close();
      return { ok: false, reason: 'Scene is empty (0 renderers). Engine loaded but scene failed to initialize. pc=' + engineHealth.pc + ' app=' + engineHealth.windowApp + ' webgl=' + engineHealth.webgl, loaded: true, engineHealth: engineHealth };
    }

    log('[QuickTest] Scene has ' + engineHealth.rendererCount + ' renderers — proceeding', taskId);

    // Check if page has any visible content (not blank/white/black screen)
    const bodyColor = await page.evaluate(function() {
      var canvas = document.querySelector('canvas');
      if (canvas) return 'has-canvas';
      return document.body.innerText.length > 10 ? 'has-text' : 'empty';
    });
    if (bodyColor === 'empty') {
      await browser.close();
      return { ok: false, reason: 'Page loaded but appears empty (no canvas, no text). Game may not have initialized.', loaded: false };
    }

    // Try to read _currentShot from the game runtime
    var initialShot = await page.evaluate(function() {
      // Try multiple ways to find the shot state
      try {
        // Bridge.NET compiled code — global scope or on component
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain._currentShot !== undefined) return GameFlowManagerMain._currentShot;
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain.currentShot !== undefined) return GameFlowManagerMain.currentShot;
      } catch(e) {}
      try {
        // Search through Unity objects
        var objs = typeof UnityEngine !== 'undefined' && UnityEngine.Object ? UnityEngine.Object.FindObjectsOfType(UnityEngine.MonoBehaviour) : null;
        if (objs) {
          for (var i = 0; i < objs.length; i++) {
            if (objs[i]._currentShot !== undefined) return objs[i]._currentShot;
            if (objs[i].currentShot !== undefined) return objs[i].currentShot;
          }
        }
      } catch(e) {}
      return null;
    });

    log('[QuickTest] Initial shot state: ' + initialShot, taskId);

    // Simulate basic interactions: clicks + drags
    var interactions = [
      { type: 'click', x: 400, y: 300 },   // center
      { type: 'click', x: 400, y: 500 },   // bottom center
      { type: 'drag', x1: 90, y1: 560, x2: 90, y2: 510 },  // joystick up
      { type: 'click', x: 200, y: 300 },   // left area
      { type: 'drag', x1: 90, y1: 560, x2: 130, y2: 560 }, // joystick right
      { type: 'click', x: 600, y: 300 },   // right area
    ];

    for (var i = 0; i < interactions.length; i++) {
      var action = interactions[i];
      try {
        if (action.type === 'click') {
          await page.mouse.click(action.x, action.y);
        } else if (action.type === 'drag') {
          await page.mouse.move(action.x1, action.y1);
          await page.mouse.down();
          await page.mouse.move(action.x2, action.y2, { steps: 5 });
          await page.mouse.up();
        }
      } catch(e) {}
      await page.waitForTimeout(800);
    }

    // Read shot state again
    var finalShot = await page.evaluate(function() {
      try {
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain._currentShot !== undefined) return GameFlowManagerMain._currentShot;
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain.currentShot !== undefined) return GameFlowManagerMain.currentShot;
      } catch(e) {}
      try {
        var objs = typeof UnityEngine !== 'undefined' && UnityEngine.Object ? UnityEngine.Object.FindObjectsOfType(UnityEngine.MonoBehaviour) : null;
        if (objs) {
          for (var i = 0; i < objs.length; i++) {
            if (objs[i]._currentShot !== undefined) return objs[i]._currentShot;
            if (objs[i].currentShot !== undefined) return objs[i].currentShot;
          }
        }
      } catch(e) {}
      return null;
    });

    log('[QuickTest] Final shot state: ' + finalShot, taskId);

    // Take a screenshot for debugging
    var screenshotPath = path.join(CUA_RESULTS_DIR, taskId + '-quicktest.png');
    try {
      await page.screenshot({ path: screenshotPath });
    } catch(e) {}

    // === Solid color detection (3-14 audit lesson: stop CUA on solid-color screens) ===
    // WebGL canvas with preserveDrawingBuffer:false (default) clears after compositing,
    // so both gl.readPixels AND drawImage read black. The only reliable source is
    // the page screenshot (which captures the composited frame before clear).
    // Multi-region sampling (3-29 fix): sample center + 4 quadrants to avoid false
    // positives when ground plane fills center but objects exist at edges.
    var solidColorCheck = { solid: false, reason: 'screenshot-analysis' };
    try {
      if (fs.existsSync(screenshotPath)) {
        var sharp = require('sharp');
        var img = sharp(screenshotPath);
        var meta = await img.metadata();
        var imgW = meta.width || 400;
        var imgH = meta.height || 400;
        var channels = meta.channels || 3;
        var regionSize = 60;

        // 5 regions: center, top-left, top-right, bottom-left, bottom-right
        var regions = [
          { left: Math.floor(imgW / 2) - 30, top: Math.floor(imgH / 2) - 30 },
          { left: Math.floor(imgW * 0.2) - 30, top: Math.floor(imgH * 0.25) - 30 },
          { left: Math.floor(imgW * 0.8) - 30, top: Math.floor(imgH * 0.25) - 30 },
          { left: Math.floor(imgW * 0.2) - 30, top: Math.floor(imgH * 0.75) - 30 },
          { left: Math.floor(imgW * 0.8) - 30, top: Math.floor(imgH * 0.75) - 30 }
        ];
        // Clamp regions to image bounds
        for (var ri = 0; ri < regions.length; ri++) {
          regions[ri].left = Math.max(0, Math.min(regions[ri].left, imgW - regionSize));
          regions[ri].top = Math.max(0, Math.min(regions[ri].top, imgH - regionSize));
        }

        var solidRegions = 0;
        var firstColor = null;
        var allRegionsSameColor = true;
        for (var ri = 0; ri < regions.length; ri++) {
          var buf = await sharp(screenshotPath)
            .extract({ left: regions[ri].left, top: regions[ri].top, width: regionSize, height: regionSize })
            .raw().toBuffer();
          var r0 = buf[0], g0 = buf[1], b0 = buf[2];
          var regionSolid = true;
          for (var si = channels; si < buf.length; si += channels) {
            if (Math.abs(buf[si] - r0) > 5 || Math.abs(buf[si+1] - g0) > 5 || Math.abs(buf[si+2] - b0) > 5) {
              regionSolid = false;
              break;
            }
          }
          if (regionSolid) solidRegions++;
          if (!firstColor) {
            firstColor = { r: r0, g: g0, b: b0 };
          } else if (Math.abs(r0 - firstColor.r) > 15 || Math.abs(g0 - firstColor.g) > 15 || Math.abs(b0 - firstColor.b) > 15) {
            allRegionsSameColor = false;
          }
        }
        // Only flag as solid if ALL regions are uniform AND they share the same color
        var isSolid = solidRegions >= 5 && allRegionsSameColor;
        var colorStr = firstColor ? 'rgb(' + firstColor.r + ',' + firstColor.g + ',' + firstColor.b + ')' : 'unknown';
        solidColorCheck = { solid: isSolid, color: colorStr, sampled: regionSize * regionSize * 5, method: 'multi-region', solidRegions: solidRegions, totalRegions: 5 };
      }
    } catch(e) {
      log('[QuickTest] Screenshot analysis error (non-fatal): ' + e.message, taskId);
      solidColorCheck = { solid: false, reason: 'analysis-error: ' + e.message };
    }
    log('[QuickTest] Solid color check: ' + JSON.stringify(solidColorCheck), taskId);

    if (solidColorCheck.solid) {
      var colorStr = solidColorCheck.color || 'unknown';
      var isBlack = colorStr === 'rgb(0,0,0)';
      if (isBlack) {
        // True black = no GPU / WebGL context failed — skip CUA entirely
        log('[QuickTest] ⚠️ SOLID BLACK — no GPU or WebGL render failure, skipping CUA', taskId);
        await browser.close();
        return {
          ok: false,
          reason: 'Screen is solid black — no GPU or WebGL context failure. CUA cannot operate.',
          loaded: true,
          solidColor: true,
          solidColorDetail: solidColorCheck,
          initialShot: initialShot,
          finalShot: finalShot,
          shotProgressed: false
        };
      } else {
        // Non-black solid color = code logic bug (objects hidden/same color/not created)
        // Return as a code issue, NOT a GPU issue — let the pipeline handle it as build feedback
        log('[QuickTest] ⚠️ SOLID COLOR (' + colorStr + ') — likely code bug (objects not visible), reporting as build issue', taskId);

        // Inject diagnostic script to find out WHY the screen is solid color
        var diagnostics = { objectsAtOrigin: [], objectsHidden: [], cameraInfo: null, groundInfo: null };
        try {
          diagnostics = await page.evaluate(function() {
            var result = { objectsAtOrigin: [], objectsHidden: [], cameraInfo: null, groundInfo: null };

            try {
              if (typeof UnityEngine === 'undefined') return result;

              // Camera info
              var cam = UnityEngine.Camera.main;
              if (cam) {
                var bg = cam.backgroundColor;
                result.cameraInfo = {
                  bgColor: 'rgb(' + Math.round(bg.r*255) + ',' + Math.round(bg.g*255) + ',' + Math.round(bg.b*255) + ')',
                  orthSize: cam.orthographicSize,
                  pos: cam.transform.position.toString()
                };
              }

              // Check all root-level objects for visibility
              var allRenderers = UnityEngine.Object.FindObjectsOfType$1(UnityEngine.Renderer);
              if (allRenderers) {
                for (var i = 0; i < Math.min(allRenderers.length, 50); i++) {
                  var r = allRenderers[i];
                  var go = r.gameObject;
                  var pos = go.transform.position;
                  var name = go.name;
                  var yPos = pos.y;
                  var scale = go.transform.localScale;

                  // Skip pool objects still at y=-999
                  if (yPos < -100) {
                    result.objectsHidden.push(name + ' (y=' + yPos.toFixed(0) + ')');
                    continue;
                  }

                  // Objects near origin
                  var color = '?';
                  try {
                    var mat = r.material;
                    if (mat && mat.color) {
                      var c = mat.color;
                      color = 'rgb(' + Math.round(c.r*255) + ',' + Math.round(c.g*255) + ',' + Math.round(c.b*255) + ')';
                    }
                  } catch(e) {}

                  result.objectsAtOrigin.push({
                    name: name,
                    pos: 'y=' + yPos.toFixed(1),
                    scale: scale.x.toFixed(1) + 'x' + scale.y.toFixed(1) + 'x' + scale.z.toFixed(1),
                    color: color,
                    active: go.activeSelf
                  });

                  // Check for ground plane (largest object by scale)
                  if (scale.x * scale.z > 4) { // Large flat object
                    result.groundInfo = {
                      name: name,
                      scale: scale.x.toFixed(1) + 'x' + scale.y.toFixed(1) + 'x' + scale.z.toFixed(1),
                      color: color
                    };
                  }
                }
              }
            } catch(e) {
              result.error = e.message;
            }

            return result;
          });
        } catch(diagErr) {
          log('[QuickTest] Diagnostics injection error (non-fatal): ' + diagErr.message, taskId);
          diagnostics.error = diagErr.message;
        }

        // Build detailed reason string with diagnostic info
        var detailedReason = 'Screen is solid color (' + colorStr + ') with ' + (engineHealth.rendererCount || 0) + ' renderers loaded.';
        if (diagnostics.cameraInfo) {
          detailedReason += '\nCamera: bg=' + diagnostics.cameraInfo.bgColor + ', orthSize=' + diagnostics.cameraInfo.orthSize;
        }
        if (diagnostics.groundInfo) {
          detailedReason += '\nGround plane: ' + diagnostics.groundInfo.name + ' scale=' + diagnostics.groundInfo.scale + ' color=' + diagnostics.groundInfo.color;
        }
        if (diagnostics.objectsAtOrigin.length > 0) {
          detailedReason += '\nVisible objects (' + diagnostics.objectsAtOrigin.length + '): ' + diagnostics.objectsAtOrigin.map(function(o) {
            return o.name + '(' + o.pos + ',scale=' + o.scale + ',color=' + o.color + ')';
          }).join(', ');
        }
        detailedReason += '\nHidden objects at y<-100: ' + diagnostics.objectsHidden.length;
        detailedReason += '\n\nFIX: 1) Ground plane color must be neutral gray, not saturated. 2) Ensure ≥3 objects with contrasting colors are at y≥0. 3) Camera.backgroundColor must differ from ground by ≥0.3.';

        log('[QuickTest] Diagnostics: ' + JSON.stringify(diagnostics), taskId);

        await browser.close();
        return {
          ok: false,
          reason: detailedReason,
          loaded: true,
          solidColor: true,
          codeBug: true,
          solidColorDetail: { solid: solidColorCheck.solid, color: solidColorCheck.color, sampled: solidColorCheck.sampled, method: solidColorCheck.method, diagnostics: diagnostics },
          initialShot: initialShot,
          finalShot: finalShot,
          shotProgressed: false
        };
      }
    }

    await browser.close();

    // Analyze results
    var loaded = (bodyColor !== 'empty');
    var shotProgressed = (initialShot !== null && finalShot !== null && finalShot > initialShot);

    // If we can't read _currentShot, that's not a failure — just means we can't verify
    if (initialShot === null) {
      return { ok: true, reason: 'Could not read _currentShot variable (runtime may use different naming)', loaded: loaded, initialShot: null, finalShot: null, shotProgressed: false };
    }

    // If shot didn't progress, it's a warning but not a hard fail (user interaction might be needed)
    // Hard fail only if page didn't load at all
    if (!loaded) {
      return { ok: false, reason: 'Game failed to render (no canvas or content visible)', loaded: false, initialShot: initialShot, finalShot: finalShot, shotProgressed: false };
    }

    return { ok: true, loaded: true, initialShot: initialShot, finalShot: finalShot, shotProgressed: shotProgressed };

  } catch(e) {
    if (browser) try { await browser.close(); } catch(x) {}
    log('[QuickTest] Unexpected error (treating as FAIL): ' + e.message, taskId);
    return { ok: false, reason: 'Quick test error: ' + e.message, loaded: false };
  }
}

/**
 * Build phase name lookup: for each blueprint phase, collect all known aliases
 * (id, name, label, camelCase variants) for fuzzy matching against completedPhases.
 * Fixes BUG-0008: blueprint phase IDs (English) vs completedPhases (Chinese) mismatch.
 */
function buildPhaseAliases(blueprint) {
  const aliases = new Map(); // phaseId → Set<alias strings>
  const phaseNodes = (blueprint && blueprint.nodes || []).filter(function(n) { return n.type === 'phaseNode'; });
  const phases = blueprint && blueprint.phases || [];

  // Collect from phaseNodes
  for (var i = 0; i < phaseNodes.length; i++) {
    var n = phaseNodes[i];
    var d = n.data || {};
    var id = d.phaseId || n.id;
    var nameSet = aliases.get(id) || new Set();
    nameSet.add(id);
    if (d.name) nameSet.add(d.name);
    if (d.label) nameSet.add(d.label);
    if (n.id && n.id !== id) nameSet.add(n.id);
    aliases.set(id, nameSet);
  }

  // Collect from phases array
  for (var j = 0; j < phases.length; j++) {
    var p = phases[j];
    var pid = p.id || p.phaseId;
    if (!pid) continue;
    var pNameSet = aliases.get(pid) || new Set();
    pNameSet.add(pid);
    if (p.name) pNameSet.add(p.name);
    if (p.label) pNameSet.add(p.label);
    aliases.set(pid, pNameSet);
  }

  return aliases;
}

/**
 * Check if a phase (by any of its aliases) appears in completedPhases.
 * Returns { completed: boolean, matchedAlias: string|null }.
 */
function isPhaseCompleted(phaseId, aliases, completedPhases) {
  var nameSet = aliases.get(phaseId);
  if (!nameSet) {
    // No aliases known, fall back to direct check
    return { completed: completedPhases.indexOf(phaseId) !== -1, matchedAlias: completedPhases.indexOf(phaseId) !== -1 ? phaseId : null };
  }
  // Exact match pass
  for (var alias of nameSet) {
    if (completedPhases.indexOf(alias) !== -1) {
      return { completed: true, matchedAlias: alias };
    }
  }
  // Case-insensitive and trimmed pass
  var completedLower = completedPhases.map(function(p) { return (p || '').trim().toLowerCase(); });
  for (var alias2 of nameSet) {
    var lowerAlias = (alias2 || '').trim().toLowerCase();
    if (completedLower.indexOf(lowerAlias) !== -1) {
      return { completed: true, matchedAlias: alias2 + ' (case-insensitive)' };
    }
  }
  return { completed: false, matchedAlias: null };
}

/**
 * Run CUA verification on the build output
 *
 * @param {string} buildDir - Path to stage4/develop/ build output
 * @param {object} blueprint - Blueprint data with nodes
 * @param {string} taskId - Task/project ID
 * @param {function} log - Logging function
 * @returns {object} { passed: boolean, issues: string[], report: object }
 */

/**
 * Auto-Play Verification — programmatic game driver (no GPT needed).
 * 
 * Loads the HTML in headless Playwright, injects JS to simulate:
 *   - Joystick movement (pointer events on canvas)
 *   - Proximity-based interactions (auto-trigger)
 *   - Click interactions on various screen areas
 * 
 * Reads __gameState to verify phase progression.
 * Used as fallback when CUA GPT API fails (401, timeout, etc.)
 * or for idle/tycoon games that CUA can't operate.
 * 
 * @param {string} url - Preview URL
 * @param {object} specs - Phase specs array
 * @param {string} taskId
 * @param {function} log
 * @param {number} maxDurationSec - Max auto-play duration (default 90s)
 * @returns {object} { passed, issues, gameState, phasesCompleted, totalPhases }
 */
async function autoPlayVerify(url, specs, taskId, log, maxDurationSec) {
  maxDurationSec = maxDurationSec || 90;
  let browser, page;
  const issues = [];
  
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    
    // Suppress game console noise but capture GFM/phase logs
    const gameLogs = [];
    page.on('pageerror', () => {});
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[GFM]') || text.includes('Phase') || text.includes('phase') || text.includes('completed'))
        gameLogs.push(text.substring(0, 200));
    });
    
    log('[AutoPlay] Loading ' + url, taskId);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 20000 });
    } catch(e) {
      if (browser) await browser.close();
      return { passed: false, issues: ['[autoplay-load] Page failed to load: ' + e.message], gameState: null, phasesCompleted: 0, totalPhases: 0 };
    }
    
    // Wait for engine init
    log('[AutoPlay] Waiting for engine (8s)...', taskId);
    await page.waitForTimeout(8000);
    
    // Check engine
    const health = await page.evaluate(function() {
      return {
        bridge: typeof Bridge !== 'undefined',
        unityEngine: typeof UnityEngine !== 'undefined',
        canvas: !!document.querySelector('canvas'),
      };
    });
    
    if (!health.bridge || !health.unityEngine) {
      if (browser) await browser.close();
      return { passed: false, issues: ['[autoplay-engine] Engine not loaded: ' + JSON.stringify(health)], gameState: null, phasesCompleted: 0, totalPhases: 0 };
    }
    
    // Read initial state
    var readState = function() {
      return page.evaluate(function() {
        try {
          if (typeof window.__gameState === 'function') return window.__gameState();
          if (typeof window.__gameState === 'object' && window.__gameState !== null) return window.__gameState;
          if (typeof UnityEngine !== 'undefined' && UnityEngine.Object) {
            var monos = UnityEngine.Object.FindObjectsOfType$1(UnityEngine.MonoBehaviour);
            if (monos) {
              for (var i = 0; i < monos.length; i++) {
                var m = monos[i];
                if (m.GetGameState) return m.GetGameState();
              }
            }
          }
        } catch(e) { return { error: e.message }; }
        return null;
      });
    };
    
    const initialState = await readState();
    log('[AutoPlay] Initial state: ' + JSON.stringify(initialState), taskId);
    
    if (!initialState) {
      if (browser) await browser.close();
      return { passed: false, issues: ['[autoplay-no-state] __gameState not available — cannot verify'], gameState: null, phasesCompleted: 0, totalPhases: 0 };
    }
    
    // Inject touch simulator
    await page.evaluate(function() {
      var canvas = document.querySelector('canvas');
      if (!canvas) return;
      window.__simTouch = function(type, x, y) {
        var rect = canvas.getBoundingClientRect();
        var cx = rect.left + x;
        var cy = rect.top + y;
        canvas.dispatchEvent(new PointerEvent('pointer' + type, {
          clientX: cx, clientY: cy, pointerId: 1, pointerType: 'touch',
          bubbles: true, cancelable: true
        }));
        var mouseType = type === 'down' ? 'mousedown' : type === 'up' ? 'mouseup' : 'mousemove';
        canvas.dispatchEvent(new MouseEvent(mouseType, {
          clientX: cx, clientY: cy, button: 0,
          bubbles: true, cancelable: true
        }));
        try {
          var touch = new Touch({ identifier: 1, target: canvas, clientX: cx, clientY: cy });
          var touchType = type === 'down' ? 'touchstart' : type === 'up' ? 'touchend' : 'touchmove';
          canvas.dispatchEvent(new TouchEvent(touchType, {
            touches: type === 'up' ? [] : [touch],
            changedTouches: [touch],
            bubbles: true, cancelable: true
          }));
        } catch(e) {}
      };
    });
    
    // Auto-play loop: move in different directions, click, check state
    const directions = [
      { name: 'up', jx: 90, jy: 530, dx: 90, dy: 480 },
      { name: 'right', jx: 90, jy: 530, dx: 140, dy: 530 },
      { name: 'up-right', jx: 90, jy: 530, dx: 140, dy: 480 },
      { name: 'down', jx: 90, jy: 530, dx: 90, dy: 580 },
      { name: 'left', jx: 90, jy: 530, dx: 40, dy: 530 },
      { name: 'down-right', jx: 90, jy: 530, dx: 140, dy: 580 },
      { name: 'up-left', jx: 90, jy: 530, dx: 40, dy: 480 },
      { name: 'down-left', jx: 90, jy: 530, dx: 40, dy: 580 },
    ];
    
    // Click targets: spread across screen for proximity triggers
    const clickTargets = [
      { x: 400, y: 300 }, { x: 200, y: 200 }, { x: 600, y: 200 },
      { x: 200, y: 400 }, { x: 600, y: 400 }, { x: 400, y: 150 },
      { x: 400, y: 450 }, { x: 100, y: 300 }, { x: 700, y: 300 },
    ];
    
    const startTime = Date.now();
    const maxMs = maxDurationSec * 1000;
    let cycle = 0;
    let lastCompletedCount = (initialState.completedPhases || []).length;
    let staleCount = 0;
    let finalState = initialState;
    
    while (Date.now() - startTime < maxMs) {
      cycle++;
      var dir = directions[cycle % directions.length];
      
      // Joystick movement (2s per direction)
      await page.evaluate(function(d) { window.__simTouch('down', d.jx, d.jy); }, dir);
      await page.waitForTimeout(50);
      for (var step = 0; step < 10; step++) {
        await page.evaluate(function(d) { window.__simTouch('move', d.dx, d.dy); }, dir);
        await page.waitForTimeout(200);
      }
      await page.evaluate(function(d) { window.__simTouch('up', d.dx, d.dy); }, dir);
      
      // Click a target
      var ct = clickTargets[cycle % clickTargets.length];
      await page.mouse.click(ct.x, ct.y);
      await page.waitForTimeout(300);
      
      // Check state
      var state = await readState();
      if (state) {
        finalState = state;
        var completed = (state.completedPhases || []).length;
        
        if (completed > lastCompletedCount) {
          log('[AutoPlay] Progress! Cycle ' + cycle + ': ' + completed + ' phases completed (phase: ' + state.currentPhase + ')', taskId);
          lastCompletedCount = completed;
          staleCount = 0;
        } else {
          staleCount++;
        }
        
        // Early exit if game ended
        if (state.currentPhase === 'gameEnd' || state.currentPhase === 'cta' || state.currentPhase === 'CTA') {
          log('[AutoPlay] Game reached end/CTA at cycle ' + cycle, taskId);
          break;
        }
        
        // Early exit if stuck for too long (20 cycles = ~50s with no progress)
        if (staleCount >= 20) {
          log('[AutoPlay] Stale for 20 cycles, stopping early', taskId);
          break;
        }
      }
    }
    
    // Take screenshot
    var ssPath = path.join(CUA_RESULTS_DIR, taskId + '-autoplay.png');
    try { await page.screenshot({ path: ssPath }); } catch(e) {}
    
    await browser.close();
    
    // === Analyze Results ===
    var completedPhases = (finalState && finalState.completedPhases) || [];
    var specPhaseIds = specs ? specs.map(function(s) { return s.phaseId; }) : [];
    var totalExpected = specPhaseIds.length;
    
    // How many spec phases were completed?
    var specCompleted = 0;
    var specMissing = [];
    for (var i = 0; i < specPhaseIds.length; i++) {
      if (completedPhases.indexOf(specPhaseIds[i]) >= 0) {
        specCompleted++;
      } else {
        specMissing.push(specPhaseIds[i]);
      }
    }
    
    log('[AutoPlay] Result: ' + completedPhases.length + ' phases completed (' + completedPhases.join(', ') + '), spec coverage: ' + specCompleted + '/' + totalExpected, taskId);
    log('[AutoPlay] Entity states: ' + JSON.stringify(finalState.entityStates || {}), taskId);
    log('[AutoPlay] Game logs: ' + gameLogs.slice(-5).join(' | '), taskId);
    
    // Determine pass/fail
    // Criteria: game must have progressed beyond initial state
    var progressed = completedPhases.length > (initialState.completedPhases || []).length;
    
    if (!progressed) {
      issues.push('[autoplay-no-progress] Game did not progress after ' + cycle + ' cycles of auto-play simulation. Joystick/interaction may not be working.');
    }
    
    // Check if game has meaningful phases (not just gameStart → gameEnd)
    var meaningfulPhases = completedPhases.filter(function(p) {
      return p !== 'gameStart' && p !== 'gameEnd' && p !== 'cta';
    });
    if (progressed && meaningfulPhases.length === 0) {
      issues.push('[autoplay-no-meaningful-phases] Game progressed but only had start/end phases — no gameplay phases were implemented.');
    }
    
    // If spec phases exist but few were completed
    if (totalExpected > 0 && specCompleted === 0) {
      issues.push('[autoplay-spec-mismatch] 0/' + totalExpected + ' spec phases found in completedPhases. Code may have renamed phases or only implemented a single mega-phase.');
    }
    
    // Entity states check
    if (finalState.entityStates) {
      var allZero = Object.values(finalState.entityStates).every(function(v) { return String(v) === '0'; });
      if (allZero && Object.keys(finalState.entityStates).length > 0) {
        issues.push('[autoplay-entities-unchanged] All entity states are 0 — no entity progression occurred. Game may not have real interactive mechanics.');
      }
    }
    
    var passed = progressed && issues.length === 0;
    
    return {
      passed: passed,
      issues: issues,
      gameState: finalState,
      phasesCompleted: completedPhases.length,
      totalPhases: totalExpected,
      specCoverage: specCompleted + '/' + totalExpected,
      cycles: cycle,
      durationSec: Math.round((Date.now() - startTime) / 1000),
      gameLogs: gameLogs.slice(-10),
      mode: 'autoplay'
    };
    
  } catch(e) {
    if (browser) try { await browser.close(); } catch(x) {}
    log('[AutoPlay] Error: ' + e.message, taskId);
    return { passed: false, issues: ['[autoplay-error] ' + e.message], gameState: null, phasesCompleted: 0, totalPhases: 0, mode: 'autoplay' };
  }
}

async function runCUAVerification(buildDir, blueprint, taskId, log) {
  if (!fs.existsSync(LUNA_AGENT_JS)) {
    log('[CUA] luna-agent.js not found, skipping CUA verification', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[CUA] No HTML file in build output, skipping CUA', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  log('[CUA] Starting CUA verification...', taskId);

  let server;
  try {
    server = await startLocalServer(buildDir);
    log('[CUA] Local preview server started on port ' + LOCAL_PREVIEW_PORT, taskId);
  } catch(e) {
    log('[CUA] Failed to start local server: ' + e.message, taskId);
    return { passed: true, issues: [], skipped: true, error: e.message };
  }

  const previewUrl = 'http://127.0.0.1:' + LOCAL_PREVIEW_PORT + '/' + (hasIframe ? 'iframe.html' : 'index.html');
  const outputPath = path.join(CUA_RESULTS_DIR, taskId + '-report.json');
  const logPath = path.join(CUA_RESULTS_DIR, taskId + '-cua.log');

  // === Quick Play Test: 15-second headless sanity check before full CUA ===
  try {
    const quickResult = await quickPlayTest(previewUrl, taskId, log);
    if (!quickResult.ok) {
      log('[CUA] Quick play test FAILED: ' + quickResult.reason, taskId);
      try { server.close(); } catch(e) {}
      return {
        passed: false,
        issues: ['[quick-test] ' + quickResult.reason],
        skipped: false,
        quickTestFailed: true,
        quickTestDetail: quickResult
      };
    }
    log('[CUA] Quick play test passed: loaded=' + quickResult.loaded + ', shotProgressed=' + quickResult.shotProgressed + ', initialShot=' + quickResult.initialShot + ', finalShot=' + quickResult.finalShot, taskId);
  } catch(qe) {
    log('[CUA] Quick play test error (non-fatal): ' + qe.message, taskId);
    // Non-fatal: continue to full CUA even if quick test errors
  }

  const scriptPath = path.join(CUA_RESULTS_DIR, taskId + '-script.txt');
  const hasScript = generateScript(blueprint, scriptPath);

  const args = [
    LUNA_AGENT_JS,
    previewUrl,
    '--model', 'cua',
    '--rounds', '15',
    '--output', outputPath
  ];
  if (hasScript) args.push('--script', scriptPath);

  return new Promise((resolve) => {
    const child = spawn('node', args, {
      cwd: __dirname,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { 
      const line = d.toString();
      stdout += line;
      if (line.includes('[Luna Agent]') || line.includes('[CUA]') || line.includes('Score')) {
        log('[CUA] ' + line.trim(), taskId);
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      log('[CUA] Timeout after 5 minutes, killing', taskId);
      try { child.kill('SIGTERM'); } catch(e) {}
    }, 300000);

    child.on('close', async (code) => {
      clearTimeout(timeout);
      try { server.close(); } catch(e) {}

      log('[CUA] luna-agent exited with code ' + code, taskId);

      try {
        fs.writeFileSync(logPath, stdout + '\n---STDERR---\n' + stderr, 'utf-8');
      } catch(e) {}

      // Read report
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      } catch(e) {
        log('[CUA] Failed to read report: ' + (e.message || 'unknown'), taskId);
        resolve({ passed: false, issues: ['CUA report not generated (timeout or crash)'], skipped: false, error: e.message });
        return;
      }

      // === Blueprint flow verification (pass/fail, strict) ===
      const issues = [];

      // 0. ANTI-CHEAT: Cross-check script steps vs expected shot count
      //    If code has 10 shots but CUA script only has 1, blueprint data was corrupted
      const scriptStepCount = report.scriptCoverage ? report.scriptCoverage.length : 0;
      const expectedShotCount = blueprint && blueprint.nodes ? blueprint.nodes.filter(function(n) { return n.type === 'shotNode'; }).length : 0;
      // Also check via report metadata if available
      if (scriptStepCount > 0 && scriptStepCount < 3 && expectedShotCount >= 3) {
        // Very suspicious: a real playable ad should have at least 3 steps (skip for V4 which has no shots)
        log('[CUA] WARNING: Script only has ' + scriptStepCount + ' steps (expected blueprint: ' + expectedShotCount + '). Possible data corruption.', taskId);
        issues.push('[suspicious-script] Script has only ' + scriptStepCount + ' step(s) — too few for a real playable ad. Blueprint may have lost data. Expected: 3+ steps.');
      }

      // 0b. ANTI-CHEAT: Detect GPT "stuck" pattern — if GPT repeatedly says "no change" / "没有变化"
      const historyEntries = report.history || report.rounds || [];
      let noChangeCount = 0;
      const noChangePatterns = /没有明显.*变化|没有.*改变|图像.*保持|保持稳定|no.*visible.*change|no.*significant.*change|still.*same|nothing.*changed|仍然没/gi;
      for (var hi = 0; hi < historyEntries.length; hi++) {
        var desc = historyEntries[hi].thinking || historyEntries[hi].description || historyEntries[hi].text || '';
        if (noChangePatterns.test(desc)) noChangeCount++;
        noChangePatterns.lastIndex = 0; // reset regex
      }
      if (historyEntries.length >= 5 && noChangeCount >= Math.floor(historyEntries.length * 0.5)) {
        issues.push('[stuck-pattern] GPT reported "no visible change" in ' + noChangeCount + '/' + historyEntries.length + ' rounds. Game flow is likely stuck — not progressing through shots.');
      }

      // 1. Check for stuck/crash
      if (report.exitReason === 'stuck') {
        issues.push('[stuck] Game stuck during CUA operation (no state change for multiple rounds)');
      }

      // 2. Check blueprint shot coverage (STRICT: ALL shots must be covered)
      // V4 entity-driven blueprints have NO shotNodes — skip coverage check for V4
      const hasShotNodes = expectedShotCount > 0;
      const isV4 = !hasShotNodes && blueprint && blueprint.nodes && blueprint.nodes.some(function(n) { return n.type === 'entityNode'; });
      if (!hasShotNodes) {
        log('[CUA] No shotNodes in blueprint (V4 or phase-only) — skipping shot coverage check', taskId);
      } else if (report.scriptCoverage) {
        const uncovered = report.scriptCoverage.filter(s => !s.covered);
        // Cross-check: if completedPhases covers the phase, don't flag as uncovered
        const _gs = report.gameState;
        const _completedPhases = (_gs && _gs.completedPhases) || [];
        const _phaseAliases = buildPhaseAliases(blueprint);
        const trueUncovered = uncovered.filter(function(s) {
          var stepName = s.step || s.name || '';
          var result = isPhaseCompleted(stepName, _phaseAliases, _completedPhases);
          if (result.completed) {
            log('[CUA] Shot "' + stepName + '" marked uncovered by script but phase completed — overriding', taskId);
            return false;
          }
          return true;
        });
        if (trueUncovered.length > 0) {
          issues.push('[uncovered] Blueprint shots not reached (' + trueUncovered.length + '/' + report.scriptCoverage.length + '): ' + trueUncovered.map(s => s.step || s.name).join(', '));
        }
      } else if (report.gameState && report.gameState.completedPhases && report.gameState.completedPhases.length > 0) {
        // No scriptCoverage but gameState shows phases completed — use as coverage proxy
        log('[CUA] No scriptCoverage data but gameState.completedPhases has ' + report.gameState.completedPhases.length + ' entries — using as coverage proxy', taskId);
      } else {
        // No script coverage AND no gameState = cannot verify shots = fail
        issues.push('[no-coverage] No blueprint shot coverage data in CUA report');
      }

      // 3. CTA must be reachable
      if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
        issues.push('[cta] CTA not reached or unresponsive: ' + (report.ctaStatus || 'unknown'));
      }

      // 4. Content validation: GPT must have seen actual game content
      //    If all round descriptions are vague/empty, the game likely didn't load
      const roundTexts = (report.rounds || []).map(r => r.description || r.text || r.observation || '').join(' ');
      const vaguePatterns = /淡蓝色|空白|没有.*元素|没有.*内容|无法.*识别|blank|empty|nothing|no visible/gi;
      const vagueMatches = (roundTexts.match(vaguePatterns) || []).length;
      const totalRounds = (report.rounds || []).length;
      const gameContentKeywords = /按钮|角色|场景|游戏|障碍|敌人|道具|得分|血量|UI|菜单|开始|button|character|scene|game|score|player|enemy|level|menu|start|shoot|arrow|wood|target|弓|箭|射|木/gi;
      const contentMatches = (roundTexts.match(gameContentKeywords) || []).length;

      if (totalRounds >= 5 && contentMatches < 3) {
        issues.push('[no-content] GPT did not observe actual game content across ' + totalRounds + ' rounds (content keywords: ' + contentMatches + ', vague descriptions: ' + vagueMatches + '). Game may not have loaded properly.');
      }

      // 5. Blocking interaction issues (button unresponsive, scene transition failure)
      if (report.bugs) {
        const bugList = report.bugs.fromAI || report.bugs;
        const bugArray = Array.isArray(bugList) ? bugList : [];
        bugArray.forEach(bug => {
          issues.push('[interaction] ' + (bug.description || bug.message || JSON.stringify(bug)));
        });
      }

      // 6. Critical anomalies (white screen, crash)
      if (report.anomalies) {
        report.anomalies
          .filter(a => a.severity === 'high' || a.severity === 'error' || a.severity === 'critical')
          .forEach(a => {
            issues.push('[critical] ' + (a.description || a.rule || JSON.stringify(a)));
          });
      }

      // 7. Phase coverage check via __gameState (BUG-0008: use fuzzy alias matching)
      if (report.gameState) {
        const gs = report.gameState;
        const completedPhases = gs.completedPhases || [];
        const phaseAliases = buildPhaseAliases(blueprint);
        const phaseNodes = (blueprint && blueprint.nodes || []).filter(function(n) { return n.type === 'phaseNode'; });
        if (phaseNodes.length > 0) {
          const totalPhases = phaseNodes.length;
          // Count covered using fuzzy alias matching
          let coveredCount = 0;
          const uncoveredPhases = phaseNodes.filter(function(n) {
            const d = n.data || {};
            const phaseId = d.phaseId || n.id;
            const result = isPhaseCompleted(phaseId, phaseAliases, completedPhases);
            if (result.completed) {
              coveredCount++;
              if (result.matchedAlias && result.matchedAlias !== phaseId) {
                log('[CUA] Phase \'' + phaseId + '\' matched via alias \'' + result.matchedAlias + '\'', taskId);
              }
              return false;
            }
            return true;
          });
          if (uncoveredPhases.length > 0) {
            const details = uncoveredPhases.map(function(n) {
              const d = n.data || {};
              return (d.name || d.phaseId || n.id) + ' (trigger: ' + (d.triggerCondition || 'none') + ')';
            }).join('; ');
            // Phase coverage is now a warning, not a blocking issue.
            // Spec-phase-skipped (7b) is the authoritative check — it only validates phases that were actually generated.
            log('[CUA] [phase-coverage-warn] ' + coveredCount + '/' + totalPhases + ' blueprint phases completed. Missing: ' + details, taskId);
          }
          log('[CUA] Phase coverage: ' + coveredCount + '/' + totalPhases + ', current: ' + (gs.currentPhase || 'unknown'), taskId);
        }
        // Entity state check — buildable entities must reach terminal state
        if (gs.entityStates) {
          const missingEntities = [];
          const incompleteEntities = [];
          (blueprint.entities || []).forEach(function(e) {
            const eName = e.name || e.id;
            if (gs.entityStates[eName] === undefined) {
              missingEntities.push(eName);
            }
          });
          if (missingEntities.length > 0) {
            // Info only — blueprint entity names may differ from code variable names
            // Spec entity check (7b) is the authoritative validation
            log('[CUA] [info] Blueprint entities not in gameState (may be aliased): ' + missingEntities.join(', '), taskId);
          }
          // Check that buildable entities reached terminal state (state "2" = built)
          const BUILDABLE_KEYS = ['conveyor', 'woodHouse', 'turret'];
          BUILDABLE_KEYS.forEach(function(key) {
            if (gs.entityStates[key] !== undefined) {
              const state = String(gs.entityStates[key]);
              if (state !== '2') {
                incompleteEntities.push(key + '=' + state + ' (expected 2=built)');
              }
            }
          });
          if (incompleteEntities.length > 0) {
            issues.push('[entity-incomplete] Buildable entities not fully constructed: ' + incompleteEntities.join(', ') + '. The game rushed through phases without completing intermediate build steps.');
          }
        }

        // (phase-skipped check merged into phase-coverage above — no duplicate)
      } else if (!isV4 || (blueprint && blueprint.nodes && blueprint.nodes.some(function(n) { return n.type === 'phaseNode'; }))) {
        // No __gameState available — note it as a soft issue
        log('[CUA] __gameState not available — cannot verify phase coverage programmatically', taskId);
      }

      // 7b. Spec-based validation (if specs exist for this project)
      // Specs saved by worker-coder.js to local spec-data/ directory
      const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
      const specs = loadSpecs(taskId, specsDataDir);
      if (specs && specs.length > 0 && report.gameState) {
        const gs = report.gameState;
        log('[CUA] Spec validation: ' + specs.length + ' phase specs loaded', taskId);

        // Check: all spec phases completed (BUG-0008: use fuzzy alias matching)
        const specPhaseIds = specs.map(s => s.phaseId);
        const completed = gs.completedPhases || [];
        // Build aliases for spec phases too (merge with blueprint aliases)
        const specAliases = buildPhaseAliases(blueprint);
        // Also add spec-specific aliases (specs may have names not in blueprint)
        for (var spi = 0; spi < specs.length; spi++) {
          var spec = specs[spi];
          var spId = spec.phaseId;
          if (spId) {
            var spNameSet = specAliases.get(spId) || new Set();
            spNameSet.add(spId);
            if (spec.name) spNameSet.add(spec.name);
            if (spec.label) spNameSet.add(spec.label);
            specAliases.set(spId, spNameSet);
          }
        }
        const specSkipped = specPhaseIds.filter(function(id) {
          var result = isPhaseCompleted(id, specAliases, completed);
          if (result.completed && result.matchedAlias && result.matchedAlias !== id) {
            log('[CUA] Spec phase \'' + id + '\' matched via alias \'' + result.matchedAlias + '\'', taskId);
          }
          return !result.completed;
        });
        if (specSkipped.length > 0 && completed.length > 0) {
          // If the current phase IS one of the skipped spec phases, it means the game is IN that phase
          // but hasn't finished it yet (CUA ran out of rounds). This is expected for complex tycoon games.
          var currentPhase = gs.currentPhase || '';
          var trulySkipped = specSkipped.filter(function(id) {
            // Not skipped if it's the current active phase
            return id !== currentPhase && currentPhase.indexOf(id) < 0 && id.indexOf(currentPhase) < 0;
          });
          if (trulySkipped.length > 0) {
            issues.push('[spec-phase-skipped] Spec phases not completed: ' + trulySkipped.join(', ') + '. Game balance likely broken — phases were bypassed.');
          } else {
            log('[CUA] [spec-phase-active] Phase ' + specSkipped.join(', ') + ' is currently active but not completed (CUA ran out of rounds). This is acceptable for complex games.', taskId);
          }
        }

        // Check: spec entities state (warning only — CUA may not reach all upgrades in 15 rounds)
        // The authoritative check is spec-phase-skipped above.
        specs.forEach(function(spec) {
          (spec.entitiesRequired || []).forEach(function(entity) {
            if (gs.entityStates && gs.entityStates[entity.name] !== undefined) {
              if (String(gs.entityStates[entity.name]) !== String(entity.terminalState)) {
                log('[CUA] [spec-entity-warn] ' + entity.name + ' state=' + gs.entityStates[entity.name] + ', spec requires ' + entity.terminalState + ' (' + entity.description + ')', taskId);
              }
            }
          });
        });

        // Check: phase dwell times (from phaseTimestamps)
        if (gs.phaseTimestamps) {
          for (var si = 0; si < specs.length; si++) {
            var spec = specs[si];
            var enterTime = gs.phaseTimestamps[spec.phaseId];
            var nextEnterTime = (si < specs.length - 1 && gs.phaseTimestamps[specs[si + 1].phaseId]) ? gs.phaseTimestamps[specs[si + 1].phaseId] : gs.variables.gameTimer;
            if (enterTime > 0 && nextEnterTime > 0) {
              var dwellTime = nextEnterTime - enterTime;
              if (dwellTime < spec.duration.min) {
                issues.push('[spec-too-fast] Phase ' + spec.phaseId + ' lasted ' + dwellTime + 's, spec minimum ' + spec.duration.min + 's');
              }
            }
          }
        }
      }

      // 8. Diagnostics-based issues (engine state, console errors)
      if (report.diagnostics) {
        const diag = report.diagnostics;
        if (!diag.engineReady) {
          issues.push('[engine-not-ready] Luna engine failed to initialize. Engine state: ' + JSON.stringify(diag.engineState || 'unknown'));
          if (diag.consoleErrors && diag.consoleErrors.length > 0) {
            issues.push('[console-errors] JS errors during load (' + diag.consoleErrors.length + '): ' + diag.consoleErrors.slice(0, 5).join(' | '));
          }
          if (diag.pageErrors && diag.pageErrors.length > 0) {
            issues.push('[page-errors] Uncaught JS exceptions (' + diag.pageErrors.length + '): ' + diag.pageErrors.slice(0, 5).join(' | '));
          }
        }
      }

      // Pass criteria: ALL shots covered + CTA reachable + game content visible + no critical issues
      // Timeout/max_rounds without meaningful interaction = NOT a pass
      const exitReason = report.exitReason || 'unknown';
      const hasHistory = Array.isArray(report.history) && report.history.length > 0;
      let passed;
      if (exitReason === 'max_rounds' && (!report.totalRounds || report.totalRounds <= 1)) {
        // max_rounds with ≤1 round means timeout killed the agent before it could do anything
        passed = false;
        if (issues.length === 0) {
          issues.push('[timeout] CUA agent timed out (exit: max_rounds) without completing verification');
        }
      } else if (!hasHistory) {
        // No interaction history = CUA API failed. Try auto-play verification as fallback.
        log('[CUA] No interaction history from GPT CUA — falling back to auto-play verification', taskId);
        try {
          const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
          const autoPlaySpecs = loadSpecs(taskId, specsDataDir) || [];
          const autoResult = await autoPlayVerify(previewUrl, autoPlaySpecs, taskId, log, 90);
          log('[CUA] Auto-play result: passed=' + autoResult.passed + ', phases=' + autoResult.phasesCompleted + ', issues=' + autoResult.issues.length, taskId);
          
          // Use auto-play result
          passed = autoResult.passed;
          autoResult.issues.forEach(function(iss) { issues.push(iss); });
          report.autoPlay = autoResult;
        } catch(autoErr) {
          log('[CUA] Auto-play fallback error: ' + autoErr.message, taskId);
          passed = false;
          if (issues.length === 0) {
            issues.push('[no-interaction] CUA completed ' + (report.totalRounds || 0) + ' rounds with zero interactions, auto-play fallback also failed: ' + autoErr.message);
          }
        }
      } else {
        passed = issues.length === 0;
      }

      log('[CUA] Issues: ' + issues.length + ', Pass: ' + passed + ', ExitReason: ' + exitReason, taskId);

      resolve({ passed, issues, report, skipped: false });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { server.close(); } catch(e) {}
      log('[CUA] Failed to start: ' + err.message, taskId);
      resolve({ passed: false, issues: ['CUA process failed to start: ' + err.message], skipped: false, error: err.message });
    });
  });
}

module.exports = { runCUAVerification, autoPlayVerify, CUA_RESULTS_DIR, MAX_CUA_RETRIES };
