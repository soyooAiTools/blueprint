'use strict';

// task25 visual-shift-left field-level diff template.
// Consumed by engine/stages/fidelity-source-diff as ctx.fidelityFieldDiffTemplate.
// Compares per-phase observed snapshot (from source HTML and from built WebGL)
// against the v0.5 fidelityContract (golden baseline locked 2026-05-28 by task #24).
//
// Three buckets per phase:
//   1. entities[].primitives[]    — mesh/transform/material divergence
//   2. phases[].{spawn/hide/guide/target} — phase spec divergence
//   3. hud[]                       — slot/label text + anchor divergence
//
// Status enum per entry: ok|missing|extra|mismatch.
// Tolerance: floats 1e-3, strings byte-exact, arrays order-insensitive for
// entity lists / order-sensitive for steps[].
//
// Self-contained — no Node-only deps; the page-eval extractor function
// runs inside Playwright via page.evaluate(template.PAGE_EXTRACTOR).

const fs = require('fs');

const SCHEMA_VERSION = 'task25.field-diff@0.6.1';
const FLOAT_EPSILON = 1e-3;
const SCENE_DELTA_E_TOLERANCE = 5;

function loadContract(contractPath) {
  const raw = fs.readFileSync(contractPath, 'utf8');
  const c = JSON.parse(raw);
  if (c && c.contract && Array.isArray(c.contract.entities)) return c.contract;
  return c;
}

function canonicalEntityKey(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const stripped = s.charAt(0) === '_' ? s.slice(1) : s;
  if (stripped.length === 0) return stripped;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function mergeEntityDetailsByCanonicalKey(entityDetails) {
  const canonDetails = {};
  for (const k of Object.keys(entityDetails || {})) {
    const key = canonicalEntityKey(k);
    if (!key) continue;
    const dst = canonDetails[key] || {};
    const src = entityDetails[k] || {};
    for (const field of Object.keys(src)) {
      if (src[field] !== undefined) dst[field] = src[field];
    }
    canonDetails[key] = dst;
  }
  return canonDetails;
}

function indexContract(contract) {
  const phasesById = {};
  for (const p of contract.phases || []) phasesById[p.id] = p;

  const entitiesByFamily = {};
  for (const e of contract.entities || []) {
    const key = canonicalEntityKey(e.id || e.name);
    if (key) entitiesByFamily[key] = e;
  }

  const hudById = {};
  for (const h of contract.hud || []) hudById[h.id] = h;

  const uiOverlayEntities = new Set();
  const uiOverlayContract = contract.sourceEntityContract && contract.sourceEntityContract.uiOverlayContract
    || contract.uiOverlayContract
    || null;
  const uiOverlayItems = uiOverlayContract && Array.isArray(uiOverlayContract.entities)
    ? uiOverlayContract.entities
    : [];
  for (const item of uiOverlayItems) {
    const id = typeof item === 'string' ? item : item && (item.id || item.name);
    const key = canonicalEntityKey(id);
    if (key) uiOverlayEntities.add(key);
  }

  return { contract, phasesById, entitiesByFamily, hudById, uiOverlayEntities };
}

function expectedVisibleForPhase(indexed, phaseId) {
  const phase = indexed.phasesById[phaseId];
  if (!phase) return null;
  const set = new Set();
  for (const x of (phase.showEntities || [])) set.add(canonicalEntityKey(x));
  for (const x of (phase.hideEntities || [])) set.delete(canonicalEntityKey(x));
  set.add('Player');
  return set;
}

function floatEq(a, b, eps) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= (eps == null ? FLOAT_EPSILON : eps);
}

function vec3Eq(a, b) {
  if (!a || !b) return a === b;
  return floatEq(a.x, b.x) && floatEq(a.y, b.y) && floatEq(a.z, b.z);
}

function rgbaEq(a, b) {
  if (!a || !b) return a === b;
  return floatEq(a.r, b.r) && floatEq(a.g, b.g) && floatEq(a.b, b.b) && floatEq(a.a, b.a);
}

