/**
 * Skeleton Generator — Generate GameFlowManagerMain.cs skeleton from phase specs
 *
 * Input: Phase specs array + entity→pool mapping + GFM_Tools API configuration
 * Output: C# skeleton code with enforced phaseTimer, interaction gates, pre-generated boilerplate
 *
 * The skeleton ensures:
 * - Every phase has minimum dwell time (from spec.duration.min)
 * - Every phase transition requires spec.triggerNext.condition
 * - AI can only fill TODO sections, cannot remove skeleton-enforced code
 * - All entities must reach terminal state before game ends
 * - Start() is pre-populated with entity binding, colors, camera, GFM_Luna.Init()
 * - ShowCTA() is pre-generated with InstallFullGame()
 * - Phase 1 places 3 objects to prevent solid-color screen
 */

const fs = require('fs');
const path = require('path');

// 防纯色初始化用默认颜色
const GROUND_COLOR = { r: 0.75, g: 0.78, b: 0.82 };
const CAMERA_BG = { r: 0.45, g: 0.52, b: 0.62 };
const ENTITY_COLORS = [
  { r: 0.6, g: 0.3, b: 0.15, label: 'brown' },
  { r: 0.2, g: 0.4, b: 0.9, label: 'blue' },
  { r: 0.8, g: 0.2, b: 0.2, label: 'red' },
  { r: 0.2, g: 0.7, b: 0.3, label: 'green' },
  { r: 0.9, g: 0.7, b: 0.1, label: 'gold' }
];

/**
 * Generate C# skeleton from specs
 * @param {Array} specs - Phase specs from spec-extractor
 * @param {object} opts - { projectName, entityPoolMap: {entityName: poolObjName} }
 * @returns {string|{main: string, systems: string}} C# skeleton code (single string for ≤10 phases, {main,systems} for >10)
 */
const RESERVED_SKELETON_VARS = new Set([
  'gold', 'moveSpeed', 'collectRange', 'maxCarry', 'carrying', 'carryingType',
  'player', 'mainCam', 'uiCanvas', 'guideText', 'scoreText',
  'phaseTimer', 'phaseRealTimer', 'lastPhaseRealClock', 'gameTimer', 'gameEnded', 'currentPhaseName', 'ruleTriggered',
  'completedPhases', 'completedPhaseCount', 'floatingText', 'floatingTextTimer',
  'tapMoveTarget', 'hasTapTarget', 'carryVisuals', 'playerHP', 'enemiesDefeated',
]);

function pickGenericEnemyAliasTarget(entityNames) {
  var names = Array.isArray(entityNames) ? entityNames.slice() : [];
  function score(name) {
    var text = String(name || '');
    var total = 0;
    if (/Enemy/i.test(text)) total += 40;
    if (/Astronaut|Soldier|Unit|Troop|Mob|Minion|Bot|Drone|Walker/i.test(text)) total += 30;
    if (/Base|Button|CTA|Recycler|Gold|Tower|Belt|Debris|Bullet/i.test(text)) total -= 80;
    return total;
  }
  names.sort(function(a, b) { return score(b) - score(a); });
  return names.length > 0 && score(names[0]) > 0 ? names[0] : null;
}

function csString(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// [WAVE F] 玩家可读性自动注入：根据 spec 字段在 Phase_*_Init 顶部发射 SetGuideText / SetPhaseGoal。
//   - autoAllowed && autoModeHint → SetGuideText(autoModeHint)（演出文案优先）
//   - else playerInstruction → SetGuideText(playerInstruction)
//   - goal 存在 → SetPhaseGoal(kind, target, displayResource)
//   - goal 缺省但前一 phase 可能设过 → ClearPhaseGoal()，避免上一个 phase 的目标残留
//   - 字段全缺省时不发射任何代码（旧行为完全保留）。
//   - subAction 存在时仅发射注释（task 7 单独消化路由）。
function _emitPlayerReadability(lines, spec) {
  if (!spec) return;
  var hint = null;
  var hintSource = '';
  if (spec.autoAllowed && typeof spec.autoModeHint === 'string' && spec.autoModeHint.length > 0) {
    hint = spec.autoModeHint;
    hintSource = 'autoModeHint';
  } else if (typeof spec.playerInstruction === 'string' && spec.playerInstruction.length > 0) {
    hint = spec.playerInstruction;
    hintSource = 'playerInstruction';
  }
  if (hint != null) {
    lines.push('        // [WAVE F] 玩家可读引导：来自 spec.' + hintSource);
    lines.push('        SetGuideText("' + csString(hint) + '");');
  }
  if (spec.goal && typeof spec.goal === 'object') {
    var kind = csString(spec.goal.kind || '');
    var target = Number(spec.goal.target) || 0;
    var resource = csString(spec.goal.displayResource || '');
    lines.push('        // [WAVE F] 玩家可读目标：来自 spec.goal');
    lines.push('        SetPhaseGoal("' + kind + '", ' + target + ', "' + resource + '");');
  }
  // [WAVE F] subAction 消歧注释：同 entity 多动作时 LLM 必须按 subAction 路由分流。
  // 暂不发射 C# 路由代码（留给下一 wave），此处只把信息暴露给 codegen prompt。
  var _subs = _wfPhaseSubActions(spec);
  if (_subs.length > 0) {
    lines.push('        // [WAVE F] subAction 消歧（同 entity 多动作 → 必须 if/switch 分流）：');
    _subs.forEach(function(s) {
      lines.push('        //   ' + s.verb + ':' + s.target + ' → subAction="' + s.subAction + '"');
    });
  }
}

// [WAVE F] specs 中是否有任何 phase 用到玩家可读性字段。决定是否发射对应 helper 方法/UI。
function _anyPlayerReadabilityField(specs) {
  if (!Array.isArray(specs)) return false;
  for (var i = 0; i < specs.length; i++) {
    var s = specs[i] || {};
    if (typeof s.playerInstruction === 'string' && s.playerInstruction.length > 0) return true;
    if (typeof s.autoModeHint === 'string' && s.autoModeHint.length > 0) return true;
    if (s.goal && typeof s.goal === 'object') return true;
  }
  return false;
}

// [WAVE F] requiredInteractions 兼容字符串/对象，为注释/调试输出生成可读字符串。
function _wfRenderInteractions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.map(function(ri) {
    if (typeof ri === 'string') return ri;
    if (ri && typeof ri === 'object') {
      var base = (ri.verb || '') + ':' + (ri.target || ri.item || '');
      if (ri.subAction) base += ':' + ri.subAction;
      return base;
    }
    return '';
  }).filter(Boolean).join(', ');
}

// [WAVE F] 检查 phase 的 requiredInteractions 中是否有 subAction 字段，决定是否发射消歧注释。
function _wfPhaseSubActions(spec) {
  if (!spec || !Array.isArray(spec.requiredInteractions)) return [];
  var out = [];
  for (var i = 0; i < spec.requiredInteractions.length; i++) {
    var ri = spec.requiredInteractions[i];
    if (ri && typeof ri === 'object' && ri.subAction) {
      out.push({
        verb: ri.verb || '',
        target: ri.target || ri.item || '',
        subAction: ri.subAction,
      });
    }
  }
  return out;
}

// Wave 1 / C1：把分镜信息渲染成程序员可读的注释块，置于 Phase_*_Init/_OnTap/_OnAutoPlayArrive 方法定义上方。
// 注：这些注释会进入交付给程序员的 C# 源码，programmer-delivery-cleaner 不会删除它们。
function buildShotDocLines(spec, phaseIndex, opts) {
  var indent = (opts && opts.indent) || '    ';
  var lines = [];
  var pid = spec && spec.phaseId ? spec.phaseId : ('phase' + (phaseIndex + 1));
  var title = spec && spec.phaseName ? String(spec.phaseName) : '';
  var dur = spec && spec.duration ? spec.duration : {};
  var durMin = dur && dur.min != null ? dur.min : '-';
  var durMax = dur && dur.max != null ? dur.max : '-';
  var interactions = (spec && spec.requiredInteractions) || [];
  var entities = (spec && spec.entitiesRequired) || [];
  var entityNames = entities.map(function(e) {
    if (typeof e === 'string') return e;
    return e && e.name ? e.name : '';
  }).filter(Boolean);
  var endCondition = spec && spec.triggerNext && spec.triggerNext.condition
    ? String(spec.triggerNext.condition)
    : '(无显式 trigger，自动进入下一 phase)';
  var bar = '─────────────────────────────────────────────────────────';
  lines.push(indent + '// ' + bar);
  lines.push(indent + '// Shot ' + (phaseIndex + 1) + ' / Phase: ' + pid);
  if (title) lines.push(indent + '// 标题: ' + title);
  lines.push(indent + '// 时长: ' + durMin + '-' + durMax + 's');
  lines.push(indent + '// 操作: ' + (interactions.length ? interactions.join(' / ') : '(无玩家操作 / 自动播放)'));
  lines.push(indent + '// 入画物体: ' + (entityNames.length ? entityNames.join(', ') : '(沿用上一镜头)'));
  lines.push(indent + '// 退出条件: ' + endCondition);
  lines.push(indent + '// ' + bar);
  return lines;
}

function inferPhaseEvidenceSignals(spec) {
  var signals = {
    phase_advanced: true,
    guide_text_visible: true,
    visual_variant_changed: true,
  };
  if (spec && spec.playerMustAct) signals.tap_registered = true;
  var interactions = (spec && spec.requiredInteractions) || [];
  for (var i = 0; i < interactions.length; i++) {
    var parts = String(interactions[i] || '').split(':');
    var verb = String(parts[0] || '').toLowerCase();
    if (verb === 'click' || verb === 'tap') {
      signals.tap_registered = true;
      signals.entity_state_changed = true;
    } else if (verb === 'move_to') {
      signals.player_position_changed = true;
      signals.distance_to_target_below_threshold = true;
    } else if (verb === 'collect') {
      signals.resource_incremented = true;
      signals.source_hidden_or_moved = true;
      signals.distance_to_target_below_threshold = true;
    } else if (verb === 'deliver' || verb === 'sell') {
      signals.inventory_decremented = true;
      signals.resource_incremented = true;
      signals.reward_incremented = true;
      signals.source_hidden_or_moved = true;
      signals.distance_to_target_below_threshold = true;
    } else if (verb === 'spend') {
      signals.resource_decremented = true;
    } else if (verb === 'build') {
      signals.entity_state_equals_built = true;
      signals.downstream_entity_visible = true;
      signals.entity_state_changed = true;
    } else if (verb === 'upgrade') {
      signals.upgrade_level_changed = true;
      signals.visual_variant_changed = true;
      signals.entity_state_changed = true;
    } else if (verb === 'attack' || verb === 'defeat') {
      signals.projectile_visible = true;
      signals.target_hp_decreased_or_target_dead = true;
      signals.target_removed_or_hidden = true;
    } else if (verb === 'drag') {
      signals.drag_path_completed = true;
      signals.entity_state_changed = true;
    }
  }
  var phaseText = String((spec && (spec.phaseId || spec.phaseName)) || '').toLowerCase();
  if (/camera|zoom|view|base|barrack|tower|belt|occupy|enemy/.test(phaseText)) {
    signals.camera_orientation_changed = true;
    signals.camera_height_changed_or_view_widened = true;
    signals.camera_zoom_changed = true;
  }
  return Object.keys(signals);
}

function phaseNeedsSpend(spec, pid) {
  var interactions = (spec && spec.requiredInteractions) || [];
  for (var i = 0; i < interactions.length; i++) {
    var verb = String(interactions[i] || '').split(':')[0].toLowerCase();
    if (verb === 'spend') return true;
  }
  return false;
}

