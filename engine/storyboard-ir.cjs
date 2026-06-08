'use strict';

var crypto = require('crypto');

var STORYBOARD_IR_SCHEMA_VERSION = 'storyboard-ir.v1';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ':' + stableJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function semanticHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function numberValue(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeId(value, fallback) {
  var text = stringValue(value).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (!text) text = fallback || 'item';
  if (!/^[A-Za-z_]/.test(text)) text = 'id_' + text;
  return text;
}

function resolveFrames(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.frames)) return input.frames;
  if (Array.isArray(input.storyboardFrames)) return input.storyboardFrames;
  if (input.storyboard && Array.isArray(input.storyboard.frames)) return input.storyboard.frames;
  if (input.blueprint) return resolveFrames(input.blueprint);
  return [];
}

function resolveSheet(input, key) {
  if (!input) return {};
  if (input[key] && typeof input[key] === 'object' && !Array.isArray(input[key])) return input[key];
  if (input.storyboard && input.storyboard[key] && typeof input.storyboard[key] === 'object' && !Array.isArray(input.storyboard[key])) {
    return input.storyboard[key];
  }
  if (input.blueprint) return resolveSheet(input.blueprint, key);
  return {};
}

function normalizeSheet(sheet) {
  var out = {};
  Object.keys(sheet || {}).sort().forEach(function(key) {
    var value = sheet[key];
    if (value == null) return;
    out[sanitizeId(key, 'sheet')] = typeof value === 'object' ? clone(value) : stringValue(value);
  });
  return out;
}

function collectEntityNames(input, options) {
  var entities = safeArray(options && options.entities).concat(safeArray(input && input.entities));
  if (input && input.blueprint) entities = entities.concat(safeArray(input.blueprint.entities));
  var seen = {};
  var out = [];
  entities.forEach(function(entity) {
    ['name', 'id', 'label', 'chineseName'].forEach(function(key) {
      var name = stringValue(entity && entity[key]);
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push(name);
    });
  });
  return out;
}

function inferVerb(raw) {
  var text = stringValue(raw).toLowerCase();
  if (!text) return 'observe';
  if (/^(click|tap)(:|\b|$)|点击|点按|按钮/.test(text)) return 'click';
  if (/^(drag|drop)(:|\b|$)|拖拽|拖动|拖到/.test(text)) return 'drag';
  if (/^(move_to|move|reach|near)(:|\b|$)/.test(text)) return 'joystick';
  if (/joystick|摇杆|移动|走向|靠近|滑动|swipe/.test(text)) return 'joystick';
  if (/^(collect|gather|pickup)(:|\b|$)|收集|拾取|采集|获得/.test(text)) return 'collect';
  if (/^(attack|shoot|defeat)(:|\b|$)|攻击|射击|消灭|击败/.test(text)) return 'attack';
  if (/^(build|repair)(:|\b|$)|建造|修复|搭建/.test(text)) return 'build';
  if (/^(upgrade)(:|\b|$)|升级/.test(text)) return 'upgrade';
  if (/^(wait|timer)(:|\b|$)|等待|倒计时/.test(text)) return 'wait';
  return 'observe';
}

function parseColonInteraction(raw) {
  var parts = stringValue(raw).split(':').map(function(part) { return part.trim(); }).filter(Boolean);
  if (parts.length < 2) return null;
  return {
    verb: inferVerb(parts[0]),
    target: parts[1] || '',
    resource: parts[0].toLowerCase() === 'collect' ? parts[1] || '' : '',
    amount: numberValue(parts[2], null),
  };
}

function inferTarget(text, entityNames) {
  var hay = stringValue(text);
  for (var i = 0; i < entityNames.length; i++) {
    var name = entityNames[i];
    if (name && hay.indexOf(name) >= 0) return name;
  }
  return '';
}

function normalizeEntityRefs(value) {
  var refs = [];
  safeArray(value).forEach(function(item) {
    var name = typeof item === 'string' ? item : stringValue(item && (item.name || item.id || item.entity || item.target));
    if (name) refs.push(name);
  });
  var seen = {};
  return refs.filter(function(name) {
    if (seen[name]) return false;
    seen[name] = true;
    return true;
  });
}

function normalizeInteraction(frame, entityNames) {
  var raw = stringValue(frame.interaction || frame.action || frame.guide || frame.ui || frame.caption || frame.title);
  var parsed = parseColonInteraction(raw) || {};
  var joined = [
    raw,
    frame.title,
    frame.ui,
    frame.guide,
    frame.action,
    frame.caption,
    frame.scene,
    frame.prompt,
  ].map(stringValue).join('\n');
  var verb = parsed.verb || inferVerb(raw || joined);
  var target = parsed.target || inferTarget(joined, entityNames);
  return {
    raw: raw,
    verb: verb,
    target: target || null,
    resource: parsed.resource || null,
    amount: parsed.amount == null ? null : parsed.amount,
    riskHints: ['joystick', 'drag'].indexOf(verb) >= 0 ? [verb] : [],
  };
}

