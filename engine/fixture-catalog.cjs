'use strict';

// Layer 4 of task #27 visual-fidelity shift-left.
// Acceptance/evidence catalog index for fidelity sweep — NOT a pipeline stage.
// Discovers registered fixtures from a JSON manifest, validates each entry,
// resolves paths, and computes sha256 bindings (mirrors L3 source-html-bind
// pattern so catalog drift surfaces loudly).
//
// listFixtures(opts) -> [{ name, status, contractPath, sourceHtmlPath,
//                          projectDir, sha256: { contract, sourceHtml },
//                          metadata, manifestEntryIndex }]
//
// The companion runner is scripts/run-fidelity-catalog.cjs.

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var CATALOG_KIND = 'blueprint.fixtureAcceptanceCatalog';
var CATALOG_SCHEMA_VERSION = '1.0.0';
var VALID_STATUSES = ['golden', 'candidate', 'advisory'];
var DEFAULT_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'ACCEPTANCE_CATALOG.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function sha256OfFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function resolveAgainst(baseDir, p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function assertString(value, label, ctx) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('fixture-catalog: ' + ctx + ' missing or non-string field: ' + label);
  }
}

function validateManifest(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('fixture-catalog: manifest at ' + manifestPath + ' is not an object');
  }
  if (manifest.kind !== CATALOG_KIND) {
    throw new Error('fixture-catalog: manifest.kind expected ' + CATALOG_KIND + ', got ' + manifest.kind);
  }
  if (manifest.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error('fixture-catalog: manifest.schemaVersion expected ' + CATALOG_SCHEMA_VERSION + ', got ' + manifest.schemaVersion);
  }
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error('fixture-catalog: manifest.fixtures must be an array');
  }
}

function validateEntry(entry, index) {
  var ctx = 'fixtures[' + index + ']';
  assertString(entry && entry.name, 'name', ctx);
  assertString(entry.contractPath, 'contractPath', ctx);
  assertString(entry.status, 'status', ctx);
  if (VALID_STATUSES.indexOf(entry.status) < 0) {
    throw new Error('fixture-catalog: ' + ctx + '.status must be one of ' + VALID_STATUSES.join('/') + ', got ' + entry.status);
  }
  // sourceHtmlPath + projectDir are optional (some fixtures may be unity-only
  // or runtime-only); catalog runner skips visual sweep when absent.
}

function loadCatalog(manifestPath) {
  var resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    throw new Error('fixture-catalog: manifest not found at ' + resolved);
  }
  var manifest = readJson(resolved);
  validateManifest(manifest, resolved);
  var baseDir = path.dirname(resolved);

  var seenNames = Object.create(null);
  var entries = manifest.fixtures.map(function (entry, i) {
    validateEntry(entry, i);
    if (seenNames[entry.name]) {
      throw new Error('fixture-catalog: duplicate fixture name "' + entry.name + '" at index ' + i);
    }
    seenNames[entry.name] = true;

    var contractPath = resolveAgainst(baseDir, entry.contractPath);
    var sourceHtmlPath = entry.sourceHtmlPath ? resolveAgainst(baseDir, entry.sourceHtmlPath) : null;
    var projectDir = entry.projectDir ? resolveAgainst(baseDir, entry.projectDir) : null;

    if (!fs.existsSync(contractPath)) {
      throw new Error('fixture-catalog: fixtures[' + i + '] contract missing at ' + contractPath);
    }
    if (sourceHtmlPath && !fs.existsSync(sourceHtmlPath)) {
      throw new Error('fixture-catalog: fixtures[' + i + '] sourceHtmlPath missing at ' + sourceHtmlPath);
    }
    if (projectDir && !fs.existsSync(projectDir)) {
      throw new Error('fixture-catalog: fixtures[' + i + '] projectDir missing at ' + projectDir);
    }

    return {
      name: entry.name,
      status: entry.status,
      contractPath: contractPath,
      sourceHtmlPath: sourceHtmlPath,
      projectDir: projectDir,
      target: entry.target || 'unity',
      metadata: entry.metadata || {},
      sha256: {
        contract: sha256OfFile(contractPath),
        sourceHtml: sourceHtmlPath ? sha256OfFile(sourceHtmlPath) : null,
      },
      manifestEntryIndex: i,
    };
  });

  return {
    manifestPath: resolved,
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt || null,
    notes: manifest.notes || null,
    fixtures: entries,
  };
}

function listFixtures(opts) {
  opts = opts || {};
  var manifestPath = opts.manifestPath || DEFAULT_MANIFEST;
  var catalog = loadCatalog(manifestPath);
  var fixtures = catalog.fixtures;
  if (opts.status) {
    var wanted = Array.isArray(opts.status) ? opts.status : [opts.status];
    fixtures = fixtures.filter(function (f) { return wanted.indexOf(f.status) >= 0; });
  }
  if (opts.names && opts.names.length) {
    var want = {};
    opts.names.forEach(function (n) { want[n] = true; });
    fixtures = fixtures.filter(function (f) { return want[f.name]; });
  }
  return fixtures;
}

module.exports = {
  CATALOG_KIND: CATALOG_KIND,
  CATALOG_SCHEMA_VERSION: CATALOG_SCHEMA_VERSION,
  VALID_STATUSES: VALID_STATUSES,
  DEFAULT_MANIFEST: DEFAULT_MANIFEST,
  loadCatalog: loadCatalog,
  listFixtures: listFixtures,
  _internals: {
    validateManifest: validateManifest,
    validateEntry: validateEntry,
    sha256OfFile: sha256OfFile,
  },
};