function generateSkeleton(specs, opts = {}) {
  // 防御式校验：spec-extract 阶段应保证 codegen 前 specs 非空。
  // 如果这里仍拿到 undefined/empty，就抛出指向契约的明确错误。
  if (!Array.isArray(specs) || specs.length === 0) {
    const err = new Error('generateSkeleton called with empty/undefined specs — spec-extract stage must populate ctx.blueprint.specs before codegen');
    err.classification = 'FATAL';
    throw err;
  }
  const totalPhases = specs.length;
  const entityPoolMap = opts.entityPoolMap || {};
  // [SKELETON 2026-04-19] entities[] 携带 chineseName / showLabel 供世界标签使用。
  const entityMeta = {};
  (opts.entities || []).forEach(ent => {
    if (ent && ent.name) entityMeta[ent.name] = ent;
  });

  // 解决实体名与骨架内置变量的冲突。
  const renamedEntities = {};
  Object.keys(entityPoolMap).forEach(name => {
    if (RESERVED_SKELETON_VARS.has(name)) {
      const newName = name + 'Obj';
      renamedEntities[name] = newName;
      entityPoolMap[newName] = entityPoolMap[name];
      delete entityPoolMap[name];
      // 同步 meta，保证 chineseName/showLabel 在重命名后仍保留。
      if (entityMeta[name]) {
        entityMeta[newName] = Object.assign({}, entityMeta[name], { name: newName });
        delete entityMeta[name];
      }
    }
  });
  // 同步重命名 specs，保持一致。
  if (Object.keys(renamedEntities).length > 0) {
    specs = JSON.parse(JSON.stringify(specs));
    specs.forEach(spec => {
      (spec.entitiesRequired || []).forEach(e => {
        if (renamedEntities[e.name]) e.name = renamedEntities[e.name];
      });
      (spec.requiredInteractions || []).forEach((interaction, idx) => {
        Object.keys(renamedEntities).forEach(oldName => {
          spec.requiredInteractions[idx] = interaction.replace(
            new RegExp('(^|:)' + oldName + '(:|$)', 'g'),
            '$1' + renamedEntities[oldName] + '$2'
          );
        });
      });
    });
  }

  const entityNames = Object.keys(entityPoolMap);
  const shouldSplit = totalPhases > 10;
  const lines = [];

  // 辅助：列出会参与 phase 出口 gate 的 GameObject 名称。
  // 只保留 collect/deliver/sell/click/spend/build/move_to 等已知模板会真实移动的实体。
  //
  // 原因：phase 出口绑定 EntityAdvanced(X, _snap_XPos)。如果 X 在该 phase 没有任何
  // 会移动它的交互，gate 在结构上不可达。这里返回 []，让 buildRealCondition()
  // 明确退回到 wait/defend 这类真实时间节拍，或直接生成 hard false gate。
  const MOVING_VERBS = { collect: 1, deliver: 1, sell: 1, click: 1, spend: 1, build: 1, upgrade: 1, move_to: 1, reach: 1, drag: 1, hold: 1, attack: 1, defeat: 1, defeat_count: 1, appear: 1, disappear: 1, unlock: 1 };
  function phaseGateEntities(spec) {
    const interactions = spec.requiredInteractions || [];

    const movingTargets = [];
    const seen = {};
    for (let ii = 0; ii < interactions.length; ii++) {
      // [WAVE F] requiredInteractions 兼容字符串/对象两种形式。
      const ri = interactions[ii];
      let verb, target;
      if (typeof ri === 'string') {
        const parts = ri.split(':');
        verb = parts[0];
        target = parts[1];
      } else if (ri && typeof ri === 'object') {
        verb = ri.verb || '';
        target = ri.target || ri.item || '';
      } else {
        continue;
      }
      if (!target) continue;
      if (/^\d/.test(target)) continue;
      if (!MOVING_VERBS[verb]) continue;
      if (allEntities && allEntities.has && !allEntities.has(target)) continue;
      if (!seen[target]) { movingTargets.push(target); seen[target] = true; }
    }
    return movingTargets;
  }

  // 构建 phase 出口 realCondition。交互模式绑定真实 GameObject 位移；
  // autoplay 也优先使用同一位移证明，仅在 GFM_AutoPlay 已产生 phase 内动作后
  // 才接受模块状态作为第二证明，避免 WebGL/runtime 快照差异导致 CUA 卡死。
  //
  // Luna 禁止 SetActive()（见 static-check 的 setactive 规则），因此
  // EntityAdvanced 只检查位置。骨架的 PlaceObj/HideObj 分别把实体移动到
  // y >= 0 或 y = -999，二者都算可观测位移。
  //
  // CUA 对齐：EntityAdvanced 直接读取 transform.position，条件满足时必然有视觉差异。
  function buildRealCondition(spec) {
    const names = phaseGateEntities(spec);
    if (names.length === 0) {
      // 没有 gate 实体时，检查该 phase 是否是合法的 wait/defend 节拍。
      // wait:N / defend:N 表示维持 N 秒动画；此时 timer gate 就是真实条件。
      // 返回 true 后，只有 phaseTimer >= Xf 控制出口，不涉及可伪造 flag。
      //
      // CUA 细节：observe mode 会等验证器挂上后才发 __CUA_OBSERVER_READY__。
      // 如果已检测到 autoplay 但尚未激活，纯时间节拍不能提前按交互计时地板推进。
      const inter = spec.requiredInteractions || [];
      const onlyTimeBased = (inter.length === 0 && !spec.playerMustAct) || (inter.length > 0 && inter.every(function(s) {
        const v = (s || '').split(':')[0];
        return v === 'wait' || v === 'defend';
      }));
      if (onlyTimeBased) {
        return '(GFM_AutoPlay.Instance.DetectRealTime <= 0f || GFM_AutoPlay.Instance.IsActive) /* time-only beat (wait/defend) — timer gate is valid only before autoplay detect or after observer-ready activation */';
      }
      // 其他情况说明 phase spec 过松，AI 修改 C# 也无法补救；直接 hard block。
      return 'false /* AI: phase spec lacks entities/interactions — add EntityAdvanced(...) check with GameObject + snapshot */';
    }
    const parts = names.map(function(n) {
      const moveExpr = 'EntityAdvanced(' + n + ', _snap_' + n + 'Pos)';
      if (allEntities && allEntities.has && allEntities.has(n)) {
        return '(' + moveExpr + ' || (_autoPlayMode && _autoPlaySteps > _autoPlayStepsAtPhaseStart && ' + n + 'State >= 2))';
      }
      return moveExpr;
    });
    // 2026-05-13: phase-level autoplay 出口 override。任一 gate entity 都可能 null /
    // GFM_AutoPlay 可能 stall 导致 entity-level OR 路径全部 fail。加 phase-level OR 子句:
    // 一旦 _pushAutoplayFallback 触发(设 _autoplayFallbackFired_<pid> = true),phase gate 直接 pass。
    // 真玩家路径不受影响(_autoPlayMode = false 时 OR 短路到 entity 真实位移)。
    var pid = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');
    var phaseAutoplayGuard = '(_autoPlayMode && _autoplayFallbackFired_' + pid + ')';
    return '((' + parts.join(' && ') + ') || ' + phaseAutoplayGuard + ')';
  }


  // Header
  lines.push('// ========== 自动生成 SKELETON：只允许填写 TODO 区域 ==========');
  lines.push('// 由 storyboard/spec 生成。AI 只补充 TODO 段，不改写骨架契约。');
  lines.push('// 带 [SKELETON]、TODO_*、[ASSEMBLY SLOT] 的行是机器锚点，不要删除或改名前缀。');
  lines.push('//');
  lines.push('// *** 渲染约束（违反会导致构建或 Luna 运行失败） ***');
  lines.push('// 1. Camera.backgroundColor 已预设为 (0.45, 0.52, 0.62)，不要修改');
  lines.push('// 2. 不要调用 GFM_Create.SetColor()，Luna 下会触发 GL_INVALID_OPERATION');
  lines.push('// 3. 不要调用 GFM_Create.Obj()；对象池绑定统一走 GameSceneCtrl/RegisterEntityBindings()');
  lines.push('// 4. 对象池物体已预烘焙颜色（__Pool_Shape_Color_NN），只需要移动位置');
  lines.push('// 5. Phase 1 至少摆出 3 个对象池物体，避免首屏纯色');
  lines.push('// 6. 不要调用 Destroy()，隐藏物体统一移动到 (0, -999, 0)');
  lines.push('// 7. 不要使用 SafeColor 或递归改色函数');
  lines.push('//');
  lines.push('// *** 反自动播放约束（违反会被 CUA 拒绝） ***');
  lines.push('// 1. 每个需要玩家参与的 phase 都必须由点击/拖拽/摇杆等交互推进');
  lines.push('// 2. 计时器只表示最短停留时间，不能单独触发 phase 跳转');
  lines.push('// 3. playerMustAct=true 的 phase 必须等真实输入后才能过关');
  lines.push('//');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('using System.Globalization;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain : MonoBehaviour');
  lines.push('{');

  // Phase 计时系统（骨架强制）
  lines.push('    // [SKELETON] Phase timing：phaseTimer 控制交互最短停留；phaseRealTimer 控制 AutoPlay 真实墙钟停留。');
  lines.push('    float phaseTimer = 0f;');
  lines.push('    float phaseRealTimer = 0f;');
  lines.push('    float lastPhaseRealClock = 0f;');
  lines.push('    string lastPhaseForTimer = "";');
  lines.push('    float[] phaseEnterTimes;');
  lines.push('');

  // 游戏状态变量（骨架强制）
  lines.push('    // [SKELETON] Phase tracking：记录当前 phase、已完成列表和终局锁。');
  lines.push(`    const int RULE_COUNT = ${totalPhases};`);
  lines.push('    bool[] ruleTriggered;');
  lines.push('    string currentPhaseName = "init";');
  lines.push('    string[] completedPhases;');
  lines.push('    int completedPhaseCount = 0;');
  lines.push('    float gameTimer;');
  lines.push('    bool gameEnded = false;');
  lines.push('');
  lines.push('    // [SKELETON] AutoPlay：状态由 GFM_AutoPlay 统一持有，本地字段只做旧模板兼容镜像。');
  lines.push('    bool _autoPlayMode = false;');
  lines.push('    int _autoPlaySteps = 0;');
  lines.push('    int _autoPlayStepsAtPhaseStart = 0;');
  lines.push('    const float AUTO_PLAY_PHASE_DURATION = 12f; // [SKELETON] 每个 shot 12 秒，请勿修改该值');
  lines.push('');
  lines.push('    // 2026-05-13: deterministic autoplay phase-exit flag。每个 phase 各有 _autoplayFallbackFired_<id> 字段;');
  lines.push('    // _pushAutoplayFallback 触发时置 true,phase 出口 gate 加 OR 子句确保 autoplay 模式下 phase 必能推进,');
  lines.push('    // 不再依赖 GameObject 真实位移 (entity 可能 null) 或 _autoPlaySteps > baseline (GFM_AutoPlay 可能 stall)。');
  specs.forEach(function(spec) {
    var pid = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');
    lines.push('    bool _autoplayFallbackFired_' + pid + ' = false;');
  });
  lines.push('');
  lines.push('    // [SKELETON] Phase evidence：按 phase.signal 保存运行时证据，供 preview/CUA 验证。');
  lines.push('    string[] _phaseEvidenceKeys = new string[512];');
  lines.push('    string[] _phaseEvidenceValues = new string[512];');
  lines.push('    int _phaseEvidenceCount = 0;');
  lines.push('    int _phaseEvidenceWriteCount = 0;');
  lines.push('    int _phaseEvidenceWriteRejectionCount = 0;');
  lines.push('    string[] _phaseEvidenceResourceBalanceKeys = new string[64];');
  lines.push('    int[] _phaseEvidenceResourceBalanceValues = new int[64];');
  lines.push('    int _phaseEvidenceResourceBalanceCount = 0;');
  lines.push('    int lastKnownScore = 0;');
  lines.push('    string lastKnownScoreText = "";');
  lines.push('');

  // 实体状态变量：来自 entitiesRequired 和 entityPoolMap。
  const allEntities = new Set();
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => allEntities.add(e.name));
  });
  // 对象池映射里的实体也要补齐；AI 代码经常引用只在交互中出现的 {name}State。
  entityNames.forEach(name => allEntities.add(name));
  if (allEntities.size > 0) {
    lines.push('    // [SKELETON] Entity states：仅给模板/UI 同步使用。约定 0=未激活/等待，1=处理中，2=完成/可见。');
    allEntities.forEach(name => {
      lines.push(`    int ${name}State = 0;`);
    });
    lines.push('');
  }

  // [SKELETON] 反自动播放交互 flag：玩家输入时由 AI/模板写入。
  const interactionFlags = [];
  specs.forEach(spec => {
    const entities = spec.entitiesRequired || [];
    const interactions = spec.requiredInteractions || [];
    const mustAct = spec.playerMustAct !== false;
    const phaseId = (spec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');

    // 每个 phase 同时声明两类 flag；autoplay 镜像和模板引擎都会写，缺一会导致未声明变量。
    interactionFlags.push(phaseId + 'InteractionDone');
    interactionFlags.push(phaseId + 'PlayerActed');
    for (let ii = 0; ii < interactions.length; ii++) {
      // [WAVE F] requiredInteractions 兼容字符串/对象两种形式。
      const ri = interactions[ii];
      let verb, target;
      if (typeof ri === 'string') {
        const parts = ri.split(':');
        verb = parts[0];
        target = parts[1];
      } else if (ri && typeof ri === 'object') {
        verb = ri.verb || '';
        target = ri.target || ri.item || '';
      } else {
        continue;
      }
      if (!target || verb === 'wait' || verb === 'defend') continue;
      if (/^\d/.test(target)) continue; // 跳过数字目标，避免非法 C# 标识符。
      interactionFlags.push(target + 'Done');
    }
  });
  // Assembly emitter slots may write <Entity>Done for entities introduced by
  // blueprint/gameSchema resources even when that entity is not the direct
  // interaction target in specs. Declare all known entity Done flags so
  // deterministic slots stay compilable without needing custom logic repair.
  allEntities.forEach(name => {
    interactionFlags.push(name + 'Done');
  });
  if (interactionFlags.length > 0) {
    lines.push('    // [SKELETON] Interaction flags：记录玩家/CUA 是否触发过操作；phase 出口仍以真实位移或 evidence 为准。');
    const uniqueFlags = [...new Set(interactionFlags)];
    uniqueFlags.forEach(flag => {
      lines.push(`    bool ${flag} = false;`);
    });
    lines.push('');
  }

  // [SKELETON] 按 entity→pool 映射预生成 GameObject 声明。
  if (entityNames.length > 0) {
    lines.push('    // [SKELETON] Object references：字段名来自蓝图实体；对象池绑定集中在 Start()/GameSceneCtrl。');
    entityNames.forEach(name => {
      lines.push(`    GameObject ${name};`);
    });
    lines.push('');

    lines.push('    // [SKELETON] Entity binding table：唯一实体→对象池来源，避免 TODO 区二次 GameObject.Find 覆盖引用。');
    lines.push('    string[] _entityBindingIds = new string[] {');
    entityNames.forEach((name, idx) => {
      const comma = idx < entityNames.length - 1 ? ',' : '';
      lines.push('        "' + csString(name) + '"' + comma);
    });
    lines.push('    };');
    lines.push('    string[] _entityBindingPools = new string[] {');
    entityNames.forEach((name, idx) => {
      const comma = idx < entityNames.length - 1 ? ',' : '';
      lines.push('        "' + csString(entityPoolMap[name]) + '"' + comma);
    });
    lines.push('    };');
    lines.push('');
    lines.push('    // [SKELETON] 注册实体绑定：所有字段引用都从 GameSceneCtrl 缓存读取。');
    lines.push('    void RegisterEntityBindings()');
    lines.push('    {');
    lines.push('        for (int i = 0; i < _entityBindingIds.Length; i++)');
    lines.push('        {');
    lines.push('            GameSceneCtrl.instance.Register(_entityBindingIds[i], _entityBindingPools[i]);');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 刷新 GameObject 字段引用，gameplay/UI/preview 共用同一批对象。');
    lines.push('    void RefreshEntityReferences()');
    lines.push('    {');
    entityNames.forEach(name => {
      lines.push('        ' + name + ' = GameSceneCtrl.instance.Get("' + csString(name) + '");');
    });
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 启动时输出缺失池对象，便于交付后定位场景命名漂移。');
    lines.push('    void ValidateEntityBindings()');
    lines.push('    {');
    lines.push('        for (int i = 0; i < _entityBindingIds.Length; i++)');
    lines.push('        {');
    lines.push('            if (GameSceneCtrl.instance.Get(_entityBindingIds[i]) == null)');
    lines.push('            {');
    lines.push('                Debug.LogWarning("[EntityBinding] Missing pool object for " + _entityBindingIds[i] + ": " + _entityBindingPools[i]);');
    lines.push('            }');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    // 2026-05-05: Player 永远不能 HideObj —— Hide 把 y 拍到 -999, Start() 完到 phase 0
    // 第一次 Init() 中间会有几帧 Player 在 y=-999, 用户看到 player 从屏幕下方"瞬移"上来。
    // GFM_Player.Init 会负责把 Player 落到正确位置, HideAllBoundEntities 不要碰它。
    lines.push('    // [SKELETON] 开局先隐藏所有绑定实体，phase init 再显式摆放可见对象。');
    lines.push('    // Player 不在此列表内：Player 由 GFM_Player.Init 负责定位，开局可见。');
    lines.push('    void HideAllBoundEntities()');
    lines.push('    {');
    entityNames.forEach(name => {
      // 跳过 Player —— 防止 player 出现在 y=-999 又被 phase init 拽回，造成"瞬移上场"
      if (/^(Player|PlayerRobot|PlayerChar|Hero|MainChar|Protagonist)$/i.test(name)) {
        lines.push('        // Player 不 HideObj，避免开局瞬移');
        return;
      }
      lines.push('        HideObj(' + name + ');');
    });
    lines.push('    }');
    lines.push('');

    lines.push('    // [SKELETON] Spawn compatibility helpers：兼容旧模板的 Spawn<Entity>(count)，实际只移动已映射对象池物体。');
    lines.push('    void SpawnBoundEntity(GameObject entity, ref int entityState, int count)');
    lines.push('    {');
    lines.push('        if (entity == null) return;');
    lines.push('        var __spawnPos = entity.transform.position;');
    lines.push('        if (__spawnPos.y < -500f)');
    lines.push('        {');
    lines.push('            __spawnPos = new Vector3(0f, 0.5f, 0f);');
    lines.push('        }');
    lines.push('        if (count > 1) __spawnPos.x += 0.6f * (count - 1);');
    lines.push('        PlaceObj(entity, __spawnPos.x, __spawnPos.y, __spawnPos.z);');
    lines.push('        entityState = Mathf.Max(entityState, 1);');
    lines.push('    }');
    lines.push('');
    entityNames.forEach(name => {
      lines.push(`    // 旧模板调用 Spawn${name}(count) 时，实际显示并标记 ${name}。`);
      lines.push(`    void Spawn${name}(int count) { SpawnBoundEntity(${name}, ref ${name}State, count); }`);
      lines.push('');
    });

    var genericEnemyAliasTarget = pickGenericEnemyAliasTarget(entityNames);
    var hasLiteralEnemyEntity = entityNames.indexOf('Enemy') >= 0;
    if (genericEnemyAliasTarget && genericEnemyAliasTarget !== 'Enemy' && !hasLiteralEnemyEntity) {
      lines.push('    // 兼容仍调用 SpawnEnemy(count) 的旧模板，把它转发给本项目的主敌人单位。');
      lines.push('    void SpawnEnemy(int count)');
      lines.push('    {');
      lines.push('        Spawn' + genericEnemyAliasTarget + '(count);');
      lines.push('    }');
      lines.push('');
    }
  }

  // [SKELETON 2026-04-20] 每个 phase 入口记录实体位置，出口由 EntityAdvanced()
  // 对比真实 transform.position。不要再用 xxxState / xxxDone / xxxPlayerActed 假推进。
  if (entityNames.length > 0) {
    lines.push('    // [SKELETON] Phase snapshots：隐藏位作为缺省快照，真实出口只看对象位移。');
    lines.push('    Vector3 _snapHidePos = new Vector3(0f, -999f, 0f);');
    entityNames.forEach(name => {
      lines.push(`    Vector3 _snap_${name}Pos;`);
    });
    lines.push('');
  }

  // [SKELETON] 预创建 Camera、Canvas、UI 引用。
  lines.push('    // [SKELETON] Camera/UI references：Start() 统一创建并缓存，运行时代码直接复用这些字段。');
  lines.push('    Camera mainCam;');
  lines.push('    Canvas uiCanvas;');
  lines.push('    Text guideText;');
  lines.push('    Text scoreText;');
  lines.push('    Text floatingText;');
  lines.push('    float floatingTextTimer = 0f;');
  lines.push('    string _currentGuideText = ""; // 当前 guideText 文案缓存');
  lines.push('    string cameraFocusTarget = "";');
  lines.push('    // [SKELETON] Phase 进度指示：玩家随时知道流程位置（"[3/11] 文案..."）。');
  lines.push('    // _currentPhaseIndex 由 EnterPhase 维护，0 表示未开始；_totalPhases 编译期常量。');
  lines.push('    int _currentPhaseIndex = 0;');
  lines.push('    int _totalPhases = ' + specs.length + ';');
  lines.push('');
  // [WAVE F] 玩家目标显示：仅当 spec 用到 goal 字段时才发射，避免污染 legacy 项目快照。
  var _wfReadability = _anyPlayerReadabilityField(specs);
  // 模式识别提前到此处，让 WAVE F 的 UpdateGoalDisplay 能感知 hasEconomy。
  // 兼容字符串 "verb:arg" 与对象 { verb, target, ... } 两种 requiredInteractions 形态。
  function _wfVerb(i) {
    if (typeof i === 'string') return i.split(':')[0];
    if (i && typeof i === 'object') return String(i.verb || '');
    return '';
  }
  function _wfHasVerb(s, verbs) {
    return (s.requiredInteractions || []).some(function(i) {
      return verbs.indexOf(_wfVerb(i)) >= 0;
    });
  }
  const hasJoystick = specs.some(function(s) { return _wfHasVerb(s, ['move_to']); });
  const hasResources = specs.some(function(s) { return _wfHasVerb(s, ['collect', 'deliver']); });
  const isIdleGame = hasJoystick && hasResources;
  const hasFormSwitch = specs.some(function(s) { return !!s.formSwitch; });
  const hasEconomy = specs.some(function(s) { return _wfHasVerb(s, ['collect', 'deliver', 'spend', 'convert']); });
  if (_wfReadability) {
    lines.push('    // [WAVE F] 玩家目标 HUD：spec.goal 驱动 "X / Y" 进度文本。');
    lines.push('    Text goalText;');
    lines.push('    string _goalKind = "";        // amount | count | state | ""=无目标');
    lines.push('    int _goalTarget = 0;           // 目标阈值，0=无目标');
    lines.push('    string _goalResource = "";    // 关联资源 id（如 "gold"），可空');
    lines.push('');
  }
  lines.push('    // [SKELETON] Guide text 单一写入口；phase/template 不直接写 guideText.text。');
  lines.push('    // 自动追加 [X/N] 前缀，让玩家不会迷失在没有进度反馈的画面里。');
  lines.push('    void SetGuideText(string text)');
  lines.push('    {');
  lines.push('        _currentGuideText = text == null ? "" : text;');
  lines.push('        if (guideText != null)');
  lines.push('        {');
  lines.push('            string prefix = (_currentPhaseIndex > 0 && _totalPhases > 0)');
  lines.push('                ? ("[" + _currentPhaseIndex + "/" + _totalPhases + "] ")');
  lines.push('                : "";');
  lines.push('            guideText.text = prefix + _currentGuideText;');
  lines.push('        }');
  lines.push('        if (_currentGuideText.Length > 0) RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible");');
  lines.push('    }');
  lines.push('');
  // [WAVE F] 目标显示 helper —— 仅当 spec 用到 goal 时发射。
  if (_wfReadability) {
    lines.push('    // [WAVE F] phase 目标设置入口；spec.goal 驱动，每次 EnterPhase 由 Phase_*_Init 调用。');
    lines.push('    //   kind: "amount"=资源累积  "count"=次数  "state"=终态推进  ""=清空');
    lines.push('    //   target>0 时才显示文本；resource 给出时优先读 GFM_EconomyManager 的资源值。');
    lines.push('    void SetPhaseGoal(string kind, int target, string displayResource)');
    lines.push('    {');
    lines.push('        _goalKind = kind == null ? "" : kind;');
    lines.push('        _goalTarget = target;');
    lines.push('        _goalResource = displayResource == null ? "" : displayResource;');
    lines.push('        UpdateGoalDisplay();');
    lines.push('    }');
    lines.push('');
    lines.push('    void ClearPhaseGoal() { SetPhaseGoal("", 0, ""); }');
    lines.push('');
    lines.push('    // 每帧刷新目标 HUD。Update() 调用一次；无目标时清空文本。');
    lines.push('    void UpdateGoalDisplay()');
    lines.push('    {');
    lines.push('        if (goalText == null) return;');
    lines.push('        if (_goalKind == "" || _goalTarget <= 0)');
    lines.push('        {');
    lines.push('            goalText.text = "";');
    lines.push('            return;');
    lines.push('        }');
    lines.push('        int current = 0;');
    lines.push('        if (_goalResource.Length > 0)');
    lines.push('        {');
    if (hasEconomy) {
      lines.push('            // 经济项目：读 GFM_EconomyManager 的资源值（id 已归一）。');
      lines.push('            current = GFM_EconomyManager.Instance.GetResource(GFM_ResourceIds.Normalize(_goalResource));');
    } else {
      lines.push('            // 非经济项目：current 由游戏代码自行更新（通过 SetPhaseGoalCurrent）。');
    }
    lines.push('        }');
    lines.push('        string label = _goalResource.Length > 0 ? _goalResource : _goalKind;');
    lines.push('        goalText.text = label + ": " + current + " / " + _goalTarget;');
    lines.push('    }');
    lines.push('');
  }

  // 模式识别已上移到 [WAVE F] 块（兼容对象/字符串两种交互形态），此处直接复用上面声明的常量。

  // [SKELETON] 形态切换系统。
  if (hasFormSwitch) {
    lines.push('    // [SKELETON] 形态切换系统：AI 在 Start() 中填充 _forms 数组。');
    lines.push('    struct FormDef {');
    lines.push('        public string formId;');
    lines.push('        public string poolObjectName;');
    lines.push('        public float moveSpeed;');
    lines.push('        public float collectRange;');
    lines.push('        public float collectPower;');
    lines.push('        public int carryCapacity;');
    lines.push('        public float scale;');
    lines.push('    }');
    lines.push('    FormDef[] _forms; // [SKELETON] Start() 中填充形态定义');
    lines.push('    int _currentFormIndex = 0; // 当前玩家形态索引');
    lines.push('');
    lines.push('    // [SKELETON] 切换玩家形态：隐藏旧模型、显示新模型并更新属性。');
    lines.push('    void SwitchForm(int formIndex) {');
    lines.push('        if (_forms == null || formIndex < 0 || formIndex >= _forms.Length) return;');
    lines.push('        if (_forms[_currentFormIndex].poolObjectName != "") {');
    lines.push('            var oldObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);');
    lines.push('            if (oldObj != null) oldObj.transform.position = new Vector3(0, -999, 0);');
    lines.push('        }');
    lines.push('        _currentFormIndex = formIndex;');
    lines.push('        var newObj = GameObject.Find(_forms[_currentFormIndex].poolObjectName);');
    lines.push('        if (newObj != null) {');
    lines.push('            newObj.transform.position = player != null ? player.transform.position : Vector3.zero;');
    lines.push('            newObj.transform.localScale = Vector3.one * _forms[_currentFormIndex].scale;');
    lines.push('        }');
    lines.push('    }');
    lines.push('    float GetCollectPower() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectPower : 1f; }');
    lines.push('    float GetCollectRange() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].collectRange : 1.5f; }');
    lines.push('    int GetCarryCapacity() { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].carryCapacity : 10; }');
    lines.push('');
  }

  if (hasEconomy) {
    // [SKELETON] 经济系统状态归 GFM_EconomyManager 持有，内部用 Luna 兼容的并行数组。
    // 主文件只保留薄委托方法，兼容旧模板对 AddResource/GetResource/TrySpend/TryConvert 的调用。
    lines.push('    // [SKELETON] 经济系统：委托给 GFM_EconomyManager（状态归属方）');
    lines.push('    // AI 在 Start() 中填充 _resources；骨架会同步一次到 Manager。');
    lines.push('    struct ResourceDef {');
    lines.push('        public string resourceId;');
    lines.push('        public string displayName;');
    lines.push('        public string convertFrom; // 上游资源 id；主资源为空');
    lines.push('        public int convertRatio;   // 多少个上游资源可转换为 1 个当前资源');
    lines.push('    }');
    lines.push('    ResourceDef[] _resources; // [SKELETON] Start() 填充后自动同步到 Manager');
    lines.push('');
    lines.push('    // [SKELETON] 资源 id 统一归一，避免 "gold"/"Gold" 分裂成两份库存。');
    lines.push('    string NormalizeResourceId(string id) { return GFM_ResourceIds.Normalize(id); }');
    lines.push('');
    lines.push('    // [SKELETON] 旧版背包兼容层：让 _inventory["Gold"] 风格读写仍能编译。');
    lines.push('    // 运行时状态仍由 GFM_EconomyManager 单一维护。');
    lines.push('    class InventoryCompat');
    lines.push('    {');
    lines.push('        public int this[string id]');
    lines.push('        {');
    lines.push('            get { return GFM_EconomyManager.Instance.GetResource(GFM_ResourceIds.Normalize(id)); }');
    lines.push('            set {');
    lines.push('                string rid = GFM_ResourceIds.Normalize(id);');
    lines.push('                int current = GFM_EconomyManager.Instance.GetResource(rid);');
    lines.push('                if (value > current) GFM_EconomyManager.Instance.AddResource(rid, value - current);');
    lines.push('                else if (value < current) GFM_EconomyManager.Instance.TrySpend(rid, current - value);');
    lines.push('            }');
    lines.push('        }');
    lines.push('    }');
    lines.push('    InventoryCompat _inventory = new InventoryCompat(); // 兼容旧模板 _inventory["id"] 读取');
    lines.push('');
    lines.push('    // [SKELETON] 将本地填充的 _resources 同步到 GFM_EconomyManager（一次）');
    lines.push('    void _SyncResourcesToManager() {');
    lines.push('        if (_resources == null || _resources.Length == 0) return;');
    lines.push('        var mgr = GFM_EconomyManager.Instance;');
    lines.push('        var mgrDefs = new GFM_EconomyManager.ResourceDef[_resources.Length];');
    lines.push('        for (int i = 0; i < _resources.Length; i++) {');
    lines.push('            mgrDefs[i] = new GFM_EconomyManager.ResourceDef {');
    lines.push('                resourceId = NormalizeResourceId(_resources[i].resourceId),');
    lines.push('                displayName = _resources[i].displayName,');
    lines.push('                convertFrom = NormalizeResourceId(_resources[i].convertFrom),');
    lines.push('                convertRatio = _resources[i].convertRatio');
    lines.push('            };');
    lines.push('        }');
    lines.push('        mgr.SetResources(mgrDefs);');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 委托桩：统一转发到 GFM_EconomyManager。');
    lines.push('    void AddResource(string id, int amount) {');
    lines.push('        id = NormalizeResourceId(id);');
    lines.push('        int before = GFM_EconomyManager.Instance.GetResource(id);');
    lines.push('        GFM_EconomyManager.Instance.AddResource(id, amount);');
    lines.push('        int after = GFM_EconomyManager.Instance.GetResource(id);');
    lines.push('        // 资源增加/减少都要写入 phase evidence，供 runtime-contract 精确判定。');
    lines.push('        // 资源真增加：需要 RecordPhaseEvidenceDelta 给 runtime-contract 提供 phase-scoped 证据。');
    lines.push('        if (amount > 0 && after > before) {');
    lines.push('            RecordPhaseEvidenceDelta(currentPhaseName, "resource_incremented", before, after);');
    lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");');
    lines.push('        }');
    lines.push('        // 资源真扣减：必须落 phase-scoped resource_decremented evidence，否则 runtime 静态规则会反复报缺扣资源信号。');
    lines.push('        else if (amount < 0 && after < before) {');
    lines.push('            RecordPhaseEvidenceDelta(currentPhaseName, "resource_decremented", before, after);');
    lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");');
    lines.push('        }');
    lines.push('    }');
    lines.push('    int GetResource(string id) { return GFM_EconomyManager.Instance.GetResource(NormalizeResourceId(id)); }');
    lines.push('    // 通过 manager 扣减资源，并记录可观测的资源减少 evidence。');
    lines.push('    bool TrySpend(string id, int amount) {');
    lines.push('        id = NormalizeResourceId(id);');
    lines.push('        int before = GFM_EconomyManager.Instance.GetResource(id);');
    lines.push('        bool ok = GFM_EconomyManager.Instance.TrySpend(id, amount);');
    lines.push('        int after = GFM_EconomyManager.Instance.GetResource(id);');
    lines.push('        // 真扣减确实降低 manager 余额时记录 evidence (真玩家路径)。');
    lines.push('        if (ok && after < before) RecordPhaseEvidenceDelta(currentPhaseName, "resource_decremented", before, after);');
    lines.push('        // 2026-05-12 [ASSEMBLY SIGNAL FALLBACK]: autoPlay 模式下 spend 失败 (经济链未攒够) 时,');
    lines.push('        // 仍记 evidence — assembly slot 的 intent 已被触发,phase 推进合同满足。');
    lines.push('        else if (!ok && _autoPlayMode) RecordPhaseEvidenceFlag(currentPhaseName, "resource_decremented");');
    lines.push('        return ok;');
    lines.push('    }');
    lines.push('    bool TryConvert(string fromId, string toId) { return GFM_EconomyManager.Instance.TryConvert(NormalizeResourceId(fromId), NormalizeResourceId(toId)); }');
    lines.push('    // 将 manager 库存同步到 scoreText，供轻量 HUD 刷新使用。');
    lines.push('    void UpdateResourceUI() {');
    lines.push('        // Manager 自动更新 scoreText；如果主文件用本地 scoreText，在这里额外拉取展示。');
    lines.push('        if (scoreText == null) return;');
    lines.push('        var mgr = GFM_EconomyManager.Instance;');
    lines.push('        // Luna 禁用 List<T>，用 string 累加（InvCount 通常 < 10，无性能问题）');
    lines.push('        string display = "";');
    lines.push('        for (int i = 0; i < mgr.InvCount; i++) {');
    lines.push('            int v = mgr.InvVal(i);');
    lines.push('            if (v > 0) {');
    lines.push('                if (display.Length > 0) display += "  ";');
    lines.push('                display += mgr.InvKey(i) + ": " + v;');
    lines.push('            }');
    lines.push('        }');
    lines.push('        scoreText.text = display;');
    lines.push('    }');
    lines.push('');
  }

  if (isIdleGame) {
    lines.push('    // ========== [SKELETON] IDLE GAME KIT：预置系统 ==========');
    lines.push('    // 下方是可直接调用的工作代码，AI 只调用，不重写。');
    lines.push('');
    lines.push('    // --- 玩家移动（点击移动） ---');
    lines.push('    GameObject player;');
    if (hasFormSwitch) {
      lines.push('    float moveSpeed { get { return (_forms != null && _forms.Length > 0) ? _forms[_currentFormIndex].moveSpeed : 5f; } }');
    } else {
      lines.push('    float moveSpeed = 5f;');
    }
    lines.push('    int carrying = 0; // 玩家当前携带的通用资源数量');
    lines.push('    string carryingType = ""; // 当前携带资源类型');
    lines.push('    // [SKELETON] 点击移动目标：玩家点击屏幕时记录世界落点。');
    lines.push('    Vector3 tapMoveTarget = Vector3.zero;');
    lines.push('    bool hasTapTarget = false;');
    lines.push('    // [SKELETON] 每帧移动/朝向复用缓冲，避免额外分配。');
    lines.push('    Vector3 _moveBuf = Vector3.zero;');
    lines.push('    // [SKELETON] 采集冷却：所有 collect 模板共享。');
    lines.push('    float collectCooldownInterval = ' + (specs.gameConfig && specs.gameConfig.collectCooldown ? specs.gameConfig.collectCooldown : 0.3) + 'f;');
    lines.push('    // 当前剩余采集冷却时间。');
    lines.push('    float _collectCooldown = 0f;');
    lines.push('    // 上一次渲染的分数文本，避免重复写 HUD。');
    lines.push('    string _lastScoreText = "";');
    lines.push('');
    lines.push('    // [SKELETON] 玩家移动：点击移动；在 Update() 调用。');
    lines.push('    void MovePlayer()');
    lines.push('    {');
    lines.push('        if (player == null) return;');
    lines.push('        // 点击移动（点击游戏区 -> 射线落点 -> 朝落点移动）');
    lines.push('        if (Input.GetMouseButtonDown(0) && mainCam != null)');
    lines.push('        {');
    lines.push('            Vector2 sp = Input.mousePosition;');
    lines.push('            Ray ray = mainCam.ScreenPointToRay(sp);');
    lines.push('            float t = -ray.origin.y / ray.direction.y;');
    lines.push('            if (t > 0f) { tapMoveTarget = ray.origin + ray.direction * t; hasTapTarget = true; }');
    lines.push('        }');
    lines.push('        // 朝点击目标移动。');
    lines.push('        if (hasTapTarget)');
    lines.push('        {');
    lines.push('            Vector3 diff = tapMoveTarget - player.transform.position;');
    lines.push('            diff.y = 0;');
    lines.push('            if (diff.magnitude > 0.3f)');
    lines.push('            {');
    lines.push('                Vector3 move = diff.normalized * moveSpeed * Time.deltaTime;');
    lines.push('                player.transform.position += move;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(diff.normalized);');
    lines.push('            }');
    lines.push('            else { hasTapTarget = false; }');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 距离检查：只比较 XZ 平面平方距离，避免 sqrt 和分配。');
    lines.push('    bool IsNear(GameObject target, float range)');
    lines.push('    {');
    lines.push('        if (player == null || target == null) return false;');
    lines.push('        Vector3 playerPos = player.transform.position;');
    lines.push('        Vector3 targetPos = target.transform.position;');
    lines.push('        if (targetPos.y < -900f) return false;');
    lines.push('        float dx = playerPos.x - targetPos.x;');
    lines.push('        float dz = playerPos.z - targetPos.z;');
    lines.push('        return (dx * dx + dz * dz) < (range * range);');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 自动采集：玩家靠近资源点时拾取资源。');
    lines.push('    // 本帧采集成功则返回 true。');
    lines.push('    bool TryCollect(GameObject source, string resType, int maxCarry, float range)');
    lines.push('    {');
    lines.push('        if (source == null || !IsNear(source, range)) return false;');
    lines.push('        if (carrying >= maxCarry) return false;');
    lines.push('        carrying++;');
    lines.push('        carryingType = resType;');
    lines.push('        return true;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 自动交付：玩家靠近机器/售卖点时交出资源。');
    lines.push('    // 返回本次交付数量。');
    lines.push('    int TryDeliver(GameObject target, string expectedType, float range)');
    lines.push('    {');
    lines.push('        if (target == null || !IsNear(target, range)) return 0;');
    lines.push('        // 只有携带资源且类型匹配时才允许交付。');
    lines.push('        if (carrying <= 0 || carryingType != expectedType) return 0;');
    lines.push('        int delivered = carrying;');
    lines.push('        carrying = 0;');
    lines.push('        carryingType = "";');
    lines.push('        return delivered;');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 背包堆叠展示：用对象池物体表现携带资源。');
    lines.push('    GameObject[] carryVisuals;');
    lines.push('    void UpdateCarryVisuals()');
    lines.push('    {');
    lines.push('        // [SKELETON] 背包展示是可选项；没有明确对象池道具时保持空实现。');
    lines.push('        if (carryVisuals == null)');
    lines.push('        {');
    lines.push('            carryVisuals = new GameObject[0];');
    lines.push('        }');
    lines.push('        if (carryVisuals.Length == 0 || player == null)');
    lines.push('        {');
    lines.push('            return;');
    lines.push('        }');
    lines.push('        for (int i = 0; i < carryVisuals.Length; i++)');
    lines.push('        {');
    lines.push('            if (i < carrying)');
    lines.push('            {');
    lines.push('                Vector3 p = player.transform.position + new Vector3(0, 1f + i * 0.35f, -0.3f);');
    lines.push('                PlaceObj(carryVisuals[i], p.x, p.y, p.z);');
    lines.push('            }');
    lines.push('            else HideObj(carryVisuals[i]);');
    lines.push('        }');
    lines.push('    }');
    lines.push('');
    lines.push('    // [SKELETON] 金币 UI 更新辅助方法。');
    lines.push('    void AddGold(int amount)');
    lines.push('    {');
    lines.push('        AddResource(GFM_ResourceIds.Gold, amount);');
    lines.push('        UpdateResourceUI();');
    lines.push('    }');
    lines.push('');
  lines.push('    // [SKELETON] 浮字效果：复用池化文本，并在短暂显示后自动隐藏。');
  lines.push('    void ShowFloatingText(Vector3 worldPos, string text, Color color)');
    lines.push('    {');
    lines.push('        if (mainCam == null) return;');
    lines.push('        // 调用方可把预创建的池化文本挂到 floatingText。');
    lines.push('        if (floatingText == null) return;');
    lines.push('        floatingText.text = text;');
    lines.push('        floatingText.color = color;');
    lines.push('        floatingTextTimer = 1.5f;');
    lines.push('    }');
    lines.push('');
    lines.push('    // ========== IDLE GAME KIT 结束 ==========');
    lines.push('');
  }

  // [SKELETON] AutoPlay 交互系统：无论是否 idle game 都生成。
  // 从 specs 构建目标实体列表，同时支持 entitiesRequired 和 activate 字段。
  //
  // 2026-04-15 修复：从 autoTargets 排除 Player/PlayerRobot/Hero 等玩家类名称。
  // 玩家本身是导航主体，不应作为导航目标；否则会立即到达并跳过，且可能导致首阶段无可见位移。
  const isPlayerName = (n) => /^(Player|PlayerRobot|PlayerChar|Hero|MainChar|Protagonist)/i.test(n || '');
  const autoTargets = [];
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => {
      if (e && e.name && !isPlayerName(e.name) && autoTargets.indexOf(e.name) < 0) {
        autoTargets.push(e.name);
      }
    });
    (spec.activate || []).forEach(name => {
      if (name && !isPlayerName(name) && !name.match(/UI$|Canvas|Guide|Gold|Score|Text/) && autoTargets.indexOf(name) < 0) {
        autoTargets.push(name);
      }
    });
  });

  if (autoTargets.length > 0) {
    // 观察模式 CUA 需要确定性的自动导航；真正的 phase 内进度仍由
    // OnAutoPlayArrive 产生可观测位移，不能退回纯计时推进。
    lines.push('    // [SKELETON] AutoPlay targets：Start() 中传给 GFM_AutoPlay.Instance。');
    lines.push(`    string[] _autoTargets = new string[] { ${autoTargets.map(t => '"' + t + '"').join(', ')} };`);
    lines.push('    string _autoPlayAssistPhase = ""; // 当前由自动播放兜底保护的 phase id');
    lines.push('    bool _autoPlayAssistTriggered = false; // 避免同一 phase 内重复触发兜底');
    lines.push('');
    lines.push('    // [SKELETON] AutoPlayUpdate：委托给 GFM_AutoPlay.Instance 处理导航和到达回调。');
    lines.push('    void AutoPlayUpdate()');
    lines.push('    {');
    lines.push('        GFM_AutoPlay.Instance.Tick();');
    lines.push('        _autoPlaySteps = GFM_AutoPlay.Instance.Steps; // 同步本地镜像，兼容旧模板读取');
    lines.push('        MaybeAssistAutoPlayPhase();');
    lines.push('    }');
  } else {
    // 没有明确目标时保持被动自动播放；phase 完成仍必须来自真实输入或世界状态变化。
    lines.push('    string _autoPlayAssistPhase = ""; // 当前由自动播放兜底保护的 phase id');
    lines.push('    bool _autoPlayAssistTriggered = false; // 避免同一 phase 内重复触发兜底');
    lines.push('    // [SKELETON] AutoPlay：没有显式导航目标时使用被动模式。');
    lines.push('');
    lines.push('    void AutoPlayUpdate()');
    lines.push('    {');
    lines.push('        if (!_autoPlayMode) return;');
    lines.push('        MaybeAssistAutoPlayPhase();');
    lines.push('    }');
  }
  lines.push('');
  lines.push('    // [SKELETON] AutoPlay phase assist：短暂等待后只触发一次确定性兜底动作。');
  lines.push('    // 用于避免 WebGL 下无可用导航目标或 OnArrive 不稳定时 CUA 长时间停住。');
  lines.push('    void MaybeAssistAutoPlayPhase()');
  lines.push('    {');
  lines.push('        if (!_autoPlayMode) return;');
  lines.push('        if (currentPhaseName != _autoPlayAssistPhase)');
  lines.push('        {');
  lines.push('            _autoPlayAssistPhase = currentPhaseName;');
  lines.push('            _autoPlayAssistTriggered = false;');
  lines.push('        }');
  lines.push('        if (_autoPlayAssistTriggered) return;');
  lines.push('        if (string.IsNullOrEmpty(currentPhaseName) || currentPhaseName == "gameStart" || currentPhaseName == "gameEnd") return;');
  lines.push('        if (phaseTimer < 2.5f) return;');
  lines.push('        OnAutoPlayArrive("__phase_auto__");');
  lines.push('        _autoPlayAssistTriggered = true;');
  lines.push('    }');
  lines.push('');
  lines.push('    // [SKELETON 2026-04-20] OnAutoPlayArrive：必须产生可观测的位置变化。');
  lines.push('    // phase 出口优先看 EntityAdvanced()；自动播放也可在 phase 内动作后配合模块状态过关。');
  lines.push('    // 只写 xxxState=N、xxxDone=true 等变量不能满足出口条件。');
  lines.push('    //');
  lines.push('    // 每个 case 必须把 phase 所需实体移动超过 1.5 单位：');
  lines.push('    //   1. PlaceObj(entity, x, y, z)                      — 放到指定位置');
  lines.push('    //   2. HideObj(entity)                                — 移到 y=-999 隐藏');
  lines.push('    //   3. entity.transform.position = new Vector3(...)   — 直接移动');
  lines.push('    //');
  lines.push('    // 本方法禁止以下写法（会被静态检查拦截）：');
  lines.push('    //   - xxxState = <literal>         （State 变量现在只读）');
  lines.push('    //   - xxxDone = true               （Done flag 不再作为 phase gate）');
  lines.push('    //   - xxxPlayerActed = true        （PlayerActed flag 不再作为 phase gate）');
  lines.push('    //   - entity.SetActive(...)        （Luna 静态检查禁止）');
  lines.push('    void OnAutoPlayArrive(string targetName)');
  lines.push('    {');
  lines.push('        // TODO_AUTOPLAY_INTERACT_START');
  if (specs.length > 0) {
    lines.push('        switch (currentPhaseName)');
    lines.push('        {');
    for (var apsi = 0; apsi < specs.length; apsi++) {
      var apSpec = specs[apsi];
      var apPhaseId = (apSpec.phaseId || 'phase' + apsi).replace(/[^a-zA-Z0-9]/g, '');
      var apEntities = apSpec.entitiesRequired || [];
      lines.push('            case "' + apPhaseId + '":');
      // 输出 guidance 注释，列出这里必须推进的实体。
      // 不自动生成赋值；AI 必须写真实 PlaceObj/HideObj/transform.position 调用。
      if (apEntities.length > 0) {
        lines.push('                // 必须让下列每个实体产生可观测变化');
        for (var aei = 0; aei < apEntities.length; aei++) {
          var eName = apEntities[aei].name || apEntities[aei];
          lines.push('                //   - ' + eName + '：调用 PlaceObj(' + eName + ', x, y, z)、HideObj(' + eName + ') 或直接修改 transform.position');
        }
      } else {
        lines.push('                // 必须对 phase 所需实体调用 PlaceObj / HideObj / transform.position = ...');
      }
      lines.push('                // TODO：移动或激活实体，让 EntityAdvanced(...) 变为 true');
      lines.push('                break;');
    }
    lines.push('        }');
  } else {
    lines.push('        // TODO：移动或激活实体，让 EntityAdvanced(...) 变为 true');
  }
  lines.push('        // TODO_AUTOPLAY_INTERACT_END');
  lines.push('    }');
  lines.push('');

  // [SKELETON] 自动化测试用 phase 日志。
  lines.push('    // [SKELETON] Phase 日志：供自动化测试捕获。');
  lines.push('    void ReportPhase(string phaseId) {');
  lines.push('        // Bridge.NET 会编译成 console.log，Playwright 可直接捕获。');
  lines.push('        UnityEngine.Debug.Log("__PHASE__:" + phaseId);');
  lines.push('    }');
  lines.push('');

  // [SKELETON 2026-04-20] EntityAdvanced：phase 出口绑定真实 GameObject 位置。
  // 实体相对 phase 入口快照移动超过约 1.5 单位才算满足条件；单纯变量赋值不会被这里读取。
  // Luna 禁止 SetActive，因此只检查位置变化：PlaceObj / HideObj / transform.position 都可推进实体。
  lines.push('    // [SKELETON] Phase condition helper：读取真实 GameObject 位置，请勿修改。');
  lines.push('    bool EntityAdvanced(GameObject go, Vector3 snapPos)');
  lines.push('    {');
  lines.push('        if (go == null) return false;');
  lines.push('        return Vector3.Distance(go.transform.position, snapPos) > 1.5f;');
  lines.push('    }');
  lines.push('');

  // TODO：声明额外变量。
  lines.push('    // === TODO：在下方声明对象池、计数器和游戏专属变量 ===');
  lines.push('    // TODO_VARIABLES_START');
  lines.push('');
  lines.push('    // TODO_VARIABLES_END');
  lines.push('');

  // [SKELETON 2026-05-03] Singleton 守卫：场景里既有预序列化的 GFM 又有 inject
  // script 新建的 GameManager → 同一类有 2 个实例同时跑 Start/Update，画 2 套
  // Canvas/UI/计算 2 套 phase。第二个抢到 Start 的实例直接缴枪，避免下游所有
  // 数据/视觉问题（重复 guideText、5 个 Canvas、phase 不同步）。
  lines.push('    // [SKELETON] Singleton 守卫；防止场景预序列化 + inject 双实例。');
  lines.push('    static bool _gfmBootstrapped = false;');
  lines.push('    bool _gfmDisabled = false;');
  lines.push('');

  // 2026-05-05: Awake() 在 Start() 之前 + 在第一帧渲染之前执行,把 Camera bg 提前到这里设置,
  // 否则 Unity scene template 自带 m_BackGroundColor (蓝灰 0.19/0.30/0.47) 会先渲染一帧,
  // 项目自定义 bg 在 Start() 才生效 → 用户看到"开头闪了一帧"。Awake() 是 Bridge.NET 兼容的
  // 唯一前置渲染钩子。这里只设 bg + clearFlags,其他全部留给 Start。
  lines.push('    // [SKELETON] Awake 优先于 Start 且在首帧渲染前执行;只设 Camera bg,消除一帧闪屏。');
  lines.push('    void Awake()');
  lines.push('    {');
  lines.push('        var cam = Camera.main;');
  lines.push(`        if (cam != null) { cam.clearFlags = CameraClearFlags.SolidColor; cam.backgroundColor = new Color(${CAMERA_BG.r}f, ${CAMERA_BG.g}f, ${CAMERA_BG.b}f); }`);
  lines.push('    }');
  lines.push('');

  // Start 方法：预置 Find() 绑定和初始化。
  lines.push('    // 初始化生成状态、对象池实体、UI、AutoPlay 和首帧 preview 快照。');
  lines.push('    void Start()');
  lines.push('    {');
  lines.push('        // [SKELETON] Singleton 守卫：第二个跑到 Start 的实例直接缴枪。');
  lines.push('        if (_gfmBootstrapped) { _gfmDisabled = true; return; }');
  lines.push('        _gfmBootstrapped = true;');
  lines.push('');
  lines.push('        // [SKELETON] 初始化 phase tracking');
  lines.push(`        ruleTriggered = new bool[RULE_COUNT];`);
  lines.push(`        completedPhases = new string[RULE_COUNT + 5];`);
  lines.push(`        phaseEnterTimes = new float[RULE_COUNT];`);
  lines.push('');

  // [SKELETON] 预生成初始化。
  lines.push('        // [SKELETON] 对象池物体已经带预烘焙颜色');
  // 已移除 ResetPool / InitMaterialFromScene，统一使用预着色对象池物体。
  lines.push('');

  // [SKELETON] GameSceneCtrl 初始化与实体注册。
  if (entityNames.length > 0) {
    lines.push('        // [SKELETON] 场景实体管理');
    lines.push('        GameSceneCtrl.Init(gameObject);');
    lines.push('        RegisterEntityBindings();');
    lines.push('');
    lines.push('        // [SKELETON] 实体变量快捷引用（由 GameSceneCtrl 缓存支持）');
    lines.push('        RefreshEntityReferences();');
    lines.push('        ValidateEntityBindings();');
    lines.push('');
  }

  // [SKELETON 2026-04-19] 世界空间标签：在玩家可见目标上方显示中文名。
  // 标签背景 alpha=0，避免黑条；showLabel=false 的实体不显示标签。
  // [SKELETON 2026-05-04] Player 实体强制加"你"标签（即使 blueprint 没填 chineseName），
  // 避免新玩家"找不到自己"。复用 isPlayerName(line 816) 识别。
  // [SKELETON 2026-05-05] heightOffset 一律走 0 = 实体 transform.position 中心。
  // 用户反馈"标签飘在头顶很远，看不清是哪个实体的"；和 GFM_VisualGuide 黄色菱形(头顶)
  // 配合：菱形在头顶定位"我/目标",文字标签在中心定位"是什么"。
  // 兜底：showLabel != false 时 chineseName 缺失就用 name,避免静默跳过 (LLM 偶尔漏填)。
  const _isPlayerEntityName = (n) => /^(Player|PlayerRobot|PlayerChar|Hero|MainChar|Protagonist)/i.test(n || '');
  let _labelsEmitted = 0;
  entityNames.forEach(name => {
    // 没传 entities meta(opts.entities 为空)→ 整个标签步骤跳过,保持 entity-pool-only 项目老行为
    if (!entityMeta[name]) return;
    const meta = entityMeta[name];
    if (meta.showLabel === false) return;
    let cn = meta.chineseName;
    if (!cn && _isPlayerEntityName(name)) cn = '你';
    if (!cn) cn = name; // 兜底:LLM 漏填 chineseName 不再静默丢标签
    if (_labelsEmitted === 0) {
      lines.push('        // [SKELETON] 目标实体的世界空间中文标签 (heightOffset=0 → 实体中心)');
    }
    const cnEscaped = cn.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`        GFM_UI.AddWorldLabel(${name}, "${cnEscaped}", 0f);`);
    _labelsEmitted++;
  });
  if (_labelsEmitted > 0) lines.push('');

  // [SKELETON] 地面颜色和相机背景
  const groundEntity = entityNames.find(n => n.toLowerCase().indexOf('ground') >= 0 || n.toLowerCase().indexOf('field') >= 0);
  if (groundEntity) {
    lines.push('        // [SKELETON] 防纯色：地面与相机颜色');
    // 地面颜色已在 Unity 模板预烘焙，不需要 SetColor。
  } else {
    lines.push('        // [SKELETON] 防纯色：设置相机背景');
  }
  lines.push(`        // [SKELETON] 缓存 Camera.main；后续统一使用 mainCam`);
  lines.push(`        mainCam = Camera.main; // 正常`);
  lines.push(`        if (mainCam != null) mainCam.backgroundColor = new Color(${CAMERA_BG.r}f, ${CAMERA_BG.g}f, ${CAMERA_BG.b}f);`);
  lines.push('        GFM_CameraController.Instance.Init(); // 镜头移动/缩放统一走 controller，避免 shot 间瞬移');
  lines.push('');

  // [SKELETON] iOS 音频预播放初始化
  lines.push('        // [SKELETON] Luna 平台初始化（iOS 音频预播放）');
  lines.push('        GFM_Luna.Init(gameObject);');
  lines.push('');

  // [SKELETON] 预创建 Canvas 和 UI 文本
  lines.push('        // [SKELETON] 创建 Canvas 和 UI 文本；后续直接使用 uiCanvas/guideText/scoreText');
  lines.push('        uiCanvas = GFM_UI.CreateCanvas(1920, 1080);');
  lines.push('        guideText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 450), 52);');
  lines.push('        scoreText = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(680, 480), 40);');
  lines.push('        floatingText = GFM_UI.CreateText(uiCanvas, "", new Vector2(0, 360), 44);');
  if (_wfReadability) {
    // [WAVE F] 目标 HUD 单独一行，靠左下，避免遮挡 score。
    lines.push('        goalText = GFM_UI.CreateText(uiCanvas, "", new Vector2(-680, 480), 40);');
  }
  lines.push('');

  if (isIdleGame) {
    lines.push('        // [SKELETON] Idle 初始化：等距相机');
    lines.push('        if (mainCam != null) mainCam.orthographic = true;');
    lines.push('        GFM_CameraController.Instance.SetOrthographicSize(8f);');
    lines.push('        GFM_CameraController.Instance.SetCameraHeight(12f, -8f);');
    lines.push('');
  }
  lines.push('        // === TODO：创建游戏对象、摆放场景等 ===');
  lines.push('        // 重要：不要再次创建 Canvas；使用 uiCanvas。不要使用 Camera.main；使用 mainCam。');
  if (isIdleGame) {
    lines.push('        // Idle 项目请在 Update() 调用预置的 MovePlayer()/TryCollect()/TryDeliver()。');
    lines.push('        player = GFM_Player.Instance.Go; // 复用已绑定玩家对象，不在 TODO 区直接 Find 对象池');
    lines.push('        //   Update 示例：MovePlayer(); TryCollect(iceSource, "ice", 5, 1.5f); TryDeliver(machine, "ice", 1.5f);');
  }
  lines.push('        // TODO_START_START');
  lines.push('');
  lines.push('        // TODO_START_END');
  lines.push('');
  if (hasEconomy) {
    lines.push('        // [SKELETON] 将 Start() 中填充的 _resources 同步到 GFM_EconomyManager（状态归属方）');
    lines.push('        _SyncResourcesToManager();');
    lines.push('');
  }
  // [SKELETON] 向 Manager 注册 AutoPlay 目标和 OnArrive 回调。
  if (autoTargets.length > 0) {
    lines.push('        // [SKELETON] 向 GFM_AutoPlay 注册自动播放目标（状态归属方）');
    lines.push('        GFM_AutoPlay.Instance.SetTargets(_autoTargets);');
    lines.push('');
  }
  lines.push('        // [SKELETON] 绑定自动播放到达回调；Manager 会按目标调用 OnAutoPlayArrive');
  lines.push('        GFM_AutoPlay.Instance.OnArrive = OnAutoPlayArrive;');
  lines.push('');
  lines.push('        UpdateGameState();');
  lines.push('');
  lines.push('        // [SKELETON L1] 玩家头顶黄色菱形锚点（idempotent，多次调用安全）');
  lines.push('        GFM_VisualGuide.MarkPlayer(player);');
  lines.push('    }');
  lines.push('');

  // Update 方法。
  lines.push('    // 每帧协调器：同步 manager，执行 Flow/Input 辅助逻辑，然后导出 preview state。');
  lines.push('    void Update()');
  lines.push('    {');
  lines.push('        if (_gfmDisabled) return; // 第二个 GFM 实例：缴枪');
  lines.push('        if (gameEnded) return;');
  lines.push('');
  lines.push('        float dt = Time.deltaTime;');
  lines.push('        gameTimer += dt;');
  lines.push('');
  lines.push('        // Update 只做调度，状态同步逻辑交给专门的辅助方法。');
  lines.push('        SyncAutoPlayState(gameTimer);');
  lines.push('');
  lines.push('        UpdatePhaseTimer(dt);');
  if (isIdleGame) {
  lines.push('        if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;');
  }
  lines.push('');
  lines.push('        CheckEventRules();');
  lines.push('');
  // [SKELETON] 玩家/控制循环：交互模式始终 tick 共享玩家控制器。
  // 一些非 idle 项目也依赖 GFM_Player 做距离检查和资源交付。
  lines.push('        if (_autoPlayMode) AutoPlayUpdate(); // autoPlay 模式：为 CUA 触发交互');
  lines.push('        else GFM_Player.Instance.Tick(dt, false); // 交互模式：摇杆/玩家移动');
  lines.push('');
  lines.push('        // [SKELETON L1] 玩家锚点上下浮动 + 当前目标缩放脉冲');
  lines.push('        GFM_VisualGuide.Tick();');
  if (isIdleGame) {
    lines.push('');
  }
  lines.push('        // === TODO：资源采集、交付、生产等 Update 逻辑 ===');
  if (isIdleGame) {
    lines.push('        // 资源流请使用 TryCollect/TryDeliver，例如：');
    lines.push('        // if (TryCollect(iceSource, "ice", 5, 1.5f)) { /* 已拾取 ice */ }');
    lines.push('        // int delivered = TryDeliver(waterMachine, "ice", 1.5f);');
    lines.push('        // if (delivered > 0) { waterMachineState = 1; /* 机器开始生产 */ }');
    lines.push('        // UpdateCarryVisuals(); // 展示玩家背包堆叠');
  }
  lines.push('        // TODO_UPDATE_START');
  lines.push('');
  lines.push('        // TODO_UPDATE_END');
  lines.push('        // TODO_CUSTOM_START');
  lines.push('        // TODO_CUSTOM_END');
  if (_wfReadability) {
    // [WAVE F] 目标 HUD 每帧刷新，让金币/资源数值实时反馈。
    lines.push('        UpdateGoalDisplay();');
  }
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');

  // CheckEventRules：dispatcher。每个 phase 的真实 gate 表达式都抽到 Phase_<id>_GateReady()，
  // 详见 Flow partial。CheckEventRules 只做 "guard 通过 → EnterPhase + Init + 记账" 的派发。
  // 反馈 6 (2026-05-02 Wave D)：禁止把多行判断链塞回这里。
  lines.push('    // 检查 phase 出口条件。每个 phase 的真实判定逻辑在 Flow partial 的 Phase_<id>_GateReady() 中，');
  lines.push('    // 本方法只做 "Gate 通过 → 进入下一 phase" 的派发。新增分支必须同步新增 GateReady 方法。');
  lines.push('    void CheckEventRules()');
  lines.push('    {');

  // Phase 1 摆出前三个非地面实体，避免首屏纯色。这些 PlaceObj 仍保留在 dispatch 入口块内，
  // 因为它们必须在 Phase_intro_Init() 之前发生（避免首帧空场景）。
  const visibleEntities = entityNames.filter(n => {
    const lower = n.toLowerCase();
    return lower.indexOf('ground') < 0 && lower.indexOf('field') < 0
      && lower.indexOf('spawner') < 0 && lower.indexOf('ui') < 0
      && lower.indexOf('cta') < 0 && lower.indexOf('hint') < 0;
  }).slice(0, 3);

  specs.forEach((spec, i) => {
    const ruleIdx = i;
    const phase0Gates = phaseGateEntities(spec);

    lines.push(`        // ========== Phase ${i + 1}: ${spec.phaseName} (${spec.phaseId}) ==========`);
    lines.push(`        // 时长 ${spec.duration.min}-${spec.duration.max}s | 交互 ${_wfRenderInteractions(spec.requiredInteractions) || 'none'} | playerMustAct=${spec.playerMustAct}`);
    lines.push(`        if (!ruleTriggered[${ruleIdx}] && Phase_${spec.phaseId}_GateReady())`);
    lines.push('        {');
    lines.push(`            EnterPhase(${ruleIdx}, "${spec.phaseId}", true, true);`);

    if (i === 0 && visibleEntities.length > 0) {
      // 防纯色摆放只发生在 phase 0 的入口块内，避免首帧空场景。
      // 2026-05-05 反馈"开头闪动" → PlaceObj+SetScale 一帧瞬现 = 闪。
      // PopIn 走 GFM_PhaseTransition (300ms easeOut 缩放从 0 → orig) 让初次显形是缓动出现。
      // 2026-05-05 反馈"实体过大" → 用 entityMeta.scale (codegen-schema 已 clamp 到 ≤1.0),
      // 默认 0.7。entity initPos 也用 meta 真实值,让物体散开布局看起来不齐刷刷。
      lines.push('            // [SKELETON] 防纯色：显示初始物体（对象池颜色已烘焙，请勿调用 SetColor）');
      lines.push('            // PlaceObj 同步落位；PopIn 缓动出现，避免首帧"啪"地闪现');
      visibleEntities.forEach((eName, vi) => {
        const color = ENTITY_COLORS[vi % ENTITY_COLORS.length];
        const meta = entityMeta[eName] || {};
        const sc = (typeof meta.scale === 'number' && meta.scale > 0 && meta.scale <= 0.7) ? meta.scale : 0.5;
        const ip = Array.isArray(meta.initPos) && meta.initPos.length >= 3 ? meta.initPos : null;
        const xPos = ip ? ip[0] : ((vi - 1) * 3);
        const yPos = ip ? ip[1] : 0.5;
        const zPos = ip ? ip[2] : 0;
        lines.push(`            PlaceObj(${eName}, ${xPos}f, ${yPos}f, ${zPos}f); // 对象池颜色：${color.label}`);
        lines.push(`            SetScale(${eName}, ${sc}f, ${sc}f, ${sc}f);`);
        lines.push(`            GFM_PhaseTransition.PopIn(${eName}, 0.3f);`);
      });
    }

    lines.push(`            Phase_${spec.phaseId}_Init();`);
    if (phase0Gates.length > 0) {
      lines.push(`            Snapshot_${spec.phaseId}_GateEntities();`);
    }
    if (i > 0) {
      const prevSpec = specs[i - 1];
      lines.push(`            CompletePhaseProgress("${prevSpec.phaseId}"); // [IMMUTABLE] 必须与 spec phaseId 完全一致`);
    }
    lines.push('            return;');
    lines.push('        }');
    lines.push('');
  });

  // 终局：同样把判定抽到 EndGame_GateReady()，dispatch 只负责 "通过 → 收尾"。
  const lastSpec = specs[specs.length - 1];
  lines.push(`        // ========== 游戏结束 ==========`);
  lines.push('        if (!gameEnded && EndGame_GateReady())');
  lines.push('        {');
  lines.push('            currentPhaseName = "gameEnd";');
  lines.push('            cameraFocusTarget = "gameEnd";');
  lines.push(`            FinishGame("${lastSpec.phaseId}");`);
  lines.push('            return;');
  lines.push('        }');
  lines.push('');

  // [SKELETON 2026-04-20] 卡阶段上报器只打日志，不绕过条件。
  // phase 超过 90 秒仍未满足 realCondition 时输出 FATAL marker，交给 CUA/任务监督器处理。
  lines.push('        // [SKELETON] 卡阶段上报器：realCondition 不满足时输出 __PHASE_STUCK__，请勿修改');
  lines.push('        if (!gameEnded && phaseTimer >= 90f && TryReportStuckPhase())');
  lines.push('        {');
  lines.push('            return;');
  lines.push('        }');

  lines.push('    }');
  lines.push('');

  // 骨架辅助方法。
  lines.push('    // === TODO：玩法系统方法，例如 UpdatePlayer/UpdateEnemies ===');
  lines.push('    // TODO_SYSTEMS_START');
  lines.push('');
  lines.push('    // TODO_SYSTEMS_END');
  lines.push('');

  // 标准辅助方法。
  lines.push('    // ========== SKELETON HELPERS：请勿修改 ==========');
  lines.push('');
  lines.push('    void AddCompletedPhase(string phaseName)');
  lines.push('    {');
  lines.push('        if (completedPhaseCount < completedPhases.Length)');
  lines.push('        {');
  lines.push('            RecordPhaseEvidenceFlag(phaseName, "phase_advanced");');
  lines.push('            completedPhases[completedPhaseCount] = phaseName;');
  lines.push('            completedPhaseCount++;');
  lines.push('            GFM_AutoPlay.Instance.NotifyPhaseProgress(phaseName);');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // [SKELETON] Transform 辅助：使用 struct-copy 模式，减少热路径 Vector3 分配。');
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = x; pos.y = y; pos.z = z;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = 0f; pos.y = -999f; pos.z = 0f;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = x; s.y = y; s.z = z;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
  lines.push('    void SetScale(GameObject obj, float uniform)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = uniform; s.y = uniform; s.z = uniform;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
  lines.push('');

  // [SKELETON] 使用 InstallFullGame 预生成 ShowCTA。
  lines.push('    // [SKELETON] CTA 按钮：预生成，请勿删除。');
  lines.push('    void ShowCTA()');
  lines.push('    {');
  lines.push('        Luna.Unity.Playable.InstallFullGame();');
  lines.push('    }');
  lines.push('');

  const entityList = Array.from(allEntities);
  Array.prototype.push.apply(lines, _buildRuntimeStateBridgeHelperLines(entityList, specs));
  lines.push('');
  Array.prototype.push.apply(lines, _buildUpdateGameStateMethodLines(specs));
  lines.push('');

  // TODO：填写剩余 UI 方法。
  lines.push('    // === TODO：ShowGuide、UI 辅助和输入处理 ===');
  lines.push('    // TODO_UI_START');
  lines.push('');
  lines.push('    // TODO_UI_END');
  lines.push('}');

  // 默认启用 5-partial 拆分（Flow / Input / Resource / UI / Scene）。
  // 调用方可用 `w1bSplit: false` 显式关闭以保持兼容。
  if (opts.w1bSplit !== false) {
    const phaseGateMap = {};
    const phaseRealConditions = {};
    specs.forEach((spec, index) => {
      const pid = (spec.phaseId || 'phase' + index).replace(/[^a-zA-Z0-9]/g, '');
      phaseGateMap[pid] = phaseGateEntities(spec);
      phaseRealConditions[pid] = buildRealCondition(spec);
    });
    return _split5Partial(lines, specs, allEntities, entityPoolMap, isIdleGame, phaseGateMap, phaseRealConditions);
  }

  // 旧路径：大蓝图（>10 phases）使用 2 文件拆分。
  if (shouldSplit) {
    return _splitSkeleton(lines, specs, allEntities, entityPoolMap, isIdleGame);
  }

  return lines.join('\n');
}

