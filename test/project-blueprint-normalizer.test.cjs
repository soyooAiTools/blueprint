var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var projectsApi = require('../api/projects.cjs');
var { normalizeProjectBlueprint } = require('../lib/project-blueprint-normalizer.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

var nodesOnlyProject = {
  id: 'proj_nodes_only',
  name: 'NodesOnlyProject',
  status: 'editing',
  blueprint: {
    nodes: [
      {
        id: 'phase_intro',
        type: 'phaseNode',
        position: { x: 0, y: 0 },
        data: {
          name: 'intro',
          activate: ['Player', 'ConveyorBelt'],
          guide: '靠近传送带',
          endCondition: 'entity:ConveyorBelt.state == built',
          camera: { lookAt: 'ConveyorBelt', zoom: 1.1 }
        }
      },
      {
        id: 'entity_player',
        type: 'entityNode',
        position: { x: 200, y: 0 },
        data: {
          name: 'Player',
          label: '玩家',
          template: 'PlayerController',
          visual: { position: '(0,0,0)' },
          behavior: { moveSpeed: 5 }
        }
      },
      {
        id: 'entity_conveyor',
        type: 'entityNode',
        position: { x: 300, y: 0 },
        data: {
          name: 'ConveyorBelt',
          label: '传送带',
          template: 'Buildable',
          visual: { position: '(1,0,1)' },
          trigger: { type: 'proximity', params: { radius: 2 } },
          behavior: { buildTime: 2 }
        }
      }
    ],
    edges: [],
    globalSettings: { cameraAngle: 'topDown45' }
  },
  entities: [],
  phases: [],
  updatedAt: new Date().toISOString()
};

var normalized = normalizeProjectBlueprint(clone(nodesOnlyProject));
assert.strictEqual(normalized.entities.length, 2, 'normalizeProjectBlueprint should derive entities from entity nodes');
assert.strictEqual(normalized.blueprint.entities.length, 2, 'blueprint.entities should be derived from nodes');
assert.strictEqual(normalized.phases.length, 1, 'normalizeProjectBlueprint should derive phases from phase nodes');
assert.strictEqual(normalized.blueprint.phases.length, 1, 'blueprint.phases should be derived from nodes');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-normalizer-'));
var storedProject = clone(nodesOnlyProject);
var ctx = {
  taskQueue: {
    _task: null,
    get: function() { return this._task; },
    updateBlueprint: function(id, blueprint) { this._task = { id: id, blueprint: blueprint }; },
    updateStatus: function() {},
    enqueue: function(taskId, id, name, blueprint) { this._task = { taskId: taskId, id: id, name: name, blueprint: blueprint }; },
    cancel: function() {}
  },
  config: {
    PORT: 3210,
    DATA_DIR: tmpRoot,
    PROJECTS_DIR: path.join(tmpRoot, 'projects'),
    WEBGL_DIR: path.join(tmpRoot, 'webgl'),
    SOURCES_DIR: path.join(tmpRoot, 'sources')
  },
  sendJSON: function(res, payload, status) {
    res.statusCode = status || 200;
    res.payload = payload;
  },
  readProject: function(id) {
    return storedProject && storedProject.id === id ? clone(storedProject) : null;
  },
  writeProject: function(project) {
    storedProject = clone(project);
  },
  listProjects: function() { return []; },
  generateId: function() { return 'generated'; },
  notify: { alert: function() {} },
  wakeOpenClaw: function() {},
  resetCUARetries: function() {}
};

fs.mkdirSync(ctx.config.PROJECTS_DIR, { recursive: true });
fs.mkdirSync(ctx.config.WEBGL_DIR, { recursive: true });
fs.mkdirSync(ctx.config.SOURCES_DIR, { recursive: true });

var handlers = projectsApi.init(ctx);
var saveRes = {};
handlers.saveBlueprint({}, saveRes, JSON.stringify({
  nodes: nodesOnlyProject.blueprint.nodes,
  edges: [],
  projectName: nodesOnlyProject.name,
  globalSettings: nodesOnlyProject.blueprint.globalSettings
}), { id: 'proj_nodes_only' });

assert.strictEqual(saveRes.statusCode, 200, 'saveBlueprint should succeed for nodes-only payload');
assert.strictEqual(storedProject.entities.length, 2, 'saveBlueprint should backfill top-level entities from nodes');
assert.strictEqual(storedProject.blueprint.entities.length, 2, 'saveBlueprint should backfill blueprint.entities from nodes');
assert.strictEqual(storedProject.phases.length, 1, 'saveBlueprint should backfill top-level phases from nodes');
assert.strictEqual(storedProject.blueprint.phases.length, 1, 'saveBlueprint should backfill blueprint.phases from nodes');

var exported = handlers.exportBlueprintForAgent(storedProject);
assert.strictEqual(exported.entities.length, 2, 'exportBlueprintForAgent should export normalized entities');
assert.strictEqual(exported.phases.length, 1, 'exportBlueprintForAgent should export normalized phases');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('project blueprint normalizer tests passed');
