/**
 * Deterministic trigger normalizer (2026-04-27).
 *
 * Re-derives schema.phases[i].trigger from spec.requiredInteractions, which
 * is a structured DSL. When the deterministic answer disagrees with the LLM
 * answer, the deterministic answer wins (LLM is wrong here ~10-15% of the
 * time and the bad trigger usually causes the phase to never advance,
 * burning a CUA round at minimum).
 *
 * Why this is safe: requiredInteractions is the canonical source of truth
 * for "what the player must do to advance" — the spec author writes it and
 * the storyboard reviewer signs off on it. The C# expression in
 * triggerNext.condition is downstream prose. So when they conflict we
 * trust the structured field.
 *
 * Behind env flag DETERMINISTIC_TRIGGER_NORMALIZE: 'shadow' = log diffs only,
 * 'apply' = rewrite, 'off' (default) = no-op. Always observable: returns
 * { llmTrigger, derivedTrigger, applied, reason } per phase.
 *
 * requiredInteractions DSL grammar:
 *   click:<Entity>          → click_entity (alone) or part of multi-step
 *   move_to:<Entity>        → near_entity (rarely standalone)
 *   collect:<resource>:<n>  → resource_collected
 *   deliver:<resource>:<E>  → entity_state_reached on E
 *   spend:<resource>:<n>    → cost-gated; combine with build/upgrade for state
 *   build:<Entity>          → entity_state_reached on E, state=2 (built)
 *   upgrade:<Entity>:<lvl>  → entity_state_reached on E, state=lvl
 *   recruit:<role>:<n>      → entity_state_reached on Role-derived entity
 *
 * Multiple upgrade:X:N actions in same phase → compound (and).
 * Pure click:CTAButton (CTA phase) → click_entity.
 *
 * Pure: no I/O, no mutation. Caller decides whether to apply.
 */

var TRIGGER_TYPES_ENUM = {
  resource_collected: 1, entity_state_reached: 1, near_entity: 1,
  click_entity: 1, all_built: 1, enemy_defeated: 1, timer: 1, compound: 1,
};

function parseInteraction(s) {
  if (typeof s !== 'string') return null;
  var parts = s.split(':');
  if (parts.length < 2) return null;
  return { verb: parts[0].trim(), args: parts.slice(1).map(function(p) { return p.trim(); }) };
}

