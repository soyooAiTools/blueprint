'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var vm = require('vm');

var visualAssets = require('../adapters/demo2spec/visual-assets.js');

var PLAYABLE_SCENE_IR_SCHEMA_VERSION = '1.0.0';
var PLAYABLE_SCENE_IR_KIND = 'blueprint.playableSceneIR';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  var out = {};
  Object.keys(value).sort().forEach(function(key) {
    if (value[key] !== undefined) out[key] = stableValue(value[key]);
  });
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256OfString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractBalancedLiteral(source, openIndex, openChar, closeChar) {
  var depth = 0;
  var quote = null;
  var escaped = false;
  for (var i = openIndex; i < source.length; i += 1) {
    var ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

function parseTopLevelLiteral(source, name, openChar, closeChar) {
  var html = stripComments(source);
  var re = new RegExp('(?:\\b(?:const|let|var)\\s+' + name + '\\s*=|\\bwindow\\.' + name + '\\s*=)', 'g');
  var match;
  while ((match = re.exec(html))) {
    var openIndex = html.indexOf(openChar, re.lastIndex);
    if (openIndex < 0) return { value: null, errors: [name + ' literal missing opening ' + openChar] };
    var literal = extractBalancedLiteral(html, openIndex, openChar, closeChar);
    if (!literal) return { value: null, errors: [name + ' literal could not be balanced'] };
    try {
      return {
        value: vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 100 }),
        errors: [],
      };
    } catch (err) {
      return { value: null, errors: [name + ' literal parse failed: ' + err.message] };
    }
  }
  return { value: null, errors: [name + ' literal not found'] };
}

function parseSourcePhases(source) {
  var parsed = parseTopLevelLiteral(source, 'PHASES', '[', ']');
  return {
    phases: Array.isArray(parsed.value) ? parsed.value : [],
    errors: Array.isArray(parsed.value) ? [] : parsed.errors,
  };
}

