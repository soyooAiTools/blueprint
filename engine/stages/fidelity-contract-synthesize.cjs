'use strict';

/**
 * Stage: fidelity-contract-synthesize (Option B — 2026-05-31)
 *
 * Purpose: produce a v1.0 fidelityContract by parsing the project's source.html
 * (the storyboard2html L1–L8.5 contract surface — PHASES[], ENTITY_STYLE,
 * ENTITY_POSITIONS, SCENE_CONFIG at top-level literal scope), and write it to
 * `ctx.blueprint.fidelityContract`. Downstream `fidelity-contract-produce`
 * then enriches v1.0 → v1.2/v1.3 (projected anchors, primitiveStyle, etc.).
 *
 * Without this stage, `fidelity-contract-produce.canSkip()` returns true on
 * every production task because nothing else assigns the contract — so both
 * `helpers.buildVisualAssetsForRequest` and `fidelity-source-diff` fall
 * through to `DEFAULT_FIDELITY_CONTRACT_PATH_FOR_BUILD` (the space-ranger-v0.5
 * fixture). The 99% pixel-diff is the fixture mismatch, not the Luna build.
 *
 * Placement: AFTER `source-html-bind`, BEFORE `clone` (no dependency on
 * cloned workdir; contract synthesis only needs ctx.sourceHtmlPath).
 *
 * Inputs (from ctx):
 *   ctx.sourceHtmlPath  — absolute path to source.html (from source-html-bind)
 *
 * Outputs:
 *   ctx.blueprint.fidelityContract  — v1.0 contract,
 *     `validateFidelityContract(contract).valid === true` (verified before write)
 *   ctx.fidelityContractSynthesizeReport — {phasesCount, entitiesCount, hudCount}
 *
 * Skips silently when:
 *   - no ctx.sourceHtmlPath (source-html-bind was soft-mode and didn't bind)
 *   - source.html missing PHASES[] OR ENTITY_STYLE OR SCENE_CONFIG literals
 *     (these are L1/L7/L8 required by storyboard2html contract; absence
 *     indicates an off-contract source, so we don't risk synthesizing wrong)
 */

var fs = require('fs');
var path = require('path');
var fidelityContract = require('../fidelity-contract.cjs');

// Extract a top-level `const/var/let NAME = <literal>;` JSON-compatible
// literal from JS source. Returns the literal string (without trailing `;`)
// or null if not present at top level. Uses bracket-balance scanning to
// handle nested arrays/objects with embedded `{` `}` `[` `]` in strings/regex.
function extractTopLevelLiteral(src, name) {
  var pattern = new RegExp('(?:^|\\n)\\s*(?:const|var|let)\\s+' + name + '\\s*=\\s*');
  var m = pattern.exec(src);
  if (!m) return null;
  var start = m.index + m[0].length;
  if (start >= src.length) return null;
  var openCh = src.charAt(start);
  if (openCh !== '{' && openCh !== '[') return null;
  var closeCh = openCh === '{' ? '}' : ']';
  var depth = 0;
  var inString = false;
  var stringQuote = '';
  for (var i = start; i < src.length; i++) {
    var ch = src.charAt(i);
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringQuote) { inString = false; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringQuote = ch;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return src.substring(start, i + 1);
    }
  }
  return null;
}

// Convert a JS object/array literal source string into a JS value via Function.
// We do NOT eval; we wrap as `return <expr>` and call once. Source HTML
// is trusted (we wrote it via storyboard2html). The literals are pure data —
// no function refs, no side effects.
function jsLiteralToValue(literalSrc, label) {
  try {
    return Function('"use strict"; return (' + literalSrc + ');')();
  } catch (e) {
    throw new Error('failed to parse ' + label + ' literal: ' + e.message);
  }
}

