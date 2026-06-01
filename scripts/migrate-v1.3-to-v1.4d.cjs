#!/usr/bin/env node
'use strict';

// task #52 (v1.4d-ε) + task #53 (v1.4d-ζ Axis A) — fidelityContract v1.3.0 → v1.4.0 migration.
//
// task #52 (ε) — Single-axis fix for hud=22 bucket regression detected after
// #45/#46 ship. Root cause: hud[].text was authored as phase-static plain
// string (only phase1 values). DOM observer + extractor correctly emit
// per-phase text; field-diff gate already supports `resolvePolymorphicText`
// shape. The only break is at Stage 1 (contract authoring).
//
// task #53 (ζ Axis A) — Fix `hud.targethint` formula. ε wrongly used
// `PHASES[i].guideText` (long guide sentence) — that mirrored the worker's
// own bug (storyboard2html template — task #54 Axis B). Source HTML L183
// truth is `"目标：" + ENTITY_STYLE[currentStep.target].label`. Because
// `hud.targethint` is phase-level (single value), we resolve it at phase
// entry: `"目标：" + ENTITY_STYLE[steps[0].target].label`.
//
// This migration folds the source HTML's PHASES array into polymorphic
// records `{perPhase: {phaseId: text}}` for the 3 HUD slots whose text
// varies per phase:
//   - hud.phase       → "Phase N/8"                                  (derived from phase index)
//   - hud.tip         → PHASES[i].guideText                          (long guide sentence)
//   - hud.targethint  → "目标：" + ENTITY_STYLE[steps[0].target].label (short entity label, task #53)
//
// Other HUD slots (hud.label.*, hud.iceHud, hud.oxygenHud, hud.coinHud,
// hud.scrapHud, hud.toolHud, etc.) are NOT touched — their text either is
// phase-constant (label.*) or surfaces under a separate runtime-state
// bucket out of v1.4d scope.
//
// scope boundary (Sam ratify msg=74953e2e):
//   - data-only contract producer change; no worker/renderer changes
//   - no descriptor severity change (field-diff already blocking=true)
//   - schemaVersion bump 1.3.0 → 1.4.0 with #12 three-way sync
//     (engine SCHEMA_VERSION, descriptor acceptedInstanceSchemaVersions,
//      contract instance schemaVersion)
//   - plain-string `hud[].text` from older contracts stays advisory
//     (backward-compat for v0.5 / v1.0~v1.3)
//
// Behavior:
//   1. Accept v1.3.0 OR v1.4.0 input (idempotent on v1.4.0 unless --force-reextract).
//   2. Extract PHASES array from source HTML (deterministic regex).
//   3. For each of the 3 polymorphic-eligible HUD slots, replace `.text` with
//      `{perPhase: {phaseN: ...}}` covering all extracted phases.
//   4. CONDITIONAL schemaVersion bump (mirrors v1.2→v1.3 discipline):
//      - Bump 1.3.0 → 1.4.0 IFF every targeted HUD slot was successfully
//        rewritten with all 8 (or N source-declared) phases populated.
//      - Otherwise: stay at 1.3.0, partialMigration:true, advisory gaps appended.

var fs = require('fs');
var path = require('path');

var POLYMORPHIC_HUD_IDS = ['hud.phase', 'hud.tip', 'hud.targethint'];
var TARGETHINT_PREFIX = '\u76ee\u6807\uff1a'; // "目标："

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

// Extract the PHASES array literal from source HTML. Returns the body string
// (between `[` and `]`), or null if not found.
function extractPhasesBlock(html) {
  // Match both `const PHASES = [...]` and `var PHASES = [...]`.
  var m = html.match(/(?:const|var|let)\s+PHASES\s*=\s*\[([\s\S]*?)\];\s*(?:window\.PHASES|<\/script>|$)/);
  if (m) return m[1];
  // Looser fallback — just look for `PHASES = [ ... ]`.
  m = html.match(/PHASES\s*=\s*\[([\s\S]*?)\];/);
  return m ? m[1] : null;
}

