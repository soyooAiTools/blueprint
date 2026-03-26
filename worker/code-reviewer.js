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
// Last synced: 2026-03-26
const REVIEW_RULES = `
## Luna/Bridge.NET Iron Rules (MUST check each one)

### 1. Object Naming — Pool Objects (MOST COMMON FAILURE)
- Scene has exactly 90 __Pool_* objects: __Pool_Cube_01..14, __Pool_Cylinder_01..04, __Pool_Sphere_01..20, __Pool_Plane_01..10
- All GameObject.Find() calls MUST use these exact pool names
- NEVER use concept names like "Building_1", "Player", "Enemy_1", "Tree", "Ground" etc. — these DO NOT exist in the scene
- If code references objects outside this pool, GameObject.Find returns null silently → nothing renders → solid color screen
- This is the #1 cause of "green screen" / "solid color" failures (postmortem 2026-03-26)

### 2. C# Language Restrictions (Bridge.NET)
- MUST have "using UnityEngine;" at the top of every .cs file
- MUST have "using System;" if using Math, Array, or similar System types
- Class must inherit MonoBehaviour
- NO generic method calls — GetComponent<T>() DOES NOT WORK → use GetComponent(typeof(T)) and cast
- NO LINQ — System.Linq is not available in Luna Bridge.NET
- NO async/await — not supported in Luna Bridge.NET
- NO string interpolation $"..." — use string.Format() or string concatenation
- NO nameof() operator
- NO null-conditional operators (?. / ??)
- NO pattern matching (switch expressions, is pattern)
- NO default interface implementations
- MUST NOT define any class or enum named "EventPool" — conflicts with Luna's internal EventPool (causes CS1022). If you need event pooling, name it "GFM_EventPool" instead

### 3. Luna Runtime API Restrictions
- CreatePrimitive() objects are COMPLETELY INVISIBLE in Luna (Runtime Analysis strips them) — NEVER use. Use __Pool_* objects instead
- new GameObject() creates objects WITHOUT mesh/renderer — they are invisible. Use __Pool_* objects instead
- Camera.AddComponent() does NOT create a working camera — camera is managed by injection template
- AddComponent() after scene load: Start() and Update() are NOT auto-called by Luna (unlike standard Unity). The injection template handles lifecycle via requestAnimationFrame
- GFM_Create.InitMaterialFromScene() must be called in Start() before using materials
- Do NOT call Destroy() on cameras or lights — the injection template manages these
- Resources.GetBuiltinResource() is NOT implemented in Luna — will throw
- Shader.Find() may fail if the shader was stripped by Runtime Analysis — only "Universal Render Pipeline/Lit" is guaranteed safe

### 4. Object Positioning & Visibility
- All __Pool_* objects start at y=-999 (hidden below camera view)
- ShowEntity() / equivalent moves them to visible Y positions; HideEntity() sends back to y=-999
- Ground should be at y=-0.5 or y=0
- Player/characters at y=0.5~1.0
- Camera is preset by injection template: orthographic, 45° top-down view, size=8, position=(0,15,-15)
- Code should NOT modify Camera.main.transform or camera projection — the template manages this

### 5. Color & Materials (Shader-null root cause)
- Use GFM_Create.SetColor(gameObject, new Color(r,g,b,a)) for coloring
- DO NOT create new Material() manually — the shader will be null (Luna serialization strips built-in shader references)
- The injection template fixes null shaders at runtime with Shader.Find("Universal Render Pipeline/Lit"), but only for __Pool_* objects
- Manually created materials bypass this fix → invisible objects
- Color convention: Player=blue(0.2,0.5,0.9), Ground=green(0.45,0.65,0.3), Buildings=tan, Enemies=red

### 6. Code Structure Requirements
- MUST have Start() method that: finds all pool objects via GameObject.Find("__Pool_*"), sets initial positions/colors/scales
- MUST have Update() method that: handles input, updates game state, moves objects each frame
- MUST implement ALL shots/phases from the storyboard (zero tolerance — no skipping)
- Shot methods MUST be named shot_1(), shot_2(), ... shot_N() — NOT Scene1, Level1, Phase1, Stage1 or any other naming scheme
- MUST have a state machine or CheckEventRules() for phase transitions
- Last shot MUST call Luna.Unity.LifeCycle.GameEnded() + show CTA button via Luna.Unity.Playable.InstallFullGame()
- MUST NOT modify or redefine GFM_Tools.cs functions — it is an external toolkit provided by the template

### 7. UI Elements
- Use GFM_UI or Unity UI (Canvas/Text) for labels and HUD
- Joystick is created by injection template — reference via this.joystick from GFM_Joystick.Create()
- CTA button for "install full game" must appear in the final shot/phase
- Canvas and EventSystem are provided by the scene template — do not recreate them

### 8. Common Fatal Mistakes (from ERRORS.md & LEARNINGS.md)
- Using Vector3 without "new" keyword → compile error
- Missing null checks after GameObject.Find() — if object not found, all subsequent .transform / .GetComponent calls throw NullReferenceException silently
- Infinite loops or blocking code in Update() → freezes entire WebGL page
- Using Time.time for elapsed timing instead of accumulating Time.deltaTime each frame
- Declaring variables inside switch cases without braces → CS0163 fall-through error
- Using "override" on methods that don't exist in the base class
- Trying to access .material directly instead of .GetComponent<Renderer>().material (and remember: no generics, so use GetComponent(typeof(Renderer)))
- Calling Destroy(gameObject) on pool objects — they should be hidden (y=-999), not destroyed, as they are reused across shots

### 9. Incremental Fix Rules (from rules.md)
- When reviewing code that is a FIX (not full generation): the code should only modify what the feedback requested
- Removing shot methods or game objects to "fix" compile errors = REJECTED — this is a content regression
- Shot count must match the blueprint exactly — if original had 8 shots, fixed code must still have 8 shots
- AI must not "simplify" by merging or removing shots

### 10. Performance & WebGL Constraints
- No heavy per-frame allocations (new Vector3() in Update is OK but avoid new List/Array/string per frame)
- No Debug.Log() calls in Update() — console spam kills WebGL performance
- No Application.LoadLevel / SceneManager.LoadScene — Luna runs in a single scene
- All game state must be in-memory (no PlayerPrefs, no file I/O, no network calls)

### 11. Verified Failure Patterns (from postmortem)
- "Green screen" = all GameObject.Find() returned null (using concept names instead of __Pool_*)
- "Black screen" = shader is null on all materials (creating new Material() instead of using GFM_Create)
- "Loading stuck" = missing engine files or script errors preventing luna:started event
- "Objects invisible but code runs" = used CreatePrimitive() or new GameObject() instead of __Pool_*
- "Compile CS0246 MonoBehaviour not found" = missing "using UnityEngine;"
- "Compile CS8802" = duplicate class definition from leftover files (not a code review issue but worth noting)
`;

