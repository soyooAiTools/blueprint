/**
 * Blueprint V4 Prompt Generator
 * 纯事件驱动架构：实体自带行为+触发条件，无线性 Phase
 */

var fs = require('fs');
var path = require('path');

// 加载行为模板文档
var BEHAVIOR_TEMPLATES = '';
try {
  BEHAVIOR_TEMPLATES = fs.readFileSync(path.join(__dirname, 'behavior-templates.md'), 'utf-8');
} catch(e) {
  console.error('[prompt-v4] Warning: behavior-templates.md not found');
}

/**
 * 把 phase:N 引用转换为实际条件表达式
 * 通过查找 Rule N 的 triggerCondition
 */
function resolvePhaseRef(condition, ruleMap) {
  if (!condition) return 'gameStart';
  if (condition === 'runtime') return 'runtime';
  if (condition.indexOf('phase:') === 0) {
    var phaseId = parseInt(condition.split(':')[1]);
    if (ruleMap[phaseId]) return ruleMap[phaseId];
    if (phaseId === 1) return 'gameStart';
    return 'phase_' + phaseId + '_active';
  }
  if (condition.indexOf('entity:') === 0) {
    return condition.split(':')[1];
  }
  return condition;
}

/**
 * V4 蓝图 → AI Prompt
 */
function buildRulesFromSpecs(specs) {
  var out = [];
  specs = Array.isArray(specs) ? specs : [];
  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i] || {};
    var required = Array.isArray(spec.requiredInteractions) ? spec.requiredInteractions : [];
    var entitiesRequired = Array.isArray(spec.entitiesRequired) ? spec.entitiesRequired : [];
    var showEntities = Array.isArray(spec.showEntities) ? spec.showEntities : [];
    var activate = showEntities.length ? showEntities : entitiesRequired.map(function(entity) {
      return entity && (entity.entity || entity.name || entity.id || entity);
    }).filter(Boolean);
    out.push({
      id: spec.phaseId || ('phase_' + (i + 1)),
      name: spec.phaseName || spec.name || spec.title || spec.phaseId || ('Phase ' + (i + 1)),
      triggerCondition: i === 0 ? 'gameStart' : null,
      endCondition: spec.triggerNext || (i + 1 < specs.length ? 'phase-complete:' + (spec.phaseId || ('phase_' + (i + 1))) : 'gameEnd'),
      activate: activate,
      actions: required.map(function(dsl) {
        return { type: 'requiredInteraction', params: { dsl: dsl } };
      }),
      guide: spec.playerInstruction || spec.goal || spec.autoModeHint || ''
    });
  }
  return out;
}

function resolvePromptRules(blueprint) {
  blueprint = blueprint || {};
  if (Array.isArray(blueprint.phases) && blueprint.phases.length > 0) {
    return blueprint.phases.map(function(phase) {
      return Object.assign({}, phase || {});
    });
  }
  if (Array.isArray(blueprint.specs) && blueprint.specs.length > 0) {
    return buildRulesFromSpecs(blueprint.specs);
  }
  return [];
}