// Parse PHASES block into [{id, guideText, firstStepTarget}, ...]. Each phase
// is a top-level `{...}` object inside PHASES. We scan for top-level objects
// by balancing braces (PHASES entries contain nested `steps[]` and
// `trigger{}` objects). `firstStepTarget` is the `target` of the first step
// inside `steps:[]` — used by task #53 hud.targethint resolution.
function parsePhases(blockBody) {
  var out = [];
  var depth = 0;
  var start = -1;
  for (var i = 0; i < blockBody.length; i++) {
    var ch = blockBody.charCodeAt(i);
    if (ch === 123 /* { */) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === 125 /* } */) {
      depth--;
      if (depth === 0 && start >= 0) {
        var entry = blockBody.slice(start, i + 1);
        var idM = entry.match(/\bid\s*:\s*["']([^"']+)["']/);
        var guideM = entry.match(/\bguideText\s*:\s*["']([^"']+)["']/);
        var firstStepM = entry.match(/\bsteps\s*:\s*\[\s*\{[^}]*?\btarget\s*:\s*["']([^"']+)["']/);
        if (idM && guideM) {
          out.push({
            id: idM[1],
            guideText: guideM[1],
            firstStepTarget: firstStepM ? firstStepM[1] : null
          });
        }
        start = -1;
      }
    }
  }
  return out;
}

// Extract the ENTITY_STYLE block body from source HTML (between `{` and `};`).
// Returns the body string or null.
function extractEntityStyleBlock(html) {
  var m = html.match(/(?:const|var|let)\s+ENTITY_STYLE\s*=\s*\{([\s\S]*?)\};/);
  return m ? m[1] : null;
}