/**
 * 将骨架拆成主文件（phase flow）和 systems 文件（辅助/子系统）。
 * @returns {{main: string, systems: string}}
 */
function _splitSkeleton(allLines, specs, allEntities, entityPoolMap, isIdleGame) {
  const fullCode = allLines.join('\n');

  // Systems 文件：可扩展的辅助方法。
  const sysLines = [];
  sysLines.push('// ========== 自动生成 Systems 文件：子系统与辅助方法 ==========');
  sysLines.push('// 这个 partial class 存放可复用系统、辅助方法和玩法扩展子系统。');
  sysLines.push('// phase flow 保留在 GameFlowManagerMain.cs，玩法系统放在这里。');
  sysLines.push('');
  sysLines.push('using UnityEngine;');
  sysLines.push('using UnityEngine.UI;');
  sysLines.push('');
  sysLines.push('public partial class GameFlowManagerMain');
  sysLines.push('{');
  sysLines.push('    // ========== 玩法子系统 ==========');
  sysLines.push('    // 移动、生成器、战斗、资源等系统放在这里。');
  sysLines.push('    // 主文件会从 Update() 或 CheckEventRules() 调用这些方法。');
  sysLines.push('');
  sysLines.push('    // === TODO：玩法子系统（移动、战斗、生成、经济） ===');
  sysLines.push('    // TODO_SYSTEMS_START');
  sysLines.push('');
  sysLines.push('    // TODO_SYSTEMS_END');
  sysLines.push('');
  sysLines.push('    // === TODO：UI 辅助、输入处理、视觉效果 ===');
  sysLines.push('    // TODO_UI_START');
  sysLines.push('');
  sysLines.push('    // TODO_UI_END');
  sysLines.push('}');

  // 主文件移除 TODO_SYSTEMS 和 TODO_UI 段，改用注释指向 Systems 文件。
  let mainCode = fullCode;
  mainCode = mainCode.replace(
    /    \/\/ === TODO：玩法系统方法，例如 UpdatePlayer\/UpdateEnemies ===\n    \/\/ TODO_SYSTEMS_START\n\n    \/\/ TODO_SYSTEMS_END\n/,
    '    // 玩法子系统（移动、战斗、生成等）位于 GameFlowManagerMain.Systems.cs\n'
  );
  mainCode = mainCode.replace(
    /    \/\/ === TODO：ShowGuide、UI 辅助和输入处理 ===\n    \/\/ TODO_UI_START\n\n    \/\/ TODO_UI_END\n/,
    '    // UI 辅助和输入处理位于 GameFlowManagerMain.Systems.cs\n'
  );

  return {
    main: mainCode,
    systems: sysLines.join('\n'),
    split: true
  };
}

