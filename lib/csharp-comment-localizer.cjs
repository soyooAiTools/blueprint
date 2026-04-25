var fs = require('fs');
var path = require('path');

function hasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function isStructuralTodo(text) {
  return /^TODO_[A-Za-z0-9_]+(?:_(?:START|END))?$/.test(String(text || '').trim());
}

function isSeparator(text) {
  return /^[=\-_*#\s]+$/.test(String(text || ''));
}

function findLineCommentIndex(line) {
  var inString = false;
  var inChar = false;
  var inVerbatimString = false;
  for (var i = 0; i < line.length - 1; i++) {
    var ch = line[i];
    var next = line[i + 1];

    if (inString) {
      if (inVerbatimString) {
        if (ch === '"' && next === '"') {
          i++;
        } else if (ch === '"') {
          inString = false;
          inVerbatimString = false;
        }
      } else if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (ch === '\\') {
        i++;
      } else if (ch === "'") {
        inChar = false;
      }
      continue;
    }

    if (ch === '/' && next === '/') return i;
    if (ch === "'") {
      inChar = true;
      continue;
    }
    if (ch === '"') {
      var prev = line[i - 1] || '';
      var prev2 = line[i - 2] || '';
      inString = true;
      inVerbatimString = prev === '@' || (prev === '$' && prev2 === '@') || (prev === '@' && prev2 === '$');
    }
  }
  return -1;
}

function replacePhrases(text) {
  var out = String(text || '');
  var replacements = [
    [/AUTO-GENERATED/g, '自动生成'],
    [/DO NOT MODIFY SKELETON LINES/g, '不要修改骨架行'],
    [/Generated from storyboard spec\. AI fills TODO sections only\./g, '由故事板规格生成。AI 只填充 TODO 区域。'],
    [/Lines marked \[SKELETON\] must not be removed or modified\./g, '带有 [SKELETON] 标记的行不得删除或修改。'],
    [/RENDERING RULES \(MUST FOLLOW — violation = build failure\)/g, '渲染规则（必须遵守，违反会导致构建失败）'],
    [/ANTI-AUTOPLAY RULES \(MUST FOLLOW — violation = CUA rejection\)/g, '反自动播放规则（必须遵守，违反会导致 CUA 拒收）'],
    [/Camera\.backgroundColor is pre-set to ([^—]+) — do NOT change/g, 'Camera.backgroundColor 已预设为 $1，请勿修改'],
    [/NEVER call GFM_Create\.SetColor\(\) — it causes GL_INVALID_OPERATION in Luna/g, '禁止调用 GFM_Create.SetColor()，会在 Luna 中触发 GL_INVALID_OPERATION'],
    [/NEVER call GFM_Create\.Obj\(\) — pool objects already exist, use GameObject\.Find\(\)/g, '禁止调用 GFM_Create.Obj()，对象池物体已经存在，请使用 GameObject.Find()'],
    [/Pool objects have pre-baked colors \(__Pool_Shape_Color_NN\) — just position them/g, '对象池物体已有预烘焙颜色（__Pool_Shape_Color_NN），只需要摆放位置'],
    [/Phase 1 must place at least 3 pool objects on screen to prevent solid-color/g, '第 1 阶段必须在屏幕上摆放至少 3 个对象池物体，避免纯色画面'],
    [/NEVER call Destroy\(\) — hide objects via position \(0, -999, 0\)/g, '禁止调用 Destroy()，请通过位置 (0, -999, 0) 隐藏物体'],
    [/NEVER use SafeColor or recursive color functions/g, '禁止使用 SafeColor 或递归颜色函数'],
    [/Every phase transition MUST require player interaction \(click\/drag\/joystick\)/g, '每个阶段转换都必须要求玩家交互（点击/拖拽/摇杆）'],
    [/NEVER advance phases based on timer alone — timer is minimum dwell, not trigger/g, '禁止仅按计时器推进阶段，计时器只是最短停留时间，不是触发条件'],
    [/playerMustAct=true phases MUST wait for user input before transitioning/g, 'playerMustAct=true 的阶段必须等待用户输入后才能转换'],

    [/FLOW PARTIAL/g, '流程 partial'],
    [/INPUT PARTIAL/g, '输入 partial'],
    [/RESOURCE PARTIAL/g, '资源 partial'],
    [/SCENE PARTIAL/g, '场景 partial'],
    [/UI PARTIAL/g, 'UI partial'],
    [/SYSTEMS FILE/g, '系统文件'],
    [/phase orchestration helpers/g, '阶段编排辅助'],
    [/player movement \/ tap handling helpers/g, '玩家移动/点击处理辅助'],
    [/economy \/ inventory \/ form helpers/g, '经济/背包/形态辅助'],
    [/entity placement \/ lifecycle helpers/g, '实体摆放/生命周期辅助'],
    [/CTA \/ HUD \/ exported preview state/g, 'CTA/HUD/导出预览状态'],
    [/Subsystems & Helpers/g, '子系统与辅助方法'],

    [/Owner class: GameFlowManagerMain \(partial\)\. Fields in main are shared\./g, '所属类：GameFlowManagerMain（partial）。主文件字段在各 partial 中共享。'],
    [/Flow Dispatchers/g, '流程分发器'],
    [/Shared Flow Helpers/g, '共享流程辅助'],
    [/Phase Init Handlers/g, '阶段初始化处理器'],
    [/Phase Tap Handlers/g, '阶段点击处理器'],
    [/Phase AutoPlay Handlers/g, '阶段自动播放处理器'],
    [/Phase Snapshot Helpers/g, '阶段快照辅助'],
    [/Game End/g, '游戏结束'],

    [/Interactive-mode tap dispatcher\. Update\(\) calls this on player tap/g, '交互模式点击分发器：Update() 在玩家点击时调用'],
    [/when !_autoPlayMode\. Grep phaseId to locate each Phase_<id>_OnTap\(\) below\./g, '当 !_autoPlayMode 时生效。可搜索 phaseId 定位下方对应的 Phase_<id>_OnTap()。'],
    [/Dispatch the current phase directly to its dedicated tap handler\./g, '将当前阶段直接分发到专用点击处理器。'],
    [/AutoPlay-mode dispatcher\. Keep this coordinator thin and delegate phase logic below\./g, '自动播放模式分发器。保持协调层轻量，并把阶段逻辑委托到下方方法。'],
    [/Dispatch directly to the active phase-specific autoPlay handler\./g, '直接分发到当前激活阶段对应的自动播放处理器。'],
    [/Sync the local autoplay mirrors from GFM_AutoPlay so Update\(\) stays lightweight\./g, '从 GFM_AutoPlay 同步本地自动播放镜像，让 Update() 保持轻量。'],
    [/Manager owns activation timing and step counting\. Keep main flow code read-only\./g, '管理器负责激活时机和步数统计。主流程代码保持只读式协调。'],
    [/Reset and advance the per-phase timer whenever the active phase changes\./g, '当激活阶段变化时，重置并推进当前阶段计时器。'],
    [/Apply the common state changes that happen whenever flow enters a new phase\./g, '进入新阶段时统一应用公共状态变更。'],
    [/Apply the immutable end-of-game sequence in one place\./g, '在一个位置执行不可变的游戏结束流程。'],
    [/Apply the common phase-progress bookkeeping after a transition completes\./g, '阶段转换完成后统一记录进度。'],
    [/Emit one stuck-phase marker and throttle repeats so CUA gets a stable fatal signal\./g, '发出一次阶段卡住标记并限流重复日志，让 CUA 获得稳定的致命信号。'],
    [/Record a completed phase in order and notify the autoPlay observer immediately\./g, '按顺序记录已完成阶段，并立即通知自动播放观察器。'],

    [/Phase "([^"]+)" enter\/init helper\./g, '阶段 "$1" 的进入/初始化辅助方法。'],
    [/Keep phase-specific placement\/guide logic here so CheckEventRules\(\) stays concise\./g, '把阶段专属的摆放/引导逻辑放在这里，让 CheckEventRules() 保持简洁。'],
    [/AI fills — place additional objects, set colors, show guide/g, 'AI 填充：摆放额外物体、设置颜色、显示引导'],
    [/AI fills — activate objects for (.*)/g, 'AI 填充：激活 $1 所需物体'],
    [/\[REMINDER\] This phase will exit when EntityAdvanced\(X, _snap_XPos\) > 1\.5 for every X/g, '[REMINDER] 当前阶段会在每个 X 都满足 EntityAdvanced(X, _snap_XPos) > 1.5 时退出'],
    [/listed above\. The exit gate reads transform\.position ONLY\. Flag writes/g, '上面列出的对象必须产生位移。退出门只读取 transform.position，写 flag'],
    [/\(xxxDone=true \/ xxxState=N \/ xxxPlayerActed=true\) DO NOT satisfy the gate\./g, '（xxxDone=true / xxxState=N / xxxPlayerActed=true）不能满足该门。'],
    [/Ensure the phase's player-triggered interaction body \(in Update \/ handlers \//g, '请确保该阶段由玩家触发的交互逻辑体（位于 Update / handlers /'],
    [/the matching case in OnAutoPlayArrive\) calls PlaceObj\(X,\.\.\.\) \/ HideObj\(X\) \//g, '或 OnAutoPlayArrive 中匹配的 case）会调用 PlaceObj(X,...) / HideObj(X) /'],
    [/X\.transform\.position = \.\.\. at least once per required entity\./g, '对每个必需实体至少执行一次 X.transform.position = ...。'],

    [/Phase "([^"]+)" tap handler\. AI\/template fills TODO region\./g, '阶段 "$1" 的点击处理器。AI/模板填充 TODO 区域。'],
    [/AI\/template fills — produce observable movement or other real gameplay progress here\./g, 'AI/模板填充：在这里产生可观察位移或其他真实玩法进度。'],
    [/Do NOT rely on (.*) \/ (.*) alone to advance the phase\./g, '不要只依赖 $1 / $2 来推进阶段。'],
    [/Phase "([^"]+)" autoPlay handler\./g, '阶段 "$1" 的自动播放处理器。'],
    [/MUST produce observable position changes so EntityAdvanced\(\.\.\.\) can pass\./g, '必须产生可观察的位置变化，EntityAdvanced(...) 才能通过。'],
    [/REQUIRED: produce observable change for each entity below/g, '必需：为下列每个实体产生可观察变化'],
    [/REQUIRED: call PlaceObj \/ HideObj \/ transform\.position = \.\.\. for the phase-required entity/g, '必需：对阶段必需实体调用 PlaceObj / HideObj / transform.position = ...'],
    [/AI fills — move\/activate entities so EntityAdvanced\(\.\.\.\) becomes true/g, 'AI 填充：移动/激活实体，让 EntityAdvanced(...) 变为 true'],
    [/targetName is provided by GFM_AutoPlay for phase-specific routing when needed\./g, 'targetName 由 GFM_AutoPlay 提供，供需要时做阶段内路由。'],
    [/Capture the current positions of phase-gating entities for later EntityAdvanced\(\.\.\.\) checks\./g, '捕获阶段门控实体的当前位置，供后续 EntityAdvanced(...) 检查使用。'],

    [/\[SKELETON FALLBACK\] Keep phase progression deterministic even/g, '[SKELETON FALLBACK] 即使阶段处理器为空，也保持阶段推进确定性'],
    [/when AI leaves the phase handler empty\. This mutates both transform/g, '当 AI 留空阶段处理器时，本回退会同时修改 transform'],
    [/positions and a small set of gameplay variables so CUA sees real progress\./g, '位置和少量玩法变量，让 CUA 能观察到真实进度。'],

    [/Phase timing system — enforces minimum dwell time per phase/g, '阶段计时系统：强制每个阶段的最短停留时间'],
    [/records when each phase was entered/g, '记录每个阶段的进入时间'],
    [/Phase tracking/g, '阶段跟踪'],
    [/AutoPlay — state owner is GFM_AutoPlay \(canonical library\)/g, 'AutoPlay：状态归属 GFM_AutoPlay（canonical 工具库）'],
    [/Local snapshots are synced at top of Update\(\) each frame for backward compat/g, '每帧在 Update() 开头同步本地快照，以兼容旧逻辑'],
    [/with downstream skeleton code that reads _autoPlayMode \/ _autoPlaySteps\./g, '兼容下游读取 _autoPlayMode / _autoPlaySteps 的骨架代码。'],
    [/tracks autoPlay steps when current phase started/g, '记录当前阶段开始时的自动播放步数'],
    [/12s per shot — DO NOT MODIFY this value/g, '每个 shot 12 秒，请勿修改该值'],
    [/Phase-scoped runtime evidence for module-contract verification\./g, '用于模块契约验证的阶段作用域运行时证据。'],
    [/Entity states — must reach terminal state/g, '实体状态：必须达到终态'],
    [/Anti-autoplay flags — AI MUST set these to true when player performs the required interaction/g, '反自动播放标记：玩家完成必需交互时，AI 必须把这些标记设为 true'],
    [/Set to true on player interaction \(click\/drag\/joystick\)/g, '玩家交互（点击/拖拽/摇杆）时设为 true'],
    [/Object references \(auto-mapped from entity→pool\)/g, '对象引用（从实体自动映射到对象池）'],
    [/Spawn compatibility helpers — compile-safe fallback when/g, '生成兼容辅助：当出现以下情况时提供编译安全回退'],
    [/AI\/template code invents Spawn<Entity>\(count\) wrappers instead of/g, 'AI/模板代码发明 Spawn<Entity>(count) 包装，而不是'],
    [/moving the pooled object directly\./g, '直接移动对象池物体。'],
    [/Generic enemy spawn alias for template\/schema fallbacks\./g, '模板/Schema 回退用的通用敌人生成别名。'],
    [/Some upstream generators still emit SpawnEnemy\(count\) as a placeholder;/g, '部分上游生成器仍会把 SpawnEnemy(count) 作为占位输出；'],
    [/keep this mapped to the primary enemy unit instead of failing method-check\./g, '这里将其映射到主要敌方单位，避免 method-check 失败。'],
    [/Shared fallback pos for phase-entry snapshots \(class field init, not hot path\)/g, '阶段进入快照的共享回退位置（类字段初始化，不在热路径）'],
    [/Per-entity phase-entry snapshots — DO NOT MODIFY/g, '每个实体的阶段进入快照：请勿修改'],
    [/Camera reference — use mainCam instead of Camera\.main/g, '相机引用：使用 mainCam，不使用 Camera.main'],
    [/UI references — canvas and text pre-created, use directly/g, 'UI 引用：canvas 和文本已预创建，请直接使用'],
    [/Economy\/resource helpers live in GameFlowManagerMain\.Resource\.cs/g, '经济/资源辅助方法位于 GameFlowManagerMain.Resource.cs'],
    [/Scene placement helpers live in GameFlowManagerMain\.Scene\.cs/g, '场景摆放辅助方法位于 GameFlowManagerMain.Scene.cs'],
    [/UI \/ CTA \/ UpdateGameState helpers live in GameFlowManagerMain\.UI\.cs/g, 'UI / CTA / UpdateGameState 辅助方法位于 GameFlowManagerMain.UI.cs'],
    [/Input helpers live in GameFlowManagerMain\.Input\.cs/g, '输入辅助方法位于 GameFlowManagerMain.Input.cs'],
    [/AutoPlay phase dispatch helpers live in GameFlowManagerMain\.Flow\.cs/g, '自动播放阶段分发辅助方法位于 GameFlowManagerMain.Flow.cs'],
    [/Phase bookkeeping helpers live in GameFlowManagerMain\.Flow\.cs/g, '阶段记账辅助方法位于 GameFlowManagerMain.Flow.cs'],
    [/AutoPlay targets — passed to GFM_AutoPlay\.Instance in Start\(\)/g, 'AutoPlay 目标：在 Start() 中传给 GFM_AutoPlay.Instance'],
    [/AutoPlayUpdate — delegates to GFM_AutoPlay\.Instance \(navigation \+ OnArrive\)/g, 'AutoPlayUpdate：委托给 GFM_AutoPlay.Instance（导航 + OnArrive）'],
    [/sync local for backward compat/g, '同步本地状态以兼容旧逻辑'],
    [/AutoPlay phase assist — trigger exactly one deterministic/g, 'AutoPlay 阶段辅助：精确触发一次确定性'],
    [/in-phase side effect after a short settle window\. This prevents/g, '阶段内副作用，等待短暂稳定窗口后执行。这样可避免'],
    [/observe-mode CUA from stalling forever when navigation reaches no/g, 'observe 模式 CUA 在导航没有到达'],
    [/valid targets or OnArrive cannot fire reliably in WebGL\./g, '有效目标或 WebGL 中 OnArrive 无法可靠触发时永久卡住。'],
    [/Phase instrumentation for automated testing/g, '自动化测试用阶段埋点'],
    [/Bridge\.NET compiles this to console\.log which Playwright can capture/g, 'Bridge.NET 会将其编译为 console.log，Playwright 可捕获。'],
    [/Phase condition helper — reads REAL GameObject position \(DO NOT MODIFY\)/g, '阶段条件辅助：读取真实 GameObject 位置（请勿修改）'],
    [/AI declares pools, counters, and game-specific variables below/g, 'AI 在下方声明对象池、计数器和游戏专属变量'],
    [/\[AUTO-REPAIR\] Compile-safe player bridge property for generated templates\./g, '[AUTO-REPAIR] 面向生成模板的编译安全 player 桥接属性。'],
    [/\[AUTO-REPAIR\] Batch-2 collect cooldown infra\./g, '[AUTO-REPAIR] Batch-2 采集冷却基础设施。'],
    [/Initialize phase tracking/g, '初始化阶段跟踪'],
    [/Scene entity management/g, '场景实体管理'],
    [/Pool objects already ship with pre-baked colors/g, '对象池物体已经带有预烘焙颜色'],
    [/Entity variable shortcuts \(backed by GameSceneCtrl cache\)/g, '实体变量快捷引用（由 GameSceneCtrl 缓存支持）'],
    [/Anti-solid-color: show initial objects \(pool objects have pre-baked colors — do NOT call SetColor\)/g, '防纯色：显示初始物体（对象池物体已有预烘焙颜色，请勿调用 SetColor）'],
    [/pool color: ([^—]+) — do NOT call SetColor/g, '对象池颜色：$1，请勿调用 SetColor'],
    [/keep original scale — avoid oversized black rectangles/g, '保持原始缩放，避免过大的黑色矩形'],
    [/Transition from (.*) → (.*)/g, '从 $1 转换到 $2'],
    [/Phase-exit gate \(DO NOT MODIFY OR REMOVE\)/g, '阶段退出门（请勿修改或移除）'],
    [/\[IMMUTABLE\] Must match spec phaseId exactly/g, '[IMMUTABLE] 必须与规格中的 phaseId 完全一致'],
    [/time-only beat \(wait\/defend\) — timer gate is valid only before autoplay detect or after observer-ready activation/g, '纯时间节拍（wait/defend）：计时器门只在自动播放检测前或 observer-ready 激活后有效'],

    [/Keep input-facing helpers here so the main file stays focused on phase orchestration\./g, '把输入相关辅助方法放在这里，让主文件专注于阶段编排。'],
    [/Keep resource-facing helpers here so the main file only coordinates phase flow\./g, '把资源相关辅助方法放在这里，让主文件只协调阶段流程。'],
    [/Keep scene-facing helpers here so the main file stays focused on flow orchestration\./g, '把场景相关辅助方法放在这里，让主文件专注于流程编排。'],
    [/Keep UI-facing helpers here so the main file only orchestrates when they are called\./g, '把 UI 相关辅助方法放在这里，让主文件只负责编排调用时机。'],
    [/Place a pooled scene object at a concrete world position\./g, '把对象池场景物体放到具体世界坐标。'],
    [/Hide a pooled scene object by moving it below the playable camera range\./g, '通过把对象池场景物体移到可玩相机范围下方来隐藏它。'],
    [/Apply a non-uniform scene scale to a pooled object\./g, '对对象池物体应用非等比场景缩放。'],
    [/Apply a uniform scene scale to a pooled object\./g, '对对象池物体应用等比场景缩放。'],
    [/Trigger the final CTA directly when the game-end gate succeeds\./g, '游戏结束门通过后直接触发最终 CTA。'],
    [/Serialize current runtime state for preview polling \/ CUA verification\./g, '序列化当前运行时状态，供预览轮询/CUA 验证使用。'],
    [/Economy system — delegated to GFM_EconomyManager \(state owner\)/g, '经济系统：委托给 GFM_EconomyManager（状态归属方）'],
    [/AI fills _resources array in Start\(\); skeleton syncs it to Manager once\./g, 'AI 在 Start() 中填充 _resources 数组；骨架会同步一次到 Manager。'],
    [/Legacy inventory compatibility shim\./g, '旧版背包兼容层。'],
    [/Older templates\/prompts still emit _inventory\["Gold"\] style reads\/writes\./g, '旧模板/提示仍可能输出 _inventory["Gold"] 风格的读写。'],
    [/Keep this alias wired to GFM_EconomyManager so old code compiles while/g, '保留该别名并接到 GFM_EconomyManager，让旧代码可编译，同时'],
    [/runtime state remains single-sourced in the manager\./g, '运行时状态仍由 manager 单一维护。'],
    [/Sync locally-filled _resources into GFM_EconomyManager \(once\)/g, '将本地填充的 _resources 同步到 GFM_EconomyManager（一次）'],
    [/Delegate stubs — forward to GFM_EconomyManager \(single source of truth\)/g, '委托桩：转发到 GFM_EconomyManager（单一事实来源）'],

    [/\[ASSEMBLY OWNER MANIFEST\] Deterministic scaffold generated from AssemblyPlan\./g, '[ASSEMBLY OWNER MANIFEST] 由 AssemblyPlan 确定性生成的脚手架。'],
    [/Deterministic Assembly Slots/g, '确定性装配槽位'],
    [/Implement only `([^`]+)` for `([^`]+)` in this owner file\./g, '只在此归属文件中实现 `$1` 针对 `$2` 的逻辑。'],
    [/This slot is generated deterministically from AssemblyPlan; keep logic local to this module\./g, '该槽位由 AssemblyPlan 确定性生成；逻辑应保持在本模块内。'],
    [/No assembly slots owned by ([^.]+)\./g, '$1 没有归属的装配槽位。'],
    [/No module instances currently owned by this file\./g, '当前文件没有归属的模块实例。'],
    [/\[ASSEMBLY FALLBACK EVIDENCE\] action-backed signal evidence from CUA actions\./g, '[ASSEMBLY FALLBACK EVIDENCE] 来自 CUA 动作的信号证据回退。'],
    [/\[ASSEMBLY SLOT BODY REDACTED\]/g, '[ASSEMBLY SLOT 正文已隐藏]'],
    [/Click ownership is input-scoped; build\/state transitions are handled by Flow owner slots\./g, '点击归属在输入作用域内；构建/状态转换由 Flow 归属槽位处理。'],

    [/GameSceneCtrl\.cs — scene entity management singleton/g, 'GameSceneCtrl.cs：场景实体管理单例'],
    [/Centralizes Find\/cache\/show\/hide to reduce skeleton boilerplate\./g, '集中处理 Find/缓存/显示/隐藏，减少骨架样板代码。'],
    [/Plain class \(no MonoBehaviour\) — Luna-safe, no AddComponent needed\./g, '普通类（非 MonoBehaviour）：Luna 安全，不需要 AddComponent。'],
    [/ScriptActivator\.cs — pre-baked behavior component for pool objects/g, 'ScriptActivator.cs：对象池物体的预烘焙行为组件'],
    [/Attach to __Pool_\* objects in Unity Editor\. Activate at runtime via config\./g, '在 Unity Editor 中挂到 __Pool_* 物体上，运行时通过配置激活。'],
    [/Object pool counters \(scene has ([^)]+)\)/g, '对象池计数器（场景包含 $1）'],
    [/neutral base, Obj\(\) will set per-type colors/g, '中性基础色，Obj() 会按类型设置颜色'],
    [/Auto-set camera: top-down 45° orthographic view/g, '自动设置相机：俯视 45° 正交视角'],
    [/sky blue/g, '天空蓝'],
    [/Cube, Capsule → use cube pool/g, 'Cube、Capsule 使用 cube 对象池'],
    [/Clamp to max \(reuse last object\)/g, '限制到最大值（复用最后一个物体）'],
    [/Fallback: CreatePrimitive \(won't render in Luna, but compiles\)/g, '回退：CreatePrimitive（Luna 中不会渲染，但可编译）'],
    [/Hide all pool objects \(move offscreen\)/g, '隐藏所有对象池物体（移出屏幕）'],
    [/Auto-assign distinct base color by primitive type \(fallback if AI doesn't SetColor\)/g, '按 primitive 类型自动分配不同基础色（AI 未 SetColor 时的回退）'],
    [/brown/g, '棕色'],
    [/green/g, '绿色'],
    [/steel gray/g, '钢灰色'],
    [/dark brown/g, '深棕色'],
    [/light gray/g, '浅灰色'],
    [/\bblue\b/g, '蓝色'],
    [/\bred\b/g, '红色'],
    [/\byellow\b/g, '黄色'],
    [/\borange\b/g, '橙色'],
    [/\bwhite\b/g, '白色']
  ];

  for (var i = 0; i < replacements.length; i++) {
    out = out.replace(replacements[i][0], replacements[i][1]);
  }
  return out;
}

var metadataLabels = {
  ownerFile: '所属文件',
  moduleInstances: '模块实例',
  relevantPhases: '相关阶段',
  moduleId: '模块 ID',
  entity: '实体',
  statesWritten: '写入状态',
  expectedSignals: '期望信号',
  observableFeedback: '可观察反馈',
  sourceAtoms: '来源 atom',
  params: '参数',
  phaseEvidenceSchema: '阶段证据结构',
  activateEntities: '激活实体',
  completionSignals: '完成信号',
  cuaActions: 'CUA 动作',
  ownerSlots: '归属槽位',
  Duration: '时长',
  Interactions: '交互',
  Requires: '要求',
};

function localizeMetadata(text) {
  var match = /^([A-Za-z][A-Za-z0-9_]*(?:\([^)]*\))?):\s*(.*)$/.exec(text);
  if (!match) return null;
  var key = match[1];
  var baseKey = key.replace(/\([^)]*\)/g, '');
  var label = metadataLabels[baseKey] || metadataLabels[key];
  if (!label) return null;
  if (text.indexOf('// ' + label) >= 0) return text;
  return key + ': ' + match[2] + '  // ' + label;
}

