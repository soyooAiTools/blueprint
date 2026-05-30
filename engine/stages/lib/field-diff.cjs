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
//
// 2026-05-29 ship to /opt/blueprint-editor/engine/stages/lib/field-diff.cjs.
// Folded (per Sam vendored review):
//   (2) loadContract unwraps Jonny split-pack `{writer, contract:{...}}` wrapper
//   (3) entityFamily → e.id (v0.5 schema has no entityFamily; id===name)
//   (4) canonicalEntityKey() — strip leading `_` + UpperCamel first char so
//       `_player` and `Player` regularize to `Player`. All entity-set ops walk
//       canonical form to bridge contract `phase.showEntities` (_camelCase)
//       and `entities[].id` (CamelCase) + source-HTML PHASES.showEntities.
//   (5) PAGE_EXTRACTOR `__gameState` fn/obj dual-form tolerance — source HTML
//       exposes as fn (`window.__gameState=function(){...}`), v2 build exposes
//       as plain object (demo2spec line 10135 `window.__gameState=best.state`).
//       Both shapes resolved transparently. (folded from Sam end-to-end patch)
//   (6) Layer 1.5 extractor abstraction — `makePageExtractor({targetKind})`
//       returns SOURCE_PAGE_EXTRACTOR (source HTML, Three.js, DOM-HUD) or
//       WEBGL_PAGE_EXTRACTOR (PlayCanvas/Luna build, walks pc.app.root for
//       visibleEntities, reads `bp-storyboard-*` DOM overlay for HUD).
//       Per Jonny 03:23 scope: no new pipeline stage, single report out;
//       caller in `fidelity-source-diff.cjs` picks 'source' vs 'webgl-playcanvas'
//       per page being captured. `diffPhasesBucket` also gates `showEntities`
//       check on `obs.showEntities !== undefined` so a target extractor that
//       legitimately can't observe phase intent doesn't pop a phantom diff.
//   (7) WEBGL_PAGE_EXTRACTOR skip-list extension — exact-match
//       `Untitled|EventSystem` + prefix `Storyboard*` filtered out of the
//       PlayCanvas scene-tree visibleEntities walk. Sam 08:16 L1.5 verdict
//       surfaced these as 5 phantoms/phase (40 entity-extra across 8 phases)
//       from Luna runtime/scaffold nodes the contract doesn't list.
//   (8) task #29 design — phase-aware HUD + worldLabel split (Sam 08:40 拍
//       Q1=A Q2=A Q3=yes). Three lib changes:
//       Q1: new `worldLabel` bucket — `entities[].worldLabel` (v0.6 forward)
//           or `hud[id^="label."]` (v0.5 transitional fallback). Diffs are
//           non-blocking advisory (HTML overlay target legitimately doesn't
//           render world-space entity labels; Unity golden does). Reclassifies
//           192 hud-missing noise out of the hud bucket.
//       Q2: polymorphic `hud[].text` (and `entities[].worldLabel`) — string OR
//           `{default?: string, perPhase: {phaseId: string}}`. Resolver picks
//           perPhase[phaseId] → default → undefined-skip. Backward-compat:
//           existing v0.5 plain-string entries unchanged.
//       Q3: `hud:steptoast` empty-string-equals-missing tolerance — if expected
//           `text === ''` and target slot is undefined, skip diff (transient
//           toast with no active step is a legitimate undefined state).
//   (8.1) `runFieldLevelDiff` shim observability fix — flatten worldLabel
//        bucket entries into the legacy flat diff array (`category:
//        worldLabel-{missing,mismatch}`, `blocking: false`) so stage-layer
//        callers see them. Also pass through `blocking` flag on all entries so
//        the stage can split blocking vs advisory without guessing. Sam 08:53
//        diagnosed gap: lib computed worldLabel diffs but legacy shim dropped
//        them on the floor — report.json had 0 mentions of worldLabel.

const fs = require('fs');

const SCHEMA_VERSION = 'task25.field-diff@0.6.1';
const FLOAT_EPSILON = 1e-3;

// ─── Contract loading ──────────────────────────────────────────────────────────

