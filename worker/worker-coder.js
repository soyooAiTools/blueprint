// Worker Coder v3 — AI coding agent with compile-fix-retry loop
// Uses Luna diagnostics JSON for accurate error extraction

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ Helpers ============
function listCsFiles(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) results = results.concat(listCsFiles(fp));
      else if (entries[i].name.endsWith('.cs')) results.push(fp);
    }
  } catch(e) {}
  return results;
}

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
  '## CRITICAL ARCHITECTURE: Rewrite Template Scripts (they are the ONLY entry points)',
  '',
  '⚠️ Luna converts Unity C# to JavaScript. [RuntimeInitializeOnLoadMethod] is IGNORED by Luna.',
  '⚠️ ONLY scripts in Assets/Program/Script/ are attached to scene GameObjects and will execute.',
  '⚠️ Scripts you create in Assets/Scripts/ will NEVER run unless AddComponent from a Program script.',
  '⚠️ The template is a SLG/idle game — you must COMPLETELY REPLACE the game logic.',
  '',
  '### Strategy: REWRITE the template entry-point scripts + create helpers',
  '',
  '#### The template project structure:',
  '- `Assets/Program/Script/Manager/StateManager.cs` — main game state machine (REWRITE THIS FIRST)',
  '- `Assets/Program/Script/Manager/LunaManager.cs` — Luna lifecycle (keep Luna calls, replace game logic)',
  '- `Assets/Program/Script/Manager/UIManager.cs` — UI management (REWRITE for blueprint UI)',
  '- `Assets/Program/Script/Controllers/Player.cs` — player controller (REWRITE for blueprint player)',
  '- `Assets/Program/Script/Controllers/Boss.cs` — boss controller (REWRITE or empty out)',
  '- `Assets/Program/Script/Controllers/Npc.cs` — NPC controller (REWRITE or empty out)',
  '- `Assets/Program/Script/Manager/CameraManager.cs` — camera (REWRITE for blueprint camera)',
  '- `Assets/Program/Script/UI/MainPanel.cs` — main UI panel (REWRITE)',
  '- `Assets/Program/Script/UI/TouchArea.cs` — touch input (REWRITE for blueprint input)',
  '- `Assets/Program/Script/UI/YangJoystick.cs` — virtual joystick (REWRITE if blueprint uses joystick)',
  '- `Assets/Program/Script/Utilities/MonoSingleton.cs` — utility (KEEP as-is)',
  '',
  '#### Step 1: REWRITE StateManager.cs as your main game controller',
  '- Keep the class name `StateManager` (it is attached to the scene)',
  '- Delete ALL template game logic inside it',
  '- In Start(): hide all template scene objects, then create your blueprint world from code',
  '```csharp',
  '// In StateManager.Start() — first thing:',
  'foreach (GameObject root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects())',
  '{',
  '    string n = root.name.ToLower();',
  '    if (n.Contains("camera") || n.Contains("light") || n.Contains("eventsystem") || n.Contains("statemanager") || n.Contains("manager"))',
  '        continue;',
  '    root.SetActive(false);',
  '}',
  '// Then create your game world from code...',
  '```',
  '',
  '#### Step 2: Create game objects from code in StateManager.Start()',
  '- 3D objects: `GameObject.CreatePrimitive(PrimitiveType.Cube/Sphere/Plane/etc.)`',
  '- UI: `new GameObject("Button", typeof(RectTransform), typeof(Image), typeof(Button))`',
  '- Text: `new GameObject("Label", typeof(RectTransform), typeof(UnityEngine.UI.Text))`',
  '- Materials: `new Material(Shader.Find("Universal Render Pipeline/Lit"))` with colors',
  '- Camera: find existing Main Camera, reposition for your game',
  '- Create Canvas with CanvasScaler (1080x1920) + GraphicRaycaster',
  '',
  '#### Step 3: Implement shots as state machine in StateManager',
  '- Each shot = a method that creates/shows the right objects and hides the previous shot',
  '- Use SetActive to toggle shot containers',
  '- Shot transitions triggered by gameplay events',
  '',
  '#### Step 4: REWRITE other Program scripts to support your game',
  '- Player.cs → implement blueprint player behavior',
  '- UIManager.cs → implement blueprint UI',
  '- Other controllers → implement or empty out (keep class names!)',
  '',
  '### Rules:',
  '- You MUST output files with paths starting with `Assets/Program/Script/` for scripts attached to scene',
  '- Keep ALL class names in Assets/Program/ identical (changing = broken scene references)',
  '- Helper scripts go in `Assets/Scripts/` and are attached via `AddComponent` from StateManager',
  '- Do NOT create Bootstrap scripts with [RuntimeInitializeOnLoadMethod] — Luna ignores them',
  '- Do NOT rely on template GameObjects by name — hide everything and create from code',
  '',
  '### What to REWRITE (keep class names, replace ALL logic):',
  '- `Assets/Program/Script/Manager/StateManager.cs` — your main entry point',
  '- `Assets/Program/Script/Manager/UIManager.cs`',
  '- `Assets/Program/Script/Controllers/Player.cs`',
  '- `Assets/Program/Script/Controllers/Boss.cs`',
  '- `Assets/Program/Script/Controllers/Npc.cs`',
  '- `Assets/Program/Script/Manager/CameraManager.cs`',
  '- `Assets/Program/Script/UI/MainPanel.cs`',
  '- `Assets/Program/Script/UI/TouchArea.cs`',
  '',
  '### What to KEEP unchanged:',
  '- `Assets/Program/Script/Utilities/MonoSingleton.cs` and other utility base classes',
  '- `Assets/Program/Script/Utilities/Event/*` — event system',
  '- Class names of ALL scripts in Assets/Program/ (even if you empty the body)',
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

  // Clean up ALL previously generated scripts in Assets/Scripts to avoid conflicts
  if (!isCocos) {
    var scriptsDir = path.join(clientDir, 'Assets', 'Scripts');
    if (fs.existsSync(scriptsDir)) {
      // Delete EVERYTHING in Assets/Scripts — all AI-generated residue
      var allScriptFiles = listCsFiles(scriptsDir);
      var deleted = 0;
      allScriptFiles.forEach(function(f) {
        try { fs.unlinkSync(f); deleted++; } catch(e) {}
      });
      // Also remove empty subdirectories
      function rmEmptyDirs(dir) {
        try {
          var entries = fs.readdirSync(dir, { withFileTypes: true });
          entries.forEach(function(e) { if (e.isDirectory()) rmEmptyDirs(path.join(dir, e.name)); });
          if (fs.readdirSync(dir).length === 0 && dir !== scriptsDir) fs.rmdirSync(dir);
        } catch(e) {}
      }
      rmEmptyDirs(scriptsDir);
      if (deleted > 0) log('[coder] Cleaned ' + deleted + ' old scripts from Assets/Scripts', taskId);
    }
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
    projectSection += '\n\n## TEMPLATE SCRIPTS IN Assets/Program/ (these are ATTACHED to scene — you MUST REWRITE them):\n'
      + '⚠️ These scripts are the ONLY ones that execute (attached to scene GameObjects).\n'
      + '⚠️ You MUST rewrite them with blueprint logic. Keep class names, replace ALL content.\n'
      + '⚠️ Key entry point: StateManager.cs — rewrite Start() to hide template objects and build your game.\n\n'
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
    // Accept both Assets/Program/ and Assets/Scripts/ paths as-is
    if (!fp.startsWith('Assets/')) fp = 'Assets/Scripts/' + path.basename(fp);
    files.push({ path: fp, content: match[2].trim() + '\n' });
  }
  if (files.length === 0) {
    var fb = /```(?:csharp|cs)\s*\n([\s\S]*?)```/g;
    var idx = 0;
    while ((match = fb.exec(text)) !== null) {
      var code = match[1].trim() + '\n';
      var cm = code.match(/class\s+(\w+)/);
      // Check if the class matches a known Program script
      var knownProgram = ['StateManager','Player','Boss','Npc','UIManager','CameraManager','LunaManager','MainPanel','TouchArea','YangJoystick'];
      var className = cm ? cm[1] : 'Script' + idx;
      var targetPath = 'Assets/Scripts/' + className + '.cs';
      if (knownProgram.indexOf(className) !== -1) {
        // Map to correct Program path
        var programPaths = {
          'StateManager': 'Assets/Program/Script/Manager/StateManager.cs',
          'Player': 'Assets/Program/Script/Controllers/Player.cs',
          'Boss': 'Assets/Program/Script/Controllers/Boss.cs',
          'Npc': 'Assets/Program/Script/Controllers/Npc.cs',
          'UIManager': 'Assets/Program/Script/Manager/UIManager.cs',
          'CameraManager': 'Assets/Program/Script/Manager/CameraManager.cs',
          'LunaManager': 'Assets/Program/Script/Manager/LunaManager.cs',
          'MainPanel': 'Assets/Program/Script/UI/MainPanel.cs',
          'TouchArea': 'Assets/Program/Script/UI/TouchArea.cs',
          'YangJoystick': 'Assets/Program/Script/UI/YangJoystick.cs'
        };
        targetPath = programPaths[className];
      }
      files.push({ path: targetPath, content: code });
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
