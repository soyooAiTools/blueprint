'use strict';

var contract = require('./storyboard2html-contract.cjs');

var DEFAULT_MODEL = 'claude-sonnet-4-6';
var DEFAULT_TIMEOUT_MS = 600000;
var DEFAULT_MIN_OUTPUT_LEN = 2000;

var SYSTEM_PROMPT_HEADER = [
  '你是 storyboard2html 生成器。把 Blueprint specs(逆向分镜驱动)转成 *单文件可运行 HTML demo*,',
  '同一份 HTML 既驱动 three.js/Canvas 视觉,也暴露 storyboard2html v1.0.0 契约,',
  '保证 demo2spec 反解 + Luna 同向迁移 + CUA verify 主门一次过。',
  '',
  '## 输出格式',
  '- 只输出 *单一完整 HTML 文档*,以 `<!doctype html>` 起,以 `</html>` 止。',
  '- 不要 markdown 围栏(无 ``` 包裹),不要任何解释/前言/后记。',
  '- 不要 `import`/`require`,所有 JS inline 在 `<script>`;允许通过 CDN `<script src="https://...">` 加载 three.js。',
  '- 浏览器原生 ES2018 即可,不要 TypeScript 语法。',
  '',
  '## L1 — HTML 静态入口(强约束,demo2spec 静态解析必须命中)',
  '- 顶层声明 `const PHASES = [...]`(或 `let`/`var`/`window.PHASES = [...]`)。',
  '- 每个 PHASES[i] 含字段:`id` (字符串 `phase{n}`)、`name`、`goalText`;',
  '  推荐补:`guideText`、`durationSec`、`showEntities[]`、`trigger{type,...}`、`plannedModuleIds[]`。',
  '- 提供 `function setTip(text, ms)` *或* `window.setTip = function(text, ms) { ... }`:',
  '  必须可见更新引导文本,并把最新文本保留到闭包 / 全局,供 `window.__gameState().ui_state.guideText` 读到。',
  '- 每个 phase 提供具名函数 `enterPhase<N>` / `completePhase<N>`(N 从 1 起);可选 `updatePhase<N>`。',
  '- 第一个 phase 必须存在 `showEntities >= 3`(默认实体可见 / spawn)。',
  '- 最后一个 phase 的 `trigger.type` 必须是 `click_entity`,且 `trigger.entity === "CtaButton"`,',
  '  对应 phaseEvidence 写 `cta_finish` 模块 + `final_phase: true`。',
  '',
  '## L2 — 运行态契约 window.__gameState',
  '- 必须挂 `window.__gameState = function() { return state; }`(函数形态优先;允许直接对象但 phaseRealTimer 必须自更新)。',
  '- 返回对象必含 top-level keys: `phase`(string `phase{n}`)、`phaseRealTimer`(秒,实时 wall-clock,*不能*用帧数)、',
  '  `entity_states`(object map: name → {visible, position:{x,y,z}, state})、',
  '  `phaseEvidence`(object,见 L3)。',
  '- 推荐补:`resources`(name→balance)、`inventory`(资源镜像)、`visibleEntities[]`、',
  '  `ui_state.guideText`、`camera_state`、`completedPhases[]`(`["phase1","phase2",...]`)。',
  '- 允许双键写入兼容(`entityStates` / `entity_states`、`uiState` / `ui_state`、`cameraState` / `camera_state`)。',
  '- phaseRealTimer 每次 phase 切换归零;基于 `Date.now()` / `performance.now()` 差值,不是 phaseIndex/frame。',
  '',
  '## L3 — phaseEvidence envelope(每 phase 每 module 一条)',
  '- 路径:`phaseEvidence.phase{N}.{moduleId}`。',
  '- 每个 module 对象必须含 `_meta`:`{ schemaVersion: "1.0.0", sourcePlatform: "html", sourceModuleId: "<moduleId>" }`。',
  '- 同层 `_meta` 允许补:`generatedAt`、`sourceAtomIds[]`、`synthetic`。',
  '- 同层 phase 上(`phaseEvidence.phase{N}`)允许写 flat signal bool:',
  '  `guide_text_visible` / `phase_advanced` / `resource_incremented` / `source_hidden_or_moved` /',
  '  `entity_visible` / `downstream_entity_visible` / `entity_state_changed`。',
  '- module 触发 = phase 真正发生该模块对应行为时,把对应模块条目写入 + 把对应 flat signal 置 true。',
  '- 仅写 spec.plannedModuleIds 列举的 module(及 cta_finish 在最后一相),不要多写无关 module。',
  '',
  '## 模块 evidence 模板(必须复用这些 key,不能改名)',
  '- guide_ui:`{ _meta, text, before:{text}, after:{text}, text_changed, visible }`,phase 切换 enter 时写,同步 flat `guide_text_visible=true`。',
  '- inventory_wallet:`{ _meta, resource, operation:"add"|"sub", before:{balance}, after:{balance}, score_text_visible }`,资源增减时写 + flat `resource_incremented=true`。',
  '- collect_on_near:`{ _meta, resource, item, count, range, before:{balance}, after:{balance}, sourceHidden:true }`,玩家近距离收集时写 + flat `resource_incremented=true` + `source_hidden_or_moved=true`。',
  '- phase_gate_timer:`{ _meta, seconds_required, seconds_elapsed, before:{phase_index}, after:{phase_index}, timer_completed, phase_advanced_by_timer }`,timer trigger 完成时写 + flat `phase_advanced=true`。',
  '- visual_binding:`{ _meta, entity, operation:"show"|"hide"|"move", before:{visible}, after:{visible}, position, scale_applied }`,entity 显隐/位置变时写 + flat `entity_visible=true`。',
  '- spawn_once:`{ _meta, target, position, placed:true }`,首次 spawn 时写 + flat `downstream_entity_visible=true` + `entity_state_changed=true`。',
  '- cta_finish:`{ _meta, target:"CtaButton", cta_visible:true, install_called_or_ready:true, final_phase:true }`,最后一 phase 写。',
  '- highlight_target:`{ _meta, target, glow:true, ring_visible:true }`。',
  '- floating_text_feedback:`{ _meta, text, position, color, duration_ms }`。',
  '- click_trigger:`{ _meta, target, click_count, before:{clicks:0}, after:{clicks:1} }`。',
  '- player_input_tap:`{ _meta, target, x_norm, y_norm, captured:true }`。',
  '- 其它 moduleId 若 plan 出现,按相同 `{ _meta, before, after, ... }` 三段式写。',
  '',
  '## 视觉/交互要求',
  '- 用 three.js (CDN https://cdn.jsdelivr.net/npm/three@0.156.1/build/three.min.js) 或纯 Canvas;场景必须真有元素,*禁止全黑/空白*。',
  '- 每 phase 至少能从 UI 引导文本(`#tip` div)看出"切到下个 phase",视觉上有变化(entity show/hide/move 任一)。',
  '- 玩家不需要真操作:可以 auto-progress(setTimeout 推 advancePhase),但 phase 间至少 600ms 间隔,不要瞬切。',
  '- 最后一 phase 必须有 DOM CTA 按钮(id=cta-button),点击触发 phase 完成 + cta_finish module 写入。',
  '- 全部资源用整数计数;HUD 顶栏显示资源/引导文本。',
  '',
  '## 禁止反规则',
  '- 不允许把 phaseRealTimer 写成 frame count / phaseIndex / 0。',
  '- 不允许遗漏 `_meta.schemaVersion="1.0.0"` 或 `_meta.sourcePlatform="html"`。',
  '- 不允许把 PHASES 写成 `function PHASES()` 或闭包内变量(必须顶层声明)。',
  '- 不允许 phaseEvidence 里出现 undefined / 函数 / Symbol;只用 primitive + object。',
  '- 不允许最后一 phase 缺 `cta_finish` 模块或 CtaButton。',
  '',
].join('\n');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function describeTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return null;
  if (trigger.type === 'compound') {
    var inner = safeArray(trigger.triggers).map(describeTrigger).filter(Boolean).join(' ' + (trigger.operator || 'and') + ' ');
    return inner ? 'compound(' + inner + ')' : 'compound()';
  }
  if (trigger.type === 'timer') return 'timer(' + (trigger.seconds || 0.5) + 's)';
  if (trigger.type === 'resource_collected') return 'resource_collected(' + (trigger.resource || 'Resource') + ',' + (trigger.amount || 1) + ')';
  if (trigger.type === 'near_entity') return 'near_entity(' + (trigger.entity || 'Entity') + ',' + (trigger.range || 2) + ')';
  if (trigger.type === 'click_entity') return 'click_entity(' + (trigger.entity || 'CtaButton') + ')';
  if (trigger.type === 'entity_state_reached') return 'entity_state_reached(' + (trigger.entity || 'Entity') + ',' + (trigger.state || 1) + ')';
  if (trigger.type === 'all_built') return 'all_built()';
  return String(trigger.type || 'unknown');
}

