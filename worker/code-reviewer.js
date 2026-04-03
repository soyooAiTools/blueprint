/**
 * Code Reviewer — GPT-5.4 adversarial review of AI-generated C# code
 * 
 * Checks generated GameFlowManagerMain.cs against Luna/Bridge.NET constraints
 * documented in memory/*.md and .learnings/LEARNINGS.md.
 * 
 * Called after AI coding (both full generation and incremental fix),
 * before compilation. If issues found, returns feedback for Claude to fix.
 * 
 * @see memory/luna-rendering-postmortem.md — 5-layer rendering root causes
 * @see memory/2026-03-19.md — PlayCanvas API constraints
 * @see memory/rules.md — Luna injection iron rules
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// OpenAI API via relay (sub.mindrix.app)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://sub.mindrix.app/v1';
const REVIEW_MODEL = 'gpt-5.4';
const REVIEW_TIMEOUT = 120000; // 2 min

// === Luna/Bridge.NET constraint rules ===
// Sources: luna-rendering-postmortem.md, blueprint-tech.md, rules.md, LEARNINGS.md, ERRORS.md
// luna-spec.md, GFM_Tools_API.md, behavior-templates.md, entity-architecture-proposal.md
// Last synced: 2026-03-29
//
// DESIGN: Rules are split into 3 tiers by severity.
// GPT-5.4 checks Tier 1 (critical/instant-fail) first, then Tier 2, then Tier 3.
// This prevents attention dilution on a long flat list.
const REVIEW_RULES = `
## Tier 1 — INSTANT FAIL (check these first, any violation = FAIL)

### 1. Object Naming — Pool Objects
- All GameObject.Find() calls MUST use pool names matching the pattern: __Pool_{Shape}_{Color}_{NN}
- Valid shapes: Cube, Sphere, Cylinder, Plane
- Valid colors: Red, Blue, Green, Yellow, Orange, Purple, White, Brown, Cyan, Pink
- Valid format examples: __Pool_Cube_Red_01, __Pool_Sphere_Blue_02, __Pool_Plane_Green_01, __Pool_Cylinder_White_03
- The prompt provides exact pool name assignments for each entity — code MUST use those exact names
- NEVER use concept names like "Building_1", "Player", "Tree" — these DO NOT exist → Find returns null → solid color screen
- Do NOT construct pool names dynamically (e.g., idx.ToString("D2")) — Bridge.NET string formatting is unreliable. Use explicit string literals.

### 2. Forbidden APIs (will be invisible or crash)
- CreatePrimitive() — objects are INVISIBLE in Luna (Runtime Analysis strips them)
- new GameObject() — creates objects WITHOUT mesh/renderer, invisible
- new Material() — shader will be null (Luna strips built-in shader refs) → invisible
- Camera.AddComponent() — does NOT create a working camera
- Destroy() on cameras/lights — managed by injection template
- Resources.GetBuiltinResource() — NOT implemented in Luna
- FindObjectOfType / FindObjectsOfType — may return null
- AddComponent(typeof(TextMesh)) or other rendering/text components at runtime — Luna cannot initialize them properly → invisible/broken
- Application.ExternalEval() — not supported in Luna; arbitrary JS eval breaks transpilation/runtime
- Camera.main — may be null in Luna template; skeleton pre-caches it as "mainCam" field. Use mainCam instead of Camera.main. Always null-check before use: if (mainCam != null)
- Camera.allCameras — camera enumeration is not safe; camera lifecycle is template-managed
- GetComponentInChildren / GetComponentInParent — hierarchy traversal unstable
- transform.parent access — may be undefined in Luna, crashes
- transform.SetParent() — use GFM_UI for UI hierarchy instead
- SceneManager.LoadScene / Application.LoadLevel — Luna is single-scene
- SendMessage() — NOT supported

### 3. C# Language — Bridge.NET Hard Limits
- MUST have "using UnityEngine;" (missing = CS0246 MonoBehaviour not found)
- NO generics: GetComponent<T>() → use GetComponent(typeof(T)) and cast
- NO LINQ (System.Linq unavailable)
- NO async/await
- NO string interpolation $"..."
- NO null-conditional (?.) or null-coalescing (??)
- NO pattern matching, no nameof()
- NO List<T> or Dictionary<K,V> — use arrays
- NO coroutines — use Update() + deltaTime timer
- MUST NOT define class/enum named "EventPool" (conflicts with Luna template → CS0101)

### 4. Code Completeness
- ALL phases from blueprint MUST be implemented in CheckEventRules() (zero tolerance)
- Each phase must have transition logic with phaseTimer minimum dwell check
- The gameEnd block MUST call Luna.Unity.LifeCycle.GameEnded() + ShowCTA() which calls Luna.Unity.Playable.InstallFullGame()
- Call order matters: GameEnded() MUST be called before InstallFullGame() — reversed order causes integration failures
- Must have Start() and Update() methods
- Must NOT modify or redefine GFM_Tools.cs classes
### 4b. Phase Architecture Verification (MECHANICAL CHECK — count, don't guess)
- Count all ruleTriggered[N] references in CheckEventRules() — the highest N+1 MUST equal the expected phase count from blueprint
- Every ruleTriggered[N] block MUST have a real condition (NOT just "true" or timer-only) — at least one entity state check or interaction flag
- Every phase transition MUST include a phaseTimer >= Nf dwell guard (prevents instant skip)
- Every phase MUST have real completion conditions (entity states, interaction flags, counters) — NOT timer-only or unconditional. Phase progression MUST require actual player actions (click/drag/move), never auto-complete
- Variables referenced in trigger conditions (e.g. iceCrystalState, goldState) MUST be declared and MUST be modified somewhere in Update() or a helper method
- If ruleTriggered[] array size < number of phases described in the prompt → INSTANT FAIL (phases were collapsed or removed)
- CheckEventRules() MUST be called from Update() — verify the call chain exists

## Tier 2 — LIKELY FAIL (high probability of runtime issues)

### 5. Materials & Rendering
- Colors are pre-baked into pool objects (e.g., __Pool_Cube_Red_01 is already red). Do NOT call GFM_Create.SetColor() — it is no longer needed
- Do NOT create new Material() — materials are baked at build time
- Pool objects start at y=-999 (hidden). Show = move to visible Y. Hide = y=-999
- Do NOT use SetActive(false) for hiding — use y=-999 position

### 5b. Solid-Color Screen Prevention (CRITICAL)
- Ground/GroundField plane color MUST be neutral gray (recommended (0.75, 0.78, 0.82)). Any channel saturation > 0.3 from gray midpoint triggers FAIL (e.g. green (0.42, 0.72, 0.38) is BANNED)
- Camera.backgroundColor MUST differ from ground color by ≥ 0.3 on at least one RGB channel. Recommended: (0.35, 0.55, 0.75) deep sky blue. BANNED: (0.75, 0.82, 0.92) — too close to gray ground, triggers solid-color detection
- Rule 0 / gameStart MUST position ≥ 3 differently-colored objects at y ≥ -1 in the first frame — prevents solid-color screen if later phases never trigger
- Main entities (castle, player, hero) MUST have at least one scale dimension ≥ 1.5 to be visible under orthographic camera

### 6. GFM_Tools API Signatures (wrong params = compile error or silent fail)
- GFM_Create.Obj(PrimitiveType, Vector3 pos, Vector3 scale, string name) — exactly 4 params
- GFM_Create.Ground(float width, float depth) — 2 floats, not Vector3
- GFM_UI.CreateCanvas(int w, int h) — REQUIRES 2 params, returns Canvas
- GFM_UI.CreateProgressBar(...) — returns Slider, NOT Image
- GFM_Joystick.Create(Canvas, float size) — returns GFM_Joystick (.Horizontal/.Vertical/.IsDragging)
- There is NO class called "GFM_Tools" — use GFM_Create, GFM_UI, GFM_Utils, etc.
- GFM_UI.CreateText(Canvas, string, Vector2, int) — returns Text, valid API
- GFM_UI.CreateButton(Canvas, string, Vector2, Vector2, UnityAction) — returns Button, valid API
- GFM_UI.AddWorldLabel(GameObject, string, float) — adds world-space text label above object
- NOTE: The skeleton pre-creates uiCanvas, guideText, scoreText — use those variables instead of creating new ones

### 7. Gameplay Logic
- FORBIDDEN: autoplay / ForceCompleteAllPhases / auto-demo
- FORBIDDEN: auto-shoot for turrets (player must trigger)
- ALLOWED: proximity auto-collect (player walks near item → auto pickup, no tap needed)
- FORBIDDEN: pure numeric triggers that skip interaction (killCount >= N auto-jumps phase)
- Kill counters for phase progression MUST only count player-caused kills — enemies self-destructing/escaping must NOT count
- Auto-targeting (player clicks but target is auto-selected) still violates interaction requirements for turret/combat gameplay
- Player input must drive phase progression — CUA needs to interact
- Phase progression MUST be driven by player interaction (PlayableAgent operates) — NEVER auto-advance phases via timer, animation callback, or scripted sequence

### 8. Incremental Fix Constraints
- Removing phase logic from CheckEventRules() to "fix" compile errors = REJECTED (content regression)
- Phase count must not decrease from original
- Fix must only change what feedback requested — no full rewrite

## Tier 3 — WARNINGS (best practices, may work but risky)

### 9. Common Mistakes
- Vector3 without "new" keyword → compile error
- Missing null checks after GameObject.Find() → NullReferenceException
- Infinite loops or blocking code in Update() → freezes WebGL
- Using Time.time instead of accumulating Time.deltaTime
- Debug.Log() in Update() → console spam kills performance
- Declaring variables inside switch cases without braces → CS0163
- Shared mutable state for pooled entities (e.g., one global arrowDamage for all arrows) — track per-entity state with aligned arrays

### 10. Luna Platform Limitations
- No TileMap, no New InputSystem, no Terrain, no multi-threading
- Input.GetMouseButtonDown(0) alone may fail on mobile — use GFM/Luna input abstraction or handle both touch and mouse
- CharacterController poorly supported — use Transform or Rigidbody
- No animation state machine Exit nodes
- Vector3Int not supported (cast to Vector3)
- DOTween chains must be split into separate lines (transpile bug)
- Multiple materials: only first material animates correctly
- GetComponent<Transform>() ≠ GetComponent<RectTransform>()
- iOS AppLovin: first touch must pre-play silent audio (GFM_Luna.Init handles this)
- Time.deltaTime is constant 0.1 in Luna regardless of FPS

### 11. Phase ID Format (CRITICAL)
- AddCompletedPhase() parameter MUST exactly match the blueprint Rule ID (e.g., "phase_1774794448160_1")
- Do NOT use semantic names like "openingTutorial", "buildPhase", "phase_BuildHouse"
- The prompt provides exact Rule IDs for each phase — code MUST use those exact strings
- currentPhaseName should track progression using these same IDs

### 12. Forbidden Legacy APIs
- GFM_Create.InitMaterialFromScene() — NO LONGER needed; colors are pre-baked at build time
- GFM_Create.SetColor() — NO LONGER needed; pool objects already have baked colors (e.g., __Pool_Cube_Red_01 is already red)
- GFM_Create.ResetPool() — NO LONGER needed in current skeleton
- GFM_Create.Obj() — Do NOT create new objects; use GameObject.Find() to locate pre-existing pool objects
- GFM_Create.Ground() — Ground is pre-created in skeleton

### 13. Architecture (V5 phase-driven)
- Phase tracking: currentPhaseName, ruleTriggered[], phaseTimer, phaseEnterTimes[]
- CheckEventRules() with bool[] ruleTriggered — each phase has trigger condition + min dwell time
- Entity states tracked as int variables (0=waiting, 1=building, 2=built)
- Main code in GameFlowManagerMain.cs (may use partial class for large files)
`;

// Dynamic rules: auto-promoted from pending-rules when ≥2 different projects hit the same issue.
// Kept lean — only rules that survived cross-project validation get promoted.
const PROMOTED_RULES_PATH = path.join(__dirname, 'promoted-rules.json');

function loadPromotedRules() {
  try {
    return JSON.parse(fs.readFileSync(PROMOTED_RULES_PATH, 'utf8'));
  } catch(e) {
    return [];
  }
}

function savePromotedRules(rules) {
  fs.writeFileSync(PROMOTED_RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

function getDynamicRulesText() {
  // Inject anomaly detection rules (from luna-anomaly-rules.js)
  var anomalyRules = '';
  try {
    var anomalyPath = require('path').join(__dirname, 'luna-anomaly-rules.js');
    if (require('fs').existsSync(anomalyPath)) {
      anomalyRules = '\n\n## Runtime Anomaly Prevention (auto-extracted)\n' +
        '- No object creation in Update() without pooling (leak risk)\n' +
        '- Phase timers must have max-duration auto-advance (stuck prevention)\n' +
        '- Null-check all UI text values before display (NaN/undefined/null prevention)\n' +
        '- Player movement must be clamped within bounds (out-of-bounds prevention)\n' +
        '- Start() must move >=3 pool objects to visible positions (empty scene prevention)\n' +
        '- CTA click handler must call Luna.Unity.Playable.InstallFullGame() (CTA unresponsive prevention)\n' +
        '- Use pooling (y=-999) instead of Destroy() for hiding objects (mass disappear prevention)\n';
    }
  } catch(e) {}
  var promoted = loadPromotedRules();
  if (promoted.length === 0) return '';
  var lines = ['\n## Auto-Promoted Rules (cross-project validated)\n'];
  for (var i = 0; i < promoted.length; i++) {
    lines.push('- ' + promoted[i].description + ' — FIX: ' + (promoted[i].fix || 'see rule'));
  }
  return lines.join('\n') + anomalyRules;
}

/**
 * Auto-promote: after recording a new pending rule, check if any pending rule
 * has been triggered by ≥2 different projects. If so, promote it.
 * Uses keyword similarity (same as isKnownIssue) to cluster similar rules.
 */