// Parse ENTITY_STYLE block into { entityName: label }. Each entry has the
// shape `Name:{label:"...",color:0x...,kind:"..."}` (flat — no nested
// objects, so a single-`}`-terminated regex is safe).
function parseEntityStyle(blockBody) {
  var out = {};
  var re = /(\w+)\s*:\s*\{[^}]*?\blabel\s*:\s*["']([^"']+)["'][^}]*?\}/g;
  var m;
  while ((m = re.exec(blockBody)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function buildPolymorphicHud(phases, entityStyleLabel) {
  entityStyleLabel = entityStyleLabel || {};
  var perPhasePhase = {};
  var perPhaseTip = {};
  var perPhaseTargetHint = {};
  var unresolvedTargetHintPhases = [];
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    perPhasePhase[p.id] = 'Phase ' + (i + 1) + '/' + phases.length;
    perPhaseTip[p.id] = p.guideText;
    var entityLabel = p.firstStepTarget && entityStyleLabel[p.firstStepTarget];
    if (entityLabel) {
      perPhaseTargetHint[p.id] = TARGETHINT_PREFIX + entityLabel;
    } else {
      unresolvedTargetHintPhases.push(p.id);
    }
  }
  return {
    'hud.phase': { perPhase: perPhasePhase },
    'hud.tip': { perPhase: perPhaseTip },
    'hud.targethint': { perPhase: perPhaseTargetHint },
    unresolvedTargetHintPhases: unresolvedTargetHintPhases
  };
}

function isPlainString(v) { return typeof v === 'string'; }

function migrate(contract, opts) {
  opts = opts || {};
  if (!contract || typeof contract !== 'object') {
    throw new Error('input contract must be an object');
  }
  if (contract.schemaVersion !== '1.3.0' && contract.schemaVersion !== '1.4.0') {
    throw new Error('input schemaVersion must be 1.3.0 or 1.4.0, got ' + contract.schemaVersion);
  }

  var out = deepClone(contract);

  var report = {
    kind: 'blueprint.fidelityContract.migrationReport',
    schemaVersion: '1.4.0',
    fromVersion: contract.schemaVersion,
    toVersion: null,
    generatedAt: new Date().toISOString(),
    counts: {
      hudEntriesTotal: (out.hud || []).length,
      phasesExtracted: 0,
      hudSlotsRewritten: 0,
      hudSlotsMissingInContract: 0,
      hudSlotsAlreadyPolymorphic: 0
    },
    partialMigration: false,
    bumpedSchemaVersion: false,
    advisoryGaps: [],
    sourceHtmlPath: opts.sourceHtml || null,
    rewrittenSlots: []
  };

  if (!opts.sourceHtml) {
    report.partialMigration = true;
    report.toVersion = contract.schemaVersion;
    report.advisoryGaps.push({
      id: 'v14d-no-source-html',
      path: '$.hud[].text',
      message: 'sourceHtml not provided; v1.4d polymorphic hud cannot be reverse-extracted — staying at ' + contract.schemaVersion,
      blocking: false,
      source: 'migrate-v1.3-to-v1.4d',
      kind: 'v14d-hud-polymorphic'
    });
    return { contract: out, report: report };
  }

  var html = fs.readFileSync(opts.sourceHtml, 'utf8');
  var phasesBlock = extractPhasesBlock(html);
  var phases = phasesBlock ? parsePhases(phasesBlock) : [];
  report.counts.phasesExtracted = phases.length;

  if (phases.length === 0) {
    report.advisoryGaps.push({
      id: 'v14d-phases-missing',
      path: 'PHASES',
      message: 'PHASES array not found or empty in source HTML — cannot fold polymorphic hud',
      blocking: false,
      source: 'migrate-v1.3-to-v1.4d',
      kind: 'v14d-hud-polymorphic'
    });
    out.schemaVersion = contract.schemaVersion;
    report.toVersion = contract.schemaVersion;
    report.partialMigration = true;
    return { contract: out, report: report };
  }

  var entityStyleBlock = extractEntityStyleBlock(html);
  var entityStyleLabel = entityStyleBlock ? parseEntityStyle(entityStyleBlock) : {};
  report.counts.entityStyleLabelsExtracted = Object.keys(entityStyleLabel).length;

  var polymorphic = buildPolymorphicHud(phases, entityStyleLabel);
  var targetHintUnresolved = polymorphic.unresolvedTargetHintPhases || [];
  var targetHintFullyResolved = targetHintUnresolved.length === 0;
  if (!targetHintFullyResolved) {
    report.advisoryGaps.push({
      id: 'v14d-targethint-unresolved',
      path: '$.hud[id=hud.targethint].text.perPhase',
      message: 'hud.targethint could not resolve ENTITY_STYLE label for phases: ' +
        targetHintUnresolved.join(',') + ' — slot left untouched',
      blocking: false,
      source: 'migrate-v1.3-to-v1.4d',
      kind: 'v14d-hud-polymorphic'
    });
  }

  var hudById = {};
  var huds = out.hud || [];
  for (var i = 0; i < huds.length; i++) {
    if (huds[i] && huds[i].id) hudById[huds[i].id] = huds[i];
  }

  for (var k = 0; k < POLYMORPHIC_HUD_IDS.length; k++) {
    var slotId = POLYMORPHIC_HUD_IDS[k];
    var entry = hudById[slotId];
    if (!entry) {
      report.counts.hudSlotsMissingInContract++;
      report.advisoryGaps.push({
        id: 'v14d-hud-slot-missing:' + slotId,
        path: '$.hud[id=' + slotId + ']',
        message: 'hud slot ' + slotId + ' not present in contract — skipped',
        blocking: false,
        source: 'migrate-v1.3-to-v1.4d',
        kind: 'v14d-hud-polymorphic'
      });
      continue;
    }
    // Already polymorphic (has perPhase) — idempotent skip unless --force.
    if (!isPlainString(entry.text) && entry.text && entry.text.perPhase && !opts.forceReextract) {
      report.counts.hudSlotsAlreadyPolymorphic++;
      continue;
    }
    // task #53 (ζ) — if hud.targethint can't be fully resolved against
    // ENTITY_STYLE, leave the slot untouched (advisory gap already emitted).
    // Better to preserve old shape than partially fold (would mis-rebump).
    if (slotId === 'hud.targethint' && !targetHintFullyResolved) {
      continue;
    }
    entry.text = polymorphic[slotId];
    entry.provenance = {
      source: 'html',
      confidence: 1,
      extractedFrom: slotId === 'hud.targethint'
        ? 'PHASES[].steps[0].target + ENTITY_STYLE[].label (' + phases.length + ' phases)'
        : 'PHASES[].guideText (' + phases.length + ' phases)'
    };
    report.counts.hudSlotsRewritten++;
    report.rewrittenSlots.push(slotId);
  }

  // Conditional bump — all 3 polymorphic slots must be present and rewritten
  // (or already polymorphic from a prior run), AND hud.targethint must be
  // fully resolvable against ENTITY_STYLE. Otherwise → partial, stay at input
  // schemaVersion. This keeps task #53 ground-truth gate honest: a 1.4.0
  // bump means every polymorphic slot is sourced from the source-HTML truth.
  var fullyCovered = (
    (report.counts.hudSlotsRewritten + report.counts.hudSlotsAlreadyPolymorphic) === POLYMORPHIC_HUD_IDS.length
    && targetHintFullyResolved
  );
  if (fullyCovered && phases.length > 0) {
    out.schemaVersion = '1.4.0';
    report.toVersion = '1.4.0';
    report.bumpedSchemaVersion = true;
    report.partialMigration = false;
  } else {
    out.schemaVersion = contract.schemaVersion;
    report.toVersion = contract.schemaVersion;
    report.bumpedSchemaVersion = false;
    report.partialMigration = true;
  }

  if (report.advisoryGaps.length) {
    out.unresolvedFidelityGaps = (out.unresolvedFidelityGaps || []).concat(
      report.advisoryGaps.map(function(g) { return deepClone(g); })
    );
  }

  return { contract: out, report: report };
}

function usage(exitCode) {
  console.error('Usage: node scripts/migrate-v1.3-to-v1.4d.cjs --in <path/in.json> --out <path/out.json> --source-html <path/source.html> [--dry-run] [--report <path>] [--force-reextract]');
  process.exit(exitCode === undefined ? 2 : exitCode);
}

function parseArgs(argv) {
  var opts = {
    in: null, out: null, sourceHtml: null,
    dryRun: false, reportPath: null, forceReextract: false
  };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--in') opts.in = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--source-html') opts.sourceHtml = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report') opts.reportPath = argv[++i];
    else if (a === '--force-reextract') opts.forceReextract = true;
    else if (a === '--help' || a === '-h') usage(0);
    else usage();
  }
  if (!opts.in || !opts.out) usage();
  return opts;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  var opts = parseArgs(process.argv);
  var inPath = path.resolve(opts.in);
  var outPath = path.resolve(opts.out);
  if (!fs.existsSync(inPath)) {
    console.error('input not found: ' + inPath);
    process.exit(1);
  }
  if (opts.sourceHtml && !fs.existsSync(path.resolve(opts.sourceHtml))) {
    console.error('source-html not found: ' + opts.sourceHtml);
    process.exit(1);
  }

  var input = readJson(inPath);
  var result = migrate(input, opts);

  console.log('=== fidelityContract v1.3.0 -> v1.4.0 (hud polymorphic) migration ===');
  console.log(' input              : ' + inPath);
  console.log(' output             : ' + outPath + (opts.dryRun ? ' (DRY RUN, not written)' : ''));
  console.log(' phases extracted   : ' + result.report.counts.phasesExtracted);
  console.log(' slots rewritten    : ' + result.report.counts.hudSlotsRewritten + ' (' + result.report.rewrittenSlots.join(', ') + ')');
  console.log(' slots already poly : ' + result.report.counts.hudSlotsAlreadyPolymorphic);
  console.log(' slots missing      : ' + result.report.counts.hudSlotsMissingInContract);
  console.log(' fromVersion        : ' + result.report.fromVersion);
  console.log(' toVersion          : ' + result.report.toVersion);
  console.log(' bumped             : ' + (result.report.bumpedSchemaVersion ? 'yes' : 'no - partial migration, stays at ' + result.report.fromVersion));

  if (!opts.dryRun) {
    writeJson(outPath, result.contract);
    var reportPath = opts.reportPath || (outPath.replace(/\.json$/, '') + '.migration-report.json');
    writeJson(reportPath, result.report);
    console.log(' report             : ' + reportPath);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  migrate: migrate,
  extractPhasesBlock: extractPhasesBlock,
  parsePhases: parsePhases,
  extractEntityStyleBlock: extractEntityStyleBlock,
  parseEntityStyle: parseEntityStyle,
  buildPolymorphicHud: buildPolymorphicHud,
  POLYMORPHIC_HUD_IDS: POLYMORPHIC_HUD_IDS,
  TARGETHINT_PREFIX: TARGETHINT_PREFIX
};
