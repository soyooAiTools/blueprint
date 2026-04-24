/**
 * Entity Resolver — Map spec entity names to pool objects before skeleton generation
 *
 * Bridges the gap between abstract entity names in specs (e.g. "bulletMaker")
 * and physical pool objects in the scene (e.g. "__Pool_Cube_Brown_03").
 *
 * Must run after spec-extract and before skeleton-gen / codegen.
 */

var promptV5 = require('../worker/prompt-v5-basetemplate.js');

/**
 * Resolve entity names from specs to pool object names
 * @param {Array} specs - Phase specs from spec-extractor
 * @param {Array} blueprintEntities - blueprint.entities array (if exists)
 * @returns {object} { entityPoolMap: {name: poolName}, resolvedSpecs: specs with poolName added }
 */
function resolveEntities(specs, blueprintEntities) {
  // Guard: specs may be undefined/null for legacy blueprints or tasks that skipped spec-extraction
  if (!specs || specs.length === 0) {
    return {
      entityPoolMap: {},
      resolvedSpecs: [],
      allEntities: {},
      poolManifest: buildPoolManifest({}, {}, blueprintEntities),
    };
  }

  // Collect all unique entity names from specs
  var specEntities = {};
  for (var i = 0; i < specs.length; i++) {
    var ents = specs[i].entitiesRequired || [];
    for (var j = 0; j < ents.length; j++) {
      if (ents[j].name && !specEntities[ents[j].name]) {
        specEntities[ents[j].name] = {
          name: ents[j].name,
          terminalState: ents[j].terminalState || 2,
          description: ents[j].description || '',
        };
      }
    }
  }

  // Also include interaction targets as potential entities.
  // NOTE: count-style verbs (defeat_count:5, collect:IceBlock:5, spend:gold:20)
  // use the numeric suffix as a quantity, not an entity name. Treating "5" as
  // an entity leaks into skeleton codegen and produces bogus Register("5",...)
  // + GameObject Entity5 declarations (see 2026-04-20 82frm7 postmortem).
  var COUNT_VERBS = { defeat_count: 1, spend: 1, collect: 1, deliver: 1, upgrade: 1, unlock: 1 };
  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var k = 0; k < interactions.length; k++) {
      var parts = interactions[k].split(':');
      var verb = parts[0];
      var target = parts[1];
      if (!target || specEntities[target] || verb === 'wait' || verb === 'defend') continue;
      // Numeric targets are counts/amounts, not entity names.
      if (/^\d+(\.\d+)?$/.test(target)) continue;
      // For count-style verbs the "entity" is parts[1] only when it's non-numeric
      // — guarded above — so this is now safe.
      specEntities[target] = {
        name: target,
        terminalState: 1,
        description: 'interaction target for ' + verb,
      };
    }
  }

  // Assembly-first projects often contain runtime entities that never appear in
  // spec.entitiesRequired, for example spawner outputs, helper machines, bullets,
  // or chain-linked workers. If we only resolve spec-visible entities, skeleton
  // generation under-declares GameObject fields/state vars and later AI/template
  // code references undeclared symbols (GoldRecycler / TowerShooter / Bullet ...).
  //
  // Treat every blueprint entity as a first-class runtime entity so the pool map
  // and skeleton stay aligned with the actual node graph, not just the reduced
  // experience-contract view.
  if (Array.isArray(blueprintEntities)) {
    for (var bp = 0; bp < blueprintEntities.length; bp++) {
      var bpEntity = blueprintEntities[bp];
      if (!bpEntity || !bpEntity.name || specEntities[bpEntity.name]) continue;
      specEntities[bpEntity.name] = {
        name: bpEntity.name,
        terminalState: bpEntity.terminalState || 1,
        description: bpEntity.description || 'blueprint entity',
      };
    }
  }

  // Build entity list compatible with matchPrefabs format
  var entityList = [];
  var specEntityNames = Object.keys(specEntities);
  for (var i = 0; i < specEntityNames.length; i++) {
    var se = specEntities[specEntityNames[i]];
    // Check if blueprint.entities has a matching entry with template info
    var bpEntity = null;
    if (blueprintEntities) {
      for (var bi = 0; bi < blueprintEntities.length; bi++) {
        if (blueprintEntities[bi].name === se.name) {
          bpEntity = blueprintEntities[bi];
          break;
        }
      }
    }
    entityList.push({
      name: se.name,
      template: bpEntity ? (bpEntity.template || '') : '',
    });
  }

  // Use prompt-v5's matchPrefabs to get pool mapping
  var entityPoolMap = {};
  if (promptV5.matchPrefabs && entityList.length > 0) {
    entityPoolMap = promptV5.matchPrefabs(entityList);
  }

  // Enrich specs with resolved pool names
  var resolvedSpecs = specs.map(function(spec) {
    var resolved = JSON.parse(JSON.stringify(spec)); // deep clone
    if (resolved.entitiesRequired) {
      resolved.entitiesRequired = resolved.entitiesRequired.map(function(ent) {
        return {
          name: ent.name,
          terminalState: ent.terminalState,
          description: ent.description,
          poolName: entityPoolMap[ent.name] || null,
          stateVar: ent.name + 'State',
        };
      });
    }
    return resolved;
  });

  // Build pool manifest — structured metadata for prompt trimming + debugging
  var poolManifest = buildPoolManifest(entityPoolMap, specEntities, blueprintEntities);

  return {
    entityPoolMap: entityPoolMap,
    resolvedSpecs: resolvedSpecs,
    allEntities: specEntities,
    poolManifest: poolManifest,
  };
}

