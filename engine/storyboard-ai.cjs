'use strict';

var crypto = require('crypto');

var STORYBOARD_AI_SCHEMA_VERSION = 'storyboard-ai.v1';
var STORYBOARD_AI_KIND = 'blueprint.storyboardAi';
var PHASE_MIN = 10;
var PHASE_MAX = 13;

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

function normalizePhaseId(value, index) {
  var text = stringValue(value).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (!text) return 'phase' + (index + 1);
  if (/^phase\d+$/i.test(text)) return 'phase' + Number(text.match(/\d+/)[0]);
  if (/^\d+$/.test(text)) return 'phase' + Number(text);
  return text;
}

function inferCtaInteraction(text) {
  if (/cta|install|download|下载|安装|立即|跳转|结束/i.test(text)) return 'click:CtaButton';
  return '';
}

function normalizeCanonicalInteraction(phase, index, total) {
  var explicit = stringValue(phase.canonicalInteraction || phase.interaction || phase.action);
  if (explicit) return explicit;
  var required = safeArray(phase.requiredInteractions).map(stringValue).filter(Boolean);
  if (required.length) return required[0];
  var text = [
    phase.title,
    phase.sceneText || phase.scene,
    phase.playerAction || phase.instruction,
    phase.feedback,
    phase.uiText || phase.ui,
  ].map(stringValue).join(' ');
  if (index === total - 1) return inferCtaInteraction(text) || 'click:CtaButton';
  if (/采集|收集|拾取|collect|gather/i.test(text)) return 'collect:Resource:1';
  if (/建造|搭建|修建|build/i.test(text)) return 'build:Target';
  if (/升级|upgrade/i.test(text)) return 'upgrade:Target:2';
  if (/攻击|消灭|击败|attack|shoot/i.test(text)) return 'attack:Enemy';
  if (/移动|前往|靠近|摇杆|joystick|move/i.test(text)) return 'move_to:Target';
  if (/点击|tap|click/i.test(text)) return 'click:Target';
  return 'observe';
}

function inferPrimaryTarget(phase, canonicalInteraction) {
  var target = stringValue(phase.primaryTarget || phase.target);
  if (target) return target;
  var parts = stringValue(canonicalInteraction).split(':');
  if (parts[1] && parts[0] !== 'collect') return parts[1];
  if (parts[0] === 'collect' && parts[1]) return parts[1];
  return '';
}

function normalizeEvidence(value) {
  return safeArray(value).map(function(item) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      return [
        item.source,
        item.locator || item.path || item.time,
        item.text,
      ].map(stringValue).filter(Boolean).join(':');
    }
    return '';
  }).filter(Boolean);
}

function resolveInputPhases(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.phases)) return input.phases;
  if (Array.isArray(input.customerStoryboardRows)) return input.customerStoryboardRows;
  if (Array.isArray(input.rows)) return input.rows;
  if (Array.isArray(input.frames)) return input.frames;
  if (Array.isArray(input.storyboardFrames)) return input.storyboardFrames;
  if (input.storyboard && Array.isArray(input.storyboard.frames)) return input.storyboard.frames;
  if (input.blueprint) return resolveInputPhases(input.blueprint);
  return [];
}

function phaseText(phase) {
  return [
    phase.title,
    phase.sceneText || phase.scene,
    phase.playerAction || phase.interaction,
    phase.feedback,
    phase.uiText || phase.ui,
  ].map(stringValue).filter(Boolean).join(' ');
}

function normalizePhase(phase, index, total) {
  phase = phase || {};
  var canonicalInteraction = normalizeCanonicalInteraction(phase, index, total);
  var requiredInteractions = safeArray(phase.requiredInteractions).map(stringValue).filter(Boolean);
  var title = stringValue(phase.title || phase.phaseTitle || phase.phaseName || phase.chapterTitle || phase.name) || ('Phase ' + (index + 1));
  var sceneText = stringValue(phase.sceneText || phase.scene || phase.description || phase.visual && phase.visual.sceneText);
  var playerAction = stringValue(phase.playerAction || phase.instruction && phase.instruction.playerText || phase.interaction || phase.action);
  var feedback = stringValue(phase.feedback || phase.result || phase.outcome);
  var uiText = stringValue(phase.uiText || phase.ui || phase.guide || phase.caption || phase.instruction && phase.instruction.uiText);
  return {
    phaseId: normalizePhaseId(phase.phaseId || phase.id || phase.chapter, index),
    title: title,
    sceneText: sceneText,
    playerAction: playerAction,
    feedback: feedback,
    uiText: uiText,
    primaryTarget: inferPrimaryTarget(phase, canonicalInteraction),
    canonicalInteraction: canonicalInteraction,
    requiredInteractions: requiredInteractions,
    image: phase.image || phase.imageUrl || phase.asset || phase.visual && phase.visual.image || '',
    visualBrief: phase.visualBrief && typeof phase.visualBrief === 'object' ? clone(phase.visualBrief) : null,
    visualPrompt: stringValue(phase.visualPrompt || phase.prompt || phase.visual && phase.visual.prompt),
    sourceEvidence: normalizeEvidence(phase.sourceEvidence || phase.evidence || phase.sources),
    sourceRows: safeArray(phase.sourceRows || phase.rows).map(function(row) { return stringValue(row); }).filter(Boolean),
    confidence: phase.confidence == null ? null : Number(phase.confidence),
    clientStatus: stringValue(phase.clientStatus || phase.status),
  };
}

