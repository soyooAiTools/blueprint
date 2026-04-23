var fs = require('fs');
var path = require('path');

var REGISTRY_DIR = path.join(__dirname, 'assembly-registry-v1');
var MANIFEST_PATH = path.join(REGISTRY_DIR, 'registry-pack.v1.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveManifestPath(baseDir, relPath) {
  return path.resolve(baseDir, relPath);
}

function loadAssemblyRegistry() {
  var manifest = readJson(MANIFEST_PATH);
  var baseDir = path.dirname(MANIFEST_PATH);
  var storyboardAtoms = readJson(resolveManifestPath(baseDir, manifest.storyboardAtoms));
  var runtimeModules = readJson(resolveManifestPath(baseDir, manifest.runtimeModules));
  var cuaAssertions = readJson(resolveManifestPath(baseDir, manifest.cuaAssertions));
  var mappings = readJson(resolveManifestPath(baseDir, manifest.mappings));

  return {
    manifest: manifest,
    storyboardAtoms: storyboardAtoms,
    runtimeModules: runtimeModules,
    cuaAssertions: cuaAssertions,
    mappings: mappings
  };
}

module.exports = {
  REGISTRY_DIR: REGISTRY_DIR,
  MANIFEST_PATH: MANIFEST_PATH,
  loadAssemblyRegistry: loadAssemblyRegistry
};
