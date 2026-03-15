// Worker Coder v3 — AI coding agent with compile-fix-retry loop
// Uses Luna diagnostics JSON for accurate error extraction

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
const API_BASE = 'https://crs.mindrix.app/api';
const API_KEY = process.env.LLM_API_KEY || 'cr_f891cb1046bf100addfc0bf027cb1b37fafa8cc214e1bdbbe5493e6fa3240e7c';
const MODEL_GENERATE = process.env.LLM_MODEL_GENERATE || 'claude-opus-4-6';
const MODEL_FIX = process.env.LLM_MODEL_FIX || 'claude-opus-4-6';
const MAX_TOKENS = 30000; // Opus max is 32000; leave headroom
const MAX_FIX_ATTEMPTS = 10;  // Keep retrying until fixed (practical upper bound)
const PIPELINE_DIR = process.env.LUNA_PIPELINE || 'D:\\Luna\\pipeline';
const COCOS_EXE = process.env.COCOS_CREATOR || 'D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe';

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
  '## ⛔⛔⛔ ABSOLUTE RULE #1 — READ THIS FIRST ⛔⛔⛔',
  '',
  'ALL visible 3D objects MUST be created using GFM_Create.Obj() or GFM_Create.Ground().',
  'CreatePrimitive() and new GameObject() with mesh/renderer are FORBIDDEN — they produce INVISIBLE objects in Luna WebGL.',
  '',
  'AVAILABLE GFM_ classes (DO NOT invent others): GFM_Create, GFM_UI, GFM_Utils, GFM_Audio, GFM_Pool, GFM_Event, GFM_Luna, GFM_Joystick, GFM_Grid, GFM_Pathfinding, GFM_ReturnTimer.',
  'GFM_Billboard does NOT exist. Do NOT reference any GFM_ class not in this list.',
  'Do NOT modify GFM_Tools.cs — it is a read-only toolkit file.',
  '',
  'In Start(), BEFORE creating any objects, you MUST call:',
  '  GFM_Create.InitMaterialFromScene();',
  '  GFM_Create.ResetPool();',
  '',
  'Then create objects like:',
  '  var cube = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0,1,0), Vector3.one, "MyCube");',
  '  GFM_Create.SetColor(cube, new Color(0.2f, 0.4f, 0.9f));',
  '  var ground = GFM_Create.Ground(20f, 20f);',
  '',
  'If your code does NOT use GFM_Create.Obj(), it WILL be rejected. This is non-negotiable.',
  '',
  '## CRITICAL LUNA CONSTRAINTS',
  '',
  '### Absolutely DO NOT use:',
  '- Do NOT use CreatePrimitive or new Mesh — use GFM_Create.Obj() to get pre-placed scene objects (Luna object pool)',
  '- TileMap, New InputSystem, Terrain (use mesh-based terrain instead)',
  '- Generics (Luna does NOT support generic syntax — use non-generic overloads)',
  '- Resources.GetBuiltinResource<T>() — use (T)Resources.GetBuiltinResource(typeof(T), name) instead',
  '- C# 7.0+ syntax (no tuples, pattern matching, local functions, etc.)',
  '- Multi-threading (web does not support threads)',
  '- SceneManager (scene transitions = SetActive on parent GameObjects)',
  '- Resources.Load, AssetBundle, async/await, Task, LINQ',
  '- Animation component (use Animator instead)',
  '- TextMeshPro / TMPro (use UnityEngine.UI.Text instead; for font use: (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf"))',
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
  '- GFM_Create.Obj() fetches from this pool, moves to position, and assigns material automatically.',
  '```csharp',
  'void Start() {',
  '    GFM_Create.ResetPool();  // MUST call first — resets pool counters',
  '    GFM_Create.InitMaterialFromScene();  // Init base material from __MaterialSource',
  '    // Create objects using pool (Luna-compatible!):',
  '    var cube = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0, 1, 0), Vector3.one, "MyCube");',
  '    var sphere = GFM_Create.Obj(PrimitiveType.Sphere, new Vector3(3, 1, 0), Vector3.one * 0.5f, "Ball");',
  '    var ground = GFM_Create.Ground(20f, 20f);  // Creates a ground plane',
  '    // To hide an object: move it offscreen',
  '    cube.transform.position = new Vector3(0, -9999, 0);',
  '}',
  '```',
  '- Pool limits: Cube=50, Sphere=20, Plane=10, Cylinder=10. Plan your objects within these limits.',
  '- GFM_Create.SetColor(obj, new Color(r, g, b)) — MANDATORY: use the color palette: player=blue(0.2f,0.4f,0.9f), ground=brown(0.35f,0.25f,0.15f), buildings=tan(0.85f,0.7f,0.4f), enemies=red(0.85f,0.15f,0.15f), trees=green(0.1f,0.55f,0.1f), turrets=gray(0.5f,0.5f,0.55f). Set _mainCam.backgroundColor=new Color(0.6f,0.8f,1f).',
  '- NEVER use Shader.Find() or new Material(shader) directly',
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
  '#### In Start(), grab material from __MaterialSource, then create your content:',
  '```csharp',
  '// Grab material from the hidden __MaterialSource object',
  'var matSource = GameObject.Find("__MaterialSource");',
  'if (matSource != null) {',
  '    var r = matSource.GetComponent<Renderer>();',
  '    if (r != null) _baseMat = new Material(r.sharedMaterial);',
  '} else {',
  '    var anyRenderer = Object.FindObjectOfType<Renderer>();',
  '    if (anyRenderer != null) _baseMat = new Material(anyRenderer.sharedMaterial);',
  '}',
  'if (_baseMat == null) _baseMat = new Material(Shader.Find("Standard"));',
  'if (_baseMat != null) { _baseMat.mainTexture = null; }',
  '',
  '// _baseMat is the base material. Use GFM_Create.SetColor(obj, color) to set distinct colors per object.',
  '',
  '// Scene is clean — start creating your game objects directly',
  '// No need to hide template objects (scene only has Camera, Light, EventSystem)',
  '```',
  '',
  '#### Then create your game world from code:',
  '- 3D objects: `GFM_Create.Obj(PrimitiveType.Cube/Sphere/Plane, pos, scale, "name")` (from scene pool)',
  '- UI: `new GameObject("Btn", typeof(RectTransform), typeof(Image), typeof(Button))`',
  '- Text: `var t = new GameObject("Lbl", typeof(RectTransform)).AddComponent<UnityEngine.UI.Text>();`',
  '- Font: `t.font = (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf");`',
  '- Materials: `new Material(_baseMat)` — _baseMat grabbed from scene renderer in Start() (see Material handling section)',
  '- Canvas: create with CanvasScaler (1080x1920) + GraphicRaycaster',
  '',
  '#### MANDATORY: Auto-Play for QA Testing',
  '- Every shot that requires player movement MUST include auto-play fallback logic.',
  '- Add a private float `_autoPlayTimer = 0f;` field and a private float `_autoPlayDelay = 2f;` field.',
  '- In Update(), after joystick handling, add auto-play logic:',
  '```csharp',
  '// Auto-play: if no joystick input for 2 seconds, auto-move player toward guide',
  'if (_joystickDir.magnitude < 0.1f && _guideArrow != null && _player != null) {',
  '    _autoPlayTimer += Time.deltaTime;',
  '    if (_autoPlayTimer > _autoPlayDelay) {',
  '        Vector3 dir = _guideArrow.transform.position - _player.transform.position;',
  '        dir.y = 0;',
  '        if (dir.magnitude > 1f) {',
  '            _player.transform.position += dir.normalized * _playerSpeed * Time.deltaTime;',
  '            _player.transform.forward = dir.normalized;',
  '        }',
  '    }',
  '} else {',
  '    _autoPlayTimer = 0f;',
  '}',
  '```',
  '- Also, make the joystick activation zone larger — use the FULL left half of the screen, not just bottom-left quarter:',
  '  `if (mousePos.x < Screen.width * 0.5f)` (remove the mousePos.y check)',
  '- This ensures automated QA testing can verify all shots even without perfect input.',
  '',
  '#### MANDATORY: Create ALL Scene Objects from Blueprint',
  '- Every single object mentioned in the blueprint/storyboard MUST be created as a 3D object in the scene.',
  '- This includes: buildings, turrets, trees, resources, NPCs, vehicles, conveyor belts, generators, walls, decorations.',
  '- Use GFM_Create.Obj(PrimitiveType.Cube/Sphere/Cylinder, pos, scale, "label") for each visible object. Call GFM_Create.ResetPool() + GFM_Create.InitMaterialFromScene() at Start().',
  '- Different object types should use different primitive shapes:',
  '  - Buildings/structures: Cube (scaled appropriately)',
  '  - Trees/plants: Cylinder (tall thin) + Sphere (on top as crown)',
  '  - Characters/NPCs: Capsule',
  '  - Resources/items: Sphere (small)',
  '  - Vehicles/machines: Cube (wide low)',
  '- Scale objects to reasonable sizes (buildings 3-5 units, trees 4-6 units, player 2 units)',
  '- Position objects in a logical spatial layout, spread out, not all at origin',
  '- Use DIFFERENT colored materials for categories (via new Material(_baseMat)):',
  '  - Buildings: brown Color(0.6f,0.4f,0.2f), Trees: green Color(0.2f,0.6f,0.2f)',
  '  - Resources: yellow Color(0.8f,0.7f,0.2f), Player: blue Color(0.3f,0.3f,0.8f)',
  '  - Enemies: red Color(0.8f,0.2f,0.2f)',
  '- If a shot says click X or drag X, X MUST exist as a visible object with a Collider',
  '- Objects for later shots: create initially with SetActive(false), activate when needed',
  '- Scene must look like a populated game world, NOT an empty void with just a player',
  '',
  '#### MANDATORY: Text Labels on Interactive Objects',
  '- You MUST add floating text labels above every key interactive object (buildings, turrets, NPCs, blueprints, etc.) so CUA can identify them',
  '- Create a WorldSpace Canvas for each labeled object:',
  '```csharp',
  'void AddLabel(GameObject target, string text) {',
  '    var labelObj = new GameObject("Label_" + text);',
  '    var canvas = labelObj.AddComponent<Canvas>();',
  '    canvas.renderMode = RenderMode.WorldSpace;',
  '    canvas.transform.SetParent(target.transform, false);',
  '    canvas.transform.localPosition = new Vector3(0, 1.5f, 0);',
  '    canvas.transform.localScale = new Vector3(0.02f, 0.02f, 0.02f);',
  '    canvas.GetComponent<RectTransform>().sizeDelta = new Vector2(200, 50);',
  '    var textComp = new GameObject("Text").AddComponent<UnityEngine.UI.Text>();',
  '    textComp.transform.SetParent(canvas.transform, false);',
  '    textComp.GetComponent<RectTransform>().sizeDelta = new Vector2(200, 50);',
  '    textComp.text = text;',
  '    textComp.font = (Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf");',
  '    textComp.fontSize = 24;',
  '    textComp.color = Color.white;',
  '    textComp.alignment = TextAnchor.MiddleCenter;',
  '}',
  '```',
  '- Call AddLabel for every building, turret, blueprint, NPC, resource pile, etc.',
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
  '        case 1: // Wait for player to reach target (auto-play handles movement)',
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
  '- Do NOT redefine ANY class. All utility code is in GFM_Tools.cs (GFM_ prefix). Use them as-is.',
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
  '- GFM_Create.InitMaterialFromScene() / .Obj(type, pos, scale, label) / .Ground(w, d) / .SetColor(obj, color)',
  '- GFM_UI.CreateCanvas(w, h) / .CreateButton(canvas, text, pos, size, onClick) / .CreateText(canvas, text, pos, fs)',
  '- GFM_UI.AddWorldLabel(obj, text, height) / .CreateProgressBar(canvas, pos, size, color)',
  '- GFM_Audio.Init(go) / .instance.PlaySFX(clip) / .PlayBGM(clip) / .PlayPitch(clip, idx)',
  '- GFM_Pool.Init(go) / .Preload(prefab, n) / .Get(prefab) / .Return(obj) / .ReturnAfter(obj, delay)',
  '- GFM_Event.Init(go) / .Subscribe(id, handler) / .Fire(id, sender, data) / .FireNow(...) / .Unsubscribe(id, h)',
  '- GFM_Utils.IsInRange(dist, a, b, inclY) / .IsOnScreen(tf) / .FindClosestByTag(origin, tag, maxD)',
  '- GFM_Joystick.Create(canvas, size) — .Horizontal / .Vertical / .Direction / .IsDragging',
  '- GFM_Luna.Init(go) / .GameOver() / .GotoStore() / .IsGameOver()',
  '',
  'CRITICAL: Do NOT define classes named AudioManager, PoolManager, EventManager, EventPool,',
  'BasicExtensions, MonoSingleton, Player, Boss, Npc, LunaManager, CTAManager, etc.',
  'Use the GFM_ equivalents. All utility logic is in GFM_Tools.cs.',
  '',
  'Generate code that implements the blueprint faithfully and completely.'
].join('\n');

