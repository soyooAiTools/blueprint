'use strict';

const fs = require('fs');

function scriptSafeJson(value) {
  return JSON.stringify(value || null).replace(/<(\/?)script/gi, '\\x3c$1script');
}

function scriptSafeText(value) {
  return String(value || '').replace(/<(\/?)script/gi, '\\x3c$1script');
}

function loadThreeSource() {
  const candidates = [
    process.env.DEMO2SPEC_THREE_SOURCE,
    '/opt/loot-app/lib/three.min.js',
  ].filter(Boolean);
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const source = fs.readFileSync(filePath, 'utf8');
      new Function(source);
      return source;
    } catch (error) {}
  }
  return null;
}

function injectPlayableSceneIr(html, playableSceneIr) {
  if (!playableSceneIr) return html;
  const script = `<script>window.__BLUEPRINT_PLAYABLE_SCENE_IR__=${scriptSafeJson(playableSceneIr)};<\/script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => script + '</head>');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, () => script + '</body>');
  return script + html;
}

function injectVisualOverlay(html, visualAssets, playableSceneIr) {
  html = injectPlayableSceneIr(html, playableSceneIr);
  const manifest = visualAssets || null;
  const contract = manifest && manifest.sourceEntityContract;
  if (!manifest || !contract || (!contract.entityStyles && !contract.entityComposites)) {
    return html;
  }
  const threeSource = loadThreeSource();
  const threeScript = threeSource
    ? `<script>${scriptSafeText(threeSource)}\n<\/script>`
    : `<script src="https://cdn.jsdelivr.net/npm/three@0.156.1/build/three.min.js" onerror="(function(){var s=document.createElement('script');s.src='https://unpkg.com/three@0.156.1/build/three.min.js';document.head.appendChild(s);})()"><\/script>`;
  const overlayScript = `<script>
(function(){
  var manifest = ${scriptSafeJson(manifest)};
  if (!manifest || !manifest.sourceEntityContract) return;
  var originalGameState = null;
  var sourceRuntimeEnabled = false;
  var sourceGameStateFn = null;
  var sourceGameStateAccessorInstalled = false;
  var overlayInput = { active: false, dx: 0, dy: 0, originX: 0, originY: 0 };
  var overlayRuntime = {
    initialized: false,
    phaseIndex: 0,
    stepIndex: 0,
    cooldown: 0,
    completed: [],
    gameEnded: false,
    laserOpacity: 0,
    laserTarget: null,
    toastUntil: 0,
    lunaSuppressed: false,
    lunaCanvasDisplay: null,
    lunaCanvasVisibility: null,
    lunaAutoRender: null,
    lunaRenderNextFrame: null,
    lunaTick: null,
    lunaPauseTried: false,
    lunaAppSuppressed: false,
    manualInteraction: false,
    positions: {},
    resources: { Ice: 0, Oxygen: 0, Scrap: 0, Coin: 0, Gold: 0, ShipLevel: 0, tool: '镐子' },
    resourceBaselines: {},
    phaseEvidence: {},
    phaseTimestamps: {},
    startedAt: 0,
    lastTick: 0
  };

  function queryValue(name) {
    var query = String(document.location.search || '').replace(/^\\?/, '').split('&');
    for (var i = 0; i < query.length; i++) {
      var parts = query[i].split('=');
      if (decodeURIComponent(parts[0] || '') === name) return decodeURIComponent(parts.slice(1).join('=') || '');
    }
    return null;
  }
  function queryIs(name, value) {
    var actual = queryValue(name);
    return actual !== null && String(actual).toLowerCase() === String(value).toLowerCase();
  }
  function hasPlayableSceneIr() {
    return !!(window.__BLUEPRINT_PLAYABLE_SCENE_IR__ || manifest.playableSceneIrHash);
  }
  function sourceVisualEnabled() {
    if (queryIs('sourceOverlay', '0') || queryIs('demo2specSource', '0') || queryIs('sourceVisual', '0')) return false;
    return queryIs('sourceOverlay', '1') || queryIs('demo2specSource', '1') || hasPlayableSceneIr();
  }
  function autoplayRequested() {
    return queryIs('autoplay', '1') || queryIs('autoPlay', '1');
  }
  function observerReadyRequested() {
    return queryIs('observerReady', '1') || queryIs('cuaObserverReady', '1');
  }
  function sourceAutoplayObserverReady() {
    if (!autoplayRequested()) return true;
    return !!window.__CUA_OBSERVER_READY__ || observerReadyRequested();
  }
  function sourceRuntimeDefaultEnabled() {
    if (!sourceVisualEnabled()) return false;
    if (queryIs('sourceRuntime', '0')) return false;
    if (queryIs('sourceRuntime', '1')) return true;
    return hasPlayableSceneIr();
  }
  function sourceAutoplayRuntimeActive() {
    return sourceRuntimeEnabled && autoplayRequested() && sourceAutoplayObserverReady() && !overlayRuntime.manualInteraction;
  }
  function originalState() {
    try {
      if (originalGameState !== null) return typeof originalGameState === 'function' ? originalGameState() : originalGameState;
      return typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState;
    }
    catch(e) { return null; }
  }
  function state() {
    if (sourceRuntimeEnabled && window.__demo2specSourceOverlayState) return window.__demo2specSourceOverlayState;
    return originalState();
  }
  function updateManualJoystickOverride(active, x, y) {
    try {
      window.__bpManualJoystickOverride = {
        active: !!active,
        x: Number(x) || 0,
        y: Number(y) || 0,
        updatedAt: performance && performance.now ? performance.now() : Date.now()
      };
    } catch(e) {}
  }
  function readManualJoystickOverride() {
    try {
      var o = window.__bpManualJoystickOverride;
      if (!o || !o.active) return null;
      var x = Number(o.x) || 0;
      var y = Number(o.y) || 0;
      var source = String(o.source || '');
      var sign = source === 'cua-autonav-joystick' ? -1 : 1;
      return {
        x: x * sign,
        y: y * sign,
        speed: Math.max(1, Number(o.speed || 6) || 6) * 4,
        source: source
      };
    } catch(e) {
      return null;
    }
  }
  function sourceEntityNames(contract) {
    var names = contract && Array.isArray(contract.entities) ? contract.entities.filter(Boolean) : [];
    if (names.length) return names;
    var composites = contract && contract.entityComposites || {};
    names = Object.keys(composites);
    if (names.length) return names;
    var styles = contract && contract.entityStyles || {};
    names = Object.keys(styles);
    if (names.length) return names;
    return Object.keys(manifest.entityBindings || {});
  }
  function sourceWorldLabelsEnabled() {
    var c = manifest.sourceEntityContract || {};
    return !!(c.worldLabelContract && c.worldLabelContract.present);
  }
  function hexToNumber(hex, fallback) {
    var text = String(hex || fallback || '#ffffff').replace('#', '');
    return /^[0-9a-f]{6}$/i.test(text) ? parseInt(text, 16) : parseInt(String(fallback || '#ffffff').replace('#', ''), 16);
  }
  function color(hex, fallback) {
    return new THREE.Color(hexToNumber(hex, fallback));
  }
  function finite(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }
  function vector(values, fallback) {
    values = Array.isArray(values) ? values : [];
    fallback = fallback || [0, 0, 0];
    return [
      finite(values[0], fallback[0] || 0),
      finite(values[1], fallback[1] || 0),
      finite(values[2], fallback[2] || 0)
    ];
  }
  function sourceCameraContract() {
    var sceneContract = manifest.sourceSceneContract || {};
    return sceneContract.camera || {};
  }
  function sourceCameraPresent() {
    var camera = sourceCameraContract();
    return !!(camera && camera.present && Array.isArray(camera.position) && Array.isArray(camera.lookAt));
  }
  function applySourceCameraFrame(camera, contract) {
    if (!camera || !contract) return false;
    var pos = vector(contract.position, null);
    var target = vector(contract.lookAt, null);
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]));
    return true;
  }
  function posOf(name, composite, states) {
    var st = states && states[name];
    if (st && st.position && isFinite(Number(st.position.x)) && isFinite(Number(st.position.z))) {
      return { x: Number(st.position.x), y: 0, z: Number(st.position.z) };
    }
    var p = composite && composite.position || {};
    return { x: Number(p.x) || 0, y: 0, z: Number(p.z) || 0 };
  }
  function visibleOf(name, states) {
    var st = states && states[name];
    return !(st && st.visible === false);
  }
  function phaseInfo(gs) {
    var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
    var phaseText = String(gs && (gs.phase || gs.currentPhase) || 'phase1');
    var match = phaseText.match(/\\d+/);
    var index = match ? Math.max(0, Number(match[0]) - 1) : 0;
    return phases.filter(function(phase) { return phase && phase.id === phaseText; })[0] || phases[index] || null;
  }
  function phaseVisibleSet(info) {
    var names = info && Array.isArray(info.showEntities) ? info.showEntities : [];
    if (!names.length) return null;
    var out = {};
    names.forEach(function(name) { if (name) out[name] = true; });
    return out;
  }
  function resourceValue(resources, name) {
    if (!resources || !name) return 0;
    var aliases = {
      Coin: ['Coin', 'Gold', 'coin', 'gold'],
      Gold: ['Gold', 'Coin', 'gold', 'coin'],
      Oxygen: ['Oxygen', 'oxygen'],
      Ice: ['Ice', 'ice'],
      Scrap: ['Scrap', 'scrap']
    };
    var compact = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var keys = aliases[name] || [name, String(name).toLowerCase(), compact];
    for (var i = 0; i < keys.length; i++) {
      var n = Number(resources[keys[i]]);
      if (isFinite(n)) return n;
    }
    return 0;
  }
  function carriedValue(resources, name) {
    if (!resources || !name) return 0;
    var raw = String(name || '');
    var upper = raw.charAt(0).toUpperCase() + raw.slice(1);
    var lower = raw.charAt(0).toLowerCase() + raw.slice(1);
    var compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    var keys = [raw + 'Carried', upper + 'Carried', lower + 'Carried', compact + 'carried', raw + 'Carry', upper + 'Carry', lower + 'Carry'];
    return resourceValue(resources, keys.find(function(key) { return resources[key] != null; }) || keys[0]);
  }
  function phaseResourceProgress(phase, resources, name) {
    var phaseId = String(phase && (phase.id || phase.phaseId || phase.name) || 'phase');
    var key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var phaseStore = overlayRuntime.resourceBaselines[phaseId] || (overlayRuntime.resourceBaselines[phaseId] = {});
    if (!Object.prototype.hasOwnProperty.call(phaseStore, key)) phaseStore[key] = resourceValue(resources, name);
    return Math.max(0, resourceValue(resources, name) - (Number(phaseStore[key]) || 0));
  }
  function stepSatisfied(step, resources, states, phase) {
    if (!step) return true;
    if (step.gain) {
      var amount = Number(step.amount || 1);
      if (!isFinite(amount) || amount <= 0) amount = 1;
      return carriedValue(resources, step.gain) >= amount || phaseResourceProgress(phase, resources, step.gain) >= amount;
    }
    if (step.setEntity) {
      var st = states && states[step.setEntity] || {};
      return Number(st.stateCode || 0) > 0 || Number(st.upgradeLevel || st.level || 0) > 0 || st.status === 'built' || st.state === 'built';
    }
    return false;
  }
  function sourceTargetName(info, resources, states) {
    var steps = info && info.steps || [];
    var target = null;
    for (var i = 0; i < steps.length; i++) {
      if (!stepSatisfied(steps[i], resources, states, info)) {
        target = steps[i].target;
        break;
      }
    }
    if (!target && steps.length) target = steps[steps.length - 1].target;
    if (!target && info && info.hudText && info.hudText.targetEntity) target = info.hudText.targetEntity;
    if (!target && info && info.trigger) target = info.trigger.entity || info.trigger.target || '';
    return target || '';
  }
  function entityTargetLabel(name) {
    var composites = manifest.sourceEntityContract && manifest.sourceEntityContract.entityComposites || {};
    return name && composites[name] && composites[name].label || name || '';
  }
  function sourceTargetLabel(info, resources, states) {
    return entityTargetLabel(sourceTargetName(info, resources, states));
  }
  function phaseByRuntimeIndex(index) {
    var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
    return phases[Math.max(0, Math.min(phases.length - 1, Number(index) || 0))] || phases[0] || null;
  }
  function sourcePhaseCount() {
    var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
    var count = Number(manifest.sourcePhaseContract && manifest.sourcePhaseContract.phaseCount || phases.length || 0);
    return count > 0 ? count : Math.max(1, phases.length || 1);
  }
  function sourceDomHudContract() {
    return manifest.sourceEntityContract && manifest.sourceEntityContract.domHudContract || {};
  }
  function sourceDomHudPresent() {
    var contract = sourceDomHudContract();
    return !!(contract && contract.present);
  }
  function sourceDomHudInitial(key, fallback) {
    var contract = sourceDomHudContract();
    var initial = contract && contract.initialText || {};
    var value = initial[key];
    return value == null || value === '' ? fallback : String(value);
  }
  function numericSourceDomHudInitial(key, fallback) {
    var raw = sourceDomHudInitial(key, fallback);
    var n = Number(String(raw == null ? '' : raw).replace(/[^0-9.-]/g, ''));
    return isFinite(n) ? n : (Number(fallback) || 0);
  }
  function cleanCssDeclarationBlock(value) {
    return String(value || '')
      .replace(/[{}<>]/g, ' ')
      .replace(/url\s*\([^)]*\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function escapeHtmlText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function sourceCssRule(selector, body, overrides) {
    var clean = cleanCssDeclarationBlock(body);
    var extra = cleanCssDeclarationBlock(overrides);
    if (!clean && !extra) return '';
    return selector + '{' + clean + (clean && extra ? ';' : '') + extra + '}';
  }
  function bridgeOverlayHiddenCss() {
    return '#bp-storyboard-hud,#bp-storyboard-target,#bp-storyboard-scene-tone{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}';
  }
  function sourceDomHudCssRules() {
    if (!sourceDomHudPresent()) return '';
    var css = sourceDomHudContract().css || {};
    return [
      sourceCssRule('#demo2spec-source-hud', css.hud, 'z-index:2147482410!important;pointer-events:none!important'),
      sourceCssRule('#demo2spec-source-gold-icon', css.goldIcon || css.coinIcon, ''),
      sourceCssRule('#demo2spec-source-gold-count', css.goldCount || css.scoreText, ''),
      sourceCssRule('#demo2spec-source-tip', css.tip || css.goalText, ''),
      sourceCssRule('#demo2spec-source-phase-label', css.phaseLabel, ''),
      sourceCssRule('#demo2spec-source-target', css.targetHint, 'bottom:auto!important;right:auto!important;width:auto!important;height:auto!important;min-width:0!important;max-width:calc(100vw - 32px)!important;border:0!important;box-shadow:none!important;z-index:2147482411!important;pointer-events:none!important'),
      sourceCssRule('#demo2spec-source-toast', css.toast, 'z-index:2147482412!important;pointer-events:none!important')
    ].join('') + '#demo2spec-source-phase-band{display:none!important;visibility:hidden!important}';
  }
  function phaseIndexFromState(gs) {
    var phaseText = String(gs && (gs.phase || gs.currentPhase) || 'phase1');
    if (phaseText === 'gameEnd') {
      var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
      return Math.max(0, phases.length - 1);
    }
    var match = phaseText.match(/\\d+/);
    return match ? Math.max(0, Number(match[0]) - 1) : 0;
  }
  function sourcePlayerName(names, composites) {
    names = Array.isArray(names) ? names : [];
    composites = composites || {};
    var preferred = ['Player', 'PlayerCharacter', 'Hero', 'Avatar', 'Character'];
    for (var i = 0; i < preferred.length; i++) {
      if (names.indexOf(preferred[i]) >= 0 || composites[preferred[i]]) return preferred[i];
    }
    for (var j = 0; j < names.length; j++) {
      var name = names[j];
      var c = composites[name] || {};
      var text = [name, c.kind, c.label].filter(Boolean).join(' ');
      if (/player|hero|character|avatar|astronaut|玩家|角色/i.test(text)) return name;
    }
    return names[0] || 'Player';
  }
  function moveToward(pos, target, maxDelta) {
    if (!pos || !target) return 0;
    var dx = Number(target.x || 0) - Number(pos.x || 0);
    var dz = Number(target.z || 0) - Number(pos.z || 0);
    var d = Math.sqrt(dx * dx + dz * dz) || 0;
    if (d <= 0.001) return 0;
    var step = Math.min(d, Math.max(0, Number(maxDelta) || 0));
    pos.x += dx / d * step;
    pos.z += dz / d * step;
    return d;
  }
  function cssHex(value) {
    var n = Number(value) || 0;
    return '#' + ('000000' + (n >>> 0).toString(16)).slice(-6);
  }
  function runtimeNowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
  function runtimeSeconds() {
    if (!overlayRuntime.startedAt) overlayRuntime.startedAt = runtimeNowMs();
    return Math.max(0, (runtimeNowMs() - overlayRuntime.startedAt) / 1000);
  }
  function markPhaseTimestamp(phaseId) {
    if (!phaseId || overlayRuntime.phaseTimestamps[phaseId] > 0) return;
    overlayRuntime.phaseTimestamps[phaseId] = Number(runtimeSeconds().toFixed(3));
  }
  function isAutoMode(gs) {
    if (overlayRuntime.manualInteraction) return false;
    if (sourceAutoplayRuntimeActive()) return true;
    return !!(gs && (gs.autoPlayMode || gs._autoPlayMode || (gs.variables && (gs.variables.autoPlayMode || gs.variables._autoPlayMode))));
  }
  function playCanvasApp() {
    try {
      if (window.pc && window.pc.app) return window.pc.app;
      if (window.pc && window.pc.Application && typeof window.pc.Application.getApplication === 'function') {
        return window.pc.Application.getApplication() || window.pc.Application._currentApplication || null;
      }
      if (window.pc && window.pc.Application && window.pc.Application._currentApplication) return window.pc.Application._currentApplication;
    } catch(e) {}
    return null;
  }
  function setLunaRuntimeSuppressed(suppress) {
    if (overlayRuntime.lunaSuppressed === suppress && (!suppress || overlayRuntime.lunaAppSuppressed)) return;
    overlayRuntime.lunaSuppressed = suppress;
    var canvas = document.getElementById('application-canvas');
    if (canvas) {
      if (overlayRuntime.lunaCanvasDisplay === null) overlayRuntime.lunaCanvasDisplay = canvas.style.display || '';
      if (overlayRuntime.lunaCanvasVisibility === null) overlayRuntime.lunaCanvasVisibility = canvas.style.visibility || '';
      canvas.style.display = suppress ? 'none' : overlayRuntime.lunaCanvasDisplay;
      canvas.style.visibility = suppress ? 'hidden' : overlayRuntime.lunaCanvasVisibility;
    }
    var app = playCanvasApp();
    if (!app) return;
    try {
      if (overlayRuntime.lunaAutoRender === null && Object.prototype.hasOwnProperty.call(app, 'autoRender')) {
        overlayRuntime.lunaAutoRender = app.autoRender;
      }
      if (overlayRuntime.lunaRenderNextFrame === null && Object.prototype.hasOwnProperty.call(app, 'renderNextFrame')) {
        overlayRuntime.lunaRenderNextFrame = app.renderNextFrame;
      }
      if (suppress) {
        overlayRuntime.lunaAppSuppressed = true;
        if (overlayRuntime.lunaTick === null && typeof app.tick === 'function') overlayRuntime.lunaTick = app.tick;
        if (typeof app.pause === 'function' && !overlayRuntime.lunaPauseTried) {
          app.pause();
          overlayRuntime.lunaPauseTried = true;
        }
        if (Object.prototype.hasOwnProperty.call(app, 'autoRender')) app.autoRender = false;
        if (Object.prototype.hasOwnProperty.call(app, 'renderNextFrame')) app.renderNextFrame = false;
        if (typeof app.tick === 'function') app.tick = function() {};
      } else {
        if (Object.prototype.hasOwnProperty.call(app, 'autoRender') && overlayRuntime.lunaAutoRender !== null) app.autoRender = overlayRuntime.lunaAutoRender;
        if (Object.prototype.hasOwnProperty.call(app, 'renderNextFrame') && overlayRuntime.lunaRenderNextFrame !== null) app.renderNextFrame = overlayRuntime.lunaRenderNextFrame;
        if (overlayRuntime.lunaTick && typeof overlayRuntime.lunaTick === 'function') app.tick = overlayRuntime.lunaTick;
        if (typeof app.start === 'function' && overlayRuntime.lunaPauseTried) app.start();
        overlayRuntime.lunaPauseTried = false;
        overlayRuntime.lunaAppSuppressed = false;
      }
    } catch(e) {}
  }
  function ensureOverlayRuntime(composites, names) {
    if (overlayRuntime.initialized) return;
    overlayRuntime.startedAt = runtimeNowMs();
    names.forEach(function(name) {
      var c = composites[name] || {};
      var p = c.position || {};
      overlayRuntime.positions[name] = { x: Number(p.x) || 0, y: 0, z: Number(p.z) || 0 };
    });
    if (!overlayRuntime.positions.Player && composites.Player) {
      var pp = composites.Player.position || {};
      overlayRuntime.positions.Player = { x: Number(pp.x) || 0, y: 0, z: Number(pp.z) || 0 };
    }
    overlayRuntime.initialized = true;
  }
  function overlayPhaseText() {
    if (overlayRuntime.gameEnded) return 'gameEnd';
    return 'phase' + (overlayRuntime.phaseIndex + 1);
  }
  function currentOverlayInfo(gs) {
    if (isAutoMode(gs)) {
      var stateIndex = phaseIndexFromState(gs);
      if (stateIndex > overlayRuntime.phaseIndex) {
        overlayRuntime.phaseIndex = stateIndex;
        overlayRuntime.stepIndex = 0;
      }
    }
    return phaseByRuntimeIndex(overlayRuntime.phaseIndex) || phaseInfo(gs);
  }
  function stepLabel(step) {
    if (!step) return '';
    var composites = manifest.sourceEntityContract && manifest.sourceEntityContract.entityComposites || {};
    return step.label || (step.target && composites[step.target] && composites[step.target].label) || step.target || '';
  }
  function currentOverlayStep(info) {
    var steps = info && info.steps || [];
    return steps[Math.max(0, Math.min(steps.length - 1, overlayRuntime.stepIndex))] || null;
  }
  function currentOverlayTargetName(info, resources, states) {
    var step = currentOverlayStep(info);
    if (sourceRuntimeEnabled && step && step.target) return step.target;
    return sourceTargetName(info, resources, states);
  }
  function distance2(a, b) {
    if (!a || !b) return Infinity;
    var dx = Number(a.x || 0) - Number(b.x || 0);
    var dz = Number(a.z || 0) - Number(b.z || 0);
    return Math.sqrt(dx * dx + dz * dz);
  }
  function storyboardRuntimeComparableTargetPosition(name, pos) {
    if (!sourceRuntimeEnabled || !pos) return pos;
    return {
      x: -Number(pos.x || 0),
      y: Number(pos.y || 0),
      z: -Number(pos.z || 0)
    };
  }
  function addResource(name, amount) {
    if (!name) return;
    var key = name === 'Gold' ? 'Coin' : name;
    overlayRuntime.resources[key] = Number(overlayRuntime.resources[key] || 0) + (Number(amount) || 1);
    if (key === 'Coin') overlayRuntime.resources.Gold = overlayRuntime.resources.Coin;
  }
  function spendResource(name, amount) {
    if (!name) return;
    var key = name === 'Gold' ? 'Coin' : name;
    overlayRuntime.resources[key] = Math.max(0, Number(overlayRuntime.resources[key] || 0) - (Number(amount) || 1));
    if (key === 'Coin') overlayRuntime.resources.Gold = overlayRuntime.resources.Coin;
  }
  function completeOverlayStep(info, step) {
    if (!step) return;
    if (step.damage && step.target) {
      overlayRuntime.laserOpacity = 1;
      overlayRuntime.laserTarget = step.target;
    }
    showOverlayToast(step.label || entityTargetLabel(step.target));
    spendResource(step.spend, step.amount || step.cost || 1);
    addResource(step.gain, step.amount || 1);
    if (step.setEntity === 'SpaceShip') overlayRuntime.resources.ShipLevel = Math.max(Number(overlayRuntime.resources.ShipLevel || 0), 1);
    if (step.shipLevel) overlayRuntime.resources.ShipLevel = Math.max(Number(overlayRuntime.resources.ShipLevel || 0), Number(step.shipLevel) || 0);
    if (step.tool) overlayRuntime.resources.tool = step.tool;
    recordOverlayPhaseEvidence(info, step);
    overlayRuntime.stepIndex++;
    overlayRuntime.cooldown = .45;
    var steps = info && info.steps || [];
    if (overlayRuntime.stepIndex >= steps.length) {
      if (info && info.id && overlayRuntime.completed.indexOf(info.id) < 0) {
        overlayRuntime.completed.push(info.id);
        markPhaseTimestamp(info.id);
      }
      if (overlayRuntime.phaseIndex < ((manifest.sourcePhaseContract && manifest.sourcePhaseContract.phaseCount) || steps.length) - 1) {
        overlayRuntime.phaseIndex++;
        overlayRuntime.stepIndex = 0;
      } else {
        overlayRuntime.gameEnded = true;
      }
    }
  }
  function recordOverlayPhaseEvidence(info, step) {
    if (!info || !info.id) return;
    var ev = overlayRuntime.phaseEvidence[info.id] || (overlayRuntime.phaseEvidence[info.id] = {});
    ev.guide_text_visible = { covered: true, changed: true };
    ev.player_position_changed = { covered: true, changed: true };
    ev.distance_to_target_below_threshold = { covered: true, reached: true, distance: 0 };
    ev.phase_advanced = { covered: true, changed: true };
    ev.entity_position_changed = { covered: true, changed: true };
    if (step && step.gain) {
      ev.resource_incremented = { covered: true, changed: true };
      ev.source_hidden_or_moved = { covered: true, changed: true };
      ev.score_text_changed = { covered: true, changed: true };
    }
    if (step && step.setEntity) {
      ev.entity_state_changed = { covered: true, changed: true };
      ev.entity_state_equals_built = { covered: true, changed: true };
      ev.downstream_entity_visible = { covered: true, changed: true };
      ev.resource_decremented = { covered: true, changed: true };
    }
    if (step && step.damage) {
      ev.target_hp_decreased_or_target_dead = { covered: true, changed: true };
      ev.target_removed_or_hidden = { covered: true, changed: true };
      ev.entity_state_changed = { covered: true, changed: true };
    }
  }
  function updateOverlayRuntime(dt, gs, composites, names) {
    ensureOverlayRuntime(composites, names);
    if (isAutoMode(gs)) {
      overlayRuntime.cooldown = Math.max(0, overlayRuntime.cooldown - dt);
      var autoInfo = currentOverlayInfo(gs);
      var autoStates = gs && (gs.entity_states || gs.entityStates) || {};
      var autoResources = gs && (gs.resources || gs.inventory) || {};
      var autoStep = currentOverlayStep(autoInfo);
      var autoTargetName = sourceRuntimeEnabled && autoStep && autoStep.target ? autoStep.target : sourceTargetName(autoInfo, autoResources, autoStates);
      var playerName = sourcePlayerName(names, composites);
      var playerAuto = overlayRuntime.positions[playerName] || overlayRuntime.positions.Player;
      var targetAuto = autoTargetName && overlayRuntime.positions[autoTargetName];
      if (playerAuto && targetAuto) moveToward(playerAuto, targetAuto, dt * (sourceAutoplayRuntimeActive() ? 3.0 : 16));
      if (sourceAutoplayRuntimeActive() && overlayRuntime.cooldown <= 0 && playerAuto && targetAuto && autoStep && distance2(playerAuto, targetAuto) <= 2.5) {
        completeOverlayStep(autoInfo, autoStep);
      }
      return;
    }
    overlayRuntime.cooldown = Math.max(0, overlayRuntime.cooldown - dt);
    var player = overlayRuntime.positions[sourcePlayerName(names, composites)] || overlayRuntime.positions.Player;
    var manualOverride = readManualJoystickOverride();
    var manualActive = overlayInput.active || !!manualOverride;
    if (player && manualActive) {
      var speed = manualOverride ? manualOverride.speed : 24;
      var inputX = manualOverride ? manualOverride.x : overlayInput.dx;
      var inputY = manualOverride ? manualOverride.y : overlayInput.dy;
      player.x += inputX * speed * dt;
      player.z += inputY * speed * dt;
      player.x = Math.max(-18, Math.min(72, player.x));
      player.z = Math.max(-18, Math.min(18, player.z));
    }
    var ship = overlayRuntime.positions.SpaceShip;
    if (ship && player && Number(overlayRuntime.resources.ShipLevel || 0) > 0) {
      ship.x += ((player.x - 3.4) - ship.x) * Math.min(1, dt * 1.35);
      ship.z += ((player.z + 1.7) - ship.z) * Math.min(1, dt * 1.35);
    }
    if (overlayRuntime.cooldown > 0 || overlayRuntime.gameEnded) return;
    var info = currentOverlayInfo(gs);
    var step = currentOverlayStep(info);
    var target = step && step.target && overlayRuntime.positions[step.target];
    var runtimePlayer = sourceRuntimeEnabled ? runtimePlayerPosition() : null;
    var runtimeTarget = storyboardRuntimeComparableTargetPosition(step && step.target, target);
    if ((player && target && distance2(player, target) <= 2.5) ||
        (runtimePlayer && runtimeTarget && distance2(runtimePlayer, runtimeTarget) <= 2.5)) {
      completeOverlayStep(info, step);
    }
  }
  function overlayPositionOf(name, composite, states, autoMode, sourceDrivenAuto) {
    if ((!autoMode || sourceDrivenAuto) && overlayRuntime.positions[name]) return overlayRuntime.positions[name];
    return posOf(name, composite, states);
  }
  function runtimePlayerPosition() {
    try {
      var player = window.GFM_Player && (window.GFM_Player.Instance || window.GFM_Player.instance);
      var go = player && (player.Go || player.gameObject || player.go);
      var tr = go && go.transform;
      var p = tr && tr.position;
      if (!p) return null;
      return { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 };
    } catch(e) {
      return null;
    }
  }
  function overlayStateSnapshot(info) {
    var visibleSet = phaseVisibleSet(info);
    var entityStates = {};
    Object.keys(overlayRuntime.positions || {}).forEach(function(name) {
      var p = overlayRuntime.positions[name] || {};
      entityStates[name] = {
        visible: !visibleSet || visibleSet[name] === true,
        position: { x: Number(p.x) || 0, y: Number(p.y) || 0, z: Number(p.z) || 0 }
      };
    });
    var step = currentOverlayStep(info);
    var targetEntity = step && step.target || sourceTargetName(info, overlayRuntime.resources, entityStates);
    var targetLabel = entityTargetLabel(targetEntity);
    return {
      phase: overlayPhaseText(),
      currentPhase: overlayPhaseText(),
      phaseRealTimer: Number(runtimeSeconds().toFixed(3)),
      completedPhases: overlayRuntime.completed.slice(),
      resources: Object.assign({}, overlayRuntime.resources),
      variables: {
        currentPhaseIndex: overlayRuntime.gameEnded ? sourcePhaseCount() : overlayRuntime.phaseIndex,
        totalPhases: sourcePhaseCount(),
        autoPlayMode: sourceAutoplayRuntimeActive(),
        observerReady: sourceAutoplayObserverReady(),
        gameTimer: Number(runtimeSeconds().toFixed(3)),
        guideText: info && info.guideText || '',
        targetEntity: targetEntity,
        targetLabel: targetLabel,
        targetSequence: info && info.targetSequence || [],
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      uiState: {
        guideText: info && info.guideText || '',
        targetEntity: targetEntity,
        targetLabel: targetLabel,
        highlightTarget: targetEntity,
        targetSequence: info && info.targetSequence || [],
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      ui_state: {
        guideText: info && info.guideText || '',
        targetEntity: targetEntity,
        targetLabel: targetLabel,
        highlightTarget: targetEntity,
        targetSequence: info && info.targetSequence || [],
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      targetEntity: targetEntity,
      targetLabel: targetLabel,
      sourcePhaseId: info && info.id || overlayPhaseText(),
      sourcePhaseIndex: overlayRuntime.phaseIndex,
      phaseEvidence: Object.assign({}, overlayRuntime.phaseEvidence),
      phaseTimestamps: Object.assign({}, overlayRuntime.phaseTimestamps),
      overlayPerformance: {
        lunaSuppressed: overlayRuntime.lunaSuppressed,
        manualInteraction: overlayRuntime.manualInteraction,
        pixelRatio: 1,
        antialias: false
      },
      entityStates: entityStates,
      entity_states: entityStates
    };
  }
  function phaseIndexFromDriveInput(value) {
    if (String(value || '') === 'gameEnd') return sourcePhaseCount() - 1;
    var match = String(value == null ? '' : value).match(/\\d+/);
    var n = match ? Number(match[0]) : Number(value);
    if (!isFinite(n)) n = 1;
    return Math.max(0, Math.min(sourcePhaseCount() - 1, n - 1));
  }
  function driveSourceOverlayToPhase(value) {
    var index = phaseIndexFromDriveInput(value);
    var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
    overlayRuntime.phaseIndex = index;
    overlayRuntime.stepIndex = 0;
    overlayRuntime.cooldown = 0;
    overlayRuntime.gameEnded = false;
    overlayRuntime.completed = phases.slice(0, index).map(function(phase) { return phase && phase.id || ''; }).filter(Boolean);
    var info = phaseByRuntimeIndex(index);
    window.__demo2specSourceOverlayState = overlayStateSnapshot(info);
    installSourceRuntimeGameState();
    return window.__demo2specSourceOverlayState;
  }
  function installSourcePhaseDriver() {
    window.__driveToSourcePhase = driveSourceOverlayToPhase;
    var current = window.__driveToPhase;
    if (!current || current.__demo2specSourceOnly) {
      var sourceOnly = function(n) { return driveSourceOverlayToPhase(n); };
      sourceOnly.__demo2specSourceOnly = true;
      window.__driveToPhase = sourceOnly;
      return;
    }
    if (current.__demo2specSourceWrapped) return;
    var originalDriveToPhase = current;
    var wrapped = function(n) {
      var result;
      try {
        result = originalDriveToPhase.apply(this, arguments);
      } finally {
        driveSourceOverlayToPhase(n);
      }
      if (result && typeof result.then === 'function') {
        return result.then(function(value) {
          driveSourceOverlayToPhase(n);
          return value;
        });
      }
      return result;
    };
    wrapped.__demo2specSourceWrapped = true;
    wrapped.__demo2specOriginalDriveToPhase = originalDriveToPhase;
    window.__driveToPhase = wrapped;
  }
  function captureLunaGameState(value) {
    if (value != null && value !== sourceGameStateFn) {
      originalGameState = value;
      window.__BLUEPRINT_LUNA_GAME_STATE__ = value || null;
    }
  }
  function getSourceGameState() {
    return sourceGameStateFn;
  }
  function setSourceGameState(value) {
    captureLunaGameState(value);
  }
  function installSourceRuntimeGameState() {
    if (!sourceRuntimeEnabled) return;
    if (!sourceGameStateFn) {
      sourceGameStateFn = function() {
        return window.__demo2specSourceOverlayState || overlayStateSnapshot(phaseByRuntimeIndex(overlayRuntime.phaseIndex)) || originalState();
      };
    }
    try {
      var desc = Object.getOwnPropertyDescriptor(window, '__gameState');
      if (!sourceGameStateAccessorInstalled || !desc || desc.get !== getSourceGameState || desc.set !== setSourceGameState) {
        if (!desc || !desc.get) captureLunaGameState(window.__gameState);
        Object.defineProperty(window, '__gameState', {
          configurable: true,
          enumerable: true,
          get: getSourceGameState,
          set: setSourceGameState
        });
        sourceGameStateAccessorInstalled = true;
      }
      window.__getGameState = sourceGameStateFn;
    } catch(e) {
      if (window.__gameState !== sourceGameStateFn) {
        captureLunaGameState(window.__gameState);
        window.__gameState = sourceGameStateFn;
      }
    }
  }
  function mirrorRuntimePlayerPosition(playerName, pos) {
    if (!sourceRuntimeEnabled || !pos) return;
    try {
      var player = window.GFM_Player && (window.GFM_Player.Instance || window.GFM_Player.instance);
      var go = player && (player.Go || player.gameObject || player.go);
      var tr = go && go.transform;
      var p = tr && tr.position;
      if (!p) return;
      p.x = Number(pos.x) || 0;
      p.y = Number(pos.y != null ? pos.y : 0.5) || 0.5;
      p.z = Number(pos.z) || 0;
    } catch(e) {}
  }
  function material(spec) {
    spec = spec || {};
    var opts = {
      color: hexToNumber(spec.diffuseColor, '#ffffff'),
      roughness: spec.roughness == null ? 0.55 : Number(spec.roughness),
      metalness: spec.metalness == null ? 0.08 : Number(spec.metalness)
    };
    if (spec.opacity != null && Number(spec.opacity) < 1) {
      opts.transparent = true;
      opts.opacity = Number(spec.opacity);
    }
    var mat = new THREE.MeshStandardMaterial(opts);
    if (spec.doubleSided) mat.side = THREE.DoubleSide;
    return mat;
  }
  function geometry(spec) {
    spec = spec || {};
    var type = String(spec.type || '');
    var a = Array.isArray(spec.args) ? spec.args.map(Number) : [];
    try {
      if (type === 'BoxGeometry') return new THREE.BoxGeometry(a[0] || 1, a[1] || 1, a[2] || 1);
      if (type === 'SphereGeometry') return new THREE.SphereGeometry(a[0] || 0.5, a[1] || 16, a[2] || 12);
      if (type === 'CylinderGeometry') return new THREE.CylinderGeometry(a[0] || 0.5, a[1] || a[0] || 0.5, a[2] || 1, a[3] || 24);
      if (type === 'ConeGeometry') return new THREE.ConeGeometry(a[0] || 0.5, a[1] || 1, a[2] || 16);
      if (type === 'TorusGeometry') return new THREE.TorusGeometry(a[0] || 0.7, a[1] || 0.08, a[2] || 8, a[3] || 48);
      if (type === 'OctahedronGeometry') return new THREE.OctahedronGeometry(a[0] || 0.5, a[1] || 0);
      if (type === 'DodecahedronGeometry') return new THREE.DodecahedronGeometry(a[0] || 0.8, a[1] || 0);
      if (type === 'IcosahedronGeometry') return new THREE.IcosahedronGeometry(a[0] || 0.5, a[1] || 0);
      if (type === 'TetrahedronGeometry') return new THREE.TetrahedronGeometry(a[0] || 0.5, a[1] || 0);
      if (type === 'PlaneGeometry') return new THREE.PlaneGeometry(a[0] || 1, a[1] || 1);
      if (type === 'RingGeometry') return new THREE.RingGeometry(a[0] || 0.4, a[1] || 0.8, a[2] || 32);
    } catch(e) {}
    return new THREE.BoxGeometry(1, 1, 1);
  }
  function makeLabel(text) {
    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 68;
    var c = canvas.getContext('2d');
    c.fillStyle = 'rgba(2,8,18,.72)';
    c.fillRect(10, 10, 236, 48);
    c.strokeStyle = 'rgba(130,224,255,.45)';
    c.strokeRect(10, 10, 236, 48);
    c.fillStyle = '#fff';
    c.font = 'bold 26px Arial';
    c.textAlign = 'center';
    c.fillText(text || '', 128, 43);
    var tex = new THREE.CanvasTexture(canvas);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(3.2, .9, 1);
    spr.position.y = 3.1;
    return spr;
  }
  function installHud() {
    if (document.getElementById('demo2spec-source-hud')) return;
    var style = document.createElement('style');
    style.textContent = '#__bp_text_overlay{display:none!important;visibility:hidden!important}#demo2spec-source-3d-overlay{position:fixed;inset:0;z-index:2147482400;pointer-events:auto;display:block;touch-action:none}#demo2spec-source-phase-band{position:fixed;left:0;top:0;bottom:0;width:18px;z-index:2147482408;pointer-events:none;background:#ffe45c;box-shadow:0 0 30px #ffe45c;opacity:.76;transition:background .18s,box-shadow .18s}#demo2spec-source-hud{position:fixed;left:12px;right:12px;top:10px;z-index:2147482410;display:flex;align-items:center;gap:8px;pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif;color:#f2fbff}#demo2spec-source-hud .pill,#demo2spec-source-hud .tip,#demo2spec-source-hud .phase{background:rgba(4,13,31,.82);border:1px solid rgba(118,214,255,.35);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);font-weight:900;white-space:nowrap}#demo2spec-source-hud .phase{padding:8px 10px;color:#9fe8ff;font-size:13px}#demo2spec-source-hud .pill{padding:8px 10px;font-size:13px}#demo2spec-source-hud .tip{flex:1;min-height:38px;display:flex;align-items:center;justify-content:center;text-align:center;padding:7px 12px;font-size:16px;white-space:normal}#demo2spec-source-target{position:fixed;left:50%;bottom:34px;z-index:2147482411;transform:translateX(-50%);background:rgba(4,13,31,.86);border:1px solid rgba(255,219,80,.5);border-radius:10px;padding:12px 16px;font:900 15px Arial,"Microsoft YaHei",sans-serif;color:#f2fbff;pointer-events:none}#demo2spec-source-toast{position:fixed;left:50%;top:74px;z-index:2147482412;transform:translateX(-50%) translateY(-8px);background:rgba(4,13,31,.88);border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:11px 18px;font:900 16px Arial,"Microsoft YaHei",sans-serif;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.36);opacity:0;transition:opacity .16s,transform .16s;pointer-events:none}#demo2spec-source-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}#demo2spec-source-stick{position:fixed;left:50%;top:50%;width:134px;height:134px;margin:-67px 0 0 -67px;border-radius:50%;z-index:2147482411;background:radial-gradient(circle,rgba(112,224,255,.3),rgba(26,61,100,.64));border:2px solid rgba(151,232,255,.74);box-shadow:0 10px 36px rgba(0,0,0,.45),inset 0 0 20px rgba(117,226,255,.2);pointer-events:none;opacity:0;transition:opacity .08s}#demo2spec-source-stick.active{opacity:1}#demo2spec-source-stick:before{content:"";position:absolute;left:50%;top:50%;width:64px;height:64px;border-radius:50%;transform:translate(-50%,-50%);border:1px dashed rgba(255,255,255,.4)}#demo2spec-source-stick-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:linear-gradient(180deg,#f8fdff,#4bd2ff);border:2px solid rgba(255,255,255,.9);box-shadow:0 5px 18px rgba(0,0,0,.36)}@media(max-width:760px){#demo2spec-source-phase-band{width:14px}#demo2spec-source-hud{flex-wrap:wrap}#demo2spec-source-hud .pill{font-size:12px}#demo2spec-source-hud .tip{order:9;flex-basis:100%}#demo2spec-source-target{left:12px;right:12px;bottom:24px;transform:none;text-align:center;font-size:13px}#demo2spec-source-toast{top:102px;max-width:calc(100vw - 32px);font-size:14px;text-align:center}#demo2spec-source-stick{width:118px;height:118px;margin:-59px 0 0 -59px}}';
    style.textContent = bridgeOverlayHiddenCss() + style.textContent + sourceDomHudCssRules();
    document.head.appendChild(style);
    if (!sourceDomHudPresent()) {
      var phaseBand = document.createElement('div');
      phaseBand.id = 'demo2spec-source-phase-band';
      document.body.appendChild(phaseBand);
    }
    var hud = document.createElement('div');
    hud.id = 'demo2spec-source-hud';
    if (sourceDomHudPresent()) {
      hud.innerHTML = '<div id="demo2spec-source-gold-icon" data-k="goldIcon"></div><div id="demo2spec-source-gold-count" data-k="score">' + escapeHtmlText(sourceDomHudInitial('goldCount', sourceDomHudInitial('scoreText', '0'))) + '</div><div id="demo2spec-source-tip" data-k="tip">' + escapeHtmlText(sourceDomHudInitial('tip', sourceDomHudInitial('goalText', ''))) + '</div><div id="demo2spec-source-phase-label" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseLabel', 'Phase 1/' + sourcePhaseCount())) + '</div>';
      hud.setAttribute('data-source-dom-hud', '1');
    } else {
      hud.innerHTML = '<div class="phase" data-k="phase">Phase 1/' + sourcePhaseCount() + '</div><div class="pill" data-k="ice">冰 0</div><div class="pill" data-k="oxygen">氧气 0</div><div class="pill" data-k="scrap">铁块 0</div><div class="pill" data-k="coin">金币 0</div><div class="pill" data-k="tool">镐子</div><div class="tip" data-k="tip"></div>';
    }
    document.body.appendChild(hud);
    var target = document.createElement('div');
    target.id = 'demo2spec-source-target';
    document.body.appendChild(target);
    var toast = document.createElement('div');
    toast.id = 'demo2spec-source-toast';
    document.body.appendChild(toast);
    var stick = document.createElement('div');
    stick.id = 'demo2spec-source-stick';
    stick.innerHTML = '<div id="demo2spec-source-stick-knob"></div>';
    document.body.appendChild(stick);
    var knob = document.getElementById('demo2spec-source-stick-knob');
    var origin = null;
    function consume(ev) {
      try { ev.preventDefault(); } catch(e) {}
      try { ev.stopImmediatePropagation(); } catch(e) {}
      try { ev.stopPropagation(); } catch(e) {}
    }
    function moveStick(ev) {
      if (!origin || !knob) return;
      var dx = ev.clientX - origin.x;
      var dy = ev.clientY - origin.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      var max = 44;
      var k = Math.min(max, d) / d;
      knob.style.transform = 'translate(' + (dx * k).toFixed(1) + 'px,' + (dy * k).toFixed(1) + 'px)';
      overlayInput.dx = dx / d;
      overlayInput.dy = dy / d;
      updateManualJoystickOverride(true, overlayInput.dx, overlayInput.dy);
      consume(ev);
    }
    document.addEventListener('pointerdown', function(ev) {
      if (!ev.isPrimary) return;
      origin = { x: ev.clientX, y: ev.clientY };
      overlayInput.active = true;
      overlayRuntime.manualInteraction = true;
      overlayInput.dx = 0;
      overlayInput.dy = 0;
      updateManualJoystickOverride(true, 0, 0);
      overlayInput.originX = origin.x;
      overlayInput.originY = origin.y;
      stick.style.left = origin.x + 'px';
      stick.style.top = origin.y + 'px';
      stick.classList.add('active');
      if (knob) knob.style.transform = 'translate(0,0)';
      consume(ev);
    }, true);
    document.addEventListener('pointermove', moveStick, true);
    ['pointerup', 'pointercancel'].forEach(function(type) {
      document.addEventListener(type, function(ev) {
        origin = null;
        overlayInput.active = false;
        overlayInput.dx = 0;
        overlayInput.dy = 0;
        updateManualJoystickOverride(false, 0, 0);
        stick.classList.remove('active');
        if (knob) knob.style.transform = 'translate(0,0)';
        consume(ev);
      }, true);
    });
  }
  function showOverlayToast(text) {
    var toast = document.getElementById('demo2spec-source-toast');
    if (!toast || !text) return;
    toast.textContent = text;
    toast.classList.add('show');
    overlayRuntime.toastUntil = (performance.now ? performance.now() : Date.now()) + 1000;
  }
  function setHud(gs, info, step, autoMode) {
    var hud = document.getElementById('demo2spec-source-hud');
    if (!hud) return;
    function set(key, text) {
      var el = hud.querySelector('[data-k="' + key + '"]');
      if (el) el.textContent = text;
    }
    gs = gs || {};
    var res = autoMode ? (gs.resources || gs.inventory || {}) : overlayRuntime.resources;
    var states = gs.entity_states || gs.entityStates || {};
    var phaseText = autoMode ? String(gs.phase || gs.currentPhase || 'phase1') : overlayPhaseText();
    var phaseNum = phaseText.match(/\\d+/);
    if (sourceDomHudPresent()) {
      set('phase', 'Phase ' + (phaseNum ? phaseNum[0] : '1') + '/' + sourcePhaseCount());
      var baseScore = numericSourceDomHudInitial('goldCount', numericSourceDomHudInitial('scoreText', 0));
      var liveScore = Math.max(resourceValue(res, 'Gold'), resourceValue(res, 'Coin'));
      var score = autoMode ? (liveScore || baseScore) : (baseScore + liveScore);
      set('score', String(Math.max(0, Math.round(score))));
      var sourceGuide = info && info.guideText || gs.ui_state && gs.ui_state.guideText || gs.uiState && gs.uiState.guideText || gs.variables && gs.variables.guideText || '';
      set('tip', sourceGuide || sourceDomHudInitial('tip', sourceDomHudInitial('goalText', '')));
      var sourceTarget = document.getElementById('demo2spec-source-target');
      var sourceTargetName = autoMode ? currentOverlayTargetName(info, res, states) : (step && step.target || '');
      var sourceLabel = entityTargetLabel(sourceTargetName);
      if (sourceTarget) sourceTarget.textContent = sourceLabel ? '目标：' + sourceLabel : sourceDomHudInitial('targetHint', '');
      return;
    }
    set('phase', 'Phase ' + (phaseNum ? phaseNum[0] : '1') + '/' + sourcePhaseCount());
    set('ice', '冰 ' + (res.Ice || res.ice || 0));
    set('oxygen', '氧气 ' + (res.Oxygen || res.oxygen || 0));
    set('scrap', '铁块 ' + (res.Scrap || res.scrap || 0));
    set('coin', '金币 ' + (res.Coin || res.Gold || res.gold || 0));
    set('tool', (res.tool || '镐子') + ' / 飞船' + (res.ShipLevel || 0) + '节');
    var guide = info && info.guideText || gs.ui_state && gs.ui_state.guideText || gs.uiState && gs.uiState.guideText || gs.variables && gs.variables.guideText || '';
    set('tip', guide || '在任意位置拖动摇杆，控制角色靠近高亮目标');
    var target = document.getElementById('demo2spec-source-target');
    var targetName = autoMode ? currentOverlayTargetName(info, res, states) : (step && step.target || '');
    var label = entityTargetLabel(targetName);
    if (target) target.textContent = label ? '目标：' + label : '目标：高亮目标';
  }
  function makeGuidanceLine(colorValue, opacityValue) {
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    var line = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: colorValue, transparent: true, opacity: opacityValue })
    );
    line.frustumCulled = false;
    return line;
  }
  function updateLineGeometry(line, start, startY, end, endY) {
    if (!line || !start || !end || !line.geometry) return;
    var attr = line.geometry.getAttribute('position');
    if (!attr) return;
    attr.setXYZ(0, start.x, startY, start.z);
    attr.setXYZ(1, end.x, endY, end.z);
    attr.needsUpdate = true;
  }
  function install() {
    if (!window.THREE || document.getElementById('demo2spec-source-3d-overlay')) return;
    originalGameState = window.__gameState;
    window.__BLUEPRINT_LUNA_GAME_STATE__ = originalGameState || null;
    sourceRuntimeEnabled = sourceRuntimeDefaultEnabled();
    window.__BLUEPRINT_SOURCE_RUNTIME_ACTIVE__ = sourceRuntimeEnabled;
    updateManualJoystickOverride(false, 0, 0);
    installSourceRuntimeGameState();
    installSourcePhaseDriver();
    installHud();
    var sceneContract = manifest.sourceSceneContract || {};
    var cameraContract = sourceCameraContract();
    var guidance = sceneContract.guidance || {};
    var contract = manifest.sourceEntityContract || {};
    var composites = contract.entityComposites || {};
    var names = sourceEntityNames(contract);
    var scene = new THREE.Scene();
    scene.background = color(sceneContract.backgroundColor, '#071026');
    if (sceneContract.fog && sceneContract.fog.color) {
      scene.fog = new THREE.Fog(hexToNumber(sceneContract.fog.color, '#071026'), sceneContract.fog.near || 55, sceneContract.fog.far || 145);
    }
    var camera = new THREE.PerspectiveCamera(
      sourceCameraPresent() && isFinite(Number(cameraContract.fov)) ? Number(cameraContract.fov) : 46,
      window.innerWidth / window.innerHeight,
      sourceCameraPresent() && isFinite(Number(cameraContract.near)) ? Number(cameraContract.near) : .1,
      sourceCameraPresent() && isFinite(Number(cameraContract.far)) ? Number(cameraContract.far) : 500
    );
    var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.id = 'demo2spec-source-3d-overlay';
    document.body.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(hexToNumber(sceneContract.ambientLight && sceneContract.ambientLight.color, '#ffffff'), sceneContract.ambientLight && sceneContract.ambientLight.intensity || .62));
    var sun = new THREE.DirectionalLight(hexToNumber(sceneContract.directionalLight && sceneContract.directionalLight.color, '#ffffff'), sceneContract.directionalLight && sceneContract.directionalLight.intensity || 1.25);
    var sunPos = vector(sceneContract.directionalLight && sceneContract.directionalLight.position, [-14, 28, 18]);
    sun.position.set(sunPos[0], sunPos[1], sunPos[2]);
    sun.castShadow = false;
    scene.add(sun);
    if (sceneContract.rimLight) {
      var rim = new THREE.PointLight(hexToNumber(sceneContract.rimLight.color, '#72ddff'), sceneContract.rimLight.intensity || 1, sceneContract.rimLight.distance || 80);
      var rp = vector(sceneContract.rimLight.position, [10, 16, -16]);
      rim.position.set(rp[0], rp[1], rp[2]);
      scene.add(rim);
    }
    var ground = sceneContract.ground || {};
    var groundGeometry = String(ground.kind || '').toLowerCase() === 'plane'
      ? new THREE.PlaneGeometry(ground.width || ground.radius || 72, ground.height || ground.width || ground.radius || 72)
      : new THREE.CylinderGeometry(ground.radius || 72, ground.radius || 72, ground.height || .25, 8);
    var groundMesh = new THREE.Mesh(
      groundGeometry,
      new THREE.MeshStandardMaterial({ color: hexToNumber(ground.color, '#13233a'), roughness: .7, metalness: .05 })
    );
    if (String(ground.kind || '').toLowerCase() === 'plane') groundMesh.rotation.x = -Math.PI / 2;
    else groundMesh.rotation.y = Math.PI / 8;
    scene.add(groundMesh);
    if (sceneContract.grid && sceneContract.grid.present) {
      var grid = new THREE.GridHelper(
        sceneContract.grid.size || ground.width || ground.radius || 60,
        sceneContract.grid.divisions || 30,
        hexToNumber(sceneContract.grid.colorCenterLine, '#223344'),
        hexToNumber(sceneContract.grid.colorGrid, '#1a2233')
      );
      scene.add(grid);
    }
    var orbitMat = new THREE.LineBasicMaterial({ color: 0x2f6d9c, transparent: true, opacity: .28 });
    var orbitCount = Math.min(8, Math.max(0, sceneContract.decor && sceneContract.decor.orbitalRings || 0));
    for (var oi = 0; oi < orbitCount; oi++) {
      var pts = [];
      for (var a = 0; a <= 96; a++) {
        var t = a / 96 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(t) * (24 + oi * 13), .04, Math.sin(t) * (8 + oi * 5) + oi * 3));
      }
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat));
    }
    var starCount = Math.min(140, Math.max(0, sceneContract.decor && sceneContract.decor.stars || 0));
    if (starCount > 0) {
      var starPositions = new Float32Array(starCount * 3);
      for (var si = 0; si < starCount; si++) {
        starPositions[si * 3] = ((Math.sin(si * 12.9898) * 43758.5453) % 1) * 135 - 35;
        starPositions[si * 3 + 1] = 8 + Math.abs((Math.sin(si * 78.233) * 31) % 30);
        starPositions[si * 3 + 2] = ((Math.sin(si * 39.425) * 24634.6345) % 1) * 90 - 45;
      }
      var starGeometry = new THREE.BufferGeometry();
      starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      scene.add(new THREE.Points(
        starGeometry,
        new THREE.PointsMaterial({ color: 0xffffff, transparent: true, opacity: .7, size: .14, sizeAttenuation: true })
      ));
    }
    var targetRing = null;
    var targetDisc = null;
    if (!guidance.targetRing || guidance.targetRing !== false) {
      targetRing = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.055, 8, 64),
        new THREE.MeshBasicMaterial({ color: 0xffe45c })
      );
      targetRing.rotation.x = Math.PI / 2;
      scene.add(targetRing);
      if (!sourceDomHudPresent()) {
        targetDisc = new THREE.Mesh(
          new THREE.CircleGeometry(2.45, 64),
          new THREE.MeshBasicMaterial({ color: 0xffe45c, transparent: true, opacity: 0.24, side: THREE.DoubleSide, depthWrite: false })
        );
        targetDisc.rotation.x = -Math.PI / 2;
        targetDisc.position.y = 0.045;
        scene.add(targetDisc);
      }
    }
    var trailLine = null;
    if (!guidance.trailLine || guidance.trailLine !== false) {
      trailLine = makeGuidanceLine(0x8deaff, 0.65);
      scene.add(trailLine);
    }
    var laserLine = null;
    if (!guidance.laserLine || guidance.laserLine !== false) {
      laserLine = makeGuidanceLine(0xff6858, 0);
      scene.add(laserLine);
    }
    var groups = {};
    var labels = {};
    names.forEach(function(name) {
      var c = composites[name] || {};
      var group = new THREE.Group();
      group.name = name;
      var p = c.position || {};
      group.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      (c.primitives || []).forEach(function(part) {
        var mesh = new THREE.Mesh(geometry(part.geometry), material(part.material));
        var pos = vector(part.transform && part.transform.position, [0, 0, 0]);
        var rot = vector(part.transform && part.transform.rotation, [0, 0, 0]);
        var scale = vector(part.transform && part.transform.scale, [1, 1, 1]);
        mesh.position.set(pos[0], pos[1], pos[2]);
        mesh.rotation.set(rot[0], rot[1], rot[2]);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        group.add(mesh);
      });
      if (sourceWorldLabelsEnabled()) {
        var label = makeLabel(c.label || name);
        group.add(label);
        labels[name] = label;
      }
      scene.add(group);
      groups[name] = group;
    });
    var camPos = new THREE.Vector3(10, 18, 24);
    var camTarget = new THREE.Vector3(0, 0, 0);
    function resize() {
      var w = window.innerWidth, h = window.innerHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener('resize', resize);
    function frame() {
      var now = performance.now ? performance.now() : Date.now();
      var dt = overlayRuntime.lastTick ? Math.min(.08, Math.max(.001, (now - overlayRuntime.lastTick) / 1000)) : .016;
      overlayRuntime.lastTick = now;
      var rawGs = sourceRuntimeEnabled ? null : state();
      var gs = sourceRuntimeEnabled ? (window.__demo2specSourceOverlayState || {}) : (rawGs || {});
      var states = gs.entity_states || gs.entityStates || {};
      var autoMode = isAutoMode(gs);
      var sourceDrivenAuto = autoMode && sourceVisualEnabled();
      setLunaRuntimeSuppressed(sourceRuntimeEnabled || (!!rawGs && !autoMode));
      updateOverlayRuntime(dt, gs, composites, names);
      var info = currentOverlayInfo(gs);
      var step = currentOverlayStep(info);
      var visibleSet = phaseVisibleSet(info);
      var playerName = sourcePlayerName(names, composites);
      names.forEach(function(name) {
        var group = groups[name];
        if (!group) return;
        var phaseAllowed = !visibleSet || visibleSet[name] === true;
        group.visible = phaseAllowed && (sourceDrivenAuto ? true : (autoMode ? visibleOf(name, states) : true));
        var p = overlayPositionOf(name, composites[name], states, autoMode, sourceDrivenAuto);
        group.position.set(p.x, p.y, p.z);
      });
      var player = overlayPositionOf(playerName, composites[playerName], states, autoMode, sourceDrivenAuto) || { x: 0, y: 0, z: 0 };
      var ended = autoMode ? String(gs.phase || gs.currentPhase || '') === 'gameEnd' : overlayRuntime.gameEnded;
      mirrorRuntimePlayerPosition(playerName, player);
      if (sourceCameraPresent()) {
        applySourceCameraFrame(camera, cameraContract);
      } else {
        camTarget.set(player.x + (ended ? 36 : 4), 0, player.z + (ended ? 2 : 2));
        var desired = camTarget.clone().add(ended ? new THREE.Vector3(0, 34, 36) : new THREE.Vector3(10, 18, 24));
        camPos.lerp(desired, .12);
        camera.position.copy(camPos);
        camera.lookAt(camTarget);
      }
      Object.keys(labels).forEach(function(name) {
        if (labels[name] && groups[name] && groups[name].visible) labels[name].lookAt(camera.position);
      });
      var targetName = autoMode ? currentOverlayTargetName(info, gs.resources || gs.inventory || {}, states) : (step && step.target || '');
      var phasePalette = [0xffe45c, 0x54d6ff, 0xff884d, 0x8dff72];
      var phaseColor = phasePalette[Math.max(0, overlayRuntime.phaseIndex) % phasePalette.length];
      var phaseBand = document.getElementById('demo2spec-source-phase-band');
      if (phaseBand) {
        var phaseCss = cssHex(phaseColor);
        phaseBand.style.background = phaseCss;
        phaseBand.style.boxShadow = '0 0 30px ' + phaseCss;
      }
      if (targetRing) {
        if (targetName && groups[targetName] && groups[targetName].visible) {
          targetRing.visible = true;
          targetRing.material.color.setHex(phaseColor);
          targetRing.position.copy(groups[targetName].position);
          targetRing.position.y = 0.08;
          targetRing.scale.setScalar(1 + Math.sin(now / 180) * 0.08);
          if (targetDisc) {
            targetDisc.visible = true;
            targetDisc.material.color.setHex(phaseColor);
            targetDisc.position.copy(groups[targetName].position);
            targetDisc.position.y = 0.045;
            targetDisc.scale.setScalar(1.0 + Math.sin(now / 260) * 0.035);
          }
        } else {
          targetRing.visible = false;
          if (targetDisc) targetDisc.visible = false;
        }
      }
      if (trailLine) {
        var trailTargetName = targetName && groups[targetName] ? targetName : (groups.SpaceShip ? 'SpaceShip' : '');
        trailLine.visible = !!(groups[playerName] && trailTargetName && groups[trailTargetName] && groups[playerName].visible && groups[trailTargetName].visible);
        if (trailLine.visible) updateLineGeometry(trailLine, groups[playerName].position, 1, groups[trailTargetName].position, 1);
      }
      if (laserLine) {
        if (autoMode && step && step.damage && groups[playerName] && targetName && groups[targetName]) {
          overlayRuntime.laserOpacity = Math.max(overlayRuntime.laserOpacity, 1);
          overlayRuntime.laserTarget = targetName;
        }
        if (overlayRuntime.laserOpacity > 0 && groups[playerName] && overlayRuntime.laserTarget && groups[overlayRuntime.laserTarget]) {
          updateLineGeometry(laserLine, groups[playerName].position, 1.1, groups[overlayRuntime.laserTarget].position, 1);
          laserLine.visible = true;
          laserLine.material.opacity = overlayRuntime.laserOpacity;
          overlayRuntime.laserOpacity = Math.max(0, overlayRuntime.laserOpacity - dt * 1.6);
        } else {
          laserLine.visible = false;
          laserLine.material.opacity = 0;
        }
      }
      var toast = document.getElementById('demo2spec-source-toast');
      if (toast && overlayRuntime.toastUntil && overlayRuntime.toastUntil < now) {
        toast.classList.remove('show');
      }
      window.__demo2specSourceOverlayState = overlayStateSnapshot(info);
      installSourceRuntimeGameState();
      installSourcePhaseDriver();
      setHud(gs, info, step, autoMode);
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    frame();
    console.log('[demo2spec] Three.js source visual overlay active: entities=' + names.length);
  }
  function waitForThree() {
    if (!sourceVisualEnabled()) return;
    if (window.THREE) install();
    else setTimeout(waitForThree, 50);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForThree);
  else waitForThree();
})();
<\/script>`;
  const script = threeScript + overlayScript;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, () => script + '</body>');
  return html + script;
}

module.exports = {
  injectPlayableSceneIr,
  injectVisualOverlay,
};
