// Worker Coder v3 — AI coding agent with compile-fix-retry loop
// Uses Luna diagnostics JSON for accurate error extraction

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Code Reviewer — GPT-5.4 adversarial review against Luna constraints
let codeReviewer;
try {
  codeReviewer = require('./code-reviewer.js');
} catch(e) { console.warn('[coder] code-reviewer.js not loaded:', e.message); }

// Spec System — structured experience specs + skeleton generation
let specExtractor, skeletonGenerator;
try {
  specExtractor = require('../adapters/spec-extractor.cjs');
  skeletonGenerator = require('../adapters/skeleton-generator.cjs');
} catch (e) {
  // spec system not available — degrade gracefully
}

// GitNexus Helper — 代码结构分析（可选，不影响主流程）
let gnHelper;
try {
  gnHelper = require('./gitnexus-helper');
} catch (e) {
  // gitnexus-helper.js 不存在时静默跳过
}

// ============ Helpers ============
function listCsFiles(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory() && entries[i].name !== 'Editor') results = results.concat(listCsFiles(fp));
      else if (entries[i].name.endsWith('.cs')) results.push(fp);
    }
  } catch(e) {}
  return results;
}

// ============ Config ============
const API_BASE = 'https://crs.mindrix.app/api/anthropic';
const API_KEY = process.env.LLM_API_KEY || 'oki-d82fb9cf928492b23847db9569dd1f912906cc09135c62fe20b5fa3f0576';
const MODEL_GENERATE = process.env.LLM_MODEL_GENERATE || 'claude-opus-4-7';
const MODEL_FIX = process.env.LLM_MODEL_FIX || 'claude-opus-4-7';
const MAX_TOKENS = 30000; // Opus max is 32000; leave headroom
const MAX_FIX_ATTEMPTS = 10;  // Keep retrying until fixed (practical upper bound)
const PIPELINE_DIR = process.env.LUNA_PIPELINE || 'D:\\Luna\\pipeline';
const COCOS_EXE = process.env.COCOS_CREATOR || 'D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe';

// ============ HTTPS Proxy Helper ============
const http = require('http');

function createProxyRequest(targetUrl, opts, callback) {
  var proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxyUrl) {
    // No proxy — direct HTTPS request
    return https.request(opts, callback);
  }
  
  var proxy = new URL(proxyUrl);
  return new Promise(function(resolveReq) {
    var connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: opts.hostname + ':' + (opts.port || 443),
      timeout: 30000
    });
    connectReq.on('connect', function(res, socket) {
      if (res.statusCode !== 200) {
        socket.destroy();
        var fakeReq = new (require('events').EventEmitter)();
        fakeReq.write = function() {}; fakeReq.end = function() {};
        resolveReq(fakeReq);
        fakeReq.emit('error', new Error('Proxy CONNECT failed: ' + res.statusCode));
        return;
      }
      socket.setKeepAlive(true, 30000);
      socket.setTimeout(0); // no idle timeout on tunnel
      opts.socket = socket;
      opts.agent = false;
      var req = https.request(opts, callback);
      resolveReq(req);
    });
    connectReq.on('error', function(e) {
      var fakeReq = new (require('events').EventEmitter)();
      fakeReq.write = function() {}; fakeReq.end = function() {};
      resolveReq(fakeReq);
      fakeReq.emit('error', new Error('Proxy connection failed: ' + e.message));
    });
    connectReq.end();
  });
}

// ============ LLM Call ============

function callClaude(systemPrompt, userMessage, timeoutMs, model) {
  timeoutMs = timeoutMs || 300000; // 5 min default
  model = model || MODEL_GENERATE; // Use Opus for all calls (fix quality > cost savings)
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

    function handleResponse(res) {
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
    }

    // Use proxy if available, otherwise direct
    var proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    // Skip proxy for crs.mindrix.app (directly accessible, proxy causes timeout on long Opus requests)
    var skipProxy = (API_BASE.indexOf('crs.mindrix.app') >= 0 || API_BASE.indexOf('api.aaxe.cn') >= 0 || API_BASE.indexOf('localhost') >= 0);
    if (proxyUrl && !skipProxy) {
      createProxyRequest(API_BASE + '/v1/messages', opts, handleResponse).then(function(req) {
        req.on('error', reject);
        req.on('timeout', function() { req.destroy(); reject(new Error('API timeout')); });
        req.write(body);
        req.end();
      });
    } else {
      var req = https.request(opts, handleResponse);
      req.on('error', reject);
      req.on('timeout', function() { req.destroy(); reject(new Error('API timeout')); });
      req.write(body);
      req.end();
    }
  });
}

// Retry wrapper for callClaude — retries on transient network errors
function callClaudeWithRetry(systemPrompt, userMessage, timeoutMs, model, maxRetries) {
  maxRetries = maxRetries || 3;
  var attempt = 0;
  function tryOnce() {
    attempt++;
    return callClaude(systemPrompt, userMessage, timeoutMs, model).catch(function(err) {
      var msg = err.message || '';
      var isTransient = msg.indexOf('ECONNABORTED') >= 0 || msg.indexOf('socket hang up') >= 0 || 
                        msg.indexOf('ECONNRESET') >= 0 || msg.indexOf('timeout') >= 0 ||
                        msg.indexOf('ETIMEDOUT') >= 0;
      if (isTransient && attempt < maxRetries) {
        var delay = attempt * 15000;
        return new Promise(function(resolve) { setTimeout(resolve, delay); }).then(tryOnce);
      }
      throw err;
    });
  }
  return tryOnce();
}

// ============ Blueprint → Prompt ============

// --- V3 三层结构解析：物件清单 + 流程时间线 + 参数表 ---

// 从 sceneObjects 文本中提取对象列表
// ============ System Prompts ============

