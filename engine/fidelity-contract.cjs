'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_SCHEMA_PATH = path.join(__dirname, '..', 'contracts', 'fidelity-contract.v1.json');
var CONTRACT_KIND = 'blueprint.fidelityContract';
var SCHEMA_KIND = 'blueprint.fidelityContract.schema';
var SCHEMA_VERSION = '1.2.0';
// v1.2.0 adds two-layer screen-space anchor design:
//   - phases[].cameraTransform (informative/diagnostic — does NOT block)
//   - phases[].projectedAnchors (normative/blocking — per-entity screen rect
//     pre-projected from source Three.js camera, consumed by target writer
//     verbatim to bypass Three.js↔PlayCanvas projection-math non-equivalence)
// Visibility booleans (effectiveVisible/selfVisible/viewportIntersection) are
// EXPLICITLY EXCLUDED from anchor records (locked v6.1 persistence boundary);
// consumers derive at consume time from anchor x/y/w/h vs viewport baseline.
// v1.1.0 adds optional entities[].worldLabel + polymorphic hud[].text (string OR
// {default?, perPhase}). v1.0.0 instances remain valid — lib field-diff @0.6.1
// transitionally reads hud[id^="label."] as worldLabel fallback so v1.0 contracts
// run against @0.6.1 lib without migration.
var ACCEPTED_INSTANCE_SCHEMA_VERSIONS = { '1.0.0': true, '1.1.0': true, '1.2.0': true };
var RESOLVED_CONFLICT_STATUSES = { accepted: true, rejected: true, deferred: true };

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadSchema(explicitPath) {
  return readJson(explicitPath || process.env.FIDELITY_CONTRACT_SCHEMA_FILE || DEFAULT_SCHEMA_PATH);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function pathLabel(parts) {
  return parts.join('.');
}

function requiredObject(doc, key, errors, basePath) {
  if (!isPlainObject(doc[key])) {
    errors.push(pathLabel([basePath, key]) + ' must be an object');
    return {};
  }
  return doc[key];
}

function requiredArray(doc, key, errors, basePath) {
  if (!Array.isArray(doc[key])) {
    errors.push(pathLabel([basePath, key]) + ' must be an array');
    return [];
  }
  return doc[key];
}

function requireKeys(doc, keys, errors, basePath) {
  keys.forEach(function(key) {
    if (doc[key] === undefined || doc[key] === null) {
      errors.push(pathLabel([basePath, key]) + ' is required');
    }
  });
}

function validateSchema(doc) {
  if (!isPlainObject(doc)) throw new Error('fidelity schema must be an object');
  if (!ACCEPTED_INSTANCE_SCHEMA_VERSIONS[doc.schemaVersion]) {
    throw new Error('unsupported fidelity schemaVersion: ' + doc.schemaVersion + ' (accept ' + Object.keys(ACCEPTED_INSTANCE_SCHEMA_VERSIONS).join('|') + ')');
  }
  if (doc.kind !== SCHEMA_KIND) throw new Error('invalid fidelity schema kind: ' + doc.kind);
  if (doc.instanceKind !== CONTRACT_KIND) throw new Error('fidelity schema missing instanceKind');
  if (!Array.isArray(doc.requiredRoots) || doc.requiredRoots.indexOf('rendererAdapter') < 0) {
    throw new Error('fidelity schema missing rendererAdapter required root');
  }
  if (!doc.rendererAdapter || !Array.isArray(doc.rendererAdapter.requiredBuckets)) {
    throw new Error('fidelity schema missing rendererAdapter required buckets');
  }
  if (!doc.provenance || !Array.isArray(doc.provenance.acceptedSources)) {
    throw new Error('fidelity schema missing provenance accepted sources');
  }
  if (!doc.primitiveContract || !Array.isArray(doc.primitiveContract.materialRequiredKeys)) {
    throw new Error('fidelity schema missing primitive material required keys');
  }
  return true;
}

// v1.1.0: hud[].text and entities[].worldLabel are polymorphic — they accept
// either a plain string OR an object of shape { default?: string, perPhase: Record<string, string> }.
// Lib resolution order (field-diff @0.6.1): perPhase[phaseId] > default > undefined (skip).
function validatePolymorphicText(value, errors, basePath) {
  if (typeof value === 'string') return;
  if (!isPlainObject(value)) {
    errors.push(basePath + ' must be a string or {default?, perPhase} object');
    return;
  }
  if (value.default !== undefined && typeof value.default !== 'string') {
    errors.push(basePath + '.default must be a string when present');
  }
  if (!isPlainObject(value.perPhase)) {
    errors.push(basePath + '.perPhase must be an object when text is polymorphic');
    return;
  }
  Object.keys(value.perPhase).forEach(function(phaseId) {
    if (typeof value.perPhase[phaseId] !== 'string') {
      errors.push(basePath + '.perPhase.' + phaseId + ' must be a string');
    }
  });
}

var ANCHOR_PROVENANCE_ENUM = { 'extracted': true, 'inferred-default': true, 'anchor-only': true };
var DEFAULT_ANCHOR_TOLERANCE_PX = Number(process.env.DEFAULT_ANCHOR_PIXEL_TOLERANCE) > 0
  ? Number(process.env.DEFAULT_ANCHOR_PIXEL_TOLERANCE)
  : 8;

function gteSemver(a, b) {
  var p = String(a || '0').split('.').map(Number);
  var q = String(b || '0').split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var x = p[i] || 0, y = q[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function validateProjectedAnchor(anchor, errors, basePath) {
  if (!isPlainObject(anchor)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  ['x_px', 'y_px', 'w_px', 'h_px'].forEach(function(k) {
    if (typeof anchor[k] !== 'number' || !isFinite(anchor[k])) {
      errors.push(basePath + '.' + k + ' must be a finite number');
    }
  });
  if (typeof anchor.w_px === 'number' && anchor.w_px < 0) {
    errors.push(basePath + '.w_px must be >= 0');
  }
  if (typeof anchor.h_px === 'number' && anchor.h_px < 0) {
    errors.push(basePath + '.h_px must be >= 0');
  }
  if (anchor.depth_ndc !== undefined && (typeof anchor.depth_ndc !== 'number' || !isFinite(anchor.depth_ndc))) {
    errors.push(basePath + '.depth_ndc must be a finite number when present');
  }
  if (!ANCHOR_PROVENANCE_ENUM[String(anchor.provenance || '')]) {
    errors.push(basePath + '.provenance must be one of ' + Object.keys(ANCHOR_PROVENANCE_ENUM).join('|'));
  }
  // Audit fields are required when provenance ∈ {extracted, anchor-only}.
  // For inferred-default they may be absent (migration backfill placeholder).
  if (anchor.provenance === 'extracted' || anchor.provenance === 'anchor-only') {
    ['lookupPath', 'matchedAlias', 'resolverRule'].forEach(function(k) {
      if (typeof anchor[k] !== 'string' || !anchor[k]) {
        errors.push(basePath + '.' + k + ' must be a non-empty string when provenance=' + anchor.provenance);
      }
    });
  }
  // Persistence boundary (v6.1 locked): visibility booleans MUST NOT appear in
  // contract anchor records. Consumers derive viewportIntersection from x/y/w/h.
  ['selfVisible', 'effectiveVisible', 'viewportIntersection'].forEach(function(k) {
    if (anchor[k] !== undefined) {
      errors.push(basePath + '.' + k + ' must not be present in contract anchor record (derived at consume time)');
    }
  });
}

function validateProvenance(value, errors, basePath) {
  if (!isPlainObject(value)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  if (!/^(unity|html|spec|inferred)$/.test(String(value.source || ''))) {
    errors.push(basePath + '.source must be unity|html|spec|inferred');
  }
  var confidence = Number(value.confidence);
  if (!isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push(basePath + '.confidence must be a number between 0 and 1');
  }
}

function validateRendererAdapter(adapter, errors) {
  var drivers = ['three', 'unity'];
  var buckets = ['shader', 'animator', 'physics', 'audio', 'ui'];
  drivers.forEach(function(driver) {
    var driverValue = adapter[driver];
    if (!isPlainObject(driverValue)) {
      errors.push('rendererAdapter.' + driver + ' must be an object');
      return;
    }
    buckets.forEach(function(bucket) {
      if (!isPlainObject(driverValue[bucket])) {
        errors.push('rendererAdapter.' + driver + '.' + bucket + ' must be an object');
      }
    });
  });
}

function validateTransformLike(value, errors, basePath) {
  if (!isPlainObject(value)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  ['localPosition', 'localRotation', 'localScale'].forEach(function(key) {
    if (!isPlainObject(value[key])) errors.push(basePath + '.' + key + ' must be an object');
  });
}

function validateMaterial(material, errors, basePath) {
  if (!isPlainObject(material)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  ['id', 'shader', 'colors', 'alpha', 'blendMode', 'guid', 'guidSeed', 'guidAlgorithm', 'contentHash'].forEach(function(key) {
    if (material[key] === undefined || material[key] === null || material[key] === '') {
      errors.push(basePath + '.' + key + ' is required');
    }
  });
  if (material.colors !== undefined) {
    if (!isPlainObject(material.colors)) {
      errors.push(basePath + '.colors must be an object');
    } else {
      ['_Color', '_ColorTint', '_EmissionColor'].forEach(function(key) {
        if (!Array.isArray(material.colors[key])) errors.push(basePath + '.colors.' + key + ' must be an array');
      });
    }
  }
}

function validatePrimitive(primitive, errors, basePath) {
  if (!isPlainObject(primitive)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  requireKeys(primitive, ['id', 'name', 'parentPath', 'transform', 'pivot', 'bounds', 'mesh', 'material', 'provenance'], errors, basePath);
  validateTransformLike(primitive.transform, errors, basePath + '.transform');
  if (!isPlainObject(primitive.pivot)) errors.push(basePath + '.pivot must be an object');
  if (!isPlainObject(primitive.bounds)) errors.push(basePath + '.bounds must be an object');
  if (!isPlainObject(primitive.mesh)) {
    errors.push(basePath + '.mesh must be an object');
  } else {
    if (!primitive.mesh.type) errors.push(basePath + '.mesh.type is required');
    if (!Array.isArray(primitive.mesh.args)) errors.push(basePath + '.mesh.args must be an array');
  }
  validateMaterial(primitive.material, errors, basePath + '.material');
  validateProvenance(primitive.provenance, errors, basePath + '.provenance');
}

function validateEntity(entity, errors, basePath) {
  if (!isPlainObject(entity)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  requireKeys(entity, ['id', 'name', 'parentPath', 'transform', 'pivot', 'bounds', 'primitives', 'provenance'], errors, basePath);
  validateTransformLike(entity.transform, errors, basePath + '.transform');
  if (!isPlainObject(entity.pivot)) errors.push(basePath + '.pivot must be an object');
  if (!isPlainObject(entity.bounds)) errors.push(basePath + '.bounds must be an object');
  if (entity.worldLabel !== undefined) {
    validatePolymorphicText(entity.worldLabel, errors, basePath + '.worldLabel');
  }
  validateProvenance(entity.provenance, errors, basePath + '.provenance');
  requiredArray(entity, 'primitives', errors, basePath).forEach(function(primitive, index) {
    validatePrimitive(primitive, errors, basePath + '.primitives[' + index + ']');
  });
}

function validatePhase(phase, errors, basePath, contractSchemaVersion) {
  if (!isPlainObject(phase)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  requireKeys(phase, ['id', 'showEntities', 'trigger', 'interactionGate', 'autoPlayGate', 'manualGate'], errors, basePath);
  if (!Array.isArray(phase.showEntities)) errors.push(basePath + '.showEntities must be an array');
  ['trigger', 'interactionGate', 'autoPlayGate', 'manualGate'].forEach(function(key) {
    if (!isPlainObject(phase[key])) errors.push(basePath + '.' + key + ' must be an object');
  });
  // v1.2.0: cameraTransform (informative) + projectedAnchors (normative) required.
  // 1:1 enforcement: every showEntities[] entry must have a projectedAnchors entry.
  // empty showEntities + projectedAnchors:{} is valid (1:1 vacuously true).
  // Locked 2026-05-29 by Sam msg=68437d33 + Tim msg=db64fb53:
  // `projectedAnchors` MUST be present; omitting the key blocks.
  if (gteSemver(contractSchemaVersion, '1.2.0')) {
    requireKeys(phase, ['cameraTransform', 'projectedAnchors'], errors, basePath);
    if (phase.cameraTransform !== undefined && !isPlainObject(phase.cameraTransform)) {
      errors.push(basePath + '.cameraTransform must be an object when present');
    }
    if (phase.projectedAnchors !== undefined && !isPlainObject(phase.projectedAnchors)) {
      errors.push(basePath + '.projectedAnchors must be an object');
    }
    if (isPlainObject(phase.projectedAnchors) && Array.isArray(phase.showEntities)) {
      phase.showEntities.forEach(function(entId) {
        if (phase.projectedAnchors[entId] === undefined) {
          errors.push(basePath + '.projectedAnchors.' + entId + ' is required (1:1 with showEntities)');
        }
      });
      Object.keys(phase.projectedAnchors).forEach(function(entId) {
        validateProjectedAnchor(phase.projectedAnchors[entId], errors, basePath + '.projectedAnchors.' + entId);
      });
    }
  }
}

function validateHudEntry(entry, errors, basePath) {
  if (!isPlainObject(entry)) {
    errors.push(basePath + ' must be an object');
    return;
  }
  requireKeys(entry, ['id', 'text', 'anchor', 'consumer', 'provenance'], errors, basePath);
  if (entry.text !== undefined && entry.text !== null) {
    validatePolymorphicText(entry.text, errors, basePath + '.text');
  }
  if (!isPlainObject(entry.anchor)) errors.push(basePath + '.anchor must be an object');
  if (!Array.isArray(entry.consumer)) errors.push(basePath + '.consumer must be an array');
  validateProvenance(entry.provenance, errors, basePath + '.provenance');
}

function validateFidelityContract(doc) {
  var errors = [];
  if (!isPlainObject(doc)) {
    return { valid: false, errors: ['fidelity contract must be an object'] };
  }
  if (!ACCEPTED_INSTANCE_SCHEMA_VERSIONS[doc.schemaVersion]) {
    errors.push('schemaVersion must be one of ' + Object.keys(ACCEPTED_INSTANCE_SCHEMA_VERSIONS).join('|') + ' (got ' + doc.schemaVersion + ')');
  }
  if (doc.kind !== CONTRACT_KIND) errors.push('kind must be ' + CONTRACT_KIND);
  requireKeys(doc, [
    'producerVersion',
    'requiredCapabilities',
    'coordinateSystem',
    'rendererAdapter',
    'entities',
    'phases',
    'hud',
    'unityCoverage',
    'unresolvedFidelityGaps',
    'contractConflicts'
  ], errors, '$');
  requiredArray(doc, 'requiredCapabilities', errors, '$');
  var coordinateSystem = requiredObject(doc, 'coordinateSystem', errors, '$');
  requireKeys(coordinateSystem, ['source', 'target', 'handedness', 'zFlip', 'unitScale'], errors, '$.coordinateSystem');
  validateRendererAdapter(requiredObject(doc, 'rendererAdapter', errors, '$'), errors);
  requiredArray(doc, 'entities', errors, '$').forEach(function(entity, index) {
    validateEntity(entity, errors, 'entities[' + index + ']');
  });
  requiredArray(doc, 'phases', errors, '$').forEach(function(phase, index) {
    validatePhase(phase, errors, 'phases[' + index + ']', doc.schemaVersion);
  });
  requiredArray(doc, 'hud', errors, '$').forEach(function(entry, index) {
    validateHudEntry(entry, errors, 'hud[' + index + ']');
  });
  var unityCoverage = requiredObject(doc, 'unityCoverage', errors, '$');
  if (!/^(complete|partial|missing)$/.test(String(unityCoverage.status || ''))) {
    errors.push('unityCoverage.status must be complete|partial|missing');
  }
  requiredArray(doc, 'unresolvedFidelityGaps', errors, '$');
  requiredArray(doc, 'contractConflicts', errors, '$');
  return { valid: errors.length === 0, errors: errors };
}

function blockingGaps(doc) {
  return safeArray(doc && doc.unresolvedFidelityGaps).filter(function(gap) {
    return !gap || gap.blocking !== false;
  });
}

function unresolvedConflicts(doc) {
  return safeArray(doc && doc.contractConflicts).filter(function(conflict) {
    var status = conflict && conflict.resolution && conflict.resolution.status;
    return !RESOLVED_CONFLICT_STATUSES[String(status || '')];
  });
}

function missingCapabilities(doc, supportedCapabilities) {
  var supported = {};
  safeArray(supportedCapabilities).forEach(function(capability) { supported[capability] = true; });
  return safeArray(doc && doc.requiredCapabilities).filter(function(capability) {
    return !supported[capability];
  });
}

function assertWriterReady(doc, options) {
  options = options || {};
  var validation = validateFidelityContract(doc);
  var errors = validation.errors.slice();
  var gaps = blockingGaps(doc);
  var conflicts = unresolvedConflicts(doc);
  var missing = missingCapabilities(doc, options.supportedCapabilities || []);
  if (gaps.length) errors.push('unresolved fidelity gaps block writer: ' + gaps.map(function(gap) { return gap && (gap.id || gap.path) || '<unknown>'; }).join(', '));
  if (conflicts.length) errors.push('unresolved contract conflicts block writer: ' + conflicts.map(function(conflict) { return conflict && (conflict.id || conflict.path) || '<unknown>'; }).join(', '));
  if (missing.length) errors.push('writer missing required capabilities: ' + missing.join(', '));
  if (options.target === 'unity' && doc && doc.unityCoverage && doc.unityCoverage.status === 'missing' && !options.allowMissingUnityCoverage) {
    errors.push('unity writer requires unityCoverage.status !== missing');
  }
  if (errors.length) {
    var err = new Error('fidelity contract writer gate failed: ' + errors.join('; '));
    err.errors = errors;
    throw err;
  }
  return true;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sameValue(a, b) {
  return stableJson(a) === stableJson(b);
}

function entityKey(entity) {
  return entity && (entity.id || entity.name);
}

function primitiveKey(primitive) {
  return primitive && (primitive.id || primitive.name);
}

function mapBy(values, keyFn) {
  var out = {};
  safeArray(values).forEach(function(value) {
    var key = keyFn(value);
    if (key) out[key] = value;
  });
  return out;
}

function pushDiff(diffs, pathName, expected, actual) {
  if (!sameValue(expected, actual)) {
    diffs.push({ path: pathName, expected: expected, actual: actual });
  }
}

function diffFidelityRoundTrip(expected, actual) {
  var diffs = [];
  var left = validateFidelityContract(expected);
  var right = validateFidelityContract(actual);
  if (!left.valid) diffs.push({ path: '$expected', expected: 'valid', actual: left.errors });
  if (!right.valid) diffs.push({ path: '$actual', expected: 'valid', actual: right.errors });
  if (diffs.length) return { passed: false, diffs: diffs };
  pushDiff(diffs, 'coordinateSystem', expected.coordinateSystem, actual.coordinateSystem);
  pushDiff(diffs, 'requiredCapabilities', expected.requiredCapabilities, actual.requiredCapabilities);
  pushDiff(diffs, 'rendererAdapter', expected.rendererAdapter, actual.rendererAdapter);
  var expectedEntities = mapBy(expected.entities, entityKey);
  var actualEntities = mapBy(actual.entities, entityKey);
  Object.keys(expectedEntities).sort().forEach(function(id) {
    var exp = expectedEntities[id];
    var act = actualEntities[id];
    if (!act) {
      diffs.push({ path: 'entities.' + id, expected: 'present', actual: 'missing' });
      return;
    }
    ['name', 'parentPath', 'transform', 'pivot', 'bounds', 'label', 'worldLabel'].forEach(function(key) {
      pushDiff(diffs, 'entities.' + id + '.' + key, exp[key], act[key]);
    });
    var expPrimitives = mapBy(exp.primitives, primitiveKey);
    var actPrimitives = mapBy(act.primitives, primitiveKey);
    Object.keys(expPrimitives).sort().forEach(function(pid) {
      var eprim = expPrimitives[pid];
      var aprim = actPrimitives[pid];
      if (!aprim) {
        diffs.push({ path: 'entities.' + id + '.primitives.' + pid, expected: 'present', actual: 'missing' });
        return;
      }
      ['name', 'parentPath', 'transform', 'pivot', 'bounds', 'mesh', 'material'].forEach(function(key) {
        pushDiff(diffs, 'entities.' + id + '.primitives.' + pid + '.' + key, eprim[key], aprim[key]);
      });
    });
  });
  // v1.2.0: per-phase per-entity anchor delta with tolerance. Replaces the
  // coarse phases pushDiff at v1.2+ because anchor numerics will rarely match
  // byte-for-byte across re-extractions; tolerance is the contract.
  // For v1.1- contracts, the coarse pushDiff stays (anchors not in schema).
  if (gteSemver(expected && expected.schemaVersion, '1.2.0')) {
    var expectedPhasesById = mapBy(expected.phases, function(p) { return p && p.id; });
    var actualPhasesById = mapBy(actual.phases, function(p) { return p && p.id; });
    Object.keys(expectedPhasesById).sort().forEach(function(pid) {
      var ep = expectedPhasesById[pid], ap = actualPhasesById[pid];
      if (!ap) {
        diffs.push({ path: 'phases.' + pid, expected: 'present', actual: 'missing' });
        return;
      }
      // Non-anchor phase fields — exclude projectedAnchors from coarse diff so
      // tolerance-based anchor compare below is the authoritative anchor check.
      var epClean = {}, apClean = {};
      Object.keys(ep).forEach(function(k) { if (k !== 'projectedAnchors') epClean[k] = ep[k]; });
      Object.keys(ap).forEach(function(k) { if (k !== 'projectedAnchors') apClean[k] = ap[k]; });
      pushDiff(diffs, 'phases.' + pid, epClean, apClean);
      // Anchor delta — per entity, per field, vs DEFAULT_ANCHOR_TOLERANCE_PX.
      if (isPlainObject(ep.projectedAnchors) && isPlainObject(ap.projectedAnchors)) {
        Object.keys(ep.projectedAnchors).forEach(function(eid) {
          var ea = ep.projectedAnchors[eid], aa = ap.projectedAnchors[eid];
          if (!aa) {
            diffs.push({ path: 'phases.' + pid + '.projectedAnchors.' + eid, expected: 'present', actual: 'missing' });
            return;
          }
          ['x_px', 'y_px', 'w_px', 'h_px'].forEach(function(k) {
            var delta = Math.abs((Number(ea[k]) || 0) - (Number(aa[k]) || 0));
            if (delta > DEFAULT_ANCHOR_TOLERANCE_PX) {
              diffs.push({
                path: 'phases.' + pid + '.projectedAnchors.' + eid + '.' + k,
                expected: ea[k], actual: aa[k],
                deltaPx: delta, tolerancePx: DEFAULT_ANCHOR_TOLERANCE_PX
              });
            }
          });
        });
      } else if (isPlainObject(ep.projectedAnchors) && !isPlainObject(ap.projectedAnchors)) {
        diffs.push({ path: 'phases.' + pid + '.projectedAnchors', expected: 'object', actual: typeof ap.projectedAnchors });
      }
    });
  } else {
    pushDiff(diffs, 'phases', expected.phases, actual.phases);
  }
  pushDiff(diffs, 'hud', expected.hud, actual.hud);
  return { passed: diffs.length === 0, diffs: diffs };
}

module.exports = {
  DEFAULT_SCHEMA_PATH: DEFAULT_SCHEMA_PATH,
  CONTRACT_KIND: CONTRACT_KIND,
  SCHEMA_KIND: SCHEMA_KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  ACCEPTED_INSTANCE_SCHEMA_VERSIONS: ACCEPTED_INSTANCE_SCHEMA_VERSIONS,
  loadSchema: loadSchema,
  validateSchema: validateSchema,
  validateFidelityContract: validateFidelityContract,
  assertWriterReady: assertWriterReady,
  diffFidelityRoundTrip: diffFidelityRoundTrip,
  ANCHOR_PROVENANCE_ENUM: ANCHOR_PROVENANCE_ENUM,
  DEFAULT_ANCHOR_TOLERANCE_PX: DEFAULT_ANCHOR_TOLERANCE_PX,
  validateProjectedAnchor: validateProjectedAnchor,
  _internals: {
    blockingGaps: blockingGaps,
    unresolvedConflicts: unresolvedConflicts,
    missingCapabilities: missingCapabilities,
    validatePolymorphicText: validatePolymorphicText,
    stableJson: stableJson,
    gteSemver: gteSemver
  }
};
