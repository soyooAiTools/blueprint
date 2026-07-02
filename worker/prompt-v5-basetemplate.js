/**
 * Blueprint V5 Prompt Generator — 基础样例工程模式
 * 
 * 核心变化：场景已预制 160 个带颜色的对象，AI 只需 Find + Move + 写逻辑
 * 不再需要 GFM_Create.Obj / GFM_UI.CreateCanvas 等创建 API
 */

var fs = require('fs');
var path = require('path');
var isSkeletonReviewFalsePositive = require('./code-reviewer.js').isSkeletonReviewFalsePositive;

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

// 预制颜色池：10色 × 4形状，颜色在 Unity 中已烘焙，无需运行时 SetColor
var POOL_COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Purple', 'White', 'Brown', 'Cyan', 'Pink'];
var POOL_SHAPES = {
  Cube:     { count: 5 },
  Sphere:   { count: 5 },
  Cylinder: { count: 3 },
  Plane:    { count: 3 }
};
var COLOR_HINTS = {
  player: 'Blue', enemy: 'Red', boss: 'Red', ground: 'Green', floor: 'Brown',
  wall: 'White', coin: 'Yellow', gem: 'Purple', gold: 'Yellow', tree: 'Green',
  water: 'Cyan', bullet: 'Yellow', arrow: 'White', bomb: 'Brown', rock: 'Brown',
  tower: 'White', castle: 'White', building: 'Brown', house: 'Brown',
  worker: 'Cyan', soldier: 'Green', guide: 'Yellow', road: 'White',
  fire: 'Orange', lava: 'Orange', star: 'Yellow', heart: 'Pink', hp: 'Pink',
  shield: 'Cyan', sword: 'White', spaceship: 'White', rocket: 'White'
};

function guessColor(entityName, template) {
  var n = (entityName || '').toLowerCase();
  var t = (template || '').toLowerCase();
  var keys = Object.keys(COLOR_HINTS);
  for (var i = 0; i < keys.length; i++) {
    if (n.indexOf(keys[i]) >= 0 || t.indexOf(keys[i]) >= 0) return COLOR_HINTS[keys[i]];
  }
  return null;
}

function guessShape(entityName, template) {
  var n = (entityName || '').toLowerCase();
  var t = (template || '').toLowerCase();
  if (t.indexOf('projectile') >= 0 || n.indexOf('bullet') >= 0 || n.indexOf('ball') >= 0 || n.indexOf('coin') >= 0 || n.indexOf('gem') >= 0 || n.indexOf('sphere') >= 0) return 'Sphere';
  if (t.indexOf('ground') >= 0 || n.indexOf('ground') >= 0 || n.indexOf('floor') >= 0 || n.indexOf('plane') >= 0 || n.indexOf('water') >= 0) return 'Plane';
  if (n.indexOf('tower') >= 0 || n.indexOf('turret') >= 0 || n.indexOf('pillar') >= 0 || n.indexOf('cylinder') >= 0 || n.indexOf('tree') >= 0 || n.indexOf('pole') >= 0) return 'Cylinder';
  return 'Cube';
}

/**
 * 根据蓝图实体列表，匹配预制颜色池对象名
 * 新命名: __Pool_{Shape}_{Color}_{NN}
 */