function findEntityByLooseName(entities, hint) {
  if (!Array.isArray(entities) || !hint) return null;
  var lower = String(hint).toLowerCase();
  // exact (case-insensitive)
  for (var i = 0; i < entities.length; i++) {
    if (entities[i] && entities[i].name && String(entities[i].name).toLowerCase() === lower) {
      return entities[i].name;
    }
  }
  // substring
  var hits = [];
  for (var j = 0; j < entities.length; j++) {
    var n = entities[j] && entities[j].name;
    if (!n) continue;
    if (String(n).toLowerCase().indexOf(lower) >= 0 || lower.indexOf(String(n).toLowerCase()) >= 0) {
      hits.push(n);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Derive trigger from requiredInteractions array + entity registry.
 * Returns trigger object matching schema, or null if no derivation possible.
 */
function deriveTriggerFromInteractions(requiredInteractions, schemaEntities, opts) {
  opts = opts || {};
  if (!Array.isArray(requiredInteractions) || requiredInteractions.length === 0) return null;
  var parsed = requiredInteractions.map(parseInteraction).filter(Boolean);
  if (parsed.length === 0) return null;

  // Look for collect:<res>:<n> — strongest signal
  var collects = parsed.filter(function(p) { return p.verb === 'collect' && p.args.length >= 2; });
  if (collects.length === 1) {
    var c = collects[0];
    var amt = parseInt(c.args[1], 10);
    return {
      type: 'resource_collected',
      resource: c.args[0],
      amount: isFinite(amt) && amt > 0 ? amt : 1,
    };
  }

  // Look for upgrade:<E>:<lvl> — multiple = compound.
  // If any entity cannot be resolved in the schema, return null rather than
  // emitting an unresolvable entity name that will fail schema validation.
  var upgrades = parsed.filter(function(p) { return p.verb === 'upgrade' && p.args.length >= 2; });
  if (upgrades.length >= 1) {
    var subs = [];
    for (var ui = 0; ui < upgrades.length; ui++) {
      var u = upgrades[ui];
      var entity = findEntityByLooseName(schemaEntities, u.args[0]);
      if (!entity) return null; // can't resolve → no safe derivation
      var st = parseInt(u.args[1], 10);
      subs.push({
        type: 'entity_state_reached',
        entity: entity,
        state: isFinite(st) ? st : 1,
      });
    }
    if (subs.length === 1) return subs[0];
    return { type: 'compound', operator: 'and', triggers: subs };
  }

  // Look for build:<E> — terminal state defaults to 2 (built).
  // Return null if entity cannot be resolved to avoid emitting a bad name.
  var builds = parsed.filter(function(p) { return p.verb === 'build' && p.args.length >= 1; });
  if (builds.length === 1) {
    var be = findEntityByLooseName(schemaEntities, builds[0].args[0]);
    if (!be) return null; // can't resolve → no safe derivation
    return { type: 'entity_state_reached', entity: be, state: 2 };
  }
  if (builds.length > 1) {
    var buildTriggers = [];
    for (var bi = 0; bi < builds.length; bi++) {
      var en = findEntityByLooseName(schemaEntities, builds[bi].args[0]);
      if (!en) return null; // can't resolve → no safe derivation
      buildTriggers.push({ type: 'entity_state_reached', entity: en, state: 2 });
    }
    return { type: 'compound', operator: 'and', triggers: buildTriggers };
  }

  // Look for deliver:<res>:<E> — entity reaches loaded/filled state.
  // Return null if entity cannot be resolved to avoid emitting a bad name.
  var delivers = parsed.filter(function(p) { return p.verb === 'deliver' && p.args.length >= 2; });
  if (delivers.length === 1) {
    var de = findEntityByLooseName(schemaEntities, delivers[0].args[1]);
    if (!de) return null; // can't resolve → no safe derivation
    // Default: state 1 (loaded). Can't know without entity's state machine,
    // so use 1 as the conservative "first non-initial state" default.
    return { type: 'entity_state_reached', entity: de, state: 1 };
  }

  // CTA terminal: pure click on CTA-named entity
  var clicks = parsed.filter(function(p) { return p.verb === 'click' && p.args.length >= 1; });
  if (parsed.length === clicks.length && clicks.length === 1) {
    var ce = findEntityByLooseName(schemaEntities, clicks[0].args[0]) || clicks[0].args[0];
    if (/CTA|Button/i.test(ce)) {
      return { type: 'click_entity', entity: ce };
    }
    // Bare click on non-CTA entity → click_entity is still legal but weak;
    // we don't claim derivation confidence here — return null so LLM stays in charge.
    return null;
  }

  // recruit:<role>:<n> — entity name often differs (worker → WorkerAI). Try loose match.
  var recruits = parsed.filter(function(p) { return p.verb === 'recruit' && p.args.length >= 1; });
  if (recruits.length === 1) {
    var re = findEntityByLooseName(schemaEntities, recruits[0].args[0]);
    if (re) return { type: 'entity_state_reached', entity: re, state: 1 };
  }

  return null;
}

function triggersEqual(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'resource_collected') {
    return String(a.resource || '').toLowerCase() === String(b.resource || '').toLowerCase()
      && Number(a.amount) === Number(b.amount);
  }
  if (a.type === 'entity_state_reached') {
    return String(a.entity || '') === String(b.entity || '')
      && Number(a.state) === Number(b.state);
  }
  if (a.type === 'click_entity') {
    return String(a.entity || '') === String(b.entity || '');
  }
  if (a.type === 'compound') {
    if (a.operator !== b.operator) return false;
    var ta = a.triggers || [];
    var tb = b.triggers || [];
    if (ta.length !== tb.length) return false;
    // order-insensitive compare for `and` operator
    if (a.operator === 'and') {
      var matched = new Array(tb.length).fill(false);
      for (var i = 0; i < ta.length; i++) {
        var found = false;
        for (var j = 0; j < tb.length; j++) {
          if (!matched[j] && triggersEqual(ta[i], tb[j])) { matched[j] = true; found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    }
    for (var k = 0; k < ta.length; k++) {
      if (!triggersEqual(ta[k], tb[k])) return false;
    }
    return true;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Walk schema phases and produce diagnostic per phase.
 * @param {object} schema - the LLM-generated game schema (will not be mutated)
 * @param {Array} specs   - blueprint.specs (source of truth)
 * @returns {{ diagnostics: Array, applied: number, mode: string }}
 */
function analyzeSchemaTriggers(schema, specs) {
  var diagnostics = [];
  if (!schema || !Array.isArray(schema.phases) || !Array.isArray(specs)) {
    return { diagnostics: diagnostics, applied: 0, mode: 'noop' };
  }
  var entities = schema.entities || [];
  for (var i = 0; i < schema.phases.length; i++) {
    var phase = schema.phases[i];
    var spec = null;
    // Match spec by phaseId; fall back to index if not found (legacy specs may lack phaseId)
    for (var j = 0; j < specs.length; j++) {
      if (specs[j] && specs[j].phaseId && phase && phase.phaseId && specs[j].phaseId === phase.phaseId) {
        spec = specs[j]; break;
      }
    }
    if (!spec) spec = specs[i] || null;
    if (!spec) {
      diagnostics.push({ phaseId: phase && phase.phaseId, status: 'no-spec' });
      continue;
    }
    var derived = deriveTriggerFromInteractions(spec.requiredInteractions, entities);
    if (!derived) {
      diagnostics.push({
        phaseId: phase.phaseId,
        status: 'no-derivation',
        llmTrigger: phase.trigger,
      });
      continue;
    }
    if (triggersEqual(phase.trigger, derived)) {
      diagnostics.push({ phaseId: phase.phaseId, status: 'agree', trigger: derived });
    } else {
      diagnostics.push({
        phaseId: phase.phaseId,
        status: 'disagree',
        llmTrigger: phase.trigger,
        derivedTrigger: derived,
        requiredInteractions: spec.requiredInteractions,
      });
    }
  }
  return { diagnostics: diagnostics, applied: 0, mode: 'analyze' };
}

/**
 * Apply derived triggers to schema in-place (only when LLM disagrees).
 * Returns the same diagnostic shape as analyze, but with mode='apply' and
 * applied=count of replacements.
 */
function applyDerivedTriggers(schema, specs) {
  var result = analyzeSchemaTriggers(schema, specs);
  var applied = 0;
  for (var i = 0; i < result.diagnostics.length; i++) {
    var d = result.diagnostics[i];
    if (d.status === 'disagree' && schema.phases[i]) {
      schema.phases[i].trigger = d.derivedTrigger;
      d.applied = true;
      applied++;
    }
  }
  result.applied = applied;
  result.mode = 'apply';
  return result;
}

/**
 * Read env DETERMINISTIC_TRIGGER_NORMALIZE and act:
 *   'apply'  → mutate schema, return diagnostics
 *   'shadow' → leave schema unchanged, return diagnostics for logging
 *   anything else → noop
 */
function maybeNormalize(schema, specs, env) {
  env = env || process.env;
  var mode = String(env.DETERMINISTIC_TRIGGER_NORMALIZE || '').toLowerCase();
  if (mode === 'apply') return applyDerivedTriggers(schema, specs);
  if (mode === 'shadow') return analyzeSchemaTriggers(schema, specs);
  return { diagnostics: [], applied: 0, mode: 'off' };
}

module.exports = {
  deriveTriggerFromInteractions: deriveTriggerFromInteractions,
  analyzeSchemaTriggers: analyzeSchemaTriggers,
  applyDerivedTriggers: applyDerivedTriggers,
  triggersEqual: triggersEqual,
  maybeNormalize: maybeNormalize,
  _internals: {
    parseInteraction: parseInteraction,
    findEntityByLooseName: findEntityByLooseName,
  },
};