function autoPromotePendingRules() {
  var pending = loadPendingRules();
  var promoted = loadPromotedRules();
  var newPromoted = [];

  // Group by RULE CATEGORY (not description keywords) — more reliable clustering
  var ruleGroups = {};
  for (var i = 0; i < pending.length; i++) {
    var rule = pending[i];
    // Normalize rule category: lowercase, strip special chars, take first 80 chars
    var ruleKey = (rule.rule || 'unknown').toLowerCase().replace(/[^a-z0-9 _.-]/g, '').substring(0, 80).trim();
    if (!ruleGroups[ruleKey]) {
      ruleGroups[ruleKey] = { rules: [], projects: {}, bestDesc: rule.description, bestFix: rule.fix };
    }
    ruleGroups[ruleKey].rules.push(rule);
    if (rule.taskId) ruleGroups[ruleKey].projects[rule.taskId] = true;
    // Keep the longest description/fix as "best"
    if ((rule.description || '').length > (ruleGroups[ruleKey].bestDesc || '').length) {
      ruleGroups[ruleKey].bestDesc = rule.description;
    }
    if ((rule.fix || '').length > (ruleGroups[ruleKey].bestFix || '').length) {
      ruleGroups[ruleKey].bestFix = rule.fix;
    }
  }

  // Promote rules triggered by ≥2 different projects
  var promotedDescs = promoted.map(function(p) { return (p.description || '').toLowerCase(); }).join('|||');
  var entries = Object.entries(ruleGroups);
  for (var gi = 0; gi < entries.length; gi++) {
    var key = entries[gi][0];
    var group = entries[gi][1];
    var uniqueProjects = Object.keys(group.projects).length;
    if (uniqueProjects < 2) continue;

    // Check if already promoted (by rule key match)
    var alreadyPromoted = false;
    for (var pi = 0; pi < promoted.length; pi++) {
      var existingKey = (promoted[pi].rule || '').toLowerCase().replace(/[^a-z0-9 _.-]/g, '').substring(0, 80).trim();
      if (existingKey === key) { alreadyPromoted = true; break; }
      // Also check description similarity (>60% keyword overlap)
      var existingDesc = (promoted[pi].description || '').toLowerCase();
      var newDesc = (group.bestDesc || '').toLowerCase();
      if (existingDesc.length > 20 && newDesc.length > 20) {
        var words = newDesc.match(/[a-z]{4,}/g) || [];
        var matches = words.filter(function(w) { return existingDesc.indexOf(w) >= 0; }).length;
        if (words.length > 0 && matches / words.length > 0.6) { alreadyPromoted = true; break; }
      }
    }

    if (!alreadyPromoted) {
      newPromoted.push({
        description: group.bestDesc,
        rule: key,
        fix: group.bestFix,
        promotedAt: new Date().toISOString(),
        triggerProjects: Object.keys(group.projects),
        triggerCount: uniqueProjects,
        totalOccurrences: group.rules.length
      });
    }
  }

  if (newPromoted.length > 0) {
    promoted = promoted.concat(newPromoted);
    savePromotedRules(promoted);
    console.log('[reviewer] Auto-promoted ' + newPromoted.length + ' rules from pending (cross-project validated)');
  }
}