function matchPrefabs(entities) {
  var pools = {};
  var shapes = Object.keys(POOL_SHAPES);
  for (var si = 0; si < shapes.length; si++) {
    pools[shapes[si]] = {};
    for (var ci = 0; ci < POOL_COLORS.length; ci++) {
      pools[shapes[si]][POOL_COLORS[ci]] = 1;
    }
  }
  var used = {};
  var colorIdx = 0;
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var shape = guessShape(e.name, e.template);
    var color = guessColor(e.name, e.template);
    if (!color) { color = POOL_COLORS[colorIdx % POOL_COLORS.length]; colorIdx++; }
    var maxCount = POOL_SHAPES[shape].count;
    var nextIdx = pools[shape][color];
    if (nextIdx > maxCount) {
      for (var ci = 0; ci < POOL_COLORS.length; ci++) {
        var altColor = POOL_COLORS[ci];
        if (pools[shape][altColor] <= maxCount) { color = altColor; nextIdx = pools[shape][altColor]; break; }
      }
    }
    var num = nextIdx < 10 ? '0' + nextIdx : '' + nextIdx;
    used[e.name] = '__Pool_' + shape + '_' + color + '_' + num;
    pools[shape][color] = nextIdx + 1;
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

function computeReservePool(prefabMap) {
  var shapeCounts = {};
  var usedPools = {};
  var pKeys = Object.keys(prefabMap);
  for (var i = 0; i < pKeys.length; i++) {
    var poolName = prefabMap[pKeys[i]];
    usedPools[poolName] = true;
    var m = poolName.match(/^__Pool_(\w+)_(\w+)_(\d+)$/);
    if (m) {
      var key = m[1] + '_' + m[2];
      shapeCounts[key] = (shapeCounts[key] || 0) + 1;
    }
  }
  var reserves = [];
  var scKeys = Object.keys(shapeCounts);
  for (var ri = 0; ri < scKeys.length; ri++) {
    var parts = scKeys[ri].split('_');
    var shape = parts[0], color = parts[1];
    var used = shapeCounts[scKeys[ri]];
    var max = POOL_SHAPES[shape] ? POOL_SHAPES[shape].count : 5;
    var nextIdx = used + 1;
    var extra = Math.min(2, max - used);
    for (var rx = 0; rx < extra; rx++) {
      var num = (nextIdx + rx) < 10 ? '0' + (nextIdx + rx) : '' + (nextIdx + rx);
      var rName = '__Pool_' + shape + '_' + color + '_' + num;
      if (!usedPools[rName]) reserves.push(rName);
    }
  }
  return reserves;
}

/**
 * V5 蓝图 → AI Prompt（基础样例工程模式）
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

function parseBlueprintToPromptV5(blueprint, opts) {
  opts = opts || {};
  blueprint = blueprint || {};
  var entities = blueprint.entities || [];
  
  // 从 phases/specs 提取事件规则。source-of-truth 已迁移到 specs；
  // 修复回路不能因为 blueprint.phases 为空就失去 phase 上下文。
  var rules = resolvePromptRules(blueprint);
  if (rules.length === 0) {
    throw new Error('No phase rules found in blueprint. Expected blueprint.specs or blueprint.phases.');
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

  // ========== Kit Detection ==========
  var specs = blueprint.specs || [];
  var hasFormSwitch = (specs || []).some(function(s) { return !!s.formSwitch; });
  var hasEconomy = (specs || []).some(function(s) {
    return (s.requiredInteractions || []).some(function(i) {
      var verb = String(i).split(':')[0];
      return verb === 'collect' || verb === 'deliver' || verb === 'spend';
    });
  });

  // ========== 1. 任务说明 ==========
  lines.push('# 任务');
  lines.push('在 `GameFlowManagerMain` 系列 partial class 中实现一个 Luna 试玩广告。默认骨架会拆成 6 个文件：');
  lines.push('- **GameFlowManagerMain.cs**：主入口 / 生命周期 / 流程编排');
  lines.push('- **GameFlowManagerMain.Flow.cs**：流程控制、phase dispatch、按 `type` 分类的流程处理');
  lines.push('- **GameFlowManagerMain.Input.cs**：输入处理');
  lines.push('- **GameFlowManagerMain.Resource.cs**：资源系统');
  lines.push('- **GameFlowManagerMain.UI.cs**：UI 系统');
  lines.push('- **GameFlowManagerMain.Scene.cs**：场景控制');
  lines.push('不要把功能重新塞回主文件。按职责把方法放进对应 partial 文件。');
  lines.push('`GameFlowManagerMain.cs` 应保持轻量：只保留初始化、Update 节拍、CheckEventRules 编排，以及对各系统方法的直接调用。');
  lines.push('');
  lines.push('## 输出边界（必须保持）');
  lines.push('- 本 prompt 只生成 Luna/WebGL staging 的 `GameFlowManagerMain` partial 代码，不生成程序员 Unity 交付工程。');
  lines.push('- storyboard2html/source HTML/WebGL parity 是事实源；不要在 C# 里改写 phase、guideText、targetSequence、entity/resource/gate 语义。');
  lines.push('- 需要交付 Unity WebGL 时，最终 WebGL 必须来自 Unity Editor 原生 `BuildTarget.WebGL` 构建；不要把 hand-written HTML/JS、preview HTML 或报告替身声明成 Unity WebGL。');
  lines.push('- source HTML 的 HUD、world label、camera、targetRing / marker 是视觉合同；Unity/WebGL 侧只能继承并验证，不要用近似布局、固定 label 或 phase-index-only 目标兜底。');
  lines.push('- 程序员 Unity 交付另走 profile：默认 `gmp-v14` legacy；显式 `unitycomponent-v1` 才输出 UnityComponent(3) `Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}`、`Entity` / `BaseComponent` / `EntityManager` / `GameEntry`、UnityDeliverySpec 和 v1 hardgate。');
  lines.push('- 本 prompt 中的 Luna 对象池、`GameObject.Find("__Pool_*")`、`GFM_*` 只属于 WebGL staging，不得带入程序员 Unity 交付包。');
  lines.push('');
  lines.push('关键字段、跨 phase 方法、多参数 helper 和复杂 gate 的说明注释必须紧邻定义或调用；不要只在文件顶部写总说明。');
  lines.push('含 `&&` / `||` 或跨 phase 状态的条件链，必须在前一行写注释解释这个 gate 为什么存在。');
  lines.push('');
  lines.push('## 代码结构硬要求');
  lines.push('1. **注释要少而准**：关键字段、复杂方法、跨 phase 状态、单位/边界/副作用要用中文大白话说明；自解释字段、简单 getter、单行 guard 不要机械补注释。');
  lines.push('2. **复杂条件要说明业务原因**：含 `&&` / `||`、跨 phase 依赖或资源门槛的分支，在进入条件前说明为什么这样判断，而不是复述代码结果。');
  lines.push('3. **空行按职责分块**：字段、初始化、输入、状态推进、UI、验证/兜底之间留空行；连续逻辑内部不要随意插空行。');
  lines.push('4. **不要把大量判断逻辑塞进 `HandlePlayerInteractions()` / `OnAutoPlayArrive()` / `Update()` 等聚合方法**。拆成多个命名明确的私有方法，然后直接调用。');
  lines.push('5. **不要通过事件系统调用业务方法**。禁止 GFM_Event / UnityEvent / event Action / AddListener / SendMessage / BroadcastMessage。只允许直接方法调用。');
  lines.push('6. **UI 统一按 1920x1080 设计**，不要改骨架中的 1920x1080 Canvas。');
  lines.push('7. **CheckEventRules 只做 phase 分发，不放 gate 逻辑**。骨架已为每个 phase 生成 `Phase_<pid>_GateReady()` 出口判定方法 + `EndGame_GateReady()`；CheckEventRules 内部按 `if (!ruleTriggered[i] && Phase_<pid>_GateReady()) { EnterPhase(...); ... return; }` 顺序分派。要扩展某个 phase 的进入条件，去改对应 `Phase_<pid>_GateReady()`，不要把 `&&`/`||` 长链塞回 CheckEventRules。');
  lines.push('');
  lines.push('## ⚡ 核心规则：基础样例工程模式');
  lines.push('场景已预制 160 个带颜色的 3D 对象 + UI 元素。你 **不需要创建任何对象**。');
  lines.push('');
  lines.push('你只需要：');
  lines.push('1. 优先使用骨架中已经绑定好的实体字段；如果代码里有 `RegisterEntityBindings()`，不要再写 `GameObject.Find("__Pool_*")`');
  lines.push('2. `transform.position = new Vector3(x,y,z)` 移动到场景中（显示）');
  lines.push('3. `transform.position = new Vector3(0,-999,0)` 移到远处（隐藏）');
  lines.push('4. 颜色已烘焙 — 直接 Find 对应颜色的 `__Pool_{Shape}_{Color}_{NN}` 对象，无需 SetColor');
  lines.push('5. 写游戏逻辑（交互、碰撞检测、流程控制）');
  lines.push('');
  lines.push('## 骨架已预创建的变量（直接使用，不要重新创建）');
  lines.push('- `Camera mainCam` — 已缓存的相机，绝对不要用 Camera.main，用 mainCam');
  lines.push('- `Canvas uiCanvas` — 已创建的 Canvas，不要再创建');
  lines.push('- `Text guideText` — 引导文字，优先调用 `SetGuideText("...")` 更新');
  lines.push('- `Text scoreText` — 分数文字，设 scoreText.text = "..." 更新');
  lines.push('');
  lines.push('## ⛔ 绝对禁止');
  lines.push('- **绝对不要用 Camera.main** — 用 mainCam，操作前 if (mainCam != null)');
  lines.push('- **绝对不要用 GFM_UI.CreateCanvas()** — 用 uiCanvas');
  lines.push('- **绝对不要用 SetActive()** — Luna 中会导致对象永久消失');
  lines.push('- 不要用 GFM_Create.Obj() / GFM_Create.Ground() — 对象已存在');
  lines.push('- 如果骨架已经生成 `_entityBindingIds/_entityBindingPools`，不要在 TODO 区直接 `GameObject.Find("__Pool_*")` 覆盖实体字段');
  lines.push('- 资源 API 使用 `GFM_ResourceIds.Gold` / `GFM_ResourceIds.Normalize("...")`，不要裸写 `AddResource("Gold", ...)`');
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
  lines.push('5. **Rule 0 / Phase 1 防纯色必须优先使用 fidelityContract.phases[0].showEntities / source PHASES[].showEntities 中的实体**：第一帧移动至少 3 个这些合同可见实体到 y ≥ 0；禁止为了凑数摆放后续 phase 才出现的实体。');
  lines.push('');

  // ========== 2. 骨架代码 ==========
  lines.push('# 骨架代码（必须遵循此结构）');
  lines.push('```csharp');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public partial class GameFlowManagerMain : MonoBehaviour');
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
  lines.push('以下是蓝图实体 → 场景对象的映射。新骨架会用 RegisterEntityBindings 自动绑定；不要在 TODO 区重复 Find。');
  lines.push('对象名格式为 __Pool_[Shape]_[Color]_[NN]（如 __Pool_Cube_Red_01），颜色已烘焙，这些是场景中已存在的 3D 对象。');
  lines.push('');
  lines.push('| 蓝图实体 | 场景对象名 | 说明 |');
  lines.push('|----------|-----------|------|');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var pName = prefabMap[e.name] || '__Pool_Cube_White_01';
    var desc = (e.template || 'Static') + (e.label ? ' (' + e.label + ')' : '');
    lines.push('| ' + e.name + ' | ' + pName + ' | ' + desc + ' |');
  }
  lines.push('');
  lines.push('允许使用的 pool literal（仅限下列对象，禁止自行拼接或改名）:');
  var allowedPools = Object.keys(prefabMap).map(function(name) { return prefabMap[name]; });
  var seenPools = {};
  var dedupedPools = [];
  for (var api = 0; api < allowedPools.length; api++) {
    if (seenPools[allowedPools[api]]) continue;
    seenPools[allowedPools[api]] = true;
    dedupedPools.push(allowedPools[api]);
  }
  lines.push(dedupedPools.map(function(poolName) { return '`' + poolName + '`'; }).join(', '));
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
  var totalPool = 50 + 50 + 30 + 30; // 10colors × (5+5+3+3) = 160
  if (entities.length > totalPool) {
    lines.push('⚠️ **POOL EXHAUSTION WARNING**: ' + entities.length + ' entities exceed the pool capacity of ' + totalPool + ' objects. Some entities share the same pool object — merge or reduce entity count.');
    lines.push('');
  }

  // ========== 5b. 备用池对象（Pool Manifest） ==========
  var reservePool = computeReservePool(prefabMap);
  if (reservePool.length > 0) {
    lines.push('# 备用池对象（按白名单复用）');
    lines.push('如果同色同形状的已分配对象用完，只能从以下备用对象中选择；不要直接 Instantiate 或发明新的 pool literal：');
    lines.push('');
    for (var rpi = 0; rpi < reservePool.length; rpi++) {
      lines.push('- `' + reservePool[rpi] + '`');
    }
    lines.push('');
    lines.push('本项目共使用 ' + Object.keys(prefabMap).length + '/' + totalPool + ' 个池对象。');
    lines.push('');
  }

  // ========== 6. 实体行为描述 ==========
  lines.push('# 实体行为');
  lines.push('');
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    lines.push('## ' + e.name + (e.label ? ' (' + e.label + ')' : ''));
    lines.push('场景对象: `GameObject.Find("' + (prefabMap[e.name] || '__Pool_Cube_White_01') + '")`');
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
  lines.push('场景中预置了 160 个带颜色的 3D 对象，命名规则: `__Pool_{Shape}_{Color}_{NN}`');
  lines.push('- 形状: Cube(每色5个), Sphere(每色5个), Cylinder(每色3个), Plane(每色3个)');
  lines.push('- 颜色: Red, Blue, Green, Yellow, Orange, Purple, White, Brown, Cyan, Pink');
  lines.push('- 例: `__Pool_Cube_Red_01`, `__Pool_Sphere_Blue_03`, `__Pool_Cylinder_Green_02`');
  lines.push('- 颜色已在 Unity 中烘焙，**不需要调用 GFM_Create.SetColor()**');
  lines.push('- 其他固定对象：`Main Camera`、`__MainLight`、`EventSystem`、`GameManager`、`__MaterialSource`、`__Ground`');
  lines.push('');
  lines.push('初始时所有 __Pool_* 对象位于 (0, -999, 0)（不可见）。');
  lines.push('要显示对象：`obj.transform.position = new Vector3(x, y, z);`');
  lines.push('要隐藏对象：`obj.transform.position = new Vector3(0, -999, 0);`（不用 SetActive）');
  lines.push('');
  lines.push('## 🚨 相机与对象可见性（必须遵守，否则画面纯色/黑屏）');
  lines.push('- 不要直接写 mainCam.transform.position / mainCam.transform.eulerAngles / mainCam.orthographicSize');
  lines.push('- shot 镜头移动、缩放、构图统一用 `GFM_CameraController.Instance.FramePoint(...)` / `SetOrthographicSize(...)` / `SetCameraHeight(...)`');
  lines.push('- 所有游戏对象的 position.x 必须在 -6~6 范围，position.y 在 -4~4 范围');
  lines.push('- 对象 localScale 不能小于 0.3f，推荐 0.5~2.0f');
  lines.push('- SpriteRenderer 的颜色不能和 Camera.backgroundColor 相同');
  lines.push('- 初始化时至少有 1 个对象在屏幕可见范围内（不能全部在 -999）');
  lines.push('- 不要在 Awake/Start 中 SetActive(false) 所有对象');
  lines.push('');
  lines.push('## 操作 API');
  lines.push('- ⛔ 不要用 GFM_Create.SetColor() — 颜色已烘焙，直接 Find 对应颜色的对象');
  lines.push('- 玩家移动：点击屏幕设定目标点，由骨架 MovePlayer() 自动朝目标走；不要再创建虚拟摇杆');
  lines.push('- 游戏结束: `Luna.Unity.LifeCycle.GameEnded()`');
  lines.push('- CTA: `Luna.Unity.Playable.InstallFullGame()`');
  lines.push('- 时间延迟: 用 `timer += Time.deltaTime; if (timer > X)` 代替 WaitForSeconds');
  lines.push('- UI 文字: guide 用 `SetGuideText("xxx")`；score 用已存在的 `scoreText` 字段，避免新 Find');
  lines.push('- 距离门槛: `(a.position - b.position).sqrMagnitude < radius * radius`；不要用 `Vector3.Distance(...) < radius`');
  lines.push('- 不要用 transform.parent / SetParent / FindObjectOfType');
  lines.push('- 不要定义 class EventPool（和模板冲突）');
  lines.push('- 最后一个步骤必须有 GameEnded() + CTA 按钮');
  lines.push('');
  
  // ========== 8b. 双模式架构：交互模式 + AutoPlay 模式 ==========
  lines.push('# 🚨🚨🚨 双模式架构（最高优先级！）');
  lines.push('');
  lines.push('## 骨架已内置 _autoPlayMode 开关，你的代码必须支持两种模式:');
  lines.push('');
  lines.push('### 模式 A: 交互模式 (_autoPlayMode == false) — 上线给用户玩');
  lines.push('- 玩家通过点击/拖拽操控角色');
  lines.push('- Phase 推进需要玩家完成指定操作');
  lines.push('- 引导(guide)告诉玩家下一步操作');
  lines.push('- 每个 Phase 必须有交互门槛（不能靠 timer 自动推进）');
  lines.push('');
  lines.push('### 模式 B: AutoPlay 模式 (_autoPlayMode == true) — CUA 自动验证用');
  lines.push('- 角色/NPC 自动沿路径移动（不需要用户输入）');
  lines.push('- AutoPlay 只负责自动移动/触达目标；Phase 仍必须靠真实实体位移或交互结果推进');
  lines.push('- 允许短暂停留给 CUA 观察，但不能靠 timer 直接推进 phase');
  lines.push('- 运动必须平滑自然（Vector3.MoveTowards + Quaternion.Lerp）');
  lines.push('- 速度适中（moveSpeed * 0.5~0.7），不要瞬移');
  lines.push('- 每个 Phase 的关键实体必须在画面中可见');
  lines.push('');
  lines.push('## 🚨 2026-04-20 新契约: Phase 门控只认 GameObject 位置变化');
  lines.push('');
  lines.push('骨架的 CheckEventRules 现在用 EntityAdvanced(GameObject, _snap_XxxPos) 判断 phase 能否推进。');
  lines.push('它读取 transform.position 并与该 phase 进入时的快照比较 — 距离 > 1.5 就算"已推进"。');
  lines.push('');
  lines.push('### 这意味着:');
  lines.push('- ✅ 你必须用 PlaceObj / HideObj / transform.position 让关键实体在画面上发生可观察的位移');
  lines.push('- ⛔ 直接写 xxxState = 1 / xxxDone = true / PlayerActed = true 不再推进 phase (静态检查会 block)');
  lines.push('- ⛔ 也不要在骨架之外手工把 ruleTriggered[i] 置 true');
  lines.push('- ⛔ 只在 `Phase_<id>_Init()` 里移动 gate 实体也不算完成；快照发生在 phase 进入附近，必须在 `OnTap` / `OnAutoPlayArrive` / 运行时交互里再次移动');
  lines.push('');
  lines.push('### Flow.cs 里的 autoPlay handler 正确写法:');
  lines.push('```csharp');
  lines.push('void Phase_phase1_OnAutoPlayArrive(string targetName) {');
  lines.push('    PlaceObj(Barracks, 2f, 0.5f, 0f);    // 把兵营放到新位置 — 可观察');
  lines.push('    // 如需给资源，走与玩家一致的交互/收集 helper，不要直接改 gold/resources');
  lines.push('}');
  lines.push('');
  lines.push('void Phase_phase2_OnAutoPlayArrive(string targetName) {');
  lines.push('    HideObj(Enemy);                      // 隐藏敌人 (移到 y=-999)');
  lines.push('    PlaceObj(Crystal, -2f, 0.5f, 0f);    // 显示水晶');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### Flow.cs 里的 phase init 正确写法:');
  lines.push('```csharp');
  lines.push('void Phase_phase2_Init() {');
  lines.push('    // 进入该 phase 时的初始化/引导/UI 提示放这里');
  lines.push('    // 不要把这段重新塞回 CheckEventRules()');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('### Update() 里的 AutoPlay 行为:');
  lines.push('```csharp');
  lines.push('// 在 Update() 的 TODO_UPDATE 区域:');
  lines.push('if (_autoPlayMode)');
  lines.push('{');
  lines.push('    // NPC 平滑移动 — 不要瞬移');
  lines.push('    // npc.transform.position = Vector3.MoveTowards(npc.transform.position, npcTarget, 2f * dt);');
  lines.push('    // 资源/数值变化可以在这里做，但推进 phase 的关键实体要在 OnAutoPlayArrive 里移动');
  lines.push('}');
  lines.push('else');
  lines.push('{');
  lines.push('    // 正常交互逻辑 — 需要玩家操作');
  lines.push('    if (Input.GetMouseButtonDown(0)) { /* 点击交互 */ }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## 重要规则:');
  lines.push('- ✅ 骨架 AutoPlayUpdate() 已处理玩家基础移动；Flow.cs 的 `Phase_<id>_OnAutoPlayArrive()` 由 dispatcher 在到达 target 时调用');
  lines.push('- ✅ 每个 phase 的关键实体都必须在对应的 `Phase_<id>_OnAutoPlayArrive()` 里被移动/显示/隐藏 (> 1.5 单位)');
  lines.push('- ✅ NPC 移动用 Vector3.MoveTowards(pos, target, speed * dt)，不要瞬移');
  lines.push('- ✅ 每个 Phase 要有明显的视觉变化（对象出现/移动/颜色变化/UI 更新）');
  lines.push('- ⛔ `Phase_<id>_OnAutoPlayArrive()` 里禁止直接赋值 xxxState=N / xxxDone=true / PlayerActed=true');
  lines.push('- ⛔ 禁止使用 SetActive() — Luna 不支持，移动到 y=-999 (HideObj) 替代');
  lines.push('- ⛔ 不要把 phase-specific 逻辑重新塞回 `GameFlowManagerMain.cs`；主文件只保留编排和直接调用');
  lines.push('- ⛔ 不要修改骨架的 _autoPlayMode 检测、CheckEventRules、EntityAdvanced 辅助函数');
  lines.push('');

  // ========== 8c. 交互模式规则 ==========
  lines.push('# 交互模式规则 (_autoPlayMode == false 时)');
  lines.push('');
  lines.push('## 每个 Phase 必须有交互门槛');
  lines.push('- ✅ Phase 推进依赖玩家操作（点击移动到位/拖拽）');
  lines.push('- ✅ 引导(guide)清晰告诉玩家下一步操作');
  lines.push('- ✅ 每个阶段之间有明显的视觉变化');
  lines.push("- ✅ AddCompletedPhase 的参数使用 Rule 的 ID");
  lines.push('');
  lines.push('## 数值平衡');
  lines.push('- ✅ 每个 Phase/shot 程序员审阅时长必须控制在 10-15 秒内，默认 12 秒（骨架已用 phaseTimer 保障）');
  lines.push('- ✅ 所有可建造实体的 entityState 必须达到 2（built）');
  lines.push('- ✅ 资源投递到建筑必须有搬运过程');
  lines.push('');

  // ========== 8d. 正确代码模式参考（必须严格遵循）==========
  lines.push('# 📋 正确代码模式参考（直接照抄，不要自创写法）');
  lines.push('');
  lines.push('## CheckEventRules 的正确写法');
  lines.push('```csharp');
  lines.push('void CheckEventRules() {');
  lines.push('  var p = GameObject.Find("__Pool_Sphere_Blue_01"); // Player — use prompt中指定的实际pool名');
  lines.push('  if (p == null) return;');
  lines.push('  var playerPos = p.transform.position;');
  lines.push('');
  lines.push('  // Rule 1: 游戏开始 → 显示引导');
  lines.push('  if (currentPhaseName == "" || currentPhaseName == "gameStart") {');
  lines.push('    currentPhaseName = "phase_1";');
  lines.push('    AddCompletedPhase("phase_xxx_1"); // 用蓝图中 Rule 的真实 ID');
  lines.push('    ShowGuide("点击屏幕移动到目标位置");');
  lines.push('  }');
  lines.push('');
  lines.push('  // Rule 2: 玩家移动到目标 → 触发下一阶段');
  lines.push('  if (currentPhaseName == "phase_1") {');
  lines.push('    var target = GameObject.Find("__Pool_Cube_Red_01"); // Target — use prompt中指定的实际pool名');
  lines.push('    if (target != null && (playerPos - target.transform.position).sqrMagnitude < 1.5f * 1.5f) {');
  lines.push('      AddCompletedPhase("phase_xxx_2"); // 用蓝图中 Rule 的真实 ID');
  lines.push('      currentPhaseName = "phase_2";');
  lines.push('      ShowGuide("点击建造按钮");');
  lines.push('    }');
  lines.push('  }');
  lines.push('');
  lines.push('  // Rule 3: 建造完成 → 下一阶段');
  lines.push('  if (currentPhaseName == "phase_2" && eState[BUILDING_ID] == 2) {');
  lines.push('    AddCompletedPhase("phase_xxx_3");');
  lines.push('    currentPhaseName = "phase_3";');
  lines.push('  }');
  lines.push('');
  lines.push('  // 最终 Rule: 所有阶段完成 → 结束游戏');
  lines.push('  if (currentPhaseName == "phase_final") {');
  lines.push('    Luna.Unity.LifeCycle.GameEnded();');
  lines.push('    ShowCTA();');
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## 对象初始化的正确写法');
  lines.push('```csharp');
  lines.push('void InitScene() {');
  lines.push('  // 1. 相机设置（必须走 controller，避免 shot 间瞬移）');
  lines.push('  GFM_CameraController.Instance.Init();');
  lines.push('  GFM_CameraController.Instance.FramePoint(Vector3.zero, 8f);');
  lines.push('');
  lines.push('  // 2. 玩家放在屏幕中心附近（坐标 -6~6 范围）');
  lines.push('  var player = GameObject.Find("__Pool_Sphere_Blue_01"); // Player — use prompt中指定的实际pool名');
  lines.push('  player.transform.position = new Vector3(-3, 0, 0);');
  lines.push('  player.transform.localScale = Vector3.one * 1.0f;');
  lines.push('');
  lines.push('  // 3. 目标对象放在可见范围内');
  lines.push('  var target = GameObject.Find("__Pool_Cube_Red_01"); // Target — use prompt中指定的实际pool名');
  lines.push('  target.transform.position = new Vector3(3, 2, 0);');
  lines.push('');
  lines.push('  // 4. 暂时不需要的对象放在屏幕外（不用 SetActive）');
  lines.push('  var later = GameObject.Find("__Pool_Cube_Green_01"); // 暂不需要的对象');
  lines.push('  later.transform.position = new Vector3(0, -999, 0);');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## ⚠️ 关键提醒');
  lines.push('- AddCompletedPhase / ReportPhase / currentPhaseName 必须严格使用当前 spec 里的 `phaseId` 原值。若 spec 是语义名，就用语义名；若 spec 是 `phase_...`，就用 `phase_...`。不要自己改名或混用别名。');
  lines.push('- 每个 Phase 推进必须由真实世界状态变化触发（玩家操作 / AutoPlay 到达后的实体位移）；不能把 timer 当唯一完成条件');
  lines.push('- CheckEventRules 中的 if 条件链必须用 currentPhaseName 串联，确保顺序执行');
  lines.push('- 初始化时必须有至少 1 个对象在屏幕可见范围内');
  lines.push('');

  // ========== 8e. Form-Switch Kit 说明（按需注入）==========
  if (hasFormSwitch) {
    lines.push('## Form-Switch Kit (Skeleton Pre-Built)');
    lines.push('骨架已预建形态切换系统。你只需填 _forms 数组：');
    lines.push('```csharp');
    lines.push('_forms = new FormDef[] {');
    lines.push('    new FormDef { formId="形态1", poolObjectName="__Pool_...", moveSpeed=3.5f, collectRange=1.5f, collectPower=1f, carryCapacity=10, scale=1.5f },');
    lines.push('    new FormDef { formId="形态2", poolObjectName="__Pool_...", moveSpeed=5f, collectRange=3f, collectPower=5f, carryCapacity=50, scale=2.5f },');
    lines.push('};');
    lines.push('```');
    lines.push('切换形态：`SwitchForm(1);` — 在 CheckEventRules 的 phase 切换里调用');
    lines.push('MovePlayer/TryCollect 自动读取当前形态数值，你不需要写额外移动代码。');
    lines.push('**禁止** 为不同形态写独立的移动/采集方法。');
    lines.push('');
  }

  // ========== 8f. Economy Kit 说明（按需注入）==========
  if (hasEconomy) {
    lines.push('## Economy Kit (Skeleton Pre-Built)');
    lines.push('骨架已预建资源经济系统。你只需填 _resources 数组：');
    lines.push('```csharp');
    lines.push('_resources = new ResourceDef[] {');
    lines.push('    new ResourceDef { resourceId="wood", displayName="木材", convertFrom="", convertRatio=0 },');
    lines.push('    new ResourceDef { resourceId="gold", displayName="金币", convertFrom="wood", convertRatio=3 },');
    lines.push('};');
    lines.push('```');
    lines.push('可用方法：AddResource(id, amount), TrySpend(id, amount), TryConvert(fromId, toId), GetResource(id)');
    lines.push('UI 自动更新（UpdateResourceUI 已预建）。');
    lines.push('**禁止** 手写 gold/wood/resource 变量和加减逻辑 — 优先用 AddResource/GetResource/TrySpend/TryConvert；旧模板里的 _inventory[...] 仅作为兼容别名。');
    lines.push('');
  }

  // ========== 9. 行为模板（按需注入：只保留当前实体真正用到的模板） ==========
  if (BEHAVIOR_TEMPLATES) {
    var usedBehaviors = detectUsedBehaviors(blueprint);
    var filtered = filterBehaviorTemplates(BEHAVIOR_TEMPLATES, usedBehaviors);
    if (filtered) {
      lines.push('# 行为模板参考（仅当前实体用到的）');
      lines.push(filtered);
      lines.push('');
    }
  }

  // ========== 10. 反馈修复（结构化 JSON + legacy text fallback）==========
  // Per-entry char budget: keeps fix-loop prompts from blowing up after several rounds.
  // Structured path enforces caps on each section; legacy fallback enforces a single
  // hard cap on the raw text dump.
  var FEEDBACK_TEXT_CAP = 2500;
  var FEEDBACK_ISSUE_MSG_CAP = 600;
  var FEEDBACK_MAX_ISSUES = 5;
  var FEEDBACK_MAX_DETAIL_ITEMS = 6;
  var FEEDBACK_MAX_CONSOLE_ERRORS = 6;

  function _truncate(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? (s.slice(0, n) + '…(truncated)') : s;
  }

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
        lines.push('**Round ' + s.round + ' — ' + _truncate(s.summary, 200) + '**');
        lines.push('');

        // Render each issue as actionable item (cap count and message length)
        var issuesToRender = (s.issues || []).slice(0, FEEDBACK_MAX_ISSUES);
        for (var ii = 0; ii < issuesToRender.length; ii++) {
          var issue = issuesToRender[ii];
          lines.push('### Issue ' + (ii + 1) + ': [' + issue.type + '] (severity: ' + issue.severity + ')');
          lines.push(_truncate(issue.message, FEEDBACK_ISSUE_MSG_CAP));
          if (issue.fix_hint) {
            lines.push('**How to fix:** ' + _truncate(issue.fix_hint, FEEDBACK_ISSUE_MSG_CAP));
          }
          if (issue.details && issue.details.missing) {
            var missingItems = issue.details.missing.slice(0, FEEDBACK_MAX_DETAIL_ITEMS);
            lines.push('Missing phases:');
            for (var mi = 0; mi < missingItems.length; mi++) {
              var mp = missingItems[mi];
              lines.push('  - ' + mp.phaseId + (mp.trigger ? ' (trigger: ' + mp.trigger + ')' : ''));
            }
            if (issue.details.missing.length > FEEDBACK_MAX_DETAIL_ITEMS) {
              lines.push('  - …(' + (issue.details.missing.length - FEEDBACK_MAX_DETAIL_ITEMS) + ' more)');
            }
          }
          if (issue.details && issue.details.entities) {
            var entItems = issue.details.entities.slice(0, FEEDBACK_MAX_DETAIL_ITEMS);
            lines.push('Incomplete entities:');
            for (var ei = 0; ei < entItems.length; ei++) {
              var ent = entItems[ei];
              lines.push('  - ' + ent.entity + ': current=' + ent.currentState + ', required=' + ent.requiredState + ' (' + ent.stateLabel + ')');
            }
            if (issue.details.entities.length > FEEDBACK_MAX_DETAIL_ITEMS) {
              lines.push('  - …(' + (issue.details.entities.length - FEEDBACK_MAX_DETAIL_ITEMS) + ' more)');
            }
          }
          lines.push('');
        }
        if ((s.issues || []).length > FEEDBACK_MAX_ISSUES) {
          lines.push('… (' + (s.issues.length - FEEDBACK_MAX_ISSUES) + ' more issues truncated)');
        }

        // Game state context
        if (s.gameState && s.gameState.completedPhases) {
          lines.push('### Game State at Failure');
          lines.push('- Current Phase: ' + (s.gameState.currentPhase || 'unknown'));
          lines.push('- Completed Phases: ' + _truncate((s.gameState.completedPhases.join(', ') || 'none'), 400));
          if (s.gameState.entityStates) lines.push('- Entity States: ' + _truncate(JSON.stringify(s.gameState.entityStates), 400));
          if (s.gameState.variables) lines.push('- Variables: ' + _truncate(JSON.stringify(s.gameState.variables), 400));
          lines.push('');
        }

        // Console errors (cap count)
        if (s.consoleErrors && s.consoleErrors.length > 0) {
          lines.push('### Console Errors');
          var consoleToRender = s.consoleErrors.slice(0, FEEDBACK_MAX_CONSOLE_ERRORS);
          for (var ce = 0; ce < consoleToRender.length; ce++) {
            lines.push('- ' + _truncate(consoleToRender[ce], 300));
          }
          if (s.consoleErrors.length > FEEDBACK_MAX_CONSOLE_ERRORS) {
            lines.push('- …(' + (s.consoleErrors.length - FEEDBACK_MAX_CONSOLE_ERRORS) + ' more errors)');
          }
          lines.push('');
        }

        // Fix history warning
        if (s.fixHistory && s.fixHistory.length > 1) {
          lines.push('### Fix History (DO NOT repeat these approaches)');
          var historyToShow = s.fixHistory.slice(-3);
          for (var fhi = 0; fhi < historyToShow.length; fhi++) {
            var fh = historyToShow[fhi];
            lines.push('- Round ' + fh.round + ': ' + fh.category + ' — ' + _truncate(fh.topIssue, 200));
          }
          lines.push('**You must try a DIFFERENT fix strategy.**');
          lines.push('');
        }
      } else {
        // Legacy fallback: render plain text with hard cap
        var rawText = (fb.data && fb.data.text) || fb.message || fb.text || JSON.stringify(fb);
        lines.push(_truncate(rawText, FEEDBACK_TEXT_CAP));
      }
    }
    lines.push('');
  }

  // ========== 11. 现有代码 ==========
  // Outline 化策略：
  //   - 完整代码已经在工作区磁盘上，CC CLI 可以用 Read 工具按需读取
  //   - prompt 里只放 outline（class/字段/函数签名 + 函数体行数注释）+ 与 feedback 相关的 phase 块
  //   - 避免每轮 fix-loop 都重发整个 1300-1600 行的文件
  //   - opts.fullExistingCode = true 时退回旧行为（首次调用、debug 用）
  if (opts.existingCode) {
    lines.push('');
    if (opts.fullExistingCode) {
      lines.push('# 现有代码（在此基础上修复）');
      lines.push('```csharp');
      lines.push(opts.existingCode);
      lines.push('```');
    } else {
      lines.push('# 现有代码概要 — GameFlowManagerMain.cs');
      lines.push('> ⚠️ 完整文件已在工作区 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`，请用 Read 工具按需读取。下面只列出函数 outline + 与当前 feedback 相关的 phase 代码块。');
      lines.push('```csharp');
      lines.push(buildCodeOutline(opts.existingCode));
      lines.push('```');
      var relevantBlocks = extractRelevantPhaseBlocks(opts.existingCode, opts.feedback || []);
      if (relevantBlocks) {
        lines.push('');
        lines.push('# 与当前 feedback 相关的 phase 代码块（GameFlowManagerMain.cs）');
        lines.push('```csharp');
        lines.push(relevantBlocks);
        lines.push('```');
      }
    }
  }

  // ========== 11b. 现有 partial class 文件 ==========
  if (opts.existingSystemsCode) {
    lines.push('');
    if (opts.fullExistingCode) {
      lines.push('# 现有 partial class 文件: GameFlowManagerMain.Systems.cs');
      lines.push('> ⚠️ 此文件与主文件共同编译。不要在主文件中重复定义此文件已有的方法，否则会产生CS0111编译错误。');
      lines.push('```csharp');
      lines.push(opts.existingSystemsCode);
      lines.push('```');
    } else {
      lines.push('# 现有代码概要 — GameFlowManagerMain.Systems.cs (partial class)');
      lines.push('> ⚠️ 此文件与主文件共同编译，partial class 共享所有字段。完整文件已在磁盘 `Assets/Program/Script/Manager/GameFlowManagerMain.Systems.cs`，请用 Read 工具按需读取。');
      lines.push('> ⚠️ 不要在主文件中重复定义此文件已有的方法，否则会产生CS0111编译错误。');
      lines.push('```csharp');
      lines.push(buildCodeOutline(opts.existingSystemsCode));
      lines.push('```');
    }
  }

  // ========== 12. 历史教训 + Phase State Machine（统一注入点，避免重复） ==========
  // 单一来源原则：
  //   - blueprint.promotedRulesText 由 codegen.cjs 构建（critical 全量 + warning top-10 by freq, 带 severity 分级）
  //   - blueprint.phaseStateMachineText 由 codegen.cjs 从 specs 构建
  //   - 这里只消费，不再重复读取 promoted-rules.json
  if (blueprint.promotedRulesText) {
    lines.push('');
    lines.push(blueprint.promotedRulesText);
  }
  if (blueprint.phaseStateMachineText) {
    lines.push('');
    lines.push(blueprint.phaseStateMachineText);
  }

  // pending-rules.json 是 codegen.cjs 不覆盖的额外信号（跨项目 ≥2 出现但还未晋升的模式）
  // 仅注入 promotedRulesText 中没有的去重项，且最多 8 条，避免与 promoted 重复
  try {
    var pendingPath = require('path').join(__dirname, 'pending-rules.json');
    if (require('fs').existsSync(pendingPath)) {
      var pending = JSON.parse(require('fs').readFileSync(pendingPath, 'utf-8'));
      var promotedTextLower = (blueprint.promotedRulesText || '').toLowerCase();
      var ruleGroups = {};
      for (var pi = 0; pi < pending.length; pi++) {
        var pr = pending[pi];
        if (isSkeletonReviewFalsePositive(pr)) continue;
        var ruleKey = (pr.rule || 'unknown').toLowerCase().replace(/[^a-z0-9 ]/g, '').substring(0, 60);
        if (!ruleGroups[ruleKey]) ruleGroups[ruleKey] = { count: 0, projects: {}, fix: pr.fix, desc: pr.description };
        ruleGroups[ruleKey].count++;
        if (pr.taskId) ruleGroups[ruleKey].projects[pr.taskId] = true;
      }
      var sorted = Object.keys(ruleGroups)
        .map(function(k) { return { key: k, data: ruleGroups[k], projectCount: Object.keys(ruleGroups[k].projects).length }; })
        .filter(function(e) { return e.projectCount >= 2; })
        // 去重：promotedRulesText 已经包含的 description 不再注入
        .filter(function(e) {
          var descSig = ((e.data.desc || '').toLowerCase()).slice(0, 40);
          return descSig.length > 0 && promotedTextLower.indexOf(descSig) < 0;
        })
        .sort(function(a, b) { return b.projectCount - a.projectCount; })
        .slice(0, 8);

      if (sorted.length > 0) {
        lines.push('');
        lines.push('# ⚠️ 额外的跨项目失败模式（promoted-rules 之外，按出现频次）');
        for (var si = 0; si < sorted.length; si++) {
          var s = sorted[si];
          lines.push('- **' + s.key + '** (影响 ' + s.projectCount + ' 项目, ' + s.data.count + ' 次): ' + (s.data.desc || '').substring(0, 120));
          if (s.data.fix) lines.push('  修复: ' + s.data.fix.substring(0, 120));
        }
      }
    }
  } catch(lessonsErr) {
    console.warn('[prompt] Failed to load pending lessons (non-fatal): ' + lessonsErr.message);
  }

  return lines.join('\n');
}

