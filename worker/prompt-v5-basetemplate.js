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
  // 对象池实际名称（和场景模板 0.json 完全一致）
  var pools = {
    Cube: { prefix: '__Pool_Cube_', total: 50, next: 1 },
    Sphere: { prefix: '__Pool_Sphere_', total: 20, next: 1 },
    Plane: { prefix: '__Pool_Plane_', total: 10, next: 1 },
    Cylinder: { prefix: '__Pool_Cylinder_', total: 10, next: 1 }
  };
  var used = {};

  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var template = (e.template || 'Static').toLowerCase();
    var name = (e.name || '').toLowerCase();

    // 根据实体类型选择形状
    var shape = 'Cube'; // default
    if (template.indexOf('projectile') >= 0 || name.indexOf('bullet') >= 0 || name.indexOf('ball') >= 0 || name.indexOf('coin') >= 0 || name.indexOf('gem') >= 0 || name.indexOf('sphere') >= 0) {
      shape = 'Sphere';
    } else if (template.indexOf('ground') >= 0 || name.indexOf('ground') >= 0 || name.indexOf('floor') >= 0 || name.indexOf('plane') >= 0 || name.indexOf('water') >= 0) {
      shape = 'Plane';
    } else if (name.indexOf('tower') >= 0 || name.indexOf('turret') >= 0 || name.indexOf('pillar') >= 0 || name.indexOf('cylinder') >= 0 || name.indexOf('tree') >= 0 || name.indexOf('pole') >= 0) {
      shape = 'Cylinder';
    }

    var pool = pools[shape];
    if (pool.next <= pool.total) {
      var num = pool.next < 10 ? '0' + pool.next : '' + pool.next;
      used[e.name] = pool.prefix + num;
      pool.next++;
    } else {
      // Pool exhausted, fall back to Cube pool
      var fallback = pools.Cube;
      if (fallback.next <= fallback.total) {
        var fn = fallback.next < 10 ? '0' + fallback.next : '' + fallback.next;
        used[e.name] = fallback.prefix + fn;
        fallback.next++;
      } else {
        // All pools exhausted — use last available
        used[e.name] = '__Pool_Cube_50';
      }
    }
  }

  return used;
}

/**
 * 检测 matchPrefabs 映射中的冲突（多个实体映射到同一个池对象）
 */