function defaultCoreLoop(phases) {
  var titles = safeArray(phases).map(function(phase) { return phase.title; }).filter(Boolean);
  if (!titles.length) return '';
  return titles.slice(0, 7).join(' -> ') + (titles.length > 7 ? ' -> CTA' : '');
}

function normalizeStoryboardAi(input, options) {
  options = options || {};
  input = input || {};
  var rawPhases = resolveInputPhases(input);
  var normalized = rawPhases.map(function(phase, index) {
    return normalizePhase(phase, index, rawPhases.length);
  });
  var projectName = stringValue(options.projectName || input.projectName || input.name || input.project && input.project.name) || 'AI试玩广告分镜';
  var coreLoop = stringValue(options.coreLoop || input.coreLoop || input.project && input.project.coreLoop) || defaultCoreLoop(normalized);
  var out = {
    schemaVersion: STORYBOARD_AI_SCHEMA_VERSION,
    kind: STORYBOARD_AI_KIND,
    project: {
      name: projectName,
      coreLoop: coreLoop,
      customerPdfTemplate: 'customer-storyboard-pdf.v1',
    },
    phases: normalized,
    diagnostics: [],
  };
  var count = normalized.length;
  if (count < PHASE_MIN || count > PHASE_MAX) {
    out.diagnostics.push({
      code: 'storyboard_ai_phase_count_out_of_bounds',
      severity: 'warning',
      phaseCount: count,
      min: PHASE_MIN,
      max: PHASE_MAX,
    });
  }
  normalized.forEach(function(phase, index) {
    if (!phase.sceneText && !phase.visualPrompt && !phase.visualBrief) {
      out.diagnostics.push({ code: 'storyboard_ai_phase_missing_visual_text', severity: 'warning', phaseId: phase.phaseId });
    }
    if (!phase.playerAction && phase.canonicalInteraction === 'observe' && index !== normalized.length - 1) {
      out.diagnostics.push({ code: 'storyboard_ai_phase_missing_action', severity: 'warning', phaseId: phase.phaseId });
    }
    if (!phase.image && !phase.visualPrompt && !phase.visualBrief) {
      out.diagnostics.push({ code: 'storyboard_ai_phase_missing_image_source', severity: 'warning', phaseId: phase.phaseId });
    }
  });
  out.semanticHash = semanticHash({
    schemaVersion: out.schemaVersion,
    project: out.project,
    phases: out.phases,
  });
  return out;
}

function assertStoryboardAi(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('storyboard-ai must be an object');
  if (doc.schemaVersion !== STORYBOARD_AI_SCHEMA_VERSION) throw new Error('unsupported storyboard-ai schemaVersion: ' + doc.schemaVersion);
  if (doc.kind !== STORYBOARD_AI_KIND) throw new Error('invalid storyboard-ai kind: ' + doc.kind);
  if (!Array.isArray(doc.phases)) throw new Error('storyboard-ai phases must be an array');
  doc.phases.forEach(function(phase, index) {
    if (!phase || typeof phase !== 'object') throw new Error('storyboard-ai phase[' + index + '] must be an object');
    if (!phase.phaseId) throw new Error('storyboard-ai phase[' + index + '] missing phaseId');
    if (!phase.title) throw new Error('storyboard-ai phase[' + index + '] missing title');
  });
  return true;
}

function toLegacyStoryboardFrames(storyboardAi) {
  var ai = storyboardAi && storyboardAi.kind === STORYBOARD_AI_KIND
    ? storyboardAi
    : normalizeStoryboardAi(storyboardAi || {});
  return ai.phases.map(function(phase, index) {
    return {
      id: phase.phaseId,
      chapter: index + 1,
      chapterTitle: phase.title,
      step: 1,
      title: phase.title,
      scene: [phase.sceneText, phase.feedback].filter(Boolean).join(' '),
      interaction: phase.canonicalInteraction,
      ui: phase.uiText || phase.playerAction,
      image: phase.image,
      prompt: phase.visualPrompt,
    };
  });
}

module.exports = {
  STORYBOARD_AI_SCHEMA_VERSION: STORYBOARD_AI_SCHEMA_VERSION,
  STORYBOARD_AI_KIND: STORYBOARD_AI_KIND,
  PHASE_MIN: PHASE_MIN,
  PHASE_MAX: PHASE_MAX,
  normalizeStoryboardAi: normalizeStoryboardAi,
  assertStoryboardAi: assertStoryboardAi,
  toLegacyStoryboardFrames: toLegacyStoryboardFrames,
  _internals: {
    normalizePhase: normalizePhase,
    normalizeCanonicalInteraction: normalizeCanonicalInteraction,
    normalizePhaseId: normalizePhaseId,
    semanticHash: semanticHash,
    stableJson: stableJson,
  },
};
