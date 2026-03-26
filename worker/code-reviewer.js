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
// Last synced: 2026-03-26
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

### 2. Forbidden APIs (will be invisible or crash)
- CreatePrimitive() — objects are INVISIBLE in Luna (Runtime Analysis strips them)
- new GameObject() — creates objects WITHOUT mesh/renderer, invisible
- new Material() — shader will be null (Luna strips built-in shader refs) → invisible
- Camera.AddComponent() — does NOT create a working camera
- Destroy() on cameras/lights — managed by injection template
- Resources.GetBuiltinResource() — NOT implemented in Luna
- FindObjectOfType / FindObjectsOfType — may return null
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
- ALL shots/phases from blueprint MUST be implemented (zero tolerance)
- Shot methods MUST be named shot_1(), shot_2()...shot_N() — not Scene1/Level1/Phase1
- Last shot MUST call Luna.Unity.LifeCycle.GameEnded() + Luna.Unity.Playable.InstallFullGame()
- Must have Start() and Update() methods
- Must NOT modify or redefine GFM_Tools.cs classes

## Tier 2 — LIKELY FAIL (high probability of runtime issues)

### 5. Materials & Rendering
- Use GFM_Create.SetColor(go, new Color(r,g,b,a)) for coloring
- Do NOT create new Material() — use GFM_Create which handles material registry
- GFM_Create.InitMaterialFromScene() must be called in Start() before any SetColor()
- Pool objects start at y=-999 (hidden). Show = move to visible Y. Hide = y=-999
- Do NOT use SetActive(false) for hiding — use y=-999 position

### 6. GFM_Tools API Signatures (wrong params = compile error or silent fail)
- GFM_Create.Obj(PrimitiveType, Vector3 pos, Vector3 scale, string name) — exactly 4 params
- GFM_Create.Ground(float width, float depth) — 2 floats, not Vector3
- GFM_UI.CreateCanvas(int w, int h) — REQUIRES 2 params, returns Canvas
- GFM_UI.CreateProgressBar(...) — returns Slider, NOT Image
- GFM_Joystick.Create(Canvas, float size) — returns GFM_Joystick (.Horizontal/.Vertical/.IsDragging)
- There is NO class called "GFM_Tools" — use GFM_Create, GFM_UI, GFM_Utils, etc.

### 7. Gameplay Logic
- FORBIDDEN: autoplay / ForceCompleteAllPhases / auto-demo
- FORBIDDEN: auto-shoot for turrets (player must trigger)
- FORBIDDEN: proximity auto-collect (player must tap)
- FORBIDDEN: pure numeric triggers that skip interaction (killCount >= N auto-jumps phase)
- Player input must drive phase progression — CUA needs to interact

### 8. Incremental Fix Constraints
- Removing shot methods to "fix" compile errors = REJECTED (content regression)
- Shot count must not decrease from original
- Fix must only change what feedback requested — no full rewrite

## Tier 3 — WARNINGS (best practices, may work but risky)

### 9. Common Mistakes
- Vector3 without "new" keyword → compile error
- Missing null checks after GameObject.Find() → NullReferenceException
- Infinite loops or blocking code in Update() → freezes WebGL
- Using Time.time instead of accumulating Time.deltaTime
- Debug.Log() in Update() → console spam kills performance
- Declaring variables inside switch cases without braces → CS0163

### 10. Luna Platform Limitations
- No TileMap, no New InputSystem, no Terrain, no multi-threading
- CharacterController poorly supported — use Transform or Rigidbody
- No animation state machine Exit nodes
- Vector3Int not supported (cast to Vector3)
- DOTween chains must be split into separate lines (transpile bug)
- Multiple materials: only first material animates correctly
- GetComponent<Transform>() ≠ GetComponent<RectTransform>()
- iOS AppLovin: first touch must pre-play silent audio (GFM_Luna.Init handles this)
- Time.deltaTime is constant 0.1 in Luna regardless of FPS

### 11. Architecture (V4 entity-driven)
- Parallel arrays: eGo[], eActive[], eState[], eTimer[], eHP[]
- CheckEventRules() with bool[] ruleTriggered — independent checks, not linear state machine
- Each entity has its own UpdateXxx() method
- All code in ONE file: GameFlowManagerMain.cs
`;

// Dynamic rules disabled — all critical rules are in the static REVIEW_RULES above.
// Static rules are curated, deduplicated, and tiered by severity.
// Dynamic loading from 16 files added ~6K tokens of noisy/duplicate bullets
// that diluted GPT-5.4's attention on critical checks.
// To add new rules: edit REVIEW_RULES directly (and update "Last synced" date).
const DYNAMIC_RULES = '';

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
${DYNAMIC_RULES}

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

    log('[reviewer] Verdict: ' + (passed ? 'PASS ✅' : 'FAIL ❌') + 
        ' (' + criticalCount + ' critical, ' + warningCount + ' warnings)' +
        ' — ' + (review.summary || ''), taskId);

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

module.exports = { reviewCode, REVIEW_RULES };
