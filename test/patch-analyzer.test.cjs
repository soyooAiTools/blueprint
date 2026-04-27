#!/usr/bin/env node
/**
 * 2026-04-27: patch-analyzer locks down CS0103 hallucination repair.
 *
 * Real production data (7-day pipeline log, 2026-04-27):
 *   - CS0103 = 230 occurrences (top compile failure)
 *   - 'SafeSetText' alone = 60 occurrences (26% of CS0103)
 *
 * The stub registry is allow-list; a wrong-shape stub would silently regress
 * UI behavior, so each entry is null-guarded and idempotent. Cases below
 * exercise both behaviors plus the env-flag dispatch.
 */

var assert = require('assert');
var pa = require('../engine/patch-analyzer.cjs');

// Real msbuild error text (verbatim from server-data/task-logs/proj_1776680895524_s6ae56)
var realError = [
  "msbuild failed: Sources/GameFlowManagerMain.cs(194,9): error CS0103: The name 'SafeSetText' does not exist in the current context [/tmp/luna-build-wpdl8e/Scripts/Scripts.csproj]",
  "Sources/GameFlowManagerMain.cs(326,86): error CS0103: The name 'SafeSetText' does not exist in the current context [/tmp/luna-build-wpdl8e/Scripts/Scripts.csproj]",
  "Sources/GameFlowManagerMain.cs(485,65): error CS0103: The name 'SafeSetText' does not exist in the current context [/tmp/luna-build-wpdl8e/Scripts/Scripts.csproj]",
].join('\n');

// ---------- analyzeBuildError ----------

// 1. count occurrences
var a1 = pa.analyzeBuildError(realError);
assert.strictEqual(a1.totalCS0103, 3, 'Case 1: 3 CS0103 lines');
assert.strictEqual(a1.undeclaredNames.SafeSetText, 3);

// 2. mixed names
var mixed = realError + "\nSources/X.cs(10,5): error CS0103: The name 'TickVisualAnimations' does not exist in the current context";
var a2 = pa.analyzeBuildError(mixed);
assert.strictEqual(a2.totalCS0103, 4);
assert.strictEqual(a2.undeclaredNames.SafeSetText, 3);
assert.strictEqual(a2.undeclaredNames.TickVisualAnimations, 1);

// 3. no CS0103 → empty
var a3 = pa.analyzeBuildError('Sources/X.cs(1,1): error CS0111: duplicate definition');
assert.strictEqual(a3.totalCS0103, 0);
assert.deepStrictEqual(a3.undeclaredNames, {});

// 4. empty/null input
assert.strictEqual(pa.analyzeBuildError('').totalCS0103, 0);
assert.strictEqual(pa.analyzeBuildError(null).totalCS0103, 0);

// ---------- findClassClosingBrace ----------

var sampleCode = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour',
  '{',
  '    void Start() { var x = 1; }',
  '    void Update() {',
  '        SafeSetText(_goldUi, "100");',
  '    }',
  '}',
].join('\n');
var braceIdx = pa.findClassClosingBrace(sampleCode);
assert.ok(braceIdx > 0, 'Case 4: must find closing brace');
assert.strictEqual(sampleCode.charAt(braceIdx), '}');
assert.strictEqual(braceIdx, sampleCode.lastIndexOf('}'));

// 5. no class → -1
assert.strictEqual(pa.findClassClosingBrace('var foo = 1;'), -1);

// ---------- injectStubs ----------

// 6. SafeSetText injection in 'safe' mode
var r6 = pa.injectStubs(sampleCode, { SafeSetText: 1 }, { mode: 'safe' });
assert.strictEqual(r6.changed, true);
assert.deepStrictEqual(r6.injected, ['SafeSetText']);
assert.ok(/void SafeSetText\(GameObject __go, string __s\)/.test(r6.code));
assert.ok(/PATCH-ANALYZER/.test(r6.code), 'Case 6: stub must include marker comment');
// Stub must be inside class
assert.ok(r6.code.lastIndexOf('void SafeSetText') < r6.code.lastIndexOf('}'));

// 7. idempotent: inject twice → no change second time
var r7a = pa.injectStubs(sampleCode, { SafeSetText: 1 }, { mode: 'safe' });
var r7b = pa.injectStubs(r7a.code, { SafeSetText: 1 }, { mode: 'safe' });
assert.strictEqual(r7b.changed, false, 'Case 7: idempotent');
assert.deepStrictEqual(r7b.injected, []);
assert.strictEqual(r7b.code, r7a.code);

// 8. no name match → no change
var r8 = pa.injectStubs(sampleCode, { 'SomeRandomName': 5 }, { mode: 'safe' });
assert.strictEqual(r8.changed, false);
assert.strictEqual(r8.code, sampleCode);

// 9. mode 'off' → never inject
var r9 = pa.injectStubs(sampleCode, { SafeSetText: 1 }, { mode: 'off' });
assert.strictEqual(r9.changed, false);
assert.strictEqual(r9.code, sampleCode);

// 10. existing definition (LLM happened to write one) → skip
var preDefined = sampleCode.replace('void Start()',
  'void SafeSetText(GameObject g, string s) {} \n    void Start()');
var r10 = pa.injectStubs(preDefined, { SafeSetText: 1 }, { mode: 'safe' });
assert.strictEqual(r10.changed, false, 'Case 10: must not double-inject');

// 11. malformed code (no class brace) → no-op, not crash
var r11 = pa.injectStubs('not C# at all', { SafeSetText: 1 }, { mode: 'safe' });
assert.strictEqual(r11.changed, false);

// ---------- maybePatch (env-flag dispatch) ----------

// 12. default (env unset) → analyze-only, no mutation
delete process.env.PATCH_ANALYZER_AUTO_STUB;
var r12 = pa.maybePatch(sampleCode, realError);
assert.strictEqual(r12.changed, false);
assert.strictEqual(r12.code, sampleCode);
assert.strictEqual(r12.mode, 'off');
assert.strictEqual(r12.analysis.totalCS0103, 3);
assert.strictEqual(r12.analysis.undeclaredNames.SafeSetText, 3);

// 13. env=safe → inject SafeSetText
process.env.PATCH_ANALYZER_AUTO_STUB = 'safe';
var r13 = pa.maybePatch(sampleCode, realError);
assert.strictEqual(r13.changed, true);
assert.strictEqual(r13.mode, 'safe');
assert.deepStrictEqual(r13.injected, ['SafeSetText']);
delete process.env.PATCH_ANALYZER_AUTO_STUB;

// 14. env=analyze → analysis only, no mutation
process.env.PATCH_ANALYZER_AUTO_STUB = 'analyze';
var r14 = pa.maybePatch(sampleCode, realError);
assert.strictEqual(r14.changed, false);
assert.strictEqual(r14.code, sampleCode);
assert.strictEqual(r14.analysis.totalCS0103, 3);
delete process.env.PATCH_ANALYZER_AUTO_STUB;

// 15. injected stub compiles to plausible C# — sanity-check brace balance after injection
process.env.PATCH_ANALYZER_AUTO_STUB = 'safe';
var r15 = pa.maybePatch(sampleCode, realError);
delete process.env.PATCH_ANALYZER_AUTO_STUB;
var openCount = (r15.code.match(/\{/g) || []).length;
var closeCount = (r15.code.match(/\}/g) || []).length;
assert.strictEqual(openCount, closeCount, 'Case 15: brace balance preserved');

// 16. SafeSetText stub null-guards — text grep
assert.ok(/if \(__go == null\) return;/.test(r15.code), 'Case 16: stub null-guards GameObject');

console.log('patch-analyzer: 16 cases passed');
