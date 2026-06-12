#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');

var {
  SOURCE_IR_PREVIEW_RENDERER_VERSION,
  buildSourceIrPreviewHtml,
  buildSourceIrPreviewRendererScript,
  buildThreeLoaderTags,
  rewriteHtmlWithSourceIrPreviewRenderer,
} = require('../engine/source-ir-preview-renderer.cjs');

var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  detectSourceIrPreviewRenderer,
  extractSourceSceneIrFromHtml,
  normalizeSourceSceneIr,
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

function fixtureSourceIr() {
  return normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    generatedAt: '2026-06-07T00:00:00.000Z',
    project: { name: 'Water Seller Preview', theme: 'farming' },
    scene: {
      backgroundColor: '#071026',
      camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] },
      ground: { kind: 'plane', size: [20, 20], color: '#13233a' },
      lights: [{ kind: 'ambient', color: '#ffffff', intensity: 0.65 }],
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'WaterDrop', label: 'Water', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
      { id: 'GoldUI', label: 'Gold UI', kind: 'ui_marker', position: [4, 0, 5.4], visual: { primitive: 'box', color: '#ffe45c' } },
    ],
    resources: [{ id: 'Water', label: 'Water', kind: 'resource', carrierEntity: 'WaterDrop', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect water',
        guideText: 'Collect water',
        showEntities: ['Player', 'WaterDrop', 'GoldUI'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near'],
        steps: [
          { kind: 'move_to', target: 'WaterDrop', radius: 1.5 },
          { kind: 'collect', resource: 'Water', amount: 3, from: 'WaterDrop' },
        ],
        gate: { kind: 'resource', resource: 'Water', threshold: 3 },
      },
      {
        id: 'phase2',
        title: 'Install',
        guideText: 'Go to install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton', radius: 1.8 },
      },
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['Water'], cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
}

function createFakeDom() {
  var elements = {};
  var documentListeners = {};

  function makeElement(tag) {
    var idValue = '';
    var el = {
      tagName: String(tag || 'div').toUpperCase(),
      style: {},
      children: [],
      attributes: {},
      parentNode: null,
      className: '',
      textContent: '',
      appendChild: function(child) {
        child.parentNode = el;
        el.children.push(child);
        if (child.id) elements[child.id] = child;
        return child;
      },
      setAttribute: function(name, value) {
        el.attributes[name] = String(value);
      },
      getAttribute: function(name) {
        return el.attributes[name];
      },
      addEventListener: function() {},
      closest: function() { return null; },
    };
    Object.defineProperty(el, 'id', {
      enumerable: true,
      get: function() { return idValue; },
      set: function(value) {
        idValue = String(value || '');
        if (idValue) elements[idValue] = el;
      },
    });
    return el;
  }

  var body = makeElement('body');
  elements.body = body;
  return {
    body: body,
    createElement: makeElement,
    getElementById: function(id) {
      return elements[id] || null;
    },
    addEventListener: function(name, fn) {
      documentListeners[name] = documentListeners[name] || [];
      documentListeners[name].push(fn);
    },
    __elements: elements,
    __listeners: documentListeners,
  };
}

function dispatchDocumentEvent(sandbox, type, props) {
  var listeners = sandbox.document.__listeners[type] || [];
  var event = Object.assign({
    target: { closest: function() { return null; } },
    clientX: 0,
    clientY: 0,
  }, props || {});
  listeners.forEach(function(fn) {
    fn(event);
  });
}