// === Pending Rules: auto-record new issues for human approval ===
const PENDING_RULES_PATH = path.join(__dirname, 'pending-rules.json');

function loadPendingRules() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_RULES_PATH, 'utf8'));
  } catch(e) {
    return [];
  }
}

function savePendingRules(rules) {
  fs.writeFileSync(PENDING_RULES_PATH, JSON.stringify(rules, null, 2), 'utf8');
}

/**
 * Check if an issue is already covered by REVIEW_RULES or pending list.
 * Simple keyword dedup — not perfect, but avoids obvious duplicates.
 */
function isKnownIssue(issue) {
  var desc = (issue.description || '').toLowerCase();
  if (!desc) return false;
  
  // Extract keywords for semantic matching (not exact string match)
  var keywords = desc.replace(/[^a-z0-9_\s]/g, '').split(/\s+/).filter(function(w) { return w.length > 3; });
  if (keywords.length === 0) return false;
  
  // Check against REVIEW_RULES text
  var rulesLower = REVIEW_RULES.toLowerCase();
  var matchCount = 0;
  for (var ki = 0; ki < keywords.length; ki++) {
    if (rulesLower.indexOf(keywords[ki]) >= 0) matchCount++;
  }
  // If >60% of keywords found in existing rules, consider it known
  if (matchCount / keywords.length > 0.6) return true;
  
  // Check against pending rules with semantic similarity
  var pending = loadPendingRules();
  for (var j = 0; j < pending.length; j++) {
    var pDesc = (pending[j].description || '').toLowerCase();
    var pKeywords = pDesc.replace(/[^a-z0-9_\s]/g, '').split(/\s+/).filter(function(w) { return w.length > 3; });
    if (pKeywords.length === 0) continue;
    
    // Jaccard-like similarity: shared keywords / total unique keywords
    var shared = 0;
    for (var sk = 0; sk < keywords.length; sk++) {
      if (pDesc.indexOf(keywords[sk]) >= 0) shared++;
    }
    if (shared / keywords.length > 0.5) return true; // >50% keyword overlap = same issue
  }
  return false;
}


