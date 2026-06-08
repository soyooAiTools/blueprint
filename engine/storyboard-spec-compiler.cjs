'use strict';

var shotDurationPolicy = require('../lib/shot-duration-policy.cjs');
var storyboardIrMod = require('./storyboard-ir.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = stringValue(value);
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function normalizeKey(value) {
  return stringValue(value).toLowerCase().replace(/[\s_-]+/g, '');
}

function isCtaName(value) {
  return /cta|install|download|下载|安装|按钮/i.test(stringValue(value));
}

function buildEntityLookup(entities) {
  var aliases = {};
  var names = [];
  safeArray(entities).forEach(function(entity) {
    entity = entity || {};
    var canonical = stringValue(entity.name || entity.id);
    if (!canonical) return;
    names.push(canonical);
    ['name', 'id', 'label', 'showLabel', 'chineseName'].forEach(function(key) {
      var alias = stringValue(entity[key]);
      if (alias) aliases[normalizeKey(alias)] = canonical;
    });
  });
  if (!aliases.ctabutton && names.indexOf('CtaButton') < 0) aliases.ctabutton = 'CtaButton';
  aliases.cta = aliases.cta || aliases.ctabutton || 'CtaButton';
  return { aliases: aliases, names: uniqueStrings(names) };
}

function resolveEntityName(raw, lookup) {
  var text = stringValue(raw);
  if (!text) return '';
  var key = normalizeKey(text);
  if (lookup.aliases[key]) return lookup.aliases[key];
  if (isCtaName(text)) return lookup.aliases.ctabutton || lookup.aliases.cta || 'CtaButton';
  if (/^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(text)) return text;
  return '';
}

function isKnownEntityName(name, lookup) {
  return !!name && (safeArray(lookup.names).indexOf(name) >= 0 || isCtaName(name));
}

function resolveResourceName(raw, fallback) {
  var text = stringValue(raw || fallback);
  if (!text) return '';
  if (/^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(text)) return text;
  return '';
}

function normalizeAmount(value, fallback) {
  var n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return fallback || 1;
}

function groupFramesByChapter(frames) {
  var byChapter = {};
  safeArray(frames).forEach(function(frame, index) {
    var chapter = Number(frame && frame.chapter || 1);
    if (!Number.isFinite(chapter) || chapter <= 0) chapter = 1;
    var key = String(chapter);
    if (!byChapter[key]) byChapter[key] = { chapter: chapter, frames: [], firstIndex: index };
    byChapter[key].frames.push(frame || {});
  });
  return Object.keys(byChapter).sort(function(a, b) {
    return byChapter[a].firstIndex - byChapter[b].firstIndex;
  }).map(function(key) {
    return byChapter[key];
  });
}

function frameText(frame) {
  return [
    frame && frame.title,
    frame && frame.instruction && frame.instruction.playerText,
    frame && frame.instruction && frame.instruction.uiText,
    frame && frame.interaction && frame.interaction.raw,
  ].map(stringValue).filter(Boolean).join(' ');
}

function durationFromFrames(frames) {
  var raw = null;
  for (var i = 0; i < frames.length; i += 1) {
    raw = frames[i] && (frames[i].duration || frames[i].timing);
    if (raw) break;
  }
  return shotDurationPolicy.normalizeReviewShotDuration(raw).duration;
}

function addEntityRequired(out, name, extra) {
  if (!name) return;
  var existing = out.filter(function(item) { return item.name === name; })[0];
  if (!existing) {
    existing = { name: name, terminalState: 2, description: '' };
    out.push(existing);
  }
  if (extra && extra.resource) existing.resource = extra.resource;
  if (extra && extra.terminalState !== undefined) existing.terminalState = extra.terminalState;
  if (extra && extra.description) existing.description = extra.description;
}

function frameEntityRefs(frame) {
  var refs = [];
  safeArray(frame && frame.entities).forEach(function(name) { refs.push(name); });
  safeArray(frame && frame.visibleEntities).forEach(function(name) { refs.push(name); });
  return uniqueStrings(refs);
}

function interactionToSpecItems(interaction, lookup, phaseIndex, isFinal) {
  interaction = isObject(interaction) ? interaction : {};
  var verb = stringValue(interaction.verb) || 'observe';
  var rawTarget = interaction.target || interaction.resource || '';
  var target = resolveEntityName(rawTarget, lookup);
  var amount = normalizeAmount(interaction.amount, 1);
  var resource = resolveResourceName(interaction.resource || rawTarget, target || rawTarget);
  var items = [];
  var entitiesRequired = [];
  var goal = null;

  if ((verb === 'joystick' || verb === 'drag') && target) {
    items.push('move_to:' + target);
    addEntityRequired(entitiesRequired, target, { description: 'Target reached' });
  } else if (verb === 'click' && target) {
    items.push('click:' + target);
    addEntityRequired(entitiesRequired, target, { description: isCtaName(target) ? 'CTA available' : 'Clicked target' });
  } else if (verb === 'collect' && resource) {
    items.push('collect:' + resource + ':' + amount);
    if (isKnownEntityName(target, lookup)) {
      addEntityRequired(entitiesRequired, target, { resource: resource, description: 'Collectible resource target' });
    }
    goal = { kind: 'amount', target: amount, displayResource: resource };
  } else if (verb === 'attack' && target) {
    items.push('attack:' + target);
    addEntityRequired(entitiesRequired, target, { terminalState: 0, description: 'Target defeated' });
  } else if (verb === 'build' && target) {
    items.push('build:' + target);
    addEntityRequired(entitiesRequired, target, { terminalState: 2, description: 'Build completed' });
  } else if (verb === 'upgrade' && target) {
    items.push('upgrade:' + target + ':' + amount);
    addEntityRequired(entitiesRequired, target, { terminalState: amount, description: 'Upgrade completed' });
  } else if (verb === 'wait') {
    items.push('wait:' + Math.max(1, amount));
  }

  if (isFinal && items.length === 0) {
    var cta = resolveEntityName('CtaButton', lookup) || 'CtaButton';
    items.push('click:' + cta);
    addEntityRequired(entitiesRequired, cta, { description: 'Final CTA' });
  }

  return {
    requiredInteractions: items,
    entitiesRequired: entitiesRequired,
    goal: goal,
    actionCount: items.filter(function(item) { return !/^wait:/.test(item); }).length,
  };
}

function triggerFromInteractions(requiredInteractions, entitiesRequired, isFinal) {
  var first = safeArray(requiredInteractions)[0] || '';
  var parts = first.split(':');
  var verb = parts[0] || '';
  var target = parts[1] || '';
  var amount = normalizeAmount(parts[2], 1);
  if (isFinal && (verb === 'click' || isCtaName(target))) {
    return { condition: 'CtaButton.clicked', description: 'CTA clicked' };
  }
  if (verb === 'collect' && target) {
    return { condition: target + '.amount >= ' + amount, description: 'Collected ' + amount + ' ' + target };
  }
  if (verb === 'build' && target) {
    return { condition: target + 'State == 2', description: target + ' built' };
  }
  if (verb === 'upgrade' && target) {
    return { condition: target + 'State == ' + amount, description: target + ' upgraded' };
  }
  if (verb === 'attack' && target) {
    return { condition: target + 'Hp <= 0', description: target + ' defeated' };
  }
  if ((verb === 'move_to' || verb === 'click') && target) {
    return { condition: target + 'Reached == true', description: 'Reached ' + target };
  }
  if (verb === 'wait') {
    return { condition: 'timer >= ' + amount, description: 'Timer elapsed' };
  }
  var firstEntity = safeArray(entitiesRequired)[0] && safeArray(entitiesRequired)[0].name;
  if (firstEntity) return { condition: firstEntity + 'Reached == true', description: 'Reached ' + firstEntity };
  return { condition: '', description: '' };
}

function phaseTitle(group, index) {
  var first = group.frames[0] || {};
  return stringValue(first.chapterTitle || first.title) || ('Phase ' + (index + 1));
}

function compileSpecsFromStoryboardIr(inputIr, options) {
  options = options || {};
  var ir = inputIr && inputIr.kind === 'blueprint.storyboardIr'
    ? inputIr
    : storyboardIrMod.normalizeStoryboardIr(inputIr || {}, options);
  var lookup = buildEntityLookup(options.entities || inputIr && inputIr.entities || []);
  var groups = groupFramesByChapter(ir.frames);
  var diagnostics = [];
  var specs = [];
  var actionPhaseCount = 0;

  groups.forEach(function(group, index) {
    var requiredInteractions = [];
    var entitiesRequired = [];
    var visibleEntities = [];
    var goal = null;
    var isFinal = index === groups.length - 1;
    group.frames.forEach(function(frame) {
      frameEntityRefs(frame).forEach(function(name) {
        var resolved = resolveEntityName(name, lookup) || name;
        if (!resolved) return;
        visibleEntities.push(resolved);
        addEntityRequired(entitiesRequired, resolved, { description: 'Storyboard-visible entity' });
      });
      var derived = interactionToSpecItems(frame.interaction, lookup, index, isFinal);
      requiredInteractions = requiredInteractions.concat(derived.requiredInteractions);
      derived.entitiesRequired.forEach(function(entity) {
        addEntityRequired(entitiesRequired, entity.name, entity);
      });
      if (!goal && derived.goal) goal = derived.goal;
    });
    requiredInteractions = uniqueStrings(requiredInteractions);
    if (requiredInteractions.some(function(item) { return !/^wait:/.test(item); })) actionPhaseCount += 1;
    var title = phaseTitle(group, index);
    var instruction = stringValue((group.frames.map(frameText).filter(Boolean)[0] || title)).slice(0, 30);
    var spec = {
      phaseId: 'phase' + (index + 1),
      phaseName: title,
      chapterId: group.chapter,
      duration: durationFromFrames(group.frames),
      requiredInteractions: requiredInteractions,
      triggerNext: triggerFromInteractions(requiredInteractions, entitiesRequired, isFinal),
      entitiesRequired: entitiesRequired,
      visibleEntities: uniqueStrings(visibleEntities),
      playerMustAct: requiredInteractions.length > 0,
      autoAllowed: false,
      formSwitch: null,
      playerInstruction: instruction,
    };
    if (goal) spec.goal = goal;
    if (requiredInteractions.length === 0) {
      spec.playerMustAct = false;
      spec.autoAllowed = true;
      spec.autoModeHint = instruction || '观察场景变化';
      delete spec.playerInstruction;
      diagnostics.push({ code: 'storyboard_spec_phase_no_actions', severity: 'warning', phaseId: spec.phaseId });
    }
    specs.push(spec);
  });

  if (specs.length === 0) diagnostics.push({ code: 'storyboard_spec_no_phases', severity: 'error' });
  var actionCoverage = specs.length ? actionPhaseCount / specs.length : 0;
  var minActionCoverage = options.minActionCoverage == null ? 0.5 : Number(options.minActionCoverage);
  var ok = specs.length > 0 && actionCoverage >= minActionCoverage;
  if (!ok) {
    diagnostics.push({
      code: 'storyboard_spec_low_action_coverage',
      severity: 'warning',
      actionCoverage: Math.round(actionCoverage * 100) / 100,
      minActionCoverage: minActionCoverage,
    });
  }
  return {
    ok: ok,
    source: 'storyboard-ir',
    storyboardIr: ir,
    specs: specs,
    diagnostics: diagnostics,
    summary: {
      phaseCount: specs.length,
      frameCount: safeArray(ir.frames).length,
      actionPhaseCount: actionPhaseCount,
      actionCoverage: Math.round(actionCoverage * 100) / 100,
    },
  };
}

module.exports = {
  compileSpecsFromStoryboardIr: compileSpecsFromStoryboardIr,
  _internals: {
    buildEntityLookup: buildEntityLookup,
    resolveEntityName: resolveEntityName,
    interactionToSpecItems: interactionToSpecItems,
    triggerFromInteractions: triggerFromInteractions,
  },
};
