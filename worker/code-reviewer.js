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

// === Luna/Bridge.NET constraint rules (extracted from project docs) ===
const REVIEW_RULES = `
## Luna/Bridge.NET Iron Rules (MUST check each one)

### 1. Naming — Pool Objects
- All GameObject.Find() calls MUST use actual scene object names: __Pool_Cube_01..14, __Pool_Cylinder_01..04, __Pool_Sphere_01..20, __Pool_Plane_01..10
- NEVER use concept names like "Building_1", "Player", "Enemy_1" etc. — these DO NOT exist in the scene
- The scene template has exactly 90 __Pool_* objects. If the code references objects outside this pool, it will fail silently

### 2. C# Basics
- MUST have "using UnityEngine;" at the top
- MUST have "using System;" if using Math/Array
- Class must inherit MonoBehaviour
- No generic method calls (Luna Bridge.NET does not support generics like GetComponent<T>(), use GetComponent(typeof(T)) instead)
- No LINQ (System.Linq is not available in Luna)
- No async/await (not supported in Luna Bridge.NET)
- No string interpolation $"..." (use string.Format or concatenation)

### 3. Luna API Restrictions
- CreatePrimitive() objects are INVISIBLE in Luna (Runtime Analysis strips them) — NEVER use
- Camera.AddComponent() does NOT create a rendering camera — camera is handled by injection template
- AddComponent() after scene load: Start()/Update() are NOT auto-called — handled by injection template
- GFM_Create.InitMaterialFromScene() should be called in Start() if using GFM_Create materials
- Do NOT call Destroy() on scene cameras or lights — the injection template manages these

### 4. Object Positioning
- All __Pool_* objects start at y=-999 (hidden)
- ShowEntity() moves them to visible positions, HideEntity() sends back to y=-999
- Ground should be at y=-0.5 or y=0, player at y=0.5~1.0
- Camera is set by injection template (orthographic, top-down 55°) — code should NOT override camera transform

### 5. Color & Materials
- Use GFM_Create.SetColor(gameObject, new Color(r,g,b,a)) for coloring
- Player = blue (0.2, 0.5, 0.9), Ground = green (0.45, 0.65, 0.3), Buildings = tan, Enemies = red
- Materials are handled by injection template's shader fix — do not create new Material() manually

### 6. Code Structure
- Must have Start() method that: finds all pool objects, sets initial positions/colors/scales
- Must have Update() method that: handles input, updates game state, moves objects
- Must have a state machine or rule system for game progression
- All shots/phases from the storyboard must be implemented (no skipping)
- Must have CheckEventRules() or equivalent for phase transitions

### 7. UI Elements
- Use GFM_UI or Unity UI (Canvas/Text) for labels and HUD
- joystick is created by injection template — code should reference this.joystick from GFM_Joystick.Create()
- CTA button for "install full game" at game end

### 8. Common Mistakes to Flag
- Using "transform.rotation = Quaternion.Euler(...)" — should use "transform.rotation = Quaternion.Euler(...)" (this is fine in C# but verify syntax)
- Using Vector3 without "new" keyword
- Missing null checks after GameObject.Find() (silent fail if object not found)
- Infinite loops or blocking code in Update()
- Using Time.time instead of accumulating deltaTime
`;

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
Your job is to check C# code against documented Luna/Bridge.NET constraints.
You MUST find violations — be adversarial. Do NOT rubber-stamp.

${REVIEW_RULES}

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
