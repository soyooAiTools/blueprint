/**
 * Blueprint V4 Prompt Generator
 * 实体驱动架构：实体行为定义 + 事件触发链 + 行为模板
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
 * V4 蓝图 → AI Prompt
 * @param {object} blueprint - V4 格式蓝图数据
 * @param {object} opts - { projectContext, existingCode, feedback }
 * @returns {string} prompt
 */
function parseBlueprintToPromptV4(blueprint, opts) {
  opts = opts || {};
  var entities = blueprint.entities || [];
  var phases = blueprint.phases || [];
  var settings = blueprint.globalSettings || {};
  var params = blueprint.globalParams || {};

  var lines = [];

  // ========== 1. 任务说明 ==========
  lines.push('# 任务');
  lines.push('在 GameFlowManagerMain.cs 中实现一个 Luna 试玩广告。');
  lines.push('采用【实体驱动架构】：每个游戏实体有独立的行为方法，由事件触发链串联。');
  lines.push('');

  // ========== 2. 全局设置 ==========
  lines.push('# 全局设置');
  if (settings.gameType) lines.push('游戏类型: ' + settings.gameType);
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

    // 出生条件
    if (e.spawn) {
      var spawnLine = '出生: ';
      if (e.spawn.condition === 'runtime') {
        spawnLine += '运行时动态创建（对象池）';
      } else if (e.spawn.condition && e.spawn.condition.indexOf('phase:') === 0) {
        spawnLine += 'Phase ' + e.spawn.condition.split(':')[1] + ' 激活';
      } else if (e.spawn.condition && e.spawn.condition.indexOf('entity:') === 0) {
        spawnLine += '当 ' + e.spawn.condition.split(':')[1] + ' 时激活';
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
        if (tp.interval) trigLine += ', 间隔' + tp.interval + 's';
        if (tp.dropTarget) trigLine += ', 拖到' + tp.dropTarget + '(半径' + tp.dropRadius + ')';
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

      // onBuilt
      if (bh.onBuilt && bh.onBuilt.length > 0) {
        var builtActions = bh.onBuilt.map(function(a) {
          return a.type + '(' + (a.params.target || '') + ')';
        }).join(' → ');
        lines.push('建造完成: ' + builtActions);
      }

      // onArrive
      if (bh.onArrive && bh.onArrive.length > 0) {
        var arriveActions = bh.onArrive.map(function(a) {
          return a.type + '(' + (a.params.target || '') + ')';
        }).join(' → ');
        lines.push('到达后: ' + arriveActions);
      }
    }

    // 动作
    if (e.actions && e.actions.length > 0) {
      for (var ai = 0; ai < e.actions.length; ai++) {
        var act = e.actions[ai];
        if (act.type === 'onDeath') {
          var deathLine = '死亡: ';
          if (act.params.drop) deathLine += '掉落' + act.params.drop + '×' + (act.params.count || 1);
          if (act.params.trigger) deathLine += '触发' + act.params.trigger;
          lines.push(deathLine);
        } else if (act.type === 'addResource') {
          var resKeys = Object.keys(act.params);
          lines.push('拾取: +' + resKeys.map(function(k) { return act.params[k] + k; }).join(', '));
        }
      }
    }

    lines.push('');
  }

  // ========== 5. 事件触发链（Phases）==========
  lines.push('# 事件触发链');
  lines.push('Phase 之间由条件驱动，不是时间驱动。条件满足自动进入下一 Phase。');
  lines.push('');

  for (var pi = 0; pi < phases.length; pi++) {
    var p = phases[pi];
    var pLine = 'Phase ' + p.id + ': ' + p.name;
    lines.push(pLine);
    if (p.activate && p.activate.length > 0) {
      lines.push('  激活: ' + p.activate.join(', '));
    }
    if (p.endCondition) {
      lines.push('  结束条件: ' + p.endCondition);
    }
    if (p.guide) {
      lines.push('  引导: ' + p.guide);
    }
    if (p.camera) {
      lines.push('  镜头: 看向' + p.camera.lookAt + ', 缩放' + p.camera.zoom);
    }
    if (p.actions) {
      lines.push('  结束动作: ' + p.actions.join(', '));
    }
    if (p.$note) {
      lines.push('  注: ' + p.$note);
    }
    lines.push('');
  }

  // ========== 6. 代码架构要求 ==========
  lines.push('# 代码架构要求');
  lines.push('');
  lines.push('1. 所有代码在一个文件 GameFlowManagerMain.cs 中');
  lines.push('2. 用平行数组管理实体状态（eGo[], eActive[], eState[], eTimer[], eHP[]）');
  lines.push('3. 每个实体一个 UpdateXxx(int idx, float dt) 方法');
  lines.push('4. Update() 中遍历所有已激活实体，分发到对应的 Update 方法');
  lines.push('5. CheckPhaseTransition() 检查 Phase 转场条件');
  lines.push('6. 动态生成的实体（敌人、弹药、金币）用对象池管理');
  lines.push('7. 用 GFM_Create.Obj() 创建 3D 对象，GFM_Create.SetColor() 设颜色');
  lines.push('8. 用 GFM_Tools.SliderValue() 读取虚拟摇杆');
  lines.push('9. 隐藏对象用 position=(0,-999,0)，不用 SetActive(false)');
  lines.push('10. 游戏结束调用 Luna.Unity.LifeCycle.GameEnded()');
  lines.push('11. CTA 调用 Luna.Unity.Playable.InstallFullGame()');
  lines.push('');

  // ========== 7. 行为模板参考 ==========
  if (BEHAVIOR_TEMPLATES) {
    lines.push('# 行为模板参考代码');
    lines.push('以下是每种模板的标准实现方式，请参考但不要照抄，根据实体定义调整参数。');
    lines.push('');
    lines.push(BEHAVIOR_TEMPLATES);
  }

  // ========== 8. 反馈修复（如有）==========
  if (opts.feedback && opts.feedback.length > 0) {
    lines.push('');
    lines.push('# CUA 反馈（需修复的问题）');
    for (var fi = 0; fi < opts.feedback.length; fi++) {
      var fb = opts.feedback[fi];
      lines.push('- ' + (fb.data ? fb.data.text : JSON.stringify(fb)));
    }
  }

  // ========== 9. 现有代码（增量修复用）==========
  if (opts.existingCode) {
    lines.push('');
    lines.push('# 当前代码（需要修复，不要从头重写）');
    lines.push('```csharp');
    lines.push(opts.existingCode);
    lines.push('```');
  }

  return lines.join('\n');
}

// 导出
module.exports = { parseBlueprintToPromptV4: parseBlueprintToPromptV4 };

// 测试：如果直接运行
if (require.main === module) {
  var testBP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'qmjs-v4-blueprint.json'), 'utf-8'));
  var prompt = parseBlueprintToPromptV4(testBP);
  console.log(prompt);
  console.log('\n--- STATS ---');
  console.log('Prompt length:', prompt.length, 'chars');
  console.log('Entities:', testBP.entities.length);
  console.log('Phases:', testBP.phases.length);
}
