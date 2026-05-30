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
  '同一份 HTML 既驱动 three.js 真实 3D 视觉,也暴露 storyboard2html v1.0.0 契约,',
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
  '- 最后一个 phase 必须以 `CtaButton` 为目标且 *arrival-gated*:`trigger.entity === "CtaButton"`,',
  '  `trigger.type` 可为 `near_entity`(arrival-only:玩家走到 CtaButton 圈内即自动完成,不需要 click)*或* `click_entity`(玩家走到 CtaButton 圈内 *再* click 完成,click handler 内部必须先校验 distance < threshold);',
  '  无论用哪种 trigger,对应 phaseEvidence *必须* 写 `cta_finish` 模块 + `final_phase: true`。',
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
  '## L2.5 — 测试驱动 hook(`window.__driveToPhase` + `window.__fidelityReady`)',
  '- 必须挂 `window.__driveToPhase = function(n) { ... }`,n 为 *1-based* phase 索引(范围 `[1, PHASES.length]`)。',
  '  - 越界(`n < 1` 或 `n > PHASES.length`)必须 `throw new Error(...)`,*不允许* 静默 no-op。',
  '  - 推进路径必须复用源 demo 自身 phase API(`advancePhase` / `enterPhase`),*不允许* 直接 mutate `phaseIndex` 后不重走 enter 逻辑(否则 phase enter side-effects 丢失:guide/visual/HUD/evidence 不刷新)。',
  '  - 返回值 *必须* 是 Promise,且 *必须* 在 resolve 前等至少 **两个 RAF**(`requestAnimationFrame` 嵌套两层后再 resolve),保证 phase 切换后下一帧 paint 已 commit,harness 截图不会拿到半帧。',
  '- 必须挂 `window.__fidelityReady`,*生命周期严格三阶段*:',
  '  - **阶段 1(显式 false)**:在 renderer / scene / IIFE bootstrap *之前* 显式 `window.__fidelityReady = false`,*不允许* 让该字段保持 `undefined` 状态(harness 会把 `undefined` 当作"页面没挂 hook"而 fail-fast,误诊为 prompt bug 而不是 race)。',
  '  - **阶段 2(首个真实 render tick 已执行)**:至少一次 `renderer.render(scene, camera)` 已实际 *执行过* 之后(canonical 路径 = bootstrap 内 `enterPhase(0,""); render();` 已调用一次,render() 内已 invoke `renderer.render(...)`),才能进入下一阶段。',
  '  - **阶段 3(双 RAF settle 后置 true)**:在阶段 2 满足后,用 `requestAnimationFrame(function(){requestAnimationFrame(function(){window.__fidelityReady=true;});});` 形态置 true。canonical 放在 IIFE 末尾或 bootstrap 完成处。',
  '  - *禁止* 把 `window.__fidelityReady = true` 写在脚本 load / IIFE top / scene 构造前 / 任何 render tick 未执行前的位置 — 这会让 harness 在 WebGL/three.js 启动完成之前就 bind 到 `__driveToPhase`,触发竞态。',
  '- **Ownership 边界(本节仅约束源 HTML)**:源 HTML 必须暴露以上两个 hook;WebGL target build 由 Blueprint deterministic skeleton/bridge 暴露 *同形态* hook(由 `worker/linux-bridge-build.js` 收口,*不在本 prompt 范围*)。*禁止* 在源 HTML 中生成 target stub / 远程控制逻辑 / 跨 build runtime 探针 — 源端只关心源端契约。',
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
  '## L5 — 交互驱动硬约束(phase 推进必须由 *任意屏幕位置浮动虚拟摇杆 + 角色 arrival-gate* 触发,*禁止键盘/直接 entity click / setTimeout 自走*)',
  '- *控制范式硬约束* = *全屏任意位置浮动虚拟摇杆*:用户在画面任意非 HUD 区域 `pointerdown` 时,摇杆底盘必须移动/显示到该触点作为原点,随后 `pointermove` 控制 thumb 偏移,`pointerup/pointercancel` 归零/隐藏。',
  '  - 必须存在可见 UI 控件(`<div id="joystick">` + thumb 或等价 canvas overlay),CSS 可用 `position:fixed`,但 *不能* 只能锁死左下角;必须由 `document`/`window`/`canvas`/`renderer.domElement` 的全屏 pointerdown 启动。',
  '  - 摇杆控件 *必须* 挂完整三段事件:`pointerdown` → `pointermove` → `pointerup/pointercancel`(等价 touch 事件可补但不能替代 pointer 事件),计算 thumb 偏移 → 写入 `__gameState.input.joystick = { dx, dy, active, originX, originY }`。',
  '  - 摇杆 vector 必须驱动 Player 角色 *每帧* 位置移动(`player.position.x += dx * speed * dt`;`y` 用作 z/forward 视相机视角),不允许摇杆只 UI 动画不实际推角色。',
  '- *交互范式硬约束* = *arrival-gate*:每个 non-final phase 的 phase advance 路径必须 = 用户拖摇杆 → Player 角色走到目标 entity 周围判定圈(distance < threshold / boundingBox hit)→ 才触发 phase 行为(收集 / 制造 / 递交 / 对话 / phase_gate_timer 倒计时)。',
  '  - *禁止* "点 entity 直接完成 phase" 这种点点点路径(non-final phase 不要写 `el.addEventListener("click", advancePhase)` / mesh click → enterPhase 的捷径)。',
  '  - *禁止* "按键直接完成 phase"(`keydown` Space/Enter 不能直接调 `enterPhase` / mutate `phaseIndex`)。',
  '- 每个 non-final phase 必须有 *至少一个* 真实 DOM event listener 驱动 phase advance,canonical 路径 = *全屏浮动虚拟摇杆 pointerdown+pointermove+pointerup 三段 listener + arrival 物理判定回调*。允许辅助 raycaster 做实体高亮反馈,但 *不能* 作为 advance 唯一触发。',
  '- non-final phase 的 `trigger.type` *只允许* `near_entity` / `resource_collected`(通过 near_entity 接触收集触发)/ `entity_state_reached`(post-arrival 状态变化)/ `compound`(上述组合)/ `timer`(*post-arrival* 才起计时)。*禁止* non-final phase 写 `click_entity` 作为 trigger。',
  '- 最后一 phase 的 `CtaButton` 必须 *arrival-gated*,两种 canonical 路径任选其一:(a) `trigger.type==="near_entity"` arrival-only — 玩家走到 CtaButton 圈内即触发 `cta_finish`,不挂 click handler;(b) `trigger.type==="click_entity"` — 挂 *真实* `addEventListener("click", ...)`,但回调内部 *必须* 先校验 `distance < threshold`,未进入 arrival-gate 就 return 不触发 finish / install。两种路径都不能用 setTimeout 触达,也不能页面任意位置 click 直接结束。',
  '- `keydown` 监听 *只能* 作为 desktop fallback / debug 辅助:WASD 可以同样推角色位置(等同摇杆 vector 写入 `__gameState.input.joystick`),但 *不能* 是唯一输入路径(虚拟摇杆必须同时存在),且 keydown handler *不能* 直接调 `enterPhase(N+1)` / mutate `phaseIndex`。',
  '- 禁止 `setTimeout(function(){ enterPhase(N+1) })` / `setTimeout(fn, ms)` 内 mutate `phaseIndex` / 直接调 `nextPhase()` 这类 phase index 自走。',
  '- `phase_gate_timer` 模块允许写 timer,但 timer 必须是 *某个用户动作之后*(canonical = arrival-gate 进入之后)的倒计时(例如角色走入目标圈、站定 N 秒再算完成);不能 phase 进入时就立即起 setTimeout 推进。',
  '- `click_trigger` 模块 *只用于最后一 phase 的 CtaButton + `trigger.type==="click_entity"` 路径*(且 arrival-gate 校验之后);若最后一 phase 走 `near_entity` arrival-only 路径,则不需要 `click_trigger`,只写 `cta_finish`。non-final phase 不要写 `click_trigger`,改写 `proximity_trigger` / `collect_on_near` / `move_to_target` 这类 arrival 语义模块。',
  '- `click_trigger.target_consumed` / `player_input_tap.registered` / `tap_count`++ / `clicks`++ 必须由 DOM event handler 内部置位,*不能* 在 module 进入(`enterPhaseN`)时同步硬编码 record 出来。',
  '- `player_input_joystick` 模块必须在 *每个 non-final phase* 的 phaseEvidence 出现一条,记录 `{ _meta, active:true, vector:{dx,dy}, applied_to_player:true }`,体现摇杆驱动 Player 位移的事实。',
  '- 资源增减(`resources.X += N` / `inventory_wallet` 写入)必须发生在 *arrival 物理判定回调内部*(distance 进入瞬间 / proximity_trigger fired / collect_on_near 接触瞬间),*不能* phase 进入时一次性 set,也 *不能* 在摇杆 `pointermove` listener 内部任意位置直接 set。',
  '- *白名单* `setTimeout`/`setInterval` 用法:动画帧节流 / 视觉效果 / toast 隐藏 / 引导文字 fade — 这些不 mutate `phaseIndex` 也不调 `enterPhase`,允许保留。',
  '',
  '## L6 — 视觉模型化硬约束(每个 entity 必须 *真实 3D + 看得见*,*禁止 Canvas/DOM 平面示意*)',
  '- 必须用 three.js (CDN https://cdn.jsdelivr.net/npm/three@0.156.1/build/three.min.js) 渲染 *真实 WebGL 3D 场景*:`new THREE.Scene()` + `new THREE.WebGLRenderer()` + 透视相机 + 灯光 + 程序化 mesh。禁止用纯 Canvas 2D / isometric 伪 3D 作为主画面。',
  '- *最低* 场景元素清单(任一缺失视为 prompt bug):',
  '  - `Scene + ground/floor` 地面/底板(THREE.PlaneGeometry / BoxGeometry 等真实 mesh)',
  '  - `Player` 角色:复合几何体(头 Sphere + 身体 Cylinder/Box + 手脚 Box),不允许只画一个圆点',
  '  - 每个 `spec.entities[]` 列出的 entity 必须有对应可见 THREE mesh/group,且形态贴合语义 — 工具(电锯/钻头)用 Box/Cylinder 组合、机器(熔炉/装瓶机)用 Box + ConeGeometry 烟囱/Cylinder 罐体、队列 NPC 用复合人形、收集物用对应 Geometry(冰块 Box + 透明材质、苹果 Sphere)',
  '  - UI HUD(资源 / 引导文本 / 阶段指示)固定在屏幕上层',
  '- *禁止* entity 只用一个 `ctx.arc(x,y,10,...)` 圆点或一个 `<div>` 方框表示。',
  '- *禁止* 整个画面只有 `<canvas>` 黑底 + 几条线条 + 几个圆点 — 这种是 "示意图" 不是 demo。',
  '- 程序化几何体(THREE primitives / 纯色 MeshStandardMaterial)不触发 L4 license — 不需要写 `window.__assetMeta`。鼓励优先走程序化避免 license 链路。',
  '- 每 phase 必须有视觉变化:entity show/hide/move、material color change、scale animation、particle emit、camera shake 任一。',
  '- 全部资源用整数计数;HUD 顶栏显示资源(图标 + 数字)/ 引导文本(`#tip` div)/ 阶段指示(`Phase N/M`)。',
  '',
  '## L7 — Entity 视觉契约(extractor 兼容布局,demo2spec 静态解析必须命中)',
  '- *顶层* 声明 `const ENTITY_STYLE = { ... }`(或 `let` / `var` / `window.ENTITY_STYLE = { ... }`,*不能* 放在函数闭包 / IIFE 内):',
  '  - key = entity 名(与 `spec.entities[].name` / `PHASES[].showEntities[]` / `trigger.entity` 严格匹配,大小写敏感)。',
  '  - value 必含 `kind` 字段(字符串语义类,如 `astronaut`/`ship`/`station`/`counter`/`pad`/`crystal`/`debris`/`cargo`/`base`/`beacon`/`gate`/`tool`/`machine`/`npc`/`collectible` 等),`buildEntity` 据此 dispatch 几何体形态。',
  '  - 推荐补 `label`(显示名,中文 OK)/ `color`(0xRRGGBB hex 数字)字段供 mesh 材质 + UI label 使用。',
  '- *顶层* 声明 `const ENTITY_POSITIONS = { ... }`(同上,*不能* 闭包):',
  '  - key 集合必须 *与 ENTITY_STYLE keys 完全一致*(同名 entity 两边都必须有,不能漏配)。',
  '  - value 含 `{x, z}`(2D 平面布局,y 默认 0)或 `{x, y, z}`(3D 全量),坐标用数值字面量。',
  '- 必须声明 *命名函数* `function buildEntity(name) { ... }`(*不能* 写成箭头 / 匿名 / `var buildEntity = function(){}`;extractor 按函数名识别):',
  '  - 内部第一步必须读 `ENTITY_STYLE[name]` 拿 `kind` + 色彩,再 *kind-switch* dispatch 各类复合几何体装配(`if (kind === "astronaut") { ... } else if (kind === "ship") { ... } else { ... }`)。',
  '  - 每个 `ENTITY_STYLE` 中出现的 `kind` 取值都必须在 `buildEntity` 里有对应分支,不能漏掉 kind 落到 default 兜底(`else` 兜底分支可保留,但不能成为多 entity 共用通道)。',
  '  - 推荐配套 helper:`function groupAt(name) { var p = ENTITY_POSITIONS[name]; var g = new THREE.Group(); g.name = name; g.position.set(p.x, p.y || 0, p.z); scene.add(g); models[name] = g; return g; }`,或在 `buildEntity` 内直接做等价 anchor。',
  '- 必须存在 *顶层 / scene 闭包顶层* 的 `var models = {}`(或 `const models = {}`,允许写在 main IIFE 内部),并对每个 entity 写一次 `models[<entityName>] = g;`(`g` = `new THREE.Group()`):',
  '  - 这是 demo2spec extractor 反向追踪 entity↔mesh 绑定的 *唯一* anchor 形态(没有它,extractor 抓到的 Mesh 全 unbound,Luna 端 fallback 默认 `__Pool_Cube_White_01`,所有 entity 都长成同款白方块)。',
  '- 必须存在统一 driver 一次性构造所有 entity,canonical 形态:`Object.keys(ENTITY_STYLE).forEach(buildEntity);`(或等价 `Object.keys(ENTITY_STYLE).forEach(function(n){ buildEntity(n); });` / `for (var k in ENTITY_STYLE) buildEntity(k);`),*不能* 把 buildEntity 调用散布到各 phase 入场逻辑里 / 不能只在某 phase 才构造。',
  '- 反例(extractor 全部抓不到 → asset-manifest entityBindings 空 → Luna 端 entity 全 fallback 白方块):',
  '  - entity mesh 装配塞进 IIFE / 单条 `(function(){...})()` 闭包,extractor 静态 AST 无法穿透。',
  '  - entity 名只出现在 `getElementById("entityName")` 字符串里,JS 端没有 ENTITY_STYLE / 没有 models[name] anchor。',
  '  - 跳过 ENTITY_STYLE map 直接散布 `new THREE.Mesh(...)` 到 scene,没有 entity name 绑定。',
  '  - `buildEntity` 内部不读 `ENTITY_STYLE[name].kind` 而是按 `switch (name)` 一一硬编码分支(name 列表跟 ENTITY_STYLE 漂移)。',
  '',
  '## L8 — 场景视觉契约(scene-level params,Luna runtime per-story 适配主门)',
  '- *顶层* 声明 `const SCENE_CONFIG = { ... }`(允许 `let` / `var` / `window.SCENE_CONFIG = {...}`,*不能* 闭包内;extractor 静态 AST 必须直接抓到):',
  '  - `backgroundColor`: 数字 `0xRRGGBB`(scene 主色 / camera clear color)。**必填**,demo2spec extractor 直接给 Luna `cam.backgroundColor`。',
  '  - `fog`: `{ color: 0xRRGGBB, near: <number>, far: <number> }` 或 `null`(无雾)。控制 Luna runtime 是否启用深度雾及参数。',
  '  - `ambientLight`: `{ color: 0xRRGGBB, intensity: <number 0~2> }`(环境光,必填,intensity 推荐 0.4-0.8)。',
  '  - `directionalLight`: `{ color: 0xRRGGBB, intensity: <number>, position: [x,y,z] }`(主方向光 / sun;必填,intensity 推荐 0.8-1.5)。',
  '  - `rimLight`: `{ color: 0xRRGGBB, intensity: <number>, position: [x,y,z], distance: <number> }` 或 `null`(辅助 point/rim light,可选氛围光)。',
  '  - `ground`: `{ kind: "cylinder"|"plane"|"box", radius?: <number>, width?: <number>, height?: <number>, color: 0xRRGGBB }` 或 `null`(地面几何体定义,Luna 用以构建匹配地形)。',
  '  - `decor`: `{ stars?: <number>, orbitalRings?: <number>, ... }` 或 `null`(装饰元素,如星空/轨道线/粒子数量,Luna runtime 据此 spawn 简版装饰)。',
  '- 字段语义:Luna skeleton 解析 `sourceSceneContract`(由 demo2spec 从 `SCENE_CONFIG` 抽出)后,**按字段而不是按主题** hard-set 背景/光照/装饰 — 同一套契约支持太空 / 农场 / 餐厅 / 塔防 / 解谜 等任意主题,extractor 不需要主题判定,Luna runtime 不需要 if-theme-then-X 硬编码分支。',
  '- canonical 示例(深空太空主题):`const SCENE_CONFIG = { backgroundColor: 0x071026, fog: { color: 0x071026, near: 55, far: 145 }, ambientLight: { color: 0xffffff, intensity: 0.62 }, directionalLight: { color: 0xffffff, intensity: 1.25, position: [-14, 28, 18] }, rimLight: { color: 0x72ddff, intensity: 1.0, position: [10, 16, -16], distance: 80 }, ground: { kind: "cylinder", radius: 72, height: 0.25, color: 0x13233a }, decor: { stars: 100, orbitalRings: 4 } };`',
  '- 源 HTML 实际渲染时仍按本契约写 Three.js scene(`scene.background = new THREE.Color(SCENE_CONFIG.backgroundColor)` / `scene.fog = new THREE.Fog(...)` / `new THREE.AmbientLight(...)` / `new THREE.DirectionalLight(...)` / 地面 mesh / 装饰 loop),保证源 HTML 跑起来视觉与契约值一致(契约不是"声明"而是"事实")。extractor 抽契约时不需要解析渲染代码,直接读 `SCENE_CONFIG` 字面值即可。',
  '- 反例(Luna runtime 拿不到对应字段,只能 fallback 灰底 / 默认 Unity 光照,与源 HTML 视觉 drift):',
  '  - SCENE_CONFIG 写在 `function init() { ... }` / IIFE 内,extractor 静态 AST 抓不到。',
  '  - `backgroundColor` 字段缺失或写成字符串 `"#071026"` / `"rgb(7,16,38)"`(必须 `0xRRGGBB` 数字字面量,与 ENTITY_STYLE.color 一致 hex 数字风格)。',
  '  - `ambientLight` / `directionalLight` 任一缺失(extractor 无法填光照契约,Luna 仍用 default Unity 灯,与源差异巨大)。',
  '  - 把 fog / rimLight / ground / decor 写成"true / false"开关或 string 标签(必须是对象形态或 `null`,让 Luna 能直接 spawn 对应几何体)。',
  '',
  '## L8.5 — 引导视觉契约(target highlight + trail line + combat laser,Luna runtime 必须 carry-over)',
  '- 必须在 scene 闭包顶层声明 `var targetRing, trailLine, laserLine;`,与 `entity_states/models/labels` 同级。demo2spec extractor 会按变量名识别并写入 `sourceSceneContract.guidance`,Luna overlay 必须重建这三件视觉。',
  '- **targetRing**(当前 target 圈选光环):必须用 `new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.055, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffe45c }))`,并设置 `targetRing.rotation.x = Math.PI / 2; scene.add(targetRing);`。每帧跟随 `targetName()` 对应的 `models[target]`,设置 `y=0.08`,并 `scale.setScalar(1 + Math.sin(performance.now()/180) * 0.08)`。无 target 时 `visible=false`。',
  '- **trailLine**(Player→SpaceShip 引导拖尾):必须用 `new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x8deaff, transparent: true, opacity: 0.65 }))`。每帧 `setFromPoints([playerPos+(0,1,0), models.SpaceShip.position+(0,1,0)])`,让玩家始终知道飞船相对方向。',
  '- **laserLine**(战斗阶段激光):必须用 `new THREE.Line(..., new THREE.LineBasicMaterial({ color: 0xff6858, transparent: true, opacity: 0 }))`。所有 `PHASES[].steps[]` 中战斗动作必须显式写 `damage: true`;执行该 step 时 `laserLine.material.opacity = 1`,并从 `playerPos+(0,1.1,0)` 指向 `models[target].position+(0,1,0)`;每帧按 `dt*1.6` 衰减 opacity。',
  '- **targetHint 文本规范**:`#targetHint` 必须显示当前 target 的 entity label,不是 step label。写法:`var t = targetName(); targetHint.textContent = t ? "目标：" + ENTITY_STYLE[t].label : "完成";`。例如显示 "目标：氧气购买台",不要显示 "目标：购买氧气"。',
  '- **step toast 完成反馈**:必须有 `#toast` 顶部浮层和 `function showToast(text){ toast.textContent=text; toast.className="show"; toastUntil=performance.now()+1000; }`。每次完成 `PHASES[].steps[]` 的一个 step 后调用 `showToast(step.label)`,每帧 `if (toastUntil < performance.now()) toast.className = "";` 自动淡出,让用户看到操作已生效。',
  '- 反例(Luna overlay 拿不到引导视觉,用户看不到去哪):',
  '  - `targetRing/trailLine/laserLine` 写在临时局部变量或匿名闭包深处,没有稳定变量名。',
  '  - targetRing 用 CSS/Canvas 圆环代替 Three.js TorusGeometry mesh。',
  '  - targetRing/trailLine/laserLine 的颜色、半径、opacity、pulse 速率随主题变化;这三件是跨主题统一交互语言,数值固定。',
  '  - targetHint 用 step label("购买氧气")而不是 entity label("氧气购买台")。',
  '  - step 完成后只更新资源数,没有 toast / 浮字反馈;用户会误以为摇杆靠近没有触发。',
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
  '- 不允许 non-final phase 完全没有 *全屏任意位置浮动虚拟摇杆 pointerdown+pointermove+pointerup 三段 listener + arrival 物理判定* 驱动 phase advance(每个 non-final phase 必须 = 摇杆 listener 推角色 + 角色到达目标圈 + 进入后触发 phase 逻辑;keyboard / 直接 entity click 都不算 canonical 驱动)。',
  '- 不允许整个 demo 缺失任意位置浮动虚拟摇杆 UI 控件(必须圆盘 + 拖拽 thumb、`position:fixed` overlay、`document/window/canvas/renderer.domElement` 全屏 `pointerdown` 启动、`pointermove`+`pointerup` 更新/归零,缺一即视为 prompt bug)。',
  '- 不允许 non-final phase 用 `keydown`(WASD/Space/Enter) 作为 *唯一* phase advance 路径(允许做 desktop fallback 同样推角色位置,但虚拟摇杆必须同时存在,且 keydown 内不能直接调 `enterPhase` / mutate `phaseIndex`)。',
  '- 不允许 non-final phase 写 `trigger.type === "click_entity"`,也不允许 non-final phase 挂 entity click handler 直接推 phase(`click_entity` *仅* 用于最后一 phase 的 CtaButton)。',
  '- 不允许 `CtaButton` 的 click handler 在 Player 未进入其 arrival-gate(distance < threshold)时就触发 finish / install;必须 arrival-gated。',
  '- 不允许 non-final phase 的 `plannedModuleIds` / phaseEvidence 中缺失 `player_input_joystick` 模块(摇杆驱动 Player 位移的事实必须有 evidence 落地)。',
  '- 不允许 entity 只用单个 `ctx.arc()` 圆点 / 单个 `<div>` 方框 / 单个 THREE.SphereGeometry 表示;每个 entity 必须由多个 THREE mesh 复合组成,贴合语义形态。',
  '- 不允许整个 stage 只是 Canvas 黑底 + 几条线条 + 几个圆点(示意图不是 demo);必须 THREE Scene + WebGLRenderer + ground + 多个 mesh + 视觉细节(阴影 / 材质颜色对比 / 镜头透视)。',
  '- 不允许跳过 `Player` 角色复合几何体 — 角色必须看得出是 *角色*(头+身+肢 至少 3 段几何体),不能只是一个圆。',
  '- 不允许 entity mesh 装配塞进 IIFE / 单条 `(function(){...})()` 闭包 — extractor 静态 AST 必须能从 *顶层* 走到 `ENTITY_STYLE` / `ENTITY_POSITIONS` / `function buildEntity` / `models[name] = g` 四件套。允许整个 demo 跑在一个大 IIFE 内,但 ENTITY_STYLE/ENTITY_POSITIONS *必须* 在 IIFE *外* 的顶层 const map。',
  '- 不允许 entity 名只出现在 `getElementById("entityName")` / `querySelector` 字符串里 — entity 必须在 *顶层* `ENTITY_STYLE` const map 里有 key,在 `ENTITY_POSITIONS` 里有同名 key,在 `models` 里有 `models[name] = g` 绑定(三处缺一即 prompt bug)。',
  '- 不允许跳过 `ENTITY_STYLE` 直接 `new THREE.Mesh(geom, mat)` 散布到 scene 而不挂到具名 entity Group — 每个 visible entity *必须* 由 `buildEntity(name)` 装配,装好后挂到 `models[name]`(否则 demo2spec extractor 把这些 Mesh 当 unbound 兜底,Luna 端 entity 全 fallback 默认白方块)。',
  '- 不允许 `buildEntity` 用 `switch (name)` / `if (name === "X")` 一一枚举 entity 名(把 ENTITY_STYLE map 形同虚设);必须读 `ENTITY_STYLE[name].kind` 然后 *kind-switch* dispatch 形态分支(kind 集合稳定,entity 集合可随 spec 浮动)。',
  '- 不允许 `ENTITY_POSITIONS` 的 key 与 `ENTITY_STYLE` 不一致 — 任一 entity 在其中一个 map 缺失即 prompt bug;两 map keys 必须 *完全相同*。',
  '- 不允许 `ENTITY_STYLE` 任一 entry 缺 `kind` 字段(extractor 没法 dispatch 几何体语义,会落到默认通道导致语义丢失)。',
  '- 不允许 `function buildEntity` 写成箭头函数 / 匿名函数表达式 / `var buildEntity = function(){}` — 必须 *命名函数声明*(`function buildEntity(name){...}`),extractor 按函数名识别。',
  '- 不允许 `SCENE_CONFIG` 写在 `function init() {...}` / IIFE / scene 闭包内 — 必须 *顶层* const map(允许 `let` / `var` / `window.SCENE_CONFIG`),extractor 静态 AST 必须直抓字面值。',
  '- 不允许 `SCENE_CONFIG.backgroundColor` 缺失或写成字符串 `"#071026"` / `"rgb(...)"` / CSS 颜色名 — 必须 `0xRRGGBB` 数字字面量,与 ENTITY_STYLE.color hex 数字风格一致(Luna camera.backgroundColor 直接读数字)。',
  '- 不允许 `SCENE_CONFIG.ambientLight` 或 `SCENE_CONFIG.directionalLight` 任一字段缺失 — 必须显式声明 `{ color, intensity }`(directional 还需 `position`);缺失 Luna runtime 只能 fallback default Unity 光照,与源 HTML 视觉巨大 drift。',
  '- 不允许 `SCENE_CONFIG.fog` / `SCENE_CONFIG.rimLight` / `SCENE_CONFIG.ground` / `SCENE_CONFIG.decor` 写成布尔开关或 string 标签(`fog: true` / `ground: "default"` 都不接受);要么写完整对象 `{ kind, color, ... }`,要么显式 `null`(`null` = 表示不要这个元素)。',
  '- 不允许源 HTML 的 `scene.background` / `scene.fog` / 光照 mesh / ground mesh / 装饰 loop 字面值与 `SCENE_CONFIG` 不一致 — 契约 = 渲染事实,渲染代码必须 `new THREE.Color(SCENE_CONFIG.backgroundColor)` / `new THREE.Fog(SCENE_CONFIG.fog.color, SCENE_CONFIG.fog.near, SCENE_CONFIG.fog.far)` 等引用契约值,不能两边各写不同字面量。',
  '- 不允许 `window.__driveToPhase` / `window.__fidelityReady` 缺失或形态不对。`__driveToPhase` 必须 1-based + 越界 throw + 双 RAF settle + 返回 Promise;`__fidelityReady` 必须 *三阶段生命周期*(① bootstrap 前显式 `= false` 初始化,② 至少一次 `renderer.render()` 已执行,③ 双 RAF 后才 `= true`);任何 script-load 即 true / 无 false 初始化 / 无 render tick 等待都视为 prompt bug。fidelity-source-diff 阶段会按此契约硬卡。',
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
  var triggerDesc = describeTrigger(spec.triggerNext || spec.trigger) || (isLast ? 'near_entity(CtaButton) or click_entity(CtaButton) [MANDATORY arrival-gated for last phase]' : 'near_entity/resource_collected/entity_state_reached arrival-gated (no click_entity in non-final)');
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
