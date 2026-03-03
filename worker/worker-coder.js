// Worker Coder v3 — AI coding agent with compile-fix-retry loop
// Uses Luna diagnostics JSON for accurate error extraction

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ Config ============
const API_BASE = 'https://crs.mindrix.app/api';
const API_KEY = process.env.LLM_API_KEY || 'cr_f891cb1046bf100addfc0bf027cb1b37fafa8cc214e1bdbbe5493e6fa3240e7c';
const MODEL_GENERATE = process.env.LLM_MODEL_GENERATE || 'claude-opus-4-20250514';
const MODEL_FIX = process.env.LLM_MODEL_FIX || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 32768; // 10 shots need more output tokens
const MAX_FIX_ATTEMPTS = 10;  // Keep retrying until fixed (practical upper bound)
const PIPELINE_DIR = process.env.LUNA_PIPELINE || 'D:\\Luna\\pipeline';
const COCOS_EXE = process.env.COCOS_CREATOR || 'D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe';

// ============ LLM Call ============

function callClaude(systemPrompt, userMessage, timeoutMs, model) {
  timeoutMs = timeoutMs || 300000; // 5 min for large blueprints
  model = model || MODEL_FIX;
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: model,
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
    var isV2 = !!(d.sceneObjects || d.triggerChain || d.params);
    var desc = '';

    if (isV2) {
      // V2 blueprint format — rich structured fields
      var parts = [];
      if (d.sceneObjects) parts.push('【场景对象】\n' + d.sceneObjects);
      if (d.inputType) parts.push('【输入方式】' + d.inputType + (d.inputConfig ? '\n' + d.inputConfig : ''));
      if (d.triggerChain) parts.push('【触发链（按顺序执行）】\n' + d.triggerChain);
      if (d.params) parts.push('【参数表】\n' + d.params);
      if (d.assets) parts.push('【资源清单】\n' + d.assets);
      if (d.entryCondition) parts.push('【进入条件】' + d.entryCondition);
      if (d.endCondition) parts.push('【结束条件】' + d.endCondition);
      if (d.referenceNote) parts.push('【参考说明】' + d.referenceNote);
      desc = parts.join('\n');
    } else if (d.description) {
      desc = d.description;
    } else if (d.scene) {
      // Legacy v1 format fallback
      var parts = [];
      if (d.scene) parts.push('【场景】' + d.scene);
      if (d.controlTarget) parts.push('【操控对象】' + d.controlTarget);
      if (d.controlMethod) parts.push('【操控方式】' + d.controlMethod);
      if (d.triggers) parts.push('【触发逻辑】' + d.triggers);
      if (d.behavior) parts.push('【数值/行为】' + d.behavior);
      if (d.entryCondition) parts.push('【进入条件】' + d.entryCondition);
      if (d.endCondition) parts.push('【结束条件】' + d.endCondition);
      desc = parts.join('\n');
    }
    return {
      id: node.id,
      label: d.label || d.name || d.title || ('Shot ' + (i + 1)),
      description: desc,
      interactions: d.interactions || []
    };
  });

  var transitions = edges.map(function(edge) {
    return { from: edge.source, to: edge.target, condition: (edge.data && edge.data.condition) || 'auto' };
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
  '- Application.OpenURL → use Luna.Unity.Playable.InstallFullGame() for CTA',
  '- public Inspector references (the scene file will NOT be modified — all references MUST be resolved in code)',
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
  '## CRITICAL ARCHITECTURE: Clean Scene + Code-Built World',
  '',
  '⚠️ Luna converts Unity C# to JavaScript. [RuntimeInitializeOnLoadMethod] is IGNORED by Luna.',
  '⚠️ Only scripts already attached to scene GameObjects via the Unity Editor will execute.',
  '⚠️ The SVN template scene contains UNRELATED objects from previous projects.',
  '⚠️ You MUST clear the template scene and BUILD THE ENTIRE GAME WORLD FROM CODE.',
  '',
  '### Strategy: CLEAN SCENE + BUILD FROM SCRATCH IN CODE',
  '',
  '#### Step 1: Clear the template scene (in Awake or Start, BEFORE anything else)',
  '```csharp',
  '// Hide ALL template objects except essential ones',
  'foreach (GameObject root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects())',
  '{',
  '    string name = root.name.ToLower();',
  '    // Keep: Main Camera, Directional Light, EventSystem, Canvas (if reusable), and the object running this script',
  '    if (name.Contains("camera") || name.Contains("light") || name.Contains("eventsystem"))',
  '        continue;',
  '    if (root == this.gameObject || root.transform == this.transform.root)',
  '        continue;',
  '    root.SetActive(false);',
  '}',
  '```',
  '',
  '#### Step 2: Set up the essential scene infrastructure',
  '- **Camera**: Reuse existing Main Camera or create one. Set position, rotation, FOV, background color per blueprint.',
  '- **Lighting**: Reuse existing Directional Light or create one. Set rotation, color, intensity.',
  '- **UI Canvas**: Create a new Canvas (Screen Space - Overlay) with CanvasScaler (Scale With Screen Size, 1080x1920 or as needed) + GraphicRaycaster.',
  '- **EventSystem**: If none exists, create one with StandaloneInputModule.',
  '',
  '#### Step 3: Build ALL game objects from code',
  '- 3D objects: `GameObject.CreatePrimitive(PrimitiveType.Cube/Sphere/Plane/etc.)` + set transform + material',
  '- UI elements: `new GameObject("ButtonName", typeof(RectTransform), typeof(Image), typeof(Button))` etc.',
  '- Text: `new GameObject("Label", typeof(RectTransform), typeof(UnityEngine.UI.Text))` — set font via `Resources.GetBuiltinResource<Font>("Arial.ttf")`',
  '- Parent objects: create empty `new GameObject("ShotContainer")` to group objects per shot',
  '- Materials: `new Material(Shader.Find("Universal Render Pipeline/Lit"))` — set color via `material.color = ...`',
  '- For complex shapes: compose from multiple primitives, or use scaled/rotated cubes',
  '',
  '#### Step 4: Implement blueprint logic on code-created objects',
  '- Attach scripts to created objects via `obj.AddComponent<T>()`',
  '- Wire up events (button clicks, collisions) in code',
  '- Shot transitions: SetActive(false) current shot container, SetActive(true) next shot container',
  '',
  '### Rules:',
  '- Identify the main controller script from the project context — REWRITE it completely (keep class name)',
  '- The rewritten main script is your ENTRY POINT — it runs Awake/Start because it is already in the scene',
  '- ALL scene content must be created in code from this entry point — do NOT rely on template scene objects',
  '- Do NOT assume any specific GameObjects exist in the scene (except Camera, Light, EventSystem)',
  '- Use `gameObject.AddComponent<T>()` for helper scripts',
  '- Color/style the objects to roughly match the blueprint theme (not just white primitives)',
  '',
  '### What to REWRITE:',
  '- The main game controller (PlayableAdController, GameManager, etc.) — keep class name, replace ALL logic',
  '- Any other scripts attached to the scene — rewrite to participate in the new code-built world',
  '',
  '### What to KEEP unchanged:',
  '- Utility scripts (MonoSingleton, math helpers, Luna lifecycle helpers)',
  '- Audio/mute handling scripts (LunaPlayableBootstrap etc.)',
  '- Class names of scripts attached to the scene (changing names = broken references)',
  '',
  '## CRITICAL: Implement EXACTLY what the blueprint describes',
  '',
  'The user has designed a playable ad with specific shots (scenes). Each shot has:',
  '- **Scene Objects**: What should appear on screen (characters, items, UI elements)',
  '- **Input Type + Config**: How the player interacts (tap, drag, joystick, etc.)',
  '- **Trigger Chain**: Step-by-step game logic — events, conditions, and actions IN ORDER',
  '- **Parameters**: Game values (speeds, scores, durations, etc.)',
  '- **Assets**: Required prefabs, textures, audio',
  '- **Entry/End Conditions**: When each shot starts and ends',
  '',
  'You MUST:',
  '1. Implement EVERY shot described in the blueprint, in the specified order',
  '2. The trigger chain is your primary guide — implement each step exactly as described',
  '3. Scene objects listed MUST appear on screen; objects NOT listed should be hidden/removed',
  '4. Use the exact input method specified (tap, drag, joystick, etc.)',
  '5. Apply all parameters from the params table (speeds, scores, timing, etc.)',
  '6. Shot transitions follow the edges/connections — implement them as scene flow',
  '7. Do NOT add gameplay that is not in the blueprint',
  '8. Do NOT keep template gameplay that contradicts the blueprint',
  '',
  '## Working with the existing SVN project',
  'The SVN project is a TEMPLATE with scripts already attached to scene GameObjects.',
  'You MUST:',
  '1. Read ALL existing scripts carefully — identify which ones are entry points (have Start/Awake)',
  '2. REWRITE the main controller script(s) to implement the blueprint — keep class names identical',
  '3. Create new helper scripts and attach them via AddComponent from the main script',
  '4. Use GameObject.CreatePrimitive() for new 3D objects the blueprint needs',
  '5. Reuse existing scene GameObjects where possible (find them by name)',
  '6. Do NOT create a Bootstrap with [RuntimeInitializeOnLoadMethod] — Luna ignores it',
  '',
  'NAMING: Do NOT create classes that conflict with existing ones.',
  '',
  'Output format: Each file as:',
  '```csharp:Assets/Scripts/FileName.cs',
  '// code',
  '```',
  '',
  'FIRST file MUST be the rewritten main controller (e.g., PlayableAdController.cs) — keep the original class name.',
  'Generate code that implements the blueprint faithfully. The final playable ad should match the storyboard exactly.'
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
  '- Do NOT use [RuntimeInitializeOnLoadMethod] — Luna ignores it',
  '- The main controller script (rewritten from template) is the entry point — keep its class name',
  '- The scene is CLEAN — all game objects are created from code, do NOT use GameObject.Find() for template objects',
  '- If a fix requires new scene objects, CREATE them in code (CreatePrimitive, new GameObject, etc.)',
  '- Do NOT reintroduce dependencies on template scene objects that were cleared',
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

// ============ Cocos System Prompts ============

var COCOS_GENERATE_PROMPT = [
  'You are a Cocos Creator 3.8.x TypeScript code generator for playable ads (HTML5 Web Mobile).',
  '',
  '## 踩坑经验（公司实战，必须遵守！）',
  '- 音频绝对不要用 .ogg 格式，必须用 .mp3。苹果手机黑屏大概率是 .ogg 导致',
  '- 打包不要勾选 MD5 缓存，可能导致打包失败',
  '- 打包 web-mobile 后压缩 zip 不要多套一层目录，否则渠道包黑屏',
  '- 打包后黑屏但调试模式正常 + JSON.parse undefined 报错 → 缓存没清干净，删 library/Build/temp 重新打包',
  '- 打包后出现进度条 → 游戏初始化时加 document.body.style.overflow = "hidden"',
  '',
  '## CRITICAL COCOS CREATOR CONSTRAINTS',
  '',
  '### DO NOT use:',
  '- Multi-threading (SharedArrayBuffer restricted in WebView)',
  '- VideoPlayer component (fails in many mobile WebViews)',
  '- localStorage (some WebViews block it)',
  '- cc.resources.load for assets not in resources/ folder',
  '- Dynamic creation of many nodes (use NodePool for pooling)',
  '- Heavy physics engines (Bullet/PhysX slow on Web, use Builtin or manual)',
  '- cc.find() for global lookups (use @property references or getChildByName)',
  '- Heavy computation in update() (use schedule() or events)',
  '- Accessing other components in onLoad (may not be initialized; use start())',
  '',
  '### MUST do:',
  '- Use TypeScript with @ccclass / @property decorators',
  '- Components extend Component (import from "cc")',
  '- import { _decorator, Component, Node, ... } from "cc"',
  '- const { ccclass, property } = _decorator',
  '- Use tween() for animations instead of manual interpolation',
  '- Use EventTarget for decoupled communication',
  '- iOS audio: play silent clip on first touch to unlock AudioContext',
  '- Implement mute/unmute callbacks (channel requirement)',
  '- CTA button: call channel SDK (e.g. mraid.open(url))',
  '- Total bundle < 5MB (AppLovin channel limit)',
  '- First screen < 3 seconds load',
  '- Scene transitions via director.loadScene() or node.active toggling',
  '- Clean up singletons on replay',
  '- Use compressed textures and sprite atlases to reduce DrawCall',
  '- Disable Mipmap on UI/static textures',
  '- MP3 audio format (best compatibility), max 30 seconds',
  '- Canvas: set Fit Width/Fit Height, anchor key UI with Widget',
  '- Use BlockInputEvents to prevent touch passthrough',
  '',
  '### Allowed:',
  '- Component, Node, Vec2, Vec3, Color, Quat, Mat4',
  '- UI: Button, Label, Sprite, Layout, Widget, Canvas, RichText',
  '- tween(), Tween',
  '- AudioSource, AudioClip',
  '- Collider, RigidBody (Builtin physics preferred)',
  '- Spine (match runtime version)',
  '- Scheduler (schedule/unschedule)',
  '- resources.load / assetManager',
  '- director.loadScene',
  '',
  '## Work with the existing project',
  'Read and understand the existing codebase. Follow same patterns and architecture.',
  'Extend/modify existing scripts rather than creating from scratch.',
  'Reuse existing utility classes, managers, helpers.',
  '',
  'Output format: Each file as:',
  '```typescript:assets/scripts/FileName.ts',
  '// code',
  '```',
  '',
  'Generate code that integrates naturally with the existing project.'
].join('\n');

var COCOS_FIX_PROMPT = [
  'You are fixing Cocos Creator 3.8.x TypeScript compilation errors for a playable ad.',
  '',
  '## Key constraints:',
  '- Must use @ccclass decorator on all component classes',
  '- @property decorator for serialized fields',
  '- Import from "cc": import { _decorator, Component, Node } from "cc"',
  '- const { ccclass, property } = _decorator',
  '- Do NOT use cc.find() — use @property references',
  '- Do NOT access uninitialized components in onLoad — use start()',
  '- Check null before accessing optional references',
  '',
  'Fix ALL errors. If same errors recur, try a different approach.',
  '',
  'Output corrected files as:',
  '```typescript:assets/scripts/FileName.ts',
  '// fixed code',
  '```',
  'Only include files that need changes.'
].join('\n');

// ============ Compile + Diagnostics ============

function tryCompileCocos(projectDir, log, taskId) {
  var buildDir = path.join(projectDir, 'build', 'web-mobile');
  try { if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
  try {
    execSync('"' + COCOS_EXE + '" --project "' + projectDir + '" --build "platform=web-mobile;debug=false"', { timeout: 180000, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
    log('[coder] Cocos build passed!', taskId);
    return { ok: true };
  } catch(e) {
    if (fs.existsSync(path.join(buildDir, 'index.html'))) {
      log('[coder] Cocos build exit non-zero but output exists, treating as pass', taskId);
      return { ok: true };
    }
    var output = ((e.stdout||'') + '\n' + (e.stderr||'')).trim();
    var errors = output.split('\n').filter(function(l) { return /error TS\d+/i.test(l); });
    if (errors.length === 0) errors = output.split('\n').filter(function(l) { return /error/i.test(l) && !/warning|asset|SIGTERM|Exit process with code:null/i.test(l); });
    log('[coder] Cocos build failed: ' + errors.length + ' errors', taskId);
    return { ok: false, errors: errors.length > 0 ? errors : ['Build failed: ' + output.slice(-500)] };
  }
}

function tryCompileUnity(clientDir, log, taskId) {
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

async function generateCode(blueprint, clientDir, log, taskId, engine) {
  log = log || console.log;
  engine = engine || 'unity';
  var isCocos = engine === 'cocos';

  var parsed = parseBlueprintToPrompt(blueprint);
  if (!parsed) {
    log('[coder] Empty blueprint, skipping', taskId);
    return { ok: true, skipped: true, message: 'Empty blueprint' };
  }

  log('[coder] Generating ' + engine + ' code for: ' + parsed.scenes.length + ' scenes', taskId);

  // Clean up previously generated scripts to avoid conflicts
  if (!isCocos) {
    var scriptsDir = path.join(clientDir, 'Assets', 'Scripts');
    var dirsToClean = ['WoodArchery', 'Playable', 'FinalPlayable', 'NewPlayable', 'Generated', 'BlueprintGame'];
    dirsToClean.forEach(function(d) {
      var dirPath = path.join(scriptsDir, d);
      if (fs.existsSync(dirPath)) {
        log('[coder] Cleaning previous AI-generated dir: ' + d, taskId);
        try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch(e) { log('[coder] Clean failed: ' + e.message, taskId); }
      }
    });
    // Also clean any PlayableBootstrap.cs in root Scripts dir
    var bootstrapFile = path.join(scriptsDir, 'PlayableBootstrap.cs');
    if (fs.existsSync(bootstrapFile)) { try { fs.unlinkSync(bootstrapFile); } catch(e) {} }
    var lunaBuildFix = path.join(scriptsDir, 'LunaBuildFix.cs');
    if (fs.existsSync(lunaBuildFix)) { try { fs.unlinkSync(lunaBuildFix); } catch(e) {} }
    log('[coder] Cleanup done', taskId);
  }

  // Select prompts and helpers based on engine
  var sysPrompt = isCocos ? COCOS_GENERATE_PROMPT : GENERATE_PROMPT;
  var fixPrompt = isCocos ? COCOS_FIX_PROMPT : FIX_PROMPT;
  var tryCompile = isCocos ? tryCompileCocos : tryCompileUnity;
  var parseBlocks = isCocos ? parseCodeBlocksCocos : parseCodeBlocks;
  var readScripts = isCocos ? readCurrentScriptsCocos : readCurrentScripts;
  var readCtx = isCocos ? readProjectContextCocos : readProjectContext;
  var listClasses = isCocos ? listExistingClassesCocos : listExistingClasses;
  var lang = isCocos ? 'Cocos Creator TypeScript' : 'Unity C#';

  // Read existing project context
  var projectCtx = readCtx(clientDir);
  log('[coder] Project context: ' + (projectCtx.fileList ? projectCtx.fileList.split('\n').length : 0) + ' files scanned', taskId);

  var existingClasses = listClasses(clientDir);
  var classWarning = '';
  if (existingClasses.length > 0) {
    classWarning = '\n\n## EXISTING CLASS NAMES (do NOT reuse these):\n' + existingClasses.join(', ');
  }

  var projectSection = '';
  if (projectCtx.fileList) {
    projectSection = '\n\n## EXISTING PROJECT FILE STRUCTURE:\n```\n' + projectCtx.fileList + '\n```';
  }
  if (projectCtx.context) {
    projectSection += '\n\n## EXISTING TEMPLATE CODE (reference ONLY — do NOT copy patterns, do NOT reuse scene-dependent logic):\n'
      + '⚠️ This template code is from the SVN base project. It references scene objects that will be HIDDEN.\n'
      + '⚠️ Only use this to understand: class names to keep, utility functions to reuse, Luna lifecycle hooks.\n'
      + '⚠️ Do NOT copy game logic, scene references, or object lookups from this code.\n\n'
      + projectCtx.context;
  }

  // Build structured scene descriptions for AI
  var scenesMarkdown = parsed.scenes.map(function(s, i) {
    var lines = ['### Shot ' + (i + 1) + ': ' + s.label];
    if (s.description) lines.push(s.description);
    return lines.join('\n');
  }).join('\n\n');

  var transMarkdown = parsed.transitions.map(function(t) {
    return '- ' + t.from + ' → ' + t.to + ' (condition: ' + t.condition + ')';
  }).join('\n');

  var userMsg = '## Project: ' + parsed.projectName + '\n\n'
    + '## Blueprint Shots (implement ALL of these IN ORDER):\n\n' + scenesMarkdown + '\n\n'
    + '## Shot Transitions (scene flow):\n' + transMarkdown
    + classWarning
    + projectSection
    + parsed.feedbackText
    + '\n\n## IMPORTANT REMINDERS:\n'
    + '1. CLEAR the template scene first (SetActive(false) on all root objects except Camera/Light/EventSystem)\n'
    + '2. BUILD everything from code — CreatePrimitive, new GameObject, UI components\n'
    + '3. Do NOT use GameObject.Find() to locate template objects — they are all disabled\n'
    + '4. Do NOT copy game logic from the template code — it is for a DIFFERENT game\n'
    + '5. The template code is ONLY useful for: class names to preserve, utility functions, Luna lifecycle hooks\n\n'
    + 'Generate ' + lang + ' scripts that implement this blueprint EXACTLY from scratch. '
    + 'Every shot must be playable with code-created objects. '
    + 'The final game should match the storyboard — no template content should be visible.';

  try {
    var response = await callClaude(sysPrompt, userMsg, 300000, MODEL_GENERATE);
    log('[coder] Generated (' + (response.usage ? response.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

    var files = parseBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks' };
    writeFiles(clientDir, files, log, taskId);

    var prevErrorSig = '';
    var sameErrorCount = 0;
    for (var attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      var result = tryCompile(clientDir, log, taskId);
      
      if (result.ok) {
        log('[coder] ✅ Build passed on attempt ' + attempt, taskId);
        return { ok: true, filesWritten: files.length, files: files.map(function(f) { return f.path; }), attempts: attempt };
      }

      var errorSig = result.errors.sort().join('|');
      if (errorSig === prevErrorSig) { sameErrorCount++; } else { sameErrorCount = 0; prevErrorSig = errorSig; }

      if (sameErrorCount >= 3) {
        log('[coder] ⚠️ Same errors repeated 3 times, regenerating from scratch...', taskId);
        var regenMsg = userMsg + '\n\n## IMPORTANT: Previous code had persistent compilation errors:\n```\n'
          + result.errors.join('\n') + '\n```\nGenerate completely different code that avoids these issues.';
        var regenResp = await callClaude(sysPrompt, regenMsg, 300000, MODEL_GENERATE);
        var regenFiles = parseBlocks(regenResp.text);
        if (regenFiles.length > 0) { writeFiles(clientDir, regenFiles, log, taskId); files = regenFiles; }
        sameErrorCount = 0; prevErrorSig = ''; continue;
      }

      log('[coder] Fix attempt ' + attempt + '/' + MAX_FIX_ATTEMPTS + ': ' + result.errors.length + ' errors', taskId);

      var currentCode = readScripts(clientDir);
      var fixProjectCtx = projectCtx.fileList ? '\n\n## Existing project files (for reference):\n```\n' + projectCtx.fileList + '\n```' : '';
      var fixMsg = '## Build Errors:\n```\n' + result.errors.join('\n') + '\n```\n\n'
        + '## Current Scripts:\n' + currentCode
        + fixProjectCtx
        + '\n\nFix ALL errors above. This is attempt ' + attempt + '. If previous fixes did not work, try a fundamentally different approach.';

      var fixResp = await callClaude(fixPrompt, fixMsg);
      log('[coder] Fix response (' + (fixResp.usage ? fixResp.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

      var fixed = parseBlocks(fixResp.text);
      if (fixed.length > 0) { writeFiles(clientDir, fixed, log, taskId); files = fixed; }
      else { log('[coder] Warning: No fix blocks, retrying...', taskId); }
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

// Read existing project code as context for LLM (SLG template project)
function readProjectContext(clientDir) {
  var MAX_CONTEXT_CHARS = 30000; // Limit to avoid token overflow
  var parts = [];
  var totalChars = 0;

  // Priority: Assets/Program (main game logic) > Assets/Scripts > Assets/Plugins
  var scanDirs = ['Assets/Program', 'Assets/Scripts', 'Assets/Plugins'];
  
  // First pass: collect file list with sizes
  var allFiles = [];
  for (var d = 0; d < scanDirs.length; d++) {
    var full = path.join(clientDir, scanDirs[d]);
    if (fs.existsSync(full)) {
      var csFiles = listCsFiles(full);
      for (var i = 0; i < csFiles.length; i++) {
        try {
          var stat = fs.statSync(csFiles[i]);
          var rel = path.relative(clientDir, csFiles[i]).replace(/\\/g, '/');
          allFiles.push({ path: csFiles[i], rel: rel, size: stat.size, dir: scanDirs[d] });
        } catch (e) {}
      }
    }
  }

  if (allFiles.length === 0) return { context: '', fileList: '' };

  // Build file tree overview (always include)
  var fileList = allFiles.map(function(f) { return f.rel + ' (' + Math.round(f.size / 1024) + 'KB)'; }).join('\n');

  // Include key files in full (prioritize smaller, more important files)
  // Sort: Program dir first, then by size ascending
  allFiles.sort(function(a, b) {
    if (a.dir !== b.dir) return a.dir === 'Assets/Program' ? -1 : 1;
    return a.size - b.size;
  });

  for (var i = 0; i < allFiles.length; i++) {
    if (totalChars >= MAX_CONTEXT_CHARS) break;
    if (allFiles[i].size > 8000) continue; // Skip very large files
    try {
      var content = fs.readFileSync(allFiles[i].path, 'utf-8');
      if (totalChars + content.length > MAX_CONTEXT_CHARS) continue;
      parts.push('```csharp:' + allFiles[i].rel + '\n' + content + '\n```');
      totalChars += content.length;
    } catch (e) {}
  }

  return { context: parts.join('\n\n'), fileList: fileList };
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

// ============ Cocos Helpers ============

function parseCodeBlocksCocos(text) {
  var files = [];
  var regex = /```(?:typescript|ts)[:\s]+([^\n`]+\.ts)\s*\n([\s\S]*?)```/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    var fp = match[1].trim();
    if (!fp.startsWith('assets/')) fp = 'assets/scripts/' + path.basename(fp);
    files.push({ path: fp, content: match[2].trim() + '\n' });
  }
  if (files.length === 0) {
    var fb = /```(?:typescript|ts)\s*\n([\s\S]*?)```/g;
    var idx = 0;
    while ((match = fb.exec(text)) !== null) {
      var code = match[1].trim() + '\n';
      var cm = code.match(/class\s+(\w+)/);
      files.push({ path: 'assets/scripts/' + (cm ? cm[1] : 'Script' + idx) + '.ts', content: code });
      idx++;
    }
  }
  return files;
}

function listExistingClassesCocos(projectDir) {
  var classes = [];
  var dirs = ['assets/scripts', 'assets/Script', 'assets/src'];
  for (var d = 0; d < dirs.length; d++) {
    var full = path.join(projectDir, dirs[d]);
    if (fs.existsSync(full)) {
      var tsFiles = listTsFiles(full);
      for (var i = 0; i < tsFiles.length; i++) {
        try {
          var content = fs.readFileSync(tsFiles[i], 'utf-8');
          var matches = content.match(/class\s+(\w+)/g);
          if (matches) for (var j = 0; j < matches.length; j++) classes.push(matches[j].replace('class ', ''));
        } catch(e) {}
      }
    }
  }
  return classes;
}

function readProjectContextCocos(projectDir) {
  var MAX = 30000, parts = [], total = 0;
  var scanDirs = ['assets/scripts', 'assets/Script', 'assets/src'];
  var allFiles = [];
  for (var d = 0; d < scanDirs.length; d++) {
    var full = path.join(projectDir, scanDirs[d]);
    if (fs.existsSync(full)) {
      var tsFiles = listTsFiles(full);
      for (var i = 0; i < tsFiles.length; i++) {
        try { var stat = fs.statSync(tsFiles[i]); allFiles.push({ path: tsFiles[i], rel: path.relative(projectDir, tsFiles[i]).replace(/\\/g,'/'), size: stat.size }); } catch(e) {}
      }
    }
  }
  if (allFiles.length === 0) return { context: '', fileList: '' };
  var fileList = allFiles.map(function(f) { return f.rel + ' (' + Math.round(f.size/1024) + 'KB)'; }).join('\n');
  allFiles.sort(function(a,b) { return a.size - b.size; });
  for (var i = 0; i < allFiles.length; i++) {
    if (total >= MAX || allFiles[i].size > 8000) continue;
    try { var c = fs.readFileSync(allFiles[i].path, 'utf-8'); if (total + c.length > MAX) continue; parts.push('```typescript:' + allFiles[i].rel + '\n' + c + '\n```'); total += c.length; } catch(e) {}
  }
  return { context: parts.join('\n\n'), fileList: fileList };
}

function readCurrentScriptsCocos(projectDir) {
  var scriptsDir = path.join(projectDir, 'assets', 'scripts');
  if (!fs.existsSync(scriptsDir)) return '(no scripts)';
  var files = listTsFiles(scriptsDir), parts = [];
  for (var i = 0; i < files.length; i++) {
    parts.push('```typescript:' + path.relative(projectDir, files[i]).replace(/\\/g,'/') + '\n' + fs.readFileSync(files[i], 'utf-8') + '\n```');
  }
  return parts.join('\n\n') || '(no scripts)';
}

function listTsFiles(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) results = results.concat(listTsFiles(fp));
      else if (entries[i].name.endsWith('.ts') && !entries[i].name.endsWith('.d.ts')) results.push(fp);
    }
  } catch(e) {}
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
