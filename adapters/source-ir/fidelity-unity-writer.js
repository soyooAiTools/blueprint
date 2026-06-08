'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { assertAuditGate } = require('../../engine/fidelity-audit-gate.cjs');
const {
  UNITY_WRITER_CAPABILITIES,
  buildFidelityRoundTripSummary,
} = require('./fidelity-contract.js');

const MANIFEST_KIND = 'blueprint.fidelityContract.unityWriterManifest';
const MANIFEST_SCHEMA_VERSION = '1.0.0';
const ASSET_INDEX_KIND = 'blueprint.fidelityContract.unityAssetIndex';
const ASSET_ENTITY_KIND = 'blueprint.fidelityContract.unityEntityAsset';
const ASSET_MATERIAL_KIND = 'blueprint.fidelityContract.unityMaterialAsset';
const ASSET_PHASE_KIND = 'blueprint.fidelityContract.unityPhaseAsset';
const ASSET_HUD_KIND = 'blueprint.fidelityContract.unityHudAsset';
const DEFAULT_MANIFEST_RELATIVE_PATH = path.join('Assets', 'Fidelity', 'fidelityContract.json');
const DEFAULT_ASSET_INDEX_RELATIVE_PATH = path.join('Assets', 'Fidelity', 'Generated', 'fidelityAssetIndex.json');
const DEFAULT_ASSET_ROOT_RELATIVE_PATH = path.join('Assets', 'Fidelity', 'Generated');

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveManifestPath(projectDir, options) {
  options = options || {};
  if (!projectDir) throw new Error('unity fidelity writer requires projectDir');
  return path.resolve(projectDir, options.manifestRelativePath || DEFAULT_MANIFEST_RELATIVE_PATH);
}

function resolveAssetIndexPath(projectDir, options) {
  options = options || {};
  if (!projectDir) throw new Error('unity fidelity writer requires projectDir');
  return path.resolve(projectDir, options.assetIndexRelativePath || DEFAULT_ASSET_INDEX_RELATIVE_PATH);
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writerCapabilities(options) {
  options = options || {};
  return options.supportedCapabilities || UNITY_WRITER_CAPABILITIES;
}

function assertUnityWriterReady(contract, options) {
  options = options || {};
  return assertAuditGate(contract, {
    target: 'unity',
    supportedCapabilities: writerCapabilities(options),
    allowMissingUnityCoverage: !!options.allowMissingUnityCoverage,
  });
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function safeFileName(value, ext) {
  const raw = String(value || 'asset');
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'asset';
  return safe + '-' + hashId(raw) + ext;
}

function relativeAssetPath(assetRoot, bucket, id, ext) {
  return path.join(assetRoot, bucket, safeFileName(id, ext));
}

function assetKey(entityId, primitiveId) {
  return String(entityId || '') + '::' + String(primitiveId || '');
}

function buildUnityFidelityAssetPack(contract, options) {
  options = options || {};
  const assetRoot = options.assetRootRelativePath || DEFAULT_ASSET_ROOT_RELATIVE_PATH;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const index = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: ASSET_INDEX_KIND,
    generatedAt,
    writer: {
      name: 'blueprint.sourceIr.fidelityUnityWriter',
      mode: 'fidelity-asset-pack-v1',
    },
    contractRoots: {
      schemaVersion: contract.schemaVersion,
      kind: contract.kind,
      producerVersion: contract.producerVersion,
      requiredCapabilities: clone(contract.requiredCapabilities),
      coordinateSystem: clone(contract.coordinateSystem),
      rendererAdapter: clone(contract.rendererAdapter),
      unityCoverage: clone(contract.unityCoverage),
      unresolvedFidelityGaps: clone(contract.unresolvedFidelityGaps || []),
      contractConflicts: clone(contract.contractConflicts || []),
    },
    assets: {
      entities: [],
      materials: [],
      phases: [],
      hud: [],
    },
  };
  const files = [];

  (contract.entities || []).forEach((entity) => {
    const entityId = entity.id || entity.name;
    const entityFile = relativeAssetPath(assetRoot, 'Entities', entityId, '.entity.json');
    const entityAsset = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: ASSET_ENTITY_KIND,
      entityId,
      entity: clone(entity),
    };
    entityAsset.entity.primitives = (entityAsset.entity.primitives || []).map((primitive) => {
      const primitiveId = primitive.id || primitive.name;
      const key = assetKey(entityId, primitiveId);
      const materialFile = relativeAssetPath(assetRoot, 'Materials', key, '.material.json');
      index.assets.materials.push({
        key,
        entityId,
        primitiveId,
        file: materialFile,
        materialId: primitive.material && primitive.material.id || null,
        guid: primitive.material && primitive.material.guid || null,
      });
      files.push({
        relativePath: materialFile,
        value: {
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          kind: ASSET_MATERIAL_KIND,
          key,
          entityId,
          primitiveId,
          material: clone(primitive.material),
        },
      });
      const next = clone(primitive);
      next.material = {
        assetRef: {
          key,
          file: materialFile,
        },
      };
      return next;
    });
    index.assets.entities.push({ entityId, file: entityFile });
    files.push({ relativePath: entityFile, value: entityAsset });
  });

  (contract.phases || []).forEach((phase) => {
    const phaseId = phase.id;
    const phaseFile = relativeAssetPath(assetRoot, 'Phases', phaseId, '.phase.json');
    index.assets.phases.push({ phaseId, file: phaseFile });
    files.push({
      relativePath: phaseFile,
      value: {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind: ASSET_PHASE_KIND,
        phaseId,
        phase: clone(phase),
      },
    });
  });

  (contract.hud || []).forEach((hud) => {
    const hudId = hud.id;
    const hudFile = relativeAssetPath(assetRoot, 'Hud', hudId, '.hud.json');
    index.assets.hud.push({ hudId, file: hudFile });
    files.push({
      relativePath: hudFile,
      value: {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind: ASSET_HUD_KIND,
        hudId,
        hud: clone(hud),
      },
    });
  });

  return { index, files };
}