function normalizeFrame(frame, index, entityNames) {
  frame = frame || {};
  var chapter = numberValue(frame.chapter, 1);
  var step = numberValue(frame.step, index + 1);
  var id = sanitizeId(frame.id || frame.frameId || frame.shotId || ('frame' + (index + 1)), 'frame' + (index + 1));
  return {
    index: index,
    id: id,
    chapter: chapter,
    chapterTitle: stringValue(frame.chapterTitle || frame.chapterName),
    step: step,
    title: stringValue(frame.title || frame.name || id),
    visual: {
      prompt: stringValue(frame.prompt || frame.visualPrompt),
      sceneText: stringValue(frame.scene || frame.description || frame.note),
      camera: frame.camera || null,
      image: frame.image || frame.imageUrl || frame.asset || null,
    },
    instruction: {
      uiText: stringValue(frame.ui || frame.guide || frame.caption),
      playerText: stringValue(frame.interaction || frame.action || frame.guide),
    },
    interaction: normalizeInteraction(frame, entityNames),
    entities: normalizeEntityRefs(frame.entities || frame.sceneEntities || frame.phaseEntities),
    visibleEntities: normalizeEntityRefs(frame.visibleEntities || frame.showEntities),
    duration: frame.duration || frame.durationSec || null,
  };
}

function buildChapters(frames) {
  var byKey = {};
  frames.forEach(function(frame) {
    var key = String(frame.chapter || 1);
    if (!byKey[key]) {
      byKey[key] = {
        chapter: frame.chapter || 1,
        title: frame.chapterTitle || frame.title || ('chapter ' + key),
        frameIds: [],
      };
    }
    byKey[key].frameIds.push(frame.id);
  });
  return Object.keys(byKey).sort(function(a, b) { return Number(a) - Number(b); }).map(function(key) {
    return byKey[key];
  });
}

function normalizeStoryboardIr(input, options) {
  options = options || {};
  var framesInput = resolveFrames(input);
  var entityNames = collectEntityNames(input, options);
  var frames = framesInput.map(function(frame, index) {
    return normalizeFrame(frame, index, entityNames);
  });
  var projectName = stringValue(options.projectName || input && (input.projectName || input.name) || input && input.project && input.project.name) || 'storyboard';
  var ir = {
    schemaVersion: STORYBOARD_IR_SCHEMA_VERSION,
    kind: 'blueprint.storyboardIr',
    project: {
      name: projectName,
      theme: stringValue(options.theme || input && (input.theme || input.themeHint)) || null,
    },
    characterSheet: normalizeSheet(resolveSheet(input, 'characterSheet')),
    sceneSheet: normalizeSheet(resolveSheet(input, 'sceneSheet')),
    chapters: [],
    frames: frames,
    diagnostics: [],
  };
  ir.chapters = buildChapters(frames);
  if (frames.length === 0) ir.diagnostics.push({ code: 'storyboard_ir_no_frames', severity: 'error' });
  frames.forEach(function(frame) {
    if (!frame.visual.sceneText && !frame.visual.prompt) {
      ir.diagnostics.push({ code: 'storyboard_ir_frame_missing_visual', severity: 'warning', frameId: frame.id });
    }
    if (!frame.instruction.playerText && frame.interaction.verb === 'observe') {
      ir.diagnostics.push({ code: 'storyboard_ir_frame_missing_interaction', severity: 'warning', frameId: frame.id });
    }
  });
  ir.semanticHash = semanticHash({
    schemaVersion: ir.schemaVersion,
    project: ir.project,
    characterSheet: ir.characterSheet,
    sceneSheet: ir.sceneSheet,
    chapters: ir.chapters,
    frames: ir.frames,
  });
  return ir;
}

function assertStoryboardIr(ir) {
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) throw new Error('storyboard IR must be an object');
  if (ir.schemaVersion !== STORYBOARD_IR_SCHEMA_VERSION) throw new Error('unsupported storyboard IR schemaVersion: ' + ir.schemaVersion);
  if (ir.kind !== 'blueprint.storyboardIr') throw new Error('invalid storyboard IR kind: ' + ir.kind);
  if (!Array.isArray(ir.frames)) throw new Error('storyboard IR frames must be an array');
  ir.frames.forEach(function(frame, index) {
    if (!frame.id) throw new Error('storyboard IR frame[' + index + '] missing id');
    if (!frame.interaction || !frame.interaction.verb) throw new Error('storyboard IR frame[' + index + '] missing interaction.verb');
  });
  return true;
}

module.exports = {
  STORYBOARD_IR_SCHEMA_VERSION: STORYBOARD_IR_SCHEMA_VERSION,
  normalizeStoryboardIr: normalizeStoryboardIr,
  assertStoryboardIr: assertStoryboardIr,
  _internals: {
    stableJson: stableJson,
    semanticHash: semanticHash,
    inferVerb: inferVerb,
    normalizeInteraction: normalizeInteraction,
  },
};