function setEq(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function diffEntitiesBucket(indexed, phaseId, observed) {
  const entries = [];
  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  const observedVisible = new Set();
  for (const x of (observed.visibleEntities || [])) observedVisible.add(canonicalEntityKey(x));

  for (const name of expectedVisible) {
    if (!observedVisible.has(name)) {
      entries.push({
        entityFamily: name,
        status: 'missing',
        diffPaths: [{ path: '$.visible', expected: true, observed: false }],
        blocking: true,
        provenance: provenanceForEntity(indexed, name),
      });
    }
  }

  for (const name of observedVisible) {
    if (!expectedVisible.has(name)) {
      if (indexed.uiOverlayEntities && indexed.uiOverlayEntities.has(name)) continue;
      entries.push({
        entityFamily: name,
        status: 'extra',
        diffPaths: [{ path: '$.visible', expected: false, observed: true }],
        blocking: true,
        provenance: { source: 'observed-only', note: 'phantom entity not in contract' },
      });
    }
  }

  if (observed.entityDetails) {
    const canonDetails = mergeEntityDetailsByCanonicalKey(observed.entityDetails);
    for (const name of expectedVisible) {
      if (!observedVisible.has(name)) continue;
      const exp = indexed.entitiesByFamily[name];
      const obs = canonDetails[name];
      if (!exp || !obs) continue;
      const primDiffs = diffEntityPrimitives(exp, obs);
      if (primDiffs.length > 0) {
        entries.push({
          entityFamily: name,
          status: 'mismatch',
          diffPaths: primDiffs,
          blocking: true,
          provenance: provenanceForEntity(indexed, name),
        });
      }
    }
  }
  return entries;
}

function diffEntityPrimitives(expected, observed) {
  const diffs = [];
  if (!observed || !Array.isArray(observed.primitives)) return diffs;
  const expPrims = expected.primitives || [];
  const obsPrims = observed.primitives || [];
  const obsById = {};
  for (const op of obsPrims) obsById[op.id] = op;

  for (const ep of expPrims) {
    const op = obsById[ep.primitiveId || ep.id];
    if (!op) {
      diffs.push({ path: `$.primitives[${ep.primitiveId || ep.id}]`, expected: '<present>', observed: '<missing>' });
      continue;
    }
    if (ep.mesh && op.mesh && ep.mesh.kind !== op.mesh.kind) {
      diffs.push({ path: `$.primitives[${ep.primitiveId}].mesh.kind`, expected: ep.mesh.kind, observed: op.mesh.kind });
    }
    if (ep.transform && op.transform && !vec3Eq(ep.transform.localPosition, op.transform.localPosition)) {
      diffs.push({
        path: `$.primitives[${ep.primitiveId}].transform.localPosition`,
        expected: ep.transform.localPosition,
        observed: op.transform.localPosition,
      });
    }
    if (ep.material && ep.material.colors && op.material && op.material.colors) {
      for (const k of ['_BaseColor', '_Color', '_ColorTint', '_EmissionColor']) {
        if (ep.material.colors[k] && op.material.colors[k] &&
            !rgbaEq(ep.material.colors[k], op.material.colors[k])) {
          diffs.push({
            path: `$.primitives[${ep.primitiveId}].material.colors.${k}`,
            expected: ep.material.colors[k],
            observed: op.material.colors[k],
          });
        }
      }
    }
  }
  return diffs;
}

function provenanceForEntity(indexed, name) {
  const e = indexed.entitiesByFamily[name];
  if (!e) return null;
  return {
    source: 'unity-contract',
    confidence: e.provenance && e.provenance.confidence,
    primitiveCount: (e.primitives || []).length,
  };
}

function diffPhasesBucket(indexed, phaseId, observed) {
  const phase = indexed.phasesById[phaseId];
  if (!phase) {
    return [{
      phaseId,
      status: 'missing',
      diffPaths: [{ path: '$', expected: '<phase in contract>', observed: '<not found>' }],
      blocking: true,
    }];
  }
  const entries = [];
  const expShowList = (phase.showEntities || []).map(canonicalEntityKey);
  const expHideList = (phase.hideEntities || []).map(canonicalEntityKey);
  const exp = {
    showEntities: expShowList,
    hideEntities: expHideList,
    guideText: (phase.phaseSpec && phase.phaseSpec.guideText)
      || (phase.manualGate && phase.manualGate.guideText)
      || (phase.trigger && phase.trigger.guideText)
      || phase.guideText || '',
    targetEntity: canonicalEntityKey((phase.trigger && phase.trigger.targetEntity) || null) || null,
  };
  const obs = observed.phaseSpec || {};
  const diffPaths = [];

  if (obs.showEntities !== undefined) {
    const expShow = new Set(expShowList);
    const obsShow = new Set(obs.showEntities.map(canonicalEntityKey));
    if (!setEq(expShow, obsShow)) {
      const missingEntities = [...expShow].filter(x => !obsShow.has(x));
      const extraEntities = [...obsShow].filter(x => !expShow.has(x));
      diffPaths.push({
        path: '$.showEntities',
        expected: [...expShow].sort(),
        observed: [...obsShow].sort(),
        missingEntities,
        extraEntities,
      });
    }
  }

  if (obs.guideText !== undefined && exp.guideText !== obs.guideText) {
    diffPaths.push({ path: '$.guideText', expected: exp.guideText, observed: obs.guideText });
  }

  const obsTarget = obs.targetEntity === undefined ? undefined : (canonicalEntityKey(obs.targetEntity) || null);
  if (obsTarget !== undefined && exp.targetEntity !== obsTarget) {
    diffPaths.push({ path: '$.targetEntity', expected: exp.targetEntity, observed: obsTarget });
  }

  if (diffPaths.length > 0) {
    entries.push({
      phaseId,
      status: 'mismatch',
      diffPaths,
      blocking: true,
      provenance: phase.provenance || null,
    });
  }
  return entries;
}

const WORLD_LABEL_HUD_ID_RE = /^label\./;

function isV13RichWorldLabel(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return false;
  if (typeof spec.text !== 'string') return false;
  var wo = spec.worldOffset;
  return wo !== null && typeof wo === 'object' && !Array.isArray(wo);
}

var V14D_POLYMORPHIC_ELIGIBLE_HUD_IDS = new Set(['hud.phase', 'hud.tip', 'hud.targethint']);

function gteVersionLocal(a, target) {
  if (typeof a !== 'string') return false;
  var av = a.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  var tv = target.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < Math.max(av.length, tv.length); i++) {
    var x = av[i] || 0, y = tv[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function resolvePolymorphicText(spec, phaseId) {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec === 'string') return spec;
  if (typeof spec === 'object') {
    if (spec.perPhase && Object.prototype.hasOwnProperty.call(spec.perPhase, phaseId)) {
      return spec.perPhase[phaseId];
    }
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) return spec.default;
    if (typeof spec.text === 'string') return spec.text;
  }
  return undefined;
}

function clamp01(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function srgbChannelToLinear(c) {
  c = clamp01(c);
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(rgb) {
  const r = srgbChannelToLinear(rgb && rgb[0]);
  const g = srgbChannelToLinear(rgb && rgb[1]);
  const b = srgbChannelToLinear(rgb && rgb[2]);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = (r * 0.2126729 + g * 0.7151522 + b * 0.0721750);
  const z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  function f(t) {
    return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
  }
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return Infinity;
  const labA = rgbToLab(a);
  const labB = rgbToLab(b);
  return Math.sqrt(
    Math.pow(labA[0] - labB[0], 2) +
    Math.pow(labA[1] - labB[1], 2) +
    Math.pow(labA[2] - labB[2], 2)
  );
}

function medianNumber(values) {
  const nums = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return Infinity;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function sceneSampleRgb(sample) {
  if (Array.isArray(sample)) return sample;
  if (sample && Array.isArray(sample.rgb)) return sample.rgb;
  return null;
}

function sceneDeltaSummary(expected, observed, samples) {
  let sourceSamples = Array.isArray(samples) && samples.length
    ? samples.filter((sample) => !(sample && sample.ignored)).map(sceneSampleRgb).filter(Boolean)
    : [observed];
  if (!sourceSamples.length && Array.isArray(samples) && samples.length) {
    sourceSamples = samples.map(sceneSampleRgb).filter(Boolean);
  }
  const deltas = sourceSamples.map((rgb) => deltaE76(expected, rgb));
  return {
    medianDeltaE: medianNumber(deltas),
    maxDeltaE: deltas.filter(Number.isFinite).reduce((m, n) => Math.max(m, n), 0),
    toleranceDeltaE: SCENE_DELTA_E_TOLERANCE,
    samples: (samples || []).map((sample, i) => {
      const rgb = sceneSampleRgb(sample);
      const out = {
        index: i,
        rgb,
        deltaE: deltaE76(expected, rgb),
      };
      if (sample && !Array.isArray(sample)) {
        if (sample.point) out.point = sample.point;
        if (Number.isFinite(sample.x)) out.x = sample.x;
        if (Number.isFinite(sample.y)) out.y = sample.y;
        if (sample.ignored) out.ignored = true;
        if (sample.ignoredReason) out.ignoredReason = sample.ignoredReason;
      }
      return out;
    }),
  };
}

function sceneDeltaBlocks(summary) {
  if (!summary) return true;
  return summary.medianDeltaE > SCENE_DELTA_E_TOLERANCE ||
    summary.maxDeltaE > SCENE_DELTA_E_TOLERANCE * 2;
}

function diffHudBucket(indexed, phaseId, observed) {
  const entries = [];
  const expectedHud = (indexed.contract.hud || []).filter(h => !WORLD_LABEL_HUD_ID_RE.test(h.id));
  const obsBySlot = {};
  for (const h of observed.hud || []) {
    const key = h.id || ('hud.' + (h.slot || '').toLowerCase());
    obsBySlot[key] = h;
  }
  const expIds = new Set(expectedHud.map(h => h.id));
  const obsIds = new Set(Object.keys(obsBySlot));
  const contractSchemaVersion = (indexed.contract && indexed.contract.schemaVersion) || '1.0.0';
  const v14dOrLater = gteVersionLocal(contractSchemaVersion, '1.4.0');

  for (const exp of expectedHud) {
    const expectedText = resolvePolymorphicText(exp.text, phaseId);
    const obs = obsBySlot[exp.id];
    if (!obs) {
      if (expectedText === '' || expectedText === undefined) continue;
      entries.push({
        id: exp.id,
        role: exp.role,
        slot: exp.slot,
        status: 'missing',
        diffPaths: [{ path: '$', expected: '<present>', observed: '<missing>' }],
        blocking: true,
        provenance: exp.provenance || null,
      });
      continue;
    }
    if (expectedText === undefined) continue;
    const diffPaths = [];
    if (obs.text !== undefined && expectedText !== obs.text) {
      diffPaths.push({ path: '$.text', expected: expectedText, observed: obs.text });
    }
    if (obs.anchor && exp.anchor &&
        (!floatEq(exp.anchor.anchoredPosition.x, obs.anchor.anchoredPosition.x) ||
         !floatEq(exp.anchor.anchoredPosition.y, obs.anchor.anchoredPosition.y))) {
      diffPaths.push({
        path: '$.anchor.anchoredPosition',
        expected: exp.anchor.anchoredPosition,
        observed: obs.anchor.anchoredPosition,
      });
    }
    if (obs.style && exp.style && !floatEq(exp.style.fontSize, obs.style.fontSize)) {
      diffPaths.push({ path: '$.style.fontSize', expected: exp.style.fontSize, observed: obs.style.fontSize });
    }
    if (diffPaths.length > 0) {
      const isPlainStringText = (typeof exp.text === 'string');
      const isPolymorphicEligible = V14D_POLYMORPHIC_ELIGIBLE_HUD_IDS.has(exp.id);
      const downgradeToAdvisory = (
        isPolymorphicEligible && isPlainStringText && !v14dOrLater
        && diffPaths.length === 1 && diffPaths[0].path === '$.text'
      );
      entries.push({
        id: exp.id,
        role: exp.role,
        slot: exp.slot,
        status: 'mismatch',
        diffPaths,
        blocking: !downgradeToAdvisory,
        provenance: exp.provenance || null,
      });
    }
  }
  for (const id of obsIds) {
    if (!expIds.has(id)) {
      entries.push({
        id,
        status: 'extra',
        diffPaths: [{ path: '$', expected: '<not in contract>', observed: obsBySlot[id].text }],
        blocking: true,
        provenance: { source: 'observed-only' },
      });
    }
  }
  return entries;
}

function diffWorldLabelBucket(indexed, phaseId, observed) {
  const entries = [];
  const expected = {};
  for (const e of (indexed.contract.entities || [])) {
    if (e.worldLabel === undefined) continue;
    const key = canonicalEntityKey(e.id || e.name);
    expected[key] = {
      entityId: e.id || e.name,
      textSpec: e.worldLabel,
      provenance: e.provenance || null,
      source: 'entities.worldLabel',
      isRich: isV13RichWorldLabel(e.worldLabel),
    };
  }
  for (const h of (indexed.contract.hud || [])) {
    if (!WORLD_LABEL_HUD_ID_RE.test(h.id)) continue;
    const entityName = h.id.replace(WORLD_LABEL_HUD_ID_RE, '');
    const key = canonicalEntityKey(entityName);
    if (expected[key]) continue;
    expected[key] = {
      entityId: entityName,
      textSpec: h.text,
      provenance: h.provenance || { source: 'hud.label.* (v0.5 transitional)' },
      source: 'hud.label',
      isRich: false,
    };
  }

  const observedLabels = {};
  for (const id of Object.keys(observed.entityDetails || {})) {
    const det = observed.entityDetails[id];
    if (det && det.worldLabel !== undefined) {
      observedLabels[canonicalEntityKey(id)] = det.worldLabel;
    }
  }

  for (const key of Object.keys(expected)) {
    const spec = expected[key];
    const expectedText = resolvePolymorphicText(spec.textSpec, phaseId);
    if (expectedText === undefined) continue;
    const obsText = observedLabels[key];
    if (obsText === undefined) {
      if (expectedText === '') continue;
      entries.push({
        entityId: spec.entityId,
        status: 'missing',
        diffPaths: [{ path: '$', expected: expectedText, observed: '<missing>' }],
        blocking: spec.isRich === true,
        provenance: spec.provenance,
        source: spec.source,
      });
      continue;
    }
    if (obsText !== expectedText) {
      entries.push({
        entityId: spec.entityId,
        status: 'mismatch',
        diffPaths: [{ path: '$.text', expected: expectedText, observed: obsText }],
        blocking: spec.isRich === true,
        provenance: spec.provenance,
        source: spec.source,
      });
    }
  }
  return entries;
}

function diffSceneBucket(indexed, phaseId, observed) {
  const entries = [];
  const exp = indexed.contract.scene;
  if (!exp || !Array.isArray(exp.backgroundColor) || exp.backgroundColor.length < 3) {
    return entries;
  }
  const expBg = exp.backgroundColor;
  const obsScene = observed && observed.scene;
  const obsBg = obsScene && obsScene.backgroundColor;
  if (obsBg === undefined || obsBg === null) {
    entries.push({
      key: 'backgroundColor',
      status: 'missing',
      diffPaths: [{ path: '$.scene.backgroundColor', expected: expBg, observed: '<missing>' }],
      blocking: true,
      provenance: exp.provenance || null,
    });
    return entries;
  }
  const actualSummary = sceneDeltaSummary(expBg, obsBg, obsScene && obsScene.backgroundColorSamples);
  if (!Array.isArray(obsBg) || obsBg.length < 3 || sceneDeltaBlocks(actualSummary)) {
    entries.push({
      key: 'backgroundColor',
      status: 'mismatch',
      diffPaths: [{
        path: '$.scene.backgroundColor',
        expected: expBg,
        observed: obsBg,
        source: obsScene && obsScene.backgroundColorSource || 'unknown',
        medianDeltaE: actualSummary.medianDeltaE,
        maxDeltaE: actualSummary.maxDeltaE,
        toleranceDeltaE: actualSummary.toleranceDeltaE,
        samples: actualSummary.samples,
      }],
      blocking: true,
      provenance: exp.provenance || null,
    });
  }
  const declaredBg = obsScene && obsScene.declaredBackgroundColor;
  const declaredSummary = Array.isArray(declaredBg) && declaredBg.length >= 3 && Array.isArray(obsBg) && obsBg.length >= 3
    ? sceneDeltaSummary(declaredBg, obsBg, obsScene && obsScene.backgroundColorSamples)
    : null;
  if (declaredSummary && sceneDeltaBlocks(declaredSummary)) {
    entries.push({
      key: 'backgroundColor.actual',
      status: 'declaration-render-mismatch',
      diffPaths: [{
        path: '$.scene.backgroundColor',
        expected: declaredBg,
        observed: obsBg,
        declared: declaredBg,
        actual: obsBg,
        source: obsScene && obsScene.backgroundColorSource || 'unknown',
        medianDeltaE: declaredSummary.medianDeltaE,
        maxDeltaE: declaredSummary.maxDeltaE,
        toleranceDeltaE: declaredSummary.toleranceDeltaE,
        samples: declaredSummary.samples,
      }],
      blocking: true,
      provenance: exp.provenance || null,
    });
  }
  return entries;
}

function diffPrimitiveStyleBucket(indexed, phaseId, observed) {
  const entries = [];
  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  if (!expectedVisible) return entries;
  const observedVisible = new Set();
  for (const x of (observed.visibleEntities || [])) observedVisible.add(canonicalEntityKey(x));
  const canonDetails = mergeEntityDetailsByCanonicalKey(observed.entityDetails);

  for (const name of expectedVisible) {
    const expEntity = indexed.entitiesByFamily[name];
    if (!expEntity || !expEntity.primitiveStyle) continue;
    if (!observedVisible.has(name)) continue;
    const expStyle = expEntity.primitiveStyle;
    const obs = canonDetails[name];
    const obsStyle = obs && obs.primitiveStyle;
    if (!obsStyle) {
      entries.push({
        entityId: expEntity.id || expEntity.name,
        status: 'missing',
        diffPaths: [{ path: '$.primitiveStyle', expected: expStyle, observed: '<missing>' }],
        blocking: true,
        provenance: expEntity.provenance || null,
      });
      continue;
    }
    const diffPaths = [];
    if (typeof expStyle.modelRef === 'string' && expStyle.modelRef !== obsStyle.modelRef) {
      diffPaths.push({
        path: '$.primitiveStyle.modelRef',
        expected: expStyle.modelRef,
        observed: obsStyle.modelRef === undefined ? '<missing>' : obsStyle.modelRef,
      });
    }
    if (Array.isArray(expStyle.baseColor) && expStyle.baseColor.length >= 3) {
      const c1 = expStyle.baseColor;
      const c2 = obsStyle.baseColor;
      if (!Array.isArray(c2) || c2.length < 3 ||
          !floatEq(c1[0], c2[0]) || !floatEq(c1[1], c2[1]) || !floatEq(c1[2], c2[2])) {
        diffPaths.push({
          path: '$.primitiveStyle.baseColor',
          expected: c1,
          observed: c2 === undefined ? '<missing>' : c2,
        });
      }
    }
    if (diffPaths.length > 0) {
      entries.push({
        entityId: expEntity.id || expEntity.name,
        status: 'mismatch',
        diffPaths,
        blocking: true,
        provenance: expEntity.provenance || null,
      });
    }
  }
  return entries;
}

function diffPhase(indexed, phaseId, observed) {
  const entities = diffEntitiesBucket(indexed, phaseId, observed);
  const phases = diffPhasesBucket(indexed, phaseId, observed);
  const hud = diffHudBucket(indexed, phaseId, observed);
  const worldLabel = diffWorldLabelBucket(indexed, phaseId, observed);
  const scene = diffSceneBucket(indexed, phaseId, observed);
  const primitiveStyle = diffPrimitiveStyleBucket(indexed, phaseId, observed);
  return { entities, phases, hud, worldLabel, scene, primitiveStyle };
}

function summarize(perPhase) {
  let totalDiffs = 0;
  let blocking = 0;
  const bucketTotals = { entities: 0, phases: 0, hud: 0, worldLabel: 0, scene: 0, primitiveStyle: 0 };
  for (const p of perPhase) {
    for (const bucket of ['entities', 'phases', 'hud', 'worldLabel', 'scene', 'primitiveStyle']) {
      for (const e of (p.buckets[bucket] || [])) {
        totalDiffs++;
        bucketTotals[bucket]++;
        if (e.blocking) blocking++;
      }
    }
  }
  return { totalDiffs, blocking, nonBlocking: totalDiffs - blocking, buckets: bucketTotals };
}

function buildReport({ contractPath, sourceKind, observedKind, perPhase, producerVersion }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    producerVersion: producerVersion || SCHEMA_VERSION,
    contract: {
      version: 'task24-unity-reverse-extractor@0.5',
      path: contractPath,
    },
    source: sourceKind,
    observed: observedKind,
    summary: summarize(perPhase),
    perPhase,
  };
}

const SOURCE_PAGE_EXTRACTOR = function(args) {
  const { phaseId } = args || {};
  const out = {
    phaseId,
    visibleEntities: [],
    entityDetails: {},
    phaseSpec: {},
    hud: [],
    worldLabels: {},
  };
  let gs = null;
  if (typeof window !== 'undefined' && window.__gameState != null) {
    gs = (typeof window.__gameState === 'function') ? window.__gameState() : window.__gameState;
  }
  if (gs && gs.visibleEntities) out.visibleEntities = gs.visibleEntities.slice();
  else if (gs && gs.entity_states) {
    out.visibleEntities = Object.keys(gs.entity_states).filter(n => gs.entity_states[n].visible);
  }
  if (typeof window !== 'undefined' && Array.isArray(window.PHASES)) {
    const idx = (gs && typeof gs.phase === 'string') ? parseInt(gs.phase.replace('phase', ''), 10) - 1 : 0;
    const p = window.PHASES[idx];
    if (p) {
      out.phaseSpec = {
        showEntities: (p.showEntities || []).slice(),
        hideEntities: (p.hideEntities || []).slice(),
        guideText: p.guideText || '',
        targetEntity: (p.steps && p.steps[0] && p.steps[0].target) || null,
      };
    }
  }
  const HUD_SELECTORS = {
    'hud.coin':       '#coinHud',
    'hud.ice':        '#iceHud',
    'hud.oxygen':     '#oxygenHud',
    'hud.phase':      '#phaseLabel',
    'hud.pickaxe':    '#toolHud',
    'hud.scrap':      '#scrapHud',
    'hud.steptoast':  '#toast',
    'hud.targethint': '#targetHint',
    'hud.tip':        '#tip',
  };
  for (const id of Object.keys(HUD_SELECTORS)) {
    const el = document.querySelector(HUD_SELECTORS[id]);
    if (el) {
      out.hud.push({
        id,
        slot: id.replace('hud.', ''),
        text: (el.textContent || '').trim(),
      });
    }
  }
  out.extractorKind = 'source';
  return out;
};

const WEBGL_PAGE_EXTRACTOR = function(args) {
  const safeArgs = args || {};
  const phaseId = safeArgs.phaseId;
  const out = {
    phaseId: phaseId,
    visibleEntities: [],
    entityDetails: {},
    phaseSpec: {},
    hud: [],
    worldLabels: {},
    extractorKind: 'webgl-playcanvas',
  };
  let pcApp = null;
  try {
    if (typeof window !== 'undefined') {
      pcApp = (window.app && window.app.app) ||
              (window.pc && window.pc.Application &&
               typeof window.pc.Application.getApplication === 'function' &&
               window.pc.Application.getApplication()) || null;
    }
  } catch (e) { pcApp = null; }

  let gs = null;
  try {
    if (typeof window !== 'undefined' && window.__gameState != null) {
      gs = (typeof window.__gameState === 'function') ? window.__gameState() : window.__gameState;
    }
  } catch (e) { gs = null; }

  function hasEntityStatesShape(candidate) {
    return !!(candidate && typeof candidate === 'object' &&
      ((candidate.entity_states && typeof candidate.entity_states === 'object') ||
       (candidate.entityStates && typeof candidate.entityStates === 'object')));
  }

  function normalizeGameState(candidate) {
    let cur = candidate;
    for (let i = 0; i < 8; i++) {
      if (!cur || typeof cur !== 'object') return cur;
      if (hasEntityStatesShape(cur)) return cur;
      const next = cur.state ||
        cur.gameState ||
        cur.game_state ||
        cur.runtimeState ||
        cur.runtime_state ||
        cur.__gameState ||
        cur.current ||
        cur.snapshot ||
        cur.payload ||
        cur.data ||
        cur.value;
      if (!next || next === cur) return cur;
      cur = next;
    }
    return cur;
  }

  function getEntityStates(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const states = candidate.entity_states || candidate.entityStates;
    return states && typeof states === 'object' ? states : null;
  }

  gs = normalizeGameState(gs);
  const authoritativeEntityStates = getEntityStates(gs);
  const hasAuthoritativeEntityState = !!authoritativeEntityStates;

  const visible = {};
  const stateHidden = {};
  if (hasAuthoritativeEntityState) {
    const keys = Object.keys(authoritativeEntityStates);
    for (let i = 0; i < keys.length; i++) {
      const st = authoritativeEntityStates[keys[i]];
      if (st && st.visible !== false) visible[keys[i]] = true;
      else stateHidden[keys[i]] = true;
    }
  }
  const storyboardEntities = {};
  if (!hasAuthoritativeEntityState && pcApp && pcApp.root) {
    const SKIP = {
      '__BaseTemplate': 1, '__LunaPool': 1,
      '__AUTOPLAY_ON__': 1, '__CUA_OBSERVER_READY__': 1,
      'Untitled': 1, 'EventSystem': 1, 'Canvas': 1,
    };
    const PRIMITIVE_NAMES = { Cube: 1, Sphere: 1, Cylinder: 1, Plane: 1, Capsule: 1, Quad: 1 };
    const SKIP_PREFIX = ['Storyboard'];
    const isSkipped = function(n) {
      if (SKIP[n] || PRIMITIVE_NAMES[n]) return true;
      for (let p = 0; p < SKIP_PREFIX.length; p++) {
        if (n.indexOf(SKIP_PREFIX[p]) === 0) return true;
      }
      return false;
    };
    const stack = [pcApp.root];
    let safety = 0;
    while (stack.length && safety++ < 5000) {
      const node = stack.shift();
      if (!node) continue;
      const name = node._name || node.name || '';
      const sbm = name && name.indexOf('StoryboardEntity_') === 0 ? name.slice('StoryboardEntity_'.length) : null;
      if (sbm && node.enabled !== false) storyboardEntities[sbm] = true;
      if (name && !isSkipped(name) && !stateHidden[name]
          && /^[A-Z][A-Za-z0-9]*$/.test(name) && node.enabled !== false) {
        visible[name] = true;
      }
      const children = node._children || node.children || [];
      for (let j = 0; j < children.length; j++) stack.push(children[j]);
    }
  }
  if (hasAuthoritativeEntityState) {
    out.visibleEntities = Object.keys(visible);
    out.visibleSource = 'entity_states';
  } else if (Object.keys(storyboardEntities).length > 0) {
    out.visibleEntities = Object.keys(storyboardEntities);
    out.visibleSource = 'storyboard-overlay';
  } else {
    out.visibleEntities = Object.keys(visible);
    out.visibleSource = 'tree';
  }

  if (gs) {
    var tipEl = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('bp-storyboard-tip') : null;
    var tipText = tipEl ? (tipEl.textContent || '').trim() : '';
    out.phaseSpec.guideText = tipText ||
                              (gs.ui_state && gs.ui_state.guideText) ||
                              (gs.uiState && gs.uiState.guideText) ||
                              (gs.variables && gs.variables.guideText) || '';
    out.phaseSpec.targetEntity = (gs.variables && gs.variables.targetEntity) ||
                                 gs.targetEntity || null;
  }

  const TARGET_HUD_SELECTORS = {
    'hud.coin':       '#bp-storyboard-coin',
    'hud.ice':        '#bp-storyboard-ice',
    'hud.oxygen':     '#bp-storyboard-oxygen',
    'hud.phase':      '#bp-storyboard-phase',
    'hud.pickaxe':    '#bp-storyboard-tool',
    'hud.scrap':      '#bp-storyboard-scrap',
    'hud.tip':        '#bp-storyboard-tip',
    'hud.targethint': '#bp-storyboard-target',
  };
  const hudIds = Object.keys(TARGET_HUD_SELECTORS);
  for (let k = 0; k < hudIds.length; k++) {
    const id = hudIds[k];
    const el = document.querySelector(TARGET_HUD_SELECTORS[id]);
    if (el) {
      out.hud.push({
        id: id,
        slot: id.replace('hud.', ''),
        text: (el.textContent || '').trim(),
      });
    }
  }

  try {
    function clamp01(n) {
      n = Number(n);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(1, n));
    }
    function rgbFromColorObj(c) {
      if (!c || typeof c.r !== 'number') return null;
      return [clamp01(c.r), clamp01(c.g), clamp01(c.b)];
    }
    function medianComponent(values) {
      values = values.slice().sort(function(a, b) { return a - b; });
      if (!values.length) return 0;
      var mid = Math.floor(values.length / 2);
      return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
    function medianRgb(samples) {
      if (!samples || !samples.length) return null;
      var usable = samples.filter(function(s) { return !s.ignored; });
      if (!usable.length) usable = samples;
      return [
        medianComponent(usable.map(function(s) { return s.rgb[0]; })),
        medianComponent(usable.map(function(s) { return s.rgb[1]; })),
        medianComponent(usable.map(function(s) { return s.rgb[2]; }))
      ];
    }
    function sceneFromBridge() {
      if (typeof window === 'undefined' || !window.__storyboardSceneDetails) return null;
      var bg = window.__storyboardSceneDetails.backgroundColor;
      if (!Array.isArray(bg) || bg.length < 3) return null;
      return [clamp01(bg[0]), clamp01(bg[1]), clamp01(bg[2])];
    }
    function sceneFromCamera() {
      var clear = null;
      if (pcApp && pcApp.scene && pcApp.scene.activeCamera) {
        clear = pcApp.scene.activeCamera.clearColor;
      }
      if (!clear && pcApp && pcApp.root) {
        (function walk(node) {
          if (!node || clear) return;
          if (node.camera && node.camera.clearColor) {
            clear = node.camera.clearColor;
            return;
          }
          var children = node.children || node._children || [];
          for (var ci = 0; ci < children.length; ci++) walk(children[ci]);
        })(pcApp.root);
      }
      return rgbFromColorObj(clear);
    }
    function sceneFromCanvas() {
      var canvas = null;
      if (typeof document !== 'undefined') {
        if (typeof document.getElementById === 'function') canvas = document.getElementById('application-canvas');
        if (!canvas && typeof document.querySelector === 'function') canvas = document.querySelector('canvas');
      }
      if (!canvas || typeof canvas.getContext !== 'function') return null;
      var gl = null;
      try { gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }); } catch (e2) { gl = null; }
      if (!gl) {
        try { gl = canvas.getContext('webgl', { preserveDrawingBuffer: true }); } catch (e1) { gl = null; }
      }
      if (!gl || typeof gl.readPixels !== 'function') return null;
      var w = canvas.width || 0;
      var h = canvas.height || 0;
      if (w <= 4 || h <= 4) return null;
      var inset = Math.max(8, Math.round(Math.min(w, h) * 0.02));
      inset = Math.min(inset, Math.max(1, Math.floor((Math.min(w, h) - 1) / 2)));
      var left = inset;
      var right = Math.max(0, w - 1 - inset);
      var bottom = inset;
      var top = Math.max(0, h - 1 - inset);
      var midX = Math.floor((left + right) / 2);
      var midY = Math.floor((bottom + top) / 2);
      var points = [
        { point: 'bottom-left', x: left, y: bottom },
        { point: 'bottom-right', x: right, y: bottom },
        { point: 'top-left', x: left, y: top },
        { point: 'top-right', x: right, y: top },
        { point: 'bottom-mid', x: midX, y: bottom },
        { point: 'top-mid', x: midX, y: top },
        { point: 'left-mid', x: left, y: midY },
        { point: 'right-mid', x: right, y: midY }
      ];
      function rectContains(rect, x, y, pad) {
        if (!rect || !isFinite(rect.x) || !isFinite(rect.y) ||
            !isFinite(rect.width) || !isFinite(rect.height)) return false;
        pad = isFinite(pad) ? pad : 0;
        return x >= rect.x - pad && x <= rect.x + rect.width + pad &&
          y >= rect.y - pad && y <= rect.y + rect.height + pad;
      }
      function sampleOccluder(x, y) {
        try {
          var manifest = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
          var fc = manifest.fidelityContract || {};
          var phases = fc.phases || [];
          var phase = null;
          for (var pi = 0; pi < phases.length; pi++) {
            if (phases[pi] && phases[pi].id === phaseId) {
              phase = phases[pi];
              break;
            }
          }
          if (!phase) return null;
          var groups = [
            { kind: 'anchor', rects: phase.projectedAnchors || {} },
            { kind: 'worldLabel', rects: phase.projectedWorldLabels || {} }
          ];
          for (var gi = 0; gi < groups.length; gi++) {
            var rects = groups[gi].rects;
            var keys = Object.keys(rects || {});
            for (var ki = 0; ki < keys.length; ki++) {
              if (rectContains(rects[keys[ki]], x, y, 6)) return groups[gi].kind + ':' + keys[ki];
            }
          }
        } catch (eOcc) {}
        return null;
      }
      var pix = new Uint8Array(4);
      var samples = [];
      for (var pi = 0; pi < points.length; pi++) {
        try {
          gl.readPixels(points[pi].x, points[pi].y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix);
          var ignoredReason = sampleOccluder(points[pi].x, points[pi].y);
          samples.push({
            point: points[pi].point,
            x: points[pi].x,
            y: points[pi].y,
            rgb: [pix[0] / 255, pix[1] / 255, pix[2] / 255],
            ignored: !!ignoredReason,
            ignoredReason: ignoredReason || undefined
          });
        } catch (eRead) {}
      }
      if (!samples.length) return null;
      return {
        backgroundColor: medianRgb(samples),
        samples: samples,
        strategy: '8-point-edge-ring',
        inset: inset
      };
    }
    var bridgeBg = sceneFromBridge();
    var cameraBg = sceneFromCamera();
    var canvasInfo = sceneFromCanvas();
    var canvasBg = canvasInfo && canvasInfo.backgroundColor;
    var bgObserved = canvasBg || cameraBg || bridgeBg;
    if (bgObserved || bridgeBg || cameraBg) {
      out.scene = { backgroundColor: bgObserved };
      if (bridgeBg) out.scene.declaredBackgroundColor = bridgeBg;
      if (canvasBg) out.scene.actualBackgroundColor = canvasBg;
      if (canvasInfo && canvasInfo.samples) out.scene.backgroundColorSamples = canvasInfo.samples;
      if (canvasInfo && canvasInfo.strategy) out.scene.backgroundColorSampleStrategy = canvasInfo.strategy;
      if (canvasInfo && Number.isFinite(canvasInfo.inset)) out.scene.backgroundColorSampleInset = canvasInfo.inset;
      if (cameraBg) out.scene.cameraBackgroundColor = cameraBg;
      out.scene.backgroundColorSource = canvasBg ? 'canvas-readpixels' : (cameraBg ? 'camera-clearColor' : 'bridge');
    }
  } catch (e) {}

  try {
    function viewportBaselineForWorldLabels() {
      var fallback = { width: 1280, height: 720 };
      try {
        var va = (typeof window !== 'undefined' && window.__BLUEPRINT_VISUAL_ASSETS__) || {};
        var candidates = [
          va.viewportBaseline,
          va.fidelityContract && va.fidelityContract.viewportBaseline,
          va.sourceFidelityContract && va.sourceFidelityContract.viewportBaseline
        ];
        for (var vi = 0; vi < candidates.length; vi++) {
          var v = candidates[vi];
          if (v && isFinite(Number(v.width)) && isFinite(Number(v.height))) {
            return { width: Number(v.width), height: Number(v.height) };
          }
        }
      } catch (_e) {}
      return fallback;
    }
    function rectNumber(rec, keys) {
      for (var ri = 0; ri < keys.length; ri++) {
        if (rec && rec[keys[ri]] != null && isFinite(Number(rec[keys[ri]]))) return Number(rec[keys[ri]]);
      }
      return NaN;
    }
    function normalizeWorldLabelRect(entId, rec) {
      if (!entId || !rec || typeof rec !== 'object') return null;
      var x = rectNumber(rec, ['x', 'x_px']);
      var y = rectNumber(rec, ['y', 'y_px']);
      var w = rectNumber(rec, ['width', 'w', 'w_px']);
      var h = rectNumber(rec, ['height', 'h', 'h_px']);
      var cx = rectNumber(rec, ['centerX', 'cx', 'center_x']);
      var cy = rectNumber(rec, ['centerY', 'cy', 'center_y']);
      if (!isFinite(x) && isFinite(cx) && isFinite(w)) x = cx - w / 2;
      if (!isFinite(y) && isFinite(cy) && isFinite(h)) y = cy - h / 2;
      if (!isFinite(cx) && isFinite(x) && isFinite(w)) cx = x + w / 2;
      if (!isFinite(cy) && isFinite(y) && isFinite(h)) cy = y + h / 2;
      if (![x, y, w, h, cx, cy].every(isFinite)) return null;
      return {
        text: typeof rec.text === 'string' ? rec.text : undefined,
        x: x,
        y: y,
        width: Math.max(0, w),
        height: Math.max(0, h),
        centerX: cx,
        centerY: cy,
        visible: rec.visible !== false
      };
    }
    function writeWorldLabelRect(entId, rec) {
      var norm = normalizeWorldLabelRect(entId, rec);
      if (!norm) return;
      out.worldLabels[entId] = norm;
      if (!out.entityDetails[entId]) out.entityDetails[entId] = {};
      if (typeof norm.text === 'string' && norm.text) out.entityDetails[entId].worldLabel = norm.text;
    }
    function rectFromDom(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') return null;
      var base = viewportBaselineForWorldLabels();
      var ww = (typeof window !== 'undefined' && window.innerWidth) || base.width;
      var wh = (typeof window !== 'undefined' && window.innerHeight) || base.height;
      var sx = base.width / ww;
      var sy = base.height / wh;
      var r = el.getBoundingClientRect();
      var visible = true;
      try {
        var cs = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') ? window.getComputedStyle(el) : null;
        visible = !(cs && (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0));
      } catch (_e2) {}
      if (r.width <= 0 || r.height <= 0) visible = false;
      return {
        text: (el.textContent || '').trim(),
        x: Number(r.left) * sx,
        y: Number(r.top) * sy,
        width: Number(r.width) * sx,
        height: Number(r.height) * sy,
        visible: visible
      };
    }
    var wlNodes = document.querySelectorAll('#bp-storyboard-worldlabels .bp-worldlabel[data-entity]');
    for (var wi = 0; wi < wlNodes.length; wi++) {
      var wlEl = wlNodes[wi];
      var entId = wlEl.getAttribute('data-entity');
      if (!entId) continue;
      var wlText = (wlEl.textContent || '').trim();
      if (!out.entityDetails[entId]) out.entityDetails[entId] = {};
      out.entityDetails[entId].worldLabel = wlText;
      writeWorldLabelRect(entId, rectFromDom(wlEl));
    }
    if (typeof window !== 'undefined' && window.__targetWorldLabels && typeof window.__targetWorldLabels === 'object') {
      var bridge = window.__targetWorldLabels;
      var bridgeForPhase = (phaseId && bridge[phaseId] && typeof bridge[phaseId] === 'object') ? bridge[phaseId] : null;
      if (!bridgeForPhase && bridge.current && typeof bridge.current === 'object') bridgeForPhase = bridge.current;
      if (!bridgeForPhase) bridgeForPhase = bridge;
      var keys = Object.keys(bridgeForPhase);
      for (var bi = 0; bi < keys.length; bi++) {
        var key = keys[bi];
        if (key === 'current' || /^phase\d+/i.test(key)) continue;
        writeWorldLabelRect(key, bridgeForPhase[key]);
      }
    }
  } catch (e) {}

  try {
    if (typeof window !== 'undefined' && window.__storyboardEntityDetails
        && typeof window.__storyboardEntityDetails === 'object') {
      const detailKeys = Object.keys(window.__storyboardEntityDetails);
      for (let di = 0; di < detailKeys.length; di++) {
        const entId = detailKeys[di];
        const detail = window.__storyboardEntityDetails[entId];
        if (!entId || !detail || typeof detail !== 'object') continue;
        if (!out.entityDetails[entId]) out.entityDetails[entId] = {};
        if (detail.primitiveStyle && typeof detail.primitiveStyle === 'object') {
          out.entityDetails[entId].primitiveStyle = {
            modelRef: detail.primitiveStyle.modelRef,
            baseColor: Array.isArray(detail.primitiveStyle.baseColor)
              ? detail.primitiveStyle.baseColor.slice(0, 3)
              : detail.primitiveStyle.baseColor,
          };
        }
        if (detail.visualKind) out.entityDetails[entId].visualKind = detail.visualKind;
        if (detail.primitiveCount != null) out.entityDetails[entId].primitiveCount = detail.primitiveCount;
      }
    }
  } catch (e) {}

  return out;
};

const PAGE_EXTRACTOR = SOURCE_PAGE_EXTRACTOR;

function makePageExtractor(opts) {
  const safeOpts = opts || {};
  const kind = safeOpts.targetKind || 'source';
  if (kind === 'webgl-playcanvas') return WEBGL_PAGE_EXTRACTOR;
  return SOURCE_PAGE_EXTRACTOR;
}

function isUnresolvedDefaultAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return false;
  const rectIsZero = ['x_px', 'y_px', 'w_px', 'h_px'].every(function(k) {
    const n = Number(anchor[k]);
    return !isFinite(n) || n === 0;
  });
  if (!rectIsZero) return false;
  const provenance = String(anchor.provenance || '').toLowerCase();
  const lookupPath = String(anchor.lookupPath || '').toLowerCase();
  const resolverRule = String(anchor.resolverRule || '').toLowerCase();
  return provenance === 'inferred-default' ||
    lookupPath === 'not-found' ||
    resolverRule === 'unresolved';
}