function writeUnityFidelityAssets(contract, projectDir, options) {
  options = options || {};
  const pack = buildUnityFidelityAssetPack(contract, options);
  const indexPath = resolveAssetIndexPath(projectDir, options);
  pack.files.forEach((file) => {
    writeJson(path.resolve(projectDir, file.relativePath), file.value);
  });
  writeJson(indexPath, pack.index);
  return {
    assetIndexPath: indexPath,
    assetIndex: pack.index,
    assetFiles: pack.files.map((file) => path.resolve(projectDir, file.relativePath)),
  };
}

function buildUnityWriterManifest(contract, options) {
  options = options || {};
  const assetIndexRelativePath = options.assetIndexRelativePath || DEFAULT_ASSET_INDEX_RELATIVE_PATH;
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    writer: {
      name: 'blueprint.sourceIr.fidelityUnityWriter',
      mode: 'fidelity-asset-pack-v1',
      note: 'Audit-gated writer emits per-root fidelity assets and readback rebuilds the contract from those assets before diffing.',
    },
    assetIndexRelativePath,
    contract: clone(contract),
  };
}

function writeUnityFidelityManifest(contract, projectDir, options) {
  options = options || {};
  const auditResult = assertUnityWriterReady(contract, options);
  const assetResult = writeUnityFidelityAssets(contract, projectDir, options);
  const manifestPath = resolveManifestPath(projectDir, options);
  const manifest = buildUnityWriterManifest(contract, options);
  writeJson(manifestPath, manifest);
  return {
    manifestPath,
    assetIndexPath: assetResult.assetIndexPath,
    assetIndex: assetResult.assetIndex,
    assetFiles: assetResult.assetFiles,
    auditResult,
    manifest,
  };
}

