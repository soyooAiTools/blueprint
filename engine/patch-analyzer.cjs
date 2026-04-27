/**
 * Patch analyzer (2026-04-27).
 *
 * Inspects msbuild error output and applies deterministic fixes BEFORE the
 * compile fix-loop spends a Sonnet round on the problem. Targets the top
 * waste pattern from production logs:
 *   CS0103 'The name X does not exist in the current context'
 *
 * From 7-day pipeline.jsonl analysis (2026-04-27), CS0103 is the #1 compile
 * failure (230 occurrences, 5× the next-highest CS0111). The top names are
 * skeleton-helper hallucinations the LLM expects to exist:
 *   SafeSetText (60), TickVisualAnimations (19), AddLocalWorldLabel (18),
 *   CTA (13), IsNear (8), ...
 *
 * Each is a method/symbol whose intent is well-defined and whose canonical
 * implementation is safe (null-guarded, no-op on missing component). For
 * those, we inject the helper into the main file scope, which makes every
 * call site work as intended without any LLM round.
 *
 * Behavior is opt-in via env flag PATCH_ANALYZER_AUTO_STUB:
 *   'safe' (recommended) → only SafeSetText (well-understood, null-guarded)
 *   'all'  → enables every helper in the registry
 *   'off' (default)      → analysis-only, no mutation
 *
 * Pure where possible: analyzeBuildError() never mutates. injectStubs() only
 * mutates when env flag enables a specific stub.
 */

/**
 * Extract per-name CS0103 occurrence counts from msbuild output.
 * @param {string} errorOutput - raw msbuild stderr/stdout
 * @returns {{ undeclaredNames: Object<string,number>, totalCS0103: number }}
 */
function analyzeBuildError(errorOutput) {
  var undeclaredNames = {};
  var total = 0;
  var s = String(errorOutput || '');
  // Pattern: "error CS0103: The name 'X' does not exist in the current context"
  var re = /error CS0103:[^']*'([^']+)' does not exist in the current context/g;
  var m;
  while ((m = re.exec(s)) !== null) {
    var name = m[1];
    undeclaredNames[name] = (undeclaredNames[name] || 0) + 1;
    total++;
  }
  return { undeclaredNames: undeclaredNames, totalCS0103: total };
}

/**
 * Stub registry. Each entry knows:
 *   - `key`: the C# identifier the LLM hallucinates
 *   - `safe`: whether the stub is safe to ship under PATCH_ANALYZER_AUTO_STUB=safe
 *   - `defines(code)`: returns true iff the stub is already present
 *   - `stub`: the C# source text to splice into the main class body
 *
 * Stubs must be:
 *   1. Null-safe (every reference checked)
 *   2. Side-effect-bounded (no AddCompletedPhase, no AddResource, no global state mutation)
 *   3. Idempotent if injected twice (defines() catches that)
 */
var STUB_REGISTRY = [
  {
    key: 'SafeSetText',
    safe: true,
    defines: function(code) {
      // any of: void SafeSetText, public void SafeSetText, static void SafeSetText
      return /\b(?:public\s+|private\s+|protected\s+|static\s+|internal\s+)*void\s+SafeSetText\s*\(/.test(code);
    },
    stub: [
      '    // [PATCH-ANALYZER] auto-stub for hallucinated SafeSetText helper.',
      '    // Behavior: set Text/TextMesh component text, or no-op when target is null/missing component.',
      '    void SafeSetText(GameObject __go, string __s)',
      '    {',
      '        if (__go == null) return;',
      '        var __t = __go.GetComponent<UnityEngine.UI.Text>();',
      '        if (__t != null) { __t.text = __s ?? ""; return; }',
      '        var __tm = __go.GetComponent<TextMesh>();',
      '        if (__tm != null) { __tm.text = __s ?? ""; return; }',
      '    }',
      '',
    ].join('\n'),
  },
];

/**
 * Find the right insertion point: just before the LAST `}` of the main
 * GameFlowManagerMain class. Returns -1 if pattern not found (caller
 * should leave file untouched).
 */
function findClassClosingBrace(code) {
  // Find `class GameFlowManagerMain` or `partial class GameFlowManagerMain`
  var classRe = /\bpartial\s+class\s+GameFlowManagerMain\b|\bclass\s+GameFlowManagerMain\b/;
  var m = classRe.exec(code);
  if (!m) return -1;
  // Walk forward from match to find balanced braces — return the index of the
  // matching closing `}` for the class body.
  var openIdx = code.indexOf('{', m.index + m[0].length);
  if (openIdx < 0) return -1;
  var depth = 1;
  for (var i = openIdx + 1; i < code.length; i++) {
    var c = code[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Inject helper stubs for hallucinated names into main file.
 *
 * @param {string} code - GameFlowManagerMain.cs contents
 * @param {Object} undeclaredNames - { 'SafeSetText': 4, ... } from analyzeBuildError
 * @param {Object} opts - { mode: 'safe' | 'all' | 'off' }
 * @returns {{ changed: boolean, code: string, injected: string[] }}
 */
function injectStubs(code, undeclaredNames, opts) {
  opts = opts || {};
  var mode = opts.mode || 'off';
  if (mode === 'off') return { changed: false, code: code, injected: [] };
  if (typeof code !== 'string' || code.length === 0) return { changed: false, code: code, injected: [] };
  if (!undeclaredNames || typeof undeclaredNames !== 'object') return { changed: false, code: code, injected: [] };

  var injected = [];
  var nextCode = code;
  for (var i = 0; i < STUB_REGISTRY.length; i++) {
    var entry = STUB_REGISTRY[i];
    if (!Object.prototype.hasOwnProperty.call(undeclaredNames, entry.key)) continue;
    if (mode === 'safe' && !entry.safe) continue;
    if (entry.defines(nextCode)) continue; // already present
    var insertAt = findClassClosingBrace(nextCode);
    if (insertAt < 0) continue;
    nextCode = nextCode.slice(0, insertAt) + entry.stub + nextCode.slice(insertAt);
    injected.push(entry.key);
  }
  return { changed: injected.length > 0, code: nextCode, injected: injected };
}

/**
 * Read env PATCH_ANALYZER_AUTO_STUB and dispatch:
 *   'safe' → inject safe-flagged stubs for hallucinated names found in error output
 *   'all'  → inject every stub in registry that matches
 *   'off' (default) → no mutation, return analysis only
 */
function maybePatch(code, errorOutput, env) {
  env = env || process.env;
  var mode = String(env.PATCH_ANALYZER_AUTO_STUB || 'off').toLowerCase();
  var analysis = analyzeBuildError(errorOutput);
  if (mode === 'off' || mode === '' || mode === 'analyze') {
    return {
      changed: false,
      code: code,
      injected: [],
      mode: mode === 'off' ? 'off' : mode,
      analysis: analysis,
    };
  }
  var result = injectStubs(code, analysis.undeclaredNames, { mode: mode });
  result.mode = mode;
  result.analysis = analysis;
  return result;
}

module.exports = {
  analyzeBuildError: analyzeBuildError,
  injectStubs: injectStubs,
  maybePatch: maybePatch,
  findClassClosingBrace: findClassClosingBrace,
  _STUB_REGISTRY: STUB_REGISTRY,
};