function localizeFallback(text) {
  var trimmed = String(text || '').trim();
  if (!trimmed) return text;
  if (isSeparator(trimmed) || isStructuralTodo(trimmed)) return text;
  if (/^\/+$/.test(trimmed)) return text;
  if (/^[{}\[\],]+$/.test(trimmed)) return '数据: ' + trimmed;
  if (/^["{}\[\],]/.test(trimmed) || /^"[^"]+"\s*:/.test(trimmed)) return '数据: ' + trimmed;
  if (/^[A-Za-z_][A-Za-z0-9_.]*\([^)]*\);?$/.test(trimmed)) return '示例: ' + trimmed;
  if (/^(var|int|float|bool|string|Camera|Ray|Vector[234]|GameObject|List<|if\b)/.test(trimmed)) return '示例: ' + trimmed;
  if (/^[-*]\s/.test(trimmed)) return trimmed.replace(/^([-*]\s*)/, '$1说明：');
  if (/^\d+\.\s/.test(trimmed)) return trimmed.replace(/^(\d+\.\s*)/, '$1说明：');
  return '说明：' + trimmed;
}

function localizeCommentBody(body) {
  var original = String(body || '');
  var leading = (original.match(/^\s*/) || [''])[0];
  var text = original.slice(leading.length);
  var trimmed = text.trim();

  if (!trimmed || isSeparator(trimmed) || isStructuralTodo(trimmed)) return original;

  var translated = replacePhrases(text);
  translated = translated
    .replace(/^数据:\s*(\[ASSEMBLY PHASE\]\s*phaseId=.*)$/g, '$1')
    .replace(/^数据:\s*(\[ASSEMBLY SLOT\]\s*.*)$/g, '$1')
    .replace(/\[ASSEMBLY PHASE\]\s*phaseId=/g, '[ASSEMBLY PHASE] 装配阶段 phaseId=')
    .replace(/\[ASSEMBLY SLOT\]\s*(?:装配槽\s*)*/g, '[ASSEMBLY SLOT] 装配槽 ')
    .replace(/^说明：ownerSlots\(([^)]+)\):\s*(.*)$/g, 'ownerSlots($1): $2');
  translated = translated
    .replace(/^(?:说明：)?Player must act:\s*(.*)$/g, '是否必须玩家操作：$1')
    .replace(/^(?:说明：)?Condition hint:\s*(.*)$/g, '条件提示：$1')
    .replace(/=== TODO: AI 填充：激活 (.*) === 所需物体/g, '=== TODO: AI 填充：激活 $1 所需物体 ===');
  var metadata = localizeMetadata(translated.trim());
  if (metadata) translated = metadata;
  Object.keys(metadataLabels).forEach(function(key) {
    var label = metadataLabels[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    translated = translated.replace(new RegExp('(// ' + label + ')(?:\\s+// ' + label + ')+', 'g'), '$1');
  });
  if (!hasChinese(translated) && /[A-Za-z]/.test(translated)) {
    translated = localizeFallback(translated);
  }
  return leading + translated;
}

function findBlockCommentRanges(line) {
  var ranges = [];
  var inString = false;
  var inChar = false;
  var inVerbatimString = false;
  for (var i = 0; i < line.length - 1; i++) {
    var ch = line[i];
    var next = line[i + 1];

    if (inString) {
      if (inVerbatimString) {
        if (ch === '"' && next === '"') {
          i++;
        } else if (ch === '"') {
          inString = false;
          inVerbatimString = false;
        }
      } else if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (inChar) {
      if (ch === '\\') {
        i++;
      } else if (ch === "'") {
        inChar = false;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      var end = line.indexOf('*/', i + 2);
      if (end >= 0) {
        ranges.push({ start: i, end: end + 2 });
        i = end + 1;
      }
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === "'") {
      inChar = true;
      continue;
    }
    if (ch === '"') {
      var prev = line[i - 1] || '';
      var prev2 = line[i - 2] || '';
      inString = true;
      inVerbatimString = prev === '@' || (prev === '$' && prev2 === '@') || (prev === '@' && prev2 === '$');
    }
  }
  return ranges;
}

function localizeCSharpComments(text) {
  var input = String(text || '').replace(/\r\n/g, '\n');
  var lines = input.split('\n');
  var changed = false;
  var localized = 0;
  for (var i = 0; i < lines.length; i++) {
    var blockRanges = findBlockCommentRanges(lines[i]);
    for (var bi = blockRanges.length - 1; bi >= 0; bi--) {
      var range = blockRanges[bi];
      var blockBody = lines[i].slice(range.start + 2, range.end - 2);
      var nextBlockBody = localizeCommentBody(blockBody);
      if (nextBlockBody !== blockBody) {
        lines[i] = lines[i].slice(0, range.start + 2) + nextBlockBody + lines[i].slice(range.end - 2);
        changed = true;
        localized++;
      }
    }
    var idx = findLineCommentIndex(lines[i]);
    if (idx < 0) continue;
    var prefix = lines[i].slice(0, idx + 2);
    var body = lines[i].slice(idx + 2);
    var nextBody = localizeCommentBody(body);
    if (nextBody !== body) {
      lines[i] = prefix + nextBody;
      changed = true;
      localized++;
    }
  }
  return {
    code: lines.join('\n'),
    changed: changed,
    localized: localized,
  };
}

function walkCSharpFiles(target) {
  if (!fs.existsSync(target)) return [];
  var stat = fs.statSync(target);
  if (stat.isFile()) return /\.cs$/.test(target) ? [target] : [];
  var out = [];
  var entries = fs.readdirSync(target, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.name === 'Library' || entry.name === 'Temp' || entry.name === 'obj' || entry.name === 'bin') continue;
    var next = path.join(target, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkCSharpFiles(next));
    } else if (entry.isFile() && /\.cs$/.test(entry.name)) {
      out.push(next);
    }
  }
  return out;
}

function localizeCSharpFile(filePath, write) {
  var before = fs.readFileSync(filePath, 'utf8');
  var result = localizeCSharpComments(before);
  if (write && result.changed) fs.writeFileSync(filePath, result.code, 'utf8');
  return {
    file: filePath,
    changed: result.changed,
    localized: result.localized,
  };
}

function localizeCSharpFiles(targets, write) {
  var files = [];
  for (var i = 0; i < (targets || []).length; i++) {
    files = files.concat(walkCSharpFiles(targets[i]));
  }
  files = Array.from(new Set(files)).sort();
  var summary = { files: files.length, changedFiles: 0, localizedComments: 0, results: [] };
  for (var j = 0; j < files.length; j++) {
    var result = localizeCSharpFile(files[j], write);
    summary.results.push(result);
    if (result.changed) summary.changedFiles++;
    summary.localizedComments += result.localized;
  }
  return summary;
}

function localizeContextCSharpComments(ctx) {
  if (!ctx) return { changed: false, files: 0, changedFiles: 0, localizedComments: 0 };
  var changed = false;
  var files = 0;
  var changedFiles = 0;
  var localizedComments = 0;

  if (typeof ctx.csCode === 'string') {
    files++;
    var main = localizeCSharpComments(ctx.csCode);
    if (main.changed) {
      ctx.csCode = main.code;
      changed = true;
      changedFiles++;
      localizedComments += main.localized;
    }
  }

  var extras = ctx.extraFiles || {};
  Object.keys(extras).forEach(function(name) {
    if (!/\.cs$/.test(name) || typeof extras[name] !== 'string') return;
    files++;
    var result = localizeCSharpComments(extras[name]);
    if (result.changed) {
      extras[name] = result.code;
      changed = true;
      changedFiles++;
      localizedComments += result.localized;
    }
  });

  return { changed: changed, files: files, changedFiles: changedFiles, localizedComments: localizedComments };
}

function main(argv) {
  var write = false;
  var targets = [];
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--write') {
      write = true;
    } else {
      targets.push(argv[i]);
    }
  }
  if (targets.length === 0) {
    console.error('Usage: node lib/csharp-comment-localizer.cjs [--write] <file-or-dir>...');
    process.exit(2);
  }
  var summary = localizeCSharpFiles(targets, write);
  console.log(JSON.stringify({
    write: write,
    files: summary.files,
    changedFiles: summary.changedFiles,
    localizedComments: summary.localizedComments,
  }, null, 2));
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  findLineCommentIndex: findLineCommentIndex,
  localizeCSharpComments: localizeCSharpComments,
  localizeCSharpFiles: localizeCSharpFiles,
  localizeContextCSharpComments: localizeContextCSharpComments,
  _internals: {
    findBlockCommentRanges: findBlockCommentRanges,
    hasChinese: hasChinese,
    isStructuralTodo: isStructuralTodo,
    localizeCommentBody: localizeCommentBody,
  },
};
