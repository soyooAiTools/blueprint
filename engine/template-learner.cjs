/**
 * Template Learner — 从成功的项目代码中自动提取新行为模板
 *
 * 触发时机：pipeline 成功完成后
 * 工作原理：
 *   1. 读取项目的 specs，提取 behavior 类型列表
 *   2. 对比 behavior-templates.md 已有的模板
 *   3. 发现新 behavior 时，从成功的 C# 代码中提取模板片段
 *   4. 追加到 behavior-templates.md
 */

var fs = require('fs');
var path = require('path');

var TEMPLATES_PATH = path.join(__dirname, '..', 'worker', 'behavior-templates.md');
var LEARNED_LOG = path.join(__dirname, '..', 'server-data', 'learned-templates.json');

// 已知模板 keyword → section title 映射
var KNOWN_BEHAVIORS = [
  'playercontroller', 'buildable', 'shooter', 'mover', 'damageable',
  'spawner', 'collectible', 'projectile',
  'carry', 'pickup', 'deliver', 'upgradeable', 'drag',
  'resourceconverter', 'converter'
];

/**
 * 从 specs 中提取所有 behavior 类型
 */
function extractBehaviors(specs) {
  var behaviors = new Set();
  if (!Array.isArray(specs)) return behaviors;
  specs.forEach(function(spec) {
    // From entitiesRequired
    (spec.entitiesRequired || []).forEach(function(e) {
      if (e.behavior) behaviors.add(e.behavior.toLowerCase());
      if (e.type) behaviors.add(e.type.toLowerCase());
    });
    // From requiredInteractions
    (spec.requiredInteractions || []).forEach(function(inter) {
      if (inter.type) behaviors.add(inter.type.toLowerCase());
    });
    // From trigger
    if (spec.triggerNext && spec.triggerNext.type) {
      behaviors.add(spec.triggerNext.type.toLowerCase());
    }
  });
  return behaviors;
}

/**
 * 检查 behavior-templates.md 中是否已有该 behavior
 */
function hasTemplate(templateContent, behavior) {
  var lower = templateContent.toLowerCase();
  // Check section headers and code comments
  return lower.indexOf('## ' + behavior) >= 0
    || lower.indexOf('模板') >= 0 && lower.indexOf(behavior) >= 0
    || KNOWN_BEHAVIORS.indexOf(behavior) >= 0;
}

/**
 * 从成功的 C# 代码中提取与特定 behavior 相关的代码片段
 */
function extractCodeSnippet(csCode, behavior) {
  if (!csCode) return null;
  var lines = csCode.split('\n');
  var snippetLines = [];
  var inRelevant = false;
  var braceDepth = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var lower = line.toLowerCase();

    // Find method that matches behavior name
    if (!inRelevant && (
      lower.indexOf('void update' + behavior) >= 0 ||
      lower.indexOf('void ' + behavior) >= 0 ||
      lower.indexOf('// ' + behavior) >= 0 ||
      lower.indexOf('void handle' + behavior) >= 0
    )) {
      inRelevant = true;
      braceDepth = 0;
    }

    if (inRelevant) {
      snippetLines.push(line);
      for (var c = 0; c < line.length; c++) {
        if (line[c] === '{') braceDepth++;
        if (line[c] === '}') braceDepth--;
      }
      if (braceDepth <= 0 && snippetLines.length > 3) {
        break; // End of method
      }
      if (snippetLines.length > 40) break; // Safety limit
    }
  }

  return snippetLines.length > 3 ? snippetLines.join('\n') : null;
}

/**
 * 记录学习到的新 behavior（供追踪）
 */
function logLearned(taskId, behavior, snippet) {
  var log = [];
  try {
    if (fs.existsSync(LEARNED_LOG)) {
      log = JSON.parse(fs.readFileSync(LEARNED_LOG, 'utf-8'));
    }
  } catch(e) {}

  log.push({
    taskId: taskId,
    behavior: behavior,
    hasSnippet: !!snippet,
    timestamp: new Date().toISOString()
  });

  // Keep last 100 entries
  if (log.length > 100) log = log.slice(-100);

  try {
    fs.writeFileSync(LEARNED_LOG, JSON.stringify(log, null, 2));
  } catch(e) {}
}

/**
 * 主入口：pipeline 成功后调用
 * @param {object} ctx - pipeline context with taskId, specs, csCode
 */
function learnFromSuccess(ctx) {
  try {
    var specsPath = path.join(__dirname, '..', 'spec-data', ctx.taskId + '-specs.json');
    if (!fs.existsSync(specsPath)) return;

    var specs = JSON.parse(fs.readFileSync(specsPath, 'utf-8'));
    var behaviors = extractBehaviors(specs);
    if (behaviors.size === 0) return;

    var templateContent = '';
    try {
      templateContent = fs.readFileSync(TEMPLATES_PATH, 'utf-8');
    } catch(e) { return; }

    var newBehaviors = [];
    behaviors.forEach(function(b) {
      if (!hasTemplate(templateContent, b)) {
        newBehaviors.push(b);
      }
    });

    if (newBehaviors.length === 0) return;

    // Extract code snippets from successful C# code
    var csCode = ctx.csCode || '';
    var additions = [];

    newBehaviors.forEach(function(behavior) {
      var snippet = extractCodeSnippet(csCode, behavior);
      logLearned(ctx.taskId, behavior, snippet);

      if (snippet) {
        additions.push('\n## ' + behavior.charAt(0).toUpperCase() + behavior.slice(1) + '（自动学习）模板\n');
        additions.push('> 从项目 ' + ctx.taskId + ' 成功代码中自动提取\n');
        additions.push('\n```csharp\n' + snippet + '\n```\n');
      } else {
        // Even without snippet, record the behavior as known
        additions.push('\n## ' + behavior.charAt(0).toUpperCase() + behavior.slice(1) + '（待补充）模板\n');
        additions.push('> 发现于项目 ' + ctx.taskId + '，暂无参考代码，AI需自行实现\n');
      }
    });

    if (additions.length > 0) {
      // Insert before the Anti-Pattern section
      var antiPatternIdx = templateContent.indexOf('## 🚨 禁止的 Anti-Pattern');
      if (antiPatternIdx >= 0) {
        templateContent = templateContent.substring(0, antiPatternIdx)
          + additions.join('\n') + '\n'
          + templateContent.substring(antiPatternIdx);
      } else {
        templateContent += '\n' + additions.join('\n');
      }
      fs.writeFileSync(TEMPLATES_PATH, templateContent);
      console.log('[template-learner] Added ' + newBehaviors.length + ' new behavior templates: ' + newBehaviors.join(', '));
    }
  } catch(e) {
    console.log('[template-learner] Error: ' + e.message);
  }
}

module.exports = { learnFromSuccess: learnFromSuccess };