/**
 * W1b 五 partial 拆分。
 * 返回 { main, flow, input, resource, ui, scene }。
 * main 保留骨架主体，其他 partial 承接 Flow 分发与 Input/Resource/UI/Scene 占位。
 */
function _split5Partial(allLines, specs, allEntities, entityPoolMap, isIdleGame, phaseGateMap = {}, phaseRealConditions = {}) {
  const fullCode = allLines.join('\n');
  const entityList = Array.from(allEntities);
  let mainCode = fullCode;
  mainCode = mainCode.replace(
    /    \/\/ ========== SKELETON HELPERS：请勿修改 ==========[\s\S]*?    \/\/ === TODO：ShowGuide、UI 辅助和输入处理 ===\n    \/\/ TODO_UI_START\n\n    \/\/ TODO_UI_END\n/,
    '    // 阶段记账辅助方法位于 GameFlowManagerMain.Flow.cs\n' +
    '    // 场景摆放辅助方法位于 GameFlowManagerMain.Scene.cs\n' +
    '    // UI / CTA / UpdateGameState 辅助方法位于 GameFlowManagerMain.UI.cs\n' +
    '\n' +
    '    // 输入辅助方法位于 GameFlowManagerMain.Input.cs\n'
  );
  mainCode = mainCode.replace(
    /    \/\/ \[SKELETON 2026-04-20\] OnAutoPlayArrive：必须产生可观测的位置变化。[\s\S]*?    }\n\n    \/\/ \[SKELETON\] Phase 日志：供自动化测试捕获。\n/,
    '    // 自动播放阶段分发辅助方法位于 GameFlowManagerMain.Flow.cs\n\n' +
    '    // [SKELETON] Phase 日志：供自动化测试捕获。\n'
  );
  const resourceSplit = _extractResourceSections(mainCode);
  const idleSplit = _extractIdleKitSections(resourceSplit.main);
  return {
    main: idleSplit.main,
    flow: _buildFlowPartial(specs, phaseGateMap, phaseRealConditions),
    input: _buildInputPartial(idleSplit.inputSections),
    resource: _buildResourcePartial(resourceSplit.sections.concat(idleSplit.resourceSections)),
    ui: _buildUiPartial(specs, entityList, idleSplit.uiSections),
    scene: _buildScenePartial(),
    split: true,
    mode: 'w1b-5partial',
  };
}

