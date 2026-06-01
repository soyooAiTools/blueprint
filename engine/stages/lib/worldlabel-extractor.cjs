#!/usr/bin/env node
'use strict';

// engine/stages/lib/worldlabel-extractor.cjs
//
// Lib used by scripts/migrate-v1.4d-to-v1.4e.cjs (and tests). Reverse-extracts
// per-phase per-entity world-label screen-space rects from a source Three.js
// HTML fixture via puppeteer + the same Tier A constructor-proxy interceptor
// used by anchor-extractor.cjs.
//
// Interface lock (Jonny msg=fd1a7e7a, task #56 thread):
//   phases[].projectedWorldLabels[entityId] = {
//     x, y, width, height, centerX, centerY   // 1280x720 top-left px
//   }
//   window.__targetWorldLabels[entityId] = { text, x, y, width, height,
//                                            centerX, centerY, visible }
//
// Persistence boundary mirrors v1.2 anchor-extractor (Sam triple sign-off):
//   worldLabels[entityId]    — CONTRACT-shaped record. Keys ∈
//                              {x, y, width, height, centerX, centerY,
//                               provenance, lookupPath?, matchedAlias?,
//                               resolverRule?}. No visibility booleans.
//   nameResolution[]         — AUDIT row per (phase, entity) for report.
//   visibilityAudit[]        — AUDIT row per (phase, entity) for report.
//
// API:
//   const ext = require('./worldlabel-extractor.cjs');
//   const result = await ext.extractFromSourceHtml({
//     sourceHtmlPath, phases, entitiesCatalog, viewportBaseline
//   });
//   // result = { 'phase1': { worldLabels, nameResolution, visibilityAudit }, ... }

var path = require('path');

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

