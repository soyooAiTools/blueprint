// Worker Coder v3 — AI coding agent with compile-fix-retry loop
// Uses Luna diagnostics JSON for accurate error extraction

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ Config ============
const API_BASE = 'https://crs.mindrix.app/api';
const API_KEY = process.env.LLM_API_KEY || 'cr_f891cb1046bf100addfc0bf027cb1b37fafa8cc214e1bdbbe5493e6fa3240e7c';
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 16384;
const MAX_FIX_ATTEMPTS = 10;  // Keep retrying until fixed (practical upper bound)
const PIPELINE_DIR = process.env.LUNA_PIPELINE || 'D:\\Luna\\pipeline';

// ============ LLM Call ============

function callClaude(systemPrompt, userMessage, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    var url = new URL(API_BASE + '/v1/messages');
    var opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
      rejectUnauthorized: false,
      timeout: timeoutMs
    };

    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var data = Buffer.concat(chunks).toString('utf-8');
        try {
          var parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error('API: ' + (parsed.error.message || JSON.stringify(parsed.error))));
          var text = '';
          if (parsed.content) for (var i = 0; i < parsed.content.length; i++) {
            if (parsed.content[i].type === 'text') text += parsed.content[i].text;
          }
          resolve({ text: text, usage: parsed.usage, model: parsed.model });
        } catch (e) { reject(new Error('Parse: ' + data.slice(0, 500))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
    req.end();
  });
}

// ============ Blueprint → Prompt ============

function parseBlueprintToPrompt(blueprint) {
  var nodes = blueprint.nodes || [];
  var edges = blueprint.edges || [];
  if (nodes.length === 0) return null;

  var scenes = nodes.map(function(node, i) {
    var d = node.data || {};
    return {
      id: node.id,
      label: d.label || d.title || ('Scene ' + (i + 1)),
      description: d.description || '',
      interactions: d.interactions || []
    };
  });

  var transitions = edges.map(function(edge) {
    return { from: edge.source, to: edge.target, condition: (edge.data && edge.data.condition) || 'click' };
  });

  var feedbackText = '';
  if (blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0) {
    var latest = blueprint.feedbackHistory[blueprint.feedbackHistory.length - 1];
    feedbackText = '\n\n## Previous Feedback (MUST address):\n' + JSON.stringify(latest.data || latest, null, 2);
  }

  return { projectName: blueprint.projectName || 'Playable Ad', scenes: scenes, transitions: transitions, feedbackText: feedbackText };
}

// ============ System Prompts ============

