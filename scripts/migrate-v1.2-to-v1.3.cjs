#!/usr/bin/env node
'use strict';

// task #45 (v1.4b) — fidelityContract v1.2.0 → v1.3.0 migration.
//
// Adds three field families to make source-vs-target visual fidelity
// observable on bg / world-label / primitive-style axes (the residual
// after v1.4a anchor calibration math was unblocked):
//
//   1. scene.backgroundColor   ← SCENE_CONFIG.backgroundColor (source HTML JS literal)
//   2. entities[].worldLabel   ← ENTITY_STYLE[name].label + buildEntity() label offset y=3.1
//   3. entities[].primitiveStyle.{ modelRef, baseColor }
//      ← ENTITY_STYLE[name].{ kind, color }
//
// Why three NEW fields instead of consuming entities[].primitives[]:
//   - entities[].primitives[] is Unity-extracted (heavy, Unity-only path);
//     v1.3 producer-side reverse-extracts from a Three.js source HTML where
//     primitives are runtime-built from kind+color, not pre-baked.
//   - modelRef is the semantic kind hint (#46 writer picks composition fn);
//     baseColor is the per-entity tint (#46 writer applies as material tint).
//
// scope boundary (Sam ack msg=301669fd, lock 2026-05-29):
//   - this stage produces DATA only; #46 owns writer overlay consumption.
//   - this stage does NOT touch worker/linux-bridge-build.js.
//   - this stage does NOT touch anchor extraction (v1.2 stays its lane).
//
// Behavior:
//   1. Accept v1.2.0 OR v1.3.0 input (idempotent on v1.3 unless --force-reextract).
//   2. Extract source HTML JS literals: regex-based, deterministic.
//      - SCENE_CONFIG.backgroundColor: /backgroundColor\s*:\s*0x([0-9a-fA-F]+)/
//      - ENTITY_STYLE block + per-entity { label, color, kind } members.
//   3. Populate per-entity:
//      - worldLabel: { text, worldOffset:{x:0,y:3.1,z:0}, color:'#ffffff', fontSize:26 }
//        (worldOffset constant from source-HTML buildEntity() label() spr.position.y=3.1)
//      - primitiveStyle: { modelRef:<kind>, baseColor:[r,g,b] }
//   4. CONDITIONAL schemaVersion bump (mirrors v1.1→v1.2 discipline):
//      - Bump 1.2.0 → 1.3.0 IFF scene.backgroundColor extracted AND every
//        entity that source HTML mentions has worldLabel + primitiveStyle populated.
//      - Otherwise: stay at 1.2.0, partialMigration:true, advisory gaps appended.

var fs = require('fs');
var path = require('path');

var WORLD_LABEL_OFFSET_DEFAULT = { x: 0, y: 3.1, z: 0 };
var WORLD_LABEL_FONT_SIZE_DEFAULT = 26;
var WORLD_LABEL_COLOR_DEFAULT = '#ffffff';

// Recognized ENTITY_STYLE.kind enum (from space-ranger-3d.html buildEntity switch).
// Order is stable; consumers may add unknown kinds → still surfaced in modelRef
// but writer (#46) may fall through to default composition.
var KNOWN_MODEL_KINDS = [
  'astronaut', 'ship', 'base', 'station', 'counter',
  'pad', 'crystal', 'debris', 'cargo', 'beacon', 'gate'
];

function hexToLinearRgb(hex) {
  var n = (typeof hex === 'string') ? parseInt(hex, 16) : (hex | 0);
  return [
    Number((((n >> 16) & 0xff) / 255).toFixed(4)),
    Number((((n >> 8) & 0xff) / 255).toFixed(4)),
    Number(((n & 0xff) / 255).toFixed(4))
  ];
}

// Extract SCENE_CONFIG.backgroundColor hex. Returns null if not found.
function extractBackgroundColorHex(html) {
  // Match within SCENE_CONFIG = { ... backgroundColor: 0xRRGGBB ... }.
  var sceneBlock = html.match(/const\s+SCENE_CONFIG\s*=\s*\{([\s\S]*?)\};/);
  if (!sceneBlock) return null;
  var m = sceneBlock[1].match(/backgroundColor\s*:\s*0x([0-9a-fA-F]+)/);
  return m ? m[1] : null;
}

