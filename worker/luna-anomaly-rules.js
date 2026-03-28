/**
 * Luna Anomaly Rules — 规则引擎异常检测
 * 
 * 零 LLM 成本的结构化 Bug 检测。
 * 在 AI 决策循环中每帧调用，不消耗 token。
 * 
 * Node.js CommonJS 模块
 */

/**
 * 检测异常
 * @param {object} snapshot - compactSnapshot() 的返回值（含 _raw）
 * @param {object} context - { round, stuckCount, prevObjectCount, history }
 * @returns {Array} anomalies - [{ type, severity, desc }]
 */
function detectAnomalies(snapshot, context) {
  var anomalies = [];
  context = context || {};

  var raw = snapshot._raw || {};
  var health = raw.health || {};
  var diff = raw.diff || {};
  var objects = raw.objects || [];
  var ui = raw.ui || {};

  // ─── 1. 对象数暴涨（内存泄漏） ───
  if (context.prevObjectCount && context.prevObjectCount > 10 &&
      health.objectCount > context.prevObjectCount * 2) {
    anomalies.push({
      type: 'leak',
      severity: 'high',
      desc: '对象数量暴涨：' + context.prevObjectCount + ' → ' + health.objectCount + '，疑似内存泄漏'
    });
  }

  // ─── 3. 卡死检测 ───
  if (context.stuckCount && context.stuckCount >= 3) {
    anomalies.push({
      type: 'stuck',
      severity: 'high',
      desc: '连续 ' + context.stuckCount + ' 轮无状态变化，游戏疑似卡死'
    });
  }

  // ─── 4. UI 文本异常 ───
  if (ui.texts) {
    for (var i = 0; i < ui.texts.length; i++) {
      var text = ui.texts[i].text || '';
      if (text.indexOf('NaN') >= 0 || text.indexOf('undefined') >= 0 ||
          text.indexOf('null') >= 0 || text.indexOf('Error') >= 0 ||
          text.indexOf('Exception') >= 0) {
        anomalies.push({
          type: 'ui_error',
          severity: 'medium',
          desc: 'UI 文本异常 "' + ui.texts[i].name + '"：显示 "' + text + '"'
        });
      }
    }
  }

  // ─── 5. 玩家出界 ───
  for (var j = 0; j < objects.length; j++) {
    var obj = objects[j];
    if (!obj || !obj.position || !obj.name) continue;
    var name = obj.name.toLowerCase();
    if (name.indexOf('player') >= 0 || name.indexOf('hero') >= 0 || name.indexOf('character') >= 0) {
      // Skip objects at pool-hidden positions (y <= -500 is standard hide position)
      if (obj.position.y <= -500) continue;
      var px = Math.abs(obj.position.x);
      var py = Math.abs(obj.position.y);
      var pz = Math.abs(obj.position.z);
      if (px > 100 || py > 100 || pz > 100) {
        anomalies.push({
          type: 'out_of_bounds',
          severity: 'medium',
          desc: '玩家 "' + obj.name + '" 超出地图边界：(' +
                obj.position.x.toFixed(1) + ', ' + obj.position.y.toFixed(1) + ', ' + obj.position.z.toFixed(1) + ')'
        });
      }
    }
  }

  // ─── 6. 零对象（场景加载失败） ───
  if (health.objectCount === 0 && context.round > 0) {
    anomalies.push({
      type: 'empty_scene',
      severity: 'high',
      desc: '场景中没有找到任何游戏对象，场景可能加载失败'
    });
  }

  // ─── 7. CTA 按钮检测 ───
  // 检查是否存在 CTA 相关的 UI 文本（PLAY NOW, 立刻开始, INSTALL, 下载, GET 等）
  var ctaKeywords = ['play now', 'install', 'download', 'get it', '立刻开始', '立即下载', '马上玩', '开始游戏', 'try now', 'get the game', 'shop now'];
  var hasCTA = false;
  if (ui.texts) {
    for (var ci = 0; ci < ui.texts.length; ci++) {
      var ctaText = (ui.texts[ci].text || '').toLowerCase();
      for (var ck = 0; ck < ctaKeywords.length; ck++) {
        if (ctaText.indexOf(ctaKeywords[ck]) >= 0) {
          hasCTA = true;
          break;
        }
      }
    }
  }

  // 如果 CTA 出现但连续 2+ 轮卡在同一场景（有 CTA 且 stuck），标记为 CTA 无响应
  if (hasCTA && context.stuckCount && context.stuckCount >= 2) {
    anomalies.push({
      type: 'cta_unresponsive',
      severity: 'high',
      desc: 'CTA 按钮（PLAY NOW/立刻开始等）点击后无响应，可能是跳转链接失效或按钮未绑定事件'
    });
  }

  // 如果传入了 ctaClickCount（CUA/Chat 循环追踪的 CTA 点击次数）
  if (context.ctaClickCount && context.ctaClickCount >= 2 && context.ctaClickChanged === false) {
    anomalies.push({
      type: 'cta_click_failed',
      severity: 'high',
      desc: 'CTA 按钮被点击 ' + context.ctaClickCount + ' 次但场景无变化，CTA 功能失效'
    });
  }

  // ─── 8. 对象大量消失 ───
  if (diff.disappeared && diff.disappeared.length > 10) {
    anomalies.push({
      type: 'mass_disappear',
      severity: 'medium',
      desc: diff.disappeared.length + ' 个对象同时消失，可能存在场景切换异常'
    });
  }

  return anomalies;
}

module.exports = { detectAnomalies: detectAnomalies };