function buildPoolManifest(entityPoolMap, specEntities, blueprintEntities) {
  var SHAPES = { Cube: 5, Sphere: 5, Cylinder: 3, Plane: 3 };
  var COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Purple', 'White', 'Brown', 'Cyan', 'Pink'];
  var totalAvailable = 0;
  var shapeKeys = Object.keys(SHAPES);
  for (var si = 0; si < shapeKeys.length; si++) totalAvailable += SHAPES[shapeKeys[si]] * COLORS.length;

  var activePool = [];
  var usedPools = {};
  var entityNames = Object.keys(entityPoolMap);
  for (var i = 0; i < entityNames.length; i++) {
    var eName = entityNames[i];
    var poolName = entityPoolMap[eName];
    usedPools[poolName] = true;
    var parts = poolName.match(/^__Pool_(\w+)_(\w+)_(\d+)$/);
    var shape = parts ? parts[1] : 'Cube';
    var color = parts ? parts[2] : 'White';

    var bpEntity = null;
    if (blueprintEntities) {
      for (var bi = 0; bi < blueprintEntities.length; bi++) {
        if (blueprintEntities[bi].name === eName) { bpEntity = blueprintEntities[bi]; break; }
      }
    }
    var specEnt = specEntities[eName];

    activePool.push({
      poolName: poolName,
      entity: eName,
      shape: shape,
      color: color,
      role: (bpEntity && bpEntity.template) || 'static',
      initialVisible: !!(bpEntity && bpEntity.visual && bpEntity.visual.position),
      initialPos: (bpEntity && bpEntity.visual && bpEntity.visual.position) || null,
      terminalState: specEnt ? specEnt.terminalState : 1,
    });
  }

  // Reserve extra objects of same shape+color for Instantiate overflow
  var reservedPool = [];
  var shapeCounts = {};
  for (var ai = 0; ai < activePool.length; ai++) {
    var key = activePool[ai].shape + '_' + activePool[ai].color;
    shapeCounts[key] = (shapeCounts[key] || 0) + 1;
  }
  var scKeys = Object.keys(shapeCounts);
  for (var ri = 0; ri < scKeys.length; ri++) {
    var scParts = scKeys[ri].split('_');
    var rShape = scParts[0], rColor = scParts[1];
    var used = shapeCounts[scKeys[ri]];
    var max = SHAPES[rShape] || 5;
    if (used < max) {
      var nextIdx = used + 1;
      var reserveCount = Math.min(2, max - used);
      for (var rx = 0; rx < reserveCount; rx++) {
        var num = (nextIdx + rx) < 10 ? '0' + (nextIdx + rx) : '' + (nextIdx + rx);
        var rPoolName = '__Pool_' + rShape + '_' + rColor + '_' + num;
        if (!usedPools[rPoolName]) {
          reservedPool.push({ poolName: rPoolName, shape: rShape, color: rColor, purpose: 'instantiate_overflow' });
        }
      }
    }
  }

  return {
    version: 1,
    totalAvailable: totalAvailable,
    activeCount: activePool.length,
    activePool: activePool,
    reservedPool: reservedPool,
    unusedCount: totalAvailable - activePool.length - reservedPool.length,
  };
}

module.exports = { resolveEntities: resolveEntities };
