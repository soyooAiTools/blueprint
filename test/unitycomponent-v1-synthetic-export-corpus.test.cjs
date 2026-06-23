#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var sourceIrArtifacts = require('../adapters/source-ir/index.js');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');

function normalize(project, extra) {
  var raw = Object.assign({
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    project: { name: project },
    scene: {
      backgroundColor: '#101820',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' }
    },
    entities: [
      { id: 'Player', kind: 'player', label: 'Player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } }
    ],
    resources: [],
    phases: []
  }, extra || {});
  raw.entities = [
    { id: 'Player', kind: 'player', label: 'Player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } }
  ].concat((extra && extra.entities) || [], [
    { id: 'CtaButton', kind: 'cta', label: 'Install', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } }
  ]);
  var phases = (extra && extra.phases) || [];
  raw.phases = phases.concat([{
    id: 'phase' + (phases.length + 1),
    guideText: 'Tap install',
    showEntities: ['Player', 'CtaButton'],
    plannedModuleIds: ['cta_finish'],
    steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
    gate: { kind: 'cta_arrival', entity: 'CtaButton' }
  }]);
  raw.hud = { tip: { source: 'phase.guideText' }, cta: { entity: 'CtaButton', arrivalGated: true } };
  return sourceSceneIr.normalizeSourceSceneIr(raw, {
    sourceHtmlPath: '/tmp/' + project + '.html',
    sourceHtmlSha256: 'c'.repeat(64),
    html: '',
    generatedAt: '2026-06-23T00:00:00.000Z'
  });
}

function fixture(project, entity, phase, resources) {
  return normalize(project, {
    entities: entity ? [entity] : [],
    resources: resources || [],
    phases: [phase]
  });
}

var corpus = [
  fixture('move-guide', { id: 'Marker', kind: 'target', label: 'Marker', position: [2, 0, 0], visual: { primitive: 'box', color: '#ffffff' } }, {
    id: 'phase1',
    guideText: 'Move to the marker',
    showEntities: ['Player', 'Marker'],
    plannedModuleIds: ['player_input_joystick', 'move_to_target'],
    steps: [{ kind: 'move_to', target: 'Marker', radius: 1.2 }],
    gate: { kind: 'near_entity', entity: 'Marker', radius: 1.2 }
  }),
  fixture('resource-stack', { id: 'Coin', kind: 'resource', label: 'Coin', position: [2, 0, 0], visual: { primitive: 'sphere', color: '#ffdd55' } }, {
    id: 'phase1',
    guideText: 'Collect coins',
    showEntities: ['Player', 'Coin'],
    plannedModuleIds: ['collect_on_near', 'inventory_wallet'],
    steps: [{ kind: 'collect', target: 'Coin', resource: 'CoinCount', amount: 3 }],
    gate: { kind: 'resource', resource: 'CoinCount', threshold: 3 }
  }, [{ id: 'CoinCount', label: 'Coins', kind: 'resource' }]),
  fixture('combat-hp', { id: 'Dummy', kind: 'enemy', label: 'Dummy', position: [2, 0, 0], visual: { primitive: 'box', color: '#aa3333' } }, {
    id: 'phase1',
    guideText: 'Attack the dummy',
    showEntities: ['Player', 'Dummy'],
    plannedModuleIds: ['combat_attack', 'hp_damage'],
    steps: [{ kind: 'attack', target: 'Dummy', damage: 1 }],
    gate: { kind: 'entity_state', entity: 'Dummy', state: 'defeated' }
  }),
  fixture('pool-effect', { id: 'HitEffect', kind: 'effect', label: 'Hit', position: [2, 0, 0], visual: { primitive: 'sphere', color: '#ffaa33' } }, {
    id: 'phase1',
    guideText: 'Trigger the hit effect',
    showEntities: ['Player', 'HitEffect'],
    plannedModuleIds: ['spawn_effect'],
    steps: [{ kind: 'show', target: 'HitEffect' }],
    gate: { kind: 'entity_state', entity: 'HitEffect', state: 'shown' }
  }),
  fixture('build-workshop', { id: 'Workshop', kind: 'building', label: 'Workshop', position: [3, 0, 0], visual: { primitive: 'box', color: '#55aa88' } }, {
    id: 'phase1',
    guideText: 'Build the workshop',
    showEntities: ['Player', 'Workshop'],
    plannedModuleIds: ['build_structure'],
    steps: [{ kind: 'build', entity: 'Workshop', target: 'Workshop' }],
    gate: { kind: 'entity_state', entity: 'Workshop', state: 'built' }
  }),
  fixture('skill-cast', { id: 'SkillButton', kind: 'ui', label: 'Skill', position: [4, 0, 0], visual: { primitive: 'box', color: '#8844ff' } }, {
    id: 'phase1',
    guideText: 'Use the skill',
    showEntities: ['Player', 'SkillButton'],
    plannedModuleIds: ['skill_button', 'ability_cast'],
    steps: [{ kind: 'select', target: 'SkillButton' }],
    gate: { kind: 'entity_state', entity: 'SkillButton', state: 'used' }
  }),
  normalize('transfer-economy', {
    entities: [
      { id: 'WoodPile', kind: 'resource', label: 'Wood', position: [2, 0, 0], visual: { primitive: 'box', color: '#8b5a2b' } },
      { id: 'Depot', kind: 'target', label: 'Depot', position: [4, 0, 0], visual: { primitive: 'box', color: '#669966' } }
    ],
    resources: [{ id: 'Wood', label: 'Wood', kind: 'resource' }],
    phases: [{
      id: 'phase1',
      guideText: 'Collect and deliver wood',
      showEntities: ['Player', 'WoodPile', 'Depot'],
      plannedModuleIds: ['collect_on_near', 'inventory_wallet'],
      steps: [
        { kind: 'collect', target: 'WoodPile', resource: 'Wood', amount: 2 },
        { kind: 'transfer', resource: 'Wood', amount: 2, target: 'Depot' }
      ],
      gate: { kind: 'entity_state', entity: 'Depot', state: 'filled' }
    }]
  }),
  fixture('spawn-minion', { id: 'EnemyMinion', kind: 'minion', label: 'Minion', position: [3, 0, 0], visual: { primitive: 'capsule', color: '#bb3333' } }, {
    id: 'phase1',
    guideText: 'Spawn a minion',
    showEntities: ['Player', 'EnemyMinion'],
    plannedModuleIds: ['spawn_wave'],
    steps: [{ kind: 'spawn', target: 'EnemyMinion' }],
    gate: { kind: 'entity_state', entity: 'EnemyMinion', state: 'spawned' }
  }),
  fixture('reward-wallet', { id: 'Treasure', kind: 'resource', label: 'Treasure', position: [2, 0, 0], visual: { primitive: 'sphere', color: '#ffd700' } }, {
    id: 'phase1',
    guideText: 'Claim the reward',
    showEntities: ['Player', 'Treasure'],
    plannedModuleIds: ['reward_resource', 'inventory_wallet'],
    steps: [{ kind: 'reward', resource: 'Gold', amount: 5, target: 'Treasure' }],
    gate: { kind: 'resource', resource: 'Gold', threshold: 5 }
  }, [{ id: 'Gold', label: 'Gold', kind: 'resource' }]),
  fixture('upgrade-station', { id: 'Station', kind: 'building', label: 'Station', position: [3, 0, 0], visual: { primitive: 'box', color: '#33aa99' } }, {
    id: 'phase1',
    guideText: 'Upgrade the station',
    showEntities: ['Player', 'Station'],
    plannedModuleIds: ['upgrade_station'],
    steps: [{ kind: 'upgrade', entity: 'Station', target: 'Station', level: 2 }],
    gate: { kind: 'entity_state', entity: 'Station', state: 'upgraded' }
  })
];

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-synthetic-corpus-'));

corpus.forEach(function(sourceIr, index) {
  var project = sourceIr.project.name;
  var artifactsDir = path.join(tmp, 'artifacts-' + index + '-' + project);
  var unityDir = path.join(tmp, 'unity-' + index + '-' + project);
  sourceIrArtifacts.buildSourceIrArtifacts('', artifactsDir, {
    sourceIr: sourceIr,
    noBlueprint: true,
    generatedAt: '2026-06-23T00:00:00.000Z'
  });
  var result = emitter.emitFromArtifacts(artifactsDir, unityDir, { generatedAt: '2026-06-23T00:00:00.000Z' });
  assert.strictEqual(result.report.passed, true, project + ': ' + JSON.stringify(result.report.errors, null, 2));
  assert.strictEqual(hardgate.validateUnityComponentV1(unityDir).passed, true, project + ' hardgate');
  var spec = result.spec;
  assert.strictEqual(spec.profile, 'unitycomponent-v1', project + ' profile');
  assert.strictEqual(spec.phases.length, sourceIr.phases.length, project + ' phase count');
  assert.deepStrictEqual(spec.phases.map(function(phase) { return phase.guideText; }), sourceIr.phases.map(function(phase) { return phase.guideText; }), project + ' guideText parity');
  assert.ok(fs.existsSync(path.join(unityDir, 'UNITYCOMPONENT_V1_VALIDATION.json')), project + ' validation report');
  var componentRoot = path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Component');
  var componentFiles = [];
  function walkComponents(dir) {
    fs.readdirSync(dir).forEach(function(name) {
      var file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walkComponents(file);
      else if (/\.cs$/i.test(file)) componentFiles.push(file);
    });
  }
  walkComponents(componentRoot);
  var allText = componentFiles.map(function(file) {
    return fs.readFileSync(file, 'utf8');
  }).join('\n');
  assert.strictEqual(/Execute[A-Za-z0-9_]*\s*\(\)\s*\{\s*\}/.test(allText), false, project + ' must not emit decorative Execute shells');
});

assert.ok(corpus.length >= 10, 'synthetic export corpus must cover at least 10 unit fixtures; this is not cutover evidence');

console.log('unitycomponent v1 synthetic export corpus tests passed');