function sortedObject(value) {
  var out = {};
  Object.keys(value || {}).sort().forEach(function(key) {
    out[key] = clone(value[key]);
  });
  return out;
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function phaseIdOf(phase, index) {
  return String(phase && (phase.id || phase.phaseId || phase.name) || ('phase' + (index + 1)));
}

function phaseById(phases) {
  var out = {};
  safeArray(phases).forEach(function(phase, index) {
    out[phaseIdOf(phase, index)] = phase;
  });
  return out;
}

function buildIrEntities(manifest) {
  var contract = manifest && manifest.sourceEntityContract || {};
  var styles = contract.entityStyles || {};
  var composites = contract.entityComposites || {};
  var bindings = manifest && manifest.entityBindings || {};
  var names = uniqueStrings(safeArray(contract.entities)
    .concat(Object.keys(styles))
    .concat(Object.keys(composites))
    .concat(Object.keys(bindings)))
    .sort();
  return names.map(function(name) {
    var style = styles[name] || {};
    var composite = composites[name] || {};
    var binding = bindings[name] || {};
    return {
      name: name,
      label: composite.label || style.label || name,
      kind: composite.kind || style.kind || null,
      color: composite.color || style.color || null,
      position: clone(composite.position || style.position || null),
      style: Object.keys(style).length ? clone(style) : null,
      composite: Object.keys(composite).length ? clone(composite) : null,
      assetIds: safeArray(binding.assetIds),
      primaryAssetId: binding.primaryAssetId || null,
      fidelityTarget: binding.fidelityTarget || composite.fidelityTarget || null,
      visualFallback: binding.visualFallback || composite.visualFallback || null,
    };
  });
}

function buildIrPhases(manifest, htmlPhases) {
  var sourcePhases = safeArray(manifest && manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases);
  var literalById = phaseById(htmlPhases);
  var sourceById = phaseById(sourcePhases);
  var ids = uniqueStrings(sourcePhases.map(phaseIdOf).concat(htmlPhases.map(phaseIdOf)));
  if (ids.length === 0) ids = sourcePhases.map(function(_, index) { return 'phase' + (index + 1); });
  return ids.map(function(id, index) {
    var source = sourceById[id] || {};
    var literal = literalById[id] || htmlPhases[index] || {};
    return {
      index: Number.isFinite(Number(source.index)) ? Number(source.index) : index,
      id: id,
      name: source.name || literal.name || literal.phaseName || id,
      guideText: source.guideText || literal.guideText || literal.tip || '',
      goalText: source.goalText || literal.goalText || '',
      showEntities: uniqueStrings(safeArray(source.showEntities).concat(safeArray(literal.showEntities))),
      trigger: clone(literal.trigger || source.trigger || null),
      steps: clone(safeArray(source.steps).length ? source.steps : safeArray(literal.steps)),
      hudText: clone(source.hudText || literal.hudText || null),
      plannedModuleIds: uniqueStrings(safeArray(literal.plannedModuleIds || literal.plannedModules || source.plannedModuleIds || source.plannedModules)),
    };
  });
}

function buildIrAssets(manifest) {
  return safeArray(manifest && manifest.assets).map(function(asset) {
    return {
      assetId: asset.assetId || null,
      kind: asset.kind || null,
      source: clone(asset.source || null),
      unityImport: clone(asset.unityImport || null),
      geometry: clone(asset.geometry || null),
      material: clone(asset.material || null),
      transform: clone(asset.transform || null),
      entityBinding: clone(asset.entityBinding || null),
      fidelityTarget: asset.fidelityTarget || null,
      visualFallback: asset.visualFallback || null,
      unsupported: clone(safeArray(asset.unsupported)),
    };
  }).sort(function(a, b) {
    return String(a.assetId || '').localeCompare(String(b.assetId || ''));
  });
}

function semanticPayload(ir) {
  return {
    schemaVersion: ir && ir.schemaVersion,
    kind: ir && ir.kind,
    source: {
      htmlSha256: ir && ir.source && ir.source.htmlSha256 || null,
    },
    scene: ir && ir.scene || null,
    entities: ir && ir.entities || [],
    phases: ir && ir.phases || [],
    entityBindings: ir && ir.entityBindings || {},
    assets: ir && ir.assets || [],
    unsupported: ir && ir.unsupported || [],
  };
}

function computePlayableSceneIrHash(ir) {
  return sha256OfString(stableStringify(semanticPayload(ir)));
}

function buildPlayableSceneIrFromHtml(htmlPath, options) {
  options = options || {};
  if (!htmlPath) throw new Error('htmlPath is required');
  var absPath = path.resolve(htmlPath);
  var html = options.html != null ? String(options.html) : fs.readFileSync(absPath, 'utf8');
  var htmlSha256 = options.htmlSha256 || sha256OfString(html);
  if (fs.existsSync(absPath) && options.allowHtmlContentMismatch !== true) {
    var fileSha256 = sha256OfFile(absPath);
    if (fileSha256 !== htmlSha256) {
      throw new Error('playableSceneIR source HTML hash mismatch: file=' + fileSha256 + ' provided=' + htmlSha256 + ' path=' + absPath);
    }
  }
  var manifest = options.assetManifest || visualAssets.extractVisualAssetManifest(html, {
    source: absPath,
    project: options.project || null,
    entityNames: options.entityNames || visualAssets.collectEntityNamesFromHtml(html),
    generatedAt: options.generatedAt,
  });
  var parsedPhases = parseSourcePhases(html);
  var ir = {
    schemaVersion: PLAYABLE_SCENE_IR_SCHEMA_VERSION,
    kind: PLAYABLE_SCENE_IR_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: {
      htmlPath: absPath,
      htmlSha256: htmlSha256,
    },
    project: options.project || manifest.project || null,
    scene: clone(manifest.sourceSceneContract || null),
    entities: buildIrEntities(manifest),
    phases: buildIrPhases(manifest, parsedPhases.phases),
    entityBindings: sortedObject(manifest.entityBindings || {}),
    assets: buildIrAssets(manifest),
    unsupported: clone(safeArray(manifest.unsupported)),
    extractionSummary: clone(manifest.extractionSummary || null),
    diagnostics: {
      phaseParseErrors: parsedPhases.errors,
    },
  };
  ir.semanticHash = computePlayableSceneIrHash(ir);
  validatePlayableSceneIr(ir);
  return ir;
}

function normalizeHash(value) {
  var text = String(value || '').trim().toLowerCase();
  return text || null;
}

function comparablePath(value) {
  if (!value) return null;
  return path.resolve(String(value));
}

function validatePlayableSceneIr(ir) {
  if (!isObject(ir)) throw new Error('playableSceneIR must be an object');
  if (ir.schemaVersion !== PLAYABLE_SCENE_IR_SCHEMA_VERSION) {
    throw new Error('unsupported playableSceneIR schemaVersion: ' + ir.schemaVersion);
  }
  if (ir.kind !== PLAYABLE_SCENE_IR_KIND) {
    throw new Error('invalid playableSceneIR kind: ' + ir.kind);
  }
  if (!ir.source || !ir.source.htmlPath) throw new Error('playableSceneIR missing source.htmlPath');
  if (!/^[0-9a-f]{64}$/i.test(String(ir.source.htmlSha256 || ''))) {
    throw new Error('playableSceneIR missing source.htmlSha256');
  }
  if (!Array.isArray(ir.entities)) throw new Error('playableSceneIR entities must be an array');
  if (!Array.isArray(ir.phases)) throw new Error('playableSceneIR phases must be an array');
  if (ir.phases.length === 0) throw new Error('playableSceneIR phases must not be empty');
  if (!/^[0-9a-f]{64}$/i.test(String(ir.semanticHash || ''))) {
    throw new Error('playableSceneIR missing semanticHash');
  }
  var expected = computePlayableSceneIrHash(ir);
  if (String(ir.semanticHash).toLowerCase() !== expected) {
    throw new Error('playableSceneIR semanticHash mismatch: expected=' + expected + ' actual=' + ir.semanticHash);
  }
  return true;
}

function assertPlayableSceneIrBinding(ir, options) {
  options = options || {};
  validatePlayableSceneIr(ir);
  var irPath = comparablePath(ir.source.htmlPath);
  var irSha = normalizeHash(ir.source.htmlSha256);
  var errors = [];

  if (options.sourceHtmlPath && comparablePath(options.sourceHtmlPath) !== irPath) {
    errors.push('sourceHtmlPath mismatch: expected ' + irPath + ' got ' + comparablePath(options.sourceHtmlPath));
  }
  if (options.sourceHtmlSha256 && normalizeHash(options.sourceHtmlSha256) !== irSha) {
    errors.push('sourceHtmlSha256 mismatch: expected ' + irSha + ' got ' + normalizeHash(options.sourceHtmlSha256));
  }

  var manifest = options.assetManifest || null;
  if (manifest) {
    var manifestPath = manifest.sourceHtmlPath || manifest.source || null;
    if (manifestPath && comparablePath(manifestPath) !== irPath) {
      errors.push('assetManifest.source mismatch: expected ' + irPath + ' got ' + comparablePath(manifestPath));
    }
    var manifestSha = normalizeHash(manifest.sourceHtmlSha256 || manifest.sourceSha256 || null);
    if (manifestSha && manifestSha !== irSha) {
      errors.push('assetManifest.sourceHtmlSha256 mismatch: expected ' + irSha + ' got ' + manifestSha);
    }
    if (options.requireAssetManifestHash && !manifestSha) {
      errors.push('assetManifest.sourceHtmlSha256 missing for IR-bound build');
    }
    if (manifest.playableSceneIrHash && normalizeHash(manifest.playableSceneIrHash) !== normalizeHash(ir.semanticHash)) {
      errors.push('assetManifest.playableSceneIrHash mismatch: expected ' + ir.semanticHash + ' got ' + manifest.playableSceneIrHash);
    }
  }

  if (errors.length > 0) {
    throw new Error('playableSceneIR binding failed: ' + errors.join('; '));
  }
  return {
    sourceHtmlPath: irPath,
    sourceHtmlSha256: irSha,
    playableSceneIrHash: ir.semanticHash,
  };
}

function writePlayableSceneIr(outPath, ir) {
  validatePlayableSceneIr(ir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(stableValue(ir), null, 2) + '\n');
  return ir;
}

function loadPlayableSceneIr(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  var ir = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validatePlayableSceneIr(ir);
  return ir;
}

function isCtaUiEntityName(value) {
  return /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(String(value || '').trim());
}

function normalizeTriggerForCompare(trigger) {
  if (!isObject(trigger)) return null;
  if (trigger.type === 'compound') {
    return {
      type: 'compound',
      operator: trigger.operator || 'and',
      triggers: safeArray(trigger.triggers).map(normalizeTriggerForCompare).filter(Boolean),
    };
  }
  if (trigger.type === 'resource_collected') {
    return {
      type: 'resource_collected',
      resource: trigger.resource || null,
      amount: Number(trigger.amount || trigger.count || 1) || 1,
    };
  }
  if (trigger.type === 'near_entity') {
    if (isCtaUiEntityName(trigger.entity)) {
      return {
        type: 'cta_arrival',
        ctaId: trigger.entity || 'CtaButton',
        range: Number(trigger.range != null ? trigger.range : trigger.distance) || 2,
      };
    }
    return {
      type: 'near_entity',
      entity: trigger.entity || null,
      range: Number(trigger.range != null ? trigger.range : trigger.distance) || 2,
    };
  }
  if (trigger.type === 'click_entity') {
    if (isCtaUiEntityName(trigger.entity)) return { type: 'cta_arrival', ctaId: trigger.entity || 'CtaButton', range: 2 };
    return { type: 'click_entity', entity: trigger.entity || null };
  }
  if (trigger.type === 'cta_arrival') {
    return {
      type: 'cta_arrival',
      ctaId: trigger.ctaId || trigger.entity || trigger.target || 'CtaButton',
      range: Number(trigger.range != null ? trigger.range : trigger.distance) || 2,
    };
  }
  if (trigger.type === 'entity_state_reached') {
    return {
      type: 'entity_state_reached',
      entity: trigger.entity || null,
      state: Number(trigger.state == null || trigger.state === '' ? 1 : trigger.state) || 1,
    };
  }
  if (trigger.type === 'timer') {
    return { type: 'timer', seconds: Number(trigger.seconds) || 1 };
  }
  return stableValue(trigger);
}

function compareStringList(expected, actual) {
  var e = safeArray(expected).map(String).filter(Boolean);
  var a = safeArray(actual).map(String).filter(Boolean);
  if (e.length !== a.length) return false;
  for (var i = 0; i < e.length; i += 1) {
    if (e[i] !== a[i]) return false;
  }
  return true;
}

function stepTargetSequence(steps) {
  return safeArray(steps).map(function(step) {
    return step && step.target ? String(step.target) : '';
  }).filter(Boolean);
}

function assertPlayableSceneIrExecutionAlignment(ir, options) {
  options = options || {};
  validatePlayableSceneIr(ir);
  var gameSchema = options.gameSchema || {};
  var phases = safeArray(gameSchema.phases);
  var irPhases = safeArray(ir.phases);
  var errors = [];
  if (phases.length !== irPhases.length) {
    errors.push('phase count mismatch: ir=' + irPhases.length + ' gameSchema=' + phases.length);
  }
  var count = Math.min(phases.length, irPhases.length);
  for (var i = 0; i < count; i += 1) {
    var irPhase = irPhases[i] || {};
    var phase = phases[i] || {};
    var expectedId = irPhase.id || ('phase' + (i + 1));
    var actualId = phase.phaseId || ('phase' + (i + 1));
    if (actualId !== expectedId) {
      errors.push('phase[' + i + '] id mismatch: ir=' + expectedId + ' gameSchema=' + actualId);
    }
    if (String(phase.guideText || '') !== String(irPhase.guideText || '')) {
      errors.push('phase[' + i + '] guideText mismatch: ir=' + JSON.stringify(irPhase.guideText || '') + ' gameSchema=' + JSON.stringify(phase.guideText || ''));
    }
    if (!compareStringList(irPhase.showEntities, phase.showEntities)) {
      errors.push('phase[' + i + '] showEntities mismatch: ir=' + JSON.stringify(irPhase.showEntities || []) + ' gameSchema=' + JSON.stringify(phase.showEntities || []));
    }
    var irTrigger = normalizeTriggerForCompare(irPhase.trigger);
    var phaseTrigger = normalizeTriggerForCompare(phase.trigger);
    if (stableStringify(irTrigger) !== stableStringify(phaseTrigger)) {
      errors.push('phase[' + i + '] trigger mismatch: ir=' + stableStringify(irTrigger) + ' gameSchema=' + stableStringify(phaseTrigger));
    }
    var irStepTargets = stepTargetSequence(irPhase.steps);
    var phaseStepTargets = stepTargetSequence(phase.steps);
    if (!compareStringList(irStepTargets, phaseStepTargets)) {
      errors.push('phase[' + i + '] step target sequence mismatch: ir=' + JSON.stringify(irStepTargets) + ' gameSchema=' + JSON.stringify(phaseStepTargets));
    }
  }
  if (errors.length > 0) {
    throw new Error('playableSceneIR execution alignment failed: ' + errors.join('; '));
  }
  return {
    passed: true,
    phaseCount: phases.length,
    sourceHtmlSha256: ir.source && ir.source.htmlSha256 || null,
    playableSceneIrHash: ir.semanticHash,
  };
}

module.exports = {
  PLAYABLE_SCENE_IR_SCHEMA_VERSION: PLAYABLE_SCENE_IR_SCHEMA_VERSION,
  PLAYABLE_SCENE_IR_KIND: PLAYABLE_SCENE_IR_KIND,
  stableStringify: stableStringify,
  sha256OfString: sha256OfString,
  sha256OfFile: sha256OfFile,
  parseSourcePhases: parseSourcePhases,
  buildPlayableSceneIrFromHtml: buildPlayableSceneIrFromHtml,
  computePlayableSceneIrHash: computePlayableSceneIrHash,
  validatePlayableSceneIr: validatePlayableSceneIr,
  assertPlayableSceneIrBinding: assertPlayableSceneIrBinding,
  assertPlayableSceneIrExecutionAlignment: assertPlayableSceneIrExecutionAlignment,
  writePlayableSceneIr: writePlayableSceneIr,
  loadPlayableSceneIr: loadPlayableSceneIr,
};
