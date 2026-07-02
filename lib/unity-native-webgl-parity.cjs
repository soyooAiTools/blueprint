#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var projector = require('./unity-delivery-spec-projector.cjs');

var KIND = 'blueprint.unityNativeWebglParityReport';
var SCHEMA_VERSION = 1;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) {
    var out = {};
    Object.keys(value).sort().forEach(function(key) {
      out[key] = stable(value[key]);
    });
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function uniq(values) {
  var seen = Object.create(null);
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function diffJson(expected, actual, pathPrefix, out) {
  pathPrefix = pathPrefix || '$';
  out = out || [];
  if (stableStringify(expected) === stableStringify(actual)) return out;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push({ path: pathPrefix, expected: expected, actual: actual });
      return out;
    }
    var max = Math.max(expected.length, actual.length);
    for (var i = 0; i < max; i++) diffJson(expected[i], actual[i], pathPrefix + '[' + i + ']', out);
    return out;
  }
  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      out.push({ path: pathPrefix, expected: expected, actual: actual });
      return out;
    }
    uniq(Object.keys(expected).concat(Object.keys(actual))).forEach(function(key) {
      diffJson(expected[key], actual[key], pathPrefix + '.' + key, out);
    });
    return out;
  }
  out.push({ path: pathPrefix, expected: expected, actual: actual });
  return out;
}

function runtimeSemanticProjection(snapshot) {
  return {
    phases: safeArray(snapshot && snapshot.phases).map(function(phase, index) {
      return {
        id: String(phase && phase.id || phase && phase.phaseId || ('phase' + (index + 1))),
        index: index,
        guideText: String(phase && phase.guideText || ''),
        showEntities: uniq(phase && phase.showEntities || []),
        targetSequence: uniq(phase && phase.targetSequence || []),
        gate: stable(phase && phase.gate || {}),
        steps: safeArray(phase && phase.steps).map(function(step) { return stable(step); })
      };
    }),
    entities: safeArray(snapshot && snapshot.entities).map(function(entity) {
      return String(isObject(entity) ? (entity.id || entity.sourceId || entity.name || '') : entity || '').trim();
    }).filter(Boolean),
    resources: safeArray(snapshot && snapshot.resources).map(function(resource, index) {
      resource = resource || {};
      return {
        id: String(resource.id || resource.sourceId || resource.name || ('Resource' + (index + 1))),
        label: resource.label || resource.name || resource.id || '',
        kind: resource.kind || resource.type || 'resource'
      };
    })
  };
}

function semanticSummary(projection) {
  projection = projection || {};
  var phases = safeArray(projection.phases);
  var entities = safeArray(projection.entities);
  var resources = safeArray(projection.resources);
  return {
    phaseCount: phases.length,
    phaseIds: phases.map(function(phase) { return String(phase && phase.id || ''); }).filter(Boolean),
    entityCount: entities.length,
    resourceCount: resources.length
  };
}

function compareSourceToRuntime(sourceIr, runtimeSnapshot, options) {
  options = options || {};
  var expected = projector.sourceSemanticProjection(sourceIr);
  var actual = runtimeSemanticProjection(runtimeSnapshot || {});
  var diffs = diffJson(expected, actual);
  var hashChecks = [];
  if (sourceIr && sourceIr.semanticHash) {
    hashChecks.push({
      id: 'source-ir-semantic-hash',
      expected: sourceIr.semanticHash,
      actual: runtimeSnapshot && runtimeSnapshot.sourceIrSemanticHash || '',
      passed: sourceIr.semanticHash === (runtimeSnapshot && runtimeSnapshot.sourceIrSemanticHash || '')
    });
  }
  if (options.unityDeliverySpecSemanticHash) {
    hashChecks.push({
      id: 'unity-delivery-spec-semantic-hash',
      expected: options.unityDeliverySpecSemanticHash,
      actual: runtimeSnapshot && runtimeSnapshot.unityDeliverySpecSemanticHash || '',
      passed: options.unityDeliverySpecSemanticHash === (runtimeSnapshot && runtimeSnapshot.unityDeliverySpecSemanticHash || '')
    });
  }
  hashChecks.forEach(function(check) {
    if (!check.passed) {
      diffs.push({
        path: '$.hashChecks.' + check.id,
        expected: check.expected,
        actual: check.actual
      });
    }
  });
  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    status: diffs.length ? 'failed' : 'passed',
    passed: diffs.length === 0,
    checked: ['phases', 'phase.guideText', 'phase.targetSequence', 'phase.gate', 'phase.steps', 'entities', 'resources'],
    sourceIrSemanticHash: sourceIr && sourceIr.semanticHash || '',
    runtimeSourceIrSemanticHash: runtimeSnapshot && runtimeSnapshot.sourceIrSemanticHash || '',
    unityDeliverySpecSemanticHash: options.unityDeliverySpecSemanticHash || runtimeSnapshot && runtimeSnapshot.unityDeliverySpecSemanticHash || '',
    summary: {
      expected: semanticSummary(expected),
      runtime: semanticSummary(actual)
    },
    diffCount: diffs.length,
    diffs: diffs,
    expected: options.includeProjection ? expected : undefined,
    actual: options.includeProjection ? actual : undefined
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  runtimeSemanticProjection: runtimeSemanticProjection,
  semanticSummary: semanticSummary,
  compareSourceToRuntime: compareSourceToRuntime,
  readJson: readJson,
  writeJson: writeJson
};
