#!/usr/bin/env node
'use strict';

// engine/stages/lib/anchor-extractor.cjs
//
// Lib used by scripts/migrate-v1.1-to-v1.2.cjs (and tests). Reverse-extracts
// per-phase screen-space anchors from a source Three.js HTML fixture via
// puppeteer + a Tier A constructor-proxy interceptor.
//
// Locked design surface: /root/.slock/agents/131d4ea0-d56a-406e-9cb3-f90999d73977/notes/v1.2-camera-transform-schema-draft.md (v6.1 triple sign-off).
//
// Persistence boundary (Jonny msg=0ec2b725 / Tim msg=52fe75ad):
//   The lib returns two persistence tiers per phase:
//     anchors[entityId]        — CONTRACT-shaped record. Keys ∈
//                                {x_px, y_px, w_px, h_px, depth_ndc?,
//                                 provenance, lookupPath?, matchedAlias?,
//                                 resolverRule?}. No visibility booleans.
//     nameResolution[]         — AUDIT row per (phase, entity) for migration
//                                report.
//     visibilityAudit[]        — AUDIT row per (phase, entity) carrying
//                                effectiveVisible / viewportIntersection /
//                                reason for migration report.
//
// API:
//   const extractor = require('./anchor-extractor.cjs');
//   const result = await extractor.extractFromSourceHtml({
//     sourceHtmlPath: '/path/to/source.html',
//     phases: [{ id: 'phase1', showEntities: ['Player', ...] }, ...],
//     entitiesCatalog: contract.entities,   // for catalog-alias resolver
//     viewportBaseline: { width: 1280, height: 720 }
//   });
//   // result = { 'phase1': { anchors, nameResolution, visibilityAudit }, ... }

var path = require('path');

// puppeteer-core is resolved through the same path the PoC used, so the lib
// works in the worker box without bundling.
function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (_) {
    return require('/usr/lib/node_modules/puppeteer-core');
  }
}

var CHROMIUM_BIN = process.env.SAM_CHROMIUM_BIN || '/usr/bin/chromium-browser';
var DEFAULT_VIEWPORT = { width: 1280, height: 720 };
var FIDELITY_READY_TIMEOUT_MS = 15000;
var PHASE_SETTLE_MS = 600;
var BOOT_SETTLE_MS = 800;

// ============================================================
// Tier A init script — injected via page.evaluateOnNewDocument BEFORE any
// page <script> runs. Object.defineProperty(window,'THREE') setter+getter
// dual install with readiness-guarded install on
// Scene/PerspectiveCamera/WebGLRenderer/Box3. Verbatim from PoC v6 which
// passed the hard gate on space-ranger-3d.html (8/8 cam+scene, 52/52
// extracted, 0 inferred).
// ============================================================
var TIER_A_INIT_SRC = `
(() => {
  const captured = { camera: null, scene: null, meshes: new Map(), renderer: null };
  window.__samAnchorProbe = captured;

  const wrap = (ctor, sink) => new Proxy(ctor, {
    construct(target, args, newTarget) {
      const inst = Reflect.construct(target, args, newTarget);
      try { sink(inst); } catch (_) { /* swallow */ }
      return inst;
    }
  });

  function install(v) {
    if (!v || v.__samAnchorPatched) return false;
    if (!v.Scene || !v.PerspectiveCamera || !v.WebGLRenderer || !v.Box3) return false;
    v.__samAnchorPatched = true;

    v.Scene              = wrap(v.Scene,             s => { if (!captured.scene) captured.scene = s; });
    v.PerspectiveCamera  = wrap(v.PerspectiveCamera, c => { if (!captured.camera) captured.camera = c; });
    v.OrthographicCamera = wrap(v.OrthographicCamera, c => { if (!captured.camera) captured.camera = c; });
    v.Mesh               = wrap(v.Mesh,              m => { if (m.name) captured.meshes.set(m.name, m); });
    v.Group              = wrap(v.Group,             g => { if (g.name) captured.meshes.set(g.name, g); });
    v.Sprite             = wrap(v.Sprite,            s => { if (s.name) captured.meshes.set(s.name, s); });

    v.WebGLRenderer = wrap(v.WebGLRenderer, (instance) => {
      if (!captured.renderer) captured.renderer = instance;
      const origRender = instance.render.bind(instance);
      instance.render = function(scene, camera) {
        if (!captured.scene) captured.scene = scene;
        if (!captured.camera) captured.camera = camera;
        return origRender(scene, camera);
      };
    });
    return true;
  }

  Object.defineProperty(window, 'THREE', {
    configurable: true,
    set(v) { this.__THREE = v; install(v); },
    get()  { install(this.__THREE); return this.__THREE; }
  });
})();
`;