var GENERATE_PROMPT = [
  'You are a Unity C# code generator for playable ads built with Luna SDK (HTML5 export).',
  'Luna converts Unity C# to JavaScript for web — many Unity features are NOT supported.',
  '',
  '## CRITICAL LUNA CONSTRAINTS',
  '',
  '### Absolutely DO NOT use:',
  '- TileMap, New InputSystem, Terrain (use mesh-based terrain instead)',
  '- Generics (Luna does NOT support generic syntax)',
  '- C# 7.0+ syntax (no tuples, pattern matching, local functions, etc.)',
  '- Multi-threading (web does not support threads)',
  '- SceneManager (scene transitions = SetActive on parent GameObjects)',
  '- Resources.Load, AssetBundle, async/await, Task, LINQ',
  '- Animation component (use Animator instead)',
  '- AnimationCurve loop modes (must manually handle time wrapping)',
  '- Custom RenderTexture',
  '- Baked shadows (Luna does NOT support baked shadows)',
  '- CharacterController (use Transform.Translate or Rigidbody instead)',
  '- SendMessage()',
  '- Vector3Int (not supported in web; cast to Vector3)',
  '- System.Math (use UnityEngine.Mathf instead)',
  '- String.Format, Regex (memory leak prone in Luna)',
  '- Multi-dimensional arrays (use 1D or jagged arrays, 10x perf difference)',
  '- GameObject.Find (use singleton pattern or pre-registered references)',
  '- Application.OpenURL → use Luna.Unity.Playable.InstallFullGame() for CTA',
  '',
  '### MUST do:',
  '- Call Luna.Unity.LifeCycle.GameEnded() when game ends (before CTA)',
  '- Use Animator for all animations, NEVER Animation component',
  '- Animator state machine: do NOT connect states to Exit node (causes animation bugs in Luna)',
  '- Animation frame events: avoid placing on first or last frame (often fails to trigger)',
  '- Do NOT call Animator.Play() continuously — it will replay frame 1 forever',
  '- Button click events: assign directly in inspector style (add listener in Awake/Start), do NOT use dynamic assignment (may need double-click on mobile)',
  '- For DOTween chain calls, write each method on a new line (avoids JS transpilation bugs):',
  '    transform.DOMove(target, 1f)',
  '      .OnUpdate(() => { ... })',
  '      .OnComplete(() => { ... });',
  '- For coroutines with bool params, do NOT use object type — use typed parameter directly',
  '- When using GetComponent<Transform>() vs GetComponent<RectTransform>(), they are NOT interchangeable',
  '',
  '### Audio rules:',
  '- Audio files max 30 seconds (longer causes initial stuttering)',
  '- Minimize empty frames in audio, especially at start (causes perceived delay)',
  '- Do NOT call AudioSource.Stop() or check AudioSource state before it has played once (Google channel error)',
  '- iOS AppLovin: initial touch audio requires pre-playing a silent clip in Awake/Start',
  '- Mute handling (required for channel testing):',
  '    Luna.Unity.LifeCycle.OnUnmute += () => { AudioListener.volume = 1; };',
  '    Luna.Unity.LifeCycle.OnMute += () => { AudioListener.volume = 0; };',
  '',
  '### Allowed:',
  '- MonoBehaviour, Transform, GameObject, SetActive',
  '- UnityEngine.UI (Button, Text, Image, Canvas, RectTransform, Graphic Raycaster)',
  '- Coroutines (IEnumerator/yield), Input, Time, Mathf, Vector2/3, Color',
  '- DOTween (supported plugin)',
  '- TextMeshPro (supported but do NOT import TMP Samples — contains unsupported code)',
  '- Spine (if needed)',
  '',
  '### Physics notes:',
  '- Physics layer masks may malfunction — use tag comparison as fallback',
  '- Avoid physics for animation effects — use DOTween instead',
  '- For kinematic rigidbody: use MovePosition; for non-kinematic: use velocity or AddForce',
  '- 3D colliders required for mouse click events (OnMouseDown etc.) — 2D colliders will NOT work',
  '- OnTriggerEnter/Exit can miss detections — use continuous checking (OnTriggerStay) as backup',
  '- Prefer BoxCollider/SphereCollider over MeshCollider for performance',
  '',
  '### UI notes:',
  '- EventTrigger drag: dragged object MUST be the one with EventTrigger/interface, not another object',
  '- UI layer ordering: add Graphic Raycaster; if sorting layer ineffective, check shader render queue',
  '- Sprite-based number display may not refresh — workaround: duplicate sprite set with alpha=0 as backup',
  '',
  'NAMING: Do NOT name any class "GameManager" — the project already has one.',
  'Use unique names like "PlayableAdController" or "AdFlowManager".',
  '',
  'Output format: Each file as:',
  '```csharp:Assets/Scripts/FileName.cs',
  '// code',
  '```',
  '',
  'Generate: one controller script + one script per scene. Keep it minimal and robust.'
].join('\n');