function hexToRgb01(hex) {
  // accept 0xRRGGBB number, "#RRGGBB" string, or [r,g,b] array
  if (Array.isArray(hex) && hex.length === 3 && hex.every(function(v) { return typeof v === 'number'; })) {
    return hex.slice();
  }
  if (typeof hex === 'string') {
    var s = hex.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(s)) {
      var n = parseInt(s.replace('#', ''), 16);
      return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    }
  }
  if (typeof hex === 'number' && isFinite(hex)) {
    return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
  }
  return [1, 1, 1];
}

function hexToHexString(hex) {
  if (typeof hex === 'number' && isFinite(hex)) {
    return '#' + (hex & 0xffffff).toString(16).padStart(6, '0');
  }
  if (typeof hex === 'string') return hex;
  return null;
}

function buildEntityRecord(name, style, pos) {
  var x = (pos && typeof pos.x === 'number') ? pos.x : 0;
  var y = (pos && typeof pos.y === 'number') ? pos.y : 0;
  var z = (pos && typeof pos.z === 'number') ? pos.z : 0;
  var color01 = hexToRgb01(style && style.color);
  var colorHex = hexToHexString(style && style.color);
  var label = (style && style.label) || name;
  var kind = (style && style.kind) || 'primitive';
  var entity = {
    id: name,
    name: name,
    parentPath: '/synth/' + name,
    transform: {
      localPosition: { x: x, y: y, z: z },
      localRotation: { x: 0, y: 0, z: 0, w: 1 },
      localScale: { x: 1, y: 1, z: 1 },
    },
    pivot: { kind: 'local-zero', note: 'synthesized from source.html top-level ENTITY_POSITIONS' },
    bounds: {
      kind: 'aabb-local',
      min: { x: -0.5, y: 0, z: -0.5 },
      max: { x: 0.5, y: 1, z: 0.5 },
      center: { x: 0, y: 0.5, z: 0 },
      extent: { x: 0.5, y: 0.5, z: 0.5 },
      derivedFrom: 'fidelity-contract-synthesize@0.1+default-unit-aabb',
    },
    primitives: [],
    provenance: { source: 'html', confidence: 0.6 },
    worldLabel: {
      text: label,
      worldOffset: { x: 0, y: 1.5, z: 0 },
      color: '#ffffff',
      fontSize: 14,
    },
    primitiveStyle: {
      modelRef: kind,
      baseColor: color01,
    },
  };
  if (colorHex) entity.primitiveStyle.baseColorHex = colorHex;
  return entity;
}

// Normalize a PHASE record from source.html into the fidelity contract phase shape.
// We MUST emit: id, showEntities, trigger, interactionGate, autoPlayGate, manualGate.
function buildPhaseRecord(phase) {
  return {
    id: phase.id,
    showEntities: Array.isArray(phase.showEntities) ? phase.showEntities.slice() : [],
    trigger: phase.trigger && typeof phase.trigger === 'object' ? phase.trigger : { type: 'timer', seconds: phase.durationSec || 30 },
    interactionGate: {
      type: 'inferred',
      modules: Array.isArray(phase.plannedModuleIds) ? phase.plannedModuleIds.slice() : [],
      note: 'synthesized from PHASES[].plannedModuleIds',
    },
    autoPlayGate: {
      durationSec: typeof phase.durationSec === 'number' ? phase.durationSec : 30,
      goalText: typeof phase.goalText === 'string' ? phase.goalText : '',
    },
    manualGate: {
      guideText: typeof phase.guideText === 'string' ? phase.guideText : '',
    },
    // v1.1 polymorphic-text phaseSpec carry-through for field-diff phase comparisons.
    phaseSpec: {
      name: phase.name || phase.id,
      goalText: phase.goalText || '',
      guideText: phase.guideText || '',
    },
  };
}

