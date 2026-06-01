/**
 * 2026-05-31 Wave 1.b — static-rule-registry single-source-of-truth.
 *
 * Before this registry existed, the `non-ascii-resource-key` API whitelist was
 * maintained independently in TWO places:
 *   - engine/static-check.cjs:965  (rule `non-ascii-resource-key` body)
 *   - engine/stages/review.cjs:444 (sanitizeNonAsciiResourceApiKeys pre-repair)
 * Drift between the two silently broke fix-loop convergence (a key the rule
 * blocks but the sanitizer doesn't repair → infinite fix rounds).
 *
 * This test locks: (1) both consumers read engine/lib/static-rule-registry.cjs,
 * (2) the sanitizer repairs exactly what the rule blocks for every whitelisted
 * API, (3) the Wave 1.a comment-mask fix holds (comment-embedded CJK examples
 * in the skeleton ASCII-ONLY warning box are NOT false-positives).
 */

var fs = require('fs');
var path = require('path');
var { staticCheck } = require('../engine/static-check.cjs');
var review = require('../engine/stages/review.cjs');
var registry = require('../engine/lib/static-rule-registry.cjs');

var sanitize = review.sanitizeNonAsciiResourceApiKeys;

function nonAsciiIssues(code) {
  return staticCheck(code).issues.filter(function(i) { return i.rule === 'non-ascii-resource-key'; });
}

describe('static-rule-registry (Wave 1.b)', function() {
  it('exports the Step-1 keys with expected shape', function() {
    expect(Array.isArray(registry.RESOURCE_API_KEY_APIS)).toBe(true);
    expect(registry.RESOURCE_API_KEY_APIS.length).toBe(11);
    expect(registry.RESOURCE_API_KEY_APIS).toContain('AddResource');
    expect(registry.RESOURCE_API_KEY_APIS).toContain('GFM_ResourceIds.Normalize');
    expect(registry.RESOURCE_API_KEY_APIS).toContain('NotifyPhaseProgress');
    // canonical (unescaped) form — no backslash-escaped dots
    registry.RESOURCE_API_KEY_APIS.forEach(function(api) {
      expect(api).not.toContain('\\');
    });
    expect(registry.RESOURCE_API_KEY_NON_ASCII_RE instanceof RegExp).toBe(true);
  });

  it('both consumers read the registry (drift impossible)', function() {
    var sc = fs.readFileSync(path.join(__dirname, '..', 'engine', 'static-check.cjs'), 'utf8');
    var rv = fs.readFileSync(path.join(__dirname, '..', 'engine', 'stages', 'review.cjs'), 'utf8');
    expect(sc).toMatch(/staticRuleRegistry\.RESOURCE_API_KEY_APIS/);
    expect(rv).toMatch(/staticRuleRegistry\.RESOURCE_API_KEY_APIS/);
    expect(rv).toMatch(/staticRuleRegistry\.RESOURCE_API_KEY_NON_ASCII_RE/);
    // neither should still carry an inline duplicate of the whitelist
    expect(sc).not.toMatch(/'RecordPhaseEvidenceFlag',\s*'NotifyPhaseProgress'/);
    expect(rv).not.toMatch(/'GFM_ResourceIds\\\\\.Normalize'/);
  });

  it('rule blocks AND sanitizer repairs every whitelisted API (paired coverage)', function() {
    registry.RESOURCE_API_KEY_APIS.forEach(function(api) {
      var call = api + '("金币", 5);';
      // static-check rule flags it
      var issues = nonAsciiIssues('void Update(){ ' + call + ' }');
      expect(issues.length).toBeGreaterThanOrEqual(1);
      // sanitizer repairs it — result no longer trips the rule
      var fixed = sanitize(call);
      expect(fixed.changed).toBe(true);
      expect(nonAsciiIssues('void Update(){ ' + fixed.code + ' }').length).toBe(0);
    });
  });

  it('sanitizer fallbacks per API category when literal sanitizes to empty', function() {
    // NOTE: rule/sanitizer only inspect the FIRST arg when it is a string literal
    // (regex `api\s*\(\s*"`). EnterPhase's phase-id as a SECOND arg is matched by
    // neither — that gap is handled upstream in assembly-plan-pipeline. So these
    // cases use the first-arg call form deliberately.
    expect(sanitize('EnterPhase("，。、");').code).toContain('"phase"');
    expect(sanitize('CompletePhaseProgress("，。、");').code).toContain('"phase"');
    expect(sanitize('NotifyPhaseProgress("，。、");').code).toContain('"phase"');
    expect(sanitize('RecordPhaseEvidenceFlag("，。、", k);').code).toContain('"evidence"');
    expect(sanitize('AddResource("，。、", 5);').code).toContain('"Resource"');
    expect(sanitize('GFM_ResourceIds.Normalize("，。、");').code).toContain('"Resource"');
    expect(sanitize('GameObject.Find("，。、");').code).toContain('"Entity"');
  });

  it('leaves ASCII identifiers and empty-string args untouched', function() {
    expect(sanitize('AddResource("coins", 5);').changed).toBe(false);
    expect(sanitize('EnterPhase(0, "", true, true);').changed).toBe(false);
    expect(sanitize('AddResource("gold_v2", 5);').changed).toBe(false);
  });

  it('caps absurdly long sanitized identifiers at 32 chars', function() {
    var longAscii = 'AddResource("' + 'a'.repeat(80) + '中", 5);';
    var fixed = sanitize(longAscii);
    var m = fixed.code.match(/AddResource\("([^"]*)"/);
    expect(m).not.toBeNull();
    expect(m[1].length).toBeLessThanOrEqual(32);
  });

  it('Wave 1.a: comment-embedded CJK examples are NOT false-positives', function() {
    // Exact reverse-examples from skeleton-generator ASCII-ONLY warning box.
    var warningBox = [
      'void Update() {',
      '  // ✗  AddResource("金币", 5)             → ✓  AddResource(GFM_ResourceIds.Gold, 5)',
      '  // ✗  EnterPhase(1, "走向太空基地")      → ✓  EnterPhase(1, "phase1")',
      '  // ✗  RecordPhaseEvidenceFlag("中文", k) → ✓  RecordPhaseEvidenceFlag(currentPhaseName, k)',
      '  /* TrySpend("钻石", 1) in a block comment too */',
      '  AddResource("coins", 5);',
      '}',
    ].join('\n');
    expect(nonAsciiIssues(warningBox).length).toBe(0);
  });

  it('Wave 1.a: genuine CJK in real code is still flagged', function() {
    // Two first-arg-string violations (see note above re: first-arg-only matching).
    var real = 'void Update() { AddResource("金币", 5); GameObject.Find("玩家角色"); }';
    expect(nonAsciiIssues(real).length).toBe(2);
  });

  it('Wave 1.a: API name embedded inside a string literal is not flagged', function() {
    expect(nonAsciiIssues('Debug.Log("calling AddResource(\\"金币\\")");').length).toBe(0);
  });
});