var FIX_PROMPT = [
  'You are fixing Unity C# compilation errors for a Luna SDK playable ad project.',
  'Luna transpiles C# to JavaScript — many Unity features cause compilation failures.',
  '',
  '## Key Luna constraints to remember when fixing:',
  '- NO generics (Luna does not support generic syntax)',
  '- NO C# 7.0+ syntax (tuples, pattern matching, local functions, etc.)',
  '- NO Vector3Int (cast to Vector3)',
  '- NO System.Math (use UnityEngine.Mathf)',
  '- NO Animation component (use Animator)',
  '- NO SendMessage, no multi-threading, no LINQ',
  '- NO SceneManager, Resources.Load, async/await',
  '- NO CharacterController (use Transform or Rigidbody)',
  '- GetComponent<Transform>() and GetComponent<RectTransform>() are NOT interchangeable',
  '- DOTween chain calls must be on separate lines to avoid JS transpilation bugs',
  '- Use Luna.Unity.Playable.InstallFullGame() instead of Application.OpenURL',
  '- Must call Luna.Unity.LifeCycle.GameEnded() when game ends',
  '- Do NOT use class name "GameManager" (already exists in project)',
  '',
  'Analyze each error carefully. Fix ALL errors. If the same error keeps recurring,',
  'try a completely different approach rather than repeating the same fix.',
  '',
  'Output corrected files as:',
  '```csharp:Assets/Scripts/FileName.cs',
  '// fixed code',
  '```',
  'Only include files that need changes.'
].join('\n');

// ============ Compile + Diagnostics ============

