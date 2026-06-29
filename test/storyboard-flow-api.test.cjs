#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var { matchRoute } = require('../api/router.cjs');
var storyboardFlowApi = require('../api/storyboard-flow.cjs');

function fixtureFlow() {
  return {
    schemaVersion: 'storyboard-flow-prototype.v1',
    kind: 'blueprint.storyboardFlowPrototype',
    projectName: 'Flow API Fixture',
    entities: [
      { id: 'Player', label: '玩家', kind: 'player' },
      { id: 'Oven', label: '烤箱', kind: 'station' },
      { id: 'Counter', label: '柜台', kind: 'station' },
      { id: 'CtaButton', label: '下载按钮', kind: 'cta' },
    ],
    resources: [
      { id: 'Food', label: '餐食', carrierEntity: 'Oven', initial: 0 },
      { id: 'Coin', label: '金币', carrierEntity: 'Counter', initial: 0 },
    ],
    phases: [
      {
        id: 'phase1',
        order: 1,
        title: '制作餐食',
        action: 'produce',
        target: 'Oven',
        resource: 'Food',
        guideText: '移动到烤箱制作餐食。',
        requiredInteractions: ['move_to:Oven', 'produce:Food:1'],
        completeCondition: 'Food >= 1',
        visibleEntities: ['Player', 'Oven'],
      },
      {
        id: 'phase2',
        order: 2,
        title: '交付餐食',
        action: 'deliver',
        target: 'Counter',
        resource: 'Food',
        guideText: '把餐食交到柜台获得金币。',
        requiredInteractions: ['deliver:Food:Counter:1', 'reward:Coin:10'],
        completeCondition: 'Coin >= 10',
        visibleEntities: ['Player', 'Counter', 'Oven'],
      },
      {
        id: 'phase3',
        order: 3,
        title: '下载',
        action: 'cta_finish',
        target: 'CtaButton',
        guideText: '点击按钮下载完整游戏。',
        requiredInteractions: ['click:CtaButton'],
        completeCondition: 'CtaButton.clicked',
        visibleEntities: ['Player', 'CtaButton'],
      },
    ],
  };
}

function makeResponse() {
  return {
    status: null,
    data: null,
    headers: null,
    body: '',
    writeHead: function(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    end: function(body) {
      this.body = body || '';
      if (this.headers && /json/.test(String(this.headers['Content-Type'] || ''))) {
        this.data = JSON.parse(this.body);
      }
    },
  };
}

function call(handler, body, params) {
  var res = makeResponse();
  handler({ headers: {} }, res, body ? JSON.stringify(body) : '', params || { id: 'flowapi' });
  return res;
}

var route = matchRoute('GET', '/api/projects/flowapi/storyboard-flow');
assert.deepStrictEqual(route, { handler: 'getStoryboardFlow', id: 'flowapi' });
route = matchRoute('POST', '/api/projects/flowapi/storyboard-flow/source-ir');
assert.deepStrictEqual(route, { handler: 'generateStoryboardFlowSourceIr', id: 'flowapi' });
route = matchRoute('GET', '/api/projects/flowapi/storyboard-flow/artifacts/source-ir/source-ir-preview.html');
assert.strictEqual(route.handler, 'serveStoryboardFlowArtifact');
assert.strictEqual(route.flowFile, 'source-ir/source-ir-preview.html');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-flow-api-'));
var projects = {
  flowapi: {
    id: 'flowapi',
    name: 'Flow API Fixture',
    status: 'editing',
    blueprint: { nodes: [], edges: [], projectName: 'Flow API Fixture' },
    createdAt: '2026-06-12T00:00:00.000Z',
    updatedAt: '2026-06-12T00:00:00.000Z',
  },
};
var handlers = storyboardFlowApi.init({
  config: { DATA_DIR: tmp },
  sendJSON: function(res, data, status) {
    res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  },
  readProject: function(id) { return projects[id] || null; },
  writeProject: function(project) { projects[project.id] = JSON.parse(JSON.stringify(project)); },
  serveStatic: function(res, filePath) {
    if (!fs.existsSync(filePath)) return false;
    res.writeHead(200, { 'Content-Type': /\.html?$/.test(filePath) ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
    res.end(fs.readFileSync(filePath, 'utf8'));
    return true;
  },
});

var saveRes = call(handlers.saveStoryboardFlow, { flow: fixtureFlow() });
assert.strictEqual(saveRes.status, 200);
assert.strictEqual(projects.flowapi.storyboardFlow.projectName, 'Flow API Fixture');
assert.ok(fs.existsSync(path.join(tmp, 'storyboard-flows', 'flowapi', 'storyboard-flow.json')));

var validateRes = call(handlers.validateStoryboardFlow, { flow: fixtureFlow() });
assert.strictEqual(validateRes.status, 200);
assert.strictEqual(validateRes.data.report.passed, true);
assert.strictEqual(projects.flowapi.storyboardFlowAuthoringSummary.passed, true);

var generateRes = call(handlers.generateStoryboardFlowSourceIr, { flow: fixtureFlow() });
assert.strictEqual(generateRes.status, 200, generateRes.body);
assert.strictEqual(generateRes.data.report.passed, true);
assert.ok(projects.flowapi.sourceHtmlPath.endsWith(path.join('source-ir', 'source-ir-preview.html')));
assert.ok(fs.existsSync(projects.flowapi.sourceHtmlPath));
assert.ok(generateRes.data.urls.html.indexOf('/api/projects/flowapi/storyboard-flow/artifacts/source-ir/source-ir-preview.html') === 0);

var diffRes = call(handlers.diffStoryboardFlow, { flow: fixtureFlow(), sourceHtmlPath: projects.flowapi.sourceHtmlPath });
assert.strictEqual(diffRes.status, 200, diffRes.body);
assert.strictEqual(diffRes.data.report.passed, true);
assert.strictEqual(diffRes.data.report.diffCounts.blocker, 0);
assert.ok(fs.existsSync(path.join(tmp, 'storyboard-flows', 'flowapi', 'diff', 'storyboard-flow-diff-report.json')));

var artifactRes = makeResponse();
handlers.serveStoryboardFlowArtifact({ headers: {} }, artifactRes, '', {
  id: 'flowapi',
  flowFile: 'source-ir/source-ir-preview.html',
});
assert.strictEqual(artifactRes.status, 200);
assert.ok(artifactRes.body.indexOf('__BP_SOURCE_IR__') >= 0);

console.log('storyboard flow API tests passed');