function summarizePhase(spec, index, isLast) {
  var phaseId = spec.phaseId || ('phase' + (index + 1));
  var name = spec.phaseName || spec.name || phaseId;
  var goal = spec.playerInstruction || spec.guideText || spec.autoModeHint || name;
  var triggerDesc = describeTrigger(spec.triggerNext || spec.trigger) || (isLast ? 'click_entity(CtaButton) [MANDATORY for last phase]' : 'timer+resource compound suggested');
  var modules = safeArray(spec.plannedModuleIds);
  if (modules.length === 0 && spec.plannedModules) modules = safeArray(spec.plannedModules);
  if (isLast && modules.indexOf('cta_finish') < 0) modules = modules.concat(['cta_finish']);
  var entities = safeArray(spec.entitiesRequired).map(function(entry) {
    if (typeof entry === 'string') return entry;
    return entry && (entry.name || entry.entity) || '';
  }).filter(Boolean);
  var interactions = safeArray(spec.requiredInteractions).map(function(entry) {
    return typeof entry === 'string' ? entry : JSON.stringify(entry);
  });
  return {
    phaseId: phaseId,
    name: name,
    goalText: goal,
    triggerDesc: triggerDesc,
    plannedModuleIds: modules,
    entities: entities,
    interactions: interactions,
    duration: spec.duration || null,
  };
}

