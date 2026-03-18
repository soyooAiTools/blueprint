/**
 * Blueprint V5 Prompt Generator — 基础样例工程模式
 * 
 * 核心变化：场景已预制 242 个对象，AI 只需 Find + Move + 写逻辑
 * 不再需要 GFM_Create.Obj / GFM_UI.CreateCanvas 等创建 API
 */

var fs = require('fs');
var path = require('path');

// 加载行为模板文档
var BEHAVIOR_TEMPLATES = '';
try {
  BEHAVIOR_TEMPLATES = fs.readFileSync(path.join(__dirname, 'behavior-templates.md'), 'utf-8');
} catch(e) {
  console.error('[prompt-v5] Warning: behavior-templates.md not found');
}

// ========== 预制对象清单 ==========
var PREFAB_REGISTRY = {
  // 通用
  Player: { shape: 'Cube', scale: '1×2×1', color: '蓝(0.2,0.4,0.9)', count: 1 },
  Ground: { shape: 'Plane', scale: '10×1×10', color: '棕绿', count: 1 },
  Wall: { shape: 'Cube(扁长)', scale: '4×1×0.3', color: '深灰', count: 10 },
  Coin: { shape: 'Sphere(小)', scale: '0.4', color: '金', count: 15 },
  Gem: { shape: 'Sphere(小)', scale: '0.4', color: '紫', count: 10 },
  // SLG/塔防
  Building: { shape: 'Cube(大)', scale: '2×2×2', color: '棕', count: 8 },
  Turret: { shape: 'Cylinder(小)', scale: '0.6×1×0.6', color: '灰', count: 8 },
  Castle: { shape: 'Cube(超大)', scale: '4×4×4', color: '石灰', count: 2 },
  Farm: { shape: 'Cube(扁)', scale: '2×0.5×2', color: '浅绿', count: 5 },
  Mine: { shape: 'Cube', scale: '1.5', color: '深棕', count: 5 },
  Barracks: { shape: 'Cube(中)', scale: '2×1.5×2', color: '暗红', count: 3 },
  Worker: { shape: 'Cube(小)', scale: '0.8×1.2×0.8', color: '橙', count: 8 },
  Soldier: { shape: 'Cube(小)', scale: '0.8×1.4×0.8', color: '军绿', count: 10 },
  Archer: { shape: 'Cylinder(小)', scale: '0.5×1.2×0.5', color: '棕', count: 8 },
  Flag: { shape: 'Cylinder(细高)', scale: '0.15×2×0.15', color: '红', count: 5 },
  Shield: { shape: 'Sphere(扁)', scale: '1×0.2×1', color: '银', count: 5 },
  // 射击/战斗
  Enemy: { shape: 'Sphere', scale: '1', color: '红', count: 15 },
  Boss: { shape: 'Sphere(大)', scale: '2', color: '暗红', count: 3 },
  Arrow: { shape: 'Cube(细长)', scale: '0.1×0.1×1', color: '白', count: 15 },
  Bullet: { shape: 'Sphere(极小)', scale: '0.2', color: '黄', count: 15 },
  Bomb: { shape: 'Sphere(中)', scale: '0.8', color: '黑', count: 8 },
  Sword: { shape: 'Cube(细长)', scale: '0.1×1.5×0.15', color: '银', count: 5 },
  // 太空
  Spaceship: { shape: 'Cube(流线)', scale: '1.5×0.5×2.5', color: '银蓝', count: 5 },
  Satellite: { shape: 'Sphere', scale: '0.8', color: '银', count: 5 },
  Asteroid: { shape: 'Sphere(大)', scale: '1.5×1.2×1.5', color: '深灰棕', count: 10 },
  SpaceStation: { shape: 'Cube(超大)', scale: '5×3×5', color: '白灰', count: 2 },
  Planet: { shape: 'Sphere(大)', scale: '4', color: '蓝绿', count: 3 },
  Rocket: { shape: 'Cylinder(长)', scale: '0.3×2×0.3', color: '白红', count: 5 },
  // 装饰/环境
  Tree: { shape: 'Cylinder+Sphere组合', scale: '树干+树冠', color: '绿', count: 15 },
  Rock: { shape: 'Sphere(扁)', scale: '1×0.6×1', color: '灰', count: 10 },
  Bush: { shape: 'Sphere(小)', scale: '0.8×0.5×0.8', color: '深绿', count: 8 },
  Water: { shape: 'Plane', scale: '5×1×5', color: '浅蓝', count: 3 },
  Road: { shape: 'Cube(扁长)', scale: '4×0.1×1', color: '灰白', count: 8 },
  Bridge: { shape: 'Cube(扁长)', scale: '3×0.2×1.5', color: '木色', count: 3 },
};