// Tier A init — identical contract to anchor-extractor.cjs so a single
// page.evaluateOnNewDocument call works for both libs when chained.
// Duplicated verbatim here so this lib is standalone-runnable.
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
// entityId in the phase, walks the same 4-step resolver as anchor-extractor
// to find the entity Group, then walks Group children to find the Sprite
// label child. Computes billboard quad world corners from sprite world
// position + camera right/up basis vectors, projects each to NDC →
// viewport, returns axis-aligned screen-space bounding rect.
// ============================================================
function inPageWorldLabelExtractor(phaseId, entityIds, viewportW, viewportH, fixtureEntities) {
  var probe = window.__samAnchorProbe;
  if (!probe || !probe.camera || !probe.scene) {
    return {
      phaseId: phaseId,
      error: 'no-camera-or-scene',
      cameraCaptured: !!(probe && probe.camera),
      sceneCaptured: !!(probe && probe.scene),
      worldLabels: {},
      nameResolution: [],
      visibilityAudit: []
    };
  }
  var T = window.__THREE || window.THREE;
  if (!T || !T.Vector3) {
    return { phaseId: phaseId, error: 'no-THREE-Vector3', worldLabels: {}, nameResolution: [], visibilityAudit: [] };
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
    var direct = lookup(contractId);
    if (direct) return Object.assign({}, direct, { resolverRule: 'direct' });

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

    return { obj: null, lookupPath: 'not-found', alias: null, resolverRule: 'unresolved' };
  }

  // Walk children to find the Sprite label child. Generic — does not depend
  // on a specific source-html builder convention (e.g. global `labels` map).
  // Depth-first one level then descends, since labels are typically a direct
  // child of the entity Group; deeper walks cover composite mesh fixtures.
  function findSpriteChild(node) {
    if (!node || !node.children) return null;
    for (var i = 0; i < node.children.length; i++) {
      var ch = node.children[i];
      if (ch && ch.isSprite) return ch;
    }
    for (var j = 0; j < node.children.length; j++) {
      var sub = findSpriteChild(node.children[j]);
      if (sub) return sub;
    }
    return null;
  }

  var R2 = function(v) { return Math.round(v * 100) / 100; };

  function emptyRecord(provenance, lookupPath, matchedAlias, resolverRule) {
    return {
      x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0,
      provenance: provenance,
      lookupPath: lookupPath, matchedAlias: matchedAlias, resolverRule: resolverRule
    };
  }

  var worldLabels = {};
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
      worldLabels[id] = emptyRecord('inferred-default', lookupPath, matchedAlias, resolverRule);
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: false, viewportIntersection: false,
        hasSprite: false, reason: 'unresolved'
      });
      continue;
    }

    var selfVisible = !!obj.visible;
    var effectiveVisible = selfVisible;
    var parent = obj.parent;
    while (parent) {
      if (!parent.visible) effectiveVisible = false;
      parent = parent.parent;
    }
    if (!effectiveVisible) {
      worldLabels[id] = emptyRecord('inferred-default', lookupPath, matchedAlias, resolverRule);
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: false, viewportIntersection: false,
        hasSprite: false, reason: 'source-not-visible'
      });
      continue;
    }

    try { obj.updateMatrixWorld(true); } catch (_) {}

    var sprite = findSpriteChild(obj);
    if (!sprite) {
      worldLabels[id] = emptyRecord('no-label', lookupPath, matchedAlias, resolverRule);
      visibilityAudit.push({
        phaseId: phaseId, contractId: id,
        effectiveVisible: true, viewportIntersection: false,
        hasSprite: false, reason: 'no-sprite-child'
      });
      continue;
    }
    try { sprite.updateMatrixWorld(true); } catch (_) {}

    // Three.js Sprite billboard math:
    // - sprite world position = (parent group world matrix) * sprite.position
    // - quad corners in world space lie in the screen-aligned plane through
    //   sprite world position, sized by sprite.scale.x/y in world units
    // - corner = world_pos + camRight * scale.x/2 * sx + camUp * scale.y/2 * sy
    //   for (sx, sy) in { -1, 1 } × { -1, 1 }
    // - project each corner to NDC via cam.project(), then to viewport px
    var spriteWorld = new T.Vector3();
    sprite.getWorldPosition(spriteWorld);

    var camRight = new T.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    var camUp = new T.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);

    var hw = (sprite.scale.x || 0) * 0.5;
    var hh = (sprite.scale.y || 0) * 0.5;

    var corners = [
      spriteWorld.clone().addScaledVector(camRight, -hw).addScaledVector(camUp, -hh),
      spriteWorld.clone().addScaledVector(camRight,  hw).addScaledVector(camUp, -hh),
      spriteWorld.clone().addScaledVector(camRight, -hw).addScaledVector(camUp,  hh),
      spriteWorld.clone().addScaledVector(camRight,  hw).addScaledVector(camUp,  hh)
    ];

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var c = 0; c < corners.length; c++) {
      var v = corners[c];
      v.project(cam);
      var px = (v.x * 0.5 + 0.5) * viewportW;
      var py = (1 - (v.y * 0.5 + 0.5)) * viewportH;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }

    var w = maxX - minX;
    var h = maxY - minY;
    var cx = minX + w * 0.5;
    var cy = minY + h * 0.5;

    var derivedViewportIntersection =
      (maxX >= 0 && minX <= viewportW && maxY >= 0 && minY <= viewportH);

    worldLabels[id] = {
      x: R2(minX),
      y: R2(minY),
      width: R2(w),
      height: R2(h),
      centerX: R2(cx),
      centerY: R2(cy),
      provenance: 'extracted',
      lookupPath: lookupPath,
      matchedAlias: matchedAlias,
      resolverRule: resolverRule
    };
    visibilityAudit.push({
      phaseId: phaseId, contractId: id,
      effectiveVisible: true, viewportIntersection: derivedViewportIntersection,
      hasSprite: true
    });
  }

  return {
    phaseId: phaseId,
    cameraCaptured: true,
    sceneCaptured: true,
    meshesRegistrySize: probe.meshes.size,
    worldLabels: worldLabels,
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

    var extractFnSrc = inPageWorldLabelExtractor.toString();

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
  TIER_A_INIT_SRC: TIER_A_INIT_SRC,
  inPageWorldLabelExtractor: inPageWorldLabelExtractor
};