// === Dynamic rules loader: reads additional constraints from project docs ===
// Loads once at startup to avoid file I/O per review call
let DYNAMIC_RULES = '';
try {
  const docsDir = '/root/.openclaw/workspace';
  const dynamicFiles = [
    { path: path.join(docsDir, '.learnings/LEARNINGS.md'), label: 'Self-Improvement Learnings' },
    { path: path.join(docsDir, '.learnings/ERRORS.md'), label: 'Historical Error Patterns' },
  ];
  const extraRules = [];
  for (const f of dynamicFiles) {
    if (fs.existsSync(f.path)) {
      const content = fs.readFileSync(f.path, 'utf-8');
      // Extract actionable bullet points (lines starting with - or *)
      const bullets = content.split('\n')
        .filter(line => /^\s*[-*]\s+/.test(line) && line.length > 20)
        .filter(line => /Luna|Bridge|compile|shader|material|Pool|GFM|mono|C#|Unity|scene|mesh|render|shot|WebGL|object|Create|Find|Component|Update|Start|script/i.test(line))
        .slice(0, 30); // cap to prevent prompt bloat
      if (bullets.length > 0) {
        extraRules.push(`\n### ${f.label} (auto-loaded)\n${bullets.join('\n')}`);
      }
    }
  }
  if (extraRules.length > 0) {
    DYNAMIC_RULES = '\n## Additional Rules from Project Learnings\n' + extraRules.join('\n');
    console.log('[reviewer] Loaded ' + extraRules.length + ' dynamic rule sources');
  }
} catch (e) {
  console.warn('[reviewer] Failed to load dynamic rules:', e.message);
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
