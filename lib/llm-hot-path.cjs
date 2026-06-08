'use strict';

function normalizeMode(env) {
  env = env || process.env;
  var raw = String(env.NO_LLM_HOT_PATH || env.BLUEPRINT_NO_LLM_HOT_PATH || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'false' || raw === 'off' || raw === 'disabled' || raw === 'none') return 'off';
  if (raw === 'enforce' || raw === 'block' || raw === 'blocking' || raw === 'strict' || raw === 'fail') return 'enforce';
  if (raw === 'shadow' || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return 'shadow';
  return 'shadow';
}

function safeText(value, maxLen) {
  if (value == null) return null;
  var text;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value); }
    catch (_) { text = String(value); }
  }
  maxLen = maxLen || 500;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function compactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  var out = {};
  Object.keys(metadata).slice(0, 24).forEach(function(key) {
    var value = metadata[key];
    if (value == null) return;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 12).map(function(item) { return safeText(item, 160); });
    else out[key] = safeText(value, 240);
  });
  return out;
}

function ensureState(ctx, mode) {
  var blueprint = ctx && ctx.blueprint;
  if (!blueprint) return null;
  if (!blueprint.noLlmHotPath) {
    blueprint.noLlmHotPath = {
      schemaVersion: '1.0.0',
      mode: mode,
      events: [],
      shadowCount: 0,
      blockedCount: 0,
      callsites: {},
    };
  }
  blueprint.noLlmHotPath.mode = mode;
  return blueprint.noLlmHotPath;
}

function stageLog(ctx, stage, message) {
  if (!ctx || typeof ctx.addLog !== 'function') return;
  try {
    if (ctx.addLog.length >= 2) ctx.addLog(stage || 'no-llm-hot-path', message);
    else ctx.addLog('[no-llm-hot-path] ' + message);
  } catch (_) {}
}

function record(ctx, callsite, options) {
  options = options || {};
  var mode = options.mode || normalizeMode(options.env);
  if (mode === 'off') return { enabled: false, mode: mode, blocked: false };

  var event = {
    ts: new Date().toISOString(),
    mode: mode,
    action: mode === 'enforce' ? 'blocked' : 'shadow',
    stage: options.stage || '',
    callsite: callsite,
    purpose: options.purpose || '',
    reason: options.reason || '',
    estimatedTokens: Number(options.estimatedTokens || 0) || 0,
    metadata: compactMetadata(options.metadata || {}),
  };

  var state = ensureState(ctx, mode);
  if (state) {
    state.events.push(event);
    if (state.events.length > 200) state.events = state.events.slice(-200);
    if (mode === 'enforce') state.blockedCount++;
    else state.shadowCount++;
    state.callsites[callsite] = (state.callsites[callsite] || 0) + 1;
  }

  var msg = event.action + ': ' + callsite;
  if (event.purpose) msg += ' (' + event.purpose + ')';
  if (event.reason) msg += ' — ' + event.reason;
  stageLog(ctx, options.stage || 'no-llm-hot-path', msg);

  if (mode === 'enforce') {
    var err = new Error('NO_LLM_HOT_PATH_BLOCKED: ' + callsite +
      (event.purpose ? ' (' + event.purpose + ')' : '') +
      (event.reason ? ' — ' + event.reason : ''));
    err.code = 'NO_LLM_HOT_PATH_BLOCKED';
    err.classification = 'FATAL';
    err.noLlmHotPathEvent = event;
    throw err;
  }

  return {
    enabled: true,
    mode: mode,
    blocked: false,
    event: event,
  };
}

function guard(ctx, callsite, options) {
  return record(ctx, callsite, options);
}

function summarize(blueprint) {
  var state = blueprint && blueprint.noLlmHotPath;
  if (!state) return null;
  return {
    mode: state.mode || 'off',
    shadowCount: state.shadowCount || 0,
    blockedCount: state.blockedCount || 0,
    eventCount: Array.isArray(state.events) ? state.events.length : 0,
    callsites: Object.assign({}, state.callsites || {}),
    events: Array.isArray(state.events) ? state.events.slice(-50) : [],
  };
}

module.exports = {
  normalizeMode: normalizeMode,
  guard: guard,
  record: record,
  summarize: summarize,
  _internals: {
    compactMetadata: compactMetadata,
  },
};