// ============================================================
// In-page extractor — runs after __driveToPhase(n) settles. For each
// entityId in the phase, walks the 4-step resolver, runs Box3.setFromObject,
// projects 8 corners → NDC → viewport, returns { anchors, nameResolution,
// visibilityAudit }. Visibility booleans live in visibilityAudit only,
// NEVER in anchors.
// ============================================================
function inPageExtractor(phaseId, entityIds, viewportW, viewportH, fixtureEntities) {
  var probe = window.__samAnchorProbe;
  if (!probe || !probe.camera || !probe.scene) {
    return {
      phaseId: phaseId,
      error: 'no-camera-or-scene',
      cameraCaptured: !!(probe && probe.camera),
      sceneCaptured: !!(probe && probe.scene),
      anchors: {},
      nameResolution: [],
      visibilityAudit: []
    };
  }
  var T = window.__THREE || window.THREE;
  if (!T || !T.Box3 || !T.Vector3) {
    return { phaseId: phaseId, error: 'no-THREE-Box3-Vector3', anchors: {}, nameResolution: [], visibilityAudit: [] };
  }

  var cam = probe.camera;
  try { cam.updateMatrixWorld(true); } catch (_) {}

  function lookup(name) {
    if (!name) return null;
    var fromReg = probe.meshes.get(name);
    if (fromReg) return { obj: fromReg, lookupPath: 'meshes', alias: name };
    var fromScene = probe.scene.getObjectByName(name);
    if (fromScene) return { obj: fromScene, lookupPath: 'scene.getObjectByName', alias: name };
    return null;
  }

  function resolveContractEntity(contractId) {
    // step 1: direct
    var direct = lookup(contractId);
    if (direct) return Object.assign({}, direct, { resolverRule: 'direct' });

    // step 2: catalog alias
    if (Array.isArray(fixtureEntities)) {
      for (var i = 0; i < fixtureEntities.length; i++) {
        var e = fixtureEntities[i];
        if (!e || !e.parentPath) continue;
        var parts = String(e.parentPath).split('/').filter(function(s) { return s.length > 0; });
        var base = parts.length ? parts[parts.length - 1] : '';
        if (base === contractId) {
          var alias = e.name || e.id;
          var hit = lookup(alias);
          if (hit) return Object.assign({}, hit, { resolverRule: 'catalog-alias' });
        }
      }
    }

    // step 3: convention
    var noUnder = contractId.replace(/^_+/, '');
    var cap = noUnder.charAt(0).toUpperCase() + noUnder.slice(1);
    var hitCap = lookup(cap);
    if (hitCap) return Object.assign({}, hitCap, { resolverRule: 'convention' });
    var pascal = noUnder.split('_').filter(function(s) { return s.length > 0; })
      .map(function(s) { return s.charAt(0).toUpperCase() + s.slice(1); }).join('');
    if (pascal && pascal !== cap) {
      var hitPascal = lookup(pascal);
      if (hitPascal) return Object.assign({}, hitPascal, { resolverRule: 'convention' });
    }

    // step 4: unresolved
    return { obj: null, lookupPath: 'not-found', alias: null, resolverRule: 'unresolved' };
  }

  var anchors = {};
  var nameResolution = [];
  var visibilityAudit = [];

  for (var k = 0; k < entityIds.length; k++) {
    var id = entityIds[k];
    var r = resolveContractEntity(id);
    var obj = r.obj;
    var lookupPath = r.lookupPath;
    var matchedAlias = r.alias;
    var resolverRule = r.resolverRule;

    nameResolution.push({
      phaseId: phaseId,
      contractId: id,
      sourceName: matchedAlias,
      resolverRule: resolverRule
    });

    if (!obj) {
      anchors[id] = {
        x_px: 0, y_px: 0, w_px: 0, h_px: 0,
        provenance: 'inferred-default',
        lookupPath: lookupPath, matchedAlias: matchedAlias, resolverRule: resolverRule
      };
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: false, viewportIntersection: false,
        reason: 'unresolved'
      });
      continue;
    }

    // Option C visibility audit (Jonny msg=cb73d30c) — stays in visibilityAudit[]
    // only. NEVER written into the anchor contract record.
    var selfVisible = !!obj.visible;
    var effectiveVisible = selfVisible;
    var parent = obj.parent;
    while (parent) {
      if (!parent.visible) effectiveVisible = false;
      parent = parent.parent;
    }
    if (!effectiveVisible) {
      anchors[id] = {
        x_px: 0, y_px: 0, w_px: 0, h_px: 0,
        provenance: 'inferred-default',
        lookupPath: lookupPath, matchedAlias: matchedAlias, resolverRule: resolverRule
      };
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: false, viewportIntersection: false,
        reason: 'source-not-visible'
      });
      continue;
    }
    try { obj.updateMatrixWorld(true); } catch (_) {}

    var box = new T.Box3();
    box.setFromObject(obj);
    var derivedViewportIntersection = false;
    if (box.isEmpty()) {
      // anchor-only fallback (label / no-mesh entity)
      var wp = new T.Vector3();
      obj.getWorldPosition(wp);
      wp.project(cam);
      var x_anchor = (wp.x * 0.5 + 0.5) * viewportW;
      var y_anchor = (1 - (wp.y * 0.5 + 0.5)) * viewportH;
      derivedViewportIntersection = (x_anchor >= 0 && x_anchor <= viewportW && y_anchor >= 0 && y_anchor <= viewportH);
      anchors[id] = {
        x_px: Math.round(x_anchor * 100) / 100,
        y_px: Math.round(y_anchor * 100) / 100,
        w_px: 0,
        h_px: 0,
        depth_ndc: Math.round(wp.z * 1000) / 1000,
        provenance: 'anchor-only',
        lookupPath: lookupPath, matchedAlias: matchedAlias, resolverRule: resolverRule
      };
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: true, viewportIntersection: derivedViewportIntersection
      });
      continue;
    }

    // Project 8 corners
    var corners = [
      new T.Vector3(box.min.x, box.min.y, box.min.z),
      new T.Vector3(box.min.x, box.min.y, box.max.z),
      new T.Vector3(box.min.x, box.max.y, box.min.z),
      new T.Vector3(box.min.x, box.max.y, box.max.z),
      new T.Vector3(box.max.x, box.min.y, box.min.z),
      new T.Vector3(box.max.x, box.min.y, box.max.z),
      new T.Vector3(box.max.x, box.max.y, box.min.z),
      new T.Vector3(box.max.x, box.max.y, box.max.z)
    ];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var zSum = 0;
    for (var c = 0; c < corners.length; c++) {
      var v = corners[c];
      v.project(cam);
      var px = (v.x * 0.5 + 0.5) * viewportW;
      var py = (1 - (v.y * 0.5 + 0.5)) * viewportH;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      zSum += v.z;
    }
    // Tim bbox-rect ∩ viewport-rect formula — viewportIntersection lives in
    // audit only, NEVER in anchors[id].
    derivedViewportIntersection = (maxX >= 0 && minX <= viewportW && maxY >= 0 && minY <= viewportH);

    anchors[id] = {
      x_px: Math.round(minX * 100) / 100,
      y_px: Math.round(minY * 100) / 100,
      w_px: Math.round((maxX - minX) * 100) / 100,
      h_px: Math.round((maxY - minY) * 100) / 100,
      depth_ndc: Math.round((zSum / 8) * 1000) / 1000,
      provenance: 'extracted',
      lookupPath: lookupPath, matchedAlias: matchedAlias, resolverRule: resolverRule
    };
    visibilityAudit.push({
      phaseId: phaseId, contractId: id,
      effectiveVisible: true, viewportIntersection: derivedViewportIntersection
    });
  }

  return {
    phaseId: phaseId,
    cameraCaptured: true,
    sceneCaptured: true,
    meshesRegistrySize: probe.meshes.size,
    anchors: anchors,
    nameResolution: nameResolution,
    visibilityAudit: visibilityAudit
  };
}