function filterComparableAnchors(anchors) {
  if (!anchors || typeof anchors !== 'object') return anchors;
  const comparable = {};
  for (const entId of Object.keys(anchors)) {
    if (!isUnresolvedDefaultAnchor(anchors[entId])) comparable[entId] = anchors[entId];
  }
  return comparable;
}

function runAnchorDiff(phaseId, expectedAnchors, actualAnchors, viewport, tolerancePx) {
  const entries = [];
  if (!expectedAnchors || typeof expectedAnchors !== 'object') return entries;
  expectedAnchors = filterComparableAnchors(expectedAnchors);
  if (!expectedAnchors || typeof expectedAnchors !== 'object' || Object.keys(expectedAnchors).length === 0) return entries;
  const tol = (typeof tolerancePx === 'number' && tolerancePx >= 0) ? tolerancePx : 8;
  const W = (viewport && viewport.width) || 1280;
  const H = (viewport && viewport.height) || 720;
  const actual = (actualAnchors && typeof actualAnchors === 'object') ? actualAnchors : {};
  for (const entId of Object.keys(expectedAnchors)) {
    const exp = expectedAnchors[entId];
    if (!exp || typeof exp !== 'object') continue;
    const x = Number(exp.x_px) || 0;
    const y = Number(exp.y_px) || 0;
    const w = Number(exp.w_px) || 0;
    const h = Number(exp.h_px) || 0;
    const vpIntersect = (x + w) >= 0 && x <= W && (y + h) >= 0 && y <= H;
    const category = vpIntersect ? 'anchor-mismatch' : 'anchor-mismatch-off-viewport';
    const blocking = vpIntersect;
    const act = actual[entId];
    if (!act || typeof act !== 'object') {
      entries.push({
        path: 'phases.' + phaseId + '.projectedAnchors.' + entId,
        source: '<contract>',
        target: 'missing',
        category: category,
        phaseId: phaseId,
        entityId: entId,
        key: '*',
        expected: 'present',
        actual: 'missing',
        blocking: blocking
      });
      continue;
    }
    for (const k of ['x_px', 'y_px', 'w_px', 'h_px']) {
      const ev = Number(exp[k]) || 0;
      const av = Number(act[k]) || 0;
      const delta = Math.abs(ev - av);
      if (delta > tol) {
        entries.push({
          path: 'phases.' + phaseId + '.projectedAnchors.' + entId + '.' + k,
          source: '<contract>',
          target: 'mismatch',
          category: category,
          phaseId: phaseId,
          entityId: entId,
          key: k,
          expected: ev,
          actual: av,
          deltaPx: delta,
          tolerancePx: tol,
          blocking: blocking
        });
      }
    }
  }
  return entries;
}