// ========== 代码 outline 化 helpers（fix-loop 减少 token 重传） ==========

/**
 * 把 C# 源码折叠为 outline：保留 class/字段/函数签名，函数体替换为 lines elided 注释。
 * 适用于 fix-loop 里只需要让 LLM 知道结构、按需 Read 完整文件的场景。
 *
 * 函数签名识别采用启发式字符串判断，避免复杂正则：
 *   - 行尾以 `)` 或 `) {` 结束（去掉行内注释和尾部空白）
 *   - 行内含括号对 `(...)`
 *   - 排除控制流关键字（if / for / while / foreach / switch / using / lock / catch / fixed）
 *   - 排除 lambda 箭头 `=>`
 */
function buildCodeOutline(code) {
  if (!code) return '';
  var lines = code.split('\n');
  var out = [];
  var inFunc = false, funcDepth = 0, funcStartIdx = 0;

  var CONTROL_KW = ['if', 'for', 'foreach', 'while', 'switch', 'using', 'lock', 'catch', 'fixed', 'return', 'throw', 'new'];

  function looksLikeFuncSig(line) {
    var trimmed = line.replace(/\/\/.*$/, '').replace(/\s+$/, '');
    if (!trimmed) return false;
    // 必须包含 ( 和 )
    var openParen = trimmed.indexOf('(');
    if (openParen < 0) return false;
    var closeParen = trimmed.lastIndexOf(')');
    if (closeParen <= openParen) return false;
    // 行尾必须是 ) 或 ) { 或 )
    var tail = trimmed.slice(closeParen + 1).replace(/\s/g, '');
    if (tail !== '' && tail !== '{') return false;
    // 排除 lambda
    if (trimmed.indexOf('=>') >= 0) return false;
    // 排除控制流关键字开头
    var leading = trimmed.replace(/^\s*/, '').split(/[\s(]/)[0];
    for (var ci = 0; ci < CONTROL_KW.length; ci++) {
      if (leading === CONTROL_KW[ci]) return false;
    }
    // 排除属性 / 字段赋值（含 = 但不含 == 且不在 () 内）
    var beforeParen = trimmed.slice(0, openParen);
    if (beforeParen.indexOf('=') >= 0 && beforeParen.indexOf('==') < 0) return false;
    // 必须有标识符紧贴 ( — 即 `Name(` 而不是 ` (`
    var nameChar = trimmed.charAt(openParen - 1);
    if (!/[A-Za-z0-9_>]/.test(nameChar)) return false;
    return true;
  }

  function countChar(s, ch) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
    return n;
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    if (!inFunc) {
      out.push(line);
      if (looksLikeFuncSig(line)) {
        if (line.indexOf('{') >= 0) {
          inFunc = true;
          funcDepth = countChar(line, '{') - countChar(line, '}');
          funcStartIdx = i;
          if (funcDepth === 0) {
            // 单行函数体 e.g. void X() { return; }
            inFunc = false;
          }
        } else if (i + 1 < lines.length && lines[i + 1].replace(/\s/g, '') === '{') {
          // 下一行单独一个 {
          out.push(lines[i + 1]);
          i++;
          inFunc = true;
          funcDepth = 1;
          funcStartIdx = i;
        }
      }
    } else {
      funcDepth += countChar(line, '{');
      funcDepth -= countChar(line, '}');
      if (funcDepth <= 0) {
        var bodyLines = i - funcStartIdx - 1;
        if (bodyLines > 0) {
          out.push('    /* ' + bodyLines + ' lines elided -- Read full file for body */');
        }
        out.push(line);
        inFunc = false;
        funcDepth = 0;
      }
    }
  }
  return out.join('\n');
}