function loadContract(contractPath) {
  const raw = fs.readFileSync(contractPath, 'utf8');
  const c = JSON.parse(raw);
  // (2) split-pack wrapper unwrap — Jonny writer emits `{writer, contract:{...}}`.
  if (c && c.contract && Array.isArray(c.contract.entities)) return c.contract;
  return c;
}

// (4) canonical entity key: strip leading underscore + uppercase first char.
//     `_player` → `Player`, `Player` → `Player`, `_oxygenShop` → `OxygenShop`.
function canonicalEntityKey(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const stripped = s.charAt(0) === '_' ? s.slice(1) : s;
  if (stripped.length === 0) return stripped;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function indexContract(contract) {
  // Build phase-keyed view so a single page-load can diff phases sequentially.
  const phasesById = {};
  for (const p of contract.phases || []) phasesById[p.id] = p;

  // Entities are phase-agnostic in the contract (geometry is static).
  // visible-per-phase derives from phase.showEntities[]/hideEntities[].
  // (3) v0.5 schema uses `id` (===name) not `entityFamily`. Key by canonical id
  // so `_player` and `Player` both resolve.
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

// Compute the set of entity families that should be VISIBLE in a given phase.
// Honors phase.showEntities[] (additive) and phase.hideEntities[] (subtractive).
// Player and SpaceShip persist across phases per source-HTML setVisible() rule
// (models.Player.visible=true always; SpaceShip if shipLevel>0 OR in showEntities).
// (4) All entries returned in canonical form.
function expectedVisibleForPhase(indexed, phaseId) {
  const phase = indexed.phasesById[phaseId];
  if (!phase) return null;
  const set = new Set();
  for (const x of (phase.showEntities || [])) set.add(canonicalEntityKey(x));
  for (const x of (phase.hideEntities || [])) set.delete(canonicalEntityKey(x));
  // Player always present (source-HTML invariant).
  set.add('Player');
  return set;
}

// ─── Tolerance helpers ──────────────────────────────────────────────────────────

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

// ─── Bucket 1: entities ────────────────────────────────────────────────────────

function diffEntitiesBucket(indexed, phaseId, observed) {
  const entries = [];
  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  // (4) canonicalize observed visible set so a probe emitting `_player`,
  //     `Player`, or any case-variant collapses to the same canonical key.
  const observedVisible = new Set();
  for (const x of (observed.visibleEntities || [])) observedVisible.add(canonicalEntityKey(x));

  // missing: expected visible, not observed visible
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
  // extra: observed visible, not expected — PHANTOM detection (e.g. _gold/_scrap/_ice)
  for (const name of observedVisible) {
    if (!expectedVisible.has(name)) {
      // task #31: source-declared UI overlays (CTA/Canvas/Joystick) are real
      // screen-space controls, not world entity phantoms. Only suppress them
      // when the contract explicitly carries sourceEntityContract.uiOverlayContract.
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
  // mismatch: both visible, but per-primitive transform/material drifts
  // (caller may pass observed.entityDetails[name] = { primitives:[{id, position, color}] })
  // observed.entityDetails keys are also canonicalized to bridge probe shape.
  if (observed.entityDetails) {
    const canonDetails = {};
    for (const k of Object.keys(observed.entityDetails)) {
      canonDetails[canonicalEntityKey(k)] = observed.entityDetails[k];
    }
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
  // Skip when extractor did not surface a primitives array at all — a partial
  // entityDetails snapshot (e.g. only worldLabel populated by #49) must not be
  // misread as "all primitives missing". The primitiveStyle bucket has its own
  // dedicated gate for modelRef/baseColor coverage.
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
    // mesh kind
    if (ep.mesh && op.mesh && ep.mesh.kind !== op.mesh.kind) {
      diffs.push({ path: `$.primitives[${ep.primitiveId}].mesh.kind`, expected: ep.mesh.kind, observed: op.mesh.kind });
    }
    // transform.localPosition
    if (ep.transform && op.transform && !vec3Eq(ep.transform.localPosition, op.transform.localPosition)) {
      diffs.push({
        path: `$.primitives[${ep.primitiveId}].transform.localPosition`,
        expected: ep.transform.localPosition,
        observed: op.transform.localPosition,
      });
    }
    // material colors — 3 independent: _BaseColor / _ColorTint / _EmissionColor
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

// ─── Bucket 2: phases ──────────────────────────────────────────────────────────

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
  // (4) canonicalize show/hide so contract `_player`-form and source-HTML
  //     `Player`-form both round-trip to the same key in the set-diff.
  const expShowList = (phase.showEntities || []).map(canonicalEntityKey);
  const expHideList = (phase.hideEntities || []).map(canonicalEntityKey);
  const exp = {
    showEntities: expShowList,
    hideEntities: expHideList,
    guideText: (phase.trigger && phase.trigger.guideText) || '',
    targetEntity: canonicalEntityKey((phase.trigger && phase.trigger.targetEntity) || null) || null,
  };
  const obs = observed.phaseSpec || {};
  const diffPaths = [];

  // showEntities — order-insensitive, canonical. (6) gate on observed presence
  // so extractors that can't observe phase intent (e.g. PlayCanvas build has no
  // PHASES global) skip this signal instead of always popping a diff.
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
  // guideText — byte-exact
  if (obs.guideText !== undefined && exp.guideText !== obs.guideText) {
    diffPaths.push({ path: '$.guideText', expected: exp.guideText, observed: obs.guideText });
  }
  // targetEntity — canonical
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

// ─── Bucket 3: hud ─────────────────────────────────────────────────────────────

// Fold (8) Q1: hud entries whose id matches this pattern are world-space entity
// labels (e.g. id `label.Player`, diffPath `hud.label.Player`), reclassified
// into the worldLabel bucket and excluded from hud-{missing,mismatch}. v0.5
// transitional shape; v0.6 forward expresses these as `entities[].worldLabel`.
// (Verified against `space-ranger-v3-hook-candidate` contract: hud[].id uses
//  `label.<EntityName>` prefix; the `hud.` prefix in the diff report path is
//  the bucket name added by the diff renderer.)
const WORLD_LABEL_HUD_ID_RE = /^label\./;

// task #45 (v1.3) Blocker #3 fix: shape-discriminated severity dispatch.
// v1.3 rich-record worldLabel = { text:<str>, worldOffset:{x,y,z}, color?, fontSize?, consumer? }
//   is a normative gate field — missing/mismatch BLOCKS acceptance (youth red line:
//   "模型一致 + 视觉一致", #45 acceptance includes worldLabel).
// v0.5 plain string / v1.1 polymorphic { default?, perPhase? } legacy spec
//   stays advisory (HTML overlay target legitimately doesn't render world-space
//   labels in those era contracts — preserves backward-compat behavior).
function isV13RichWorldLabel(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return false;
  if (typeof spec.text !== 'string') return false;
  var wo = spec.worldOffset;
  return wo !== null && typeof wo === 'object' && !Array.isArray(wo);
}

// task #52 (v1.4d-ε): hud slots whose text is phase-dynamic at runtime
// (source HTML phaseTimeline tick rewrites textContent every phase). For
// schemaVersion < 1.4.0 contracts that author these as plain strings (only
// phase1 values), per-phase mismatches downgrade to advisory (blocking:false)
// to preserve backward-compat. v1.4.0+ contracts MUST author polymorphic
// {perPhase: {...}} records — plain-string text on these ids at v1.4.0+ is
// an authoring bug and stays blocking.
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

// Fold (8) Q2: resolve a polymorphic text spec. Accepts a plain string (phase-
// constant) or `{default?: string, perPhase?: {phaseId: string}}`. Returns the
// resolved string for the given phaseId, or `undefined` if no text applies.
function resolvePolymorphicText(spec, phaseId) {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec === 'string') return spec;
  if (typeof spec === 'object') {
    if (spec.perPhase && Object.prototype.hasOwnProperty.call(spec.perPhase, phaseId)) {
      return spec.perPhase[phaseId];
    }
    if (Object.prototype.hasOwnProperty.call(spec, 'default')) return spec.default;
    // task #45 (v1.3): rich worldLabel record { text, worldOffset, ... } —
    // text is phase-constant. Falls through after perPhase/default to keep
    // v1.1 polymorphic-text behavior strictly first.
    if (typeof spec.text === 'string') return spec.text;
  }
  return undefined;
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
    // Fold (8) Q2: resolve polymorphic text per phase. undefined → text not
    // defined for this phase → skip diff entirely (no expectation to match).
    const expectedText = resolvePolymorphicText(exp.text, phaseId);
    const obs = obsBySlot[exp.id];
    if (!obs) {
      // Fold (8) Q3: empty-string-equals-missing tolerance for transient slots.
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
    // text — byte-exact (the canonical "Gold:" vs "金币" mismatch is captured here)
    if (obs.text !== undefined && expectedText !== obs.text) {
      diffPaths.push({ path: '$.text', expected: expectedText, observed: obs.text });
    }
    // anchor.anchoredPosition
    if (obs.anchor && exp.anchor &&
        (!floatEq(exp.anchor.anchoredPosition.x, obs.anchor.anchoredPosition.x) ||
         !floatEq(exp.anchor.anchoredPosition.y, obs.anchor.anchoredPosition.y))) {
      diffPaths.push({
        path: '$.anchor.anchoredPosition',
        expected: exp.anchor.anchoredPosition,
        observed: obs.anchor.anchoredPosition,
      });
    }
    // style.fontSize
    if (obs.style && exp.style && !floatEq(exp.style.fontSize, obs.style.fontSize)) {
      diffPaths.push({ path: '$.style.fontSize', expected: exp.style.fontSize, observed: obs.style.fontSize });
    }
    if (diffPaths.length > 0) {
      // task #52 (v1.4d-ε): severity downgrade for pre-v1.4 contracts that
      // authored phase-dynamic hud slots (hud.phase / hud.tip / hud.targethint)
      // as plain-string text. Per-phase mismatches in that legacy shape stay
      // advisory (blocking:false). v1.4.0+ contracts MUST use polymorphic
      // {perPhase:...} — plain-string at v1.4.0+ is an authoring bug, blocking.
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
  // extras (observed hud not in contract — e.g. legacy "Gold:" label)
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

// Fold (8) Q1: worldLabel bucket. Reads expected world-space entity labels from
// two sources: (a) v0.6 forward — `entities[].worldLabel` (polymorphic text or
// v1.3 rich record); (b) v0.5 transitional — `hud[id^="hud.label."]` plain-text
// entries (the 192 reclassified hud noise).
//
// task #45 (v1.3) Blocker #3 fix: shape-discriminated severity. Rich records
// (v1.3, isV13RichWorldLabel(spec)) emit blocking:true — they're a normative
// gate field consumed by the #46 writer overlay (modelRef + worldLabel together
// define "model + visual" replication youth's red line). Legacy v0.5 plain
// string / v1.1 polymorphic / v0.5 transitional hud.label.* still emit
// blocking:false — HTML overlay target legitimately does not render world-
// space labels in those era contracts.
//
// Observed `worldLabel` is read from `observed.entityDetails[name].worldLabel`
// (target extractors that support world-space label capture will populate it;
// absent extractors leave it undefined → missing diff).
function diffWorldLabelBucket(indexed, phaseId, observed) {
  const entries = [];
  const expected = {};
  // (a) v0.6 forward — including v1.3 rich record
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
  // (b) v0.5 transitional fallback (only if not already covered by v0.6 path).
  // Plain hud.label.* entries are never rich-record shape → always advisory.
  for (const h of (indexed.contract.hud || [])) {
    if (!WORLD_LABEL_HUD_ID_RE.test(h.id)) continue;
    const entityName = h.id.replace(WORLD_LABEL_HUD_ID_RE, '');
    const key = canonicalEntityKey(entityName);
    if (expected[key]) continue; // v0.6 entry wins
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
      // Q3 tolerance: empty expected + undefined observed = ok
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

// ─── Bucket 4: scene (v1.3) ────────────────────────────────────────────────────
// task #45 (v1.3): expected `contract.scene.backgroundColor` (linear-RGB
// 3-element array 0..1) vs observed `observed.scene.backgroundColor`. Blocking
// when contract declares scene but target doesn't render it — this is the gate
// #46 worker overlay must turn green by wiring pc.scene.clearColor from the
// contract.
function diffSceneBucket(indexed, phaseId, observed) {
  const entries = [];
  const exp = indexed.contract.scene;
  if (!exp || !Array.isArray(exp.backgroundColor) || exp.backgroundColor.length < 3) {
    return entries; // pre-v1.3 contract has no scene block
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
  if (!Array.isArray(obsBg) || obsBg.length < 3 ||
      !floatEq(expBg[0], obsBg[0]) || !floatEq(expBg[1], obsBg[1]) || !floatEq(expBg[2], obsBg[2])) {
    entries.push({
      key: 'backgroundColor',
      status: 'mismatch',
      diffPaths: [{ path: '$.scene.backgroundColor', expected: expBg, observed: obsBg }],
      blocking: true,
      provenance: exp.provenance || null,
    });
  }
  return entries;
}

// ─── Bucket 5: primitiveStyle (v1.3) ───────────────────────────────────────────
// task #45 (v1.3): per-entity `entity.primitiveStyle = {modelRef, baseColor[,
// baseColorHex]}` reverse-extracted from source HTML by Path B producer. The
// writer overlay (#46) must consume modelRef → real Luna mesh and baseColor →
// material parameter; this bucket surfaces gaps. Blocking when contract declares
// primitiveStyle but the entity is visible and observed style is missing/
// mismatched. Entity-not-visible is the entities-bucket's job — skip here to
// avoid double-counting.
function diffPrimitiveStyleBucket(indexed, phaseId, observed) {
  const entries = [];
  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  if (!expectedVisible) return entries;
  const observedVisible = new Set();
  for (const x of (observed.visibleEntities || [])) observedVisible.add(canonicalEntityKey(x));
  const canonDetails = {};
  for (const k of Object.keys(observed.entityDetails || {})) {
    canonDetails[canonicalEntityKey(k)] = observed.entityDetails[k];
  }

  for (const name of expectedVisible) {
    const expEntity = indexed.entitiesByFamily[name];
    if (!expEntity || !expEntity.primitiveStyle) continue;
    if (!observedVisible.has(name)) continue; // entities bucket already flags this
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

// ─── Top-level per-phase diff ──────────────────────────────────────────────────

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

// ─── Page-side extractors (run inside Playwright page.evaluate) ────────────────
// Two flavors: SOURCE_PAGE_EXTRACTOR (source HTML, Three.js, DOM HUD) and
// WEBGL_PAGE_EXTRACTOR (PlayCanvas/Luna build, scene walk + bp-storyboard DOM).
// `makePageExtractor({targetKind})` returns the appropriate one. Backwards-compat
// alias `PAGE_EXTRACTOR` = `SOURCE_PAGE_EXTRACTOR`.
// Returns a snapshot in the shape diff* functions expect:
//   { phaseId, visibleEntities, entityDetails, phaseSpec, hud, extractorKind }

const SOURCE_PAGE_EXTRACTOR = function(args) {
  const { phaseId } = args || {};
  const out = {
    phaseId,
    visibleEntities: [],
    entityDetails: {},
    phaseSpec: {},
    hud: [],
  };
  // Visible entities: from __gameState if present, else fallback to entity_states.
  // Source HTML exposes __gameState as a fn; some target builds (v2 demo2spec line 10135
  // `window.__gameState=best.state;`) expose it as a plain object. Handle both shapes —
  // see (5) in header. Canonical as of @0.3.
  let gs = null;
  if (typeof window !== 'undefined' && window.__gameState != null) {
    gs = (typeof window.__gameState === 'function') ? window.__gameState() : window.__gameState;
  }
  if (gs && gs.visibleEntities) out.visibleEntities = gs.visibleEntities.slice();
  else if (gs && gs.entity_states) {
    out.visibleEntities = Object.keys(gs.entity_states).filter(n => gs.entity_states[n].visible);
  }
  // phaseSpec: derive from window.PHASES + current phase
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
  // hud: scan known IDs (canonical 9 slot names from v0.5 contract)
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

// PlayCanvas / Luna build extractor — handles target builds emitted by the
// blueprint-editor worker bridge (LunaUnity.Application + pc.Application).
// Reads: window.__gameState (object form, populated ~500ms after start by GFM
// scan), pc.app.root scene tree for entity visibility, and the storyboard
// overlay DOM (`#bp-storyboard-*` created at runtime by installStoryboardDomHud).
// Leaves phaseSpec.showEntities/hideEntities UNDEFINED on purpose so the
// phase-diff bucket gating in (6) skips signals the runtime can't observe.
const WEBGL_PAGE_EXTRACTOR = function(args) {
  const safeArgs = args || {};
  const phaseId = safeArgs.phaseId;
  const out = {
    phaseId: phaseId,
    visibleEntities: [],
    entityDetails: {},
    phaseSpec: {},
    hud: [],
    extractorKind: 'webgl-playcanvas',
  };
  // 1. Resolve PlayCanvas application.
  let pcApp = null;
  try {
    if (typeof window !== 'undefined') {
      pcApp = (window.app && window.app.app) ||
              (window.pc && window.pc.Application &&
               typeof window.pc.Application.getApplication === 'function' &&
               window.pc.Application.getApplication()) || null;
    }
  } catch (e) { pcApp = null; }

  // 2. Resolve __gameState (object form by GFM scan, fn form on source HTML).
  let gs = null;
  try {
    if (typeof window !== 'undefined' && window.__gameState != null) {
      gs = (typeof window.__gameState === 'function') ? window.__gameState() : window.__gameState;
    }
  } catch (e) { gs = null; }

  // 3. visibleEntities — prefer __gameState.entity_states, supplement with PC scene walk.
  const visible = {};
  if (gs && gs.entity_states && typeof gs.entity_states === 'object') {
    const keys = Object.keys(gs.entity_states);
    for (let i = 0; i < keys.length; i++) {
      const st = gs.entity_states[keys[i]];
      if (st && st.visible !== false) visible[keys[i]] = true;
    }
  }
  if (pcApp && pcApp.root) {
    // SKIP — generic runtime/scaffold names that pollute the entity set with
    // extras the contract doesn't list. Exact-match set + prefix list. Sam end-to-end
    // 08:16 verdict surfaced 5 phantoms/phase from these: Untitled / EventSystem /
    // StoryboardGround / StoryboardStar / StoryboardOrbit.
    const SKIP = {
      '__BaseTemplate': 1, '__LunaPool': 1,
      '__AUTOPLAY_ON__': 1, '__CUA_OBSERVER_READY__': 1,
      'Untitled': 1, 'EventSystem': 1,
    };
    const SKIP_PREFIX = ['Storyboard'];
    const isSkipped = function(n) {
      if (SKIP[n]) return true;
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
      // Top-level CamelCase entity names (Player, OxygenShop, …) the contract cares about.
      // Pool-managed entities and Luna runtime markers are skipped.
      if (name && !isSkipped(name) && /^[A-Z][A-Za-z0-9]*$/.test(name) && node.enabled !== false) {
        visible[name] = true;
      }
      const children = node._children || node.children || [];
      for (let j = 0; j < children.length; j++) stack.push(children[j]);
    }
  }
  out.visibleEntities = Object.keys(visible);

  // 4. phaseSpec — derive from __gameState (PlayCanvas build has no window.PHASES).
  //    Leave showEntities/hideEntities undefined so (6) gating skips the diff.
  if (gs) {
    out.phaseSpec.guideText = (gs.ui_state && gs.ui_state.guideText) ||
                              (gs.uiState && gs.uiState.guideText) ||
                              (gs.variables && gs.variables.guideText) || '';
    out.phaseSpec.targetEntity = (gs.variables && gs.variables.targetEntity) ||
                                 gs.targetEntity || null;
  }

  // 5. HUD — bp-storyboard-* DOM overlay (created by installStoryboardDomHud).
  //    Maps to the same canonical hud.* ids the source extractor uses so the
  //    diff bucket treats both extractor flavors uniformly.
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

  // 6. scene background — v1.4d Visual Fidelity Chain.
  //     Use the worker's stable observation bridge first: scene.backgroundColor
  //     is a scene/camera property, while canvas corner pixels can be occluded by
  //     ground/decor/entity geometry. Canvas sampling remains a fallback for
  //     runtimes that have no bridge; camera clearColor is the final fallback.
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
      var points = [
        [Math.max(1, Math.floor(w * 0.02)), Math.max(1, Math.floor(h * 0.02))],
        [Math.min(w - 2, Math.floor(w * 0.98)), Math.max(1, Math.floor(h * 0.02))],
        [Math.max(1, Math.floor(w * 0.02)), Math.min(h - 2, Math.floor(h * 0.98))],
        [Math.min(w - 2, Math.floor(w * 0.98)), Math.min(h - 2, Math.floor(h * 0.98))]
      ];
      var pix = new Uint8Array(4);
      var samples = [];
      for (var pi = 0; pi < points.length; pi++) {
        try {
          gl.readPixels(points[pi][0], points[pi][1], 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pix);
          samples.push([pix[0] / 255, pix[1] / 255, pix[2] / 255]);
        } catch (eRead) {}
      }
      if (!samples.length) return null;
      samples.sort(function(a, b) {
        return (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]);
      });
      return samples[0];
    }
    var bgObserved = sceneFromBridge() || sceneFromCanvas() || sceneFromCamera();
    if (bgObserved) out.scene = { backgroundColor: bgObserved };
  } catch (e) { /* leave scene missing on extractor error */ }

  // 6a. worldLabel DOM overlay — task #49 v1.4c-β. The worker installs
  //     `#bp-storyboard-worldlabels > .bp-worldlabel[data-entity]` divs, one per
  //     contract.entities[].worldLabel. Extractor reads text regardless of
  //     visibility (DOM presence is the gate; positioning is visual-only).
  //     Populates observed.entityDetails[entityName].worldLabel string that
  //     diffWorldLabelBucket compares against rich worldLabel.text.
  try {
    var wlNodes = document.querySelectorAll('#bp-storyboard-worldlabels .bp-worldlabel[data-entity]');
    for (var wi = 0; wi < wlNodes.length; wi++) {
      var wlEl = wlNodes[wi];
      var entId = wlEl.getAttribute('data-entity');
      if (!entId) continue;
      var wlText = (wlEl.textContent || '').trim();
      if (!out.entityDetails[entId]) out.entityDetails[entId] = {};
      out.entityDetails[entId].worldLabel = wlText;
    }
  } catch (e) { /* leave entityDetails empty on extractor error */ }

  // 6b. primitiveStyle runtime bridge — task #50 v1.4c-gamma. The worker overlay
  //     consumes contract.entities[].primitiveStyle to choose a styled composite
  //     and exposes the consumed {modelRef, baseColor} at
  //     window.__storyboardEntityDetails[entity].primitiveStyle. Read that exact
  //     runtime surface back so the primitiveStyle bucket verifies consumption
  //     instead of staying missing while geometry is present.
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
  } catch (e) { /* leave primitiveStyle missing on extractor error */ }
  return out;
};

// Backwards-compat alias for callers wired against the @0.3 single-extractor API.
const PAGE_EXTRACTOR = SOURCE_PAGE_EXTRACTOR;

// Extractor factory — pick by targetKind. Callers in `fidelity-source-diff.cjs`
// pass 'source' when capturing the canonical source HTML and 'webgl-playcanvas'
// when capturing the produced build. Unknown kinds fall back to source extractor
// so existing wiring keeps working.
function makePageExtractor(opts) {
  const safeOpts = opts || {};
  const kind = safeOpts.targetKind || 'source';
  if (kind === 'webgl-playcanvas') return WEBGL_PAGE_EXTRACTOR;
  return SOURCE_PAGE_EXTRACTOR;
}

// ─── v1.2.0 anchor bucket ──────────────────────────────────────────────────────
// runAnchorDiff: compares per-phase per-entity screen-space anchor rects from
// the contract (expectedAnchors) against target-runtime anchors (actualAnchors,
// exposed by Jonny's writer at `window.__targetAnchors`). Both are
// `{ entityId: { x_px, y_px, w_px, h_px, ... } }` shaped.
//
// PERSISTENCE BOUNDARY (locked v6.1, Tim msg=612c753c + Jonny msg=0ec2b725):
//   viewportIntersection is DERIVED HERE from expected x/y/w/h at consume time —
//   never read from the contract record (visibility booleans MUST NOT be in
//   anchor records). Off-viewport expected anchors route to advisory
//   ('anchor-mismatch-off-viewport', blocking:false) so source-positioned-
//   offscreen entities don't flood the blocking bucket.
//
// Category prefix 'anchor-*' so the stage-layer bucket aggregator
// (split('-')[0]) routes entries into the 'anchor' bucket.
function runAnchorDiff(phaseId, expectedAnchors, actualAnchors, viewport, tolerancePx) {
  const entries = [];
  if (!expectedAnchors || typeof expectedAnchors !== 'object') return entries;
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
    // Bbox-rect intersection vs top-left origin viewport (NOT center-point).
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

// ─── Module exports ────────────────────────────────────────────────────────────

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
  runAnchorDiff: runAnchorDiff,
  // Sam compat: drop-in for runFieldLevelDiff(template, phaseId, sourceFields, targetFields).
  // template = { indexed }
  // sourceFields / targetFields = page extractor output snapshots
  runFieldLevelDiff: function(template, phaseId, sourceFields, targetFields) {
    if (!template || !template.indexed) {
      return [{ path: 'template', source: '<missing>', target: '<missing>', category: 'no-template' }];
    }
    // Per Sam's stage interface: the source is the canonical truth (contract was
    // reverse-extracted FROM source HTML), so we diff TARGET against contract only.
    // If both source and target diff, source diff = contract gap (extractor bug);
    // target diff = real visual drift (the case we're hunting).
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
    // Fold (8.1) + task #45 Blocker #3: flatten worldLabel bucket so stage-
    // layer callers see entries. Transparently pass through the bucket's
    // `blocking` flag (v1.3 rich record → true, v1.1 polymorphic / v0.5 plain
    // → false) instead of hard-coding false. Sam 08:53 + Jonny msg=9307fdee
    // diagnosed the prior hard-coded false as the surface that swallowed v1.3
    // worldLabel-missing into advisory.
    for (const w of (tgtBuckets.worldLabel || [])) {
      flat.push({ path: 'worldLabel.' + w.entityId, source: '<contract>', target: w.status, category: 'worldLabel-' + w.status, diffPaths: w.diffPaths, blocking: w.blocking === true });
    }
    // task #45 (v1.3): flatten scene + primitiveStyle buckets. Both blocking by
    // design — contract has the field, target overlay must render it; gap is the
    // signal for #46 worker work.
    for (const s of (tgtBuckets.scene || [])) {
      flat.push({ path: 'scene.' + s.key, source: '<contract>', target: s.status, category: 'scene-' + s.status, diffPaths: s.diffPaths, blocking: s.blocking !== false });
    }
    for (const ps of (tgtBuckets.primitiveStyle || [])) {
      flat.push({ path: 'primitiveStyle.' + ps.entityId, source: '<contract>', target: ps.status, category: 'primitiveStyle-' + ps.status, diffPaths: ps.diffPaths, blocking: ps.blocking !== false });
    }
    return flat;
  },
  // Convenience: build a template object Sam can stash on ctx.fidelityFieldDiffTemplate.
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
  // task #43 (v1.3c): same template shape but from an already-loaded in-memory
  // contract (e.g. Path B producer's enriched v1.2 on ctx.blueprint.fidelityContract).
  // Avoids round-tripping through a temp file when the canonical truth is already
  // in memory — which was the actual bridge gap: source-diff was auto-loading
  // the default v1.0 path on disk and ignoring the enriched v1.2 contract.
  makeTemplateFromContract: function(contract) {
    if (!contract || typeof contract !== 'object') {
      throw new Error('makeTemplateFromContract: contract must be an object');
    }
    // Mirror loadContract's split-pack unwrap so callers can hand in either
    // a bare contract or a writer-wrapped { contract: {...} }.
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