function renderPhaseTable(summaries) {
  var rows = [];
  rows.push('| phase | name | goalText | trigger | modules | entities | interactions |');
  rows.push('|---|---|---|---|---|---|---|');
  summaries.forEach(function(s) {
    rows.push('| ' + [
      s.phaseId,
      s.name,
      s.goalText,
      s.triggerDesc,
      s.plannedModuleIds.join(',') || '-',
      s.entities.join(',') || '-',
      s.interactions.join(';') || '-',
    ].join(' | ') + ' |');
  });
  return rows.join('\n');
}

function renderStoryboardFrames(frames) {
  if (!frames || frames.length === 0) return '(no storyboard frames provided — infer visual from specs/entities)';
  return frames.map(function(frame, i) {
    var idx = (frame.index != null ? frame.index : i) + 1;
    var bits = ['Frame ' + idx];
    if (frame.title) bits.push('title=' + JSON.stringify(frame.title));
    if (frame.interaction) bits.push('interaction=' + JSON.stringify(frame.interaction));
    if (frame.ui) bits.push('ui=' + JSON.stringify(frame.ui));
    if (frame.camera) bits.push('camera=' + JSON.stringify(frame.camera));
    if (frame.duration) bits.push('duration=' + JSON.stringify(frame.duration));
    if (frame.note) bits.push('note=' + JSON.stringify(frame.note));
    return '- ' + bits.join(' / ');
  }).join('\n');
}

function renderEntities(entities) {
  if (!entities || entities.length === 0) return '(no entities provided)';
  return entities.map(function(entity) {
    return '- name=' + JSON.stringify(entity.name || '') +
      ' label=' + JSON.stringify(entity.label || entity.name || '') +
      ' template=' + JSON.stringify(entity.template || '');
  }).join('\n');
}