var FIX_PROMPT = [
  'You are fixing Unity C# compilation errors for a Luna SDK playable ad project.',
  'Luna transpiles C# to JavaScript — many Unity features cause compilation failures.',
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
  '- NO Resources.GetBuiltinResource (not implemented in Luna — create manually)',
  '- NO Sprite.Create from code (use UI.Image with color, or GFM_Create.Obj for 3D)',
  '- NO UnityEngine.Random.Range with int overload ambiguity (cast explicitly)',
  '- NO nested generic types or generic method calls',
  '- NO optional parameters with default values in some contexts (use overloads)',
  '- NO nameof() operator',
  '- NO null-conditional ?. or null-coalescing ?? operators',
  '- GetComponent<Transform>() and GetComponent<RectTransform>() are NOT interchangeable',
  '- DOTween chain calls must be on separate lines to avoid JS transpilation bugs',
  '- Use Luna.Unity.Playable.InstallFullGame() instead of Application.OpenURL',
  '- Must call Luna.Unity.LifeCycle.GameEnded() when game ends',
  '- Do NOT use [RuntimeInitializeOnLoadMethod] — Luna ignores it',
  '- The main controller script is GameFlowManagerMain.cs — keep its class name `GameFlowManagerMain`',
  '- The scene is CLEAN — all game objects are created from code, do NOT use GameObject.Find() for template objects',
  '- Materials: grab from __MaterialSource: `var ms = GameObject.Find("__MaterialSource"); _baseMat = new Material(ms.GetComponent<Renderer>().sharedMaterial); _baseMat.mainTexture = null;`',
  '- GFM_Create.Obj() auto-assigns base material. Use GFM_Create.SetColor(obj, color) to give each object a distinct color.',
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
  '- For Font: use `(Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf")` — no generics',
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
            if (m[1] === 'class') stub += 'public class ' + m[2] + ' : MonoBehaviour { }\n';
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

  // MANDATORY: Restore original GFM_Tools.cs before every build
  // AI fix attempts may overwrite it with broken versions
  var gfmSrcBuild = path.join(path.dirname(__filename), 'GFM_Tools.cs');
  var gfmDstBuild = path.join(clientDir, 'Assets', 'Program', 'Script', 'GFM_Tools.cs');
  if (fs.existsSync(gfmSrcBuild)) {
    fs.copyFileSync(gfmSrcBuild, gfmDstBuild);
    log('[coder] GFM_Tools.cs restored from original (pre-build)', taskId);
  }

  // EventPool.cs and Event.cs are template files — DO NOT modify them.
  // They are partial classes that depend on each other. Previous approach of stubbing/removing
  // references broke Event.cs syntax (CS1022). AI prompt forbids defining EventPool class.
  // If AI creates its own EventPool class → CS0101 will be caught by compile-fix loop.

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

  var parsed = parseBlueprintToPrompt(blueprint);
  if (!parsed) {
    log('[coder] Empty blueprint, skipping', taskId);
    return { ok: true, skipped: true, message: 'Empty blueprint' };
  }

  // Check if this is an incremental fix (has feedback + existing code)
  var hasFeedbackEarly = blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0;

  log('[coder] ' + (hasFeedbackEarly ? 'INCREMENTAL FIX' : 'FULL GENERATION') + ' — ' + parsed.scenes.length + ' scenes', taskId);

  // Clean up scripts ONLY for full generation — incremental fix preserves existing code
  if (!isCocos && !hasFeedbackEarly) {
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
    // Also clean Assets/Editor (AI sometimes creates Editor scripts)
    var editorDir = path.join(clientDir, 'Assets', 'Editor');
    if (fs.existsSync(editorDir)) {
      var edFiles = listCsFiles(editorDir);
      edFiles.forEach(function(f) { try { fs.unlinkSync(f); } catch(e) {} });
    }
    // Clean AI-created subdirs in Assets/Program/Script/ that shouldn't exist
    var programScript = path.join(clientDir, 'Assets', 'Program', 'Script');
    var allowedProgramDirs = ['AStar', 'Controllers', 'Entities', 'Manager', 'UI', 'Utilities'];
    if (fs.existsSync(programScript)) {
      try {
        var pEntries = fs.readdirSync(programScript, { withFileTypes: true });
        pEntries.forEach(function(e) {
          if (e.isDirectory() && allowedProgramDirs.indexOf(e.name) === -1) {
            var dp = path.join(programScript, e.name);
            log('[coder] Removing stale AI dir: Program/Script/' + e.name, taskId);
            try { fs.rmSync(dp, { recursive: true, force: true }); } catch(x) {}
          }
        });
      } catch(e) {}
      // Also remove AI-created .cs files in Program/Script/UI/ that aren't original
      var uiDir = path.join(programScript, 'UI');
      var originalUI = ['MainPanel.cs', 'TouchArea.cs', 'YangJoystick.cs'];
      if (fs.existsSync(uiDir)) {
        try {
          fs.readdirSync(uiDir).forEach(function(f) {
            if (f.endsWith('.cs') && originalUI.indexOf(f) === -1) {
              log('[coder] Removing stale UI file: ' + f, taskId);
              try { fs.unlinkSync(path.join(uiDir, f)); } catch(x) {}
            }
          });
        } catch(e) {}
      }
    }
    // NUCLEAR RESET: SVN revert ALL Assets (not just Program) + delete ALL untracked files
    // This ensures zero contamination between tasks
    try {
      execSync('svn revert -R Assets/', { cwd: clientDir, timeout: 60000, encoding: 'utf-8' });
      log('[coder] SVN revert -R Assets/ OK (full reset)', taskId);
    } catch(e) { log('[coder] SVN revert warning: ' + e.message, taskId); }
    // Delete ALL untracked files (? status) — not just .cs, EVERYTHING
    try {
      var svnFull = execSync('svn status Assets/', { cwd: clientDir, timeout: 15000, encoding: 'utf-8' });
      var untrackedAll = svnFull.split('\n').filter(function(l) { return l.startsWith('?'); });
      var nukeCount = 0;
      untrackedAll.forEach(function(l) {
        var fp = l.replace(/^\?\s+/, '').trim();
        if (!fp) return;
        // Keep GameFlowManagerMain.cs and GFM_Tools.cs (will be recreated anyway)
        if (fp.indexOf('GameFlowManagerMain.cs') >= 0) return;
        if (fp.indexOf('GFM_Tools.cs') >= 0) return;
        var fullP = path.join(clientDir, fp);
        try {
          var stat = fs.statSync(fullP);
          if (stat.isDirectory()) { fs.rmSync(fullP, { recursive: true, force: true }); }
          else { fs.unlinkSync(fullP); }
          nukeCount++;
        } catch(ex) {}
      });
      if (nukeCount > 0) log('[coder] Nuked ' + nukeCount + ' untracked items from Assets/', taskId);
    } catch(e) { log('[coder] Untracked cleanup warning: ' + e.message, taskId); }

    // Replace SVN scene with empty-scene-template (pool objects + MaterialSource, no original game objects)
    try {
      var scenesDir = path.join(clientDir, 'Assets', 'Scenes');
      var sceneFiles = fs.existsSync(scenesDir) ? fs.readdirSync(scenesDir).filter(function(f) { return f.endsWith('.unity'); }) : [];
      var templatePath = path.join(path.dirname(require.main ? require.main.filename : __filename), 'empty-scene-template.unity');
      if (!fs.existsSync(templatePath)) templatePath = path.join(__dirname, 'empty-scene-template.unity');
      if (fs.existsSync(templatePath) && sceneFiles.length > 0) {
        for (var si = 0; si < sceneFiles.length; si++) {
          fs.copyFileSync(templatePath, path.join(scenesDir, sceneFiles[si]));
        }
        log('[coder] Replaced ' + sceneFiles.length + ' scene(s) with empty-scene-template', taskId);
      }
    } catch(e) { log('[coder] Scene replacement warning: ' + e.message, taskId); }

    // (Untracked file cleanup now handled by nuclear reset above)

    // Smart stub: keep utility classes, stub game logic, delete AI remnants
    var stubCount = 0, keepCount = 0, deleteCount = 0;

    // Files to KEEP intact (utility/tool classes AI can call)
    var keepFiles = []; // All non-essential files get stubbed
    // Files to DELETE (AI remnants from previous runs — cause duplicate class conflicts)
    var deletePatterns = [
      'StateManagerCleanup', 'StateManagerDuplicateFix', 'StateManagerExtension',
      'StateManagerFontFix', 'StateManagerMethods', 'StateManagerPublicAPI',
      'BlueprintTriggerLogic', 'BlueprintTriggerMain',
      'ConveyorBlueprintTrigger', 'CrossbowBlueprint2Trigger',
      'HouseBlueprintTrigger', 'RecruitButtonTrigger', 'UpgradeButtonTrigger',
      'Script1', 'Script2', 'Script3', 'Script4', 'Script5'
    ];

    function smartStub(dir) {
      if (!fs.existsSync(dir)) return;
      try {
        var entries = fs.readdirSync(dir, { withFileTypes: true });
        for (var i = 0; i < entries.length; i++) {
          var fullP = path.join(dir, entries[i].name);
          if (entries[i].isDirectory()) { smartStub(fullP); continue; }
          if (!entries[i].name.endsWith('.cs')) continue;

          var baseName = entries[i].name.replace('.cs', '');

          // GameFlowManagerMain.cs — AI will rewrite, skip
          if (entries[i].name === 'GameFlowManagerMain.cs') continue;
          if (entries[i].name === 'GFM_Tools.cs') continue;

          // Delete AI remnants
          if (deletePatterns.some(function(p) { return baseName.indexOf(p) >= 0; })) {
            try { fs.unlinkSync(fullP); deleteCount++; } catch(ex) {}
            // Also delete .meta
            try { fs.unlinkSync(fullP + '.meta'); } catch(ex) {}
            continue;
          }

          // Keep utility files intact
          if (keepFiles.indexOf(entries[i].name) >= 0) { keepCount++; continue; }

          // Stub everything else (game logic)
          try {
            var orig = fs.readFileSync(fullP, 'utf-8');
            var classes = orig.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/g) || [];
            var enums = orig.match(/(?:public\s+)?enum\s+(\w+)/g) || [];
            var interfaces = orig.match(/(?:public\s+)?interface\s+(\w+)/g) || [];
            var stub = 'using UnityEngine;\nusing UnityEngine.UI;\nusing System;\nusing System.Collections;\nusing System.Collections.Generic;\n';
            for (var c = 0; c < classes.length; c++) {
              var cn = classes[c].match(/class\s+(\w+)/)[1];
              stub += 'public class ' + cn + ' : MonoBehaviour { }\n';
            }
            for (var e = 0; e < enums.length; e++) {
              var en = enums[e].match(/enum\s+(\w+)/)[1];
              stub += 'public enum ' + en + ' { Default }\n';
            }
            for (var f = 0; f < interfaces.length; f++) {
              var inf = interfaces[f].match(/interface\s+(\w+)/)[1];
              stub += 'public interface ' + inf + ' { }\n';
            }
            if (classes.length === 0 && enums.length === 0 && interfaces.length === 0) stub += '// emptied\n';
            fs.writeFileSync(fullP, stub, 'utf-8');
            stubCount++;
          } catch(ex) {}
        }
      } catch(ex) {}
    }
    smartStub(programScript);
    log('[coder] Smart stub: ' + keepCount + ' kept, ' + stubCount + ' stubbed, ' + deleteCount + ' deleted', taskId);

    log('[coder] Cleanup done', taskId);
  }

  // ALWAYS copy latest GFM_Tools.cs toolkit into project (both full gen and incremental fix)
  var gfmSrc = path.join(path.dirname(__filename), 'GFM_Tools.cs');
  var gfmDst = path.join(clientDir, 'Assets', 'Program', 'Script', 'GFM_Tools.cs');
  if (fs.existsSync(gfmSrc)) {
    fs.copyFileSync(gfmSrc, gfmDst);
    log('[coder] GFM_Tools.cs toolkit copied to project', taskId);
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
    projectSection += '\n\n## TEMPLATE UTILITY SCRIPTS (you can call these, but do NOT copy their game logic):\n'
      + '⚠️ These are UTILITY classes you can reference/call from GameFlowManagerMain.cs.\n'
      + '⚠️ Do NOT copy SLG/idle game logic from them — implement the BLUEPRINT logic instead.\n'
      + '⚠️ Useful utilities: PoolManager (object pooling), AudioManager (sound), etc.\n\n'
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

  // ============ Incremental Fix vs Full Generation ============
  var hasFeedback = blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0;
  var existingCode = readScripts(clientDir);
  var hasExistingCode = existingCode && existingCode.trim().length > 200;
  var isIncrementalFix = hasFeedback && hasExistingCode;

  var userMsg;

  if (isIncrementalFix) {
    // === INCREMENTAL FIX MODE ===
    // Read existing code + feedback, ask AI to do targeted modifications only
    var allFeedback = blueprint.feedbackHistory.map(function(fb, idx) {
      var text = '';
      if (fb.data && fb.data.text) text = fb.data.text;
      else if (typeof fb.data === 'string') text = fb.data;
      else text = JSON.stringify(fb.data);
      return '- Feedback #' + (idx + 1) + ' (' + (fb.status || 'pending') + '): ' + text;
    }).join('\n');

    log('[coder] INCREMENTAL FIX mode — existing code found + ' + blueprint.feedbackHistory.length + ' feedback entries', taskId);

    // GitNexus 代码结构分析（可选增强）
    var gnContext = '';
    if (gnHelper) {
      try {
        await gnHelper.init(clientDir);
        // 从 feedback 提取错误关键词
        var latestFb = blueprint.feedbackHistory[blueprint.feedbackHistory.length - 1];
        var fbText = (latestFb.data && latestFb.data.text) || (typeof latestFb.data === 'string' ? latestFb.data : JSON.stringify(latestFb.data));
        // 提取错误中提到的类名/方法名作为关键词
        var errorKeyword = '';
        var classMatch = fbText.match(/\b([A-Z][a-zA-Z]+(?:Manager|Controller|Handler|System|Helper|UI|Panel|View))\b/);
        if (classMatch) errorKeyword = classMatch[1];
        else {
          var wordMatch = fbText.match(/(?:error|bug|fix|问题|修复|报错)[：:\s]*([^\n,.;]+)/i);
          if (wordMatch) errorKeyword = wordMatch[1].trim().substring(0, 50);
        }
        // 提取可疑文件
        var suspectFiles = [];
        var fileMatches = fbText.match(/\b\w+\.cs\b/g);
        if (fileMatches) suspectFiles = [...new Set(fileMatches)];
        gnContext = await gnHelper.getFixContext(errorKeyword, suspectFiles);
        if (gnContext) {
          log('[coder] GitNexus context: ' + gnContext.length + ' chars', taskId);
        }
        gnHelper.cleanup();
      } catch (e) {
        log('[coder] GitNexus analysis skipped: ' + e.message, taskId);
      }
    }

    userMsg = '## INCREMENTAL FIX MODE\n\n'
      + '⚠️ This is a FIX request, NOT a full regeneration.\n'
      + '⚠️ You MUST preserve the existing code structure and only modify what the feedback requires.\n'
      + '⚠️ Do NOT rewrite the entire file. Make TARGETED changes.\n\n'
      + '## Current Working Code:\n```' + lang + '\n' + existingCode + '\n```\n\n'
      + '## Feedback to Address:\n' + allFeedback + '\n\n'
      + '## Blueprint Reference (for context):\n' + scenesMarkdown + '\n\n'
      + (gnContext ? gnContext + '\n\n' : '')
      + '## Instructions:\n'
      + '1. Read the existing code carefully\n'
      + '2. Identify ONLY the parts that need changing based on feedback\n'
      + '3. Make minimal, targeted modifications\n'
      + '4. Keep all working code intact — do NOT remove or rewrite unrelated sections\n'
      + '5. Output the COMPLETE updated file (with changes applied)\n'
      + '6. The scene MAY contain template objects — Start() MUST begin with cleanup: destroy all root objects except {"Main Camera","Directional Light","EventSystem","GameManager","__MaterialSource"}\n'
      + '7. ⛔ COLOR: Each object type MUST use a DISTINCT color. Player=blue(0.2,0.4,0.9), ground=brown(0.35,0.25,0.15), buildings=tan(0.85,0.7,0.4), enemies=red(0.85,0.15,0.15), trees=green(0.1,0.55,0.1), turrets=gray(0.5,0.5,0.55), workers=orange(0.9,0.6,0.2), camera.backgroundColor=sky blue(0.6,0.8,1). NEVER same color for all objects.\n'
      + '8. ⛔ EXCEPTION TO "minimal changes": If the code uses StartCoroutine/IEnumerator/WaitForSeconds/WaitUntil/yield, you MUST rewrite ALL shot logic as an Update()-based state machine (_currentShot + _shotState + _shotTimer in switch/case). Coroutines do NOT work in Luna WebGL runtime injection.\n'
      + '9. Auto-play: Update() must include auto-play logic — if no joystick input for 2s, auto-move player toward _currentTarget.\n'
      + '10. ⛔ CAMERA: ALL projects use top-down 45° orthographic view. GFM_Tools.EnsureMaterial() auto-sets this. Do NOT change camera to perspective or other angles.\n\n'
      + 'Apply the feedback fixes to the existing code. Preserve everything that works EXCEPT coroutines which must be rewritten.';
  } else {
    // === FULL GENERATION MODE ===
    userMsg = '## Project: ' + parsed.projectName + '\n\n'
      + '## Blueprint Shots (implement ALL of these IN ORDER):\n\n' + scenesMarkdown + '\n\n'
      + '## Shot Transitions (scene flow):\n' + transMarkdown
      + classWarning
      + projectSection
      + parsed.feedbackText
      + '\n\n## IMPORTANT REMINDERS:\n'
      + '1. Start() MUST begin with scene cleanup: destroy all root objects except {"Main Camera","Directional Light","EventSystem","GameManager","__MaterialSource"}\n'
      + '2. ⛔ CRITICAL COLOR RULE: Every object type MUST have a DIFFERENT, HIGH-CONTRAST color. Use this mandatory color palette:\n'
      + '   - Ground/terrain: new Color(0.35f, 0.25f, 0.15f) (dark brown)\n'
      + '   - Player character: new Color(0.2f, 0.4f, 0.9f) (bright blue)\n'
      + '   - Trees trunk: new Color(0.45f, 0.25f, 0.1f) (brown), crown: new Color(0.1f, 0.55f, 0.1f) (green)\n'
      + '   - Buildings/structures: new Color(0.85f, 0.7f, 0.4f) (tan/sandy)\n'
      + '   - Enemies/boss: new Color(0.85f, 0.15f, 0.15f) (red)\n'
      + '   - Turrets/weapons: new Color(0.5f, 0.5f, 0.55f) (steel gray)\n'
      + '   - Wood/resources: new Color(0.6f, 0.35f, 0.1f) (wood brown)\n'
      + '   - UI buttons/highlights: new Color(1f, 0.85f, 0f) (gold yellow)\n'
      + '   - Workers/NPCs: new Color(0.9f, 0.6f, 0.2f) (orange)\n'
      + '   Camera background: new Color(0.6f, 0.8f, 1f) (sky blue) via _mainCam.backgroundColor\n'
      + '   ⛔ CAMERA: ALL projects use top-down 45° orthographic view. GFM_Tools.EnsureMaterial() auto-sets this. Do NOT change camera to perspective or other angles.\n'
      + '   NEVER make all objects the same color. If scene looks uniform, CUA cannot navigate it.\n'
      + '3. BUILD everything using GFM_Create.Obj() for 3D objects (from scene pool), new GameObject for empty parents, UI components for HUD\n'
      + '4. You CAN call utility classes from the template (DOTween, PoolManager, etc.)\n'
      + '5. Do NOT copy SLG/idle game logic — implement the BLUEPRINT logic\n'
      + '6. GameFlowManagerMain.Start() is your entry point\n\n'
      + 'Generate ' + lang + ' code that implements this blueprint EXACTLY from scratch. '
      + 'Every shot must be playable with code-created objects. '
      + 'Create your game world from a clean scene.';
  }

  try {
    var response = await callClaude(sysPrompt, userMsg, 300000, MODEL_GENERATE);
    log('[coder] Generated (' + (response.usage ? response.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

    var files = parseBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks' };
    writeFiles(clientDir, files, log, taskId);

    // Pre-build content check: verify GFM_Create usage BEFORE attempting build
    // This catches the common case where AI ignores GFM_Create.Obj and uses new GameObject/CreatePrimitive
    var preCheck = verifyCodeContent(clientDir, parsed, log, taskId);
    if (!preCheck.ok && preCheck.reason && preCheck.reason.indexOf('GFM_Create') >= 0) {
      log('[coder] ⚠️ Pre-build content check FAILED: ' + preCheck.reason.substring(0, 200), taskId);
      var currentCode = readScripts(clientDir);
      var preFixMsg = '## Pre-Build Content Check FAILED\n'
        + 'Your code has NOT been compiled yet because it fails mandatory checks:\n\n'
        + preCheck.reason + '\n\n'
        + '## Current Code:\n' + currentCode + '\n\n'
        + '## Fix Requirements:\n'
        + '- Replace ALL new GameObject() with GFM_Create.Obj(PrimitiveType.Cube, pos, scale, "label")\n'
        + '- Replace ALL CreatePrimitive() with GFM_Create.Obj()\n'
        + '- Call GFM_Create.InitMaterialFromScene() and GFM_Create.ResetPool() at start of Start()\n'
        + '- Use GFM_Create.Ground(width, depth) for ground planes\n'
        + '- Use GFM_Create.SetColor(obj, color) to color objects\n\n'
        + 'Output the COMPLETE fixed GameFlowManagerMain.cs.';
      var preFixResponse = await callClaude(sysPrompt, preFixMsg, 300000, MODEL_FIX);
      log('[coder] Pre-build fix response (' + (preFixResponse.usage ? preFixResponse.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);
      var preFixFiles = parseBlocks(preFixResponse.text);
      if (preFixFiles.length > 0) {
        var preFixMain = preFixFiles.find(function(f) { return f.path.indexOf('GameFlowManagerMain') >= 0; });
        if (preFixMain) {
          var preFixPath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
          fs.writeFileSync(preFixPath, preFixMain.content);
          log('[coder] Pre-build fix applied', taskId);
        }
      }
    }

    var prevErrorSig = '';
    var sameErrorCount = 0;
    var MAX_COMPILE_ATTEMPTS = MAX_FIX_ATTEMPTS; // compile fix budget (separate from content)
    var MAX_CONTENT_ATTEMPTS = 3; // content fix budget (separate counter)
    var contentFixCount = 0;
    for (var attempt = 1; attempt <= MAX_COMPILE_ATTEMPTS + MAX_CONTENT_ATTEMPTS; attempt++) {
      var result = tryCompile(clientDir, log, taskId);
      
      if (result.ok) {
        log('[coder] ✅ Build passed on attempt ' + attempt, taskId);
        // Content verification — reject skeleton/empty code
        var verification = verifyCodeContent(clientDir, parsed, log, taskId);
        if (!verification.ok) {
          contentFixCount++;
          log('[coder] ⚠️ Content verification FAILED (round ' + contentFixCount + '/' + MAX_CONTENT_ATTEMPTS + '): ' + verification.reason, taskId);
          if (contentFixCount < MAX_CONTENT_ATTEMPTS) {
            var currentCode = readScripts(clientDir);
            var contentFixMsg = '## Content Verification FAILED (round ' + contentFixCount + '/' + MAX_CONTENT_ATTEMPTS + ')\n'
              + 'Your code COMPILED SUCCESSFULLY but failed quality checks:\n\n'
              + verification.reason + '\n\n'
              + '## Current Code (compiles OK):\n' + currentCode + '\n\n'
              + '## Blueprint Requirements:\n' + scenesMarkdown + '\n\n'
              + '## INSTRUCTIONS:\n'
              + '- Keep the code compilable — do NOT introduce new errors\n'
              + '- Add the missing content (shots, game objects, interactions) to the EXISTING code\n'
              + '- The verification system searches for methods named shot_1(), shot_2()... shot_N() in your code\n'
              + '- If you have scene logic under different names (e.g. ShowScene1, SetupLevel1, Phase1), RENAME them to shot_1(), shot_2() etc.\n'
              + '- EASIEST FIX: Add wrapper methods: void shot_1() { /* call your existing scene logic */ }\n'
              + '- Each shot_N() method must create visible GameObjects or call methods that create them\n'
              + '- You need EXACTLY ' + (parsed.scenes ? parsed.scenes.length : 10) + ' shot methods: shot_1 through shot_' + (parsed.scenes ? parsed.scenes.length : 10) + '\n'
              + '- Missing shots: ' + (verification.missingShots ? verification.missingShots.join(', ') : 'unknown') + '\n'
              + '- DO NOT rewrite the entire code — just add the shot_N() wrapper methods and keep everything else\n'
              + '- Output the COMPLETE updated GameFlowManagerMain.cs\n';
            var contentFixResp = await callClaude(fixPrompt, contentFixMsg, 300000, MODEL_GENERATE);
            var contentFixFiles = parseBlocks(contentFixResp.text);
            if (contentFixFiles.length > 0) {
              // Safety check: reject if drastically shorter than original
              var cfMainPath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
              var cfOrigLines = 0;
              try { cfOrigLines = fs.readFileSync(cfMainPath, 'utf-8').split('\n').length; } catch(e) {}
              var cfMainFile = contentFixFiles.find(function(f) { return f.path.indexOf('GameFlowManagerMain') >= 0; });
              var cfNewLines = cfMainFile ? cfMainFile.content.split('\n').length : cfOrigLines;
              if (cfOrigLines > 100 && cfNewLines < cfOrigLines * 0.5) {
                log('[coder] ⚠️ REJECTED content fix: AI returned ' + cfNewLines + ' lines but original has ' + cfOrigLines + ' lines. Retrying...', taskId);
              } else {
                writeFiles(clientDir, contentFixFiles, log, taskId); files = contentFixFiles;
              }
            }
            log('[coder] Content fix applied, re-checking...', taskId);
            continue; // Go back to compile check
          }
          return { ok: false, error: 'Content verification failed after ' + MAX_CONTENT_ATTEMPTS + ' attempts: ' + verification.reason };
        }
        log('[coder] ✅ Content verification passed', taskId);
        // Generate architecture diagram
        try {
          var archGen = require('./generate-architecture.js');
          archGen.generateArchitecture(clientDir, log, taskId);
        } catch(archErr) { log('[coder] Architecture generation skipped: ' + archErr.message, taskId); }
        return { ok: true, filesWritten: files.length, files: files.map(function(f) { return f.path; }), attempts: attempt };
      }

      var errorSig = result.errors.sort().join('|');
      if (errorSig === prevErrorSig) { sameErrorCount++; } else { sameErrorCount = 0; prevErrorSig = errorSig; }

      if (sameErrorCount >= 3) {
        log('[coder] ⚠️ Same errors repeated 3 times, regenerating from scratch...', taskId);
        var regenMsg = userMsg + '\n\n## IMPORTANT: Previous code had persistent compilation errors:\n```\n'
          + result.errors.join('\n') + '\n```\nGenerate completely different code that avoids these issues.'
          + '\n⚠️ You MUST generate FULL game logic — do NOT output a skeleton/empty class. The game must actually run with all shots implemented.';
        var regenResp = await callClaude(sysPrompt, regenMsg, 300000, MODEL_GENERATE);
        var regenFiles = parseBlocks(regenResp.text);
        if (regenFiles.length > 0) {
          var rgMain = regenFiles.find(function(f) { return f.path.indexOf('GameFlowManagerMain') >= 0; });
          var rgLines = rgMain ? rgMain.content.split('\n').length : 999;
          if (rgLines < 100) {
            log('[coder] ⚠️ REJECTED regen: AI returned ' + rgLines + ' lines (too short for full game). Retrying...', taskId);
          } else {
            writeFiles(clientDir, regenFiles, log, taskId); files = regenFiles;
          }
        }
        sameErrorCount = 0; prevErrorSig = ''; continue;
      }

      log('[coder] Fix attempt ' + attempt + '/' + MAX_COMPILE_ATTEMPTS + ': ' + result.errors.length + ' errors', taskId);
      // Log specific errors for debugging
      result.errors.forEach(function(e, i) { if (i < 5) log('[coder]   error ' + (i+1) + ': ' + e, taskId); });

      // Auto-fix CS0101 duplicate definitions: find the conflicting stub file and empty it
      var cs0101Fixed = false;
      result.errors.forEach(function(e) {
        var m101 = e.match(/CS0101.*definition for '(\w+)'.*file:\s*([^,)]+)/);
        if (m101) {
          var conflictClass = m101[1];
          var conflictFile = m101[2].trim();
          var fullPath = path.join(clientDir, conflictFile.replace(/\//g, path.sep));
          // Only empty stub files (not the AI-written file)
          if (fullPath.indexOf('GameFlowManagerMain') < 0 && fs.existsSync(fullPath)) {
            log('[coder] Auto-fixing CS0101: emptying stub ' + conflictFile + ' (class ' + conflictClass + ')', taskId);
            fs.writeFileSync(fullPath, '// Auto-emptied to resolve CS0101 conflict with AI code\nusing UnityEngine;\n', 'utf-8');
            cs0101Fixed = true;
          }
        }
      });
      if (cs0101Fixed) {
        // Retry compile immediately without using a fix attempt
        log('[coder] Retrying compile after CS0101 auto-fix...', taskId);
        result = tryCompile(clientDir, log, taskId);
        if (result.ok) {
          log('[coder] ✅ Build passed after CS0101 auto-fix!', taskId);
          // Jump to content verification
          var verification2 = verifyCodeContent(clientDir, parsed, log, taskId);
          if (verification2.ok) {
            log('[coder] ✅ Content verification passed', taskId);
            try { var archGen2 = require('./generate-architecture.js'); archGen2.generateArchitecture(clientDir, log, taskId); } catch(ae) {}
            return { ok: true, filesWritten: files.length, files: files.map(function(f) { return f.path; }), attempts: attempt };
          }
          // Content failed — go back to top of loop which will handle content verification properly
          continue;
        }
        // Build still failed after CS0101 fix, continue to normal fix flow
      }

      var mainPath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
      var currentMainCode = '';
      try { currentMainCode = fs.readFileSync(mainPath, 'utf-8'); } catch(e) {}
      var currentMainLines = currentMainCode.split('\n');

      // Extract error line numbers and surrounding context for patch mode
      var errorLineInfos = result.errors.map(function(err) {
        var lineMatch = err.match(/line:\s*(\d+)/i) || err.match(/line\s+(\d+)/i);
        var lineNum = lineMatch ? parseInt(lineMatch[1]) : 0;
        return { error: err, line: lineNum };
      }).filter(function(e) { return e.line > 0; });

      // Use PATCH mode if we have line numbers and a substantial file
      var usePatchMode = errorLineInfos.length > 0 && currentMainLines.length > 100;

      if (usePatchMode) {
        // Build context windows around each error (±15 lines)
        var CONTEXT_RADIUS = 15;
        var patchSections = [];
        var coveredLines = {};
        for (var ei = 0; ei < errorLineInfos.length; ei++) {
          var eLine = errorLineInfos[ei].line;
          var startLine = Math.max(1, eLine - CONTEXT_RADIUS);
          var endLine = Math.min(currentMainLines.length, eLine + CONTEXT_RADIUS);
          // Merge overlapping sections
          if (patchSections.length > 0 && startLine <= patchSections[patchSections.length - 1].end + 1) {
            patchSections[patchSections.length - 1].end = endLine;
            patchSections[patchSections.length - 1].errors.push(errorLineInfos[ei].error);
          } else {
            patchSections.push({ start: startLine, end: endLine, errors: [errorLineInfos[ei].error] });
          }
        }

        var patchCtx = '## PATCH MODE: Fix compilation errors by replacing ONLY the broken sections.\n\n';
        patchCtx += '## Build Errors (' + result.errors.length + ' total):\n```\n' + result.errors.join('\n') + '\n```\n\n';
        patchCtx += '## File: GameFlowManagerMain.cs (' + currentMainLines.length + ' lines total)\n\n';
        patchCtx += 'Below are the sections around each error. Fix ONLY these sections.\n\n';

        for (var si = 0; si < patchSections.length; si++) {
          var sec = patchSections[si];
          patchCtx += '### Section ' + (si + 1) + ' (lines ' + sec.start + '-' + sec.end + '):\n';
          patchCtx += 'Errors in this section:\n```\n' + sec.errors.join('\n') + '\n```\n';
          patchCtx += 'Current code:\n```csharp\n';
          for (var li = sec.start - 1; li < sec.end && li < currentMainLines.length; li++) {
            patchCtx += (li + 1) + ': ' + currentMainLines[li] + '\n';
          }
          patchCtx += '```\n\n';
        }

        patchCtx += '## OUTPUT FORMAT:\n';
        patchCtx += 'For each section, output a patch block like this:\n';
        patchCtx += '```patch: START_LINE-END_LINE\n';
        patchCtx += '// replacement code for those lines\n';
        patchCtx += '```\n\n';
        patchCtx += 'Example: if lines 190-195 need fixing:\n';
        patchCtx += '```patch: 190-195\n';
        patchCtx += 'var light = new GameObject("Light").AddComponent<Light>();\n';
        patchCtx += '// light.type is not available in Luna, skip it\n';
        patchCtx += '```\n\n';
        patchCtx += '⚠️ ONLY output patch blocks. Do NOT output the entire file.\n';
        patchCtx += '⚠️ Keep all surrounding code unchanged. Fix ONLY the erroring lines.\n';
        patchCtx += '⚠️ The replacement lines will REPLACE the original lines in that range.\n';

        var patchResp = await callClaude(fixPrompt, patchCtx);
        log('[coder] Patch fix response (' + (patchResp.usage ? patchResp.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

        // Parse patch blocks
        var patchRegex = /```patch:\s*(\d+)\s*-\s*(\d+)\s*\n([\s\S]*?)```/g;
        var patchMatch;
        var patches = [];
        while ((patchMatch = patchRegex.exec(patchResp.text)) !== null) {
          patches.push({
            startLine: parseInt(patchMatch[1]),
            endLine: parseInt(patchMatch[2]),
            replacement: patchMatch[3].trimEnd()
          });
        }

        if (patches.length > 0) {
          // Sort patches by startLine descending so we apply from bottom up (avoids line shift issues)
          patches.sort(function(a, b) { return b.startLine - a.startLine; });
          var patchedLines = currentMainLines.slice();
          for (var pi = 0; pi < patches.length; pi++) {
            var p = patches[pi];
            var replacementLines = p.replacement.split('\n');
            // Validate patch range
            if (p.startLine < 1 || p.endLine > patchedLines.length || p.startLine > p.endLine) {
              log('[coder] ⚠️ Skipping invalid patch range: ' + p.startLine + '-' + p.endLine, taskId);
              continue;
            }
            patchedLines.splice(p.startLine - 1, p.endLine - p.startLine + 1, replacementLines.join('\n'));
            log('[coder] Applied patch: lines ' + p.startLine + '-' + p.endLine + ' → ' + replacementLines.length + ' lines', taskId);
          }
          var patchedContent = patchedLines.join('\n');
          fs.writeFileSync(mainPath, patchedContent, 'utf-8');
          log('[coder] Written (patch mode): ' + 'Assets/Program/Script/Manager/GameFlowManagerMain.cs', taskId);
          files = [{ path: 'Assets/Program/Script/Manager/GameFlowManagerMain.cs', content: patchedContent }];
        } else {
          // Fallback: AI didn't output patch format, try parsing as full file
          log('[coder] ⚠️ No patch blocks found, falling back to full-file parse...', taskId);
          var fallbackFiles = parseBlocks(patchResp.text);
          if (fallbackFiles.length > 0) {
            var fbMain = fallbackFiles.find(function(f) { return f.path.indexOf('GameFlowManagerMain') >= 0; });
            var fbLines = fbMain ? fbMain.content.split('\n').length : 0;
            if (currentMainLines.length > 100 && fbLines < currentMainLines.length * 0.5) {
              log('[coder] ⚠️ REJECTED fallback fix: ' + fbLines + ' lines vs original ' + currentMainLines.length + ' lines. Retrying...', taskId);
            } else {
              writeFiles(clientDir, fallbackFiles, log, taskId); files = fallbackFiles;
            }
          } else {
            log('[coder] Warning: No fix blocks at all, retrying...', taskId);
          }
        }
      } else {
        // No line numbers or small file — use traditional full-file fix
        var currentCode = readScripts(clientDir);
        var fixProjectCtx = projectCtx.fileList ? '\n\n## Existing project files (for reference):\n```\n' + projectCtx.fileList + '\n```' : '';
        var fixMsg = '## Build Errors (' + result.errors.length + ' total):\n```\n' + result.errors.join('\n') + '\n```\n\n'
          + '## Current Scripts:\n' + currentCode
          + fixProjectCtx
          + '\n\nFix ALL ' + result.errors.length + ' errors above. Output the COMPLETE fixed GameFlowManagerMain.cs.'
          + '\n⚠️ CRITICAL: You MUST output the ENTIRE file content — do NOT output only the changed lines or a partial snippet.'
          + '\n⚠️ Only change lines that cause errors. Keep all working code intact.'
          + '\nThis is attempt ' + attempt + '. If previous fixes oscillated, try a MINIMAL change approach.';

        var fixResp = await callClaude(fixPrompt, fixMsg);
        log('[coder] Fix response (' + (fixResp.usage ? fixResp.usage.output_tokens + ' tokens' : 'ok') + ')', taskId);

        var fixed = parseBlocks(fixResp.text);
        if (fixed.length > 0) {
          var fmMain = fixed.find(function(f) { return f.path.indexOf('GameFlowManagerMain') >= 0; });
          var fmLines = fmMain ? fmMain.content.split('\n').length : 999;
          if (currentMainLines.length > 100 && fmLines < currentMainLines.length * 0.5) {
            log('[coder] ⚠️ REJECTED fix: ' + fmLines + ' lines vs original ' + currentMainLines.length + ' lines. Retrying...', taskId);
          } else {
            writeFiles(clientDir, fixed, log, taskId); files = fixed;
          }
        }
        else { log('[coder] Warning: No fix blocks, retrying...', taskId); }
      }
    }

    log('[coder] ❌ Exhausted compile attempts (compile: ' + MAX_COMPILE_ATTEMPTS + ', content: ' + contentFixCount + '/' + MAX_CONTENT_ATTEMPTS + ')', taskId);
    return { ok: false, error: 'Build failed after ' + MAX_COMPILE_ATTEMPTS + ' compile + ' + contentFixCount + ' content attempts:\n' + (result ? result.errors.join('\n') : 'unknown') };
  } catch (e) {
    log('[coder] Error: ' + e.message, taskId);
    return { ok: false, error: e.message };
  }
}

// ============ Content Verification ============

function verifyCodeContent(clientDir, parsed, log, taskId) {
  var mainFilePath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
  if (!fs.existsSync(mainFilePath)) {
    return { ok: false, reason: 'GameFlowManagerMain.cs not found — AI did not write the main file' };
  }

  var code = fs.readFileSync(mainFilePath, 'utf-8');
  var lines = code.split('\n');
  var nonEmptyLines = lines.filter(function(l) { return l.trim().length > 0; }).length;

  var issues = [];

  // Check 1: Minimum code length
  if (nonEmptyLines < 200) {
    issues.push('GameFlowManagerMain.cs only has ' + nonEmptyLines + ' non-empty lines (minimum 200). This is likely a skeleton.');
  }

  // Check 2: Must contain shot/scene/state-related methods or state machine
  var shotCount = parsed.scenes ? parsed.scenes.length : 0;
  var hasShotMethods = false;
  var shotKeywords = 0;
  var missingShots = [];
  for (var i = 0; i < shotCount; i++) {
    var shotNum = i + 1;
    // Broad pattern matching — AI may use any naming convention
    var patterns = [
      'shot_' + shotNum, 'shot' + shotNum, 'Shot' + shotNum, 'SHOT_' + shotNum,
      'Scene' + shotNum, 'scene' + shotNum, 'scene_' + shotNum,
      'Stage' + shotNum, 'stage' + shotNum, 'stage_' + shotNum,
      'Step' + shotNum, 'step' + shotNum, 'step_' + shotNum,
      'Phase' + shotNum, 'phase' + shotNum, 'phase_' + shotNum,
      'Level' + shotNum, 'level' + shotNum, 'level_' + shotNum,
      'State' + shotNum, 'state' + shotNum, 'state_' + shotNum,
      'Screen' + shotNum, 'screen' + shotNum, 'screen_' + shotNum,
      'Page' + shotNum, 'page' + shotNum, 'page_' + shotNum
    ];
    var found = false;
    for (var p = 0; p < patterns.length; p++) {
      if (code.indexOf(patterns[p]) >= 0) { shotKeywords++; found = true; break; }
    }
    if (!found) missingShots.push(shotNum);
  }
  // ALL shots must be found — no exceptions, no lowered threshold
  if (shotCount > 0 && shotKeywords < shotCount) {
    issues.push('Missing shots: ' + missingShots.join(', ') + ' (' + shotKeywords + '/' + shotCount + ' implemented). ALL shots must be implemented — no exceptions.');
    log('[coder] FAIL: Only ' + shotKeywords + '/' + shotCount + ' shots found, missing: [' + missingShots.join(', ') + ']', taskId);
  }

  // Check 2b: Shot methods must be CALLED, not just defined
  // Look for a state machine (switch/case with shot numbers) or direct shot_N() calls
  if (shotCount > 0 && shotKeywords === shotCount) {
    var hasStateMachine = (code.indexOf('switch') >= 0 && code.indexOf('_currentShot') >= 0) ||
                          (code.indexOf('switch') >= 0 && code.indexOf('_shotState') >= 0) ||
                          (code.indexOf('switch') >= 0 && code.indexOf('currentShot') >= 0);
    var shotCallCount = 0;
    for (var sc = 1; sc <= shotCount; sc++) {
      // Check if shot_N() is actually invoked (not just defined as a method)
      // Pattern: shot_N() called outside its own definition — look for "shot_N(" not preceded by "void "
      var callPattern = 'shot_' + sc + '(';
      var defPattern = 'void shot_' + sc;
      var callIdx = -1;
      var calls = 0;
      while ((callIdx = code.indexOf(callPattern, callIdx + 1)) >= 0) calls++;
      // Subtract definitions (void shot_N, private void shot_N, etc.)
      var defIdx = -1;
      var defs = 0;
      while ((defIdx = code.indexOf(defPattern, defIdx + 1)) >= 0) defs++;
      if (calls > defs) shotCallCount++; // at least one invocation beyond the definition
    }
    if (!hasStateMachine && shotCallCount < Math.ceil(shotCount * 0.5)) {
      issues.push('Shot methods are DEFINED but NOT CALLED. Found ' + shotCallCount + '/' + shotCount + ' shot methods with actual invocations. '
        + 'You need a state machine (switch/_currentShot in Update()) or explicit shot_N() calls to drive the flow between shots.');
      log('[coder] FAIL: Shot methods defined but only ' + shotCallCount + '/' + shotCount + ' are actually called. No state machine detected.', taskId);
    }
  }

  // Check 3: Must create game objects (not just empty methods)
  var createPatterns = ['CreatePrimitive', 'new GameObject', 'AddComponent', 'Instantiate', 'GFM_Create.Obj', 'GFM_Create.Ground', 'PoolGet'];
  var createCount = 0;
  for (var c = 0; c < createPatterns.length; c++) {
    var idx = -1;
    while ((idx = code.indexOf(createPatterns[c], idx + 1)) >= 0) createCount++;
  }
  if (createCount < 5) {
    issues.push('Only ' + createCount + ' object creation calls found. The game must create objects from code (CreatePrimitive, new GameObject, etc.). Minimum 5 expected.');
  }

  // Check 4: Must NOT contain template-specific logic
  var templateKeywords = ['idleGame', 'slgGame', 'buildingUpgrade', 'troopTrain', 'ResourceType.Gold'];
  for (var t = 0; t < templateKeywords.length; t++) {
    if (code.indexOf(templateKeywords[t]) >= 0) {
      issues.push('Found template keyword "' + templateKeywords[t] + '" — code contains original SLG template logic instead of blueprint implementation.');
      break;
    }
  }

  // Check 5: Scene is clean now — warn if code still tries to hide template objects (unnecessary)
  if (code.indexOf('GetRootGameObjects') >= 0 && code.indexOf('SetActive(false)') >= 0) {
    log('[coder] Warning: Code still hides scene root objects — scene is already clean, this is unnecessary', taskId);
  }

  // Check 6: Must call GameEnded()
  if (code.indexOf('GameEnded') < 0) {
    issues.push('No GameEnded() call found — Luna lifecycle not properly handled.');
  }

  // Check 6b: State machine completeness — each shot must transition to next
  if (shotCount >= 3 && shotKeywords === shotCount) {
    var hasUpdate = code.indexOf('void Update()') >= 0 || code.indexOf('void Update ()') >= 0;
    var hasShotSwitch = code.indexOf('_currentShot') >= 0 || code.indexOf('currentShot') >= 0;
    if (!hasUpdate) {
      issues.push('No Update() method found. Shot flow requires Update() with a state machine (switch/_currentShot) to drive transitions between shots.');
      log('[coder] FAIL: No Update() method — shots cannot auto-progress', taskId);
    } else if (!hasShotSwitch) {
      issues.push('Update() exists but no _currentShot state variable found. Shots need a switch(_currentShot) dispatcher in Update() to drive the flow.');
      log('[coder] FAIL: Update() has no _currentShot state machine', taskId);
    } else {
      // Verify each shot has a transition to the next
      var missingTransitions = [];
      for (var st = 1; st < shotCount; st++) {
        // Look for _currentShot = (st+1) or currentShot = (st+1) somewhere after shot_st definition
        var transPatterns = [
          '_currentShot = ' + (st + 1),
          '_currentShot=' + (st + 1),
          'currentShot = ' + (st + 1),
          'currentShot=' + (st + 1),
          '_currentShot ++', '_currentShot++',
          'currentShot ++', 'currentShot++',
        ];
        var hasTransition = false;
        for (var tp = 0; tp < transPatterns.length; tp++) {
          if (code.indexOf(transPatterns[tp]) >= 0) { hasTransition = true; break; }
        }
        if (!hasTransition) missingTransitions.push(st + ' -> ' + (st + 1));
      }
      if (missingTransitions.length > Math.floor(shotCount * 0.3)) {
        issues.push('Shot transitions incomplete: ' + missingTransitions.length + '/' + (shotCount - 1) + ' transitions missing. '
          + 'Each shot_N must set _currentShot = N+1 (or _currentShot++) to advance the flow. '
          + 'Missing: ' + missingTransitions.slice(0, 5).join(', ') + (missingTransitions.length > 5 ? '...' : ''));
        log('[coder] FAIL: ' + missingTransitions.length + ' shot transitions missing', taskId);
      }
    }
  }

  // Check 6c: Last shot must end the game
  if (shotCount >= 3) {
    // Find the last shot method and check if it calls GameEnded/GameOver/GFM_Luna.GameOver
    var lastShotPattern = 'shot_' + shotCount;
    var lastShotIdx = code.lastIndexOf(lastShotPattern);
    if (lastShotIdx >= 0) {
      var afterLastShot = code.slice(lastShotIdx, Math.min(lastShotIdx + 2000, code.length));
      var hasEndInLastShot = afterLastShot.indexOf('GameEnded') >= 0 ||
                              afterLastShot.indexOf('GameOver') >= 0 ||
                              afterLastShot.indexOf('GFM_Luna.GameOver') >= 0 ||
                              afterLastShot.indexOf('GFM_Luna.GotoStore') >= 0;
      if (!hasEndInLastShot) {
        log('[coder] Warning: Last shot (shot_' + shotCount + ') may not call GameEnded/GameOver', taskId);
      }
    }
  }

  // Check 7: MUST use GFM_Create.Obj() for 3D objects — CreatePrimitive and new GameObject are INVISIBLE in Luna
  var gfmCreateObjCount = 0;
  var searchIdx = -1;
  while ((searchIdx = code.indexOf('GFM_Create.Obj', searchIdx + 1)) >= 0) gfmCreateObjCount++;
  var gfmGroundCount = 0;
  searchIdx = -1;
  while ((searchIdx = code.indexOf('GFM_Create.Ground', searchIdx + 1)) >= 0) gfmGroundCount++;
  var totalGfmCreate = gfmCreateObjCount + gfmGroundCount;
  if (totalGfmCreate < 3) {
    issues.push('CRITICAL: Only ' + totalGfmCreate + ' GFM_Create.Obj/Ground calls found (minimum 3). '
      + 'You MUST use GFM_Create.Obj() to create ALL visible 3D objects — '
      + 'CreatePrimitive() and new GameObject() produce INVISIBLE objects in Luna WebGL. '
      + 'The scene has a pre-placed object pool (50 Cubes, 20 Spheres, 10 Planes, 10 Cylinders). '
      + 'Use GFM_Create.Obj(PrimitiveType.Cube, pos, scale, "label") for every visible object.');
    log('[coder] FAIL: Only ' + totalGfmCreate + ' GFM_Create calls (need >= 3). AI used new GameObject/CreatePrimitive instead.', taskId);
  }

  // Check 8: Reject CreatePrimitive usage entirely
  var createPrimCount = 0;
  searchIdx = -1;
  while ((searchIdx = code.indexOf('CreatePrimitive', searchIdx + 1)) >= 0) createPrimCount++;
  if (createPrimCount > 0) {
    issues.push('FORBIDDEN: Found ' + createPrimCount + ' CreatePrimitive() calls. '
      + 'CreatePrimitive is INVISIBLE in Luna WebGL — replace ALL with GFM_Create.Obj().');
  }

  // Check 9: Must call GFM_Create.InitMaterialFromScene() and GFM_Create.ResetPool() in Start()
  if (code.indexOf('GFM_Create.InitMaterialFromScene') < 0) {
    issues.push('Missing GFM_Create.InitMaterialFromScene() call — must be called at start of Start() to initialize materials.');
  }
  if (code.indexOf('GFM_Create.ResetPool') < 0) {
    issues.push('Missing GFM_Create.ResetPool() call — must be called at start of Start() to reset object pool counters.');
  }

  if (issues.length > 0) {
    return { ok: false, reason: issues.join('\n'), missingShots: missingShots };
  }

  log('[coder] Verification: ' + nonEmptyLines + ' lines, ' + shotKeywords + '/' + shotCount + ' shots (100%), ' + createCount + ' object creations', taskId);
  return { ok: true };
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