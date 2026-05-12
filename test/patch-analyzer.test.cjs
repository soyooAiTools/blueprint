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

// ---------- 2026-05-12 P1a 扩展: TickVisualAnimations / SafeSetActive ----------

// 17. TickVisualAnimations injection
var r17 = pa.injectStubs(sampleCode, { TickVisualAnimations: 5 }, { mode: 'safe' });
assert.strictEqual(r17.changed, true);
assert.deepStrictEqual(r17.injected, ['TickVisualAnimations']);
assert.ok(/void TickVisualAnimations\(params object\[\] __args\)/.test(r17.code),
  'Case 17: stub uses params object[] for zero-arg/dt-arg overload coverage');

// 18. TickVisualAnimations idempotent
var r18 = pa.injectStubs(r17.code, { TickVisualAnimations: 5 }, { mode: 'safe' });
assert.strictEqual(r18.changed, false, 'Case 18: TickVisualAnimations idempotent');

// 19. SafeSetActive injection + null guard
var r19 = pa.injectStubs(sampleCode, { SafeSetActive: 2 }, { mode: 'safe' });
assert.strictEqual(r19.changed, true);
assert.deepStrictEqual(r19.injected, ['SafeSetActive']);
assert.ok(/void SafeSetActive\(GameObject __go, bool __on\)/.test(r19.code));
assert.ok(/if \(__go == null\) return;/.test(r19.code), 'Case 19: SafeSetActive null-guards GameObject');

// 20. 多 stub 同轮注入: SafeSetText + TickVisualAnimations + SafeSetActive 都缺时一次性补齐
var multiErr = [
  "Sources/X.cs(10,5): error CS0103: The name 'SafeSetText' does not exist in the current context",
  "Sources/X.cs(20,5): error CS0103: The name 'TickVisualAnimations' does not exist in the current context",
  "Sources/X.cs(30,5): error CS0103: The name 'SafeSetActive' does not exist in the current context",
].join('\n');
var a20 = pa.analyzeBuildError(multiErr);
var r20 = pa.injectStubs(sampleCode, a20.undeclaredNames, { mode: 'safe' });
assert.strictEqual(r20.changed, true);
assert.deepStrictEqual(r20.injected.sort(), ['SafeSetActive', 'SafeSetText', 'TickVisualAnimations']);
var openCount20 = (r20.code.match(/\{/g) || []).length;
var closeCount20 = (r20.code.match(/\}/g) || []).length;
assert.strictEqual(openCount20, closeCount20, 'Case 20: brace balance after triple inject');

// 21. env=safe + 真实多错误 build → maybePatch 一次注完
process.env.PATCH_ANALYZER_AUTO_STUB = 'safe';
var r21 = pa.maybePatch(sampleCode, multiErr);
delete process.env.PATCH_ANALYZER_AUTO_STUB;
assert.strictEqual(r21.changed, true);
assert.strictEqual(r21.mode, 'safe');
assert.strictEqual(r21.injected.length, 3);

// 22. 未匹配的 CS0103 名(如 NotInRegistry) 不会被任何 stub 接走
var r22 = pa.injectStubs(sampleCode, { NotInRegistry: 7 }, { mode: 'safe' });
assert.strictEqual(r22.changed, false);
assert.deepStrictEqual(r22.injected, []);

console.log('patch-analyzer: 22 cases passed');