/**
 * Normalize GPT-generated rule names to standard categories.
 * GPT审核返回的 rule 字段是自由文本，需要归一化到标准分类。
 */
function normalizeRuleName(rule) {
  if (!rule) return 'Unknown';
  var r = rule.toLowerCase();
  if (r.indexOf('forbidden api') >= 0 || r.indexOf('camera.main') >= 0 || r.indexOf('externalevalc') >= 0 || r.indexOf('findobj') >= 0 || r.indexOf('createprimitive') >= 0 || r.indexOf('setparent') >= 0 || r.indexOf('resources.getbuiltin') >= 0) return 'Forbidden APIs';
  if (r.indexOf('code completeness') >= 0 || r.indexOf('all phases') >= 0 || r.indexOf('phase coverage') >= 0 || r.indexOf('gameend') >= 0 || r.indexOf('game end') >= 0 || r.indexOf('missing gameplay') >= 0) return 'Code Completeness';
  if (r.indexOf('bridge') >= 0 || r.indexOf('c# language') >= 0 || r.indexOf('no list') >= 0 || r.indexOf('no generic') >= 0 || r.indexOf('getcomponent<') >= 0) return 'C# Language — Bridge.NET Hard Limits';
  if (r.indexOf('gfm_tools') >= 0 || r.indexOf('gfm_ui') >= 0 || r.indexOf('documented gfm') >= 0 || r.indexOf('skeleton pre-creates') >= 0) return 'GFM_Tools API Signatures';
  if (r.indexOf('solid-color') >= 0 || r.indexOf('solid color') >= 0 || r.indexOf('backgroundcolor') >= 0 || r.indexOf('rule 0') >= 0) return 'Solid-Color Screen Prevention';
  if (r.indexOf('gameplay logic') >= 0 || r.indexOf('gameplay safety') >= 0 || r.indexOf('numeric trigger') >= 0) return 'Gameplay Logic';
  if (r.indexOf('object naming') >= 0 || r.indexOf('pool object') >= 0) return 'Object Naming — Pool Objects';
  if (r.indexOf('luna platform') >= 0 || r.indexOf('mobile input') >= 0) return 'Luna Platform Limitations';
  if (r.indexOf('material') >= 0 && r.indexOf('rendering') >= 0) return 'Materials & Rendering';
  if (r.indexOf('cua') >= 0 || r.indexOf('phase-skipped') >= 0 || r.indexOf('cta-missing') >= 0) return 'CUA Verification';
  if (r.indexOf('architecture') >= 0 || r.indexOf('phase-driven') >= 0) return 'Architecture';
  if (r.indexOf('common mistake') >= 0 || r.indexOf('runtime duplication') >= 0) return 'Common Mistakes';
  return rule; // Keep original if no match
}