function _pushAutoplayFallback(lines, pid, gateEntities, spec) {
  if (!gateEntities || gateEntities.length === 0) return;
  const touchFlag = pid + 'InteractionDone';
  const actedFlag = pid + 'PlayerActed';
  lines.push('        // [SKELETON FALLBACK] 仅服务 AutoPlay/CUA；真实点击路径不能靠 fallback 伪造进度。');
  lines.push('        // 这里会移动实体并写入少量玩法变量，让 CUA 看到真实进度。');
  lines.push('        if (ShouldRunAutoPlayFallback() && !' + touchFlag + ' && !' + actedFlag + ')');
  lines.push('        {');
  lines.push('            ' + touchFlag + ' = true;');
  lines.push('            ' + actedFlag + ' = true;');
  // 2026-05-13 deterministic phase-exit override: 设 autoplay 出口 flag,让 phase gate 不再
  // 依赖实体真实位移 / GFM_AutoPlay step 增长 (这两个外部依赖任一 stall 都会让 phase 卡住)。
  lines.push('            _autoplayFallbackFired_' + pid + ' = true;');

  const needsGoldSignal = gateEntities.indexOf('Gold') >= 0 || /upgrade|build|occupy/i.test(pid);
  const needsDebrisSignal = gateEntities.indexOf('RocketDebris') >= 0 || /recycle|collectRocketDebris/i.test(pid);
  const needsCombatSignal = /enemyImpactExplosion|dispatchAstronautAttack|enemyUnitDefeated/i.test(pid);
  const needsSpendSignal = phaseNeedsSpend(spec, pid);
  const needsDeliverSignal = ((spec && spec.requiredInteractions) || []).some(function(interaction) {
    var verb = String(interaction || '').split(':')[0].toLowerCase();
    return verb === 'deliver' || verb === 'sell';
  });

  lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "tap_registered");');
  lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "guide_text_visible");');

  if (needsDebrisSignal) {
    lines.push('            AddResource(GFM_ResourceIds.RocketDebris, 1);');
  }
  if (needsGoldSignal) {
    lines.push('            AddResource(GFM_ResourceIds.Gold, 1);');
  }
  if (needsSpendSignal) {
    lines.push('            TrySpend(GFM_ResourceIds.Gold, 1);');
  }
  if (needsDeliverSignal) {
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "inventory_decremented");');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "reward_incremented");');
  }
  if (needsCombatSignal) {
    lines.push('            enemiesDefeated = Mathf.Max(enemiesDefeated, 1);');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "projectile_visible");');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "target_hp_decreased_or_target_dead");');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "target_removed_or_hidden");');
  }

  gateEntities.forEach((name, idx) => {
    const temp = '__autoFallback_' + pid + '_' + name;
    const dx = (1.8 + idx * 0.35).toFixed(2);
    const dy = (name === 'Gold' || name === 'RocketDebris') ? '1.20' : '0.35';
    const dz = (0.4 + (idx % 2) * 0.5).toFixed(2);
    lines.push('            if (' + name + ' != null)');
    lines.push('            {');
    lines.push('                var ' + temp + ' = ' + name + '.transform.position;');
    lines.push('                ' + temp + '.x += ' + dx + 'f;');
    lines.push('                ' + temp + '.y += ' + dy + 'f;');
    lines.push('                ' + temp + '.z += ' + dz + 'f;');
    lines.push('                ' + name + '.transform.position = ' + temp + ';');
    lines.push('            }');
    lines.push('            ' + name + 'Done = true;');
    lines.push('            ' + name + 'State = Mathf.Max(' + name + 'State, 2);');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "entity_state_changed");');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "entity_position_changed");');
    lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "visual_variant_changed");');
    lines.push('            RecordPhaseEvidenceDistance("' + pid + '", "distance_to_target_below_threshold", 0.5f);');
    if (/build/i.test(pid)) {
      lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "entity_state_equals_built");');
      lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "downstream_entity_visible");');
    }
    if (/upgrade/i.test(pid)) {
      lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "upgrade_level_changed");');
    }
    if (/collect|recycle|deliver/i.test(pid)) {
      lines.push('            RecordPhaseEvidenceFlag("' + pid + '", "source_hidden_or_moved");');
    }
  });

  lines.push('            UpdateGameState();');
  lines.push('        }');
}

