'use strict';

var contract = require('./storyboard2html-contract.cjs');

var DEFAULT_MODEL = 'claude-sonnet-4-6';
var DEFAULT_TIMEOUT_MS = 600000;
var DEFAULT_MIN_OUTPUT_LEN = 2000;

function resolveModel(opts) {
  return opts && opts.model ? opts.model : (process.env.STORYBOARD2HTML_MODEL || DEFAULT_MODEL);
}

function resolveTimeoutMs(opts) {
  if (opts && opts.timeoutMs) return opts.timeoutMs;
  var env = Number(process.env.STORYBOARD2HTML_TIMEOUT_MS || 0);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_MS;
}

function resolveMinOutputLen(opts) {
  if (opts && opts.minOutputLen) return opts.minOutputLen;
  var env = Number(process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN || 0);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MIN_OUTPUT_LEN;
}

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
  '- `trigger` 必须是结构化对象,不要写 `conditions:["timer(0.8s)"]` 字符串数组:',
  '  `timer` 写 `{type:"timer",seconds:0.8}`;',
  '  `resource_collected` 写 `{type:"resource_collected",resource:"Gold",amount:1}`;',
  '  `entity_state_reached` 写 `{type:"entity_state_reached",entity:"Turret",state:2}`;',
  '  组合触发写 `{type:"compound",operator:"and",triggers:[...]}`。',
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
  '- snake_case 是 *硬必填*:`entity_states` / `ui_state` / `camera_state` / `completedPhases` 必须存在;',
  '  camelCase(`entityStates` / `uiState` / `cameraState`)只允许作为 *镜像副本* 同步写,*不能仅写 camelCase*。',
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
  '- moduleId 必须 *逐字符* 出自下面的 36 项词表(snake_case,严格大小写);未列模板的 module 也要写,',
  '  按通用三段式 `{ _meta, before:{...}, after:{...}, ...module-specific keys }`,*不能用 0 来缺省 _meta*。',
  '',
  '### 模块词表(完整 36 项,只允许这些 moduleId)',
  '  activate_targets / apply_damage / build_progress / camera_focus / camera_lift / camera_zoom /',
  '  click_trigger / collect_on_near / cooldown / cost_gate / cta_finish / damageable /',
  '  deliver_to_target / drag_trigger / floating_text_feedback / form_switch / guide_ui /',
  '  highlight_target / hold_trigger / inventory_wallet / move_to_target / on_death_drop /',
  '  phase_gate_timer / player_input_joystick / player_input_tap / pop_animation /',
  '  projectile_emit / proximity_trigger / score_feedback / spawn_interval / spawn_once /',
  '  target_acquire / upgrade_progress / visual_binding / visual_variant_swap / world_label',
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
  '## L4 — 资产 license meta(window.__assetMeta,每个外部资产 URL 必须声明)',
  '- 任何 *外部加载* 的资产 URL(GLTFLoader/TextureLoader/AudioLoader/<img src=...>/fetch(.../*.glb|*.png|*.jpg|*.jpeg|*.webp|*.wav|*.mp3|*.ogg))都必须在 `window.__assetMeta` 里有一条对应条目。',
  '- 顶层声明 `window.__assetMeta = { ... }`(必须 *顶层赋值*,不能放在函数闭包里,且必须在任何加载器调用前先赋值)。',
  '- key = 资产 URL 字符串(必须和真实加载调用里的 URL 字符串 *逐字符一致*,包含相对路径前缀 `./`、查询串、hash)。',
  '- value 必含三字段:',
  '  - `license`:字符串,*case-sensitive 严格枚举*,只允许这 6 类 canonical token(字符级精确,不允许大小写变体、不允许空格变体):',
  '    `"CC0"` / `"CC-BY-4.0"` / `"CC-BY-SA-4.0"` / `"CC-NC-<suffix>"`(任一 NC 变体,例如 `"CC-NC-BY-4.0"`)/ `"proprietary"` / `"unknown"`。',
  '    *不允许* `"cc0"` / `"CC BY 4.0"`(空格)/ `"cc-by-4.0"`(小写)/ `"CC_BY_4.0"`(下划线)等任何形态变体。',
  '  - `attribution`:作者 / 项目名 / 主页 URL 字符串(长度 ≤ 200 字符);若 license 不要求署名(CC0)或 license=unknown 且无来源,写 `null`(*禁止* 空串 `""`)。',
  '  - `sourceUrl`:外部下载页 URL 字符串;若资产是本地相对路径 / data-uri / 程序化生成,写 `null`(*禁止* 空串 `""`)。',
  '- license *不允许漏字段、不允许漏条目*。即使来源真的查不到,也必须显式写 `license:"unknown"`,*不能* 把 entry 整条省略,*不能* 把 license 字段省略。',
  '  这样 demo2spec 反解时能区分"LLM 忘了写 meta"(prompt bug)和"真的查不到 license"(合规 fallback)。',
  '- 程序化资产(primitive prefab / canvas 生成 texture / 内嵌 SVG dataURI / three.js MeshStandardMaterial 纯色)不需要在 `window.__assetMeta` 里出现;只 *外部加载* 的才声明。',
  '- 示例:',
  '  ```',
  '  window.__assetMeta = {',
  '    "./models/HeroShip.glb": { license: "CC-BY-4.0", attribution: "https://example.com/heroship", sourceUrl: "https://example.com/heroship.glb" },',
  '    "./textures/Turret_D.png": { license: "CC0", attribution: null, sourceUrl: null },',
  '    "https://cdn.example.com/audio/click.mp3": { license: "unknown", attribution: null, sourceUrl: null }',
  '  };',
  '  ```',
  '',
  '## L5 — 交互驱动硬约束(phase 推进必须由真实玩家输入触发,*禁止 setTimeout 自走*)',
  '- 每个 non-final phase 必须有 *至少一个* 真实 DOM event listener 驱动 phase advance:',
  '  `canvas.addEventListener("pointerdown"|"click"|"touchstart", ...)` + hit-test 实体 bounding box / mesh raycaster,',
  '  *或* DOM 实体元素 `el.addEventListener("click", ...)` / `keydown` 按键,',
  '  *或* drag handler(pointerdown + pointermove + pointerup)。',
  '- 最后一 phase 的 `CtaButton` 必须挂 *真实* `addEventListener("click", ...)`,不能用 setTimeout 触达。',
  '- 禁止 `setTimeout(function(){ enterPhase(N+1) })` / `setTimeout(fn, ms)` 内 mutate `phaseIndex` / 直接调 `nextPhase()` 这类 phase index 自走。',
  '- `phase_gate_timer` 模块允许写 timer,但 timer 必须是 *某个用户动作之后* 的倒计时(例如点完一个 entity 后,等 N 秒再算完成);不能 phase 进入时就立即起 setTimeout 推进。',
  '- `click_trigger.target_consumed` / `player_input_tap.registered` / `tap_count`++ / `clicks`++ 必须由 DOM event handler 内部置位,*不能* 在 module 进入(`enterPhaseN`)时同步硬编码 record 出来。',
  '- 资源增减(`resources.X += N` / `inventory_wallet` 写入)必须发生在 listener 回调内部 *或* 紧跟用户动作的物理判定 (collision / proximity),不能 phase 进入时一次性 set。',
  '- *白名单* `setTimeout`/`setInterval` 用法:动画帧节流 / 视觉效果 / toast 隐藏 / 引导文字 fade — 这些不 mutate `phaseIndex` 也不调 `enterPhase`,允许保留。',
  '',
  '## L6 — 视觉模型化硬约束(每个 entity 必须 *看得见 + 立体感*,*禁止平面 2D 示意*)',
  '- 必须用 three.js (CDN https://cdn.jsdelivr.net/npm/three@0.156.1/build/three.min.js) 渲染 *3D 场景*,或纯 Canvas 用 *伪 3D / isometric* 方式画(深度叠加 + 透视 + 阴影 + 多视角层),不能只用平面 2D 圆/方块/折线示意。',
  '- *最低* 场景元素清单(任一缺失视为 prompt bug):',
  '  - `Scene + ground/floor` 地面/底板(THREE.PlaneGeometry / Canvas 透视梯形)',
  '  - `Player` 角色:复合几何体(头 Sphere + 身体 Cylinder/Box + 手脚 Box),不允许只画一个圆点',
  '  - 每个 `spec.entities[]` 列出的 entity 必须有对应可见 mesh / canvas group,且形态贴合语义 — 工具(电锯/钻头)用 Box/Cylinder 组合、机器(熔炉/装瓶机)用 Box + ConeGeometry 烟囱/Cylinder 罐体、队列 NPC 用复合人形、收集物用对应 Geometry(冰块 Box + 透明材质、苹果 Sphere)',
  '  - UI HUD(资源 / 引导文本 / 阶段指示)固定在屏幕上层',
  '- *禁止* entity 只用一个 `ctx.arc(x,y,10,...)` 圆点或一个 `<div>` 方框表示。',
  '- *禁止* 整个画面只有 `<canvas>` 黑底 + 几条线条 + 几个圆点 — 这种是 "示意图" 不是 demo。',
  '- 程序化几何体(THREE primitives / canvas pseudo-3D)不触发 L4 license — 不需要写 `window.__assetMeta`。鼓励优先走程序化避免 license 链路。',
  '- 每 phase 必须有视觉变化:entity show/hide/move、material color change、scale animation、particle emit、camera shake 任一。',
  '- 全部资源用整数计数;HUD 顶栏显示资源(图标 + 数字)/ 引导文本(`#tip` div)/ 阶段指示(`Phase N/M`)。',
  '',
  '## 禁止反规则',
  '- 不允许把 phaseRealTimer 写成 frame count / phaseIndex / 0。',
  '- 不允许遗漏 `_meta.schemaVersion="1.0.0"` 或 `_meta.sourcePlatform="html"`。',
  '- 不允许把 PHASES 写成 `function PHASES()` 或闭包内变量(必须顶层声明)。',
  '- 不允许把 trigger 写成 `conditions:["resource_collected(Gold,1)"]`;必须写 `triggers:[{type:"resource_collected",resource:"Gold",amount:1}]`。',
  '- 不允许 `entity_state_reached.state` 写 `"built"`;必须写整数 state,通常 built=2。',
  '- 不允许 phaseEvidence 里出现 undefined / 函数 / Symbol;只用 primitive + object。',
  '- 不允许最后一 phase 缺 `cta_finish` 模块或 CtaButton。',
  '- 不允许任何外部加载的资产 URL 在 `window.__assetMeta` 里缺条目或缺 `license` 字段;license 真不知道也必须显式写 `"unknown"`,不能省略。',
  '- 不允许把 `window.__assetMeta` 写在函数闭包里或加载器调用之后赋值;必须 *顶层* 且在加载器调用前先就绪。',
  '- 不允许 license 字段写大小写 / 空格 / 下划线变体(`"cc0"` / `"CC BY 4.0"` / `"cc-by-4.0"` / `"CC_BY_4.0"` 都是 bug);必须 *字符级精确* 匹配 6 类 canonical token。',
  '- 不允许 `attribution` 或 `sourceUrl` 字段写空串 `""`;未知必须 `null`。',
  '- 不允许 `attribution` 字符串长度 > 200(超长是 prompt bug,不要塞整段 readme)。',
  '- 不允许 `setTimeout(fn, ms)` / `setInterval(fn, ms)` 函数体内 mutate `phaseIndex` / 调用 `enterPhase(N+1)` / `nextPhase()` 这类 phase 自走(*只允许* 用户动作 listener 内部 schedule timer 计算 phase 完成)。',
  '- 不允许 `click_trigger.target_consumed=true` / `player_input_tap.registered=true` / `tap_count`/`clicks` 计数器在 `enterPhaseN()` / module evidence write 函数里同步硬编码 — 必须由真实 DOM event listener 回调内部置位。',
  '- 不允许 non-final phase 完全没有 `addEventListener("click"|"pointerdown"|"touchstart"|"keydown", ...)` 这类用户输入 listener 驱动 phase advance(每个 non-final phase 至少挂 1 个真实 listener)。',
  '- 不允许 entity 只用单个 `ctx.arc()` 圆点 / 单个 `<div>` 方框 / 单个 THREE.SphereGeometry 表示;每个 entity 必须复合几何体 / 复合 canvas pseudo-3D 叠层,贴合语义形态。',
  '- 不允许整个 stage 只是黑底 + 几条线条 + 几个圆点(示意图不是 demo);必须 ground + 多个 mesh / 多层叠加 + 视觉细节(阴影 / 描边 / 材质颜色对比)。',
  '- 不允许跳过 `Player` 角色复合几何体 — 角色必须看得出是 *角色*(头+身+肢 至少 3 段几何体),不能只是一个圆。',
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

