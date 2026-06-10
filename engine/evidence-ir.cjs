'use strict';

var crypto = require('crypto');
var path = require('path');

var EVIDENCE_IR_SCHEMA_VERSION = 'evidence-ir.v1';
var EVIDENCE_IR_KIND = 'blueprint.evidenceIr';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function semanticHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function safeSourceId(filePath, index) {
  var base = path.basename(String(filePath || 'source'), path.extname(String(filePath || 'source')));
  var safe = base.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'source';
  return 'src' + String(index + 1).padStart(2, '0') + '_' + safe;
}

function normalizeSource(source, index) {
  source = source || {};
  var filePath = stringValue(source.path || source.filePath);
  var ext = stringValue(source.extension || path.extname(filePath).slice(1)).toLowerCase();
  return {
    sourceId: stringValue(source.sourceId) || safeSourceId(filePath, index),
    path: filePath,
    fileName: stringValue(source.fileName || path.basename(filePath)),
    extension: ext,
    sourceType: stringValue(source.sourceType || ext || 'unknown'),
    status: stringValue(source.status || 'parsed'),
    metadata: source.metadata || {},
  };
}

function normalizeFact(fact, index) {
  fact = fact || {};
  return {
    factId: stringValue(fact.factId) || 'fact' + String(index + 1).padStart(4, '0'),
    sourceId: stringValue(fact.sourceId),
    sourceType: stringValue(fact.sourceType || 'unknown'),
    locator: stringValue(fact.locator),
    factType: stringValue(fact.factType || 'text'),
    text: stringValue(fact.text),
    confidence: Number.isFinite(Number(fact.confidence)) ? Number(fact.confidence) : 0.5,
    metadata: fact.metadata || {},
  };
}

function normalizeEvidenceIr(input, options) {
  options = options || {};
  input = input || {};
  var sources = safeArray(input.sources).map(normalizeSource);
  var facts = safeArray(input.facts).map(normalizeFact).filter(function(fact) {
    return fact.text || fact.factType === 'visual_reference' || fact.factType === 'manual_required';
  });
  var projectName = stringValue(options.projectName || input.projectName || input.project && input.project.name) || 'AI试玩广告分镜';
  var ir = {
    schemaVersion: EVIDENCE_IR_SCHEMA_VERSION,
    kind: EVIDENCE_IR_KIND,
    project: {
      name: projectName,
      sourceCount: sources.length,
    },
    sources: sources,
    facts: facts,
    diagnostics: safeArray(input.diagnostics),
  };
  ir.semanticHash = semanticHash({
    schemaVersion: ir.schemaVersion,
    project: ir.project,
    sources: ir.sources,
    facts: ir.facts,
  });
  return ir;
}

function assertEvidenceIr(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) throw new Error('evidence-ir must be an object');
  if (ir.schemaVersion !== EVIDENCE_IR_SCHEMA_VERSION) throw new Error('unsupported evidence-ir schemaVersion: ' + ir.schemaVersion);
  if (ir.kind !== EVIDENCE_IR_KIND) throw new Error('invalid evidence-ir kind: ' + ir.kind);
  if (!Array.isArray(ir.sources)) throw new Error('evidence-ir sources must be an array');
  if (!Array.isArray(ir.facts)) throw new Error('evidence-ir facts must be an array');
  return true;
}

function factsByType(ir, type) {
  return safeArray(ir && ir.facts).filter(function(fact) {
    return fact && fact.factType === type;
  });
}

module.exports = {
  EVIDENCE_IR_SCHEMA_VERSION: EVIDENCE_IR_SCHEMA_VERSION,
  EVIDENCE_IR_KIND: EVIDENCE_IR_KIND,
  normalizeEvidenceIr: normalizeEvidenceIr,
  assertEvidenceIr: assertEvidenceIr,
  factsByType: factsByType,
  _internals: {
    stableJson: stableJson,
    semanticHash: semanticHash,
    safeSourceId: safeSourceId,
  },
};