function renderResources(resources) {
  if (!resources || resources.length === 0) return '(no resources provided)';
  return resources.map(function(r) {
    if (typeof r === 'string') return '- ' + r;
    return '- name=' + JSON.stringify(r.name || '') + (r.entity ? ' entity=' + JSON.stringify(r.entity) : '');
  }).join('\n');
}

function buildSystemPrompt() {
  return SYSTEM_PROMPT_HEADER;
}

function buildUserPrompt(bundle, opts) {
  opts = opts || {};
  var bp = bundle || {};
  var specs = safeArray(bp.specs);
  if (specs.length === 0) throw new Error('storyboard2html prompt requires bundle.specs');
  var summaries = specs.map(function(spec, index) {
    return summarizePhase(spec, index, index === specs.length - 1);
  });

  var lines = [];
  lines.push('# storyboard2html generation request');
  lines.push('');
  lines.push('projectName: ' + (bp.projectName || 'storyboard2html'));
  lines.push('themeHint: ' + (bp.themeHint || 'default'));
  lines.push('totalPhases: ' + summaries.length);
  lines.push('');

  lines.push('## Resources');
  lines.push(renderResources(bp.resources));
  lines.push('');

  lines.push('## Entities');
  lines.push(renderEntities(bp.entities));
  lines.push('');

  lines.push('## Phase plan(逐 phase 要求,phase id 严格按 phase1..phaseN)');
  lines.push(renderPhaseTable(summaries));
  lines.push('');

  lines.push('## Storyboard frames(视觉提示;若提供,优先据此呈现场景)');
  lines.push(renderStoryboardFrames(bp.storyboardFrames));
  lines.push('');

  if (bp.acceptancePlan && Array.isArray(bp.acceptancePlan.hardGates) && bp.acceptancePlan.hardGates.length > 0) {
    lines.push('## Acceptance(生成后回归挂这些 hard gate)');
    bp.acceptancePlan.hardGates.forEach(function(gate) {
      lines.push('- ' + gate);
    });
    lines.push('');
  }

  lines.push('## 输出');
  lines.push('严格按上面契约输出 *单文件 HTML*,以 `<!doctype html>` 起,以 `</html>` 止。不要任何额外文字。');
  return lines.join('\n');
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('storyboard2html prompt requires an input bundle');
  }
  if (bundle.kind && bundle.kind !== 'blueprint.storyboard2html.input') {
    throw new Error('unexpected bundle kind: ' + bundle.kind);
  }
  if (!Array.isArray(bundle.specs) || bundle.specs.length === 0) {
    throw new Error('storyboard2html prompt requires bundle.specs[] (from spec-extract)');
  }
  if (bundle.htmlContract) {
    contract.validateContract(bundle.htmlContract);
  }
  return true;
}

function buildStoryboard2HtmlPrompt(bundle, opts) {
  opts = opts || {};
  validateBundle(bundle);
  var systemPrompt = buildSystemPrompt();
  var userPrompt = buildUserPrompt(bundle, opts);
  return {
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    model: opts.model || DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    minOutputLen: opts.minOutputLen || DEFAULT_MIN_OUTPUT_LEN,
    metadata: {
      phases: bundle.specs.length,
      themeHint: bundle.themeHint || 'default',
      projectName: bundle.projectName || 'storyboard2html',
    },
  };
}

module.exports = {
  SYSTEM_PROMPT_HEADER: SYSTEM_PROMPT_HEADER,
  DEFAULT_MODEL: DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  DEFAULT_MIN_OUTPUT_LEN: DEFAULT_MIN_OUTPUT_LEN,
  buildSystemPrompt: buildSystemPrompt,
  buildUserPrompt: buildUserPrompt,
  buildStoryboard2HtmlPrompt: buildStoryboard2HtmlPrompt,
  validateBundle: validateBundle,
  _internals: {
    summarizePhase: summarizePhase,
    renderPhaseTable: renderPhaseTable,
    renderStoryboardFrames: renderStoryboardFrames,
    renderEntities: renderEntities,
    renderResources: renderResources,
    describeTrigger: describeTrigger,
  },
};
