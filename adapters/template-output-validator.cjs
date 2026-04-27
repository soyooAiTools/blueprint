/**
 * Template Output Validator — deterministic post-template-fill QA.
 *
 * Runs immediately after `templateEngine.fillSkeleton()` (before review/LLM).
 * Catches structural defects in the schema → C# wiring that the LLM reviewer
 * would otherwise burn 1-4 rounds chasing. Three checks today:
 *
 *   1. Phase ID coverage — every schema.phases[i].phaseId must have a matching
 *      AddCompletedPhase("...") call somewhere in the aggregate code (main +
 *      partials). Reuses the fuzzy matcher from assembly-plan-contracts so
 *      camelCase ↔ snake_case drift doesn't false-positive.
 *
 *   2. NPC method coverage — every schema.npcs[i] with a registered template
 *      must (a) emit `void Update<Entity>(...)` definition AND (b) be called
 *      from a Update-style method. A defined-but-uncalled NPC system is the
 *      single largest class of "static wall" runtime bugs.
 *
 *   3. Marker residue — no `// TODO_*_START` / `// TODO_*_END` pair may have
 *      blank/whitespace-only body in the final code. The template engine emits
 *      these markers and fills between them; a residue means a template silently
 *      skipped a section, which the LLM then has to invent from scratch.
 *
 * Returns: { passed, issues:[{severity,rule,message,...}], summary:{...} }
 *
 * Pure: no side effects, no I/O, no ctx mutation.
 */

var assemblyPlanContracts = require('../engine/assembly-plan-contracts.cjs');

// NPC templates that DON'T register a generateSystem (no Update<Entity> method
// expected). Keep in sync with codegen-template-engine.cjs NPC_TEMPLATES.
// All current templates DO emit a system, so this is empty — kept as a hook
// for future template additions (e.g. pure-decorative NPCs).
var NPC_TEMPLATES_WITHOUT_SYSTEM = {};

function buildAggregateCode(csCode, extraFiles) {
  var code = String(csCode || '');
  if (extraFiles && typeof extraFiles === 'object') {
    Object.keys(extraFiles).forEach(function(name) {
      if (typeof extraFiles[name] === 'string') code += '\n' + extraFiles[name];
    });
  }
  return code;
}

function checkPhaseCoverage(schema, aggregateCode) {
  var issues = [];
  var phases = (schema && Array.isArray(schema.phases)) ? schema.phases : [];
  var expectedIds = phases.map(function(p) { return p && p.phaseId; }).filter(Boolean);
  if (expectedIds.length === 0) {
    return { issues: issues, coverage: 1, expected: 0, implemented: 0, missing: [] };
  }
  var coverageInfo = assemblyPlanContracts.computePhaseCoverage(aggregateCode, expectedIds);
  if (coverageInfo.coverage < 1.0) {
    coverageInfo.missingPhaseIds.forEach(function(pid) {
      issues.push({
        severity: 'critical',
        rule: 'phase-coverage',
        message: 'Schema phase "' + pid + '" has no AddCompletedPhase("' + pid + '") call in aggregate code (main + partials). Template engine should have wired this — schema → C# binding is broken.',
      });
    });
  }
  return {
    issues: issues,
    coverage: coverageInfo.coverage,
    expected: expectedIds.length,
    implemented: coverageInfo.implementedCount,
    missing: coverageInfo.missingPhaseIds,
  };
}

function checkNpcMethods(schema, aggregateCode) {
  var issues = [];
  var npcs = (schema && Array.isArray(schema.npcs)) ? schema.npcs : [];
  var checked = 0;
  var defined = 0;
  var called = 0;
  for (var i = 0; i < npcs.length; i++) {
    var npc = npcs[i];
    if (!npc || !npc.template || !npc.entity) continue;
    if (NPC_TEMPLATES_WITHOUT_SYSTEM[npc.template]) continue;
    var entity = String(npc.entity);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entity)) continue; // skip exotic names
    checked++;
    var defRe = new RegExp('void\\s+Update' + entity + '\\s*\\(');
    var callRe = new RegExp('Update' + entity + '\\s*\\(\\s*(?:Time\\.deltaTime|dt|[0-9.]+f?)');
    var hasDef = defRe.test(aggregateCode);
    var hasCall = callRe.test(aggregateCode);
    if (hasDef) defined++;
    if (hasCall) called++;
    if (!hasDef) {
      issues.push({
        severity: 'critical',
        rule: 'npc-method-missing-def',
        message: 'NPC "' + entity + '" (template=' + npc.template + ') has no `void Update' + entity + '(...)` definition. Template generateSystem() did not emit the method body.',
      });
    } else if (!hasCall) {
      issues.push({
        severity: 'critical',
        rule: 'npc-method-uncalled',
        message: 'NPC "' + entity + '" (template=' + npc.template + ') has `Update' + entity + '(...)` defined but never called from any Update flow. Behavior method is dead code — NPC will not animate at runtime.',
      });
    }
  }
  return {
    issues: issues,
    checked: checked,
    defined: defined,
    called: called,
  };
}