function tryCompile(clientDir, log, taskId) {
  // Clean LunaTemp
  var lunaTemp = path.join(clientDir, 'LunaTemp');
  if (fs.existsSync(lunaTemp)) {
    try { fs.rmSync(lunaTemp, { recursive: true, force: true }); } catch (e) {}
  }

  var cmd = 'node --max-old-space-size=8192 jake.js -f Jakefile.js --quiet project:build';
  try {
    execSync(cmd, {
      cwd: PIPELINE_DIR,
      timeout: 180000,
      encoding: 'utf-8',
      env: Object.assign({}, process.env, { PROJECT_PATH: clientDir }),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    log('[coder] Build passed!', taskId);
    return { ok: true };
  } catch (e) {
    // Read diagnostics JSON for actual errors
    var errors = extractDiagnosticErrors(clientDir);
    log('[coder] Build failed: ' + errors.length + ' fatal errors', taskId);
    return { ok: false, errors: errors };
  }
}

function extractDiagnosticErrors(clientDir) {
  var lunaTemp = path.join(clientDir, 'LunaTemp');
  if (!fs.existsSync(lunaTemp)) return ['Build failed (no LunaTemp)'];

  // Find diagnostics-*.json
  var files = fs.readdirSync(lunaTemp).filter(function(f) { return f.startsWith('diagnostics-') && f.endsWith('.json'); });
  if (files.length === 0) return ['Build failed (no diagnostics file)'];

  try {
    var diag = JSON.parse(fs.readFileSync(path.join(lunaTemp, files[0]), 'utf-8'));
    var errors = [];
    for (var i = 0; i < (diag.Logs || []).length; i++) {
      var log = diag.Logs[i];
      // Severity 1 = fatal error
      if (log.Severity === 1 || (log.ErrorCode && log.ErrorCode.startsWith('CS'))) {
        var msg = log.ErrorCode + ': ' + log.Description;
        if (log.FilePath) {
          // Make path relative
          var rel = log.FilePath.replace(/.*[\\\/]Assets[\\\/]/, 'Assets/').replace(/\\/g, '/');
          msg += ' (file: ' + rel + ', line: ' + (log.LinePosition || '?') + ')';
        }
        if (log.Details && log.Details.length > 0) msg += ' | ' + log.Details[0];
        errors.push(msg);
      }
    }
    return errors.length > 0 ? errors : ['Build failed with unknown error (check Luna diagnostics)'];
  } catch (e) {
    return ['Failed to parse diagnostics: ' + e.message];
  }
}

// ============ Main: Generate + Compile-Fix Loop ============

async function generateCode(blueprint, clientDir, log, taskId) {
  log = log || console.log;

  var parsed = parseBlueprintToPrompt(blueprint);
  if (!parsed) {
    log('[coder] Empty blueprint, skipping', taskId);
    return { ok: true, skipped: true, message: 'Empty blueprint' };
  }

  log('[coder] Generating code for: ' + parsed.scenes.length + ' scenes', taskId);

  // List existing project classes to avoid naming conflicts
  var existingClasses = listExistingClasses(clientDir);
  var classWarning = '';
  if (existingClasses.length > 0) {
    classWarning = '\n\n## EXISTING CLASS NAMES (do NOT reuse these):\n' + existingClasses.join(', ');
  }

  var userMsg = '## Project: ' + parsed.projectName + '\n\n'
    + '## Scenes:\n' + JSON.stringify(parsed.scenes, null, 2) + '\n\n'
    + '## Transitions:\n' + JSON.stringify(parsed.transitions, null, 2)
    + classWarning
    + parsed.feedbackText
    + '\n\nGenerate Unity C# scripts for this playable ad.';

  try {
    // === Step 1: Generate ===
    var response = await callClaude(GENERATE_PROMPT, userMsg);
    log('[coder] Generated (' + (response.usage ? response.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

    var files = parseCodeBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks' };
    writeFiles(clientDir, files, log, taskId);

    // === Step 2: Build + Fix Loop (keep trying until fixed) ===
    var prevErrorSig = '';
    var sameErrorCount = 0;
    for (var attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      var result = tryCompile(clientDir, log, taskId);
      
      if (result.ok) {
        log('[coder] ✅ Build passed on attempt ' + attempt, taskId);
        return { ok: true, filesWritten: files.length, files: files.map(function(f) { return f.path; }), attempts: attempt };
      }

      // Detect stuck loop: if same errors repeat 3 times, regenerate from scratch
      var errorSig = result.errors.sort().join('|');
      if (errorSig === prevErrorSig) {
        sameErrorCount++;
      } else {
        sameErrorCount = 0;
        prevErrorSig = errorSig;
      }

      if (sameErrorCount >= 3) {
        log('[coder] ⚠️ Same errors repeated 3 times, regenerating from scratch...', taskId);
        // Full regeneration with error context
        var regenMsg = userMsg + '\n\n## IMPORTANT: Previous code had persistent compilation errors:\n```\n'
          + result.errors.join('\n') + '\n```\nGenerate completely different code that avoids these issues.';
        var regenResp = await callClaude(GENERATE_PROMPT, regenMsg);
        var regenFiles = parseCodeBlocks(regenResp.text);
        if (regenFiles.length > 0) {
          writeFiles(clientDir, regenFiles, log, taskId);
          files = regenFiles;
        }
        sameErrorCount = 0;
        prevErrorSig = '';
        continue;
      }

      log('[coder] Fix attempt ' + attempt + '/' + MAX_FIX_ATTEMPTS + ': ' + result.errors.length + ' errors', taskId);

      // Build fix prompt with current code + errors
      var currentCode = readCurrentScripts(clientDir);
      var fixMsg = '## Build Errors:\n```\n' + result.errors.join('\n') + '\n```\n\n'
        + '## Current Scripts (Assets/Scripts/ only):\n' + currentCode
        + '\n\nFix ALL errors above. This is attempt ' + attempt + '. If previous fixes did not work, try a fundamentally different approach.';

      var fixResp = await callClaude(FIX_PROMPT, fixMsg);
      log('[coder] Fix response (' + (fixResp.usage ? fixResp.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

      var fixed = parseCodeBlocks(fixResp.text);
      if (fixed.length > 0) {
        writeFiles(clientDir, fixed, log, taskId);
        files = fixed;
      } else {
        log('[coder] Warning: No fix blocks, retrying...', taskId);
      }
    }

    log('[coder] ❌ Exhausted ' + MAX_FIX_ATTEMPTS + ' attempts', taskId);
    return { ok: false, error: 'Build failed after ' + MAX_FIX_ATTEMPTS + ' attempts:\n' + (result ? result.errors.join('\n') : 'unknown') };
  } catch (e) {
    log('[coder] Error: ' + e.message, taskId);
    return { ok: false, error: e.message };
  }
}

// ============ Helpers ============

function writeFiles(clientDir, files, log, taskId) {
  for (var i = 0; i < files.length; i++) {
    var fullPath = path.join(clientDir, files[i].path);
    var dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, files[i].content, 'utf-8');
    log('[coder] Written: ' + files[i].path, taskId);
  }
}

function parseCodeBlocks(text) {
  var files = [];
  var regex = /```(?:csharp|cs)[:\s]+([^\n`]+\.cs)\s*\n([\s\S]*?)```/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    var fp = match[1].trim();
    if (!fp.startsWith('Assets/')) fp = 'Assets/Scripts/' + path.basename(fp);
    files.push({ path: fp, content: match[2].trim() + '\n' });
  }
  if (files.length === 0) {
    var fb = /```(?:csharp|cs)\s*\n([\s\S]*?)```/g;
    var idx = 0;
    while ((match = fb.exec(text)) !== null) {
      var code = match[1].trim() + '\n';
      var cm = code.match(/class\s+(\w+)/);
      files.push({ path: 'Assets/Scripts/' + (cm ? cm[1] : 'Script' + idx) + '.cs', content: code });
      idx++;
    }
  }
  return files;
}

function listExistingClasses(clientDir) {
  var classes = [];
  var dirs = ['Assets/Program', 'Assets/Plugins', 'Assets/TutorialInfo'];
  for (var d = 0; d < dirs.length; d++) {
    var full = path.join(clientDir, dirs[d]);
    if (fs.existsSync(full)) {
      var csFiles = listCsFiles(full);
      for (var i = 0; i < csFiles.length; i++) {
        try {
          var content = fs.readFileSync(csFiles[i], 'utf-8');
          var matches = content.match(/class\s+(\w+)/g);
          if (matches) {
            for (var j = 0; j < matches.length; j++) {
              classes.push(matches[j].replace('class ', ''));
            }
          }
        } catch (e) {}
      }
    }
  }
  return classes;
}

function readCurrentScripts(clientDir) {
  var scriptsDir = path.join(clientDir, 'Assets', 'Scripts');
  if (!fs.existsSync(scriptsDir)) return '(no scripts)';
  var files = listCsFiles(scriptsDir);
  var parts = [];
  for (var i = 0; i < files.length; i++) {
    var content = fs.readFileSync(files[i], 'utf-8');
    var rel = path.relative(clientDir, files[i]).replace(/\\/g, '/');
    parts.push('```csharp:' + rel + '\n' + content + '\n```');
  }
  return parts.join('\n\n') || '(no scripts)';
}

function listCsFiles(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory() && entries[i].name !== 'Editor') results = results.concat(listCsFiles(fp));
      else if (entries[i].name.endsWith('.cs')) results.push(fp);
    }
  } catch (e) {}
  return results;
}

module.exports = { generateCode, callClaude, parseBlueprintToPrompt };

if (require.main === module) {
  (async function() {
    var bp = process.argv[2];
    var dir = process.argv[3] || 'D:\\work\\test-luna\\Client';
    if (!bp) {
      console.log('Usage: node worker-coder.js <blueprint.json> [clientDir]');
      console.log('Testing LLM...');
      try { var r = await callClaude('Test', 'Say "ready"'); console.log('OK:', r.text); }
      catch (e) { console.error('Error:', e.message); }
      return;
    }
    var blueprint = JSON.parse(fs.readFileSync(bp, 'utf-8'));
    var result = await generateCode(blueprint, dir, console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
  })();
}