function stripCodeFence(text) {
  text = String(text || '').trim();
  if (text.indexOf('```') === 0) {
    var lines = text.split('\n');
    lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].indexOf('```') === 0) lines.pop();
    text = lines.join('\n').trim();
  }
  return text;
}

function extractHtml(text) {
  var trimmed = stripCodeFence(text);
  var lower = trimmed.toLowerCase();
  var start = lower.indexOf('<!doctype html>');
  if (start < 0) start = lower.indexOf('<html');
  if (start < 0) {
    var err = new Error('LLM output missing <!doctype html> / <html ...> opening; refusing to write file');
    err.code = 'STORYBOARD2HTML_OUTPUT_NOT_HTML';
    throw err;
  }
  var end = lower.lastIndexOf('</html>');
  if (end < 0) {
    var err2 = new Error('LLM output missing </html> closing tag; refusing to write truncated HTML');
    err2.code = 'STORYBOARD2HTML_OUTPUT_TRUNCATED';
    throw err2;
  }
  return trimmed.slice(start, end + '</html>'.length).trim();
}

function buildStoryboard2HtmlPrompt(bundle, opts) {
  opts = opts || {};
  validateBundle(bundle);
  var systemPrompt = buildSystemPrompt();
  var userPrompt = buildUserPrompt(bundle, opts);
  return {
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    model: resolveModel(opts),
    timeoutMs: resolveTimeoutMs(opts),
    minOutputLen: resolveMinOutputLen(opts),
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
  stripCodeFence: stripCodeFence,
  extractHtml: extractHtml,
  resolveModel: resolveModel,
  resolveTimeoutMs: resolveTimeoutMs,
  resolveMinOutputLen: resolveMinOutputLen,
  _internals: {
    summarizePhase: summarizePhase,
    renderPhaseTable: renderPhaseTable,
    renderStoryboardFrames: renderStoryboardFrames,
    renderEntities: renderEntities,
    renderResources: renderResources,
    describeTrigger: describeTrigger,
  },
};