function checkMarkerResidue(csCode, extraFiles) {
  var issues = [];
  var residueCount = 0;
  var files = [{ name: 'GameFlowManagerMain.cs', code: String(csCode || '') }];
  if (extraFiles && typeof extraFiles === 'object') {
    Object.keys(extraFiles).forEach(function(n) {
      if (typeof extraFiles[n] === 'string') files.push({ name: n, code: extraFiles[n] });
    });
  }
  var startRe = /\/\/\s*(TODO_[A-Z0-9_]+)_START\b/g;
  for (var i = 0; i < files.length; i++) {
    var src = files[i].code;
    var fname = files[i].name;
    var m;
    startRe.lastIndex = 0;
    while ((m = startRe.exec(src)) !== null) {
      var key = m[1];
      var startIdx = m.index + m[0].length;
      var endMarker = '// ' + key + '_END';
      var endIdx = src.indexOf(endMarker, startIdx);
      if (endIdx < 0) continue; // unmatched markers are not validator's job (codegen-schema handles)
      var body = src.substring(startIdx, endIdx);
      // Strip comments and whitespace; if nothing left, the section is empty.
      var stripped = body.replace(/\/\*[\s\S]*?\*\//g, '')
                         .replace(/\/\/.*$/gm, '')
                         .replace(/\s+/g, '');
      if (stripped.length === 0) {
        residueCount++;
        issues.push({
          severity: 'critical',
          rule: 'marker-residue',
          message: 'Empty TODO marker block "' + key + '" in ' + fname + ' — template engine emitted markers but filled no code between them. AI reviewer will see a hole and try to invent fill.',
          file: fname,
          marker: key,
        });
      }
    }
  }
  return { issues: issues, residueCount: residueCount };
}

/**
 * @param {object} input - { schema, csCode, extraFiles }
 * @returns {{passed:boolean, issues:Array, summary:object}}
 */
function validateTemplateOutput(input) {
  input = input || {};
  var schema = input.schema || {};
  var csCode = input.csCode || '';
  var extraFiles = input.extraFiles || {};
  var aggregateCode = buildAggregateCode(csCode, extraFiles);

  var phaseResult = checkPhaseCoverage(schema, aggregateCode);
  var npcResult = checkNpcMethods(schema, aggregateCode);
  var markerResult = checkMarkerResidue(csCode, extraFiles);

  var allIssues = phaseResult.issues
    .concat(npcResult.issues)
    .concat(markerResult.issues);
  var critical = allIssues.filter(function(i) { return i.severity === 'critical'; });

  return {
    passed: critical.length === 0,
    issues: allIssues,
    summary: {
      phaseCoverage: phaseResult.coverage,
      phaseExpected: phaseResult.expected,
      phaseImplemented: phaseResult.implemented,
      phaseMissing: phaseResult.missing,
      npcChecked: npcResult.checked,
      npcDefined: npcResult.defined,
      npcCalled: npcResult.called,
      markerResidueCount: markerResult.residueCount,
      criticalCount: critical.length,
      totalIssueCount: allIssues.length,
    },
  };
}

/**
 * Convenience wrapper for codegen-schema: pulls schema/csCode/extraFiles off ctx.
 */
function validateFromContext(ctx) {
  var schema = ctx && ctx.blueprint && ctx.blueprint.gameSchema;
  return validateTemplateOutput({
    schema: schema,
    csCode: ctx && ctx.csCode,
    extraFiles: ctx && ctx.extraFiles,
  });
}

module.exports = {
  validateTemplateOutput: validateTemplateOutput,
  validateFromContext: validateFromContext,
  _internals: {
    checkPhaseCoverage: checkPhaseCoverage,
    checkNpcMethods: checkNpcMethods,
    checkMarkerResidue: checkMarkerResidue,
    buildAggregateCode: buildAggregateCode,
  },
};