var GENERATE_PROMPT = [
  'You are a Unity C# code generator for playable ads built with Luna SDK (HTML5 export).',
  'Luna converts Unity C# to JavaScript for web — many Unity features are NOT supported.',
  '',
  '## ⛔⛔⛔ ABSOLUTE RULE #1 — READ THIS FIRST ⛔⛔⛔',
  '',
  'ALL visible 3D objects MUST be created using GFM_Create.Obj() or GFM_Create.Ground(). V5 MODE: Objects are PRE-CREATED as __Pool_{Shape}_{Color}_{NN} — use GameObject.Find() instead.',
  'CreatePrimitive() and new GameObject() with mesh/renderer are FORBIDDEN — they produce INVISIBLE objects in Luna WebGL.',
  '',
  'AVAILABLE GFM_ classes (DO NOT invent others): GFM_Create, GFM_UI, GFM_Utils, GFM_Audio, GFM_Pool, GFM_Luna, GFM_Joystick, GFM_Grid, GFM_Pathfinding, GFM_ReturnTimer.',
  'Do NOT use GFM_Event, Subscribe, Fire, FireNow, UnityEvent, or AddListener for business flow. Call named methods directly.',
  'GFM_Billboard does NOT exist. Do NOT reference any GFM_ class not in this list.',
  'Do NOT modify GFM_*.cs in Commons/ — they are read-only toolkit files.',
  '',
  'In Start(), BEFORE creating any objects (Legacy mode):',
  '// V5 MODE: Skip these calls — pool objects are pre-created with baked colors. Use mainCam (pre-cached) and uiCanvas (pre-created).',
  '  // GFM_Create.InitMaterialFromScene(); // V5: No longer needed — colors are pre-baked into pool object names',
  '  // GFM_Create.ResetPool(); // V5: No longer needed — pool objects are pre-created',
  '',
  'Then create objects like:',
  '  // V5: var cube = GameObject.Find("__Pool_Cube_Blue_01"); // Pre-existing pool object',
  '  // Legacy: var cube = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0,1,0), Vector3.one, "MyCube");',
  '  // GFM_Create.SetColor(cube, ...); // V5: Colors are pre-baked — use __Pool_Cube_Blue_01 instead',
  '  var ground = GFM_Create.Ground(20f, 20f);',
  '',
  'V5 MODE: Use GameObject.Find("__Pool_{Shape}_{Color}_{NN}") for pre-existing pool objects. Legacy mode uses GFM_Create.Obj().',
  '',
  '## ⛔⛔⛔ ABSOLUTE RULE #2 — EVERY SHOT MUST HAVE VISIBLE UI ⛔⛔⛔',
  '',
  'Every shot_N() method MUST create at least ONE visible UI element to guide the player:',
  '- A **guide arrow** (yellow triangle pointing to the interaction target)',
  '- A **text label** (e.g. "Click here", "Drag wood") using GFM_UI.CreateText()',
  '- A **highlight circle** (yellow ring around the interactive object)',
  '- A **button** for click-based interactions using GFM_UI.CreateButton()',
  '',
  'WITHOUT visible UI guidance, the game is unplayable — the player sees colored blocks but has NO IDEA what to do.',
  'If a shot has only 3D objects and NO UI elements, it WILL be rejected.',
  '',
  'Example pattern for each shot:',
  '  Canvas canvas = GFM_UI.CreateCanvas(1920, 1080);  // Canvas type, NOT GameObject!',
  '  GFM_UI.CreateText(canvas, "Tap the tree to collect wood!", new Vector2(0, 200), 28);',
  '  var arrow = GFM_Create.Obj(PrimitiveType.Cube, targetPos + Vector3.up * 2f, new Vector3(0.5f, 1f, 0.5f), "GuideArrow");',
  '  // GFM_Create.SetColor(arrow, ...); // V5: Colors pre-baked into pool names — use __Pool_Cube_Yellow_01',
  '',
  '## CRITICAL LUNA CONSTRAINTS',
  '',
  '### Absolutely DO NOT use:',
  '- Do NOT use CreatePrimitive or new Mesh — V5: use GameObject.Find("__Pool_{Shape}_{Color}_{NN}") for pre-placed pool objects. Legacy: use GFM_Create.Obj().',
  '- TileMap, New InputSystem, Terrain (use mesh-based terrain instead)',
  '- Generics (Luna does NOT support generic syntax — use non-generic overloads)',
  '- Resources.GetBuiltinResource — NOT implemented in Luna, use GFM_UI for text/font',
  '- C# 7.0+ syntax (no tuples, pattern matching, local functions, etc.)',
  '- Multi-threading (web does not support threads)',
  '- SceneManager (scene transitions = SetActive on parent GameObjects)',
  '- Resources.Load, AssetBundle, async/await, Task, LINQ',
  '- Animation component (use Animator instead)',
  '- TextMeshPro / TMPro (use GFM_UI.CreateText for all text display)',
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
  '- `new Material(Shader.Find(...))` — does NOT work in Luna (creates invisible/pink objects)',
  '- ⛔ `GameObject.CreatePrimitive()` objects are INVISIBLE in Luna WebGL — MUST use GFM_Create.Obj() instead',
  '',
  '### Object Creation (CRITICAL — Luna object pool system):',
  '- ⛔ CreatePrimitive() objects are INVISIBLE in Luna. You MUST use GFM_Create for all 3D objects.',
  '- The scene has a pre-placed object pool: 50 Cubes, 20 Spheres, 10 Planes, 10 Cylinders at y=-9999.',
  '- V5: Pool objects are named __Pool_{Shape}_{Color}_{NN} (e.g. __Pool_Cube_Red_01). Use GameObject.Find() to get references. Legacy: GFM_Create.Obj() fetches from pool.',
  '```csharp',
  'void Start() {',
  '    // GFM_Create.ResetPool();  // V5: No longer needed — pool objects are pre-created as __Pool_{Shape}_{Color}_{NN}',
  '    // GFM_Create.InitMaterialFromScene();  // V5: No longer needed — colors are pre-baked into pool object names',
  '    // Create objects using pool (Luna-compatible!):',
  '    // V5: var cube = GameObject.Find("__Pool_Cube_Blue_01");',
  '    // V5: var sphere = GameObject.Find("__Pool_Sphere_Red_01");',
  '    // Legacy: var cube = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0, 1, 0), Vector3.one, "MyCube");',
  '    // Legacy: var sphere = GFM_Create.Obj(PrimitiveType.Sphere, new Vector3(3, 1, 0), Vector3.one * 0.5f, "Ball");',
  '    var ground = GFM_Create.Ground(20f, 20f);  // Creates a ground plane',
  '    // To hide an object: move it offscreen',
  '    cube.transform.position = new Vector3(0, -9999, 0);',
  '}',
  '```',
  '- Pool limits: Cube=50, Sphere=20, Plane=10, Cylinder=10. Plan your objects within these limits.',
  '- V5: Colors are PRE-BAKED into pool object names (__Pool_Cube_Red_01, __Pool_Sphere_Blue_01, etc). No SetColor() needed. Use `mainCam` (pre-cached) for camera. Set mainCam.backgroundColor=new Color(0.6f,0.8f,1f).',
  '- NEVER use Shader.Find() or new Material(shader) directly',
  '',
  '### MUST do:',
  '- Game end flow must be: Luna.Unity.LifeCycle.GameEnded(); then ShowCTA(); (ShowCTA must call InstallFullGame)',
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
  '## CRITICAL ARCHITECTURE',
  '',
  '⚠️ Luna converts Unity C# to JavaScript. [RuntimeInitializeOnLoadMethod] is IGNORED by Luna.',
  '⚠️ The scene SHOULD be clean but MAY still contain template objects. ALWAYS clean up in Start() as the FIRST thing:',
  '```csharp',
  '// MANDATORY: Clean all template objects at the very beginning of Start() — keep pool objects!',
  'foreach (var root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects()) {',
  '    if (root.name == "Main Camera" || root.name == "Directional Light" || root.name == "EventSystem" || root.name == "GameManager" || root.name.StartsWith("__")) continue;',
  '    Destroy(root);',
  '}',
  '```',
  '⚠️ GameFlowManagerMain will be automatically instantiated at runtime via JS injection. You are writing its content.',
  '⚠️ The template project has utility scripts in Assets/Program/Script/ — you can CALL their methods if useful (e.g., DOTween, PoolManager).',
  '⚠️ CREATE all your game content from code in Start() AFTER the cleanup above.',
  '',
  '### Strategy: Output ONLY GameFlowManagerMain.cs',
  '',
  '⚠️ You ONLY need to output ONE file: `Assets/Program/Script/Manager/GameFlowManagerMain.cs`',
  '⚠️ Do NOT create new files like StateManagerExtension.cs, GameFlowHelper.cs, etc.',
  '⚠️ Available utility classes (kept intact, you CAN call them):',
  '  - PoolManager (object pooling), AudioManager/SimpleAudioManager (sound)',
  '  - CTAManager (CTA button), LunaManager (Luna lifecycle), GameConstants, GameData',
  '  - MonoSingleton<T> (singleton base), BasicExtensions, ReturnPool, EventManager',
  '  - YangJoystick, TouchArea — WARNING: these are EMPTY STUBS, implement input yourself using IPointerDownHandler/IDragHandler or Input.GetMouseButton',
  '  - DOTween (DG.Tweening namespace, .dll)',
  '⚠️ All other game logic classes (Boss, Player, Enemy, Worker, etc.) are EMPTY stubs — do NOT call their methods.',
  '⚠️ ALL game logic must be in GameFlowManagerMain.cs — it is the only entry point.',
  '',
  '#### GameFlowManagerMain.cs is ALREADY attached to a GameObject in the scene:',
  '- It executes on Start()',
  '- Put ALL game logic here: shots, UI, input, camera, everything',
  '- Keep the class name `GameFlowManagerMain`',
  '',
  '#### In Start(), initialize materials then create content:',
  '```csharp',
  '// V5: Material initialization and SetColor are no longer needed — colors pre-baked into pool names',
  '// GFM_Create.InitMaterialFromScene(); // V5: No longer needed — colors pre-baked into pool names',
  '',
  '// V5: Colors are pre-baked into pool names — no SetColor() needed',
  '// Use __Pool_Cube_Brown_01 for brown objects, __Pool_Cube_Green_01 for green, etc.',
  '// Get references via: var building = GameObject.Find("__Pool_Cube_Brown_01");',
  '```',
  '- ⛔ DO NOT use: new Material(), Shader.Find(), FindObjectOfType<Renderer>()',
  '- ⛔ DO NOT use: GameObject.Find("__MaterialSource") — GFM_Create handles material setup internally',
  '',
  '// Scene is clean — start creating your game objects directly',
  '// No need to hide template objects (scene only has Camera, Light, EventSystem)',
  '```',
  '',
  '#### Then create your game world from code:',
  '- 3D objects: V5: `GameObject.Find("__Pool_Cube_Red_01")` (pre-existing pool). Legacy: `GFM_Create.Obj(PrimitiveType.Cube/Sphere/Plane, pos, scale, "name")`',
  '- UI Canvas: `Canvas canvas = GFM_UI.CreateCanvas(1920, 1080);`',
  '- UI Text: `Text txt = GFM_UI.CreateText(canvas, "Hello", new Vector2(0, 100), 28);`',
  '- UI Button: `Button btn = GFM_UI.CreateButton(canvas, "Go", new Vector2(0,-200), new Vector2(300,80), ()=>{});`',
  '- World Labels: `GFM_UI.AddWorldLabel(targetObj, "Label Text", 2f);`',
  '- Progress Bar: `Slider bar = GFM_UI.CreateProgressBar(canvas, new Vector2(0,300), new Vector2(400,30), Color.green);`',
  '- Materials: In V5 mode, colors are pre-baked into pool object names (__Pool_Cube_Red_01). Use `mainCam` (pre-cached) instead of Camera.main. Use `uiCanvas` (pre-created) instead of GFM_UI.CreateCanvas().',
  '- ⛔ DO NOT use: new GameObject(), SetParent(), Resources.GetBuiltinResource(), new Material(), AddComponent<Canvas/Text/Image/Button>()',
  '',
  '#### ⛔ NO Auto-Play / Auto-Demo',
  '- FORBIDDEN: autoplay, auto-shoot, auto-demo, ForceCompleteAllPhases',
  '- FORBIDDEN: auto-move player toward targets without player input',
  '- Player must actively interact (tap, click, drag, use joystick) to progress through each shot',
  '- PlayableAgent (VLM) will test the game by actually playing it — it needs real interactable elements, not auto-playing demos',
  '- Make the joystick activation zone large — use the FULL left half of the screen:',
  '  `if (mousePos.x < Screen.width * 0.5f)` (remove the mousePos.y check)',
  '',
  '#### MANDATORY: Create ALL Scene Objects from Blueprint',
  '- Every single object mentioned in the blueprint/storyboard MUST be created as a 3D object in the scene.',
  '- This includes: buildings, turrets, trees, resources, NPCs, vehicles, conveyor belts, generators, walls, decorations.',
  '- Use GFM_Create.Obj(PrimitiveType.Cube/Sphere/Cylinder, pos, scale, "label") for each visible object. V5: Objects are pre-created as __Pool_{Shape}_{Color}_{NN} — use GameObject.Find() instead.',
  '- Different object types should use different primitive shapes:',
  '  - Buildings/structures: Cube (scaled appropriately)',
  '  - Trees/plants: Cylinder (tall thin) + Sphere (on top as crown)',
  '  - Characters/NPCs: Capsule',
  '  - Resources/items: Sphere (small)',
  '  - Vehicles/machines: Cube (wide low)',
  '- Scale objects to reasonable sizes (buildings 3-5 units, trees 4-6 units, player 2 units)',
  '- Position objects in a logical spatial layout, spread out, not all at origin',
  '- V5: Use pool objects with pre-baked colors: __Pool_Cube_Brown_01 (buildings), __Pool_Cube_Green_01 (trees),',
  '  __Pool_Sphere_Yellow_01 (resources), __Pool_Cube_Blue_01 (player), __Pool_Cube_Red_01 (enemies)',
  '  Colors are baked into the pool name — no GFM_Create.SetColor() needed.',
  '  Legacy: Buildings=brown(0.6f,0.4f,0.2f), Trees=green(0.2f,0.6f,0.2f), Resources=yellow(0.8f,0.7f,0.2f)',
  '- If a shot says click X or drag X, X MUST exist as a visible object with a Collider',
  '- Objects for later shots: create initially with SetActive(false), activate when needed',
  '- Scene must look like a populated game world, NOT an empty void with just a player',
  '',
  '#### MANDATORY: Text Labels on Interactive Objects',
  '- You MUST add floating text labels above every key interactive object (buildings, turrets, NPCs, blueprints, etc.) so CUA can identify them',
  '- Use GFM_UI.AddWorldLabel() — ONE line per object, no manual canvas/text creation:',
  '```csharp',
  '// In Start() after creating objects:',
  'GFM_UI.AddWorldLabel(building, "Sawmill", 2f);',
  'GFM_UI.AddWorldLabel(turret, "Ballista", 2f);',
  'GFM_UI.AddWorldLabel(tree, "Tree", 1.5f);',
  '```',
  '- ⛔ DO NOT manually create WorldSpace Canvas, do NOT use new GameObject/AddComponent/SetParent for labels',
  '- Call GFM_UI.AddWorldLabel for every building, turret, blueprint, NPC, resource pile, etc.',
  '- This is critical for automated QA testing to identify objects.',
  '',
  '#### ⛔ CRITICAL: NO Coroutines / IEnumerator / StartCoroutine / WaitUntil / WaitForSeconds',
  '- **Luna WebGL does NOT reliably support coroutines** when the script is injected at runtime.',
  '- StartCoroutine, IEnumerator, yield return, WaitForSeconds, WaitUntil — ALL FORBIDDEN.',
  '- Instead, use **Update()-based state machine** pattern:',
  '```csharp',
  'private int _currentShot = 0;',
  'private int _shotState = 0; // sub-state within each shot',
  'private float _shotTimer = 0f;',
  '',
  'void Update() {',
  '    _shotTimer += Time.deltaTime;',
  '    switch (_currentShot) {',
  '        case 1: UpdateShot1(); break;',
  '        case 2: UpdateShot2(); break;',
  '        // ... etc',
  '    }',
  '    HandleAutoPlay();',
  '}',
  '',
  'void UpdateShot1() {',
  '    switch (_shotState) {',
  '        case 0: // Setup: create objects, show guide',
  '            SetupShot1Objects();',
  '            _shotState = 1;',
  '            _shotTimer = 0;',
  '            break;',
  '        case 1: // Wait for player to reach target (player uses joystick to move)',
  '            if (_player != null && _currentTarget != null) {',
  '                float dist = Vector3.Distance(_player.transform.position, _currentTarget.transform.position);',
  '                if (dist < 2f) { _shotState = 2; _shotTimer = 0; }',
  '            }',
  '            break;',
  '        case 2: // Build animation / progress',
  '            if (_shotTimer > 1f) { _shotState = 3; }',
  '            break;',
  '        case 3: // Complete, advance to next shot',
  '            _currentShot = 2; _shotState = 0; _shotTimer = 0;',
  '            break;',
  '    }',
  '}',
  '```',
  '- Every shot MUST follow this Update/switch pattern. No exceptions.',
  '- Shot transitions happen by changing `_currentShot` and resetting `_shotState = 0`.',
  '- Time delays use `_shotTimer` checks (e.g., `if (_shotTimer > 1.5f)`) instead of WaitForSeconds.',
  '- DOTween is OK for animations (it runs independently of coroutines).',
  '',
  '#### 踩坑经验（公司实战，必须遵守！）',
  '- Luna不支持泛型写法（NO generics!），包括 List<T>, Dictionary<K,V>, Action<T> 等',
  '- 不要用C# 7.0+语法：?., ??, $"", nameof(), pattern matching, local functions',
  '- 不要用Animation，用DOTween或Animator',
  '- CharacterController不可靠，用Transform.Translate或Rigidbody',
  '- 不要用多线程、LINQ、async/await、**Coroutines/IEnumerator/StartCoroutine**',
  '- 不要用SceneManager、Resources.Load',
  '- 不支持烘焙阴影、TileMap、Terrain、New InputSystem',
  '- 拖动UI物体必须在自身挂EventTrigger',
  '- 3D点击检测必须3D collider（2D collider触发不了OnMouseDown）',
  '- 数组操作避免double类型运算（可能下标越界）',
  '- 重玩功能不要用泛型单例',
  '- Trail renderer跟随前必须先Clear()',
  '- DOTween链式调用要分开写（避免JS转译bug）',
  '- URP不要勾动态合批（移动端材质丢失）',
  '- 不可以一直调用动画播放，否则只播第一帧',
  '',
  '#### Implement shots as state machine methods (MANDATORY naming: shot_1, shot_2, shot_3...):',
  '- Each shot = a method named shot_N() (e.g. shot_1(), shot_2()) that creates/shows objects and hides previous ones',
  '- The method MUST be named shot_N — this is verified by automated checks and will fail if named differently',
  '- Use SetActive to toggle shot containers',
  '',
  '### ⚠️ ONE FILE ONLY — ABSOLUTELY NO EXCEPTIONS ⚠️',
  '- Output ONLY `Assets/Program/Script/Manager/GameFlowManagerMain.cs`',
  '- Do NOT output ANY other file — not Player.cs, not GameHelper.cs, not any "Extension" or "Fix" file',
  '- ALL game logic, ALL helper methods, ALL inner classes go INSIDE GameFlowManagerMain.cs',
  '- If you need helper classes, define them as `private class` INSIDE GameFlowManagerMain',
  '- Violating this rule = instant compilation failure',
  '',
  '### Rules:',
  '- Keep class name `GameFlowManagerMain` (already attached to scene object)',
  '- Do NOT create Bootstrap scripts with [RuntimeInitializeOnLoadMethod]',
  '- You CAN use: PoolManager, AudioManager, SimpleAudioManager, CTAManager, LunaManager, GameConstants, GameData, MonoSingleton, DOTween',
  '- YangJoystick and TouchArea are EMPTY STUBS with NO methods — do NOT call .Horizontal, .Vertical, .GetDirection() etc.',
  '- For joystick input: implement your own drag-based joystick using IPointerDownHandler/IDragHandler/IPointerUpHandler',
  '- For touch input: use Input.GetMouseButton/Input.GetMouseButtonDown or implement IPointerClickHandler',
  '- Do NOT use: Boss, Player, Enemy, Worker, Npc, UIManager, CameraManager, or any Controller class — they are empty stubs',
  '- RULE: If a class is listed as "available" but has no documented API, assume it is an EMPTY STUB and implement the logic yourself',
  '- NEVER define classes/enums with names that already exist in the project stubs — this causes CS0101 duplicate definition errors',
  '- Do NOT redefine ANY class. All utility code is in GFM_*.cs (Commons/ directory, GFM_ prefix). Use them as-is.',
  '- If you need a helper class, use a UNIQUE name like GFM_EventPool, GFM_Helper, etc. (prefix with GFM_ to avoid conflicts)',
  '- For singletons: `public static GameFlowManagerMain instance;` set in Awake()',
  '- Do NOT define enums that conflict with stub classes (ResourceType, GameState, etc. may exist as empty stubs)',
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
  'The SVN project is a TEMPLATE. ALL other scripts are empty stubs.',
  'GameFlowManagerMain.cs is the ONLY entry point — it runs Start() on scene load.',
  'You MUST put ALL game logic in GameFlowManagerMain.cs. Do NOT create new files.',
  'Do NOT create a Bootstrap with [RuntimeInitializeOnLoadMethod] — Luna ignores it.',
  '',
  'Output format:',
  '```csharp:Assets/Program/Script/Manager/GameFlowManagerMain.cs',
  '// code',
  '```',
  '',
  'Output ONLY ONE file: Assets/Program/Script/Manager/GameFlowManagerMain.cs — no other files.',
  'ALL game logic must be SELF-CONTAINED in GameFlowManagerMain.cs.',
  'Do NOT reference any class from Utilities/Entities/AStar — they are empty stubs.',
  'Do NOT output UIManager.cs, Player.cs, CameraManager.cs, MainPanel.cs, Boss.cs, Npc.cs, or TouchArea.cs — they are all empty stubs and must stay that way.',
  '',
  '## QUALITY REQUIREMENTS (your code will be automatically verified):',
  '- GameFlowManagerMain.cs MUST be at least 300 lines of actual game logic',
  '- MUST contain methods named EXACTLY shot_1(), shot_2(), shot_3()... shot_N() for EVERY shot in the blueprint',
  '- METHOD NAMING IS MANDATORY: shot_1, shot_2, shot_3... — NOT Scene1, Level1, Phase1, Stage1 or any other name',
  '- The automated verification system searches for "shot_1", "shot_2" etc. — other names WILL FAIL verification',
  '- MUST create visible game objects (GFM_Create.Obj, UI elements) — not just empty methods',
  '- MUST implement player interactions described in the blueprint (input handling, triggers)',
  '- A skeleton/template class that only sets up camera and calls GameEnded() will be REJECTED',
  '- The generated game must be VISUALLY DIFFERENT from the SLG template — all template objects are hidden',
  '',
  '',
  '## GFM_Tools TOOLKIT (already in project — call these, DO NOT redefine)',
  '',
  '### ⚠️ RETURN TYPES MATTER — read carefully:',
  '- GFM_Create.InitMaterialFromScene() → void  // V5: No longer needed — colors pre-baked into __Pool_{Shape}_{Color}_{NN} names',
  '- GFM_Create.Obj(PrimitiveType type, Vector3 pos, Vector3 scale, string label) → **GameObject**',
  '- GFM_Create.Ground(float w, float d) → **GameObject**',
  '- GFM_Create.SetColor(GameObject obj, Color color) → void  // V5: Not needed — colors pre-baked into pool names',
  '',
  '- GFM_UI.CreateCanvas(int w, int h) → **Canvas** (NOT GameObject! Do NOT write: GameObject canvas = GFM_UI.CreateCanvas(...))',
  '- GFM_UI.CreateButton(**Canvas** canvas, string text, Vector2 pos, Vector2 size, UnityAction onClick) → **Button**',
  '- GFM_UI.CreateText(**Canvas** canvas, string text, Vector2 pos, int fontSize) → **Text**',
  '- GFM_UI.AddWorldLabel(GameObject obj, string text, float height) → void',
  '- GFM_UI.CreateProgressBar(**Canvas** canvas, Vector2 pos, Vector2 size, Color color) → Slider',
  '',
  '- GFM_Audio.Init(GameObject go) / .instance.PlaySFX(clip) / .PlayBGM(clip) / .PlayPitch(clip, idx)',
  '- GFM_Pool.Init(go) / .Preload(prefab, n) / .Get(prefab) / .Return(obj) / .ReturnAfter(obj, delay)',
  '- Business flow: direct method calls only. Do not use GFM_Event / Subscribe / Fire / FireNow / AddListener.',
  '- GFM_Utils.IsInRange(dist, a, b, inclY) / .IsOnScreen(tf) / .FindClosestByTag(origin, tag, maxD)',
  '- GFM_Joystick.Create(**Canvas** canvas, float size) → GFM_Joystick — .Horizontal / .Vertical / .Direction / .IsDragging',
  '- GFM_Luna.Init(go) / .GameOver() / .GotoStore() / .IsGameOver()',
  '',
  '### Correct Canvas usage pattern:',
  '  Canvas canvas = GFM_UI.CreateCanvas(1920, 1080);     // ← Canvas type, NOT GameObject!',
  '  GFM_UI.CreateText(canvas, "Hello", Vector2.zero, 28);',
  '  GFM_UI.CreateButton(canvas, "Play", new Vector2(0, -200), new Vector2(300, 80), () => { });',
  '  // If you need the GameObject: canvas.gameObject',
  '',
  'CRITICAL: Do NOT define classes named AudioManager, PoolManager, EventManager, EventPool,',
  'BasicExtensions, MonoSingleton, Player, Boss, Npc, LunaManager, CTAManager, etc.',
  'Use the GFM_ equivalents. All utility logic is in GFM_*.cs (Commons/).',
  '',
  'Generate code that implements the blueprint faithfully and completely.'
].join('\n');