function buildHudRecords(phases) {
  // Synthesize HUD entries from per-phase guideText. Field-diff treats hud[id=label.guide]
  // as the canonical guide-text bucket; we emit a perPhase polymorphic text.
  var perPhase = {};
  phases.forEach(function(p) {
    if (p && p.id && typeof p.guideText === 'string') perPhase[p.id] = p.guideText;
  });
  return [{
    id: 'label.guide',
    text: { perPhase: perPhase },
    anchor: { type: 'screen', position: 'bottom-center' },
    consumer: ['source-html-overlay', 'luna-build-overlay'],
    provenance: { source: 'html', confidence: 0.7 },
  }];
}

function buildSceneBlock(sceneConfig) {
  var rgb = hexToRgb01(sceneConfig && sceneConfig.backgroundColor);
  var hex = hexToHexString(sceneConfig && sceneConfig.backgroundColor);
  var block = { backgroundColor: rgb };
  if (hex) block.backgroundColorHex = hex;
  return block;
}

module.exports = {
  name: 'fidelity-contract-synthesize',
  canRetry: false,

  canSkip: function(ctx) {
    if (!ctx.sourceHtmlPath) {
      ctx.addLog && ctx.addLog('fidelity-contract-synthesize', 'no ctx.sourceHtmlPath — skip (source-html-bind soft mode)');
      return true;
    }
    if (ctx.blueprint && ctx.blueprint.fidelityContract) {
      // Only skip if the existing contract is >= 1.1.0 (the synthesizer's output
      // version). Stale checkpoints from a previous pre-v1.1 driver run might
      // carry a v1.0.0 contract — re-synthesize so downstream produce migrate
      // accepts the input.
      var existing = ctx.blueprint.fidelityContract;
      var existingVer = (existing && existing.schemaVersion) || '0.0.0';
      var parts = String(existingVer).split('.').map(function(n) { return parseInt(n, 10) || 0; });
      var isGte110 = (parts[0] > 1) || (parts[0] === 1 && parts[1] >= 1);
      if (isGte110) {
        ctx.addLog && ctx.addLog('fidelity-contract-synthesize', 'ctx.blueprint.fidelityContract already present at ' + existingVer + ' — skip');
        return true;
      }
      ctx.addLog && ctx.addLog('fidelity-contract-synthesize', 'stale contract at ' + existingVer + ' — re-synthesizing to bump to >= 1.1.0');
      // Wipe so execute() can re-emit
      delete ctx.blueprint.fidelityContract;
    }
    if (process.env.FIDELITY_CONTRACT_SYNTHESIZE_DISABLE === 'true') {
      ctx.addLog && ctx.addLog('fidelity-contract-synthesize', 'disabled by env FIDELITY_CONTRACT_SYNTHESIZE_DISABLE');
      return true;
    }
    return false;
  },

  execute: function(ctx) {
    var sourceHtmlPath = ctx.sourceHtmlPath;
    if (!fs.existsSync(sourceHtmlPath)) {
      ctx.addLog('fidelity-contract-synthesize', 'sourceHtmlPath does not exist: ' + sourceHtmlPath + ' — skip');
      return Promise.resolve({ skipped: true });
    }
    var src = fs.readFileSync(sourceHtmlPath, 'utf8');

    var phasesLit = extractTopLevelLiteral(src, 'PHASES');
    var entityStyleLit = extractTopLevelLiteral(src, 'ENTITY_STYLE');
    var entityPositionsLit = extractTopLevelLiteral(src, 'ENTITY_POSITIONS');
    var sceneConfigLit = extractTopLevelLiteral(src, 'SCENE_CONFIG');

    if (!phasesLit || !entityStyleLit || !sceneConfigLit) {
      // Off-contract source HTML — refuse to synthesize and let downstream fall
      // back to default contract with the existing warning behaviour.
      ctx.addLog('fidelity-contract-synthesize', 'source.html missing required top-level literals (' +
        ['PHASES', 'ENTITY_STYLE', 'SCENE_CONFIG'].filter(function(n, i) {
          return [phasesLit, entityStyleLit, sceneConfigLit][i] === null;
        }).join(', ') + ') — skip synthesis, downstream will use default contract');
      return Promise.resolve({ skipped: true, reason: 'off-contract-source-html' });
    }

    var phases = jsLiteralToValue(phasesLit, 'PHASES');
    var entityStyle = jsLiteralToValue(entityStyleLit, 'ENTITY_STYLE');
    var entityPositions = entityPositionsLit ? jsLiteralToValue(entityPositionsLit, 'ENTITY_POSITIONS') : {};
    var sceneConfig = jsLiteralToValue(sceneConfigLit, 'SCENE_CONFIG');

    if (!Array.isArray(phases) || phases.length === 0) {
      throw new Error('PHASES literal is not a non-empty array');
    }

    var entityNames = Object.keys(entityStyle || {});
    if (entityNames.length === 0) {
      throw new Error('ENTITY_STYLE literal has no entries');
    }

    var entities = entityNames.map(function(name) {
      return buildEntityRecord(name, entityStyle[name], entityPositions[name]);
    });

    var contract = {
      // 2026-05-31: emit v1.1.0 so downstream fidelity-contract-produce (migrate
      // v1.1→v1.2) accepts the synthesized base. v1.1.0 only differs from v1.0.0
      // by allowing polymorphic-text on hud[].text and entities[].worldLabel —
      // we already emit those shapes (hud[0].text = { perPhase: {...} }), so
      // bumping the version is safe.
      schemaVersion: '1.1.0',
      kind: 'blueprint.fidelityContract',
      producerVersion: 'fidelity-contract-synthesize@0.1',
      generatedAt: new Date().toISOString(),
      producer: {
        kind: 'source-html-synthesize',
        direction: 'html-to-contract',
        sourceHtmlPath: sourceHtmlPath,
        sourceHtmlSha256: ctx.sourceHtmlSha256 || null,
      },
      requiredCapabilities: [
        'ui.labelAnchor.v1',
        'rendererAdapter.driverMap.v1',
        'provenance.fieldLevel.v1',
      ],
      coordinateSystem: {
        source: 'three-rh',
        target: 'unity-lh',
        handedness: 'right',
        zFlip: false,
        unitScale: 1,
      },
      rendererAdapter: {
        three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
        unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
      },
      scene: buildSceneBlock(sceneConfig),
      entities: entities,
      phases: phases.map(buildPhaseRecord),
      hud: buildHudRecords(phases),
      unityCoverage: { status: 'partial', note: 'synthesized from source.html only; primitives empty' },
      unresolvedFidelityGaps: [],
      contractConflicts: [],
    };

    var validation = fidelityContract.validateFidelityContract(contract);
    if (!validation.valid) {
      throw new Error('synthesized contract failed validation: ' + validation.errors.slice(0, 10).join('; '));
    }

    ctx.blueprint = ctx.blueprint || {};
    ctx.blueprint.fidelityContract = contract;

    var report = {
      phasesCount: contract.phases.length,
      entitiesCount: contract.entities.length,
      hudCount: contract.hud.length,
      sourceHtmlSha256: ctx.sourceHtmlSha256 || null,
    };
    ctx.fidelityContractSynthesizeReport = report;
    ctx.addLog('fidelity-contract-synthesize', 'synthesized contract: ' +
      report.phasesCount + ' phases, ' + report.entitiesCount + ' entities, ' +
      report.hudCount + ' hud entries');

    return Promise.resolve(report);
  },

  // Test hooks
  _internals: {
    extractTopLevelLiteral: extractTopLevelLiteral,
    jsLiteralToValue: jsLiteralToValue,
    hexToRgb01: hexToRgb01,
    buildEntityRecord: buildEntityRecord,
    buildPhaseRecord: buildPhaseRecord,
    buildHudRecords: buildHudRecords,
    buildSceneBlock: buildSceneBlock,
  },
};