function runHtmlScripts(html) {
  var document = createFakeDom();
  var sandbox = {
    console: console,
    document: document,
    setTimeout: function(fn) { fn(); return 1; },
    clearTimeout: function() {},
    window: {
      document: document,
      innerWidth: 800,
      innerHeight: 600,
      performance: { now: function() { return 1000; } },
      addEventListener: function() {},
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.self = sandbox.window;
  sandbox.window.setTimeout = sandbox.setTimeout;
  sandbox.window.clearTimeout = sandbox.clearTimeout;
  sandbox.window.console = console;
  sandbox.window.Promise = Promise;
  sandbox.window.Error = Error;
  sandbox.window.Number = Number;
  sandbox.window.String = String;
  sandbox.window.Math = Math;
  sandbox.performance = sandbox.window.performance;

  var context = vm.createContext(sandbox);
  var match;
  var re = /<script[^>]*>([\s\S]*?)<\/script>/g;
  while ((match = re.exec(html))) {
    vm.runInContext(match[1], context, { timeout: 1000 });
  }
  return sandbox;
}

async function main() {
  var sourceIr = fixtureSourceIr();
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ir-preview-renderer-'));
  var html = buildSourceIrPreviewHtml(sourceIr, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
    includeThree: false,
  });

  assert.ok(buildSourceIrPreviewRendererScript().indexOf('__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__') >= 0);
  assert.ok(buildThreeLoaderTags({}).length >= 1);
  assert.strictEqual(buildThreeLoaderTags({ includeThree: false }).length, 0);
  assert.ok(html.indexOf('window.__BP_SOURCE_IR__') >= 0);
  assert.ok(html.indexOf('window.__BP_SOURCE_IR_HASH__') >= 0);
  assert.ok(html.indexOf('__driveToSourcePhase') >= 0);
  assert.ok(html.indexOf('source-ir-world-label') >= 0);
  assert.ok(html.indexOf('function movePreviewPlayer(dt)') >= 0);
  assert.ok(html.indexOf('function forcePreviewJoystickVisible(el)') >= 0);
  assert.ok(html.indexOf('function terminalRetainedPhaseList(index)') >= 0);
  assert.ok(html.indexOf('function visualDiffFrozen()') >= 0);
  assert.ok(html.indexOf('if (visualDiffFrozen())') >= 0);
  assert.ok(html.indexOf('source-ir-phase-band') >= 0);
  assert.ok(html.indexOf('source-ir-scene-tone') >= 0);
  var rendererScript = buildSourceIrPreviewRendererScript();
  assert.ok(rendererScript.indexOf('new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.055, 8, 64)') >= 0);
  assert.ok(rendererScript.indexOf('new THREE.Line(new THREE.BufferGeometry()') >= 0);
  assert.ok(rendererScript.indexOf('function updateGuidanceLine()') >= 0);
  assert.ok(rendererScript.indexOf('window.__sourceIrTargetRingState') >= 0);
  assert.ok(rendererScript.indexOf('function resourceLabel(id)') >= 0);
  assert.ok(rendererScript.indexOf('source-ir-resource-pill') >= 0);
  assert.ok(rendererScript.indexOf('camera_height_changed_or_view_widened') >= 0);
  assert.ok(rendererScript.indexOf('step.kind === "deliver" || step.kind === "transfer" || step.kind === "combine"') >= 0);
  assert.ok(rendererScript.indexOf('bucket.resource_decremented') >= 0);
  assert.strictEqual(rendererScript.indexOf('targetRingEl.style.position = "fixed"; targetRingEl.style.left = "50%"; targetRingEl.style.top = "50%"'), -1);

  var detection = detectSourceIrPreviewRenderer(html);
  assert.strictEqual(detection.version, SOURCE_IR_PREVIEW_RENDERER_VERSION);
  assert.strictEqual(detection.ownsVisuals, true);
  assert.strictEqual(detection.ownsPhaseDriver, true);
  assert.strictEqual(detection.visualSourceIsSourceIr, true);

  var extracted = extractSourceSceneIrFromHtml(html, '/tmp/source-ir-preview.html');
  assert.strictEqual(extracted.semanticHash, sourceIr.semanticHash);

  var strictReport = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: '/tmp/source-ir-preview.html',
    requireSourceIrRenderer: true,
  });
  assert.strictEqual(strictReport.passed, true);
  assert.strictEqual(strictReport.summary.sourceIrRenderer.version, SOURCE_IR_PREVIEW_RENDERER_VERSION);

  var htmlPath = path.join(tmp, 'preview.html');
  var cliReportPath = path.join(tmp, 'source-ir-report.json');
  fs.writeFileSync(htmlPath, html);
  var cli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'source-scene-ir-preflight.cjs'),
    htmlPath,
    cliReportPath,
    '--require-renderer',
  ], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(cliReportPath, 'utf8')).summary.sourceIrRenderer.ownsVisuals, true);

  var rewritten = rewriteHtmlWithSourceIrPreviewRenderer(html, { sourceHtmlPath: '/tmp/llm-output.html' });
  var rewrittenReport = preflightSourceSceneIrHtml(rewritten, {
    sourceHtmlPath: '/tmp/rewritten.html',
    requireSourceIrRenderer: true,
  });
  assert.strictEqual(rewrittenReport.passed, true);
  assert.strictEqual(rewrittenReport.summary.sourceIrRenderer.ownsPhaseDriver, true);

  var rewriteCliOut = path.join(tmp, 'rewritten.html');
  var rewriteCli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'source-ir-preview-html.cjs'),
    htmlPath,
    rewriteCliOut,
  ], { encoding: 'utf8' });
  assert.strictEqual(rewriteCli.status, 0, rewriteCli.stderr || rewriteCli.stdout);
  assert.strictEqual(preflightSourceSceneIrHtml(fs.readFileSync(rewriteCliOut, 'utf8'), {
    sourceHtmlPath: rewriteCliOut,
    requireSourceIrRenderer: true,
  }).passed, true);

  assert.throws(function() {
    rewriteHtmlWithSourceIrPreviewRenderer('<!doctype html><html><body></body></html>');
  }, /requires embedded/);

  var missingOwnershipReport = preflightSourceSceneIrHtml(html.replace(
    'window.__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__ = true;',
    'window.__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__ = false;'
  ), {
    sourceHtmlPath: '/tmp/source-ir-preview.html',
    requireSourceIrRenderer: true,
  });
  assert.strictEqual(missingOwnershipReport.passed, false);
  assert.ok(missingOwnershipReport.violations.some(function(violation) {
    return violation.code === 'source_ir_renderer_visual_ownership_missing';
  }));

  var sandbox = runHtmlScripts(html);
  assert.strictEqual(sandbox.window.__BP_SOURCE_IR_PREVIEW_RENDERER_VERSION__, SOURCE_IR_PREVIEW_RENDERER_VERSION);
  assert.strictEqual(sandbox.window.__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__, true);
  assert.strictEqual(sandbox.window.__BP_SOURCE_IR_RENDERER_OWNS_PHASE_DRIVER__, true);
  assert.strictEqual(typeof sandbox.window.__gameState, 'function');
  assert.strictEqual(typeof sandbox.window.__driveToPhase, 'function');
  assert.strictEqual(sandbox.window.__driveToSourcePhase, sandbox.window.__driveToPhase);
  assert.strictEqual(sandbox.document.__elements.joystick.style.display, 'none');
  assert.strictEqual(sandbox.document.__elements.joystick.style.pointerEvents, 'none');
  assert.ok(sandbox.document.__elements['source-ir-scene-tone']);
  assert.ok(sandbox.document.__elements['source-ir-phase-band']);
  assert.ok(sandbox.document.__elements.resourceBar.innerHTML.indexOf('source-ir-resource-pill') >= 0);
  assert.ok(sandbox.document.__elements.resourceBar.innerHTML.indexOf('Water 0') >= 0);
  assert.ok(sandbox.document.__elements['source-ir-world-labels']);
  assert.strictEqual(sandbox.window.__sourceIrPreviewModels.GoldUI, undefined);
  assert.strictEqual(sandbox.window.__sourceIrPreviewModels.CtaButton, undefined);

  var phase1 = sandbox.window.__gameState();
  assert.strictEqual(phase1.phase, 'phase1');
  assert.strictEqual(phase1.ui_state.guideText, 'Collect water');
  assert.strictEqual(phase1.entity_states.GoldUI.visible, true);
  assert.strictEqual(phase1.entity_states.GoldUI.hudOnly, true);
  assert.strictEqual(phase1.entity_states.WaterDrop.visible, true);
  assert.strictEqual(phase1.entity_states.CtaButton, undefined);
  assert.strictEqual(sandbox.window.__BP_SOURCE_IR_RENDERER_USING_DOM_FALLBACK__, true);
  assert.notStrictEqual(sandbox.window.__sourceIrPreviewModels.WaterDrop.dom.style.display, 'none');
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.visible, true);
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.target, 'WaterDrop');
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.mode, 'dom');
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.world.x, 3);
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.world.y, 0);
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.world.z, 0);
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.screen.x, 526);
  assert.strictEqual(sandbox.window.__sourceIrTargetRingState.screen.y, 300);
  assert.strictEqual(sandbox.document.__elements['source-ir-target-ring'].style.display, 'block');
  assert.strictEqual(sandbox.document.__elements['source-ir-target-ring'].style.left, '526.0px');
  assert.strictEqual(sandbox.document.__elements['source-ir-target-ring'].style.top, '300.0px');

  sandbox.window.__sourceIrPreviewModels.Player.position.x = 3;
  sandbox.window.__sourceIrPreviewModels.Player.position.z = 0;
  var noInputProgress = sandbox.window.__sourceIrPreviewRuntimeTick(.016);
  assert.strictEqual(noInputProgress.phase, 'phase1');
  assert.deepStrictEqual(Array.from(noInputProgress.completedPhases), []);
  sandbox.window.__sourceIrPreviewSetJoystick(0.1, 0, true);
  var progressed = sandbox.window.__sourceIrPreviewRuntimeTick(.016);
  assert.strictEqual(progressed.phase, 'phase2');
  assert.strictEqual(progressed.resources.Water, 3);
  assert.deepStrictEqual(Array.from(progressed.completedPhases), ['phase1']);

  var repeatedTargetIr = normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    generatedAt: '2026-06-07T00:00:00.000Z',
    project: { name: 'Repeated target preview', theme: 'default' },
    scene: {
      backgroundColor: '#101820',
      camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] },
      ground: { kind: 'plane', size: [20, 20], color: '#13233a' },
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'Turret', label: 'Turret', kind: 'station', position: [3, 0, 0], visual: { primitive: 'box', color: '#ffaa33' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
    ],
    phases: [
      {
        id: 'phase1',
        title: 'Build turret left',
        guideText: 'Build turret left',
        showEntities: ['Player', 'Turret'],
        steps: [{ kind: 'move_to', target: 'Turret', radius: 1.5 }, { kind: 'build', entity: 'Turret', state: 2 }],
        gate: { kind: 'entity_state', entity: 'Turret', state: 2 },
      },
      {
        id: 'phase2',
        title: 'Build turret right',
        guideText: 'Build turret right',
        showEntities: ['Player', 'Turret'],
        steps: [{ kind: 'move_to', target: 'Turret', radius: 1.5 }, { kind: 'build', entity: 'Turret', state: 2 }],
        gate: { kind: 'entity_state', entity: 'Turret', state: 2 },
      },
      {
        id: 'phase3',
        title: 'Install',
        guideText: 'Install',
        showEntities: ['Player', 'CtaButton'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton', radius: 1.8 },
      },
    ],
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
  var repeatedSandbox = runHtmlScripts(buildSourceIrPreviewHtml(repeatedTargetIr, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
    includeThree: false,
  }));
  assert.ok(buildSourceIrPreviewHtml(normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: 'Attack state preview', theme: 'default' },
    scene: { ground: { kind: 'plane', size: [10, 10] } },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule' } },
      { id: 'Enemy', label: 'Enemy', kind: 'enemy', position: [3, 0, 0], visual: { primitive: 'box' } },
    ],
    phases: [{
      id: 'phase1',
      guideText: 'Attack enemy',
      showEntities: ['Player', 'Enemy'],
      steps: [{ kind: 'move_to', target: 'Enemy' }, { kind: 'attack', target: 'Enemy', state: 0 }],
      gate: { kind: 'entity_state', entity: 'Enemy', state: 0 },
    }],
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  }), {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
    includeThree: false,
  }).indexOf('requiredState <= 0 ? currentState <= requiredState') >= 0);
  var repeatedPhase1Target = repeatedTargetIr.phases[0].steps[0].target;
  var repeatedPhase2Target = repeatedTargetIr.phases[1].steps[0].target;
  assert.notStrictEqual(repeatedPhase1Target, repeatedPhase2Target);
  repeatedSandbox.window.__sourceIrPreviewModels.Player.position.x = repeatedSandbox.window.__sourceIrPreviewModels[repeatedPhase1Target].position.x;
  repeatedSandbox.window.__sourceIrPreviewModels.Player.position.z = repeatedSandbox.window.__sourceIrPreviewModels[repeatedPhase1Target].position.z;
  repeatedSandbox.window.__sourceIrPreviewSetJoystick(0.1, 0, true);
  var repeatedPhase2 = repeatedSandbox.window.__sourceIrPreviewRuntimeTick(.016);
  assert.strictEqual(repeatedPhase2.phase, 'phase2');
  assert.deepStrictEqual(Array.from(repeatedPhase2.completedPhases), ['phase1']);
  repeatedSandbox.window.__sourceIrPreviewModels.Player.position.x = repeatedSandbox.window.__sourceIrPreviewModels[repeatedPhase2Target].position.x;
  repeatedSandbox.window.__sourceIrPreviewModels.Player.position.z = repeatedSandbox.window.__sourceIrPreviewModels[repeatedPhase2Target].position.z;
  var noFreshInput = repeatedSandbox.window.__sourceIrPreviewRuntimeTick(.016);
  assert.strictEqual(noFreshInput.phase, 'phase2');
  assert.deepStrictEqual(Array.from(noFreshInput.completedPhases), ['phase1']);
  repeatedSandbox.window.__sourceIrPreviewSetJoystick(0.1, 0, true);
  var repeatedPhase3 = repeatedSandbox.window.__sourceIrPreviewRuntimeTick(.016);
  assert.strictEqual(repeatedPhase3.phase, 'phase3');
  assert.deepStrictEqual(Array.from(repeatedPhase3.completedPhases), ['phase1', 'phase2']);

  var continuousDragSandbox = runHtmlScripts(buildSourceIrPreviewHtml(repeatedTargetIr, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
    includeThree: false,
  }));
  continuousDragSandbox.window.__sourceIrPreviewModels.Player.position.x = continuousDragSandbox.window.__sourceIrPreviewModels[repeatedPhase1Target].position.x;
  continuousDragSandbox.window.__sourceIrPreviewModels.Player.position.z = continuousDragSandbox.window.__sourceIrPreviewModels[repeatedPhase1Target].position.z;
  dispatchDocumentEvent(continuousDragSandbox, 'pointerdown', { clientX: 100, clientY: 100 });
  dispatchDocumentEvent(continuousDragSandbox, 'pointermove', { clientX: 104, clientY: 100 });
  var dragPhase2 = continuousDragSandbox.window.__gameState();
  assert.strictEqual(dragPhase2.phase, 'phase2');
  assert.deepStrictEqual(Array.from(dragPhase2.completedPhases), ['phase1']);
  continuousDragSandbox.window.__sourceIrPreviewModels.Player.position.x = continuousDragSandbox.window.__sourceIrPreviewModels[repeatedPhase2Target].position.x;
  continuousDragSandbox.window.__sourceIrPreviewModels.Player.position.z = continuousDragSandbox.window.__sourceIrPreviewModels[repeatedPhase2Target].position.z;
  dispatchDocumentEvent(continuousDragSandbox, 'pointermove', { clientX: 132, clientY: 100 });
  var heldDragPhase = continuousDragSandbox.window.__gameState();
  assert.strictEqual(heldDragPhase.phase, 'phase2');
  assert.deepStrictEqual(Array.from(heldDragPhase.completedPhases), ['phase1']);
  dispatchDocumentEvent(continuousDragSandbox, 'pointerup', { clientX: 132, clientY: 100 });
  dispatchDocumentEvent(continuousDragSandbox, 'pointerdown', { clientX: 132, clientY: 100 });
  dispatchDocumentEvent(continuousDragSandbox, 'pointermove', { clientX: 136, clientY: 100 });
  var freshDragPhase = continuousDragSandbox.window.__gameState();
  assert.strictEqual(freshDragPhase.phase, 'phase3');
  assert.deepStrictEqual(Array.from(freshDragPhase.completedPhases), ['phase1', 'phase2']);

  var phase2 = await sandbox.window.__driveToSourcePhase(2);
  assert.strictEqual(phase2.phase, 'phase2');
  assert.deepStrictEqual(Array.from(phase2.completedPhases), ['phase1']);
  assert.strictEqual(phase2.ui_state.guideText, 'Go to install');
  assert.strictEqual(phase2.ui_state.ctaVisible, true);
  assert.strictEqual(phase2.resources.Water, 3);
  assert.strictEqual(phase2.entity_states.WaterDrop.visible, true);
  assert.strictEqual(phase2.entity_states.CtaButton, undefined);
  assert.notStrictEqual(sandbox.window.__sourceIrPreviewModels.WaterDrop.dom.style.display, 'none');
  assert.strictEqual(phase2.phaseEvidence.phase2.cta_finish.final_phase, true);
  assert.strictEqual(sandbox.document.__elements.tip.textContent, 'Go to install');
  assert.strictEqual(sandbox.document.__elements['source-ir-cta-overlay'].style.display, 'grid');
  assert.strictEqual(sandbox.document.__elements['source-ir-target-ring'].style.display, 'none');
  assert.strictEqual(sandbox.window.__fidelityReady, true);

  assert.throws(function() {
    sandbox.window.__sourceIrPreviewApplyPhase(99);
  }, /phase index out of range/);

  console.log('source IR preview renderer tests passed');
}

main().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