// Extract per-entity { label, color, kind } from ENTITY_STYLE block.
// Returns { entityId → { label, colorHex, kind } } or null if block missing.
function extractEntityStyleMap(html) {
  var styleBlock = html.match(/const\s+ENTITY_STYLE\s*=\s*\{([\s\S]*?)\};/);
  if (!styleBlock) return null;
  var body = styleBlock[1];
  var map = {};
  // Per-entity entry — allow members in any order, accept either single or double quotes.
  // Capture id, then a permissive block; secondary regex extracts label/color/kind from block.
  var entryRe = /(\w+)\s*:\s*\{([^{}]*?)\}/g;
  var m;
  while ((m = entryRe.exec(body)) !== null) {
    var entityId = m[1];
    var memberBody = m[2];
    var labelM = memberBody.match(/label\s*:\s*["']([^"']+)["']/);
    var colorM = memberBody.match(/color\s*:\s*0x([0-9a-fA-F]+)/);
    var kindM = memberBody.match(/kind\s*:\s*["']([^"']+)["']/);
    if (!labelM || !colorM || !kindM) continue;
    map[entityId] = {
      label: labelM[1],
      colorHex: colorM[1],
      kind: kindM[1]
    };
  }
  return Object.keys(map).length ? map : null;
}

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function gteVersion(a, target) {
  if (typeof a !== 'string') return false;
  var av = a.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  var tv = target.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < Math.max(av.length, tv.length); i++) {
    var x = av[i] || 0, y = tv[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function migrate(contract, opts) {
  opts = opts || {};
  if (!contract || typeof contract !== 'object') {
    throw new Error('input contract must be an object');
  }
  if (contract.schemaVersion !== '1.2.0' && contract.schemaVersion !== '1.3.0') {
    throw new Error('input schemaVersion must be 1.2.0 or 1.3.0, got ' + contract.schemaVersion);
  }

  var out = deepClone(contract);

  var report = {
    kind: 'blueprint.fidelityContract.migrationReport',
    schemaVersion: '1.3.0',
    fromVersion: contract.schemaVersion,
    toVersion: null,
    generatedAt: new Date().toISOString(),
    counts: {
      entities: (out.entities || []).length,
      backgroundColorExtracted: false,
      worldLabelPopulated: 0,
      primitiveStylePopulated: 0,
      entitiesMissingFromSource: 0,
      preservedExistingWorldLabel: 0
    },
    partialMigration: false,
    bumpedSchemaVersion: false,
    advisoryGaps: [],
    sourceHtmlPath: opts.sourceHtml || null,
    unknownModelKinds: []
  };

  if (!opts.sourceHtml) {
    report.partialMigration = true;
    report.toVersion = contract.schemaVersion;
    report.advisoryGaps.push({
      id: 'v13-no-source-html',
      path: '$.scene + $.entities[].{worldLabel,primitiveStyle}',
      message: 'sourceHtml not provided; v1.3 fields cannot be reverse-extracted — staying at ' + contract.schemaVersion,
      blocking: false,
      source: 'migrate-v1.2-to-v1.3',
      kind: 'v13-fields'
    });
    return { contract: out, report: report };
  }

  var html = fs.readFileSync(opts.sourceHtml, 'utf8');

  // 1) scene.backgroundColor
  var bgHex = extractBackgroundColorHex(html);
  if (bgHex) {
    out.scene = out.scene || {};
    // Don't clobber if caller explicitly set scene.backgroundColor on the
    // input contract (treat as already-authored override).
    if (out.scene.backgroundColor === undefined || opts.forceReextract) {
      out.scene.backgroundColor = hexToLinearRgb(bgHex);
      out.scene.backgroundColorHex = '0x' + bgHex.toLowerCase();
    }
    report.counts.backgroundColorExtracted = true;
  } else {
    report.advisoryGaps.push({
      id: 'v13-scene-bg-missing',
      path: '$.scene.backgroundColor',
      message: 'SCENE_CONFIG.backgroundColor not found in source HTML',
      blocking: false,
      source: 'migrate-v1.2-to-v1.3',
      kind: 'v13-fields'
    });
  }

  // 2) per-entity worldLabel + primitiveStyle
  var entityStyleMap = extractEntityStyleMap(html);
  if (!entityStyleMap) {
    report.advisoryGaps.push({
      id: 'v13-entity-style-missing',
      path: 'ENTITY_STYLE',
      message: 'ENTITY_STYLE block not found in source HTML',
      blocking: false,
      source: 'migrate-v1.2-to-v1.3',
      kind: 'v13-fields'
    });
  } else {
    var entities = out.entities || [];
    for (var i = 0; i < entities.length; i++) {
      var e = entities[i];
      var styleEntry = entityStyleMap[e.id] || entityStyleMap[e.name];
      if (!styleEntry) {
        report.counts.entitiesMissingFromSource++;
        report.advisoryGaps.push({
          id: 'v13-entity-not-in-source:' + e.id,
          path: '$.entities[id=' + e.id + ']',
          message: 'entity ' + e.id + ' not present in source HTML ENTITY_STYLE',
          blocking: false,
          source: 'migrate-v1.2-to-v1.3',
          kind: 'v13-fields'
        });
        continue;
      }

      // worldLabel populate (idempotent on existing entries unless --force)
      if (e.worldLabel === undefined || opts.forceReextract) {
        e.worldLabel = {
          text: styleEntry.label,
          worldOffset: deepClone(WORLD_LABEL_OFFSET_DEFAULT),
          color: WORLD_LABEL_COLOR_DEFAULT,
          fontSize: WORLD_LABEL_FONT_SIZE_DEFAULT,
          consumer: ['entity-overlay'],
          provenance: { source: 'source-html-extract', confidence: 1, extractedFrom: 'ENTITY_STYLE.' + e.id + '.label' }
        };
        report.counts.worldLabelPopulated++;
      } else {
        report.counts.preservedExistingWorldLabel++;
      }

      // primitiveStyle populate (idempotent — only set if absent or --force)
      if (e.primitiveStyle === undefined || opts.forceReextract) {
        e.primitiveStyle = {
          modelRef: styleEntry.kind,
          baseColor: hexToLinearRgb(styleEntry.colorHex),
          baseColorHex: '0x' + styleEntry.colorHex.toLowerCase(),
          provenance: { source: 'source-html-extract', confidence: 1, extractedFrom: 'ENTITY_STYLE.' + e.id + '.{kind,color}' }
        };
        report.counts.primitiveStylePopulated++;

        if (KNOWN_MODEL_KINDS.indexOf(styleEntry.kind) < 0
            && report.unknownModelKinds.indexOf(styleEntry.kind) < 0) {
          report.unknownModelKinds.push(styleEntry.kind);
        }
      }
    }
  }

  // 3) conditional schemaVersion bump — mirror v1.1→v1.2 all-clean discipline,
  // scoped to source-HTML-derivable surface. Unity-internal auxiliary entities
  // (LaserLine/TargetRing/TrailLine) legitimately have no ENTITY_STYLE entry
  // in source HTML — they're effect overlays, not styled models. Bump on
  // "every source-declared entity populated" rather than "every contract entity",
  // otherwise Unity-derived contracts never bump.
  var sourceDeclaredCount = entityStyleMap ? Object.keys(entityStyleMap).length : 0;
  var sourceDeclaredCovered = report.counts.worldLabelPopulated + report.counts.preservedExistingWorldLabel;
  var allClean = (
    report.counts.backgroundColorExtracted &&
    sourceDeclaredCount > 0 &&
    sourceDeclaredCovered >= sourceDeclaredCount
  );
  report.counts.sourceDeclaredEntities = sourceDeclaredCount;
  report.counts.sourceDeclaredCovered = sourceDeclaredCovered;

  if (allClean) {
    out.schemaVersion = '1.3.0';
    report.toVersion = '1.3.0';
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
  console.error('Usage: node scripts/migrate-v1.2-to-v1.3.cjs --in <path/in.json> --out <path/out.json> --source-html <path/source.html> [--dry-run] [--report <path>] [--force-reextract]');
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

  console.log('=== fidelityContract v1.2.0 → v1.3.0 migration ===');
  console.log(' input              : ' + inPath);
  console.log(' output             : ' + outPath + (opts.dryRun ? ' (DRY RUN, not written)' : ''));
  console.log(' entities           : ' + result.report.counts.entities);
  console.log(' bg extracted       : ' + (result.report.counts.backgroundColorExtracted ? 'yes' : 'no'));
  console.log(' worldLabel set     : ' + result.report.counts.worldLabelPopulated +
              ' (existing preserved: ' + result.report.counts.preservedExistingWorldLabel + ')');
  console.log(' primitiveStyle set : ' + result.report.counts.primitiveStylePopulated);
  console.log(' missing in source  : ' + result.report.counts.entitiesMissingFromSource);
  console.log(' fromVersion        : ' + result.report.fromVersion);
  console.log(' toVersion          : ' + result.report.toVersion);
  console.log(' bumped             : ' + (result.report.bumpedSchemaVersion ? 'yes' : 'no — partial migration, stays at ' + result.report.fromVersion));
  if (result.report.unknownModelKinds.length) {
    console.log(' unknown kinds      : ' + result.report.unknownModelKinds.join(', ') + ' (#46 writer fallback)');
  }

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
  extractBackgroundColorHex: extractBackgroundColorHex,
  extractEntityStyleMap: extractEntityStyleMap,
  hexToLinearRgb: hexToLinearRgb,
  gteVersion: gteVersion,
  WORLD_LABEL_OFFSET_DEFAULT: WORLD_LABEL_OFFSET_DEFAULT,
  KNOWN_MODEL_KINDS: KNOWN_MODEL_KINDS
};