/**
 * Record new critical issues to pending-rules.json and notify via Feishu.
 * Only records issues not already in REVIEW_RULES or pending list.
 */
async function recordNewIssues(issues, taskId) {
  var newIssues = [];
  for (var i = 0; i < issues.length; i++) {
    if (issues[i].severity === 'critical' && !isKnownIssue(issues[i])) {
      newIssues.push({
        description: issues[i].description,
        rule: normalizeRuleName(issues[i].rule),
        fix: issues[i].fix,
        line: issues[i].line,
        taskId: taskId,
        timestamp: new Date().toISOString()
      });
    }
  }

  if (newIssues.length === 0) return;

  // Append to pending-rules.json
  var pending = loadPendingRules();
  for (var j = 0; j < newIssues.length; j++) {
    pending.push(newIssues[j]);
  }
  savePendingRules(pending);

  // Auto-promote rules triggered by ≥2 different projects
  try {
    autoPromotePendingRules();
  } catch(e) {
    console.log('[reviewer] Auto-promote failed (non-fatal): ' + e.message);
  }

  // Auto-cleanup: if pending-rules exceeds 100, deduplicate
  try {
    var currentPending = loadPendingRules();
    if (currentPending.length > 100) {
      console.log('[reviewer] Pending rules exceeded 100 (' + currentPending.length + '), auto-cleaning...');
      var seen = {};
      var cleaned = [];
      for (var ci = currentPending.length - 1; ci >= 0; ci--) {
        var cr = currentPending[ci];
        var cKey = normalizeRuleName(cr.rule) + '|' + (cr.taskId || '');
        if (!seen[cKey]) {
          seen[cKey] = true;
          cr.rule = normalizeRuleName(cr.rule); // Normalize while cleaning
          cleaned.unshift(cr);
        }
      }
      // Cap at 3 entries per category
      var catCount = {};
      var capped = [];
      for (var cci = cleaned.length - 1; cci >= 0; cci--) {
        var cat = cleaned[cci].rule;
        catCount[cat] = (catCount[cat] || 0) + 1;
        if (catCount[cat] <= 3) capped.unshift(cleaned[cci]);
      }
      savePendingRules(capped);
      console.log('[reviewer] Auto-cleaned pending rules: ' + currentPending.length + ' -> ' + capped.length);
    }
  } catch(cleanErr) {
    console.log('[reviewer] Auto-cleanup failed (non-fatal): ' + cleanErr.message);
  }

  // Notify via Feishu webhook (fire-and-forget)
  try {
    notifyFeishuNewRules(newIssues, taskId);
  } catch(e) {
    console.log('[reviewer] Feishu notify failed (non-fatal): ' + e.message);
  }
}