function runWorldLabelPositionDiff(phaseId, expectedLabels, actualLabels, viewport, tolerancePx, enforceBlocking) {
  const entries = [];
  if (!expectedLabels || typeof expectedLabels !== 'object') return entries;
  const tol = (typeof tolerancePx === 'number' && tolerancePx >= 0) ? tolerancePx : 7;
  const W = (viewport && viewport.width) || 1280;
  const H = (viewport && viewport.height) || 720;
  const actual = (actualLabels && typeof actualLabels === 'object') ? actualLabels : {};
  const baseBlocking = enforceBlocking === true;
  for (const entId of Object.keys(expectedLabels)) {
    const exp = expectedLabels[entId];
    if (!exp || typeof exp !== 'object') continue;
    if (exp.provenance === 'no-label') continue;
    const x = Number(exp.x) || 0;
    const y = Number(exp.y) || 0;
    const w = Number(exp.width) || 0;
    const h = Number(exp.height) || 0;
    const vpIntersect = (x + w) >= 0 && x <= W && (y + h) >= 0 && y <= H;
    const category = vpIntersect ? 'worldLabel-position-mismatch' : 'worldLabel-position-mismatch-off-viewport';
    const blocking = baseBlocking && vpIntersect;
    const act = actual[entId];
    if (!act || typeof act !== 'object') {
      entries.push({
        path: 'phases.' + phaseId + '.projectedWorldLabels.' + entId,
        source: '<contract>',
        target: 'missing',
        category: category,
        phaseId: phaseId,
        entityId: entId,
        key: '*',
        expected: 'present',
        actual: 'missing',
        blocking: blocking
      });
      continue;
    }
    for (const k of ['x', 'y', 'width', 'height']) {
      const ev = Number(exp[k]) || 0;
      const av = Number(act[k]) || 0;
      const delta = Math.abs(ev - av);
      if (delta > tol) {
        entries.push({
          path: 'phases.' + phaseId + '.projectedWorldLabels.' + entId + '.' + k,
          source: '<contract>',
          target: 'mismatch',
          category: category,
          phaseId: phaseId,
          entityId: entId,
          key: k,
          expected: ev,
          actual: av,
          deltaPx: delta,
          tolerancePx: tol,
          blocking: blocking
        });
      }
    }
  }
  return entries;
}

