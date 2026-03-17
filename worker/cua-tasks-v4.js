/**
 * V4 CUA Task Generator
 * 从事件规则+实体行为自动生成 CUA 验证任务
 */

/**
 * 从 V4 蓝图生成 CUA 验证任务列表
 * @param {object} blueprint - V4 蓝图
 * @returns {Array<{id, name, description, actions, successCriteria}>}
 */
function generateCUATasks(blueprint) {
  var entities = blueprint.entities || [];
  var phases = blueprint.phases || [];

  // 从 phaseNode 提取 phases
  if (phases.length === 0 && blueprint.nodes) {
    phases = blueprint.nodes
      .filter(function(n) { return n.type === 'phaseNode'; })
      .map(function(n) {
        var d = n.data || {};
        return {
          id: d.phaseId || 0,
          name: d.name || d.label || '',
          triggerCondition: d.triggerCondition || '',
          activate: d.activate || [],
          guide: d.guide || '',
        };
      })
      .sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
  }

  var tasks = [];

  // Task 0: 初始加载验证
  tasks.push({
    id: 'init',
    name: '游戏初始化',
    description: '验证游戏能否正常加载并显示初始场景',
    actions: ['等待页面加载完成', '观察场景是否出现 3D 对象'],
    successCriteria: '屏幕上有可见的 3D 对象（彩色方块），有虚拟摇杆控件',
  });

  // 根据实体模板生成验证任务
  var playerEntity = entities.find(function(e) { return e.template === 'PlayerController'; });
  if (playerEntity) {
    tasks.push({
      id: 'player_move',
      name: '玩家移动',
      description: '验证玩家可以通过摇杆移动',
      actions: [
        '找到屏幕左下角的虚拟摇杆',
        '向右拖拽摇杆',
        '观察玩家方块是否移动',
      ],
      successCriteria: '蓝色方块（玩家）向右移动',
    });
  }

  // 根据事件规则生成验证任务
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i];
    // 兼容旧格式：triggerCondition 或从上一个 phase 的 endCondition 推导
    var trigger = p.triggerCondition || '';
    if (!trigger && i === 0) trigger = 'gameStart';
    if (!trigger && i > 0) trigger = phases[i - 1].endCondition || '';
    if (trigger === 'gameStart' && i === 0) continue; // 已在 init 里验证

    var task = {
      id: 'rule_' + (p.id || i + 1),
      name: p.name || ('规则 ' + (i + 1)),
      description: '',
      actions: [],
      successCriteria: '',
    };

    // 根据触发条件推断玩家操作
    if (trigger.indexOf('.state') >= 0 && trigger.indexOf('built') >= 0) {
      // X.state == built → 需要先建造 X
      var buildTarget = trigger.split('.')[0];
      var ent = entities.find(function(e) { return e.name === buildTarget; });
      if (ent && ent.template && ent.template.indexOf('Buildable') >= 0) {
        var triggerType = ent.trigger && ent.trigger.type || 'proximity';
        if (triggerType === 'proximity') {
          task.actions.push('移动玩家靠近 ' + (ent.label || buildTarget) + '（' + describePosition(ent) + '）');
          task.actions.push('等待建造完成');
        } else if (triggerType === 'click') {
          task.actions.push('点击 ' + (ent.label || buildTarget));
        }
        task.successCriteria = (ent.label || buildTarget) + ' 建造完成，可能出现新的实体';
      }
    } else if (trigger.indexOf('killed') >= 0) {
      var match = trigger.match(/([\w_]+)\.killed\s*>=?\s*(\d+)/);
      if (match) {
        task.actions.push('等待或辅助击杀敌人 ' + match[1] + ' 至少 ' + match[2] + ' 个');
        task.actions.push('如果有弩炮/炮塔，点击射击按钮');
        task.successCriteria = '击杀数达标，场景发生变化（新实体出现或阶段转换）';
      }
    } else if (trigger.indexOf('>=') >= 0) {
      var resMatch = trigger.match(/([\w]+)\s*>=\s*(\d+)/);
      if (resMatch) {
        task.actions.push('收集资源 ' + resMatch[1] + ' 至少 ' + resMatch[2]);
        task.successCriteria = resMatch[1] + ' 达到 ' + resMatch[2] + '，触发新事件';
      }
    } else if (trigger.indexOf('.hp') >= 0 && trigger.indexOf('<= 0') >= 0) {
      var bossName = trigger.split('.')[0];
      task.actions.push('持续攻击 ' + bossName + ' 直到生命值归零');
      task.successCriteria = bossName + ' 被消灭';
    } else if (trigger.indexOf('.count') >= 0) {
      var spawnTarget = trigger.split('.')[0];
      task.actions.push('等待 ' + spawnTarget + ' 生成');
      task.successCriteria = spawnTarget + ' 出现在场景中';
    }

    // 补充激活实体的说明
    if (p.activate && p.activate.length > 0) {
      var activateNames = p.activate.map(function(name) {
        var e = entities.find(function(ent) { return ent.name === name; });
        return e ? (e.label || name) : name;
      });
      task.description = '当 [' + trigger + '] 满足时，激活: ' + activateNames.join(', ');
      if (!task.successCriteria) {
        task.successCriteria = '新实体出现: ' + activateNames.join(', ');
      }
    } else {
      task.description = '当 [' + trigger + '] 满足时的阶段转换';
    }

    if (p.guide) {
      task.actions.unshift('引导提示: ' + p.guide);
    }

    if (task.actions.length > 0) {
      tasks.push(task);
    }
  }

  // 最后: 游戏结束验证
  tasks.push({
    id: 'end',
    name: '游戏结束',
    description: '验证游戏最终能到达结束画面',
    actions: ['完成所有阶段后观察是否出现结束画面或 CTA 按钮'],
    successCriteria: '出现 "Install" / "Download" 按钮或结束动画',
  });

  return tasks;
}

function describePosition(entity) {
  if (!entity.visual || !entity.visual.position) return '场景中';
  return '位置 ' + entity.visual.position;
}

/**
 * 生成 CUA 可读的验证报告文本
 */
function formatCUATasksForPrompt(tasks) {
  var lines = [];
  lines.push('# CUA 验证任务清单');
  lines.push('按顺序执行以下任务，验证试玩广告是否正常工作：');
  lines.push('');

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    lines.push('## 任务 ' + (i + 1) + ': ' + t.name);
    if (t.description) lines.push(t.description);
    lines.push('');
    lines.push('**操作步骤：**');
    for (var j = 0; j < t.actions.length; j++) {
      lines.push((j + 1) + '. ' + t.actions[j]);
    }
    lines.push('');
    lines.push('**成功标准：** ' + t.successCriteria);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { generateCUATasks, formatCUATasksForPrompt };

// CLI test
if (require.main === module) {
  var fs = require('fs');
  var bp = JSON.parse(fs.readFileSync(process.argv[2] || 'docs/qmjs-v4-blueprint.json', 'utf8'));
  var tasks = generateCUATasks(bp);
  console.log(formatCUATasksForPrompt(tasks));
  console.log('\n---\nTotal tasks:', tasks.length);
}