function readUnityFidelityAssetPack(projectDir, options) {
  options = options || {};
  const indexPath = resolveAssetIndexPath(projectDir, options);
  const index = readJson(indexPath);
  if (!index || index.kind !== ASSET_INDEX_KIND) {
    throw new Error('invalid Unity fidelity asset index: ' + indexPath);
  }
  const materialByKey = {};
  (index.assets && index.assets.materials || []).forEach((entry) => {
    const asset = readJson(path.resolve(projectDir, entry.file));
    if (!asset || asset.kind !== ASSET_MATERIAL_KIND) {
      throw new Error('invalid Unity fidelity material asset: ' + entry.file);
    }
    materialByKey[entry.key] = clone(asset.material);
  });
  const entities = (index.assets && index.assets.entities || []).map((entry) => {
    const asset = readJson(path.resolve(projectDir, entry.file));
    if (!asset || asset.kind !== ASSET_ENTITY_KIND) {
      throw new Error('invalid Unity fidelity entity asset: ' + entry.file);
    }
    const entity = clone(asset.entity);
    entity.primitives = (entity.primitives || []).map((primitive) => {
      const ref = primitive.material && primitive.material.assetRef;
      if (!ref || !materialByKey[ref.key]) {
        throw new Error('missing Unity fidelity material asset for primitive: ' + (primitive.id || primitive.name || '<unknown>'));
      }
      const next = clone(primitive);
      next.material = clone(materialByKey[ref.key]);
      return next;
    });
    return entity;
  });
  const phases = (index.assets && index.assets.phases || []).map((entry) => {
    const asset = readJson(path.resolve(projectDir, entry.file));
    if (!asset || asset.kind !== ASSET_PHASE_KIND) {
      throw new Error('invalid Unity fidelity phase asset: ' + entry.file);
    }
    return clone(asset.phase);
  });
  const hud = (index.assets && index.assets.hud || []).map((entry) => {
    const asset = readJson(path.resolve(projectDir, entry.file));
    if (!asset || asset.kind !== ASSET_HUD_KIND) {
      throw new Error('invalid Unity fidelity hud asset: ' + entry.file);
    }
    return clone(asset.hud);
  });
  return {
    schemaVersion: index.contractRoots.schemaVersion,
    kind: index.contractRoots.kind,
    producerVersion: index.contractRoots.producerVersion,
    requiredCapabilities: clone(index.contractRoots.requiredCapabilities),
    coordinateSystem: clone(index.contractRoots.coordinateSystem),
    rendererAdapter: clone(index.contractRoots.rendererAdapter),
    entities,
    phases,
    hud,
    unityCoverage: clone(index.contractRoots.unityCoverage),
    unresolvedFidelityGaps: clone(index.contractRoots.unresolvedFidelityGaps || []),
    contractConflicts: clone(index.contractRoots.contractConflicts || []),
  };
}

function readUnityFidelityManifest(projectDir, options) {
  const manifestPath = resolveManifestPath(projectDir, options);
  const parsed = readJson(manifestPath);
  if (parsed && parsed.kind === MANIFEST_KIND && parsed.assetIndexRelativePath) {
    return readUnityFidelityAssetPack(projectDir, Object.assign({}, options || {}, {
      assetIndexRelativePath: parsed.assetIndexRelativePath,
    }));
  }
  if (parsed && parsed.kind === MANIFEST_KIND) return parsed.contract;
  if (parsed && parsed.kind === 'blueprint.fidelityContract') return parsed;
  throw new Error('invalid Unity fidelity manifest: ' + manifestPath);
}

function runUnityFidelityRoundTrip(contract, projectDir, options) {
  options = options || {};
  const writeResult = writeUnityFidelityManifest(contract, projectDir, options);
  const readbackContract = readUnityFidelityManifest(projectDir, options);
  const roundTrip = buildFidelityRoundTripSummary(contract, readbackContract);
  return {
    manifestPath: writeResult.manifestPath,
    assetIndexPath: writeResult.assetIndexPath,
    assetIndex: writeResult.assetIndex,
    assetFiles: writeResult.assetFiles,
    auditResult: writeResult.auditResult,
    readbackContract,
    roundTrip,
  };
}

module.exports = {
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  ASSET_INDEX_KIND,
  ASSET_ENTITY_KIND,
  ASSET_MATERIAL_KIND,
  ASSET_PHASE_KIND,
  ASSET_HUD_KIND,
  DEFAULT_MANIFEST_RELATIVE_PATH,
  DEFAULT_ASSET_INDEX_RELATIVE_PATH,
  DEFAULT_ASSET_ROOT_RELATIVE_PATH,
  assertUnityWriterReady,
  buildUnityFidelityAssetPack,
  writeUnityFidelityAssets,
  readUnityFidelityAssetPack,
  buildUnityWriterManifest,
  writeUnityFidelityManifest,
  readUnityFidelityManifest,
  runUnityFidelityRoundTrip,
};
