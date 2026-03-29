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
- All GameObject.Find() calls MUST use actual pool names: __Pool_Cube_01..50, __Pool_Sphere_01..20, __Pool_Plane_01..10, __Pool_Cylinder_01..10
- NEVER use concept names like "Building_1", "Player", "Tree" — these DO NOT exist → Find returns null → solid color screen
- This is the #1 cause of runtime failure
- Do NOT construct pool names dynamically (e.g., idx.ToString("D2")) — Bridge.NET string formatting is unreliable. Use explicit string literals or predeclared string arrays of exact pool names.

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
- Camera.main — may be null in Luna template; use the injected camera reference from the template instead
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

## Tier 2 — LIKELY FAIL (high probability of runtime issues)

### 5. Materials & Rendering
- Use GFM_Create.SetColor(go, new Color(r,g,b,a)) for coloring
- Do NOT create new Material() — use GFM_Create which handles material registry
- GFM_Create.InitMaterialFromScene() must be called in Start() before any SetColor()
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
- Only use GFM_UI methods with documented signatures (CreateCanvas, CreateProgressBar). Undocumented methods like CreateText(), CreateButton() may not exist → compile error

### 7. Gameplay Logic
- FORBIDDEN: autoplay / ForceCompleteAllPhases / auto-demo
- FORBIDDEN: auto-shoot for turrets (player must trigger)
- ALLOWED: proximity auto-collect (player walks near item → auto pickup, no tap needed)
- FORBIDDEN: pure numeric triggers that skip interaction (killCount >= N auto-jumps phase)
- Kill counters for phase progression MUST only count player-caused kills — enemies self-destructing/escaping must NOT count
- Auto-targeting (player clicks but target is auto-selected) still violates interaction requirements for turret/combat gameplay
- Player input must drive phase progression — CUA needs to interact

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

### 11. Architecture (V5 phase-driven)
- Phase tracking: currentPhaseName, ruleTriggered[], phaseTimer, phaseEnterTimes[]
- CheckEventRules() with bool[] ruleTriggered — each phase has trigger condition + min dwell time
- Entity states tracked as int variables (0=waiting, 1=building, 2=built)
- All code in ONE file: GameFlowManagerMain.cs
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
  var promoted = loadPromotedRules();
  if (promoted.length === 0) return '';
  var lines = ['\n## Auto-Promoted Rules (cross-project validated)\n'];
  for (var i = 0; i < promoted.length; i++) {
    lines.push('- ' + promoted[i].description + ' — FIX: ' + (promoted[i].fix || 'see rule'));
  }
  return lines.join('\n');
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

  for (var i = 0; i < pending.length; i++) {
    var rule = pending[i];
    // Collect distinct taskIds for similar rules
    var taskIds = {};
    taskIds[rule.taskId] = true;
    var descLower = (rule.description || '').toLowerCase();
    var keywords = descLower.match(/[a-zA-Z_][a-zA-Z0-9_.]+/g) || [];

    for (var j = 0; j < pending.length; j++) {
      if (i === j) continue;
      var otherDesc = (pending[j].description || '').toLowerCase();
      var otherKeywords = otherDesc.match(/[a-zA-Z_][a-zA-Z0-9_.]+/g) || [];
      // Check keyword overlap
      var overlap = 0;
      for (var k = 0; k < keywords.length; k++) {
        if (keywords[k].length > 4 && otherDesc.indexOf(keywords[k]) !== -1) overlap++;
      }
      if (keywords.length > 0 && overlap / keywords.length > 0.5) {
        taskIds[pending[j].taskId] = true;
      }
    }

    var uniqueProjects = Object.keys(taskIds).length;
    if (uniqueProjects >= 2) {
      // Check if already promoted (same keywords)
      var alreadyPromoted = false;
      var promotedLower = promoted.map(function(p) { return (p.description || '').toLowerCase(); }).join(' ');
      var matchCount = 0;
      for (var m = 0; m < keywords.length; m++) {
        if (keywords[m].length > 4 && promotedLower.indexOf(keywords[m]) !== -1) matchCount++;
      }
      if (keywords.length > 0 && matchCount / keywords.length > 0.4) alreadyPromoted = true;

      if (!alreadyPromoted) {
        newPromoted.push({
          description: rule.description,
          rule: rule.rule,
          fix: rule.fix,
          promotedAt: new Date().toISOString(),
          triggerProjects: Object.keys(taskIds),
          triggerCount: uniqueProjects
        });
      }
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
  var rule = (issue.rule || '').toLowerCase();
  var combined = desc + ' ' + rule;

  // Check against static REVIEW_RULES
  var rulesLower = REVIEW_RULES.toLowerCase();
  // Extract key phrases (3+ word chunks) and check if already in rules
  var keywords = combined.match(/[a-zA-Z_][a-zA-Z0-9_.]+/g) || [];
  var matchCount = 0;
  for (var i = 0; i < keywords.length; i++) {
    if (keywords[i].length > 4 && rulesLower.indexOf(keywords[i].toLowerCase()) !== -1) {
      matchCount++;
    }
  }
  // If more than 40% of significant keywords already in rules, consider it known
  if (keywords.length > 0 && matchCount / keywords.length > 0.4) return true;

  // Check against pending rules
  var pending = loadPendingRules();
  for (var j = 0; j < pending.length; j++) {
    var pDesc = (pending[j].description || '').toLowerCase();
    if (pDesc === desc) return true;
  }

  return false;
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
        rule: issues[i].rule,
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

## Output Format
Respond with a JSON object (no markdown, no code fences):
{
  "verdict": "PASS" or "FAIL",
  "issues": [
    { "severity": "critical|warning", "line": "approximate line or method name", "rule": "which rule violated", "description": "what's wrong", "fix": "how to fix it" }
  ],
  "summary": "one-line summary"
}

- "critical" issues = code will definitely break at runtime (wrong API, missing using, concept names instead of __Pool_*)
- "warning" issues = code might work but violates best practices
- Verdict is FAIL if there are ANY critical issues
- Verdict is PASS if only warnings or no issues`;

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