module.exports = {
  SCHEMA_VERSION,
  FLOAT_EPSILON,
  canonicalEntityKey,
  loadContract,
  indexContract,
  expectedVisibleForPhase,
  diffEntitiesBucket,
  diffPhasesBucket,
  diffHudBucket,
  diffWorldLabelBucket,
  diffSceneBucket,
  diffPrimitiveStyleBucket,
  diffPhase,
  buildReport,
  summarize,
  PAGE_EXTRACTOR,
  SOURCE_PAGE_EXTRACTOR,
  WEBGL_PAGE_EXTRACTOR,
  makePageExtractor,
  filterComparableAnchors,
  runAnchorDiff: runAnchorDiff,
  runWorldLabelPositionDiff: runWorldLabelPositionDiff,
  runFieldLevelDiff: function(template, phaseId, sourceFields, targetFields) {
    if (!template || !template.indexed) {
      return [{ path: 'template', source: '<missing>', target: '<missing>', category: 'no-template' }];
    }
    const tgtBuckets = template.diffPhase(phaseId, targetFields);
    const flat = [];
    for (const e of tgtBuckets.entities) {
      flat.push({ path: 'entities.' + e.entityFamily, source: '<contract>', target: e.status, category: 'entity-' + e.status, diffPaths: e.diffPaths, blocking: e.blocking !== false });
    }
    for (const p of tgtBuckets.phases) {
      flat.push({ path: 'phases.' + p.phaseId, source: '<contract>', target: p.status, category: 'phase-' + p.status, diffPaths: p.diffPaths, blocking: p.blocking !== false });
    }
    for (const h of tgtBuckets.hud) {
      flat.push({ path: 'hud.' + h.id, source: '<contract>', target: h.status, category: 'hud-' + h.status, diffPaths: h.diffPaths, blocking: h.blocking !== false });
    }
    for (const w of (tgtBuckets.worldLabel || [])) {
      flat.push({ path: 'worldLabel.' + w.entityId, source: '<contract>', target: w.status, category: 'worldLabel-' + w.status, diffPaths: w.diffPaths, blocking: w.blocking === true });
    }
    for (const s of (tgtBuckets.scene || [])) {
      flat.push({ path: 'scene.' + s.key, source: '<contract>', target: s.status, category: 'scene-' + s.status, diffPaths: s.diffPaths, blocking: s.blocking !== false });
    }
    for (const ps of (tgtBuckets.primitiveStyle || [])) {
      flat.push({ path: 'primitiveStyle.' + ps.entityId, source: '<contract>', target: ps.status, category: 'primitiveStyle-' + ps.status, diffPaths: ps.diffPaths, blocking: ps.blocking !== false });
    }
    return flat;
  },
  makeTemplate: function(contractPath) {
    const contract = loadContract(contractPath);
    const indexed = indexContract(contract);
    return {
      schemaVersion: SCHEMA_VERSION,
      contractPath,
      contract,
      indexed,
      diffPhase: function(phaseId, observed) { return diffPhase(indexed, phaseId, observed); },
      PAGE_EXTRACTOR,
      SOURCE_PAGE_EXTRACTOR,
      WEBGL_PAGE_EXTRACTOR,
      makePageExtractor,
    };
  },
  makeTemplateFromContract: function(contract) {
    if (!contract || typeof contract !== 'object') {
      throw new Error('makeTemplateFromContract: contract must be an object');
    }
    const unwrapped = (contract.contract && Array.isArray(contract.contract.entities))
      ? contract.contract
      : contract;
    const indexed = indexContract(unwrapped);
    return {
      schemaVersion: SCHEMA_VERSION,
      contractPath: null,
      contract: unwrapped,
      indexed,
      diffPhase: function(phaseId, observed) { return diffPhase(indexed, phaseId, observed); },
      PAGE_EXTRACTOR,
      SOURCE_PAGE_EXTRACTOR,
      WEBGL_PAGE_EXTRACTOR,
      makePageExtractor,
    };
  },
};