var FIX_PROMPT = [
  'You are fixing Unity C# compilation errors for a Luna SDK playable ad project.',
  'Luna transpiles C# to JavaScript — many Unity features cause compilation failures.',
  '',
  '## ⚡ GFM API CHEAT SHEET (EXACT signatures — do NOT guess parameters!)',
  '```',
  'Canvas canvas = GFM_UI.CreateCanvas(1920, 1080);                                  // (int w, int h) → Canvas',
  'Text txt = GFM_UI.CreateText(canvas, "Hello", new Vector2(0, 100), 28);           // (Canvas, string, Vector2, int) → Text — ONLY 4 params!',
  'Button btn = GFM_UI.CreateButton(canvas, "Go", new Vector2(0,-200), new Vector2(300,80), ()=>{}); // (Canvas, string, Vector2, Vector2, UnityAction) → Button — 5 params',
  'Slider bar = GFM_UI.CreateProgressBar(canvas, new Vector2(0,300), new Vector2(400,30), Color.green); // (Canvas, Vector2, Vector2, Color) → Slider — 4 params',
  'GameObject obj = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0,1,0), Vector3.one, "MyCube");     // (PrimitiveType, Vector3, Vector3, string) → GameObject — 4 params!',
  '```',
  '',
  '## ⛔ CRITICAL: NO Coroutines (MUST rewrite if found)',
  '- StartCoroutine, IEnumerator, yield return, WaitForSeconds, WaitUntil — ALL FORBIDDEN in Luna.',
  '- If the existing code uses coroutines, you MUST rewrite ALL shot logic as Update()-based state machine:',
  '  `_currentShot` (int) + `_shotState` (int) + `_shotTimer` (float) in Update() switch/case.',
  '- Time delays: use `_shotTimer += Time.deltaTime; if (_shotTimer > X)` instead of WaitForSeconds.',
  '- DOTween is OK for animations.',
  '',
  '## 踩坑经验（公司实战，必须遵守！）',
  '- Luna不支持TileMap',
  '- Luna不支持New InputSystem',
  '- 不可以一直调用动画播放，否则会一直播放第一帧',
  '- 使用数组内置减去double类型数据，打包Luna后可能下标越界（list<float>data; data[i]-Time.deltaTime）',
  '- UI层级调最上方可添加Graphic Raycaster来修改',
  '- 拖动UI时，被拖动物体只能是实现了接口或挂载EventTrigger的物体本身',
  '- Luna不支持烘焙阴影',
  '- CharacterController支持不好，用Transform或Rigidbody移动',
  '- RenderTexture不可用custom rendertexture',
  '- Luna不支持泛型写法（重要！）',
  '- 尽量不用Animation，用Animator处理动画',
  '- 不要用多线程，web不支持',
  '- 插件只用DOTween、TextMeshPro（部分）、Spine（按需）',
  '- 有重玩功能不要用泛型的instance',
  '- 不支持动画状态机内连接exit节点',
  '- Luna不支持Terrain组件',
  '- Luna6.0以后不支持动态批处理',
  '- 纹理压缩失败一般是中文路径导致',
  '- 按钮事件最好直接拖上去，不要动态赋值（手机可能需要点两下才跳转）',
  '- 3D物体检测时碰撞器和模型本体分开，onTrigger/onCollision可能漏执行',
  '- 鼠标点击事件必须3D collider，2D collider触发不了OnMouseDown系列',
  '- 动画对多材质球操作时Luna只有第一个材质球变化',
  '- Trail renderer跟随移动前必须先Clear()，否则会向屏幕中心画线',
  '- 物体贴图打包变绿是透明通道问题，alphasource选none',
  '- 只有直射光可以有实时阴影',
  '- URP项目不要勾选动态合批，否则移动端材质丢失',
  '- 重玩/重载场景时单例数据不会重置，需手动销毁再重建',
  '- DOTween重载前要KillAll+Clear',
  '- 灯光旋转不要有负值（特别是z值），否则阴影全覆盖',
  '- 2D碰撞检测触发进入/退出可能失效，最好用持续检测',
  '',
  '## Key Luna constraints to remember when fixing:',
  '- NO generics (Luna does not support generic syntax like List<T>, Dictionary<K,V> — use ArrayList or plain arrays)',
  '- NO C# 7.0+ syntax (tuples, pattern matching, local functions, string interpolation $"", etc.)',
  '- NO Vector3Int or Vector2Int (cast to Vector3/Vector2)',
  '- NO System.Math (use UnityEngine.Mathf)',
  '- NO Animation component (use Animator or DOTween)',
  '- NO TextMeshPro / TMPro (use UnityEngine.UI.Text instead)',
  '- NO SendMessage, no multi-threading, no LINQ, no System.Linq',
  '- NO SceneManager, Resources.Load, async/await, Task',
  '- NO CharacterController (use Transform.Translate or Rigidbody)',
  '- NO Enum.GetValues, Enum.Parse, typeof() with generics',
  '- NO delegate with generics (System.Action<T>, System.Func<T> — use plain delegates)',
  '- NO System.Collections.Generic in complex ways (Dictionary is sometimes OK, but HashSet/Queue may fail)',
  '- NO Camera.main.ScreenToWorldPoint without null check (Camera.main can be null)',
  '- NO Resources.GetBuiltinResource (not implemented in Luna — use GFM_UI for text/font)',
  '- NO Sprite.Create from code (use UI.Image with color, or GFM_Create.Obj for 3D)',
  '- NO UnityEngine.Random.Range with int overload ambiguity (cast explicitly)',
  '- NO nested generic types or generic method calls',
  '- NO optional parameters with default values in some contexts (use overloads)',
  '- NO nameof() operator',
  '- NO null-conditional ?. or null-coalescing ?? operators',
  '- GetComponent<Transform>() and GetComponent<RectTransform>() are NOT interchangeable',
  '- DOTween chain calls must be on separate lines to avoid JS transpilation bugs',
  '- Use Luna.Unity.Playable.InstallFullGame() instead of Application.OpenURL',
  '- Must call Luna.Unity.LifeCycle.GameEnded() when game ends, then ShowCTA()',
  '- Do NOT create or configure Light components (Light.type is NOT available in Luna Bridge.NET)',
  '- Do NOT use [RuntimeInitializeOnLoadMethod] — Luna ignores it',
  '- The main controller script is GameFlowManagerMain.cs — keep its class name `GameFlowManagerMain`',
  '- The scene is CLEAN — all game objects are created from code, do NOT use GameObject.Find() for template objects',
  '- Materials: V5 mode — colors are pre-baked into pool object names (__Pool_Cube_Red_01). No InitMaterialFromScene() or SetColor() needed.',
  '- V5: Objects have pre-baked colors via pool naming (__Pool_{Shape}_{Color}_{NN}). No SetColor() needed.',
  '- GFM_UI.CreateCanvas() returns **Canvas** (component), NOT GameObject. Write: Canvas canvas = GFM_UI.CreateCanvas(w,h);',
  '- GFM_UI.CreateButton/CreateText take **Canvas** as first param, NOT GameObject.',
  '- GFM_UI.CreateProgressBar() returns **Slider**, NOT Image.',
  '- GFM_Joystick.Create() takes **Canvas** as first param, NOT GameObject.',
  '- If you need the GameObject from a Canvas: use canvas.gameObject',
  '- GFM_Create.Obj() requires 4 params: (PrimitiveType, Vector3 pos, Vector3 scale, string label) — do NOT omit scale!',
  '- Light.type is NOT available in Luna Bridge.NET — do NOT create or configure Light components manually',
  '- CS0101 EventPool: the template already has EventPool.cs — do NOT define any class/enum named EventPool in your code',
  '- NEVER replace GFM_Create.Obj() calls with CreatePrimitive() — CreatePrimitive is INVISIBLE in Luna WebGL',
  '- If a fix requires new visible objects, use GFM_Create.Obj() — NOT CreatePrimitive (invisible in Luna)',
  '- Do NOT reintroduce dependencies on template scene objects that were cleared',
  '',
  'Analyze each error carefully. Fix ALL errors. If the same error keeps recurring,',
  'try a completely different approach rather than repeating the same fix.',
  '',
  '## CRITICAL: Do NOT simplify or remove game logic to fix errors!',
  '- If a feature causes errors, fix the implementation — do NOT delete the feature',
  '- The code MUST still implement ALL shots from the blueprint after fixing',
  '- Removing shot methods or game objects to fix compile errors = REJECTED',
  '- The final code must be 200+ non-empty lines with real game logic',
  '',
  '## FILE RULES (CRITICAL — ABSOLUTELY NO EXCEPTIONS):',
  '- Output ONLY `Assets/Program/Script/Manager/GameFlowManagerMain.cs` — NO OTHER FILES',
  '- Do NOT create StateManagerExtension.cs, GameFlowHelper.cs, etc.',
  '- Do NOT create files in Assets/Scripts/ — they will not be executed',
  '- ALL fixes must be made INSIDE GameFlowManagerMain.cs',
  '- If you need helper classes, define them as `private class` INSIDE GameFlowManagerMain',
  '- Do NOT reference classes from Utilities/, Entities/, AStar/, BySakanakoChan/ — they are EMPTY STUBS',
  '- If an error says a class/method does not exist, REMOVE the reference — do NOT create a new file for it',
  '- For UI text: use GFM_UI.CreateText(canvas, text, pos, fontSize) — do NOT manually create Font or use Resources.GetBuiltinResource',
  '- If a class does not exist, do NOT try to use it — remove or inline the logic',
  '',
  'Output corrected files as:',
  '```csharp:Assets/Program/Script/Manager/GameFlowManagerMain.cs',
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
  // Clean LunaTemp (preserve stage1 cache — Unity asset export cannot be regenerated without Unity)
  var lunaTemp = path.join(clientDir, 'LunaTemp');
  if (fs.existsSync(lunaTemp)) {
    ['stage2', 'stage3', 'stage4'].forEach(function(sub) {
      var subDir = path.join(lunaTemp, sub);
      if (fs.existsSync(subDir)) {
        try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (e) {}
      }
    });
  }

  // Read AI-written code to detect class names it defines (to avoid CS0101 duplicates)
  var aiMainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
  var aiClassNames = [];
  if (fs.existsSync(aiMainFile)) {
    var aiCode = fs.readFileSync(aiMainFile, 'utf-8');
    var aiClassMatches = aiCode.match(/(?:public|private|internal|protected)?\s*(?:class|enum|struct|interface)\s+(\w+)/g) || [];
    aiClassMatches.forEach(function(m) {
      var nameMatch = m.match(/(?:class|enum|struct|interface)\s+(\w+)/);
      if (nameMatch && nameMatch[1] !== 'GameFlowManagerMain') aiClassNames.push(nameMatch[1]);
    });
    if (aiClassNames.length > 0) log('[coder] AI defines classes: ' + aiClassNames.join(', ') + ' — will remove from stubs to avoid CS0101', taskId);
  }

  // Temporarily stub out ALL non-AI template scripts to avoid cross-reference errors
  // Save originals, replace with empty class stubs
  var stubBackups = [];
  var templateDirs = ['Utilities', 'Entities', 'AStar', 'Controllers', 'Manager', 'UI'];
  templateDirs.forEach(function(d) {
    var dir = path.join(clientDir, 'Assets', 'Program', 'Script', d);
    if (!fs.existsSync(dir)) return;
    var csFiles = listCsFiles(dir);
    csFiles.forEach(function(f) {
      // Skip files that AI wrote (they have recent mtime from this run)
      var rel = path.relative(clientDir, f).replace(/\\/g, '/');
      // Check if file was written by AI (exists in writeFiles output)
      // Simple heuristic: if file mtime is within last 10 minutes, it's AI-written
      try {
        var stat = fs.statSync(f);
        var ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 600000) return; // AI-written file, skip
      } catch(e) { return; }
      
      // This is an original template file — stub it out
      try {
        var orig = fs.readFileSync(f, 'utf-8');
        // Extract class/enum names to create valid stubs
        var classes = orig.match(/(?:public\s+)?(?:class|enum|struct|interface)\s+(\w+)/g) || [];
        var stub = 'using UnityEngine;\nusing System.Collections;\nusing System.Collections.Generic;\n\n';
        classes.forEach(function(c) {
          var m = c.match(/(class|enum|struct|interface)\s+(\w+)/);
          if (m) {
            // Skip classes that AI already defines — prevents CS0101 duplicate definition
            if (aiClassNames.indexOf(m[2]) >= 0) return;
            if (m[1] === 'class') stub += 'public class ' + m[2] + ' : MonoBehaviour { void Awake(){} void OnEnable(){} void Start(){} void Update(){} }\n';
            else if (m[1] === 'enum') stub += 'public enum ' + m[2] + ' { Default }\n';
            else if (m[1] === 'struct') stub += 'public struct ' + m[2] + ' { }\n';
            else if (m[1] === 'interface') stub += 'public interface ' + m[2] + ' { }\n';
          }
        });
        if (classes.length > 0) {
          stubBackups.push({ path: f, original: orig });
          fs.writeFileSync(f, stub, 'utf-8');
        }
      } catch(e) {}
    });
  });

  // MANDATORY: Restore GFM toolkit files → Commons/ before every build
  var _gfm = require('./gfm-files.cjs');
  _gfm.copyGfmToProjectDir(clientDir);
  _gfm.cleanupLegacyGfm(clientDir);
  log('[coder] GFM toolkit files restored to Commons/ (pre-build)', taskId);

  // Fix Event.cs stub: it has a duplicate EventPool class that conflicts with EventPool.cs
  var eventCsPath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Utilities', 'Event', 'Event.cs');
  if (fs.existsSync(eventCsPath)) {
    var eventSrc = fs.readFileSync(eventCsPath, 'utf-8');
    if (eventSrc.indexOf('class EventPool') >= 0) {
      eventSrc = eventSrc.replace(/^.*class EventPool.*$/gm, '// [AUTO-FIX] removed duplicate EventPool definition');
      fs.writeFileSync(eventCsPath, eventSrc, 'utf-8');
      log('[coder] Removed duplicate EventPool from Event.cs', taskId);
    }
  }

  // === NUCLEAR PRE-BUILD FIXES ===
  // These fix KNOWN type issues that AI consistently produces, BEFORE compilation
  var mainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
  log('[coder] Pre-build mainFile: ' + mainFile + ' exists=' + fs.existsSync(mainFile), taskId);
  if (fs.existsSync(mainFile)) {
    var mainSrc = fs.readFileSync(mainFile, 'utf-8');
    log('[coder] Pre-build mainSrc length=' + mainSrc.length + ' hasSlider=' + (mainSrc.indexOf('Slider') >= 0) + ' hasEventPool=' + (mainSrc.indexOf('EventPool') >= 0), taskId);

    // FIX: Image → Slider for CreateProgressBar (it returns Slider, not Image)
    // AI prompt incorrectly said "returns Image" causing AI to use Image type
    if (mainSrc.indexOf('Image') >= 0 && mainSrc.indexOf('CreateProgressBar') >= 0) {
      // Find lines where Image var is assigned from CreateProgressBar and fix to Slider
      var fixedLines = mainSrc.split('\n');
      var imgFixCount = 0;
      for (var fi = 0; fi < fixedLines.length; fi++) {
        if (fixedLines[fi].indexOf('CreateProgressBar') >= 0 && fixedLines[fi].indexOf('Image') >= 0) {
          fixedLines[fi] = fixedLines[fi].replace(/\bImage\b/, 'Slider');
          imgFixCount++;
        }
      }
      if (imgFixCount > 0) {
        mainSrc = fixedLines.join('\n');
        fs.writeFileSync(mainFile, mainSrc, 'utf-8');
        log('[coder] Pre-build: Fixed ' + imgFixCount + ' Image→Slider for CreateProgressBar', taskId);
      }
    }
    // Remove any class/struct/enum EventPool definition (AI keeps creating this despite prompt)
    // Use broad regex: any line containing 'class EventPool' or 'struct EventPool' or 'enum EventPool'
    // Nuclear option: rename ALL occurrences of 'EventPool' to 'GFM_EventPool' in AI code
    // This prevents CS0101 regardless of how AI defines/uses EventPool (class, enum, struct, interface, using, etc.)
    if (mainSrc.indexOf('EventPool') >= 0) {
      // Only rename standalone 'EventPool' (not 'EventPoolManager' etc., but DO rename 'EventPool<' etc.)
      mainSrc = mainSrc.replace(/\bEventPool\b/g, 'GFM_EventPool');
      fs.writeFileSync(mainFile, mainSrc, 'utf-8');
      log('[coder] Renamed EventPool→GFM_EventPool in GameFlowManagerMain.cs (prevent CS0101)', taskId);
    }

    // === Pre-build API auto-fix: fix common GFM_UI/GFM_Create call mistakes ===
    var autoFixCount = 0;
    // Re-read after EventPool removal
    mainSrc = fs.readFileSync(mainFile, 'utf-8');
    var lines = mainSrc.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      // Fix: Light.type → comment out (not supported in Luna Bridge.NET)
      if (line.match(/\.\s*type\s*=\s*LightType\b/) || line.match(/\.type\s*=\s*UnityEngine\.LightType/)) {
        lines[li] = '// [AUTO-FIX] ' + line.trim() + ' // Light.type not supported in Luna';
        autoFixCount++;
      }
      // (Slider fix moved to top of pre-build as Image→Slider for CreateProgressBar)
      // Fix: enum EventPool or struct EventPool (not just class)
      if (line.match(/\b(enum|struct)\s+EventPool\b/)) {
        lines[li] = '// [AUTO-FIX] ' + line.trim() + ' // conflicts with template EventPool';
        autoFixCount++;
      }
    }
    if (autoFixCount > 0) {
      fs.writeFileSync(mainFile, lines.join('\n'), 'utf-8');
      log('[coder] Pre-build auto-fixed ' + autoFixCount + ' known issues', taskId);
    }
  }

  var cmd = 'node --max-old-space-size=8192 jake.js -f Jakefile.js --quiet project:build';
  var buildResult;
  // Build env: set PROJECT_PATH and remove proxy vars (proxy on Worker may not exist, causes TLS failures in jake)
  var buildEnv = Object.assign({}, process.env, { PROJECT_PATH: clientDir });
  delete buildEnv.http_proxy; delete buildEnv.https_proxy;
  delete buildEnv.HTTP_PROXY; delete buildEnv.HTTPS_PROXY;
  try {
    execSync(cmd, {
      cwd: PIPELINE_DIR,
      timeout: 180000,
      encoding: 'utf-8',
      env: buildEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    log('[coder] Build passed!', taskId);
    buildResult = { ok: true };
  } catch (e) {
    // Log jake build output for debugging
    var jakeOut = ((e.stdout || '') + '\n' + (e.stderr || '')).trim();
    if (jakeOut) {
      var failLines = jakeOut.split('\n').filter(function(l) { return l.trim().length > 0; }).slice(-10);
      log('[coder] Jake output (last lines): ' + failLines.join(' | '), taskId);
    }

    // MSBuild fallback: if jake Stage3 C# fails but stage1/stage3 exist, assemble stage4 + MSBuild
    var lunaTemp = path.join(clientDir, 'LunaTemp');
    var stage3Dir = path.join(lunaTemp, 'stage3');
    var stage4Dir = path.join(lunaTemp, 'stage4', 'develop');
    if (fs.existsSync(path.join(lunaTemp, 'stage1')) && fs.existsSync(stage3Dir)) {
      log('[coder] Jake Stage3 failed — trying MSBuild fallback with stage4 assembly...', taskId);

      // Assemble stage4
      var cpDirFn = function cpD(s,d){fs.mkdirSync(d,{recursive:true});for(var en of fs.readdirSync(s,{withFileTypes:true})){var a=path.join(s,en.name),b=path.join(d,en.name);if(en.isDirectory())cpD(a,b);else fs.copyFileSync(a,b);}};
      fs.mkdirSync(stage4Dir, {recursive:true});
      var lunaEngDir = path.join(PIPELINE_DIR, '..', 'engine', 'luna');
      if (fs.existsSync(lunaEngDir)) cpDirFn(lunaEngDir, path.join(stage4Dir, 'engine', 'luna'));
      var binDir = path.join(PIPELINE_DIR, 'templates', 'LunaCompiler', 'bin');
      var ubDir = path.join(stage4Dir, 'engine', 'unity', 'bin');
      fs.mkdirSync(ubDir, {recursive:true});
      if (fs.existsSync(binDir)) fs.readdirSync(binDir).forEach(function(f){if(f.endsWith('.js'))fs.copyFileSync(path.join(binDir,f),path.join(ubDir,f));});
      if (fs.existsSync(path.join(stage3Dir,'assets'))) cpDirFn(path.join(stage3Dir,'assets'), path.join(stage4Dir,'assets'));
      if (fs.existsSync(path.join(stage3Dir,'js'))) cpDirFn(path.join(stage3Dir,'js'), path.join(stage4Dir,'js'));
      if (fs.existsSync(path.join(clientDir,'luna.json'))) fs.copyFileSync(path.join(clientDir,'luna.json'), path.join(stage4Dir,'luna.json'));
      // iframe from luna-copy
      var lcIframe = path.join(path.dirname(clientDir), 'luna-copy', 'iframe.html');
      if (fs.existsSync(lcIframe)) {
        var ih = fs.readFileSync(lcIframe,'utf-8').replace(/(src|href)="([^"]+)"/g,function(m,a,p){return a+'="'+p.replace(/\\/g,'/')+'"';});
        fs.writeFileSync(path.join(stage4Dir,'iframe.html'), ih);
      }

      // EventPool.cs and Event.cs — DO NOT modify (partial class pair, see pre-build comment)

      // MSBuild compile
      var MSBUILD = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe';
      var CSPROJ = path.join(PIPELINE_DIR, 'templates', 'LunaCompiler', 'Scripts', 'Scripts.csproj');
      var objDir = path.join(path.dirname(CSPROJ), 'obj');
      try { fs.rmSync(objDir, {recursive:true,force:true}); } catch(ex){}
      try {
        execSync('"' + MSBUILD + '" "' + CSPROJ + '" /t:Rebuild /v:minimal', {env:buildEnv, timeout:60000, encoding:'utf-8'});
        var compiledJs = path.join(PIPELINE_DIR, 'templates', 'LunaCompiler', 'bin', 'UnityScriptsCompiler.js');
        if (fs.existsSync(compiledJs)) {
          fs.copyFileSync(compiledJs, path.join(ubDir, 'UnityScriptsCompiler.js'));
          log('[coder] MSBuild OK — stage4 assembled with fresh JS', taskId);
          buildResult = { ok: true };
        } else {
          buildResult = { ok: false, errors: ['MSBuild succeeded but no output JS'] };
        }
      } catch(msbErr) {
        var msbOut = (msbErr.stdout || '') + (msbErr.stderr || '');
        var csErrors = msbOut.split('\n').filter(function(l){return l.includes('error CS');}).slice(0,10);
        log('[coder] MSBuild also failed: ' + csErrors.length + ' errors', taskId);
        buildResult = { ok: false, errors: csErrors.length > 0 ? csErrors.map(function(l){return l.trim();}) : extractDiagnosticErrors(clientDir) };
      }
    } else {
      // Read diagnostics JSON for actual errors
      var errors = extractDiagnosticErrors(clientDir);
      log('[coder] Build failed: ' + errors.length + ' fatal errors', taskId);
      buildResult = { ok: false, errors: errors };
    }
  }

  // Restore stubbed files
  stubBackups.forEach(function(b) {
    try { fs.writeFileSync(b.path, b.original, 'utf-8'); } catch(e) {}
  });

  return buildResult;
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
          // Skip errors from hidden (temporarily excluded) dirs — AI cannot fix these
          if (rel.indexOf('_hidden_') >= 0) continue;
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

  // V4/V5 entity-driven architecture (V3 removed)
  if (!blueprint.entities || !Array.isArray(blueprint.entities) || blueprint.entities.length === 0) {
    throw new Error('Blueprint has no entities - V3 format not supported');
  }
  log('[coder] V4 entity-driven blueprint detected (' + blueprint.entities.length + ' entities, ' + (blueprint.phases || []).length + ' phases)', taskId);
  return generateCodeV4(blueprint, clientDir, log, taskId, engine);
}