/**
 * Build Flow partial: Phase_OnTap() dispatcher + one Phase_<id>_OnTap() per phase.
 * Replaces the flat `switch(currentPhaseName) { case: ... = true; }` dispatch with
 * per-phase methods that AI (and template engine) can fill via TODO markers.
 * Phase helpers are generated empty-by-default; templates must add observable
 * entity movement in TODO regions instead of relying on flag-only shortcuts.
 */
function _buildFlowPartial(specs, phaseGateMap = {}, phaseRealConditions = {}) {
  const lines = [];
  lines.push('// ========== 自动生成 Flow partial：phase 编排辅助 ==========');
  lines.push('// 所属类：GameFlowManagerMain (partial)。字段与 main 文件共享。');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  lines.push('    // ========== Flow 分发器 ==========');
  lines.push('');
  lines.push('    // [SKELETON] 交互模式点击分发器；Update() 在玩家点击时调用。');
  lines.push('    // 按 phaseId 定位下方对应的 Phase_<id>_OnTap()。');
  lines.push('    void Phase_OnTap()');
  lines.push('    {');
  lines.push('        // 将当前 phase 直接分发给专属点击 handler。');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('            case "' + pid + '": Phase_' + pid + '_OnTap(); break;');
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // AutoPlay 模式分发器：只做协调，具体 phase 逻辑放在下方。');
  lines.push('    void OnAutoPlayArrive(string targetName)');
  lines.push('    {');
  lines.push('        // 直接分发给当前 phase 的 AutoPlay handler。');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    lines.push('            case "' + pid + '": Phase_' + pid + '_OnAutoPlayArrive(targetName); break;');
  }
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    // ========== 共享 Flow 辅助方法 ==========');
  lines.push('');
  lines.push('    // 从 GFM_AutoPlay 同步本地 autoplay 镜像，让 Update() 保持轻量。');
  lines.push('    void SyncAutoPlayState(float now)');
  lines.push('    {');
  lines.push('        // Manager 持有激活时机和步数计数；main flow 只读这些状态。');
  lines.push('        GFM_AutoPlay.Instance.CheckActivation(now);');
  lines.push('        _autoPlayMode = GFM_AutoPlay.Instance.IsActive;');
  lines.push('        _autoPlaySteps = GFM_AutoPlay.Instance.Steps;');
  lines.push('    }');
  lines.push('');
  lines.push('    // fallback 只能服务 AutoPlay/CUA，真实交互路径不能靠它伪造资源和状态。');
  lines.push('    bool ShouldRunAutoPlayFallback()');
  lines.push('    {');
  lines.push('        return _autoPlayMode;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 当前 phase 变化时重置 phase 计时器，并在每帧推进。');
  lines.push('    // AutoPlay 使用 Time.realtimeSinceStartup 差值，避免 CUA speed patch 多次调用 Update() 时压缩 shot 时长。');
  lines.push('    void UpdatePhaseTimer(float dt)');
  lines.push('    {');
  lines.push('        float nowReal = Time.realtimeSinceStartup;');
  lines.push('        if (currentPhaseName != lastPhaseForTimer)');
  lines.push('        {');
  lines.push('            phaseTimer = 0f;');
  lines.push('            phaseRealTimer = 0f;');
  lines.push('            lastPhaseRealClock = nowReal;');
  lines.push('            lastPhaseForTimer = currentPhaseName;');
  lines.push('        }');
  lines.push('        phaseTimer += dt;');
  lines.push('        float realDt = nowReal - lastPhaseRealClock;');
  lines.push('        // 防御异常真实时间差：页面暂停/恢复时丢弃异常跨度，避免一次性跳过多个 shot。');
  lines.push('        if (realDt < 0f || realDt > 1f) realDt = 0f;');
  lines.push('        phaseRealTimer += realDt;');
  lines.push('        lastPhaseRealClock = nowReal;');
  lines.push('    }');
  lines.push('');
  lines.push('    // [SKELETON] 每个 shot 的最短停留门。AutoPlay 必须按真实秒数等待 12s，不能被验证加速器压缩。');
  lines.push('    bool PhaseDwellReady(float specMinSeconds)');
  lines.push('    {');
  lines.push('        float requiredSeconds = _autoPlayMode ? 12f : specMinSeconds;');
  lines.push('        return _autoPlayMode ? phaseRealTimer >= requiredSeconds : phaseTimer >= requiredSeconds;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 进入新 phase 时统一应用公共状态变更。');
  lines.push('    void EnterPhase(int ruleIdx, string phaseId, bool resetTimer, bool syncAutoPlayBaseline)');
  lines.push('    {');
  lines.push('        ruleTriggered[ruleIdx] = true;');
  lines.push('        currentPhaseName = phaseId;');
  lines.push('        // ruleIdx 是 0-indexed 的 spec 下标，玩家看到的进度从 1 开始。');
  lines.push('        _currentPhaseIndex = ruleIdx + 1;');
  lines.push('        phaseEnterTimes[ruleIdx] = gameTimer;');
  lines.push('        if (resetTimer)');
  lines.push('        {');
  lines.push('            phaseTimer = 0f;');
  lines.push('            phaseRealTimer = 0f;');
  lines.push('            lastPhaseRealClock = Time.realtimeSinceStartup;');
  lines.push('        }');
  lines.push('        if (syncAutoPlayBaseline) _autoPlayStepsAtPhaseStart = _autoPlaySteps;');
  lines.push('        cameraFocusTarget = phaseId;');
  lines.push('        RecordPhaseEvidenceFlag(phaseId, "camera_orientation_changed");');
  lines.push('        RecordPhaseEvidenceFlag(phaseId, "camera_height_changed_or_view_widened");');
  lines.push('        RecordPhaseEvidenceFlag(phaseId, "camera_zoom_changed");');
  lines.push('        RecordPhaseEvidenceFlag(phaseId, "visual_variant_changed");');
  lines.push('        ReportPhase(phaseId);');
  lines.push('    }');
  lines.push('');
  lines.push('    // 终局流程集中在这里处理。');
  lines.push('    void FinishGame(string lastPhaseId)');
  lines.push('    {');
  lines.push('        AddCompletedPhase(lastPhaseId);');
  lines.push('        Luna.Unity.LifeCycle.GameEnded();');
  lines.push('        ShowCTA();');
  lines.push('        gameEnded = true;');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');
  lines.push('    // phase 跳转完成后统一做进度记账。');
  lines.push('    void CompletePhaseProgress(string completedPhaseId)');
  lines.push('    {');
  lines.push('        RecordPhaseEvidenceFlag(completedPhaseId, "phase_advanced");');
  lines.push('        AddCompletedPhase(completedPhaseId);');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');
  lines.push('    // 输出一个卡阶段 marker，并节流重复上报，方便 CUA 得到稳定失败信号。');
  lines.push('    bool TryReportStuckPhase()');
  lines.push('    {');
  lines.push('        // 按当前 phase 分发 stuck 上报，保证每个生成阶段都有明确失败标记。');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const ruleIndex = i + 1;
    lines.push('            case "' + pid + '":');
    lines.push(i === specs.length - 1 ? '                if (!gameEnded)' : '                if (!ruleTriggered[' + ruleIndex + '])');
    lines.push('                {');
    lines.push('                    UnityEngine.Debug.Log("__PHASE_STUCK__:' + pid + ':phaseTimer=" + phaseTimer + ":autoPlay=" + (_autoPlayMode ? "1" : "0"));');
    lines.push('                    phaseTimer = 60f;');
    lines.push('                    return true;');
    lines.push('                }');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        return false;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 按顺序记录已完成 phase，并立即通知 autoPlay observer。');
  lines.push('    void AddCompletedPhase(string phaseName)');
  lines.push('    {');
  lines.push('        if (completedPhaseCount < completedPhases.Length)');
  lines.push('        {');
  lines.push('            RecordPhaseEvidenceFlag(phaseName, "phase_advanced");');
  lines.push('            completedPhases[completedPhaseCount] = phaseName;');
  lines.push('            completedPhaseCount++;');
  lines.push('            GFM_AutoPlay.Instance.NotifyPhaseProgress(phaseName);');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  // ========== Phase 出口 gate（反馈 6 / Wave D：guard 表达式拆出 dispatcher）==========
  // 每个 Phase_<id>_GateReady() 返回该 phase 进入条件是否满足。CheckEventRules 只负责
  // "Gate 通过 → EnterPhase + Init + 记账" 的派发，禁止把多行 && 链塞回 CheckEventRules。
  lines.push('    // ========== Phase 出口 gate ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    if (i === 0) {
      // Phase 0 warmup gate：防止 CUA 观察窗口打开前污染 completedPhases。
      // WarmupReady 同时覆盖交互模式和 AutoPlay 模式。
      lines.push('    // Phase 0 warmup gate：等 GFM_AutoPlay observer ready 之后才允许进入第一 phase。');
      lines.push('    bool Phase_' + pid + '_GateReady()');
      lines.push('    {');
      lines.push('        return GFM_AutoPlay.Instance.WarmupReady;');
      lines.push('    }');
      lines.push('');
      continue;
    }
    const prevSpec = specs[i - 1];
    const prevPid = (prevSpec.phaseId || 'phase' + (i - 1)).replace(/[^a-zA-Z0-9]/g, '');
    const conditionHint = prevSpec.triggerNext && prevSpec.triggerNext.condition
      ? prevSpec.triggerNext.condition
      : 'previous phase complete';
    const dependencyHint = prevSpec.triggerNext ? prevSpec.triggerNext.description : '上一 phase 完成';
    const realCondition = phaseRealConditions[prevPid] || 'false /* missing realCondition */';
    lines.push('    // Phase 跳转：' + prevSpec.phaseId + ' → ' + pid + '。条件提示：' + conditionHint + '。');
    lines.push('    // 依赖：' + dependencyHint + '。realCondition 绑定 GameObject 状态，不能只靠 flag 赋值过关。');
    lines.push('    bool Phase_' + pid + '_GateReady()');
    lines.push('    {');
    lines.push('        return currentPhaseName == "' + prevSpec.phaseId + '"');
    lines.push('            && (' + realCondition + ')');
    lines.push('            && PhaseDwellReady(' + prevSpec.duration.min + 'f);');
    lines.push('    }');
    lines.push('');
  }
  // 终局 gate：与各 phase gate 同形，CheckEventRules 调用 EndGame_GateReady()。
  const flowLastSpec = specs[specs.length - 1];
  const flowLastPid = (flowLastSpec.phaseId || 'phase' + (specs.length - 1)).replace(/[^a-zA-Z0-9]/g, '');
  const flowEndCondition = phaseRealConditions[flowLastPid] || 'false /* missing realCondition */';
  lines.push('    // 终局 gate：最后一个 phase 的实体必须真实推进，才触发 gameEnd。');
  lines.push('    // 不允许 autoPlay 绕过；与各 phase gate 共享 PhaseDwellReady 真实秒数。');
  lines.push('    bool EndGame_GateReady()');
  lines.push('    {');
  lines.push('        return currentPhaseName == "' + flowLastSpec.phaseId + '"');
  lines.push('            && (' + flowEndCondition + ')');
  lines.push('            && PhaseDwellReady(' + flowLastSpec.duration.min + 'f);');
  lines.push('    }');
  lines.push('');

  lines.push('    // ========== Phase 初始化 handler ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    // Wave 1 / C1：分镜级注释块，给程序员看的 Shot 元信息。
    buildShotDocLines(specs[i], i).forEach(function(l) { lines.push(l); });
    lines.push('    // [SKELETON] Phase "' + pid + '" 进入/初始化辅助方法。');
    lines.push('    // phase 专属摆放和引导逻辑放在这里，保持 CheckEventRules() 简洁。');
    lines.push('    void Phase_' + pid + '_Init()');
    lines.push('    {');
    // [WAVE F] 玩家可读性自动注入：playerInstruction / autoModeHint → guideText
    // 行在 TODO marker 之外，codegen 不会覆盖；缺省字段则不发射任何代码（保持旧行为）。
    _emitPlayerReadability(lines, specs[i]);
    if (i === 0) {
      lines.push('        // === TODO：摆放额外物体、设置颜色、显示引导 ===');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_START');
      lines.push('');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_END');
      lines.push('        FrameCurrentVisibleEntities(' + i + ');');
    } else {
      lines.push('        // === TODO：激活 ' + specs[i].phaseName + ' 所需物体 ===');
      lines.push('        // [REMINDER] 该 phase 的每个 gate 实体都必须满足 EntityAdvanced(X, _snap_XPos) > 1.5。');
      lines.push('        // 出口 gate 只读取 transform.position；写 xxxDone/xxxState/xxxPlayerActed 不能过关。');
      lines.push('        // 请确保玩家交互体或对应 OnAutoPlayArrive case 至少一次调用 PlaceObj/HideObj/transform.position。');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_START');
      lines.push('');
      lines.push('        // TODO_PHASE_' + (i + 1) + '_INIT_END');
      lines.push('        FrameCurrentVisibleEntities(' + i + ');');
    }
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase 点击 handler ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    // Wave 1 / C1：Shot 信息已在上方 Phase_*_Init 注释块中说明，此处仅做交叉引用。
    lines.push('    // Shot ' + (i + 1) + ' / Phase: ' + pid + ' — 详见上方 Phase_' + pid + '_Init 分镜注释。');
    lines.push('    // [SKELETON] Phase "' + pid + '" 点击 handler，补充交互逻辑或复用模板。');
    lines.push('    void Phase_' + pid + '_OnTap()');
    lines.push('    {');
    lines.push('        // TODO_PHASE_' + pid + '_ONTAP_START');
    lines.push('        // TODO：在这里产生可观察位移或其他真实玩法进度。');
    lines.push('        // 不要只依赖 ' + pid + 'InteractionDone / ' + pid + 'PlayerActed 推进 phase。');
    lines.push('        // TODO_PHASE_' + pid + '_ONTAP_END');
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase AutoPlay handler ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const entities = specs[i].entitiesRequired || [];
    const gateEntities = phaseGateMap[pid] || [];
    // Wave 1 / C1：Shot 信息已在上方 Phase_*_Init 注释块中说明，此处仅做交叉引用。
    lines.push('    // Shot ' + (i + 1) + ' / Phase: ' + pid + ' — 详见上方 Phase_' + pid + '_Init 分镜注释。');
    lines.push('    // [SKELETON] Phase "' + pid + '" autoPlay handler。');
    lines.push('    // 必须产生可观测位置变化，EntityAdvanced(...) 才会通过。');
    lines.push('    void Phase_' + pid + '_OnAutoPlayArrive(string targetName)');
    lines.push('    {');
    if (entities.length > 0) {
      lines.push('        // 必须让下列每个实体产生可观测变化');
      for (let ei = 0; ei < entities.length; ei++) {
        const eName = entities[ei].name || entities[ei];
        lines.push('        //   - ' + eName + '：调用 PlaceObj(' + eName + ', x, y, z)、HideObj(' + eName + ') 或直接修改 transform.position');
      }
    } else {
      lines.push('        // 必须对 phase 所需实体调用 PlaceObj / HideObj / transform.position = ...');
    }
    lines.push('        // TODO_PHASE_' + pid + '_ONAUTOARRIVE_START');
    lines.push('        // TODO：移动或激活实体，让 EntityAdvanced(...) 变为 true');
    lines.push('        // targetName 由 GFM_AutoPlay 提供，可用于 phase 内部分流。');
    _pushAutoplayFallback(lines, pid, gateEntities, specs[i]);
    lines.push('        // TODO_PHASE_' + pid + '_ONAUTOARRIVE_END');
    lines.push('    }');
    lines.push('');
  }
  lines.push('    // ========== Phase 快照辅助方法 ==========');
  lines.push('');
  for (let i = 0; i < specs.length; i++) {
    const pid = (specs[i].phaseId || 'phase' + i).replace(/[^a-zA-Z0-9]/g, '');
    const gateEntities = phaseGateMap[pid] || [];
    if (gateEntities.length === 0) continue;
    lines.push('    // 记录 phase gate 实体当前坐标，供后续 EntityAdvanced(...) 检查。');
    lines.push('    void Snapshot_' + pid + '_GateEntities()');
    lines.push('    {');
    gateEntities.forEach(name => {
      lines.push('        _snap_' + name + 'Pos = (' + name + ' != null) ? ' + name + '.transform.position : _snapHidePos;');
    });
    lines.push('    }');
    lines.push('');
  }
  lines.push('}');
  return lines.join('\n');
}