// UI 预制
var UI_PREFABS = [
  'CTA_Button (Button)', 'ScoreText (Text)', 'HPBar_1~3 (Slider)',
  'ResourcePanel (Panel)', 'GuideHand (Image)', 'Timer (Text)'
];

/**
 * 根据蓝图实体列表，匹配预制对象名
 * 返回 AI 应该 Find 的对象清单
 */
function matchPrefabs(entities) {
  var used = {};
  var counters = {};
  
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var template = (e.template || 'Static').toLowerCase();
    var name = (e.name || '').toLowerCase();
    
    // 尝试匹配预制名
    var prefabName = null;
    var prefabKeys = Object.keys(PREFAB_REGISTRY);
    
    for (var j = 0; j < prefabKeys.length; j++) {
      var pk = prefabKeys[j];
      if (name.indexOf(pk.toLowerCase()) >= 0 || pk.toLowerCase().indexOf(name) >= 0) {
        prefabName = pk;
        break;
      }
    }
    
    // 按模板猜测
    if (!prefabName) {
      if (template.indexOf('player') >= 0) prefabName = 'Player';
      else if (template.indexOf('mover') >= 0 && template.indexOf('damageable') >= 0) prefabName = 'Enemy';
      else if (template.indexOf('shooter') >= 0) prefabName = 'Turret';
      else if (template.indexOf('buildable') >= 0) prefabName = 'Building';
      else if (template.indexOf('spawner') >= 0) prefabName = 'Building';
      else if (template.indexOf('collectible') >= 0) prefabName = 'Coin';
      else if (template.indexOf('projectile') >= 0) prefabName = 'Arrow';
      else if (template.indexOf('mover') >= 0) prefabName = 'Soldier';
      else prefabName = 'Building'; // fallback
    }
    
    if (!counters[prefabName]) counters[prefabName] = 0;
    counters[prefabName]++;
    
    var instanceName = prefabName === 'Player' ? 'Player' : prefabName + '_' + counters[prefabName];
    used[e.name] = instanceName;
  }
  
  return used;
}

/**
 * V5 蓝图 → AI Prompt（基础样例工程模式）
 */