function detectPrefabCollisions(prefabMap) {
  var reverse = {};  // poolName → [entityName, ...]
  var keys = Object.keys(prefabMap);
  for (var i = 0; i < keys.length; i++) {
    var poolName = prefabMap[keys[i]];
    if (!reverse[poolName]) reverse[poolName] = [];
    reverse[poolName].push(keys[i]);
  }
  var collisions = [];
  var rKeys = Object.keys(reverse);
  for (var j = 0; j < rKeys.length; j++) {
    if (reverse[rKeys[j]].length > 1) {
      collisions.push({ pool: rKeys[j], entities: reverse[rKeys[j]] });
    }
  }
  return collisions;
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
  lines.push('## 骨架已预创建的变量（直接使用，不要重新创建）');
  lines.push('- `Camera mainCam` — 已缓存的相机，绝对不要用 Camera.main，用 mainCam');
  lines.push('- `Canvas uiCanvas` — 已创建的 Canvas，不要再创建');
  lines.push('- `Text guideText` — 引导文字，设 guideText.text = "..." 更新');
  lines.push('- `Text scoreText` — 分数文字，设 scoreText.text = "..." 更新');
  lines.push('');
  lines.push('## ⛔ 绝对禁止');
  lines.push('- **绝对不要用 Camera.main** — 用 mainCam，操作前 if (mainCam != null)');
  lines.push('- **绝对不要用 GFM_UI.CreateCanvas()** — 用 uiCanvas');
  lines.push('- **绝对不要用 SetActive()** — Luna 中会导致对象永久消失');
  lines.push('- 不要用 GFM_Create.Obj() / GFM_Create.Ground() — 对象已存在');
  lines.push('- 不要用 CreatePrimitive() — 在 Luna 中不可见');
  lines.push('- 不要用泛型 List<T> / Dictionary<K,V> — 用数组');
  lines.push('- 不要用 coroutine / async / await — 用 Update + timer');
  lines.push('- 不要用 LINQ / System.Linq');
  lines.push('');

  // ========== 1b. 防纯色屏规则 ==========
  lines.push('## 防纯色屏规则（CRITICAL — 违反会导致构建失败）');
  lines.push('');
  lines.push('1. **地面必须用中性灰色**：Ground/GroundField Plane 颜色必须用灰色调（推荐 (0.75, 0.78, 0.82)），禁止饱和绿/蓝/棕。地面占满画面，饱和色触发纯色检测。');
  lines.push('2. **Camera.backgroundColor 必须与地面反差 ≥ 0.3**（任一 RGB 通道）。推荐深天蓝 (0.35, 0.55, 0.75)（与灰色地面 R 通道差 0.40）。禁止用浅色如 (0.75, 0.82, 0.92)，会与地面融合触发纯色检测。');
  lines.push('3. **主要对象 scale 足够大**：BaseCastle、PlayerHero 等主要实体至少一个维度 scale ≥ 1.5，确保在正交相机下可见。');
  lines.push('4. **对象颜色与地面有对比**：所有可见对象颜色与地面颜色差值（任一通道）≥ 0.25。');
  lines.push('5. **Rule 0 (gameStart) 必须在第一帧移动至少 3 个不同颜色的对象到 y ≥ 0**：确保画面不是纯色。');
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
    findLines.push('        ' + eName.replace(/[^a-zA-Z0-9_]/g, '_') + ' = GameObject.Find("' + pName + '"); // MUST NOT be null — verify pool name matches');
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
  lines.push('以下是蓝图实体 → 场景对象的映射。用 GameObject.Find 获取。');
  lines.push('对象名格式为 __Pool_[Shape]_[Number]，这些是场景中已存在的 3D 对象。');
  lines.push('');
  lines.push('| 蓝图实体 | 场景对象名 | 说明 |');
  lines.push('|----------|-----------|------|');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var pName = prefabMap[e.name] || '__Pool_Cube_01';
    var desc = (e.template || 'Static') + (e.label ? ' (' + e.label + ')' : '');
    lines.push('| ' + e.name + ' | ' + pName + ' | ' + desc + ' |');
  }
  lines.push('');

  // 检测池对象冲突
  var collisions = detectPrefabCollisions(prefabMap);
  if (collisions.length > 0) {
    lines.push('⚠️ **POOL COLLISION WARNING**: The following pool objects are shared by multiple entities:');
    for (var ci = 0; ci < collisions.length; ci++) {
      lines.push('- `' + collisions[ci].pool + '` is used by: ' + collisions[ci].entities.join(', '));
    }
    lines.push('Only one entity can use each pool object. For colliding entities, you MUST use different pool objects or merge them into a single logical entity.');
    lines.push('');
  }

  // 检测总实体数是否超过池容量
  var totalPool = 50 + 20 + 10 + 10; // Cube + Sphere + Plane + Cylinder = 90
  if (entities.length > totalPool) {
    lines.push('⚠️ **POOL EXHAUSTION WARNING**: ' + entities.length + ' entities exceed the pool capacity of ' + totalPool + ' objects. Some entities share the same pool object — merge or reduce entity count.');
    lines.push('');
  }

  // ========== 6. 实体行为描述 ==========
  lines.push('# 实体行为');
  lines.push('');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    lines.push('## ' + e.name + (e.label ? ' (' + e.label + ')' : ''));
    lines.push('场景对象: `GameObject.Find("' + (prefabMap[e.name] || '__Pool_Cube_01') + '")`');
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
  lines.push('');
  lines.push('## 场景对象池（已存在，直接 Find 使用）');
  lines.push('场景中预置了 90 个 3D 对象，名称如下：');
  lines.push('- `__Pool_Cube_01` ~ `__Pool_Cube_50`（50 个 Cube）');
  lines.push('- `__Pool_Sphere_01` ~ `__Pool_Sphere_20`（20 个 Sphere）');
  lines.push('- `__Pool_Plane_01` ~ `__Pool_Plane_10`（10 个 Plane）');
  lines.push('- `__Pool_Cylinder_01` ~ `__Pool_Cylinder_10`（10 个 Cylinder）');
  lines.push('- 其他固定对象：`Main Camera`、`Directional Light`、`EventSystem`、`GameManager`、`__MaterialSource`');
  lines.push('');
  lines.push('初始时所有 __Pool_* 对象位于 (0, -999, 0)（不可见）。');
  lines.push('要显示对象：`obj.transform.position = new Vector3(x, y, z);`');
  lines.push('要隐藏对象：`obj.transform.position = new Vector3(0, -999, 0);`（不用 SetActive）');
  lines.push('');
  lines.push('## 操作 API');
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
  
  // ========== 8b. 阶段流程规则（关键！）==========
  lines.push('# 🚨🚨🚨 阶段流程规则（最高优先级！违反 = 100% FAIL）');
  lines.push('');
  lines.push('## 绝对禁止 (这些会导致 CUA 验证直接 FAIL):');
  lines.push('- ⛔ 禁止 ForceCompleteAllPhases 或任何"超时强制完成所有阶段"的逻辑');
  lines.push('- ⛔ 禁止 gameTimer/计时器 驱动的阶段推进（如 if gameTimer > 10 then completePhase）');
  lines.push('- ⛔ 禁止 autoplay/自动演示：不要写代码让游戏自动完成步骤');
  lines.push('- ⛔ 禁止在 Update() 中用 timer += dt 来自动推进 Phase');
  lines.push('- ⛔ 禁止在 CheckEventRules 中仅靠时间条件触发 Rule (如 gameTimer > N)');
  lines.push('- ⛔ 禁止 auto-complete / auto-advance：Phase 结束条件不能是"等待N秒"');
  lines.push('');
  lines.push('## 正确做法:');
  lines.push('- ✅ 每个 Phase 必须通过玩家交互（摇杆移动到位/点击/拖拽）才能推进');
  lines.push('- ✅ Rule 的 WHEN 条件必须依赖玩家操作结果（eState==2, 距离<阈值, 金币>=N 且玩家点击）');
  lines.push('- ✅ CheckEventRules 中：Rule触发 = 设置 currentPhaseName + 激活对象 + 显示引导');
  lines.push('- ✅ 只有当玩家完成当前阶段的操作后，才调用 AddCompletedPhase 并进入下一条 Rule');
  lines.push('- ✅ 引导(guide)要清晰告诉玩家下一步操作（如"用摇杆移动到传送带"、"点击建造"）');
  lines.push('- ✅ 每个阶段之间要有明显的视觉变化（对象出现、颜色变化、UI更新）');
  lines.push('');
  lines.push('## 示例:');
  lines.push('- ✅ 正确: Rule1(gameStart)→显示引导"用摇杆移到冰矿"→玩家移动到冰矿附近→自动采集→Rule2触发');
  lines.push('- ✅ 正确: Rule2→显示引导"把冰搬到机器"→玩家移到机器旁→eState[MACHINE]==2→Rule3触发');
  lines.push('- ❌ 错误: Rule1→gameTimer>2→强制完成→Rule2→gameTimer>4→强制完成（这是 autoplay！验证必 FAIL）');
  lines.push('- ❌ 错误: if(timer > 3f) { AddCompletedPhase("xxx"); } （timer 驱动 = FAIL）');
  lines.push('');
  lines.push('## CUA 验证器会检测:');
  lines.push('- Agent 0 个操作就完成所有 Phase → 判定 autoplay → FAIL');
  lines.push('- 所有交互变量(gold, carrying等)始终为0 → 判定无交互 → FAIL');
  lines.push('- Phase 间隔均匀 <3秒 → 判定 timer 驱动 → FAIL');
  lines.push('');

  // ========== 8c. 数值平衡与节奏控制（关键！）==========
  lines.push('# 数值平衡与节奏控制（必须严格遵守）');
  lines.push('');
  lines.push('## ⛔ 禁止 gameTimer 驱动（最常见的 autoplay 原因）');
  lines.push('- ⛔ 禁止: if (gameTimer > N) { AddCompletedPhase(...); } — 这是 autoplay');
  lines.push('- ⛔ 禁止: phaseTimer += dt; if (phaseTimer > 3) { nextPhase(); } — 这是 autoplay');
  lines.push('- ⛔ 禁止: eTimer[i] += dt; if (eTimer[i] > buildTime) { ... AddCompletedPhase } — 计时器不能直接完成 Phase');
  lines.push('- ✅ 正确: eTimer[i] 可以用于建造动画/冷却，但 Phase 完成必须等玩家下一个操作（移到下个目标/点击）');
  lines.push('- ✅ 正确: 建造完成后显示引导箭头，等玩家移到新目标后才 AddCompletedPhase');
  lines.push('');
  lines.push('## 禁止自动射击/自动攻击');
  lines.push('- ⛔ 弩炮/箭塔/防御建筑 禁止自动射击（auto-shoot）');
  lines.push('- ✅ 攻击必须由玩家点击触发（点击弩炮 → 射击最近敌人）');
  lines.push('- ✅ 如果需要辅助射击（玩家长时间不操作），间隔必须 >= 8秒，且伤害减半');
  lines.push('');
  lines.push('## 每个 Phase 必须有交互门槛');
  lines.push('- ⛔ 禁止纯数值触发下一阶段（如 enemyKillCount >= 3 就自动跳 phase）');
  lines.push('- ✅ 数值条件满足后，还需要玩家执行一个操作才能推进（移动到位/点击/拖拽）');
  lines.push('- ✅ 每个 Phase 玩家至少需要 2 次主动交互（点击/拖拽/移动到指定位置）');
  lines.push('');
  lines.push('## 所有可建造实体必须真正完成建造');
  lines.push('- ✅ 如果分镜包含"建造木屋"→ woodHouseState 必须达到 2（built）');
  lines.push('- ✅ 如果分镜包含"建造炮塔"→ turretState 必须达到 2（built）');
  lines.push('- ⛔ 禁止跳过中间建造阶段直接进入 Boss 战');
  lines.push('');
  lines.push('## 资源收集必须有明确交互');
  lines.push('- ⛔ 禁止靠近自动捡取（proximity auto-collect）');
  lines.push('- ✅ 木头/资源必须通过点击或拖拽收集');
  lines.push('- ✅ 资源投递到建筑必须有搬运过程（玩家移动或工人搬运动画）');
  lines.push('');
  lines.push('## 节奏控制');
  lines.push('- ✅ 每个 Phase 最少停留 8 秒（用 phaseTimer 计时，不满足就不触发下一条 Rule）');
  lines.push('- ✅ Boss 战 HP 必须足够高，确保战斗持续 10-15 秒');
  lines.push('- ✅ 敌人刷新间隔 >= 3 秒，同时存活敌人上限 <= 3 个（前期）');
  lines.push('');
  lines.push('## CUA 验证会检查以下项目（不满足 = FAIL）');
  lines.push('- completedPhases 必须包含所有 Phase（跳过任何一个 = FAIL）');
  lines.push('- 所有可建造实体的 entityState 必须 = 2（未建成 = FAIL）');
  lines.push('- 这意味着你不能为了让 CUA 容易通过而简化玩法，必须保留完整交互流程');
  lines.push('');

  // ========== 9. 行为模板 ==========
  if (BEHAVIOR_TEMPLATES) {
    lines.push('# 行为模板参考');
    lines.push(BEHAVIOR_TEMPLATES);
    lines.push('');
  }

  // ========== 10. 反馈修复（结构化 JSON + legacy text fallback）==========
  if (opts.feedback && opts.feedback.length > 0) {
    lines.push('');
    lines.push('# CUA Feedback (Issues to Fix)');

    // Safety cap: only render the last 2 feedback entries to prevent prompt bloat
    var feedbackToRender = opts.feedback.length > 2 ? opts.feedback.slice(-2) : opts.feedback;
    for (var fi = 0; fi < feedbackToRender.length; fi++) {
      var fb = feedbackToRender[fi];
      var roundLabel = fb.source ? (' [' + fb.source + ']') : '';
      lines.push('## Feedback' + roundLabel);

      // Structured feedback rendering
      if (fb.data && fb.data.structured) {
        var s = fb.data.structured;
        lines.push('**Round ' + s.round + ' — ' + s.summary + '**');
        lines.push('');

        // Render each issue as actionable item
        for (var ii = 0; ii < s.issues.length; ii++) {
          var issue = s.issues[ii];
          lines.push('### Issue ' + (ii + 1) + ': [' + issue.type + '] (severity: ' + issue.severity + ')');
          lines.push(issue.message);
          if (issue.fix_hint) {
            lines.push('**How to fix:** ' + issue.fix_hint);
          }
          if (issue.details && issue.details.missing) {
            lines.push('Missing phases:');
            for (var mi = 0; mi < issue.details.missing.length; mi++) {
              var mp = issue.details.missing[mi];
              lines.push('  - ' + mp.phaseId + (mp.trigger ? ' (trigger: ' + mp.trigger + ')' : ''));
            }
          }
          if (issue.details && issue.details.entities) {
            lines.push('Incomplete entities:');
            for (var ei = 0; ei < issue.details.entities.length; ei++) {
              var ent = issue.details.entities[ei];
              lines.push('  - ' + ent.entity + ': current=' + ent.currentState + ', required=' + ent.requiredState + ' (' + ent.stateLabel + ')');
            }
          }
          lines.push('');
        }

        // Game state context
        if (s.gameState && s.gameState.completedPhases) {
          lines.push('### Game State at Failure');
          lines.push('- Current Phase: ' + (s.gameState.currentPhase || 'unknown'));
          lines.push('- Completed Phases: ' + (s.gameState.completedPhases.join(', ') || 'none'));
          if (s.gameState.entityStates) lines.push('- Entity States: ' + JSON.stringify(s.gameState.entityStates));
          if (s.gameState.variables) lines.push('- Variables: ' + JSON.stringify(s.gameState.variables));
          lines.push('');
        }

        // Console errors
        if (s.consoleErrors && s.consoleErrors.length > 0) {
          lines.push('### Console Errors');
          for (var ce = 0; ce < s.consoleErrors.length; ce++) {
            lines.push('- ' + s.consoleErrors[ce]);
          }
          lines.push('');
        }

        // Fix history warning
        if (s.fixHistory && s.fixHistory.length > 1) {
          lines.push('### Fix History (DO NOT repeat these approaches)');
          var historyToShow = s.fixHistory.slice(-3);
          for (var fhi = 0; fhi < historyToShow.length; fhi++) {
            var fh = historyToShow[fhi];
            lines.push('- Round ' + fh.round + ': ' + fh.category + ' — ' + fh.topIssue);
          }
          lines.push('**You must try a DIFFERENT fix strategy.**');
          lines.push('');
        }
      } else {
        // Legacy fallback: render plain text
        lines.push(fb.data ? fb.data.text : JSON.stringify(fb));
      }
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

  // ========== 12. 历史教训（从生产失败中自动提取） ==========
  try {
    var lessonsLines = [];
    // Load top error patterns from pending-rules (cross-project validated)
    var pendingPath = require('path').join(__dirname, 'pending-rules.json');
    if (require('fs').existsSync(pendingPath)) {
      var pending = JSON.parse(require('fs').readFileSync(pendingPath, 'utf-8'));
      // Group by rule category, count distinct projects per category
      var ruleGroups = {};
      for (var pi = 0; pi < pending.length; pi++) {
        var pr = pending[pi];
        var ruleKey = (pr.rule || 'unknown').toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
        if (!ruleGroups[ruleKey]) ruleGroups[ruleKey] = { count: 0, projects: {}, fix: pr.fix, desc: pr.description };
        ruleGroups[ruleKey].count++;
        if (pr.taskId) ruleGroups[ruleKey].projects[pr.taskId] = true;
      }
      // Sort by cross-project count (most widespread first)
      var sorted = Object.entries(ruleGroups)
        .map(function(e) { return { key: e[0], data: e[1], projectCount: Object.keys(e[1].projects).length }; })
        .filter(function(e) { return e.projectCount >= 2; }) // Only include patterns seen in 2+ projects
        .sort(function(a, b) { return b.projectCount - a.projectCount; })
        .slice(0, 10); // Top 10 patterns

      if (sorted.length > 0) {
        lessonsLines.push('');
        lessonsLines.push('# ⚠️ 历史生产失败教训（以下错误在多个项目中反复出现，务必避免）');
        lessonsLines.push('');
        for (var si = 0; si < sorted.length; si++) {
          var s = sorted[si];
          lessonsLines.push('- **' + s.key + '** (影响 ' + s.projectCount + ' 个项目, 共 ' + s.data.count + ' 次): ' + (s.data.desc || '').substring(0, 150));
          if (s.data.fix) lessonsLines.push('  修复: ' + s.data.fix.substring(0, 150));
        }
      }
    }
    // Also load promoted-rules (cross-project validated and promoted)
    var promotedPath = require('path').join(__dirname, 'promoted-rules.json');
    if (require('fs').existsSync(promotedPath)) {
      var promoted = JSON.parse(require('fs').readFileSync(promotedPath, 'utf-8'));
      if (promoted.length > 0 && lessonsLines.length === 0) {
        lessonsLines.push('');
        lessonsLines.push('# ⚠️ 已验证的生产规则（跨项目验证通过）');
      }
      for (var pri = 0; pri < Math.min(promoted.length, 5); pri++) {
        var pr = promoted[pri];
        lessonsLines.push('- ' + (pr.description || '').substring(0, 200) + (pr.fix ? ' — 修复: ' + pr.fix.substring(0, 100) : ''));
      }
    }
    if (lessonsLines.length > 0) {
      lines.push(lessonsLines.join('\n'));
    }
  } catch(lessonsErr) {
    console.warn('[prompt] Failed to load historical lessons (non-fatal): ' + lessonsErr.message);
  }

  return lines.join('\n');
}

module.exports = { 
  parseBlueprintToPromptV5: parseBlueprintToPromptV5,
  PREFAB_REGISTRY: PREFAB_REGISTRY,
  matchPrefabs: matchPrefabs
};