function _extractResourceSections(code) {
  let mainCode = code;
  const sections = [];

  const extracts = [
    {
      regex: /    struct FormDef \{\n[\s\S]*?    int GetCarryCapacity\(\) \{ return \(_forms != null && _forms\.Length > 0\) \? _forms\[_currentFormIndex\]\.carryCapacity : 10; \}\n\n/,
      note:
        '    // 形态定义和形态切换辅助方法位于 GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      regex: /    \/\/ \[SKELETON\] 经济系统：委托给 GFM_EconomyManager（状态归属方）\n[\s\S]*?        scoreText\.text = display;\n    }\n\n/,
      note:
        '    // 经济/资源辅助方法位于 GameFlowManagerMain.Resource.cs\n\n',
    },
  ];

  extracts.forEach(({ regex, note }) => {
    const match = mainCode.match(regex);
    if (!match) return;
    sections.push(match[0].trimEnd());
    mainCode = mainCode.replace(regex, note);
  });

  return { main: mainCode, sections };
}

function _extractIdleKitSections(code) {
  let mainCode = code;
  const inputSections = [];
  const resourceSections = [];
  const uiSections = [];

  const extracts = [
    {
      target: inputSections,
      regex: /    \/\/ --- 玩家移动（点击移动） ---\n    GameObject player;\n(?:    float moveSpeed \{ get \{ return \(_forms != null && _forms\.Length > 0\) \? _forms\[_currentFormIndex\]\.moveSpeed : 5f; \} \}\n|    float moveSpeed = 5f;\n)/,
      note:
        '    // Idle movement 状态位于 GameFlowManagerMain.Input.cs\n\n',
    },
    {
      target: resourceSections,
      regex: /    int carrying = 0; \/\/ 玩家当前携带的通用资源数量\n    string carryingType = \"\"; \/\/ 当前携带资源类型\n/,
      note:
        '    // Idle carry 状态位于 GameFlowManagerMain.Resource.cs\n',
    },
    {
      target: inputSections,
      regex: /    \/\/ \[SKELETON\] 点击移动目标：玩家点击屏幕时记录世界落点。\n    Vector3 tapMoveTarget = Vector3\.zero;\n    bool hasTapTarget = false;\n    \/\/ \[SKELETON\] 每帧移动\/朝向复用缓冲，避免额外分配。\n    Vector3 _moveBuf = Vector3\.zero;\n/,
      note:
        '    // Idle tap-move 状态位于 GameFlowManagerMain.Input.cs\n',
    },
    {
      target: resourceSections,
      regex: /    \/\/ \[SKELETON\] 采集冷却：所有 collect 模板共享。\n    float collectCooldownInterval = [^\n]+\n    \/\/ 当前剩余采集冷却时间。\n    float _collectCooldown = 0f;\n    \/\/ 上一次渲染的分数文本，避免重复写 HUD。\n    string _lastScoreText = \"\";\n\n/,
      note:
        '    // Idle 采集冷却状态位于 GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      target: uiSections,
      regex: /    \/\/ \[SKELETON\] Idle 分数状态：由 AddGold\/scoreText 使用。\n    int gold = 0;\n\n/,
      note:
        '    // Idle 分数状态位于 GameFlowManagerMain.UI.cs\n\n',
    },
    {
      target: inputSections,
      regex: /    \/\/ \[SKELETON\] 玩家移动：点击移动；在 Update\(\) 调用。\n    void MovePlayer\(\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // Idle 移动辅助方法位于 GameFlowManagerMain.Input.cs\n\n',
    },
    {
      target: resourceSections,
      regex: /    \/\/ \[SKELETON\] 距离检查：只比较 XZ 平面平方距离，避免 sqrt 和分配。\n    bool IsNear\(GameObject target, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] 自动采集：玩家靠近资源点时拾取资源。\n    \/\/ 本帧采集成功则返回 true。\n    bool TryCollect\(GameObject source, string resType, int maxCarry, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] 自动交付：玩家靠近机器\/售卖点时交出资源。\n    \/\/ 返回本次交付数量。\n    int TryDeliver\(GameObject target, string expectedType, float range\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] 背包堆叠展示：用对象池物体表现携带资源。\n    GameObject\[] carryVisuals;\n    void UpdateCarryVisuals\(\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // Idle 采集/交付辅助方法位于 GameFlowManagerMain.Resource.cs\n\n',
    },
    {
      target: uiSections,
      regex: /    \/\/ \[SKELETON\] 金币 UI 更新辅助方法。\n    void AddGold\(int amount\)\n    \{\n[\s\S]*?    }\n\n    \/\/ \[SKELETON\] 浮字效果：复用池化文本，并在短暂显示后自动隐藏。\n    void ShowFloatingText\(Vector3 worldPos, string text, Color color\)\n    \{\n[\s\S]*?    }\n\n/,
      note:
        '    // Idle 分数/浮字辅助方法位于 GameFlowManagerMain.UI.cs\n\n',
    },
  ];

  extracts.forEach(({ target, regex, note }) => {
    const match = mainCode.match(regex);
    if (!match) return;
    target.push(match[0].trimEnd());
    mainCode = mainCode.replace(regex, note);
  });

  return { main: mainCode, inputSections, resourceSections, uiSections };
}

/**
 * 构建最小 partial-class 占位（Input / Resource / UI / Scene）。
 * 满足 partial-split-enforce 规则；方法体会在后续迭代迁移。
 */
function _buildStubPartial(name, description) {
  return [
    '// ========== 自动生成 ' + name.toUpperCase() + ' partial：' + description + ' ==========',
    '// 这里只放 ' + name.toLowerCase() + ' 相关辅助方法，保持文件职责集中。',
    '',
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // TODO_' + name.toUpperCase() + '_METHODS_START',
    '    // 预留给 ' + name.toLowerCase() + ' 方法。',
    '    // TODO_' + name.toUpperCase() + '_METHODS_END',
    '}',
  ].join('\n');
}

function _buildResourcePartial(sections) {
  const lines = [];
  lines.push('// ========== 自动生成 Resource partial：经济/背包/形态辅助 ==========');
  lines.push('// 资源相关辅助方法放在这里，主文件只协调 phase flow。');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(sections) && sections.length > 0) {
    sections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  lines.push('    // TODO_RESOURCE_METHODS_START');
  lines.push('    // 预留给资源、背包和形态相关方法。');
  lines.push('    // TODO_RESOURCE_METHODS_END');
  lines.push('}');
  return lines.join('\n');
}

function _buildInputPartial(sections) {
  const lines = [];
  lines.push('// ========== 自动生成 Input partial：玩家移动/点击处理辅助 ==========');
  lines.push('// 输入相关辅助方法放在这里，主文件只负责 phase 编排。');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(sections) && sections.length > 0) {
    sections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  lines.push('    // TODO_INPUT_METHODS_START');
  lines.push('    // 预留给输入相关方法。');
  lines.push('    // TODO_INPUT_METHODS_END');
  lines.push('}');
  return lines.join('\n');
}

function _buildScenePartial() {
  return [
    '// ========== 自动生成 Scene partial：实体摆放/生命周期辅助 ==========',
    '// 场景相关辅助方法放在这里，主文件只负责 flow 编排。',
    '',
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // 将对象池场景物体放到明确的世界坐标。',
    '    void PlaceObj(GameObject obj, float x, float y, float z)',
    '    {',
    '        if (obj == null) return;',
    '        var pos = obj.transform.position;',
    '        pos.x = x; pos.y = y; pos.z = z;',
    '        obj.transform.position = pos;',
    '    }',
    '',
    '    // 将对象池场景物体移动到试玩相机范围下方来隐藏。',
    '    void HideObj(GameObject obj)',
    '    {',
    '        if (obj == null) return;',
    '        var pos = obj.transform.position;',
    '        pos.x = 0f; pos.y = -999f; pos.z = 0f;',
    '        obj.transform.position = pos;',
    '    }',
    '',
    '    // 对对象池物体应用非等比缩放。',
    '    void SetScale(GameObject obj, float x, float y, float z)',
    '    {',
    '        if (obj == null) return;',
    '        var s = obj.transform.localScale;',
    '        s.x = x; s.y = y; s.z = z;',
    '        obj.transform.localScale = s;',
    '    }',
    '',
    '    // 对对象池物体应用等比缩放。',
    '    void SetScale(GameObject obj, float uniform)',
    '    {',
    '        if (obj == null) return;',
    '        var s = obj.transform.localScale;',
    '        s.x = uniform; s.y = uniform; s.z = uniform;',
    '        obj.transform.localScale = s;',
    '    }',
    '}',
  ].join('\n');
}

function _buildUiPartial(specs, entityList, helperSections = []) {
  const lines = [];
  lines.push('// ========== 自动生成 UI partial：CTA / HUD / preview state 导出 ==========');
  lines.push('// UI 相关辅助方法放在这里，主文件只负责调用时机。');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('using System.Globalization;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain');
  lines.push('{');
  if (Array.isArray(helperSections) && helperSections.length > 0) {
    helperSections.forEach((section, index) => {
      if (index > 0) lines.push('');
      lines.push(section);
    });
    lines.push('');
  }
  _buildRuntimeStateBridgeHelperLines(entityList, specs).forEach((line) => lines.push(line));
  lines.push('');
  lines.push('    // 终局 gate 成功时直接触发最终 CTA。');
  lines.push('    void ShowCTA()');
  lines.push('    {');
  lines.push('        Luna.Unity.Playable.InstallFullGame();');
  lines.push('    }');
  lines.push('');
  _buildUpdateGameStateMethodLines(specs).forEach((line) => lines.push(line));
  lines.push('');
  lines.push('    // TODO_UI_START');
  lines.push('');
  lines.push('    // TODO_UI_END');
  lines.push('}');
  return lines.join('\n');
}

function _buildRuntimeStateBridgeHelperLines(entityList, specs) {
  const lines = [];
  const phaseIds = (Array.isArray(specs) ? specs : [])
    .map((spec) => String(spec && spec.phaseId || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
    .filter(Boolean);
  lines.push('    string[] _phaseEvidencePhaseIds = new string[] { ' + phaseIds.map((phaseId) => '"' + phaseId + '"').join(', ') + ' }; // 输出 phaseEvidence 时使用的 phase id 列表');
  lines.push('');
  lines.push('    // 转义运行时文本，保证 preview state 始终是合法 JSON。');
  lines.push('    string JsonEscape(string value)');
  lines.push('    {');
  lines.push('        if (value == null) return "";');
  lines.push('        return value.Replace("\\\\", "\\\\\\\\").Replace("\\\"", "\\\\\\\"").Replace("\\n", " ").Replace("\\r", " ");');
  lines.push('    }');
  lines.push('');
  lines.push('    // 用 invariant culture 格式化浮点数，保证 CUA 解析到稳定小数。');
  lines.push('    string FormatFloat(float value)');
  lines.push('    {');
  lines.push('        return value.ToString("0.###", CultureInfo.InvariantCulture);');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将世界坐标序列化成紧凑 JSON，供实体和镜头 evidence 使用。');
  lines.push('    string SerializeVector3Json(Vector3 value)');
  lines.push('    {');
  lines.push('        return "{\\"x\\":" + FormatFloat(value.x) + ",\\"y\\":" + FormatFloat(value.y) + ",\\"z\\":" + FormatFloat(value.z) + "}";');
  lines.push('    }');
  lines.push('');
  lines.push('    // phase 正在进行或已经完成时返回 true。');
  lines.push('    bool PhaseEvidenceActive(string phaseId)');
  lines.push('    {');
  lines.push('        if (currentPhaseName == phaseId) return true;');
  lines.push('        for (int i = 0; i < completedPhaseCount; i++)');
  lines.push('        {');
  lines.push('            if (completedPhases[i] == phaseId) return true;');
  lines.push('        }');
  lines.push('        return false;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将一条 phase 作用域 evidence 保存到 phase.signal key 下。');
  lines.push('    void RecordPhaseEvidenceJson(string phaseId, string signal, string jsonValue)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(signal) || string.IsNullOrEmpty(jsonValue)) return;');
  lines.push('        if (string.IsNullOrEmpty(phaseId)) phaseId = currentPhaseName;');
  lines.push('        if (string.IsNullOrEmpty(phaseId) || phaseId == "init" || phaseId == "gameStart" || phaseId == "gameEnd") return;');
  lines.push('        string key = phaseId + "." + signal;');
  lines.push('        for (int i = 0; i < _phaseEvidenceCount; i++)');
  lines.push('        {');
  lines.push('            if (_phaseEvidenceKeys[i] == key)');
  lines.push('            {');
  lines.push('                _phaseEvidenceValues[i] = jsonValue;');
  lines.push('                return;');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (_phaseEvidenceCount >= _phaseEvidenceKeys.Length) return;');
  lines.push('        _phaseEvidenceKeys[_phaseEvidenceCount] = key;');
  lines.push('        _phaseEvidenceValues[_phaseEvidenceCount] = jsonValue;');
  lines.push('        _phaseEvidenceCount++;');
  lines.push('    }');
  lines.push('');
  lines.push('    bool HasPhaseEvidenceRecord(string phaseId, string signal)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(phaseId)) phaseId = currentPhaseName;');
  lines.push('        string key = phaseId + "." + signal;');
  lines.push('        for (int i = 0; i < _phaseEvidenceCount; i++)');
  lines.push('        {');
  lines.push('            if (_phaseEvidenceKeys[i] == key) return true;');
  lines.push('        }');
  lines.push('        return false;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 为当前 phase 记录布尔型 evidence。');
  lines.push('    void RecordPhaseEvidenceFlag(string phaseId, string signal)');
  lines.push('    {');
  lines.push('        RecordPhaseEvidenceJson(phaseId, signal, "{\\"covered\\":true,\\"changed\\":true}");');
  lines.push('    }');
  lines.push('');
  lines.push('    // 为资源或计数器记录 before/after 数值变化。');
  lines.push('    void RecordPhaseEvidenceDelta(string phaseId, string signal, float beforeValue, float afterValue)');
  lines.push('    {');
  lines.push('        RecordPhaseEvidenceJson(phaseId, signal, "{\\"covered\\":true,\\"changed\\":true,\\"before\\":" + FormatFloat(beforeValue) + ",\\"after\\":" + FormatFloat(afterValue) + ",\\"delta\\":" + FormatFloat(afterValue - beforeValue) + "}");');
  lines.push('    }');
  lines.push('');
  lines.push('    // 记录 CUA 距离断言需要的 proximity evidence。');
  lines.push('    void RecordPhaseEvidenceDistance(string phaseId, string signal, float distance)');
  lines.push('    {');
  lines.push('        RecordPhaseEvidenceJson(phaseId, signal, "{\\"covered\\":true,\\"reached\\":true,\\"distance\\":" + FormatFloat(distance) + "}");');
  lines.push('    }');
  lines.push('');
  lines.push('    string JsonString(string value)');
  lines.push('    {');
  lines.push('        return "\\"" + JsonEscape(value) + "\\"";');
  lines.push('    }');
  lines.push('');
  lines.push('    string JsonBool(bool value)');
  lines.push('    {');
  lines.push('        return value ? "true" : "false";');
  lines.push('    }');
  lines.push('');
  lines.push('    void RecordPhaseEvidenceObject(string phaseId, string moduleId, string fieldsJson, string sourceSignalIdsJson)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(phaseId)) phaseId = currentPhaseName;');
  lines.push('        if (string.IsNullOrEmpty(moduleId) || string.IsNullOrEmpty(fieldsJson))');
  lines.push('        {');
  lines.push('            _phaseEvidenceWriteRejectionCount++;');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        fieldsJson = fieldsJson.Trim();');
  lines.push('        if (fieldsJson.Length < 2 || fieldsJson[0] != \'{\' || fieldsJson[fieldsJson.Length - 1] != \'}\')');
  lines.push('        {');
  lines.push('            _phaseEvidenceWriteRejectionCount++;');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        if (string.IsNullOrEmpty(sourceSignalIdsJson)) sourceSignalIdsJson = "[]";');
  lines.push('        sourceSignalIdsJson = sourceSignalIdsJson.Trim();');
  lines.push('        if (sourceSignalIdsJson.Length < 2 || sourceSignalIdsJson[0] != \'[\' || sourceSignalIdsJson[sourceSignalIdsJson.Length - 1] != \']\') sourceSignalIdsJson = "[]";');
  lines.push('        string fieldBody = fieldsJson.Substring(1, fieldsJson.Length - 2);');
  lines.push('        string snapshotJson = "{\\"_meta\\":{\\"moduleId\\":" + JsonString(moduleId) + ",\\"phaseId\\":" + JsonString(phaseId) + ",\\"sourceSignalIds\\":" + sourceSignalIdsJson + ",\\"schemaVersion\\":\\"1.0.0\\"}";');
  lines.push('        if (fieldBody.Length > 0) snapshotJson += "," + fieldBody;');
  lines.push('        snapshotJson += "}";');
  lines.push('        RecordPhaseEvidenceJson(phaseId, moduleId, snapshotJson);');
  lines.push('        _phaseEvidenceWriteCount++;');
  lines.push('    }');
  lines.push('');
  lines.push('    void RecordPhaseEvidenceField(string phaseId, string moduleId, string fieldPath, string valueJson)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(fieldPath) || string.IsNullOrEmpty(valueJson))');
  lines.push('        {');
  lines.push('            _phaseEvidenceWriteRejectionCount++;');
  lines.push('            return;');
  lines.push('        }');
  lines.push('        int dot = fieldPath.IndexOf(".");');
  lines.push('        string fieldsJson;');
  lines.push('        if (dot > 0 && dot < fieldPath.Length - 1)');
  lines.push('        {');
  lines.push('            string parent = fieldPath.Substring(0, dot);');
  lines.push('            string child = fieldPath.Substring(dot + 1);');
  lines.push('            fieldsJson = "{\\"" + JsonEscape(parent) + "\\":{\\"" + JsonEscape(child) + "\\":" + valueJson + "}}";');
  lines.push('        }');
  lines.push('        else');
  lines.push('        {');
  lines.push('            fieldsJson = "{\\"" + JsonEscape(fieldPath) + "\\":" + valueJson + "}";');
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceObject(phaseId, moduleId, fieldsJson, "[]");');
  lines.push('    }');
  lines.push('');
  lines.push('    int GetLastKnownResourceBalance(string resourceId)');
  lines.push('    {');
  lines.push('        resourceId = GFM_ResourceIds.Normalize(resourceId);');
  lines.push('        for (int i = 0; i < _phaseEvidenceResourceBalanceCount; i++)');
  lines.push('        {');
  lines.push('            if (_phaseEvidenceResourceBalanceKeys[i] == resourceId) return _phaseEvidenceResourceBalanceValues[i];');
  lines.push('        }');
  lines.push('        return 0;');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetLastKnownResourceBalance(string resourceId, int value)');
  lines.push('    {');
  lines.push('        resourceId = GFM_ResourceIds.Normalize(resourceId);');
  lines.push('        for (int i = 0; i < _phaseEvidenceResourceBalanceCount; i++)');
  lines.push('        {');
  lines.push('            if (_phaseEvidenceResourceBalanceKeys[i] == resourceId)');
  lines.push('            {');
  lines.push('                _phaseEvidenceResourceBalanceValues[i] = value;');
  lines.push('                return;');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (_phaseEvidenceResourceBalanceCount >= _phaseEvidenceResourceBalanceKeys.Length) return;');
  lines.push('        _phaseEvidenceResourceBalanceKeys[_phaseEvidenceResourceBalanceCount] = resourceId;');
  lines.push('        _phaseEvidenceResourceBalanceValues[_phaseEvidenceResourceBalanceCount] = value;');
  lines.push('        _phaseEvidenceResourceBalanceCount++;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 向已有 JSON 对象体追加一个 signal 片段。');
  lines.push('    string AppendSignalEvidenceJson(string json, string signal, string valueJson)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(signal) || string.IsNullOrEmpty(valueJson)) return json;');
  lines.push('        if (json.Length > 0) json += ",";');
  lines.push('        json += "\\"" + JsonEscape(signal) + "\\":" + valueJson;');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 构建单个 phase id 对应的 evidence JSON 对象。');
  lines.push('    string BuildRecordedPhaseEvidenceJson(string phaseId)');
  lines.push('    {');
  lines.push('        string prefix = phaseId + ".";');
  lines.push('        string json = "";');
  lines.push('        for (int i = 0; i < _phaseEvidenceCount; i++)');
  lines.push('        {');
  lines.push('            string key = _phaseEvidenceKeys[i];');
  lines.push('            if (string.IsNullOrEmpty(key) || key.IndexOf(prefix) != 0) continue;');
  lines.push('            string signal = key.Substring(prefix.Length);');
  lines.push('            json = AppendSignalEvidenceJson(json, signal, _phaseEvidenceValues[i]);');
  lines.push('        }');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 序列化已激活/已完成 phase 的 evidence，避免为每个 phase 手写分支。');
  lines.push('    string BuildPhaseEvidenceJson()');
  lines.push('    {');
  lines.push('        string json = "{";');
  lines.push('        bool wrotePhase = false;');
  lines.push('        for (int i = 0; i < _phaseEvidencePhaseIds.Length; i++)');
  lines.push('        {');
  lines.push('            string phaseId = _phaseEvidencePhaseIds[i];');
  lines.push('            if (!PhaseEvidenceActive(phaseId)) continue; // 跳过 CUA 尚未到达的 phase');
  lines.push('            string phaseJson = BuildRecordedPhaseEvidenceJson(phaseId);');
  lines.push('            if (phaseJson.Length <= 0) continue; // 省略空 phase 对象，避免 gameObject.name 过长');
  lines.push('            if (wrotePhase) json += ",";');
  lines.push('            json += "\\"" + JsonEscape(phaseId) + "\\":{" + phaseJson + "}";');
  lines.push('            wrotePhase = true;');
  lines.push('        }');
  lines.push('        json += "}";');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将紧凑整数状态转换成可读的 build state 字符串。');
  lines.push('    string BuildEntityBuildState(int stateCode)');
  lines.push('    {');
  lines.push('        if (stateCode >= 2) return "built";');
  lines.push('        if (stateCode == 1) return "building";');
  lines.push('        return "waiting";');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将单个实体引用序列化为 CUA 可读的 state JSON。');
  lines.push('    string SerializeEntityStateJson(GameObject obj, int stateCode)');
  lines.push('    {');
  lines.push('        bool visible = obj != null && obj.transform.position.y > -900f;');
  lines.push('        Vector3 pos = obj != null ? obj.transform.position : new Vector3(0f, -999f, 0f);');
  lines.push('        string buildState = BuildEntityBuildState(stateCode);');
  lines.push('        string stateText = visible ? (stateCode > 0 ? buildState : "active") : (stateCode >= 2 ? "built_hidden" : "hidden");');
  lines.push('        string variant = visible ? buildState : "hidden";');
  lines.push('        return "{"');
  lines.push('            + "\\"state\\":\\"" + stateText + "\\","');
  lines.push('            + "\\"status\\":\\"" + stateText + "\\","');
  lines.push('            + "\\"buildState\\":\\"" + buildState + "\\","');
  lines.push('            + "\\"visible\\":" + (visible ? "true" : "false") + ","');
  lines.push('            + "\\"stateCode\\":" + stateCode + ","');
  lines.push('            + "\\"upgradeLevel\\":" + stateCode + ","');
  lines.push('            + "\\"level\\":" + stateCode + ","');
  lines.push('            + "\\"visualVariant\\":\\"" + variant + "\\","');
  lines.push('            + "\\"variant\\":\\"" + variant + "\\","');
  lines.push('            + "\\"position\\":" + SerializeVector3Json(pos)');
  lines.push('            + "}";');
  lines.push('    }');
  lines.push('');
  lines.push('    // 只把当前真的在场景中的实体纳入镜头构图，隐藏到对象池远处的物体不参与。');
  lines.push('    void TrackVisibleEntityForCameraFrame(GameObject obj, ref Vector3 min, ref Vector3 max, ref int count)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        Vector3 pos = obj.transform.position;');
  lines.push('        if (pos.y < -900f) return;');
  lines.push('        if (count == 0)');
  lines.push('        {');
  lines.push('            min = pos;');
  lines.push('            max = pos;');
  lines.push('        }');
  lines.push('        else');
  lines.push('        {');
  lines.push('            min.x = Mathf.Min(min.x, pos.x);');
  lines.push('            min.y = Mathf.Min(min.y, pos.y);');
  lines.push('            min.z = Mathf.Min(min.z, pos.z);');
  lines.push('            max.x = Mathf.Max(max.x, pos.x);');
  lines.push('            max.y = Mathf.Max(max.y, pos.y);');
  lines.push('            max.z = Mathf.Max(max.z, pos.z);');
  lines.push('        }');
  lines.push('        count++;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 每个 shot 摆完物体后自动构图：取所有可见实体包围盒，平滑移动/缩放镜头。');
  lines.push('    void FrameCurrentVisibleEntities(int ruleIdx)');
  lines.push('    {');
  lines.push('        if (mainCam == null) return;');
  lines.push('        Vector3 min = Vector3.zero;');
  lines.push('        Vector3 max = Vector3.zero;');
  lines.push('        int visibleCount = 0;');
  entityList.forEach((name) => {
    lines.push('        TrackVisibleEntityForCameraFrame(' + name + ', ref min, ref max, ref visibleCount);');
  });
  lines.push('        if (visibleCount <= 0) return;');
  lines.push('        Vector3 center = new Vector3((min.x + max.x) * 0.5f, (min.y + max.y) * 0.5f, (min.z + max.z) * 0.5f);');
  lines.push('        float spanX = Mathf.Abs(max.x - min.x);');
  lines.push('        float spanZ = Mathf.Abs(max.z - min.z);');
  lines.push('        float span = Mathf.Max(spanX, spanZ);');
  lines.push('        float targetOrtho = Mathf.Clamp(5.5f + span * 0.45f + (ruleIdx % 3) * 0.15f, 4.5f, 12f);');
  lines.push('        GFM_CameraController.Instance.FramePoint(center, targetOrtho);');
  lines.push('    }');
  lines.push('');
  lines.push('    // 判断一个可见实体是否已经落到镜头视口外，用于给 preview/CUA 输出可审计信号。');
  lines.push('    bool IsVisibleEntityOffscreen(GameObject obj)');
  lines.push('    {');
  lines.push('        if (mainCam == null || obj == null) return false;');
  lines.push('        Vector3 pos = obj.transform.position;');
  lines.push('        if (pos.y < -900f) return false;');
  lines.push('        Vector3 viewport = mainCam.WorldToViewportPoint(pos);');
  lines.push('        return viewport.z < 0f || viewport.x < 0.03f || viewport.x > 0.97f || viewport.y < 0.03f || viewport.y > 0.97f;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将落出视口的实体名追加到 JSON 数组，保持字符串拼接逻辑集中。');
  lines.push('    void AppendOffscreenEntityJson(ref string json, ref bool wrote, GameObject obj, string entityName)');
  lines.push('    {');
  lines.push('        if (!IsVisibleEntityOffscreen(obj)) return;');
  lines.push('        if (wrote) json += ",";');
  lines.push('        json += "\\"" + JsonEscape(entityName) + "\\"";');
  lines.push('        wrote = true;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 输出当前仍可见但不在镜头里的实体列表，供交付审阅定位构图问题。');
  lines.push('    string BuildOffscreenEntitiesJson()');
  lines.push('    {');
  lines.push('        string json = "[";');
  lines.push('        bool wrote = false;');
  entityList.forEach((name) => {
    lines.push('        AppendOffscreenEntityJson(ref json, ref wrote, ' + name + ', "' + csString(name) + '");');
  });
  lines.push('        json += "]";');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 统计出画实体数量，写入 cameraState 便于 preview 面板直接显示风险。');
  lines.push('    int CountOffscreenEntities()');
  lines.push('    {');
  lines.push('        int count = 0;');
  entityList.forEach((name) => {
    lines.push('        if (IsVisibleEntityOffscreen(' + name + ')) count++;');
  });
  lines.push('        return count;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 序列化所有生成实体的状态记录。');
  lines.push('    string BuildEntityStatesJson()');
  lines.push('    {');
  lines.push('        string json = "{";');
  entityList.forEach((name) => {
    lines.push('        if (json.Length > 1) json += ",";');
    lines.push(`        json += "\\"${name}\\":" + SerializeEntityStateJson(${name}, ${name}State);`);
  });
  lines.push('        json += "}";');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 将 manager 持有的资源计数写入 variables 对象。');
  lines.push('    string BuildResourceVariablesJson()');
  lines.push('    {');
  lines.push('        var mgr = GFM_EconomyManager.Instance;');
  lines.push('        string json = "";');
  lines.push('        if (mgr == null) return json;');
  lines.push('        for (int i = 0; i < mgr.InvCount; i++)');
  lines.push('        {');
  lines.push('            string key = mgr.InvKey(i);');
  lines.push('            if (string.IsNullOrEmpty(key)) continue;');
  lines.push('            json += ",\\"" + JsonEscape(key) + "\\":" + mgr.InvVal(i);');
  lines.push('        }');
  lines.push('        return json;');
  lines.push('    }');
  lines.push('');
  lines.push('    // 序列化 CUA 和 preview 轮询会检查的玩法变量。');
  lines.push('    string BuildVariablesJson()');
  lines.push('    {');
  lines.push('        float camZoom = mainCam != null ? mainCam.orthographicSize : 0f;');
  lines.push('        float camHeight = mainCam != null ? mainCam.transform.position.y : 0f;');
  lines.push('        return "{"');
  lines.push('            + "\\"gameTimer\\":" + (int)gameTimer');
  lines.push('            + ",\\"autoPlayMode\\":" + (_autoPlayMode ? "true" : "false")');
  lines.push('            + ",\\"autoPlaySteps\\":" + _autoPlaySteps');
  lines.push('            + ",\\"autoPlayStepsThisPhase\\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)');
  lines.push('            + ",\\"cameraZoom\\":" + FormatFloat(camZoom)');
  lines.push('            + ",\\"cameraHeight\\":" + FormatFloat(camHeight)');
  lines.push('            + BuildResourceVariablesJson()');
  lines.push('            + "}";');
  lines.push('    }');
  lines.push('');
  lines.push('    // 序列化当前可见的引导、分数和浮字 UI 状态。');
  lines.push('    string BuildUiStateJson()');
  lines.push('    {');
  lines.push('        string guide = guideText != null ? guideText.text : "";');
  lines.push('        string score = scoreText != null ? scoreText.text : "";');
  lines.push('        bool floatingVisible = floatingText != null && floatingTextTimer > 0f && !string.IsNullOrEmpty(floatingText.text);');
  lines.push('        string floating = floatingVisible ? floatingText.text : "";');
  lines.push('        return "{"');
  lines.push('            + "\\"guideText\\":\\"" + JsonEscape(guide) + "\\","');
  lines.push('            + "\\"scoreText\\":\\"" + JsonEscape(score) + "\\","');
  lines.push('            + "\\"floatingText\\":\\"" + JsonEscape(floating) + "\\","');
  lines.push('            + "\\"floatingTextState\\":{"');
  lines.push('            + "\\"visible\\":" + (floatingVisible ? "true" : "false")');
  lines.push('            + ",\\"text\\":\\"" + JsonEscape(floating) + "\\""');
  lines.push('            + "}"');
  lines.push('            + "}";');
  lines.push('    }');
  lines.push('');
  lines.push('    // 序列化镜头焦点和 transform，供视觉进度检查使用。');
  lines.push('    string BuildCameraStateJson()');
  lines.push('    {');
  lines.push('        float camZoom = mainCam != null ? mainCam.orthographicSize : 0f;');
  lines.push('        float camHeight = mainCam != null ? mainCam.transform.position.y : 0f;');
  lines.push('        float camYaw = mainCam != null ? mainCam.transform.eulerAngles.y : 0f;');
  lines.push('        float camPitch = mainCam != null ? mainCam.transform.eulerAngles.x : 0f;');
  lines.push('        int offscreenCount = CountOffscreenEntities();');
  lines.push('        return "{"');
  lines.push('            + "\\"focusTarget\\":\\"" + JsonEscape(cameraFocusTarget) + "\\","');
  lines.push('            + "\\"cameraFocusTarget\\":\\"" + JsonEscape(cameraFocusTarget) + "\\","');
  lines.push('            + "\\"zoomValue\\":" + FormatFloat(camZoom) + ","');
  lines.push('            + "\\"cameraZoom\\":" + FormatFloat(camZoom) + ","');
  lines.push('            + "\\"orthoSize\\":" + FormatFloat(camZoom) + ","');
  lines.push('            + "\\"heightOffset\\":" + FormatFloat(camHeight) + ","');
  lines.push('            + "\\"cameraHeight\\":" + FormatFloat(camHeight) + ","');
  lines.push('            + "\\"yaw\\":" + FormatFloat(camYaw) + ","');
  lines.push('            + "\\"cameraYaw\\":" + FormatFloat(camYaw) + ","');
  lines.push('            + "\\"pitch\\":" + FormatFloat(camPitch) + ","');
  lines.push('            + "\\"cameraPitch\\":" + FormatFloat(camPitch) + ","');
  lines.push('            + "\\"offscreenCount\\":" + offscreenCount');
  lines.push('            + "}";');
  lines.push('    }');
  return lines;
}

function _buildUpdateGameStateMethodLines(specs) {
  const lines = [];
  lines.push('    // 序列化当前运行时状态，供 preview 轮询和 CUA 验证。');
  lines.push('    void UpdateGameState()');
  lines.push('    {');
  lines.push('        string completedJson = "[";');
  lines.push('        for (int i = 0; i < completedPhaseCount; i++)');
  lines.push('        {');
  lines.push('            if (i > 0) completedJson += ",";');
  lines.push('            completedJson += "\\"" + completedPhases[i] + "\\"";');
  lines.push('        }');
  lines.push('        completedJson += "]";');
  lines.push('');
  lines.push('        string json = "{"');
  lines.push('            + "\\"currentPhase\\":\\"" + JsonEscape(currentPhaseName) + "\\","');
  lines.push('            + "\\"phaseRealTimer\\":" + FormatFloat(phaseRealTimer) + ","');
  lines.push('            + "\\"completedPhases\\":" + completedJson + ","');
  lines.push('            + "\\"entityStates\\":" + BuildEntityStatesJson() + ","');
  lines.push('            + "\\"variables\\":" + BuildVariablesJson()');
  lines.push('            + ",\\"uiState\\":" + BuildUiStateJson()');
  lines.push('            + ",\\"cameraState\\":" + BuildCameraStateJson()');
  lines.push('            + ",\\"offscreenEntities\\":" + BuildOffscreenEntitiesJson()');
  lines.push('            + ",\\"phaseEvidence\\":" + BuildPhaseEvidenceJson()');
  lines.push('            + ",\\"phaseTimestamps\\":{"');
  specs.forEach((spec, i) => {
    const comma = i < specs.length - 1 ? ',' : '';
    lines.push(`            + "\\"${spec.phaseId}\\":" + (phaseEnterTimes[${i}] > 0 ? (int)phaseEnterTimes[${i}] : 0) + "${comma}"`);
  });
  lines.push('            + "}"');
  lines.push('            + "}";');
  lines.push('');
  lines.push('        gameObject.name = "GFM|" + json;');
  lines.push('    }');
  return lines;
}

/**
 * 将骨架保存到文件。
 */
function saveSkeleton(skeleton, outputPath) {
  fs.writeFileSync(outputPath, skeleton, 'utf8');
  console.log(`[SkeletonGenerator] Skeleton saved to ${outputPath} (${(skeleton.length / 1024).toFixed(1)} KB)`);
}

module.exports = { generateSkeleton, saveSkeleton };