function parseBlueprintToPromptV4(blueprint, opts) {
  opts = opts || {};
  blueprint = blueprint || {};
  var entities = blueprint.entities || [];
  
  // 从 phases/specs 提取事件规则。source-of-truth 已迁移到 specs；
  // 修复回路不能因为 blueprint.phases 为空就失去 phase 上下文。
  var rules = resolvePromptRules(blueprint);
  if (rules.length === 0) {
    throw new Error('No phase rules found in blueprint. Expected blueprint.specs or blueprint.phases.');
  }

  // 如果 rules 只有 endCondition 没有 triggerCondition（旧格式），自动转换
  // 上一个 rule 的 endCondition = 下一个 rule 的 triggerCondition
  for (var ri = 0; ri < rules.length; ri++) {
    if (!rules[ri].triggerCondition) {
      if (ri === 0) {
        rules[ri].triggerCondition = 'gameStart';
      } else if (rules[ri - 1].endCondition) {
        rules[ri].triggerCondition = rules[ri - 1].endCondition;
      }
    }
  }

  // 构建 ruleMap: phaseId → triggerCondition
  var ruleMap = {};
  for (var ri = 0; ri < rules.length; ri++) {
    var r = rules[ri];
    if (r.id && r.triggerCondition) {
      ruleMap[r.id] = r.triggerCondition;
    }
  }

  var settings = blueprint.globalSettings || {};
  var params = blueprint.globalParams || {};
  var lines = [];

  // ========== 1. 任务说明 ==========
  lines.push('# 任务');
  lines.push('在 GameFlowManagerMain.cs 中实现一个 Luna 试玩广告。');
  lines.push('采用【纯事件驱动架构】：');
  lines.push('- 每个实体有自己的出生条件（什么时候出现）和行为（出现后做什么）');
  lines.push('- 事件规则定义"条件→动作"，条件满足就执行，彼此独立无顺序');
  lines.push('- 没有线性 Phase/阶段概念，不要用 currentPhase 状态机');
  lines.push('- 用 bool[] ruleTriggered 跟踪哪些规则已触发');
  lines.push('');

  // ========== 2. 全局设置 ==========
  lines.push('# 全局设置');
  if (settings.cameraProjection) lines.push('相机: ' + settings.cameraProjection + ', ' + (settings.cameraAngle || 'topDown45'));
  if (settings.backgroundColor) lines.push('背景色: ' + settings.backgroundColor);
  if (settings.inputMethod) lines.push('操控方式: ' + settings.inputMethod);
  lines.push('');

  // ========== 3. 全局参数 ==========
  if (params && Object.keys(params).length > 0) {
    lines.push('# 全局参数');
    var pKeys = Object.keys(params);
    for (var pi = 0; pi < pKeys.length; pi++) {
      lines.push(pKeys[pi] + ' = ' + params[pKeys[pi]]);
    }
    lines.push('');
  }

  // ========== 4. 实体定义 ==========
  lines.push('# 实体定义（共 ' + entities.length + ' 个）');
  lines.push('');

  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var header = '## ' + e.name;
    if (e.label) header += ' (' + e.label + ')';
    lines.push(header);
    lines.push('模板: ' + e.template);

    // 视觉
    if (e.visual) {
      var vis = e.visual;
      var visLine = '外观: ' + vis.shape + '(' + vis.scale + ')';
      if (vis.color) visLine += ' 颜色' + vis.color;
      if (vis.position) visLine += ' 位置' + vis.position;
      lines.push(visLine);
    } else {
      lines.push('外观: 无（不可见实体）');
    }

    // 出生条件 - 把 phase:N 转为实际条件
    if (e.spawn) {
      var spawnLine = '出生: ';
      var resolved = resolvePhaseRef(e.spawn.condition, ruleMap);
      if (resolved === 'runtime') {
        spawnLine += '运行时动态创建（对象池）';
      } else if (resolved === 'gameStart') {
        spawnLine += '游戏开始时创建';
      } else {
        spawnLine += '当 ' + resolved + ' 时激活';
      }
      if (e.spawn.style && e.spawn.style !== 'instant') {
        spawnLine += ', 出现方式: ' + e.spawn.style;
      }
      lines.push(spawnLine);
    }

    // 触发条件
    if (e.trigger && e.trigger.type && e.trigger.type !== 'none') {
      var trigLine = '触发: ' + e.trigger.type;
      if (e.trigger.params) {
        var tp = e.trigger.params;
        if (tp.radius) trigLine += ', 距离<' + tp.radius;
        if (tp.cost) {
          var costKeys = Object.keys(tp.cost);
          var costStr = costKeys.map(function(k) { return k + ':' + tp.cost[k]; }).join(', ');
          trigLine += ', 消耗[' + costStr + ']';
        }
        if (tp.dropTarget) trigLine += ', 拖到' + tp.dropTarget + '(半径' + (tp.dropRadius || 2) + ')';
        if (tp.event) trigLine += ', 条件: ' + tp.event;
      }
      if (e.trigger.once) trigLine += ', 仅一次';
      lines.push(trigLine);
    }

    // 行为参数
    if (e.behavior) {
      var bh = e.behavior;
      var bhParts = [];
      if (bh.moveSpeed !== undefined) bhParts.push('移速:' + bh.moveSpeed);
      if (bh.moveTarget) bhParts.push('移动目标:' + bh.moveTarget);
      if (bh.hp !== undefined) bhParts.push('HP:' + bh.hp);
      if (bh.fireRate !== undefined) bhParts.push('射速:' + bh.fireRate + 's');
      if (bh.projectile) bhParts.push('弹药:' + bh.projectile);
      if (bh.damage !== undefined) bhParts.push('伤害:' + bh.damage);
      if (bh.range !== undefined) bhParts.push('射程:' + bh.range);
      if (bh.targetTag) bhParts.push('目标:' + bh.targetTag);
      if (bh.buildTime !== undefined) bhParts.push('建造时间:' + bh.buildTime + 's');
      if (bh.spawnEntity) bhParts.push('生成:' + bh.spawnEntity);
      if (bh.spawnInterval !== undefined) bhParts.push('间隔:' + bh.spawnInterval + 's');
      if (bh.maxAlive !== undefined) bhParts.push('最大存活:' + bh.maxAlive);
      if (bh.speed !== undefined) bhParts.push('飞行速度:' + bh.speed);
      if (bh.lifetime !== undefined) bhParts.push('存活时间:' + bh.lifetime + 's');
      if (bh.autoFire) bhParts.push('自动射击');
      if (bh.input) bhParts.push('输入:' + bh.input);
      if (bhParts.length > 0) {
        lines.push('行为: ' + bhParts.join(', '));
      }
      if (bh.onBuilt && bh.onBuilt.length > 0) {
        var builtActions = bh.onBuilt.map(function(a) {
          return a.type + '(' + (a.params && a.params.target || '') + ')';
        }).join(' → ');
        lines.push('建造完成: ' + builtActions);
      }
      if (bh.onArrive && bh.onArrive.length > 0) {
        var arriveActions = bh.onArrive.map(function(a) {
          return a.type + '(' + (a.params && a.params.target || '') + ')';
        }).join(' → ');
        lines.push('到达后: ' + arriveActions);
      }
      if (bh.spawnPosition) lines.push('生成位置: ' + bh.spawnPosition);
    }

    // 动作
    if (e.actions && e.actions.length > 0) {
      for (var ai = 0; ai < e.actions.length; ai++) {
        var act = e.actions[ai];
        if (act.type === 'onDeath') {
          var deathLine = '死亡: ';
          if (act.params.drop) deathLine += '掉落' + act.params.drop + '×' + (act.params.count || 1);
          if (act.params.trigger) {
            var deathTrigger = resolvePhaseRef(act.params.trigger, ruleMap);
            deathLine += ' → 触发条件: ' + deathTrigger;
          }
          lines.push(deathLine);
        } else if (act.type === 'addResource') {
          var resKeys = Object.keys(act.params);
          lines.push('拾取: +' + resKeys.map(function(k) { return act.params[k] + k; }).join(', '));
        }
      }
    }

    lines.push('');
  }

  // ========== 5. 事件规则（独立条件→动作，无顺序） ==========
  lines.push('# 事件规则');
  lines.push('每条规则独立运行。在 CheckEventRules() 中检查所有规则，条件满足且未触发过 → 执行动作。');
  lines.push('不要用 currentPhase 或 switch/case 线性流程！用 bool[] ruleTriggered 数组。');
  lines.push('');

  for (var ri = 0; ri < rules.length; ri++) {
    var rule = rules[ri];
    var trigger = rule.triggerCondition || '';
    if (!trigger && ri === 0) trigger = 'gameStart';

    lines.push('Rule ' + (rule.id || ri + 1) + ': ' + (rule.name || ''));
    lines.push('  WHEN: ' + trigger);
    if (rule.activate && rule.activate.length > 0) {
      lines.push('  → activate: ' + rule.activate.join(', '));
    }
    if (rule.actions && rule.actions.length > 0) {
      for (var ai = 0; ai < rule.actions.length; ai++) {
        var a = rule.actions[ai];
        if (a && a.type) {
          lines.push('  → ' + a.type + ': ' + JSON.stringify(a.params || {}));
        }
      }
    }
    if (rule.guide) {
      lines.push('  → showGuide: "' + rule.guide + '"');
    }
    if (rule.camera && rule.camera.lookAt) {
      lines.push('  → setCamera: lookAt=' + rule.camera.lookAt + ', zoom=' + rule.camera.zoom);
    }
    lines.push('');
  }

  // ========== 5.5 必须创建的对象清单 ==========
  lines.push('# ⚠️ 必须创建的对象清单（MANDATORY）');
  lines.push('');
  lines.push('在 Start() 中，你 **必须** 用 GameObject.Find("__Pool_Shape_Color_NN") 获取以下所有对象。');
  lines.push('⛔ 禁止 GFM_Create.Obj / GFM_Create.Ground / GFM_Create.SetColor（Luna不支持）');
  lines.push('对象池预创建后隐藏在 y=-999，需要时移到场景中。');
  lines.push('');

  var createCount = 0;
  for (var ci = 0; ci < entities.length; ci++) {
    var ce = entities[ci];
    if (!ce.visual) continue; // 跳过不可见实体
    createCount++;
    var vis = ce.visual;
    var spawnNote = '';
    if (ce.spawn) {
      var resolved = resolvePhaseRef(ce.spawn.condition, ruleMap);
      if (resolved === 'runtime') {
        spawnNote = ' → 对象池，预创建隐藏在 y=-999';
      } else if (resolved === 'gameStart') {
        spawnNote = ' → Start() 中直接创建并显示';
      } else {
        spawnNote = ' → Start() 中创建，初始隐藏 y=-999，条件满足后激活';
      }
    }
    var createLine = (createCount) + '. ' + ce.name;
    if (ce.label) createLine += '(' + ce.label + ')';
    createLine += ': ' + vis.shape + ' ' + (vis.scale || '') + ' ' + (vis.color || '');
    createLine += spawnNote;
    lines.push(createLine);
  }
  lines.push('');
  lines.push('共 ' + createCount + ' 个可见实体必须创建。场景中应有大量 3D 对象。');
  lines.push('');

  // ========== 5.6 阶段流程规则（关键！）==========
  lines.push('# 🚨🚨🚨 阶段流程规则（最高优先级！违反 = CUA 验证 100% FAIL）');
  lines.push('');
  lines.push('## 绝对禁止:');
  lines.push('- ⛔ 禁止 gameTimer / 计时器 驱动的阶段推进（如 if gameTimer > N → completePhase）');
  lines.push('- ⛔ 禁止 ForceCompleteAllPhases 或任何自动完成所有阶段的逻辑');
  lines.push('- ⛔ 禁止 timer += dt 驱动 Phase 推进');
  lines.push('- ⛔ 禁止 auto-complete: Phase 完成条件不能是"等待N秒"');
  lines.push('- ⛔ 禁止修改 AUTO_PLAY_PHASE_DURATION 的值（skeleton 设为 20f，必须保持 ≥ 15f）');
  lines.push('- ⛔ 禁止删除或修改任何带 [SKELETON] ... (DO NOT MODIFY) 注释的代码行');
  lines.push('');
  lines.push('## 正确做法:');
  lines.push('- ✅ 每个 Rule 的条件必须依赖玩家操作结果（eState==2, 距离<阈值, 点击目标）');
  lines.push('- ✅ 玩家必须用摇杆移动到目标位置 / 点击按钮 / 拖拽物体 才能触发 Rule');
  lines.push('- ✅ 只有玩家完成操作后才调用 AddCompletedPhase');
  lines.push('- ✅ 每个 Phase 显示引导箭头告诉玩家下一步操作');
  lines.push('');
  lines.push('## 🔑 AutoPlay 交互模拟（必须实现！）');
  lines.push('骨架有内置 `_autoPlayMode`（自动导航+Phase推进），用于 CUA 自动验证。');
  lines.push('骨架会在 autoPlay 玩家到达目标时调用 `OnAutoPlayArrive(string targetName)`。');
  lines.push('**你必须在 OnAutoPlayArrive 中模拟与目标的交互**，使游戏变量真正变化：');
  lines.push('```csharp');
  lines.push('void OnAutoPlayArrive(string targetName) {');
  lines.push('    // 示例：根据目标名触发对应交互逻辑');
  lines.push('    if (targetName == "crew") { rescuedCount++; gold += 10; }');
  lines.push('    if (targetName == "tree") { wood++; }');
  lines.push('    scoreText.text = "Gold: " + gold;');
  lines.push('}');
  lines.push('```');
  lines.push('- ✅ 每个实体目标都要在 OnAutoPlayArrive 中有对应处理');
  lines.push('- ✅ OnAutoPlayArrive 必须更新游戏变量（gold, score, count 等）');
  lines.push('- ✅ OnAutoPlayArrive 必须更新 UI 文字（scoreText, guideText）');
  lines.push('- ✅ OnAutoPlayArrive 可以移动/显示/隐藏实体，产生视觉变化');
  lines.push('- ⛔ 不要在 OnAutoPlayArrive 中推进 Phase — skeleton 已处理');
  lines.push('');
  lines.push('## CUA 验证检测: 交互变量始终为 0 → FAIL; 画面无变化 → FAIL');
  lines.push('');

  // ========== 6. 代码架构要求 ==========
  lines.push('# 代码架构要求');
  lines.push('');
  lines.push('1. 代码默认拆为 partial class：');
  lines.push('   - GameFlowManagerMain.cs — 生命周期 / 主流程编排');
  lines.push('   - GameFlowManagerMain.Flow.cs — 流程控制 / phase dispatch');
  lines.push('   - GameFlowManagerMain.Input.cs — 输入处理');
  lines.push('   - GameFlowManagerMain.Resource.cs — 资源系统');
  lines.push('   - GameFlowManagerMain.UI.cs — UI 系统');
  lines.push('   - GameFlowManagerMain.Scene.cs — 场景控制');
  lines.push('   - 所有文件必须用 `public partial class GameFlowManagerMain : MonoBehaviour` 或共享同名 partial class');
  lines.push('   - 不要把逻辑重新塞回主文件');
  lines.push('   - `Flow.cs` 内部按职责放置 phase-specific 方法：`Phase_<id>_Init()` / `Phase_<id>_OnTap()` / `Phase_<id>_OnAutoPlayArrive()` / `Snapshot_<id>_GateEntities()`');
  lines.push('   - `GameFlowManagerMain.cs` 不应再出现 phase-specific TODO、OnAutoPlayArrive 大 switch、或 Snapshot helper');
  lines.push('   - 本 prompt 只生成 Luna/WebGL staging 代码，不是程序员 Unity 交付工程；`GameObject.Find("__Pool_*")`、`GFM_*` 和并行数组规则不得带入 `gmp-v14` 或 `unitycomponent-v1` 程序员交付包');
  lines.push('   - storyboard2html/source HTML/WebGL parity 是事实源；不要在 C# 中改写 phase、guideText、targetSequence、entity/resource/gate 语义');
  lines.push('   - 需要交付 Unity WebGL 时，最终 WebGL 必须来自 Unity Editor 原生 `BuildTarget.WebGL` 构建；不要把 hand-written HTML/JS、source preview、Luna preview 或报告替身声明成 Unity WebGL');
  lines.push('   - source HTML 的 HUD、world label、camera、targetRing / marker 是视觉合同；Unity/WebGL 侧只能继承并验证，不能用近似布局、固定 label 或 phase-index-only 目标兜底');
  lines.push('   - 程序员 Unity 交付另走 profile：默认 `gmp-v14` legacy；显式 `unitycomponent-v1` 才输出 UnityComponent(3) `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}` 和 UnityDeliverySpec');
  lines.push('   - 关键字段、复杂方法、跨 phase 状态和多参数 helper 的中文注释必须紧邻定义或调用，不能只在文件顶部给一段总注释');
  lines.push('   - 多行 if 条件或含 && / || 的条件链，必须在前一行写注释解释该条件的业务意图');
  lines.push('2. 用平行数组管理实体状态: eGo[], eActive[], eState[], eTimer[], eHP[]');
  lines.push('3. 每个实体一个 UpdateXxx(float dt) 方法');
  lines.push('4. Update() / HandlePlayerInteractions() / OnAutoPlayArrive() 必须保持轻量，只负责直接调用更小的方法');
  lines.push('5. 注释要少而准：关键字段、复杂方法、跨 phase 状态和复杂条件写清用途/单位/边界/副作用；自解释字段、简单 getter 和单行 guard 不要机械补注释');
  lines.push('6. 禁止 GFM_Event / UnityEvent / event Action / AddListener / SendMessage / BroadcastMessage，方法必须直接调用');
  lines.push('7. CheckEventRules(): 检查每条规则的条件，满足且 ruleTriggered[i]==false → 执行动作 + 标记已触发');
  lines.push('   示例:');
  lines.push('   bool[] ruleTriggered = new bool[RULE_COUNT];');
  lines.push('   void CheckEventRules() {');
  lines.push('     if (!ruleTriggered[0]) { /* gameStart */ ruleTriggered[0]=true; ActivateEntities(...); }');
  lines.push('     if (!ruleTriggered[1] && eState[E_CONVEYOR]==2) { ruleTriggered[1]=true; ShowGuide(...); }');
  lines.push('     // 每条规则独立判断，不依赖其他规则的顺序');
  lines.push('   }');
  lines.push('8. 动态实体（敌人/弹药/金币）用对象池: 预创建数组，隐藏在 y=-999');
  lines.push('9. 获取3D对象: var go = GameObject.Find("__Pool_Cube_Red_01"); // 从预制池获取');
  lines.push('   go.transform.position = new Vector3(x,y,z); // 移到场景中=显示');
  lines.push('   go.transform.localScale = new Vector3(sx,sy,sz); // 设置大小');
  lines.push('   可用池对象: __Pool_{Cube|Sphere|Cylinder}_{Red|Blue|Green|Yellow|Brown|White|Gray}_{01-99}');
  lines.push('8. 地面已存在: var ground = GameObject.Find("__Ground");');
  lines.push('9. ⛔ 禁止: GFM_Create.Obj(), GFM_Create.Ground(), GFM_Create.SetColor(), CreatePrimitive()');
  lines.push('   池对象颜色已烘焙，直接用不同颜色后缀的池对象代替SetColor');
  lines.push('10. 虚拟摇杆: 在 Start() 中 var joystick = GFM_Joystick.Create(canvas, 200f);');
  lines.push('    在 Update() 中: float h = joystick.Horizontal; float v = joystick.Vertical;');
  lines.push('11. 隐藏对象: transform.position = new Vector3(0, -999, 0); 不用 SetActive(false)');
  lines.push('12. 游戏结束: Luna.Unity.LifeCycle.GameEnded() 之后必须立刻 ShowCTA()');
  lines.push('13. CTA: Luna.Unity.Playable.InstallFullGame()');
  lines.push('14. UI: Canvas canvas = GFM_UI.CreateCanvas(1920, 1080); // returns Canvas, not GameObject!');
  lines.push('    Text txt = GFM_UI.CreateText(canvas, "text", new Vector2(x,y), fontSize); // param1 must be Canvas type');
  lines.push('    不要直接写 Text.font/fontSize/alignment/horizontalOverflow；创建后只更新 .text');
  lines.push('15. 音频: GFM_Audio (如需要)');
  lines.push('');
  lines.push('⚠️ 重要：没有 GFM_Tools 类！可用类名: GFM_Create, GFM_Utils, GFM_UI, GFM_Joystick, GFM_Audio');
  lines.push('⚠️ 不要用 CreatePrimitive, Resources.Load, async/await, 协程, List<T>（用数组）');
  lines.push('');
  lines.push('# ⚠️ Luna WebGL 运行时限制（必读！违反会导致运行时崩溃）');
  lines.push('');
  lines.push('1. **不要访问 .transform.parent** — Luna 中 parent 可能为 undefined，直接崩溃');
  lines.push('2. **不要用 transform.SetParent()** — 改用 GFM_UI 创建 UI 元素（它内部处理了层级）');
  lines.push('3. **AddComponent 后 Start()/Awake() 不会自动调用** — 手动调用 comp.Start()');
  lines.push('4. **不要用 FindObjectOfType / FindObjectsOfType** — Luna 中可能返回 null');
  lines.push('5. **不要用 GetComponentInChildren / GetComponentInParent** — 层级遍历不稳定');
  lines.push('6. **所有对象引用保存在成员变量或数组中** — 不要运行时查找，创建时就存好引用');
  lines.push('7. **UI 元素只通过 GFM_UI.CreateText / GFM_UI.CreateButton 创建** — 不要手动 new GameObject + AddComponent<Text>');
  lines.push('8. **不要定义 class EventPool** — 和模板冲突（CS0101），如需事件直接用 delegate/Action');
  lines.push('');

  // ========== 7. 行为模板参考 ==========
  if (BEHAVIOR_TEMPLATES) {
    lines.push('# 行为模板参考');
    lines.push(BEHAVIOR_TEMPLATES);
    lines.push('');
  }

  // ========== 8. 反馈修复（如有）==========
  if (opts.feedback && opts.feedback.length > 0) {
    lines.push('');
    lines.push('# CUA 反馈（需修复的问题）');
    for (var fi = 0; fi < opts.feedback.length; fi++) {
      var fb = opts.feedback[fi];
      lines.push('- ' + (fb.data ? fb.data.text : JSON.stringify(fb)));
    }
    lines.push('');
  }

  // ========== 8. 现有代码（如有）==========
  if (opts.existingCode) {
    lines.push('');
    lines.push('# 现有代码（请在此基础上修复）');
    lines.push('```csharp');
    lines.push(opts.existingCode);
    lines.push('```');
  }

  return lines.join('\n');
}

module.exports = {
  parseBlueprintToPromptV4: parseBlueprintToPromptV4,
  buildRulesFromSpecs: buildRulesFromSpecs,
  resolvePromptRules: resolvePromptRules
};