/**
 * 从 feedback 文本里提取被点名的 phaseId / 函数名，回到完整代码里抓相应代码块（前后 ~15 行）。
 * 保证 LLM 在没有 Read 的情况下也能直接看到出问题的局部代码。
 */
function extractRelevantPhaseBlocks(code, feedback) {
  if (!code || !feedback || feedback.length === 0) return '';
  var text = '';
  for (var fi = 0; fi < feedback.length; fi++) {
    var fb = feedback[fi];
    text += ' ' + ((fb.data && fb.data.text) || fb.message || fb.text || '');
    if (fb.data && fb.data.structured) {
      var s = fb.data.structured;
      text += ' ' + (s.summary || '');
      if (s.issues) for (var ii = 0; ii < s.issues.length; ii++) text += ' ' + (s.issues[ii].message || '');
    }
  }

  // 抓 phase_xxx_N / PhaseName / Init/Update/Transition/Phase 函数名等
  var tokens = {};
  var phaseMatches = text.match(/phase_\d+_\d+/g) || [];
  phaseMatches.forEach(function(m) { tokens[m] = true; });
  var camelPhase = text.match(/\bPhase[A-Z]\w+/g) || [];
  camelPhase.forEach(function(m) { tokens[m] = true; });
  var initFns = text.match(/\b(?:Init|Update|Transition|Handle)Phase\w*/g) || [];
  initFns.forEach(function(m) { tokens[m] = true; });

  var tokenList = Object.keys(tokens).slice(0, 5);
  if (tokenList.length === 0) return '';

  var lines = code.split('\n');
  var out = [];
  var seen = {};
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    for (var t = 0; t < tokenList.length; t++) {
      if (line.indexOf(tokenList[t]) >= 0) {
        var from = Math.max(0, i - 3);
        var to = Math.min(lines.length, i + 18);
        var key = from + ':' + to;
        if (seen[key]) continue;
        seen[key] = true;
        out.push('// --- L' + (from + 1) + '-' + to + ' (matched: ' + tokenList[t] + ') ---');
        for (var k = from; k < to; k++) {
          out.push('L' + (k + 1) + ': ' + lines[k]);
        }
        out.push('');
        i = to; // skip ahead to avoid overlapping blocks
        break;
      }
    }
    if (out.length > 280) break; // hard cap ~280 lines
  }
  return out.join('\n');
}