function parseBlueprintToPromptV5(blueprint, opts) {
  opts = opts || {};
  var entities = blueprint.entities || [];
  
  // 从 nodes 提取事件规则（同 V4 逻辑）
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

  // triggerCondition 自动转换（同 V4）
  for (var ri = 0; ri < rules.length; ri++) {
    if (!rules[ri].triggerCondition) {
      if (ri === 0) rules[ri].triggerCondition = 'gameStart';
      else if (rules[ri - 1] && rules[ri - 1].endCondition) {
        rules[ri].triggerCondition = rules[ri - 1].endCondition;
      }
    }
  }

  var ruleMap = {};
  for (var ri = 0; ri < rules.length; ri++) {
    if (rules[ri].id && rules[ri].triggerCondition) {
      ruleMap[rules[ri].id] = rules[ri].triggerCondition;
    }
  }

  var settings = blueprint.globalSettings || {};
  var params = blueprint.globalParams || {};
  var prefabMap = matchPrefabs(entities);
  var lines = [];

  // ========== 1. 任务说明 ==========
  lines.push('# 任务');
  lines.push('在 GameFlowManagerMain.cs 中实现一个 Luna 试玩广告。');
  lines.push('');
  lines.push('## ⚡ 核心规则：基础样例工程模式');
  lines.push('场景已预制 242 个 3D 对象 + UI 元素。你 **不需要创建任何对象**。');
  lines.push('');
  lines.push('你只需要：');
  lines.push('1. `GameObject.Find("名称")` 获取对象引用');
  lines.push('2. `transform.position = new Vector3(x,y,z)` 移动到场景中（显示）');
  lines.push('3. `transform.position = new Vector3(0,-999,0)` 移到远处（隐藏）');
  lines.push('4. `GFM_Create.SetColor(obj, new Color(r,g,b))` 改颜色');
  lines.push('5. `Instantiate(obj)` 复制对象（如果预制数量不够）');
  lines.push('6. 写游戏逻辑（交互、碰撞检测、流程控制）');
  lines.push('');
  lines.push('## ⛔ 绝对禁止');
  lines.push('- 不要用 GFM_Create.Obj() / GFM_Create.Ground() — 对象已存在');
  lines.push('- 不要用 GFM_UI.CreateCanvas() — Canvas 已存在');
  lines.push('- 不要用 CreatePrimitive() — 在 Luna 中不可见');
  lines.push('- 不要用泛型 List<T> / Dictionary<K,V> — 用数组');
  lines.push('- 不要用 coroutine / async / await — 用 Update + timer');
  lines.push('- 不要用 LINQ / System.Linq');
  lines.push('');

  // ========== 2. 骨架代码 ==========
  lines.push('# 骨架代码（必须遵循此结构）');
  lines.push('```csharp');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public class GameFlowManagerMain : MonoBehaviour');
  lines.push('{');
  lines.push('    // === 对象引用（Start 中通过 Find 获取）===');
  
  // 根据蓝图实体生成引用声明
  var findLines = [];
  var entityNames = Object.keys(prefabMap);
  for (var i = 0; i < entityNames.length; i++) {
    var eName = entityNames[i];
    var pName = prefabMap[eName];
    lines.push('    GameObject ' + eName.replace(/[^a-zA-Z0-9_]/g, '_') + '; // → Find("' + pName + '")');
    findLines.push('        ' + eName.replace(/[^a-zA-Z0-9_]/g, '_') + ' = GameObject.Find("' + pName + '");');
  }
  
  lines.push('');
  lines.push('    // === 游戏状态 ===');
  lines.push('    bool[] ruleTriggered;');
  lines.push('    float gameTimer;');
  lines.push('');
  lines.push('    void Start()');
  lines.push('    {');
  lines.push('        // 1. 获取对象引用');
  for (var fi = 0; fi < findLines.length; fi++) {
    lines.push(findLines[fi]);
  }
  lines.push('');
  lines.push('        // 2. 初始化规则');
  lines.push('        ruleTriggered = new bool[' + Math.max(rules.length, 1) + '];');
  lines.push('');
  lines.push('        // 3. 摆放初始场景（移动对象到目标位置）');
  lines.push('        // player.transform.position = new Vector3(0, 1, 0);');
  lines.push('        // 其余对象保持在 y=-999（隐藏），需要时再移出来');
  lines.push('    }');
  lines.push('');
  lines.push('    void Update()');
  lines.push('    {');
  lines.push('        gameTimer += Time.deltaTime;');
  lines.push('        CheckEventRules();');
  lines.push('        // 各实体 Update 逻辑...');
  lines.push('    }');
  lines.push('');
  lines.push('    void CheckEventRules()');
  lines.push('    {');
  lines.push('        // 每条规则独立判断，条件满足且未触发 → 执行动作');
  lines.push('    }');
  lines.push('}');
  lines.push('```');
  lines.push('');

  // ========== 3. 全局设置 ==========
  if (settings.cameraProjection || settings.backgroundColor || settings.inputMethod) {
    lines.push('# 全局设置');
    if (settings.cameraProjection) lines.push('相机: ' + settings.cameraProjection + ', ' + (settings.cameraAngle || 'topDown45'));
    if (settings.backgroundColor) lines.push('背景色: ' + settings.backgroundColor);
    if (settings.inputMethod) lines.push('操控方式: ' + settings.inputMethod);
    lines.push('');
  }

  // ========== 4. 全局参数 ==========
  if (params && Object.keys(params).length > 0) {
    lines.push('# 全局参数');
    var pKeys = Object.keys(params);
    for (var pi = 0; pi < pKeys.length; pi++) {
      lines.push(pKeys[pi] + ' = ' + params[pKeys[pi]]);
    }
    lines.push('');
  }

  // ========== 5. 对象分配表 ==========
  lines.push('# 对象分配表');
  lines.push('以下是蓝图实体 → 预制对象的映射。用 GameObject.Find 获取。');
  lines.push('');
  lines.push('| 蓝图实体 | 预制对象名 | 说明 |');
  lines.push('|----------|-----------|------|');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var pName = prefabMap[e.name] || 'Building_1';
    var desc = (e.template || 'Static') + (e.label ? ' (' + e.label + ')' : '');
    lines.push('| ' + e.name + ' | ' + pName + ' | ' + desc + ' |');
  }
  lines.push('');

  // ========== 6. 实体行为描述 ==========
  lines.push('# 实体行为');
  lines.push('');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    lines.push('## ' + e.name + (e.label ? ' (' + e.label + ')' : ''));
    lines.push('预制对象: `GameObject.Find("' + (prefabMap[e.name] || 'Building_1') + '")`');
    lines.push('模板: ' + (e.template || 'Static'));
    
    if (e.visual) {
      var vis = e.visual;
      var visLine = '位置: ' + (vis.position || '待定');
      if (vis.scale) visLine += ', 缩放: ' + vis.scale;
      lines.push(visLine);
    }
    
    if (e.trigger && e.trigger.type && e.trigger.type !== 'none') {
      lines.push('触发: ' + e.trigger.type + (e.trigger.params ? ' ' + JSON.stringify(e.trigger.params) : ''));
    }
    
    if (e.behavior) {
      var bh = e.behavior;
      var bhParts = [];
      if (bh.moveSpeed !== undefined) bhParts.push('移速:' + bh.moveSpeed);
      if (bh.hp !== undefined) bhParts.push('HP:' + bh.hp);
      if (bh.fireRate !== undefined) bhParts.push('射速:' + bh.fireRate + 's');
      if (bh.damage !== undefined) bhParts.push('伤害:' + bh.damage);
      if (bh.range !== undefined) bhParts.push('射程:' + bh.range);
      if (bh.autoFire) bhParts.push('自动射击');
      if (bhParts.length > 0) lines.push('行为: ' + bhParts.join(', '));
    }
    
    lines.push('');
  }

  // ========== 7. 事件规则 ==========
  lines.push('# 事件规则');
  lines.push('每条规则独立运行。在 CheckEventRules() 中检查，条件满足且未触发 → 执行动作。');
  lines.push('');
  
  for (var ri = 0; ri < rules.length; ri++) {
    var rule = rules[ri];
    var trigger = rule.triggerCondition || '';
    if (!trigger && ri === 0) trigger = 'gameStart';
    
    lines.push('Rule ' + (rule.id || ri + 1) + ': ' + (rule.name || ''));
    lines.push('  WHEN: ' + trigger);
    if (rule.activate && rule.activate.length > 0) {
      lines.push('  → 激活对象: ' + rule.activate.join(', ') + ' (移到场景中显示)');
    }
    if (rule.actions && rule.actions.length > 0) {
      for (var ai = 0; ai < rule.actions.length; ai++) {
        var a = rule.actions[ai];
        if (a && a.type) lines.push('  → ' + a.type + ': ' + JSON.stringify(a.params || {}));
      }
    }
    if (rule.guide) lines.push('  → 显示引导: "' + rule.guide + '"');
    lines.push('');
  }

  // ========== 8. Luna 限制（精简版）==========
  lines.push('# Luna WebGL 限制（精简版）');
  lines.push('- 显示对象: `transform.position = new Vector3(x, y, z)`');
  lines.push('- 隐藏对象: `transform.position = new Vector3(0, -999, 0)`（不用 SetActive）');
  lines.push('- 改颜色: `GFM_Create.SetColor(obj, new Color(r,g,b))`');
  lines.push('- 虚拟摇杆: `var joystick = GFM_Joystick.Create(canvas, 200f);` canvas 是 Canvas 类型');
  lines.push('- 游戏结束: `Luna.Unity.LifeCycle.GameEnded()`');
  lines.push('- CTA: `Luna.Unity.Playable.InstallFullGame()`');
  lines.push('- 时间延迟: 用 `timer += Time.deltaTime; if (timer > X)` 代替 WaitForSeconds');
  lines.push('- UI 文字: `GameObject.Find("ScoreText").GetComponent<Text>().text = "xxx"`');
  lines.push('- 碰撞检测: `Vector3.Distance(a.position, b.position) < radius`');
  lines.push('- 不要用 transform.parent / SetParent / FindObjectOfType');
  lines.push('- 不要定义 class EventPool（和模板冲突）');
  lines.push('- 最后一个步骤必须有 GameEnded() + CTA 按钮');
  lines.push('');

  // ========== 9. 行为模板 ==========
  if (BEHAVIOR_TEMPLATES) {
    lines.push('# 行为模板参考');
    lines.push(BEHAVIOR_TEMPLATES);
    lines.push('');
  }

  // ========== 10. 反馈修复 ==========
  if (opts.feedback && opts.feedback.length > 0) {
    lines.push('');
    lines.push('# CUA 反馈（需修复的问题）');
    for (var fi = 0; fi < opts.feedback.length; fi++) {
      var fb = opts.feedback[fi];
      lines.push('- ' + (fb.data ? fb.data.text : JSON.stringify(fb)));
    }
    lines.push('');
  }

  // ========== 11. 现有代码 ==========
  if (opts.existingCode) {
    lines.push('');
    lines.push('# 现有代码（在此基础上修复）');
    lines.push('```csharp');
    lines.push(opts.existingCode);
    lines.push('```');
  }

  return lines.join('\n');
}

module.exports = { 
  parseBlueprintToPromptV5: parseBlueprintToPromptV5,
  PREFAB_REGISTRY: PREFAB_REGISTRY,
  matchPrefabs: matchPrefabs
};