async function extractFromSourceHtml(opts) {
  if (!opts || typeof opts !== 'object') throw new Error('opts required');
  if (!opts.sourceHtmlPath) throw new Error('opts.sourceHtmlPath required');
  if (!Array.isArray(opts.phases)) throw new Error('opts.phases array required');

  var puppeteer = loadPuppeteer();
  var viewport = opts.viewportBaseline || DEFAULT_VIEWPORT;
  var entitiesCatalog = Array.isArray(opts.entitiesCatalog) ? opts.entitiesCatalog : [];
  var sourceHtmlAbs = path.resolve(opts.sourceHtmlPath);

  var browser = await puppeteer.launch({
    executablePath: CHROMIUM_BIN,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-webgl']
  });

  var output = {};
  try {
    var page = await browser.newPage();
    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(TIER_A_INIT_SRC);
    await page.goto('file://' + sourceHtmlAbs, { waitUntil: 'load', timeout: 30000 });

    try {
      await page.waitForFunction(function() { return !!window.__fidelityReady; }, { timeout: FIDELITY_READY_TIMEOUT_MS });
    } catch (_) {
      // continue — probe may still have data even if __fidelityReady didn't flip
    }
    await new Promise(function(resolve) { setTimeout(resolve, BOOT_SETTLE_MS); });

    var extractFnSrc = inPageExtractor.toString();

    for (var i = 0; i < opts.phases.length; i++) {
      var phase = opts.phases[i];
      var phaseNum = parseInt(String(phase.id).replace(/^phase/, ''), 10);
      if (!isFinite(phaseNum)) phaseNum = i + 1;

      try {
        await page.evaluate(function(n) { return window.__driveToPhase ? window.__driveToPhase(n) : null; }, phaseNum);
      } catch (_) { /* swallow drive errors — continue */ }
      await new Promise(function(resolve) { setTimeout(resolve, PHASE_SETTLE_MS); });

      var args = [
        JSON.stringify(phase.id),
        JSON.stringify(phase.showEntities || []),
        String(viewport.width),
        String(viewport.height),
        JSON.stringify(entitiesCatalog)
      ].join(', ');
      var result = await page.evaluate('(' + extractFnSrc + ')(' + args + ')');
      output[phase.id] = result;
    }

    await page.close();
  } finally {
    await browser.close();
  }

  return output;
}

module.exports = {
  extractFromSourceHtml: extractFromSourceHtml,
  // Exported for tests
  TIER_A_INIT_SRC: TIER_A_INIT_SRC,
  inPageExtractor: inPageExtractor
};
