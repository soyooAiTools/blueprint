var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var projectsApi = require('../api/projects.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-assembly-projects-'));
var storedProject = null;
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

storedProject = {
  id: 'proj_assembly',
  name: 'IntegrationProject',
  status: 'editing',
  blueprint: { nodes: [], edges: [] },
  storyboardFrames: [
    { title: 'Intro', interaction: 'move_to:ConveyorBelt' },
    { title: 'Build', interaction: 'build:ConveyorBelt', camera: '镜头拉高看到全图' }
  ],
  updatedAt: new Date().toISOString()
};

var handlers = projectsApi.init(ctx);

var saveRes = {};
handlers.saveBlueprint({}, saveRes, JSON.stringify({
  nodes: [],
  edges: [],
  projectName: 'IntegrationProject',
  globalSettings: { cameraAngle: 'topDown45' },
  entities: [
    {
      name: 'Player',
      label: '玩家',
      template: 'PlayerController',
      visual: { position: '(0,0,0)', scale: '1×1×1' },
      behavior: { moveSpeed: 5 }
    },
    {
      name: 'ConveyorBelt',
      label: '传送带',
      template: 'Buildable',
      visual: { position: '(1,0,1)', scale: '1×1×1' },
      trigger: { type: 'proximity', params: { radius: 2, cost: { gold: 1 } } },
      behavior: { buildTime: 2 }
    }
  ],
  phases: [
    { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带', camera: { lookAt: 'ConveyorBelt', zoom: 1.1 } }
  ]
}), { id: 'proj_assembly' });

assert.strictEqual(saveRes.statusCode, 200, 'saveBlueprint should succeed');
assert.ok(storedProject.plans, 'plans should be attached after save');
assert.ok(storedProject.planValidation && storedProject.planValidation.ok, 'plan validation should pass after save');
assert.ok(Array.isArray(storedProject.phases) && storedProject.phases.length === 1, 'phases should sync to top-level');

storedProject.status = 'spec_review';
storedProject.specs = [
  { phaseId: 'intro', requiredInteractions: ['move_to:ConveyorBelt', 'build:ConveyorBelt'] }
];

var specsRes = {};
handlers.getSpecs({}, specsRes, '', { id: 'proj_assembly' });
assert.strictEqual(specsRes.statusCode, 200, 'getSpecs should succeed');
assert.ok(specsRes.payload.plans && specsRes.payload.plans.assemblyPlan, 'getSpecs should include plans');
assert.ok(specsRes.payload.planValidation && specsRes.payload.planValidation.ok, 'getSpecs should include plan validation');

var confirmRes = {};
handlers.confirmSpecs({}, confirmRes, JSON.stringify({ specs: storedProject.specs }), { id: 'proj_assembly' });

assert.strictEqual(confirmRes.statusCode, 200, 'confirmSpecs should succeed');
var specsPath = path.join(ctx.config.WEBGL_DIR, 'proj_assembly', 'specs.json');
var plansPath = path.join(ctx.config.WEBGL_DIR, 'proj_assembly', 'plans.json');
assert.ok(fs.existsSync(specsPath), 'specs.json should be written');
assert.ok(fs.existsSync(plansPath), 'plans.json should be written');
assert.ok(storedProject.planReview && storedProject.planReview.cuaStepCount > 0, 'planReview summary should be recorded on confirm');

var exported = handlers.exportBlueprintForAgent(storedProject);
assert.ok(exported.plans, 'export should include plans');
assert.ok(exported.plans.cuaPlan && exported.plans.cuaPlan.steps.length > 0, 'exported cua plan missing');
assert.ok(exported.phases.length === 1, 'exported phases missing');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('projects-assembly-integration tests passed');