// ========== 行为模板按需裁剪 helpers ==========
// behavior-templates.md 是按 ## Behavior: <Name> 分节的 Markdown
function filterBehaviorTemplates(text, usedNames) {
  if (!text) return '';
  if (!usedNames || usedNames.length === 0) {
    // No entities use templates → omit the whole section to save tokens
    return '';
  }
  var nameSet = {};
  usedNames.forEach(function(n) { nameSet[String(n).toLowerCase()] = true; });
  // Split by `## Behavior:` heading; first chunk is the file header
  var sections = text.split(/^##\s+Behavior:\s*/m);
  var header = sections[0] || '';
  var kept = [header];
  for (var i = 1; i < sections.length; i++) {
    var firstWord = (sections[i].split(/[\s\n]/)[0] || '').toLowerCase();
    if (nameSet[firstWord]) {
      kept.push('## Behavior: ' + sections[i]);
    }
  }
  // If nothing matched, fall back to header only — better than full 11KB dump
  return kept.length > 1 ? kept.join('') : header;
}

function detectUsedBehaviors(blueprint) {
  var set = {};
  var entities = (blueprint && blueprint.entities) || [];
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    if (e && e.behaviors && e.behaviors.length) {
      for (var j = 0; j < e.behaviors.length; j++) {
        var b = e.behaviors[j];
        var name = (b && (b.template || b.name || b.type)) || (typeof b === 'string' ? b : '');
        if (name) set[name] = true;
      }
    }
    // Some blueprints store the behavior name directly on the entity
    if (e && e.template) set[e.template] = true;
    if (e && e.behaviorTemplate) set[e.behaviorTemplate] = true;
  }
  return Object.keys(set);
}

module.exports = {
  parseBlueprintToPromptV5: parseBlueprintToPromptV5,
  PREFAB_REGISTRY: PREFAB_REGISTRY,
  matchPrefabs: matchPrefabs,
  filterBehaviorTemplates: filterBehaviorTemplates,
  detectUsedBehaviors: detectUsedBehaviors,
  buildRulesFromSpecs: buildRulesFromSpecs,
  resolvePromptRules: resolvePromptRules,
  buildCodeOutline: buildCodeOutline,
  extractRelevantPhaseBlocks: extractRelevantPhaseBlocks
};