// ============ Helpers ============

function writeFiles(clientDir, files, log, taskId) {
  // Build map of class->path from Assets/Program to detect duplicates
  var programClassMap = {};
  var programDir = path.join(clientDir, 'Assets', 'Program');
  if (fs.existsSync(programDir)) {
    var pFiles = listCsFiles(programDir);
    for (var p = 0; p < pFiles.length; p++) {
      var bn = path.basename(pFiles[p], '.cs');
      programClassMap[bn] = path.relative(clientDir, pFiles[p]).replace(/\\/g, '/');
    }
  }

  for (var i = 0; i < files.length; i++) {
    var fp = files[i].path;
    // If writing to Assets/Scripts/ but same filename exists in Assets/Program/Manager or Controllers or UI, redirect
    if (fp.indexOf('Assets/Scripts/') === 0) {
      var className = path.basename(fp, '.cs');
      if (programClassMap[className]) {
        var targetPath = programClassMap[className];
        // Only redirect to Manager/, Controllers/, UI/ — not to deleted dirs (Entities/Utilities/AStar)
        if (targetPath.indexOf('/Manager/') >= 0 || targetPath.indexOf('/Controllers/') >= 0 || targetPath.indexOf('/UI/') >= 0) {
          log('[coder] Redirecting ' + fp + ' → ' + targetPath, taskId);
          fp = targetPath;
          files[i].path = fp;
        }
      }
    }
    // Block writes to hidden dirs only
    if (fp.indexOf('_hidden_') >= 0) {
      log('[coder] BLOCKED (hidden dir): ' + fp, taskId);
      continue;
    }
    var fullPath = path.join(clientDir, fp);
    var dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Colors: AI is free to use any color. No auto-replacement.
    var content = files[i].content;
    fs.writeFileSync(fullPath, content, 'utf-8');
    log('[coder] Written: ' + fp, taskId);
  }

  // After writing, clean Assets/Scripts/ of any files that duplicate Assets/Program/ classes
  var scriptsDir = path.join(clientDir, 'Assets', 'Scripts');
  if (fs.existsSync(scriptsDir)) {
    var sFiles = listCsFiles(scriptsDir);
    for (var s = 0; s < sFiles.length; s++) {
      var sName = path.basename(sFiles[s], '.cs');
      if (programClassMap[sName]) {
        try { fs.unlinkSync(sFiles[s]); log('[coder] Removed duplicate: Assets/Scripts/' + sName + '.cs', taskId); } catch(e) {}
      }
    }
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
      var knownProgram = ['GameFlowManagerMain','StateManager','Player','Boss','Npc','UIManager','CameraManager','LunaManager','MainPanel','TouchArea','YangJoystick'];
      var className = cm ? cm[1] : 'Script' + idx;
      var targetPath = 'Assets/Scripts/' + className + '.cs';
      if (knownProgram.indexOf(className) !== -1) {
        // Map to correct Program path
        var programPaths = {
          'GameFlowManagerMain': 'Assets/Program/Script/Manager/GameFlowManagerMain.cs',
          'StateManager': 'Assets/Program/Script/Manager/GameFlowManagerMain.cs',
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

// Read existing project code as context for LLM — ONLY utility classes AI can call
function readProjectContext(clientDir) {
  var MAX_CONTEXT_CHARS = 20000;
  var parts = [];
  var totalChars = 0;

  // Only include utility files that AI can actually call (from keepFiles list)
  var utilityFiles = [
    'PoolManager.cs', 'AudioManager.cs', 'SimpleAudioManager.cs', 'SimpleAudioManagerMain.cs',
    'CTAManager.cs', 'LunaManager.cs', 'GameConstants.cs', 'GameData.cs',
    'MonoSingleton.cs', 'BasicExtensions.cs', 'ReturnPool.cs',
    'ImageSeqAni.cs', 'SpriteRendererSeqAni.cs',
    'YangJoystick.cs', 'TouchArea.cs',
    'EventManager.cs', 'Event.cs', 'EventPool.cs', 'GameEventArgs.cs'
  ];

  var programDir = path.join(clientDir, 'Assets', 'Program');
  if (!fs.existsSync(programDir)) return { context: '', fileList: '' };

  var allCsFiles = listCsFiles(programDir);
  var utilFiles = [];
  var fileListParts = [];

  for (var i = 0; i < allCsFiles.length; i++) {
    var baseName = path.basename(allCsFiles[i]);
    var rel = path.relative(clientDir, allCsFiles[i]).replace(/\\/g, '/');
    fileListParts.push(rel);

    if (utilityFiles.indexOf(baseName) >= 0) {
      utilFiles.push({ path: allCsFiles[i], rel: rel });
    }
  }

  // Include full content of utility files only
  for (var u = 0; u < utilFiles.length; u++) {
    try {
      var content = fs.readFileSync(utilFiles[u].path, 'utf-8');
      if (totalChars + content.length > MAX_CONTEXT_CHARS) continue;
      parts.push('```csharp:' + utilFiles[u].rel + '\n' + content + '\n```');
      totalChars += content.length;
    } catch (e) {}
  }

  return { context: parts.join('\n\n'), fileList: fileListParts.join('\n') };
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

// =====================================================================
// V4 实体驱动架构 - 代码生成
// =====================================================================

var promptV4Module = require('./prompt-v4.js');
var promptV5Module = require('./prompt-v5-basetemplate.js');

async function generateCodeV5(blueprint, clientDir, log, taskId, engine) {
  var isCocos = engine === 'cocos';
  if (isCocos) {
    log('[coder] V5 base template not supported for Cocos, falling back to V4', taskId);
    return generateCodeV4(blueprint, clientDir, log, taskId, engine);
  }
  var hasFeedback = blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0;

  // 生成 V5 prompt（基础样例工程模式）
  var opts = {};
  if (hasFeedback) {
    opts.feedback = blueprint.feedbackHistory;
    var mainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    if (fs.existsSync(mainFile)) {
      opts.existingCode = fs.readFileSync(mainFile, 'utf-8');
    }
    var sysFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.Systems.cs');
    if (fs.existsSync(sysFile)) {
      opts.existingSystemsCode = fs.readFileSync(sysFile, 'utf-8');
    }
  }
  var prompt = promptV5Module.parseBlueprintToPromptV5(blueprint, opts);

  log('[coder] V5 BASE TEMPLATE prompt: ' + prompt.length + ' chars, ' + (hasFeedback ? 'INCREMENTAL FIX' : 'FULL GENERATION'), taskId);

  // V5 System Prompt — 简洁版，强调 Find+Move
  var sysPrompt = 'You are a Luna playable ad developer using the BASE TEMPLATE approach.\n'
    + 'The Unity scene already contains 242 pre-built 3D objects. You do NOT create objects.\n\n'
    + 'YOUR APPROACH:\n'
    + '1. GameObject.Find("Name") to get object references in Start()\n'
    + '2. transform.position = new Vector3(x,y,z) to show objects\n'
    + '3. transform.position = new Vector3(0,-999,0) to hide objects\n'
    + '4. Colors are pre-baked into pool names (__Pool_Cube_Red_01) — no SetColor() needed\n'
    + '5. Instantiate(obj) if you need more copies of an object\n'
    + '6. Write game logic (interactions, collisions, flow control)\n\n'
    + 'CRITICAL RULES:\n'
    + '- ALL code in ONE file: GameFlowManagerMain.cs\n'
    + '- Do NOT use GFM_Create.Obj() or CreatePrimitive() — objects already exist\n'
    + '- Do NOT use GFM_UI.CreateCanvas() — Canvas already exists\n'
    + '- NO generics (no List<T>), use plain arrays\n'
    + '- NO coroutines/async/await — use Update() + timer pattern\n'
    + '- NO LINQ, NO System.Linq\n'
    + '- Hide with position y=-999, NOT SetActive(false)\n'
    + '- Game end: Luna.Unity.LifeCycle.GameEnded(); then ShowCTA()\n'
    + '- CTA: Luna.Unity.Playable.InstallFullGame()\n'
    + '- Collision detection: Vector3.Distance(a.position, b.position) < radius\n'
    + '- Do NOT define class EventPool (conflicts with template)\n'
    + '- Do NOT use transform.parent / SetParent / FindObjectOfType\n'
    + '- Do NOT use generic methods: GetComponent<T>(), Resources.GetBuiltinResource<T>(), FindObjectOfType<T>()\n'
    + '- Instead use: (T)GetComponent(typeof(T)), (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf")\n\n'
    + 'CUA VERIFICATION HOOK (MANDATORY):\n'
    + 'You MUST expose game state for automated testing. Add this in your Update() or state-change logic:\n'
    + '```\n'
    + 'private void UpdateGameState() {\n'
    + '  var state = new System.Collections.Generic.Dictionary<string, object>();\n'
    + '  state["currentPhase"] = currentPhaseName; // string: current phase name\n'
    + '  state["completedPhases"] = completedPhasesList; // string[] of completed phase names\n'
    + '  state["entityStates"] = entityStatesDict; // Dict<string,string>: entity name → state\n'
    + '  state["variables"] = variablesDict; // Dict<string,float>: variable name → value\n'
    + '  // Serialize to JSON and expose on window\n'
    + '  string json = Newtonsoft.Json.JsonConvert.SerializeObject(state);\n'
    + '  UnityEngine.Application.ExternalEval("window.__gameState=" + json);\n'
    + '}\n'
    + '```\n'
    + 'Call UpdateGameState() whenever phase changes, entities are created/destroyed, or key variables change.\n'
    + 'This is required for CUA automated testing to verify blueprint flow coverage.\n'
    + 'For signals that are ambiguous in before/after snapshots (resource spend/gain, upgrade level changes, camera changes, near-target arrival, source consumed/hidden, HP drops), also export explicit per-phase evidence.\n'
    + 'Preferred format:\n'
    + '- state["phaseEvidence"] = { "phaseId": { "signal_id": true | number | { delta, before, after, distance, changed, consumed } } }\n'
    + '- or flatten into variables with keys like:\n'
    + '  variables["evidence.upgradeOurBase.resource_decremented"] = 1\n'
    + '  variables["evidence.dispatchAstronautAttack.distance_to_target_below_threshold.distance"] = 1.2\n'
    + '  variables["evidence.recycleDebrisGetGold.source_hidden_or_moved"] = 1\n'
    + 'Only write evidence when the signal truly happens, and scope it to the current phase.\n';

  // === Spec System: Extract specs + generate skeleton (if storyboard frames available) ===
  var skeleton = null;
  var specs = null;
  var storyboardFrames = (blueprint.storyboard && blueprint.storyboard.frames && blueprint.storyboard.frames.length > 0)
    ? blueprint.storyboard.frames
    : (blueprint.storyboardFrames && blueprint.storyboardFrames.length > 0 ? blueprint.storyboardFrames : null);
  if (!hasFeedback && specExtractor && skeletonGenerator && storyboardFrames) {
    try {
      log('[coder] V5 Spec: extracting specs from ' + storyboardFrames.length + ' storyboard frames...', taskId);
      specs = await specExtractor.extractSpecs(storyboardFrames, {
        projectName: blueprint.projectName || taskId,
        gameType: blueprint.gameType || 'SLG',
        entities: blueprint.entities || [],
      });
      log('[coder] V5 Spec: extracted ' + specs.length + ' phase specs', taskId);

      // Save specs for CUA verification later
      // Save specs locally on Worker — CUA verify also runs on Worker, reads from same path
      var specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
      specExtractor.saveSpecs(specs, taskId, specsDataDir);

      // Generate skeleton with entity→pool mapping
      var entityPoolMap = {};
      if (blueprint.entities && blueprint.entities.length > 0) {
        entityPoolMap = promptV5Module.matchPrefabs(blueprint.entities);
      }
      skeleton = skeletonGenerator.generateSkeleton(specs, {
        projectName: blueprint.projectName || taskId,
        entityPoolMap: entityPoolMap,
        entities: blueprint.entities || []
      });
      log('[coder] V5 Skeleton: generated ' + skeleton.split('\n').length + ' lines', taskId);
    } catch (specErr) {
      log('[coder] V5 Spec extraction failed (non-fatal): ' + specErr.message, taskId);
      skeleton = null;
      specs = null;
    }
  }

  var userMsg = prompt;
  if (hasFeedback) {
    userMsg = '## INCREMENTAL FIX MODE\n\n'
      + '⚠️ This is a FIX request. Preserve existing code structure, only modify what feedback requires.\n\n'
      + userMsg;
  }

  // If skeleton available, inject it into the prompt
  if (skeleton) {
    userMsg += '\n\n## CODE SKELETON (MANDATORY)\n\n'
      + '⚠️ A code skeleton has been generated from the storyboard specs. You MUST:\n'
      + '1. Use this skeleton as the base of your GameFlowManagerMain.cs\n'
      + '2. Fill in all sections marked with TODO comments\n'
      + '3. Do NOT remove or modify lines marked [SKELETON]\n'
      + '4. Do NOT remove phaseTimer checks — they enforce minimum phase dwell time\n'
      + '5. Do NOT change the CheckEventRules() transition conditions\n'
      + '6. You CAN add new methods, variables, and helper functions\n\n'
      + '```csharp\n' + skeleton + '\n```\n';
  }

  userMsg += '\n\nGenerate the COMPLETE GameFlowManagerMain.cs file. '
    + 'Use GameObject.Find() to get pre-built objects. '
    + 'Move objects to show/hide them. Write game logic. '
    + 'Output the file in a ```csharp code block.';

  // V5: 不做 SVN revert 和场景替换！基础场景已经有 242 个对象
  if (!hasFeedback) {
    log('[coder] V5: Skipping SVN revert — base template scene preserved', taskId);
  }

  // Copy GFM toolkit files → Commons/
  try {
    var _gfm5 = require('./gfm-files.cjs');
    _gfm5.copyGfmToProjectDir(clientDir);
    _gfm5.cleanupLegacyGfm(clientDir);
    log('[coder] GFM toolkit files copied to Commons/', taskId);
  } catch(e) {}

  // Call AI
  try {
    var response = await callClaudeWithRetry(sysPrompt, userMsg, 300000, MODEL_GENERATE);
    log('[coder] V5 Generated (' + (response.usage ? response.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

    var files = parseCodeBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks in V5 response' };

    // Write files
    writeFiles(clientDir, files, log, taskId);

    // Post-fix: replace generic method calls that Luna doesn't support
    for (var fi = 0; fi < files.length; fi++) {
      if (files[fi].content) {
        // Fix Resources.GetBuiltinResource<T>("name") -> (T)Resources.GetBuiltinResource(typeof(T), "name")
        files[fi].content = files[fi].content.replace(/Resources\.GetBuiltinResource<(\w+)>\(([^)]+)\)/g, '($1)Resources.GetBuiltinResource(typeof($1), $2)');
        // Fix FindObjectOfType<T>() -> (T)FindObjectOfType(typeof(T))
        files[fi].content = files[fi].content.replace(/FindObjectOfType<(\w+)>\(\)/g, '($1)FindObjectOfType(typeof($1))');
        // Fix GetComponent<T>() -> (T)GetComponent(typeof(T))
        files[fi].content = files[fi].content.replace(/\.GetComponent<(\w+)>\(\)/g, '.GetComponent(typeof($1)) as $1');
      }
    }

    // Re-write files after post-fix
    writeFiles(clientDir, files, log, taskId);
    log('[coder] V5 Post-fix: stripped generic method calls for Luna compatibility', taskId);

    // Verify: V5 checks Find-based approach
    var mainFilePath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    var mainSrc = '';
    if (fs.existsSync(mainFilePath)) {
      mainSrc = fs.readFileSync(mainFilePath, 'utf-8');
    }
    var lineCount = mainSrc.split('\n').length;
    var findCalls = (mainSrc.match(/GameObject\.Find/g) || []).length;
    var gfmCreateCalls = (mainSrc.match(/GFM_Create\.Obj/g) || []).length;
    var hasGameEnded = /GameEnded/.test(mainSrc);

    log('[coder] V5 Verification: ' + lineCount + ' lines, ' + findCalls + ' Find() calls, ' + gfmCreateCalls + ' GFM_Create.Obj() calls (should be 0)', taskId);

    if (gfmCreateCalls > 0) {
      log('[coder] ⚠️ WARNING: AI used GFM_Create.Obj() in V5 mode — should use Find() instead', taskId);
    }
    if (findCalls === 0) {
      log('[coder] ⚠️ WARNING: No GameObject.Find() calls — AI may not be using base template objects', taskId);
    }
    if (!hasGameEnded) {
      log('[coder] ⚠️ WARNING: No GameEnded() call — Luna lifecycle may not end properly', taskId);
    }

    // Restore GFM toolkit files → Commons/
    try {
      var _gfm5r = require('./gfm-files.cjs');
      _gfm5r.copyGfmToProjectDir(clientDir);
      _gfm5r.cleanupLegacyGfm(clientDir);
    } catch(e) {}

    return {
      ok: true,
      skipped: false,
      v5: true,
      entityCount: (blueprint.entities || []).length,
      lineCount: lineCount,
      findCalls: findCalls,
      gfmCreateCalls: gfmCreateCalls
    };
  } catch(e) {
    log('[coder] V5 generation error: ' + e.message, taskId);
    return { ok: false, error: 'V5 generation failed: ' + e.message };
  }
}

async function generateCodeV4(blueprint, clientDir, log, taskId, engine) {
  var isCocos = engine === 'cocos';
  var lang = isCocos ? 'TypeScript' : 'C#';
  var hasFeedback = blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0;

  // 生成 V4 prompt
  var opts = {};
  if (hasFeedback) {
    opts.feedback = blueprint.feedbackHistory;
    // 读取现有代码
    var mainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    if (fs.existsSync(mainFile)) {
      opts.existingCode = fs.readFileSync(mainFile, 'utf-8');
    }
  }
  var prompt = promptV4Module.parseBlueprintToPromptV4(blueprint, opts);

  log('[coder] V4 prompt: ' + prompt.length + ' chars, ' + (hasFeedback ? 'INCREMENTAL FIX' : 'FULL GENERATION'), taskId);

  // 项目上下文
  var projectContext = '';

  // System prompt
  var sysPrompt = 'You are a Luna playable ad developer. You write C# code for Unity projects exported via Luna.\n'
    + 'CRITICAL RULES:\n'
    + '- ALL code in ONE file: GameFlowManagerMain.cs\n'
    + '- V5: var go = GameObject.Find("__Pool_Cube_Red_01"); // Pre-existing pool objects with baked colors\n'
    + '- Legacy: var go = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(x,y,z), new Vector3(sx,sy,sz), "Name");\n'
    + '- GFM_Create.Obj signature: (PrimitiveType type, Vector3 position, Vector3 scale, string name)\n'
    + '- PrimitiveType: Cube, Sphere, Cylinder, Capsule, Quad, Plane\n'
    + '- Ground: var ground = GFM_Create.Ground(width, depth); // 2 params: float width, float depth\n'
    + '- V5: Colors pre-baked into pool names — no SetColor() needed\n'
    + '- Use GameObject.Find("__Pool_Cube_Brown_01") for pre-colored objects\n'
    + '- NO CreatePrimitive, NO Resources.Load, NO async/await, NO coroutines\n'
    + '- Use Update() with event-driven condition checks (not sequential phases)\n'
    + '- NO generics (no List<T>), use plain arrays\n'
    + '- NO SetActive(false) — hide with position = new Vector3(0, -999, 0)\n'
    + '- Joystick: var joystick = GFM_Joystick.Create(canvas, 200f); then in Update: float h = joystick.Horizontal; float v = joystick.Vertical;\n'
    + '- IMPORTANT: There is NO class named "GFM_Tools". Available classes: GFM_Create (3D objects), GFM_Utils (helpers), GFM_UI (ui), GFM_Joystick (joystick), GFM_Audio (sound)\n'
    + '- Game end: Luna.Unity.LifeCycle.GameEnded(); then ShowCTA()\n'
    + '- CTA: Luna.Unity.Playable.InstallFullGame()\n'
    + '- Start() must begin with scene cleanup: destroy all root objects except {"Main Camera","Directional Light","EventSystem","GameManager","__MaterialSource"}\n'
    + '- V5: Pool objects pre-exist with baked colors — no ResetPool/InitMaterialFromScene needed\n'
    + '- Camera: top-down 45° orthographic. Do NOT change.\n'
    + '- Auto-play: if no joystick input for 2s, auto-move player toward current target\n'
    + '- Each entity uses parallel arrays: eGo[], eActive[], eState[], eTimer[], eHP[]\n'
    + '- Entity Update dispatch: for each active entity, call its UpdateXxx() method\n'
    + '- Phase transitions driven by conditions, not time\n';

  if (projectContext) {
    sysPrompt += '\n## Project Context:\n' + projectContext;
  }

  // User prompt
  var userMsg = prompt;
  if (hasFeedback) {
    userMsg = '## INCREMENTAL FIX MODE\n\n'
      + '⚠️ This is a FIX request. Preserve existing code structure, only modify what feedback requires.\n\n'
      + userMsg;
  }

  userMsg += '\n\nGenerate the COMPLETE GameFlowManagerMain.cs file. '
    + 'Use the entity-driven architecture described above. '
    + 'Each entity gets its own UpdateXxx() method. '
    + 'Phase transitions are condition-driven. '
    + 'Output the file in a ```csharp code block.';

  // 清理和准备（复用 V3 的清理逻辑）
  if (!hasFeedback && !isCocos) {
    // Full generation: clean up scripts
    try {
      execSync('svn revert -R Assets/', { cwd: clientDir, timeout: 60000, encoding: 'utf-8' });
      log('[coder] SVN revert OK', taskId);
    } catch(e) { log('[coder] SVN revert warning: ' + e.message, taskId); }

    // Replace scene with empty template
    try {
      var scenesDir = path.join(clientDir, 'Assets', 'Scenes');
      var sceneFiles = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(function(f) { return f.endsWith('.unity'); }) : [];
      var templatePath = path.join(__dirname, 'empty-scene-template.unity');
      if (fs.existsSync(templatePath) && sceneFiles.length > 0) {
        for (var si = 0; si < sceneFiles.length; si++) {
          fs.copyFileSync(templatePath, path.join(scenesDir, sceneFiles[si]));
        }
        log('[coder] Scene cleaned: replaced template with empty scene', taskId);
      }
    } catch(e) {}
  }

  // Copy GFM toolkit files → Commons/
  try {
    var _gfm4 = require('./gfm-files.cjs');
    _gfm4.copyGfmToProjectDir(clientDir);
    _gfm4.cleanupLegacyGfm(clientDir);
    log('[coder] GFM toolkit files copied to Commons/', taskId);
  } catch(e) {}

  // Scan project context
  var contextFileCount = 0;
  try {
    var walk = function(dir, arr) {
      if (!fs.existsSync(dir)) return arr;
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function(e) {
        if (e.isDirectory()) walk(path.join(dir, e.name), arr);
        else if (e.name.endsWith('.cs')) arr.push(path.join(dir, e.name));
      });
      return arr;
    };
    contextFileCount = walk(path.join(clientDir, 'Assets'), []).length;
    log('[coder] Project context: ' + contextFileCount + ' files scanned', taskId);
  } catch(e) {}

  // Call AI
  try {
    var response = await callClaudeWithRetry(sysPrompt, userMsg, 300000, MODEL_GENERATE);
    log('[coder] Generated (' + (response.usage ? response.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

    var parseBlocks = isCocos ? parseCodeBlocksCocos : parseCodeBlocks;
    var files = parseBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks in V4 response' };

    // Write files
    writeFiles(clientDir, files, log, taskId);

    // Verify: check for entity-driven structure
    var mainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    var mainSrc = '';
    if (fs.existsSync(mainFile)) {
      mainSrc = fs.readFileSync(mainFile, 'utf-8');
    }
    var lineCount = mainSrc.split('\n').length;
    var hasPhaseCheck = /CheckPhaseTransition|AdvancePhase|currentPhase/.test(mainSrc);
    var hasEntityArrays = /eGo\[|eActive\[|eState\[/.test(mainSrc);
    var hasGFMCreate = /GFM_Create\.Obj/.test(mainSrc);
    var objectCreations = (mainSrc.match(/GFM_Create\.Obj/g) || []).length;
    var entityCount = blueprint.entities.length;
    var phaseCount = (blueprint.phases || []).length;

    log('[coder] V4 Verification: ' + lineCount + ' lines, ' + objectCreations + ' object creations, phases=' + hasPhaseCheck + ', entityArrays=' + hasEntityArrays + ', GFM_Create=' + hasGFMCreate, taskId);

    // Warnings
    if (!hasGFMCreate) {
      log('[coder] Warning: No GFM_Create.Obj() calls found — AI may have used wrong API', taskId);
    }
    if (!hasPhaseCheck) {
      log('[coder] Warning: No phase transition logic found', taskId);
    }
    var hasGameEnded = /GameEnded/.test(mainSrc);
    if (!hasGameEnded) {
      log('[coder] Warning: No GameEnded() call found — Luna lifecycle may not end properly', taskId);
    }

    // Restore GFM toolkit files → Commons/
    try {
      var _gfm4r = require('./gfm-files.cjs');
      _gfm4r.copyGfmToProjectDir(clientDir);
      _gfm4r.cleanupLegacyGfm(clientDir);
      log('[coder] GFM toolkit files restored to Commons/ (pre-build)', taskId);
    } catch(e) {}

    // Pre-build checks
    var hasSrc = fs.existsSync(mainFile);
    var srcLen = hasSrc ? fs.readFileSync(mainFile, 'utf-8').length : 0;
    var hasSlider = /SliderValue/.test(mainSrc);
    log('[coder] Pre-build mainFile: ' + mainFile + ' exists=' + hasSrc, taskId);
    log('[coder] Pre-build mainSrc length=' + srcLen + ' hasSlider=' + hasSlider, taskId);

    return {
      ok: true,
      skipped: false,
      v4: true,
      entityCount: entityCount,
      phaseCount: phaseCount,
      lineCount: lineCount,
      objectCreations: objectCreations
    };
  } catch(e) {
    log('[coder] V4 generation error: ' + e.message, taskId);
    return { ok: false, error: 'V4 generation failed: ' + e.message };
  }
}

module.exports = { generateCode, generateCodeV4, generateCodeV5, callClaude };

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
