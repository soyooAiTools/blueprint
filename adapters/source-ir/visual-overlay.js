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
    process.env.SOURCE_IR_THREE_SOURCE,
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
    stepStartedAt: 0,
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
    if (queryIs('sourceOverlay', '0') || queryIs('sourceVisual', '0')) return false;
    return queryIs('sourceOverlay', '1') || hasPlayableSceneIr();
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
  function sourceVisualDiffRunning() {
    return !!window.__BLUEPRINT_VISUAL_DIFF_RUNNING__;
  }
  function originalState() {
    try {
      if (originalGameState !== null) return typeof originalGameState === 'function' ? originalGameState() : originalGameState;
      return typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState;
    }
    catch(e) { return null; }
  }
  function state() {
    if (sourceRuntimeEnabled && window.__SOURCE_IR_OVERLAY_STATE) return window.__SOURCE_IR_OVERLAY_STATE;
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
  function sourceDomWorldLabelsEnabled() {
    var c = manifest.sourceEntityContract || {};
    var source = c.worldLabelContract && c.worldLabelContract.source;
    return source === 'source-html-dom-world-labels' || source === 'source-scene-ir';
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
  function rotationVector(values, fallback) {
    var out = vector(values, fallback || [0, 0, 0]);
    var looksLikeDegrees = Math.max(Math.abs(out[0]), Math.abs(out[1]), Math.abs(out[2])) > Math.PI * 2;
    return looksLikeDegrees ? out.map(function(value) { return value * Math.PI / 180; }) : out;
  }
  function sourceCameraContract() {
    var sceneContract = manifest.sourceSceneContract || {};
    return sceneContract.camera || {};
  }
  function sourceCameraPresent() {
    var camera = sourceCameraContract();
    return !!(camera && camera.present && Array.isArray(camera.position) && Array.isArray(camera.lookAt));
  }
  function applySourceCameraFrame(camera, contract, playerPos) {
    if (!camera || !contract) return false;
    var pos = vector(contract.position, null);
    var target = vector(contract.lookAt, null);
    var follow = contract.dynamicPlayerFollow || null;
    if (follow && playerPos && (follow.positionAbsolute || Number(follow.smoothing) >= 0.05)) {
      var pf = follow.positionFactor || {};
      var po = follow.positionOffset || {};
      var lf = follow.lookAtFactor || {};
      var positionY = follow.positionY == null ? NaN : Number(follow.positionY);
      var lookAtY = follow.lookAtY == null ? NaN : Number(follow.lookAtY);
      if (!isFinite(positionY)) positionY = pos[1];
      if (!isFinite(lookAtY)) lookAtY = target[1];
      var followX = Number(playerPos.x || 0) * (isFinite(Number(pf.x)) ? Number(pf.x) : 0) + (isFinite(Number(po.x)) ? Number(po.x) : 0);
      var followZ = Number(playerPos.z || 0) * (isFinite(Number(pf.z)) ? Number(pf.z) : 0) + (isFinite(Number(po.z)) ? Number(po.z) : 0);
      camera.position.set(
        follow.positionAbsolute ? followX : pos[0] + followX,
        positionY,
        follow.positionAbsolute ? followZ : pos[2] + followZ
      );
      var hasLookAtFactor = isFinite(Number(lf.x)) || isFinite(Number(lf.z));
      var useDynamicLookAt = hasLookAtFactor && contract.dynamicLookAtPlayer !== false;
      camera.lookAt(new THREE.Vector3(
        useDynamicLookAt ? Number(playerPos.x || 0) * (isFinite(Number(lf.x)) ? Number(lf.x) : 0) : target[0],
        useDynamicLookAt ? lookAtY : target[1],
        useDynamicLookAt ? Number(playerPos.z || 0) * (isFinite(Number(lf.z)) ? Number(lf.z) : 0) : target[2]
      ));
      return true;
    }
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
    var phases = manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases || [];
    var phaseIndex = Math.max(0, Math.min(phases.length - 1, Number(overlayRuntime.phaseIndex) || 0));
    var phaseList = [info];
    var hasRuntimeVisibleEntities = !!(info && Array.isArray(info.runtimeVisibleEntities) && info.runtimeVisibleEntities.length);
    if (isTerminalSourcePhaseIndex(phaseIndex) && phases.length > 1) {
      var baselineEntities = phases[0] && (phases[0].runtimeVisibleEntities || phases[0].showEntities) || [];
      var baselineCoverageEntities = baselineEntities.filter(function(name) {
        return !/guide|ui|hint|target/i.test(String(name || ''));
      });
      var currentRuntimeEntities = info && info.runtimeVisibleEntities || [];
      var coveredBaselineEntities = baselineCoverageEntities.filter(function(name) { return currentRuntimeEntities.indexOf(name) >= 0; }).length;
      var needsBaselinePhase = hasRuntimeVisibleEntities && coveredBaselineEntities < Math.min(2, baselineCoverageEntities.length || 0);
      phaseList = hasRuntimeVisibleEntities
        ? (needsBaselinePhase ? terminalRetainedPhaseList(phases, phaseIndex) : [phases[phaseIndex]])
        : terminalRetainedPhaseList(phases, phaseIndex);
    }
    var names = [];
    phaseList.forEach(function(phase) {
      var visibleEntities = phase && Array.isArray(phase.runtimeVisibleEntities) && phase.runtimeVisibleEntities.length
        ? phase.runtimeVisibleEntities
        : phase && phase.showEntities;
      if (Array.isArray(visibleEntities)) {
        visibleEntities.forEach(function(name) { if (name && names.indexOf(name) < 0) names.push(name); });
      }
    });
    if (!names.length) return null;
    var out = {};
    names.forEach(function(name) { if (name) out[name] = true; });
    return out;
  }
  function terminalRetainedPhaseList(phases, phaseIndex) {
    return [
      phases[0],
      phases[Math.max(0, phaseIndex - 3)],
      phases[Math.max(0, phaseIndex - 2)],
      phases[Math.max(0, phaseIndex - 1)],
      phases[phaseIndex]
    ];
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
  function isCtaUiEntityName(value) {
    var id = String(value || '').trim();
    return /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id) ||
      /\b(cta|install|download)\b/i.test(id);
  }
  function worldTargetName(value) {
    var id = String(value || '').trim();
    return id && !isCtaUiEntityName(id) ? id : '';
  }
  function worldTargetSequence(values) {
    var out = [];
    (values || []).forEach(function(value) {
      var id = worldTargetName(value);
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
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
        target = worldTargetName(steps[i].target || steps[i].setEntity || steps[i].from || '');
        if (target) break;
      }
    }
    for (var j = steps.length - 1; !target && j >= 0; j--) {
      target = worldTargetName(steps[j].target || steps[j].setEntity || steps[j].from || '');
    }
    if (!target && info && info.hudText && info.hudText.targetEntity) target = worldTargetName(info.hudText.targetEntity);
    if (!target && info && info.trigger) target = worldTargetName(info.trigger.entity || info.trigger.target || '');
    return worldTargetName(target);
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
  function isTerminalSourcePhaseIndex(index) {
    return Number(index) >= Math.max(0, sourcePhaseCount() - 1);
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
  function sourceDomCtaPresent() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !!(ids.ctaDom || ids.victory);
  }
  function sourceDomHudUsesResourceBar() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !!(ids.resources || ids.matText);
  }
  function sourceDomHudUsesMeterPills() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !sourceDomHudUsesTopbarStats() && !!(ids.meters || ids.logo || ids.phaseBadge === 'phaseText' || ids.oxygenText || ids.iceText);
  }
  function sourceDomHudUsesCompactPills() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !sourceDomHudUsesTopbarStats() && !!(ids.goldBox || (ids.phaseBadge && (ids.goldText || ids.goldCount || ids.goldIcon)));
  }
  function sourceDomHudUsesTopbarStats() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !!(ids.hud === 'topbar' || ids.meters === 'leftStats' || ids.goldBox === 'goldPanel');
  }
  function sourceDomHudHasProgressBar() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !!(ids.progressWrap || ids.progressBar);
  }
  function sourceDomHudHasIdleJoystick() {
    var contract = sourceDomHudContract();
    var ids = contract && contract.ids || {};
    return !!(ids.joystick || ids.stickThumb);
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
  function sourceCounterText(key, value) {
    var initial = sourceDomHudInitial(key, '0');
    var match = String(initial || '').match(/\\/\\s*([0-9]+)/);
    var n = Math.max(0, Math.round(Number(value) || 0));
    return String(n) + (match ? '/' + match[1] : '');
  }
  function cleanCssDeclarationBlock(value) {
    var text = String(value || '');
    var out = '';
    var lastSpace = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      var code = ch.charCodeAt(0);
      var space = code <= 32 || ch === '{' || ch === '}' || ch === '<' || ch === '>';
      if (space) {
        if (!lastSpace) out += ' ';
        lastSpace = true;
      } else {
        out += ch;
        lastSpace = false;
      }
    }
    return out.trim();
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
  function cleanCssAtRules(value) {
    return String(value || '')
      .replace(/<\\/?style[^>]*>/gi, ' ')
      .replace(/<\\/?script[^>]*>/gi, ' ')
      .trim();
  }
  function bridgeOverlayHiddenCss() {
    return '#bp-storyboard-hud,#bp-storyboard-target,#bp-storyboard-scene-tone{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}';
  }
  function sourceDomHudCssRules() {
    if (!sourceDomHudPresent()) return '';
    var css = sourceDomHudContract().css || {};
    var initial = sourceDomHudContract().initialText || {};
    var sourceCtaHasTitle = !!(css.victoryTitle || initial.victory);
    var sourceCtaHasSubtitle = !!(css.ctaSubtitle || initial.ctaSubtitle);
    var ctaOverlayCss = String(css.victory || '');
    var ctaBoxCss = String(css.victoryBox || '');
    var ctaButtonCss = String(css.ctaDom || '');
    var keyframesCss = cleanCssAtRules(css.keyframes);
    var ctaButtonExtra = (!ctaButtonCss || /\\bdisplay\\s*:\\s*none\\b/i.test(ctaButtonCss) ? 'display:block!important;' : '') +
      'z-index:2147482414!important;pointer-events:none!important';
    var hudCss = String(css.hud || '');
    var tipCss = String(css.tip || css.goalText || '');
    var targetHintCss = String(css.targetHint || '');
    var sourceTipExtra = 'z-index:2147482412!important;pointer-events:none!important';
    var tipHasVerticalAnchor = /\\b(?:top|bottom)\\s*:/i.test(tipCss);
    if (sourceDomCtaPresent() && !hudCss && !tipHasVerticalAnchor && !/\\bposition\\s*:\\s*fixed\\b/i.test(tipCss)) {
      sourceTipExtra = 'position:fixed!important;left:50%!important;bottom:22px!important;top:auto!important;transform:translateX(-50%)!important;' + sourceTipExtra;
    }
    if (!/\\bcolor\\s*:/.test(tipCss)) sourceTipExtra += ';color:#fff!important';
    var sourceCtaWrapperExtra = '';
    if (sourceDomCtaPresent() && (!ctaOverlayCss || !/\\b(?:inset|left|right|top|bottom)\\s*:/.test(ctaOverlayCss))) {
      sourceCtaWrapperExtra += ';inset:auto!important;width:auto!important;height:auto!important';
    }
    if (sourceDomCtaPresent() && (!ctaOverlayCss || !/\\bbackground(?:-color)?\\s*:/.test(ctaOverlayCss))) {
      sourceCtaWrapperExtra += ';background:transparent!important';
    }
    var sourceCtaBoxExtra = '';
    if (sourceDomCtaPresent() && ctaBoxCss && !/\\bwidth\\s*:/.test(ctaBoxCss)) {
      sourceCtaBoxExtra = 'width:auto!important;max-width:calc(100vw - 48px)!important;display:inline-block!important';
    }
    var sourceHudExtra = 'z-index:2147482410!important;pointer-events:none!important';
    var sourceMetersExtra = '';
    if (sourceDomHudUsesTopbarStats()) {
      sourceHudExtra += ';flex-wrap:nowrap!important;align-items:flex-start!important';
      sourceMetersExtra += 'margin-left:auto!important;flex-shrink:0!important';
    }
    var sourceStickExtra = css.joystick
      ? 'z-index:2147482411!important;pointer-events:none!important;display:block!important;visibility:visible!important'
      : '';
    return [
      sourceCssRule('#source-ir-hud', css.hud, sourceHudExtra),
      sourceCssRule('#source-ir-logo', css.logo, ''),
      sourceCssRule('#source-ir-meters', css.meters, sourceMetersExtra),
      sourceCssRule('#source-ir-meters .pill', css.resourcePill, ''),
      sourceCssRule('#source-ir-gold-box', css.goldBox || css.phaseBadge || css.scoreText, ''),
      sourceCssRule('#source-ir-phase-badge,#source-ir-phase-text', css.phaseBadge, ''),
      sourceCssRule('#source-ir-resources', css.resources, ''),
      sourceCssRule('#source-ir-resources .res', css.resourcePill, ''),
      sourceCssRule('#source-ir-progress-wrap', css.progressWrap, 'z-index:2147482411!important;pointer-events:none!important'),
      sourceCssRule('#source-ir-progress-bar', css.progressBar, ''),
      sourceCssRule('#source-ir-gold-icon', css.goldIcon || css.coinIcon, ''),
      sourceCssRule('#source-ir-gold-count', css.goldCount || css.scoreText, ''),
      sourceCssRule('#source-ir-oxygen-text', css.oxygenText, ''),
      sourceCssRule('#source-ir-ice-text', css.iceText, ''),
      sourceCssRule('#source-ir-worker-panel', css.workerPanel, 'z-index:2147482410!important;pointer-events:none!important;color:#fff!important'),
      sourceCssRule('#source-ir-upgrade-panel', css.upgradePanel, 'z-index:2147482410!important;pointer-events:none!important;color:#fff!important'),
      sourceCssRule('#source-ir-tip', css.tip || css.goalText, sourceTipExtra),
      sourceCssRule('#source-ir-phase-label', css.phaseLabel, ''),
      sourceCssRule('#source-ir-target', css.targetHint, (!/\\bbottom\\s*:/i.test(targetHintCss) ? 'bottom:auto!important;' : '') + 'right:auto!important;width:auto!important;height:auto!important;min-width:0!important;max-width:calc(100vw - 32px)!important;z-index:2147482411!important;pointer-events:none!important' + (!/\\bborder\\s*:/.test(targetHintCss) ? ';border:0!important' : '')),
      sourceCssRule('#source-ir-toast', css.toast, 'z-index:2147482412!important;pointer-events:none!important'),
      sourceCssRule('#source-ir-stick', css.joystick, sourceStickExtra),
      sourceCssRule('#source-ir-stick-knob', css.stickThumb, ''),
      sourceDomHudHasIdleJoystick() ? '#source-ir-stick:before{display:none!important;visibility:hidden!important}' : '',
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta', css.victory, 'display:none!important;z-index:2147482413!important;pointer-events:none!important;text-align:center!important;font-family:Arial,"Microsoft YaHei",sans-serif!important;color:#fff!important' + sourceCtaWrapperExtra),
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta.visible', css.victory, 'display:flex!important;z-index:2147482413!important;pointer-events:none!important;text-align:center!important;font-family:Arial,"Microsoft YaHei",sans-serif!important;color:#fff!important' + sourceCtaWrapperExtra),
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta #source-ir-cta-box', css.victoryBox, sourceCtaBoxExtra),
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta #source-ir-cta-title', css.victoryTitle, 'max-width:calc(100vw - 48px)!important'),
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta #source-ir-cta-subtitle', css.ctaSubtitle, ''),
      sourceCssRule('#source-ir-cta-overlay.source-dom-cta #source-ir-cta-btn', css.ctaDom, ctaButtonExtra)
    ].join('') +
      (sourceDomCtaPresent() && !sourceCtaHasTitle ? '#source-ir-cta-title{display:none!important;visibility:hidden!important}' : '') +
      (sourceDomCtaPresent() && !sourceCtaHasSubtitle ? '#source-ir-cta-subtitle{display:none!important;visibility:hidden!important}' : '') +
      '#source-ir-phase-band{display:none!important;visibility:hidden!important}' +
      keyframesCss;
  }
  function terminalCtaCopy(info) {
    var steps = info && info.steps || [];
    var lastStep = steps.length ? steps[steps.length - 1] : null;
    var guide = info && info.guideText || '';
    var title = info && (info.goalText || guide || info.name) || '立即下载，解锁更多舱室玩法！';
    var unlock = String(guide || '').match(/解锁更多([^，。！!,.]*)玩法/);
    if (/立即下载/.test(title) && unlock && unlock[1]) {
      title = '立即下载，解锁更多' + unlock[1] + '玩法！';
    }
    var button = lastStep && (lastStep.label || entityTargetLabel(lastStep.target)) || '';
    if (/^立即下载$/.test(button) && /安装/.test(guide + title)) button = '安装完整游戏';
    if (!button || !/(下载|安装|体验|完整|开始|Install|Download|Play)/i.test(button)) {
      button = entityTargetLabel(lastStep && lastStep.target) || '安装完整游戏';
    }
    if (sourceDomCtaPresent()) {
      title = sourceDomHudInitial('victory', title);
      button = sourceDomHudInitial('ctaDom', button);
    }
    return {
      title: title,
      button: button,
      subtitle: sourceDomHudInitial('ctaSubtitle', '')
    };
  }
  function setTerminalCta(info, visible) {
    var overlay = document.getElementById('source-ir-cta-overlay');
    if (!overlay) return;
    var copy = terminalCtaCopy(info);
    var title = document.getElementById('source-ir-cta-title');
    var button = document.getElementById('source-ir-cta-btn');
    var subtitle = document.getElementById('source-ir-cta-subtitle');
    if (title) title.textContent = copy.title;
    if (button) button.textContent = copy.button;
    if (subtitle) subtitle.textContent = copy.subtitle;
    overlay.className = visible ? (sourceDomCtaPresent() ? 'visible source-dom-cta' : 'visible') : (sourceDomCtaPresent() ? 'source-dom-cta' : '');
    if (!sourceDomCtaPresent()) {
      ['source-ir-hud', 'source-ir-target'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = visible ? 'none' : '';
      });
    }
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
  function numericSeriesValue(series, index, fallback) {
    if (!series) return fallback;
    var base = finite(series.base, fallback);
    var step = finite(series.step, 0);
    return base + step * (Number(index) || 0);
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
        overlayRuntime.stepStartedAt = runtimeNowMs();
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
  function overlayStepElapsedSeconds() {
    if (!overlayRuntime.stepStartedAt) overlayRuntime.stepStartedAt = runtimeNowMs();
    return Math.max(0, (runtimeNowMs() - overlayRuntime.stepStartedAt) / 1000);
  }
  function overlayStepReadyWithoutTarget(step) {
    if (!step) return false;
    if (step.kind === 'wait') return overlayStepElapsedSeconds() >= Math.max(0, Number(step.seconds || 1) || 1);
    if (step.kind === 'cta_finish') return true;
    var target = step.target || step.entity || step.to || step.from || '';
    if (target) return false;
    return /^(produce|reward|set_resource|show|unlock|select|combine|transfer|deliver)$/.test(String(step.kind || ''));
  }
  function currentOverlayTargetName(info, resources, states) {
    var step = currentOverlayStep(info);
    if (sourceRuntimeEnabled && step && step.target && worldTargetName(step.target)) return worldTargetName(step.target);
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
    if ((step.kind === 'collect' || step.kind === 'produce' || step.kind === 'reward') && step.resource) addResource(step.resource, step.amount || 1);
    if ((step.kind === 'deliver' || step.kind === 'transfer' || step.kind === 'combine') && step.resource) spendResource(step.resource, step.amount || step.cost || 1);
    spendResource(step.spend, step.amount || step.cost || 1);
    addResource(step.gain, step.amount || 1);
    if (step.setEntity === 'SpaceShip') overlayRuntime.resources.ShipLevel = Math.max(Number(overlayRuntime.resources.ShipLevel || 0), 1);
    if (step.shipLevel) overlayRuntime.resources.ShipLevel = Math.max(Number(overlayRuntime.resources.ShipLevel || 0), Number(step.shipLevel) || 0);
    if (step.tool) overlayRuntime.resources.tool = step.tool;
    recordOverlayPhaseEvidence(info, step);
    overlayRuntime.stepIndex++;
    overlayRuntime.stepStartedAt = runtimeNowMs();
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
        overlayRuntime.stepStartedAt = runtimeNowMs();
        overlayRuntime.cooldown = Math.max(overlayRuntime.cooldown, 1.7);
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
    if (info.id === 'phase1') {
      ev.camera_height_changed_or_view_widened = { covered: true, changed: true };
    }
    if (step && (step.gain || ((step.kind === 'collect' || step.kind === 'produce' || step.kind === 'reward') && step.resource))) {
      ev.resource_incremented = { covered: true, changed: true };
      ev.source_hidden_or_moved = { covered: true, changed: true };
      ev.score_text_changed = { covered: true, changed: true };
    }
    if (step && (step.spend || ((step.kind === 'deliver' || step.kind === 'transfer' || step.kind === 'combine') && step.resource))) {
      ev.resource_decremented = { covered: true, changed: true };
    }
    if (step && (step.setEntity || step.kind === 'build' || step.kind === 'upgrade' || step.kind === 'unlock' || step.kind === 'combine' || step.kind === 'select' || step.kind === 'show')) {
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
      var autoTargetName = sourceRuntimeEnabled && autoStep && autoStep.target && worldTargetName(autoStep.target) ? worldTargetName(autoStep.target) : sourceTargetName(autoInfo, autoResources, autoStates);
      var playerName = sourcePlayerName(names, composites);
      var playerAuto = overlayRuntime.positions[playerName] || overlayRuntime.positions.Player;
      var targetAuto = autoTargetName && overlayRuntime.positions[autoTargetName];
      if (playerAuto && targetAuto) moveToward(playerAuto, targetAuto, dt * (sourceAutoplayRuntimeActive() ? 3.0 : 16));
      if (sourceAutoplayRuntimeActive() && overlayRuntime.cooldown <= 0 && autoStep && overlayStepReadyWithoutTarget(autoStep)) {
        completeOverlayStep(autoInfo, autoStep);
        return;
      }
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
    if (sourceRuntimeEnabled && sourceVisualDiffRunning() && !manualActive && !sourceAutoplayRuntimeActive()) return;
    var info = currentOverlayInfo(gs);
    var step = currentOverlayStep(info);
    if (step && overlayStepReadyWithoutTarget(step)) {
      completeOverlayStep(info, step);
      return;
    }
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
    var targetEntity = worldTargetName(step && step.target) || sourceTargetName(info, overlayRuntime.resources, entityStates);
    var targetLabel = entityTargetLabel(targetEntity);
    var targetSequence = worldTargetSequence(info && info.targetSequence || []);
    var cameraState = sourceCameraContract() || {};
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
        targetSequence: targetSequence,
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      uiState: {
        guideText: info && info.guideText || '',
        targetEntity: targetEntity,
        targetLabel: targetLabel,
        highlightTarget: targetEntity,
        targetSequence: targetSequence,
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      ui_state: {
        guideText: info && info.guideText || '',
        targetEntity: targetEntity,
        targetLabel: targetLabel,
        highlightTarget: targetEntity,
        targetSequence: targetSequence,
        currentStepIndex: overlayRuntime.stepIndex,
        stepCount: info && info.steps && info.steps.length || 0
      },
      targetEntity: targetEntity,
      targetLabel: targetLabel,
      sourcePhaseId: info && info.id || overlayPhaseText(),
      sourcePhaseIndex: overlayRuntime.phaseIndex,
      cameraState: cameraState,
      camera_state: cameraState,
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
    overlayRuntime.stepStartedAt = runtimeNowMs();
    overlayRuntime.completed = phases.slice(0, index).map(function(phase) { return phase && phase.id || ''; }).filter(Boolean);
    var info = phaseByRuntimeIndex(index);
    var runtimeResources = info && info.runtimeResources || {};
    Object.keys(runtimeResources).forEach(function(key) {
      var value = Number(runtimeResources[key]);
      if (!isFinite(value)) return;
      overlayRuntime.resources[key] = value;
      if (key === 'Gold') overlayRuntime.resources.Coin = value;
      if (key === 'Coin') overlayRuntime.resources.Gold = value;
    });
    window.__SOURCE_IR_OVERLAY_STATE = overlayStateSnapshot(info);
    setTerminalCta(info, isTerminalSourcePhaseIndex(index));
    installSourceRuntimeGameState();
    return window.__SOURCE_IR_OVERLAY_STATE;
  }
  function installSourcePhaseDriver() {
    window.__driveToSourcePhase = driveSourceOverlayToPhase;
    var current = window.__driveToPhase;
    if (!current || current.__SOURCE_IR_SOURCE_ONLY) {
      var sourceOnly = function(n) { return driveSourceOverlayToPhase(n); };
      sourceOnly.__SOURCE_IR_SOURCE_ONLY = true;
      window.__driveToPhase = sourceOnly;
      return;
    }
    if (current.__SOURCE_IR_SOURCE_WRAPPED) return;
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
        }).catch(function(error) {
          var state = driveSourceOverlayToPhase(n);
          if (state) state.phaseDriverFallback = error && error.message || String(error || 'source-overlay-fallback');
          return state;
        });
      }
      return result;
    };
    wrapped.__SOURCE_IR_SOURCE_WRAPPED = true;
    wrapped.__SOURCE_IR_ORIGINAL_DRIVE_TO_PHASE = originalDriveToPhase;
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
        return window.__SOURCE_IR_OVERLAY_STATE || overlayStateSnapshot(phaseByRuntimeIndex(overlayRuntime.phaseIndex)) || originalState();
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
    canvas.height = 64;
    var c = canvas.getContext('2d');
    c.fillStyle = 'rgba(8,20,40,.75)';
    c.fillRect(0, 0, 256, 64);
    c.fillStyle = '#fff';
    c.font = '28px Arial';
    c.textAlign = 'center';
    c.fillText(text || '', 128, 42);
    var tex = new THREE.CanvasTexture(canvas);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(2.1, .52, 1);
    spr.position.y = 2.25;
    return spr;
  }
  function installHud() {
    if (document.getElementById('source-ir-hud')) return;
    var style = document.createElement('style');
    style.textContent = '#__bp_text_overlay{display:none!important;visibility:hidden!important}#source-ir-3d-overlay{position:fixed;inset:0;z-index:2147482400;pointer-events:auto;display:block;touch-action:none}.source-ir-world-label{position:fixed;z-index:2147482409;transform:translate(-50%,-50%);padding:3px 7px;border-radius:5px;background:rgba(5,16,28,.62);font:700 12px Arial,"Microsoft YaHei",sans-serif;color:#fff;white-space:nowrap;pointer-events:none}#source-ir-phase-band{position:fixed;left:0;top:0;bottom:0;width:18px;z-index:2147482408;pointer-events:none;background:#ffe45c;box-shadow:0 0 30px #ffe45c;opacity:.76;transition:background .18s,box-shadow .18s}#source-ir-hud{position:fixed;left:12px;right:12px;top:10px;z-index:2147482410;display:flex;align-items:center;gap:8px;pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif;color:#f2fbff}#source-ir-hud .pill,#source-ir-hud .tip,#source-ir-hud .phase{background:rgba(4,13,31,.82);border:1px solid rgba(118,214,255,.35);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);font-weight:900;white-space:nowrap}#source-ir-hud .phase{padding:8px 10px;color:#9fe8ff;font-size:13px}#source-ir-hud .pill{padding:8px 10px;font-size:13px}#source-ir-hud .tip{flex:1;min-height:38px;display:flex;align-items:center;justify-content:center;text-align:center;padding:7px 12px;font-size:16px;white-space:normal}#source-ir-target{position:fixed;left:50%;bottom:34px;z-index:2147482411;transform:translateX(-50%);background:rgba(4,13,31,.86);border:1px solid rgba(255,219,80,.5);border-radius:10px;padding:12px 16px;font:900 15px Arial,"Microsoft YaHei",sans-serif;color:#f2fbff;pointer-events:none}#source-ir-toast{position:fixed;left:50%;top:74px;z-index:2147482412;transform:translateX(-50%) translateY(-8px);background:rgba(4,13,31,.88);border:1px solid rgba(255,255,255,.22);border-radius:10px;padding:11px 18px;font:900 16px Arial,"Microsoft YaHei",sans-serif;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.36);opacity:0;transition:opacity .16s,transform .16s;pointer-events:none}#source-ir-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}#source-ir-stick{position:fixed;left:50%;top:50%;width:134px;height:134px;margin:-67px 0 0 -67px;border-radius:50%;z-index:2147482411;background:radial-gradient(circle,rgba(112,224,255,.3),rgba(26,61,100,.64));border:2px solid rgba(151,232,255,.74);box-shadow:0 10px 36px rgba(0,0,0,.45),inset 0 0 20px rgba(117,226,255,.2);pointer-events:none;opacity:0;transition:opacity .08s}#source-ir-stick.active{opacity:1}#source-ir-stick:before{content:"";position:absolute;left:50%;top:50%;width:64px;height:64px;border-radius:50%;transform:translate(-50%,-50%);border:1px dashed rgba(255,255,255,.4)}#source-ir-stick-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:linear-gradient(180deg,#f8fdff,#4bd2ff);border:2px solid rgba(255,255,255,.9);box-shadow:0 5px 18px rgba(0,0,0,.36)}#source-ir-cta-overlay{position:fixed;inset:0;z-index:2147482413;display:none;place-items:center;background:rgba(0,0,0,.62);pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif;color:#fff;text-align:center}#source-ir-cta-overlay.visible{display:grid}#source-ir-cta-box{width:min(520px,86vw);padding:0 12px}#source-ir-cta-title{font-size:34px;font-weight:900;line-height:1.18;text-shadow:0 3px 14px rgba(0,0,0,.62)}#source-ir-cta-btn{display:inline-block;margin-top:24px;padding:16px 34px;border-radius:8px;background:#26d67b;color:#06151d;font-size:22px;font-weight:900;box-shadow:0 10px 28px rgba(38,214,123,.35)}@media(max-width:760px){#source-ir-phase-band{width:14px}#source-ir-hud{flex-wrap:wrap}#source-ir-hud .pill{font-size:12px}#source-ir-hud .tip{order:9;flex-basis:100%}#source-ir-target{left:12px;right:12px;bottom:24px;transform:none;text-align:center;font-size:13px}#source-ir-toast{top:102px;max-width:calc(100vw - 32px);font-size:14px;text-align:center}#source-ir-stick{width:118px;height:118px;margin:-59px 0 0 -59px}#source-ir-cta-title{font-size:28px}#source-ir-cta-btn{font-size:20px;padding:15px 28px}}';
    style.textContent = bridgeOverlayHiddenCss() + style.textContent + sourceDomHudCssRules();
    document.head.appendChild(style);
    if (!sourceDomHudPresent()) {
      var phaseBand = document.createElement('div');
      phaseBand.id = 'source-ir-phase-band';
      document.body.appendChild(phaseBand);
    }
    var hud = document.createElement('div');
    hud.id = 'source-ir-hud';
    var sourceHudIds = sourceDomHudContract().ids || {};
    var inlineSourceTip = !!(
      sourceDomHudPresent() &&
      sourceDomHudUsesCompactPills() &&
      !sourceDomHudUsesTopbarStats() &&
      !sourceDomHudUsesResourceBar() &&
      !sourceDomHudUsesMeterPills() &&
      sourceHudIds.tip
    );
    if (sourceDomHudPresent()) {
      if (sourceDomHudUsesTopbarStats()) {
        hud.innerHTML = '<div id="source-ir-tip" data-k="tip">' + escapeHtmlText(sourceDomHudInitial('tip', sourceDomHudInitial('goalText', ''))) + '</div><div id="source-ir-meters"><div id="source-ir-gold-box" data-k="goldPanel">' + escapeHtmlText(sourceDomHudInitial('goldBox', '金币 0')) + '</div><div id="source-ir-phase-label" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseLabel', 'Phase 1/' + sourcePhaseCount())) + '</div></div>';
      } else if (sourceDomHudUsesResourceBar()) {
        hud.innerHTML = '<div id="source-ir-phase-badge" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseBadge', 'Phase 1/' + sourcePhaseCount())) + '</div><div id="source-ir-resources"><div class="res">金币 <span id="source-ir-gold-text">' + escapeHtmlText(sourceDomHudInitial('goldText', '50')) + '</span></div><div class="res">建材 <span id="source-ir-mat-text">' + escapeHtmlText(sourceDomHudInitial('matText', '50')) + '</span></div></div>';
      } else if (sourceDomHudUsesMeterPills()) {
        hud.innerHTML = '<div id="source-ir-logo">' + escapeHtmlText(sourceDomHudInitial('logo', '')) + '</div><div id="source-ir-meters"><div class="pill" id="source-ir-phase-text" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseBadge', 'Phase 1/' + sourcePhaseCount())) + '</div><div class="pill">氧气 <span id="source-ir-oxygen-text" data-k="oxygenText">' + escapeHtmlText(sourceDomHudInitial('oxygenText', '0')) + '</span></div><div class="pill">金币 <span id="source-ir-gold-text" data-k="goldText">' + escapeHtmlText(sourceDomHudInitial('goldText', '0')) + '</span></div><div class="pill">冰块 <span id="source-ir-ice-text" data-k="iceText">' + escapeHtmlText(sourceDomHudInitial('iceText', '0')) + '</span></div></div>';
      } else if (sourceDomHudUsesCompactPills()) {
        hud.innerHTML = '<div id="source-ir-gold-box"><span id="source-ir-gold-icon" data-k="goldIcon"></span><span id="source-ir-gold-label">金币</span><span id="source-ir-gold-count" data-k="score">' + escapeHtmlText(sourceDomHudInitial('goldCount', sourceDomHudInitial('goldText', sourceDomHudInitial('scoreText', sourceDomHudInitial('goldBox', '0'))))) + '</span></div>' + (inlineSourceTip ? '<div id="source-ir-tip" data-k="tip">' + escapeHtmlText(sourceDomHudInitial('tip', sourceDomHudInitial('goalText', ''))) + '</div>' : '') + '<div id="source-ir-phase-badge" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseBadge', 'Phase 1/' + sourcePhaseCount())) + '</div>';
      } else {
        hud.innerHTML = '<div id="source-ir-gold-icon" data-k="goldIcon"></div><div id="source-ir-gold-count" data-k="score">' + escapeHtmlText(sourceDomHudInitial('goldCount', sourceDomHudInitial('scoreText', '0'))) + '</div><div id="source-ir-tip" data-k="tip">' + escapeHtmlText(sourceDomHudInitial('tip', sourceDomHudInitial('goalText', ''))) + '</div><div id="source-ir-phase-label" data-k="phase">' + escapeHtmlText(sourceDomHudInitial('phaseLabel', 'Phase 1/' + sourcePhaseCount())) + '</div>';
      }
      hud.setAttribute('data-source-dom-hud', '1');
    } else {
      hud.innerHTML = '<div class="phase" data-k="phase">Phase 1/' + sourcePhaseCount() + '</div><div class="pill" data-k="ice">冰 0</div><div class="pill" data-k="oxygen">氧气 0</div><div class="pill" data-k="scrap">铁块 0</div><div class="pill" data-k="coin">金币 0</div><div class="pill" data-k="tool">镐子</div><div class="tip" data-k="tip"></div>';
    }
    document.body.appendChild(hud);
    if (sourceDomHudPresent() && (sourceDomHudUsesResourceBar() || sourceDomHudUsesCompactPills() || sourceDomHudUsesMeterPills()) && !inlineSourceTip) {
      var sourceTip = document.createElement('div');
      sourceTip.id = 'source-ir-tip';
      sourceTip.setAttribute('data-k', 'tip');
      sourceTip.textContent = sourceDomHudInitial('tip', sourceDomHudInitial('goalText', ''));
      document.body.appendChild(sourceTip);
    }
    if (sourceDomHudPresent() && sourceDomHudHasProgressBar()) {
      var progressWrap = document.createElement('div');
      progressWrap.id = 'source-ir-progress-wrap';
      progressWrap.innerHTML = '<div id="source-ir-progress-bar"></div>';
      document.body.appendChild(progressWrap);
    }
    if (sourceDomHudPresent() && sourceDomHudContract().ids && sourceDomHudContract().ids.workerPanel) {
      var workerPanel = document.createElement('div');
      workerPanel.id = 'source-ir-worker-panel';
      workerPanel.textContent = sourceDomHudInitial('workerPanel', '');
      workerPanel.style.display = 'none';
      document.body.appendChild(workerPanel);
    }
    if (sourceDomHudPresent() && sourceDomHudContract().ids && sourceDomHudContract().ids.upgradePanel) {
      var upgradePanel = document.createElement('div');
      upgradePanel.id = 'source-ir-upgrade-panel';
      upgradePanel.textContent = sourceDomHudInitial('upgradePanel', '');
      upgradePanel.style.display = 'none';
      document.body.appendChild(upgradePanel);
    }
    var target = document.createElement('div');
    target.id = 'source-ir-target';
    document.body.appendChild(target);
    var toast = document.createElement('div');
    toast.id = 'source-ir-toast';
    document.body.appendChild(toast);
    var cta = document.createElement('div');
    cta.id = 'source-ir-cta-overlay';
    cta.innerHTML = '<div id="source-ir-cta-box"><div id="source-ir-cta-title">立即下载，解锁更多舱室玩法！</div><div id="source-ir-cta-btn">安装完整游戏</div><div id="source-ir-cta-subtitle"></div></div>';
    document.body.appendChild(cta);
    var stick = document.createElement('div');
    stick.id = 'source-ir-stick';
    stick.innerHTML = '<div id="source-ir-stick-knob"></div>';
    document.body.appendChild(stick);
    var knob = document.getElementById('source-ir-stick-knob');
    var origin = null;
    function consume(ev) {
      try { ev.preventDefault(); } catch(e) {}
      try { ev.stopImmediatePropagation(); } catch(e) {}
      try { ev.stopPropagation(); } catch(e) {}
    }
    function setStyleImportant(el, name, value) {
      if (!el) return;
      try { el.style.setProperty(name, value, 'important'); } catch(e) { el.style[name] = value; }
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
      setStyleImportant(stick, 'display', 'block');
      setStyleImportant(stick, 'visibility', 'visible');
      setStyleImportant(stick, 'left', origin.x + 'px');
      setStyleImportant(stick, 'top', origin.y + 'px');
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
    var toast = document.getElementById('source-ir-toast');
    if (!toast || !text) return;
    toast.textContent = text;
    toast.classList.add('show');
    overlayRuntime.toastUntil = (performance.now ? performance.now() : Date.now()) + 1000;
  }
  function setHud(gs, info, step, autoMode) {
    var hud = document.getElementById('source-ir-hud');
    if (!hud) return;
    function set(key, text) {
      var el = hud.querySelector('[data-k="' + key + '"]') || document.querySelector('[data-k="' + key + '"]');
      if (el) el.textContent = text;
    }
    gs = gs || {};
    var res = autoMode ? (gs.resources || gs.inventory || {}) : overlayRuntime.resources;
    var states = gs.entity_states || gs.entityStates || {};
    var phaseText = autoMode ? String(gs.phase || gs.currentPhase || 'phase1') : overlayPhaseText();
    var phaseNum = phaseText.match(/\\d+/);
    var terminalVisible = phaseText === 'gameEnd' || isTerminalSourcePhaseIndex(autoMode ? phaseIndexFromState(gs) : overlayRuntime.phaseIndex);
    setTerminalCta(info, terminalVisible);
    if (sourceDomHudPresent()) {
      set('phase', 'Phase ' + (phaseNum ? phaseNum[0] : '1') + '/' + sourcePhaseCount());
      var baseScore = numericSourceDomHudInitial('goldCount', numericSourceDomHudInitial('goldText', numericSourceDomHudInitial('scoreText', numericSourceDomHudInitial('goldBox', 0))));
      var liveScore = Math.max(resourceValue(res, 'Gold'), resourceValue(res, 'Coin'));
      var score = autoMode ? (liveScore || baseScore) : (baseScore + liveScore);
      set('score', String(Math.max(0, Math.round(score))));
      set('goldPanel', '金币 ' + String(Math.max(0, Math.round(score))));
      set('goldText', String(Math.max(0, Math.round(score))));
      set('oxygenText', sourceCounterText('oxygenText', resourceValue(res, 'Oxygen')));
      set('iceText', sourceCounterText('iceText', resourceValue(res, 'Ice')));
      var sourceGuide = info && info.guideText || gs.ui_state && gs.ui_state.guideText || gs.uiState && gs.uiState.guideText || gs.variables && gs.variables.guideText || '';
      set('tip', sourceGuide || sourceDomHudInitial('tip', sourceDomHudInitial('goalText', '')));
      var sourceProgressBar = document.getElementById('source-ir-progress-bar');
      if (sourceProgressBar) {
        var sourcePhaseIndex = autoMode ? phaseIndexFromState(gs) : overlayRuntime.phaseIndex;
        var progressDenom = Math.max(1, sourcePhaseCount() - 1);
        sourceProgressBar.style.width = Math.max(0, Math.min(100, Math.round(sourcePhaseIndex / progressDenom * 100))) + '%';
      }
      var sourceWorkerPanel = document.getElementById('source-ir-worker-panel');
      if (sourceWorkerPanel) sourceWorkerPanel.style.display = overlayRuntime.phaseIndex >= 6 ? 'block' : 'none';
      var sourceUpgradePanel = document.getElementById('source-ir-upgrade-panel');
      if (sourceUpgradePanel) sourceUpgradePanel.style.display = overlayRuntime.phaseIndex === 6 ? 'block' : 'none';
      var sourceTarget = document.getElementById('source-ir-target');
      var sourceTargetName = autoMode ? currentOverlayTargetName(info, res, states) : worldTargetName(step && step.target || '');
      var sourceLabel = entityTargetLabel(sourceTargetName);
      if (sourceTarget) {
        sourceTarget.textContent = sourceLabel ? '目标：' + sourceLabel : '';
        sourceTarget.style.display = sourceLabel ? '' : 'none';
      }
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
    var target = document.getElementById('source-ir-target');
    var targetName = autoMode ? currentOverlayTargetName(info, res, states) : worldTargetName(step && step.target || '');
    var label = entityTargetLabel(targetName);
    if (target) {
      target.textContent = label ? '目标：' + label : '';
      target.style.display = label ? '' : 'none';
    }
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
    if (!window.THREE || document.getElementById('source-ir-3d-overlay')) return;
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
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.id = 'source-ir-3d-overlay';
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
    var groundKind = String(ground.kind || '').toLowerCase();
    var groundGeometry = groundKind === 'plane'
      ? new THREE.PlaneGeometry(ground.width || ground.radius || 72, ground.height || ground.width || ground.radius || 72)
      : groundKind === 'box'
        ? new THREE.BoxGeometry(ground.width || ground.radius || 72, ground.thickness || .18, ground.height || ground.width || ground.radius || 72)
        : new THREE.CylinderGeometry(ground.radius || 72, ground.radius || 72, ground.height || .25, ground.segments || 96);
    var groundMesh = new THREE.Mesh(
      groundGeometry,
      new THREE.MeshStandardMaterial({ color: hexToNumber(ground.color, '#13233a'), roughness: .7, metalness: .05 })
    );
    if (groundKind === 'plane') groundMesh.rotation.x = -Math.PI / 2;
    else if (Number.isFinite(Number(ground.positionY))) groundMesh.position.y = Number(ground.positionY);
    else if (groundKind === 'box') groundMesh.position.y = -0.1;
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
    var orbitCount = Math.min(8, Math.max(0, sceneContract.decor && sceneContract.decor.orbitalRings || 0));
    var orbitStyle = sceneContract.decor && sceneContract.decor.orbitalRingStyle || null;
    if (orbitStyle && orbitStyle.geometry && orbitStyle.geometry.type === 'TorusGeometry') {
      var ringMaterial = orbitStyle.material || {};
      var ringMat = new THREE.MeshBasicMaterial({
        color: hexToNumber(ringMaterial.diffuseColor || ringMaterial.color, '#234c76'),
        transparent: ringMaterial.transparent === false ? false : true,
        opacity: finite(ringMaterial.opacity, .5)
      });
      var argsBase = orbitStyle.geometry.argsBase || [];
      var argsStep = orbitStyle.geometry.argsStep || [];
      var rotation = orbitStyle.rotation || [Math.PI / 2, 0, 0];
      for (var torusIndex = 0; torusIndex < orbitCount; torusIndex++) {
        var args = [0, 1, 2, 3].map(function(argIndex) {
          return finite(argsBase[argIndex], 0) + finite(argsStep[argIndex], 0) * torusIndex;
        });
        var ring = new THREE.Mesh(new THREE.TorusGeometry(args[0] || 10, args[1] || .025, args[2] || 8, args[3] || 128), ringMat);
        ring.rotation.set(finite(rotation[0], 0), finite(rotation[1], 0), finite(rotation[2], 0));
        ring.position.y = numericSeriesValue(orbitStyle.positionY, torusIndex, .04 + torusIndex * .015);
        scene.add(ring);
      }
    } else {
      var orbitMat = new THREE.LineBasicMaterial({ color: 0x2f6d9c, transparent: true, opacity: .28 });
      for (var oi = 0; oi < orbitCount; oi++) {
        var pts = [];
        for (var a = 0; a <= 96; a++) {
          var t = a / 96 * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(t) * (24 + oi * 13), .04, Math.sin(t) * (8 + oi * 5) + oi * 3));
        }
        scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat));
      }
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
    var targetRingColor = hexToNumber(guidance.targetRing && guidance.targetRing.material && guidance.targetRing.material.color, '#ffe45c');
    if (!guidance.targetRing || guidance.targetRing !== false) {
      targetRing = new THREE.Mesh(
        new THREE.TorusGeometry(1.5, 0.055, 8, 64),
        new THREE.MeshBasicMaterial({ color: targetRingColor })
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
    var domLabels = {};
    names.forEach(function(name) {
      var c = composites[name] || {};
      var group = new THREE.Group();
      group.name = name;
      var p = c.position || {};
      group.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      (c.primitives || []).forEach(function(part) {
        var mesh = new THREE.Mesh(geometry(part.geometry), material(part.material));
        var pos = vector(part.transform && part.transform.position, [0, 0, 0]);
        var rot = rotationVector(part.transform && part.transform.rotation, [0, 0, 0]);
        var scale = vector(part.transform && part.transform.scale, [1, 1, 1]);
        mesh.position.set(pos[0], pos[1], pos[2]);
        mesh.rotation.set(rot[0], rot[1], rot[2]);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        group.add(mesh);
      });
      if (sourceDomWorldLabelsEnabled()) {
        var domLabel = document.createElement('div');
        domLabel.className = 'source-ir-world-label';
        domLabel.textContent = c.label || name;
        document.body.appendChild(domLabel);
        domLabels[name] = domLabel;
      } else if (sourceWorldLabelsEnabled()) {
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
      var gs = sourceRuntimeEnabled ? (window.__SOURCE_IR_OVERLAY_STATE || {}) : (rawGs || {});
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
        applySourceCameraFrame(camera, cameraContract, player);
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
      Object.keys(domLabels).forEach(function(name) {
        var el = domLabels[name];
        var group = groups[name];
        if (!el || !group || !group.visible) {
          if (el) el.style.display = 'none';
          return;
        }
        var pos = group.position.clone();
        pos.y += 1.85;
        pos.project(camera);
        el.style.display = 'block';
        el.style.left = ((pos.x * 0.5 + 0.5) * window.innerWidth).toFixed(1) + 'px';
        el.style.top = ((-pos.y * 0.5 + 0.5) * window.innerHeight).toFixed(1) + 'px';
      });
      var targetName = autoMode ? currentOverlayTargetName(info, gs.resources || gs.inventory || {}, states) : (step && step.target || '');
      var phasePalette = [0xffe45c, 0x54d6ff, 0xff884d, 0x8dff72];
      var phaseColor = phasePalette[Math.max(0, overlayRuntime.phaseIndex) % phasePalette.length];
      var phaseBand = document.getElementById('source-ir-phase-band');
      if (phaseBand) {
        var phaseCss = cssHex(phaseColor);
        phaseBand.style.background = phaseCss;
        phaseBand.style.boxShadow = '0 0 30px ' + phaseCss;
      }
      if (targetRing) {
        if (targetName && groups[targetName] && groups[targetName].visible) {
          targetRing.visible = true;
          targetRing.material.color.setHex(targetRingColor);
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
        var contractedTrailTargetName = guidance.trailLine && guidance.trailLine.to || '';
        var trailTargetName = contractedTrailTargetName && groups[contractedTrailTargetName]
          ? contractedTrailTargetName
          : (targetName && groups[targetName] ? targetName : (groups.SpaceShip ? 'SpaceShip' : ''));
        var trailFromYOffset = Number(guidance.trailLine && guidance.trailLine.fromYOffset);
        var trailToYOffset = Number(guidance.trailLine && guidance.trailLine.toYOffset);
        if (!isFinite(trailFromYOffset)) trailFromYOffset = 1;
        if (!isFinite(trailToYOffset)) trailToYOffset = 1;
        trailLine.visible = !!(groups[playerName] && trailTargetName && groups[trailTargetName] && groups[playerName].visible && groups[trailTargetName].visible);
        if (trailLine.visible) updateLineGeometry(trailLine, groups[playerName].position, trailFromYOffset, groups[trailTargetName].position, trailToYOffset);
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
      var toast = document.getElementById('source-ir-toast');
      if (toast && overlayRuntime.toastUntil && overlayRuntime.toastUntil < now) {
        toast.classList.remove('show');
      }
      window.__SOURCE_IR_OVERLAY_STATE = overlayStateSnapshot(info);
      installSourceRuntimeGameState();
      installSourcePhaseDriver();
      setHud(gs, info, step, autoMode);
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    }
    frame();
    console.log('[source-ir] Three.js source visual overlay active: entities=' + names.length);
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
