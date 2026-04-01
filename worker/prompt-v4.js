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
function parseBlueprintToPromptV4(blueprint, opts) {
  opts = opts || {};
  var entities = blueprint.entities || [];
  
  // 从 nodes 提取事件规则
  var rules = blueprint.phases || [];
  if (rules.length === 0 && blueprint.nodes) {
    rules = blueprint.nodes
      .filter(function(n) { return n.type === 'phaseNode'; })
      .map(function(n) {
        var d = n.data || {};
        return {
          id: d.phaseId || 0,
          name: d.name || d.label || '',
          triggerCondition: d.triggerCondition || d.endCondition || '',
          activate: d.activate || [],
          actions: d.actions || [],
          guide: d.guide || '',
          camera: d.camera || null,
        };
      })
      .sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
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
  lines.push('在 Start() 中，你 **必须** 用 GFM_Create.Obj / GFM_Create.Ground 创建以下所有对象。');
  lines.push('漏创建任何一个都算 BUG。对象池类型预创建后隐藏在 y=-999。');
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
  lines.push('- ⛔ 禁止 autoplay/自动演示：不要让游戏在无输入下自动跑完');
  lines.push('- ⛔ 禁止 timer += dt 驱动 Phase 推进');
  lines.push('- ⛔ 禁止 auto-complete: Phase 完成条件不能是"等待N秒"');
  lines.push('');
  lines.push('## 正确做法:');
  lines.push('- ✅ 每个 Rule 的条件必须依赖玩家操作结果（eState==2, 距离<阈值, 点击目标）');
  lines.push('- ✅ 玩家必须用摇杆移动到目标位置 / 点击按钮 / 拖拽物体 才能触发 Rule');
  lines.push('- ✅ 只有玩家完成操作后才调用 AddCompletedPhase');
  lines.push('- ✅ 每个 Phase 显示引导箭头告诉玩家下一步操作');
  lines.push('');
  lines.push('## CUA 验证检测: Agent 0 个操作完成所有 Phase → FAIL; 交互变量始终为 0 → FAIL');
  lines.push('');

  // ========== 6. 代码架构要求 ==========
  lines.push('# 代码架构要求');
  lines.push('');
  lines.push('1. 所有代码在一个文件 GameFlowManagerMain.cs 中');
  lines.push('2. 用平行数组管理实体状态: eGo[], eActive[], eState[], eTimer[], eHP[]');
  lines.push('3. 每个实体一个 UpdateXxx(float dt) 方法');
  lines.push('4. Update() 中遍历所有已激活实体，分发到对应的 Update 方法');
  lines.push('5. CheckEventRules(): 检查每条规则的条件，满足且 ruleTriggered[i]==false → 执行动作 + 标记已触发');
  lines.push('   示例:');
  lines.push('   bool[] ruleTriggered = new bool[RULE_COUNT];');
  lines.push('   void CheckEventRules() {');
  lines.push('     if (!ruleTriggered[0]) { /* gameStart */ ruleTriggered[0]=true; ActivateEntities(...); }');
  lines.push('     if (!ruleTriggered[1] && eState[E_CONVEYOR]==2) { ruleTriggered[1]=true; ShowGuide(...); }');
  lines.push('     // 每条规则独立判断，不依赖其他规则的顺序');
  lines.push('   }');
  lines.push('6. 动态实体（敌人/弹药/金币）用对象池: 预创建数组，隐藏在 y=-999');
  lines.push('7. 创建3D对象: var go = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(x,y,z), new Vector3(sx,sy,sz), "Name");');
  lines.push('   签名: GFM_Create.Obj(PrimitiveType type, Vector3 position, Vector3 scale, string name)');
  lines.push('   PrimitiveType: Cube, Sphere, Cylinder, Capsule, Quad, Plane');
  lines.push('8. 创建地面: var ground = GFM_Create.Ground(width, depth); // 只有2个float参数');
  lines.push('   然后: GFM_Create.SetColor(ground, new Color(r,g,b));');
  lines.push('9. 设颜色: GFM_Create.SetColor(go, new Color(r,g,b));');
  lines.push('10. 虚拟摇杆: 在 Start() 中 var joystick = GFM_Joystick.Create(canvas, 200f);');
  lines.push('    在 Update() 中: float h = joystick.Horizontal; float v = joystick.Vertical;');
  lines.push('11. 隐藏对象: transform.position = new Vector3(0, -999, 0); 不用 SetActive(false)');
  lines.push('12. 游戏结束: Luna.Unity.LifeCycle.GameEnded()');
  lines.push('13. CTA: Luna.Unity.Playable.InstallFullGame()');
  lines.push('14. UI: Canvas canvas = GFM_UI.CreateCanvas(960, 540); // returns Canvas, not GameObject!');
  lines.push('    Text txt = GFM_UI.CreateText(canvas, "text", new Vector2(x,y), fontSize); // param1 must be Canvas type');
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

module.exports = { parseBlueprintToPromptV4: parseBlueprintToPromptV4 };