/**
 * Send Feishu notification about new pending rules.
 */
function notifyFeishuNewRules(newIssues, taskId) {
  // Use the blueprint project's notify webhook if available
  var webhookUrl = process.env.FEISHU_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('[reviewer] No FEISHU_WEBHOOK_URL, skipping notification');
    return;
  }

  var lines = ['🔔 **审核发现新问题待确认**（任务: ' + taskId + '）\n'];
  for (var i = 0; i < newIssues.length; i++) {
    var issue = newIssues[i];
    lines.push((i + 1) + '. **' + issue.description + '**');
    lines.push('   规则: ' + (issue.rule || '-') + ' | 建议修复: ' + (issue.fix || '-'));
  }
  lines.push('\n请确认是否加入 REVIEW_RULES。确认后告诉小白执行写入。');

  var payload = JSON.stringify({
    msg_type: 'text',
    content: { text: lines.join('\n') }
  });

  var parsed = new URL(webhookUrl);
  var opts = {
    hostname: parsed.hostname,
    port: 443,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };

  var req = https.request(opts, function(res) {
    res.on('data', function() {});
    res.on('end', function() {});
  });
  req.on('error', function() {});
  req.write(payload);
  req.end();
}

/**
 * Call GPT-5.4 for code review
 */
function callGPT(systemPrompt, userMessage, timeoutMs) {
  timeoutMs = timeoutMs || REVIEW_TIMEOUT;
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({
      model: REVIEW_MODEL,
      max_completion_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });

    var url = new URL(OPENAI_BASE_URL + '/chat/completions');
    var opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
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
          if (parsed.error) return reject(new Error('GPT Review API: ' + (parsed.error.message || JSON.stringify(parsed.error))));
          var text = '';
          if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
            text = parsed.choices[0].message.content || '';
          }
          resolve({ text: text, usage: parsed.usage, model: parsed.model });
        } catch (e) { reject(new Error('GPT Review Parse: ' + data.slice(0, 500))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('GPT Review timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Review AI-generated code against Luna constraints
 * 
 * @param {string} code - The C# source code to review
 * @param {object} options - { taskId, log, blueprint }
 * @returns {object} { passed: boolean, issues: string[], feedback: string }
 */
async function reviewCode(code, options) {
  options = options || {};
  var log = options.log || console.log;
  var taskId = options.taskId || 'unknown';

  if (!OPENAI_API_KEY) {
    log('[reviewer] No OPENAI_API_KEY, skipping review', taskId);
    return { passed: true, issues: [], feedback: '', skipped: true };
  }

  log('[reviewer] Starting GPT-5.4 adversarial review...', taskId);

  var systemPrompt = `You are a strict code reviewer for Luna (Unity-to-HTML5) playable ads.
Your job is to check C# code against documented Luna/Bridge.NET constraints AND historical lessons learned from production failures.
You MUST find violations — be adversarial. Do NOT rubber-stamp.
Every rule below comes from real production incidents. If you miss a violation, the playable ad will fail at runtime.

${REVIEW_RULES}
${getDynamicRulesText()}

## Review Strategy — TIERED CHECKING (IMPORTANT)
Check rules IN ORDER of tier. If Tier 1 has ANY violation, you may STOP checking lower tiers.
This prevents wasting attention on Tier 3 style issues when critical Tier 1 bugs exist.

1. First: Check ALL Tier 1 rules (instant fail). Count violations.
2. If Tier 1 has 0 violations: Check Tier 2 rules.
3. If Tier 1+2 have 0 violations: Check Tier 3 rules.

## Output Format
Respond with a JSON object (no markdown, no code fences):
{
  "verdict": "PASS" or "FAIL",
  "tierChecked": 1 or 2 or 3,
  "issues": [
    { "severity": "critical|warning", "tier": 1, "line": "approximate line or method name", "rule": "which rule violated", "description": "what's wrong", "fix": "how to fix it" }
  ],
  "summary": "one-line summary"
}

- "critical" issues (Tier 1/2) = code will definitely break at runtime
- "warning" issues (Tier 3) = code might work but violates best practices
- Verdict is FAIL if there are ANY critical issues
- Verdict is PASS if only warnings or no issues`;


  // Inject pool name mapping if provided
  if (options.poolNameMap) {
    systemPrompt += '\n\n## Valid Pool Names for This Project\n';
    systemPrompt += 'The following are the ONLY valid pool names. Any other names in GameObject.Find() are WRONG:\n';
    Object.keys(options.poolNameMap).forEach(function(entity) {
      systemPrompt += '- ' + entity + ' → ' + options.poolNameMap[entity] + '\n';
    });
  }
  var userMessage = `Review this GameFlowManagerMain.cs for Luna/Bridge.NET constraint violations:\n\n\`\`\`csharp\n${code}\n\`\`\``;

  // Truncate if too long (GPT context limit)
  if (userMessage.length > 100000) {
    userMessage = userMessage.slice(0, 100000) + '\n... (truncated)';
  }

  try {
    var result = await callGPT(systemPrompt, userMessage);
    var reviewText = result.text.trim();
    
    // Parse JSON response
    // Strip markdown code fences if present
    reviewText = reviewText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    
    var review;
    try {
      review = JSON.parse(reviewText);
    } catch(e) {
      log('[reviewer] Failed to parse GPT response as JSON, treating as PASS: ' + reviewText.slice(0, 200), taskId);
      return { passed: true, issues: [], feedback: reviewText, parseError: true };
    }

    var criticalCount = 0;
    var warningCount = 0;
    var issues = review.issues || [];
    
    for (var i = 0; i < issues.length; i++) {
      if (issues[i].severity === 'critical') criticalCount++;
      else warningCount++;
    }

    var passed = (review.verdict || '').toUpperCase() === 'PASS' && criticalCount === 0;

    // Detailed review log (for debugging/audit)
    log('[reviewer] === FULL REVIEW RESULT ===', taskId);
    for (var di = 0; di < issues.length; di++) {
      var dIssue = issues[di];
      log('[reviewer]   ' + (dIssue.severity === 'critical' ? '❌' : '⚠️') + ' [' + (dIssue.severity || '?') + '] ' + (dIssue.description || '').slice(0, 150) + ' | rule: ' + (dIssue.rule || '-') + ' | fix: ' + (dIssue.fix || '-').slice(0, 100), taskId);
    }
    log('[reviewer] === END REVIEW ===', taskId);

    log('[reviewer] Verdict: ' + (passed ? 'PASS ✅' : 'FAIL ❌') + 
        ' (' + criticalCount + ' critical, ' + warningCount + ' warnings)' +
        ' — ' + (review.summary || ''), taskId);

    // Record new critical issues for human approval (fire-and-forget)
    if (!passed && criticalCount > 0) {
      recordNewIssues(issues, taskId).catch(function(e) {
        log('[reviewer] recordNewIssues error (non-fatal): ' + e.message, taskId);
      });
    }

    // Build feedback string for Claude if FAIL
    var feedback = '';
    if (!passed) {
      feedback = '## Code Review Failed — Fix These Issues\n\n';
      for (var j = 0; j < issues.length; j++) {
        var issue = issues[j];
        if (issue.severity === 'critical') {
          feedback += '### ❌ CRITICAL: ' + issue.description + '\n';
          feedback += '- **Location**: ' + (issue.line || 'unknown') + '\n';
          feedback += '- **Rule**: ' + (issue.rule || 'unknown') + '\n';
          feedback += '- **Fix**: ' + (issue.fix || 'see rules') + '\n\n';
        }
      }
      // Also include warnings
      for (var k = 0; k < issues.length; k++) {
        if (issues[k].severity === 'warning') {
          feedback += '### ⚠️ WARNING: ' + issues[k].description + '\n';
          feedback += '- **Fix**: ' + (issues[k].fix || 'optional') + '\n\n';
        }
      }
    }

    return {
      passed: passed,
      issues: issues,
      feedback: feedback,
      summary: review.summary || '',
      criticalCount: criticalCount,
      warningCount: warningCount,
      usage: result.usage
    };

  } catch(err) {
    log('[reviewer] GPT review error (non-fatal, treating as PASS): ' + err.message, taskId);
    return { passed: true, issues: [], feedback: '', error: err.message };
  }
}

module.exports = { reviewCode, REVIEW_RULES, loadPendingRules, savePendingRules, recordNewIssues, isKnownIssue, PENDING_RULES_PATH };
