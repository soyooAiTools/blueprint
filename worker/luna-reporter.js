/**
 * Luna Agent HTML 报告生成器
 * 
 * 按 PlayCheck 审核标准（9大类）生成自包含 HTML 报告。
 * 复用 PlayCheck 的视觉风格，但数据来源是 Luna Agent 的结构化检测。
 * 
 * 用法: 
 *   const { generateHtmlReport } = require('./luna-reporter');
 *   const html = generateHtmlReport(report);
 *   fs.writeFileSync('report.html', html);
 */

const fs = require('fs');
const path = require('path');

// ─── 严重级别定义（对齐 PlayCheck） ───

const SEVERITY_MAP = {
  high: '阻断',
  medium: '严重',
  low: '中等',
  info: '建议'
};

const SEVERITY_COLORS = {
  '阻断': '#dc2626',
  '严重': '#ea580c',
  '中等': '#ca8a04',
  '建议': '#2563eb',
};

const SEVERITY_LABELS = {
  '阻断': '🔴 阻断',
  '严重': '🟠 严重',
  '中等': '🟡 中等',
  '建议': '🔵 建议',
};

// ─── 9大类审核标准 ───

const STANDARD_CATEGORIES = [
  { key: 'visual',      name: '画面美术',     icon: '🎨', checks: ['纹理质量', '比例协调', '色调光影', '接缝穿插', 'UI布局'] },
  { key: 'lighting',    name: '灯光',         icon: '💡', checks: ['亮度均衡', '高光质感', '层次引导'] },
  { key: 'color',       name: '配色',         icon: '🎨', checks: ['角色区分', '颜色协调', '饱和度控制'] },
  { key: 'effects',     name: '特效',         icon: '✨', checks: ['精细度', '交互反馈', '触发时机', '干扰控制'] },
  { key: 'animation',   name: '动画',         icon: '🎬', checks: ['运动节奏', '速度适当', '核心动画完整', '操作反馈'] },
  { key: 'interaction', name: '交互体验',     icon: '👆', checks: ['跟手性', '引导清晰', '反馈及时', 'CTA吸引力'] },
  { key: 'audio',       name: '音效',         icon: '🔊', checks: ['适配性', '音量均衡', '触发同步'] },
  { key: 'gameplay',    name: '游戏性与逻辑', icon: '🎮', checks: ['流程完整', '节奏把控', '逻辑一致'] },
  { key: 'tech',        name: '技术与适配',   icon: '⚙️', checks: ['穿模排查', '性能优化', '触控兼容', '加载过渡'] },
];

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 将 Luna Agent 的 bug 列表映射到 9 大类
 */
function classifyBugs(bugs) {
  const classified = {};
  STANDARD_CATEGORIES.forEach(c => {
    classified[c.key] = { passed: [], issues: [], score: 10 };
  });

  const allBugs = [];
  const globalDedup = new Set(); // 全局去重

  function dedupKey(desc) {
    return (desc || '').replace(/\d+/g, 'N').replace(/\(.*?\)/g, '').replace(/for N\+? consecutive/gi, 'consecutive').trim().substring(0, 60);
  }

  // AI 发现的 bug（先去重再分类）
  for (const bug of (bugs.fromAI || [])) {
    const desc = bug.description || '';
    const key = dedupKey(desc);
    if (globalDedup.has(key)) continue;
    globalDedup.add(key);

    const category = inferCategory(desc);
    const severity = inferSeverity(desc);
    classified[category].issues.push(desc);
    classified[category].score = Math.max(0, classified[category].score - severityPenalty(severity));
    allBugs.push({ ...bug, category, severity, source: 'ai' });
  }

  // 规则引擎发现的 bug（先去重再分类）
  for (const anomaly of (bugs.fromRules || [])) {
    const desc = anomaly.desc || '';
    const key = dedupKey(desc);
    if (globalDedup.has(key)) continue;
    globalDedup.add(key);

    const category = inferCategory(desc, anomaly.type);
    const severity = anomaly.severity === 'high' ? '阻断' : anomaly.severity === 'medium' ? '严重' : '中等';
    classified[category].issues.push(desc);
    classified[category].score = Math.max(0, classified[category].score - severityPenalty(severity));
    allBugs.push({ ...anomaly, description: desc, category, severity, source: 'rules' });
  }

  // 去重：同类问题只保留最严重的描述
  for (const key in classified) {
    const c = classified[key];
    c.issues = deduplicateIssues(c.issues);
    c.score = Math.max(0, Math.min(10, c.score));
    if (c.issues.length === 0) {
      c.passed.push('未检测到问题');
    }
  }

  return { classified, allBugs };
}

function inferCategory(desc, type) {
  const d = (desc || '').toLowerCase();
  if (type === 'performance' || d.includes('fps') || d.includes('performance') || d.includes('卡顿')) return 'tech';
  if (type === 'stuck' || d.includes('stuck') || d.includes('frozen') || d.includes('卡死')) return 'interaction';
  if (type === 'leak' || d.includes('leak') || d.includes('surge') || d.includes('泄漏')) return 'tech';
  if (type === 'out_of_bounds' || d.includes('out of bounds') || d.includes('出界')) return 'tech';
  if (type === 'ui_error' || d.includes('ui') || d.includes('nan') || d.includes('undefined')) return 'visual';
  if (type === 'empty_scene' || d.includes('empty') || d.includes('load')) return 'tech';
  if (d.includes('spawn') || d.includes('clone') || d.includes('duplicate')) return 'gameplay';
  if (d.includes('animation') || d.includes('动画')) return 'animation';
  if (d.includes('effect') || d.includes('特效')) return 'effects';
  if (d.includes('color') || d.includes('颜色')) return 'color';
  if (d.includes('light') || d.includes('灯光')) return 'lighting';
  if (d.includes('audio') || d.includes('sound') || d.includes('音效')) return 'audio';
  if (d.includes('drag') || d.includes('click') || d.includes('interact') || d.includes('操作')) return 'interaction';
  if (d.includes('gameplay') || d.includes('unplayable') || d.includes('游戏')) return 'gameplay';
  return 'tech'; // 默认归技术
}

function inferSeverity(desc) {
  const d = (desc || '').toLowerCase();
  if (d.includes('critical') || d.includes('unplayable') || d.includes('crash') || d.includes('black screen') || d.includes('崩溃') || d.includes('黑屏')) return '阻断';
  if (d.includes('stuck') || d.includes('frozen') || d.includes('malfunction') || d.includes('卡死') || d.includes('失败')) return '严重';
  if (d.includes('low') || d.includes('issue') || d.includes('not smooth') || d.includes('延迟')) return '中等';
  return '建议';
}

function severityPenalty(severity) {
  if (severity === '阻断') return 4;
  if (severity === '严重') return 2.5;
  if (severity === '中等') return 1;
  return 0.5;
}

function deduplicateIssues(issues) {
  const seen = new Set();
  const result = [];
  for (const iss of issues) {
    // 更激进的去重：去掉数字、括号内容、轮次信息
    const key = iss
      .replace(/\d+/g, 'N')
      .replace(/\(.*?\)/g, '')
      .replace(/for N\+? consecutive rounds?/gi, 'consecutive')
      .replace(/N\+?\s*rounds?/gi, 'rounds')
      .replace(/still |consistently |constantly /gi, '')
      .trim()
      .substring(0, 50);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(iss);
    }
  }
  return result;
}

/**
 * 内嵌截图为 base64
 */
function embedScreenshot(screenshotDir, filename) {
  if (!screenshotDir || !filename) return '';
  const filepath = path.join(screenshotDir, filename);
  if (!fs.existsSync(filepath)) return '';
  try {
    const data = fs.readFileSync(filepath).toString('base64');
    return 'data:image/jpeg;base64,' + data;
  } catch (e) {
    return '';
  }
}

/**
 * 生成 HTML 报告
 * @param {object} report - luna-agent 输出的报告 JSON
 * @param {string} screenshotDir - 截图目录路径（可选）
 */
function generateHtmlReport(report, screenshotDir) {
  const { classified, allBugs } = classifyBugs(report.bugs || {});

  // 去重后的 bug 列表
  const dedupedBugs = [];
  const seenDescs = new Set();
  for (const bug of allBugs) {
    const key = (bug.description || '').replace(/\d+/g, 'N').substring(0, 80);
    if (!seenDescs.has(key)) {
      seenDescs.add(key);
      dedupedBugs.push(bug);
    }
  }

  // 统计
  const stats = { '阻断': 0, '严重': 0, '中等': 0, '建议': 0 };
  dedupedBugs.forEach(b => stats[b.severity] = (stats[b.severity] || 0) + 1);
  const totalIssues = dedupedBugs.length;
  const score = Math.max(0, 100 - stats['阻断'] * 25 - stats['严重'] * 15 - stats['中等'] * 5 - stats['建议'] * 2);

  const adName = decodeURIComponent((report.url || '').split('/').filter(s => s.startsWith('fnd-') || s.startsWith('_fnd')).pop() || 'Unknown');

  // 9大类检查清单
  const checklistHtml = STANDARD_CATEGORIES.map(cat => {
    const data = classified[cat.key];
    const s = data.score;
    const color = s >= 8 ? '#22c55e' : s >= 6 ? '#eab308' : s >= 4 ? '#f97316' : '#ef4444';
    const passedHtml = data.passed.map(p => `<li style="color:#22c55e;font-size:13px">✅ ${escapeHtml(p)}</li>`).join('');
    const issuesHtml = data.issues.map(i => `<li style="color:#f97316;font-size:13px">⚠️ ${escapeHtml(i)}</li>`).join('');
    return `<div style="background:white;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:16px;font-weight:600">${cat.icon} ${escapeHtml(cat.name)}</span>
        <span style="background:${color}22;color:${color};padding:4px 12px;border-radius:20px;font-size:14px;font-weight:700">${s.toFixed(0)}/10</span>
      </div>
      ${passedHtml ? `<ul style="list-style:none;padding:0;margin:0 0 4px">${passedHtml}</ul>` : ''}
      ${issuesHtml ? `<ul style="list-style:none;padding:0;margin:0">${issuesHtml}</ul>` : ''}
    </div>`;
  }).join('\n');

  // 查找 bug 对应轮次的截图
  function findScreenshotForRound(round) {
    if (!report.history) return null;
    const h = report.history.find(function(x) { return x.round === round; });
    if (h && h.screenshot && screenshotDir) {
      return embedScreenshot(screenshotDir, h.screenshot);
    }
    // 也尝试直接用文件名
    if (screenshotDir) {
      const fname = 'round_' + String((round || 0) + 1).padStart(2, '0') + '.jpg';
      return embedScreenshot(screenshotDir, fname);
    }
    return null;
  }

  // 问题详情
  const issuesDetailHtml = dedupedBugs.map((bug, idx) => {
    const severity = bug.severity || '建议';
    const catInfo = STANDARD_CATEGORIES.find(c => c.key === bug.category) || { icon: '📋', name: '其他' };
    const screenshotSrc = findScreenshotForRound(bug.round);
    return `<div class="issue-card severity-${severity}">
      <div class="issue-header">
        <span class="issue-id">#${idx + 1}</span>
        <span class="severity-tag" style="background:${SEVERITY_COLORS[severity] || '#666'}">${SEVERITY_LABELS[severity] || severity}</span>
        <span class="issue-phase">${catInfo.icon} ${catInfo.name}</span>
        ${bug.round !== undefined ? `<span class="issue-round">第${bug.round + 1}轮</span>` : ''}
        <span style="font-size:11px;color:#94a3b8;margin-left:auto">${bug.source === 'ai' ? '🤖 AI检测' : '📏 规则检测'}</span>
      </div>
      <p class="issue-text">${escapeHtml(bug.description)}</p>
      ${screenshotSrc ? `<div style="margin-top:12px"><img src="${screenshotSrc}" alt="第${(bug.round||0)+1}轮截图" style="width:100%;border-radius:8px;border:1px solid #e2e8f0" loading="lazy" /></div>` : ''}
    </div>`;
  }).join('\n');

  // 操作时间线
  const timelineHtml = (report.history || []).map(h => {
    const hasIssues = h.bugs && h.bugs.length > 0;
    const actionsStr = (h.actions || []).join(', ');
    const timelineScreenshot = h.screenshot && screenshotDir ? embedScreenshot(screenshotDir, h.screenshot) : null;
    return `<div class="timeline-item ${hasIssues ? 'has-issues' : ''}">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-header">
          <span class="timeline-round">第${h.round + 1}轮</span>
          <span style="font-size:12px;color:#64748b">${escapeHtml(actionsStr)}</span>
        </div>
        ${timelineScreenshot ? `<img src="${timelineScreenshot}" alt="第${h.round+1}轮截图" style="width:100%;border-radius:8px;margin:8px 0;border:1px solid #e2e8f0" loading="lazy" />` : ''}
        ${hasIssues ? h.bugs.map(b => `<p class="timeline-issue">⚠️ ${escapeHtml(b)}</p>`).join('') : ''}
      </div>
    </div>`;
  }).join('\n');

  // AI 总结（从最后一轮的 thinking 提取）
  const lastHistory = (report.history || []).slice(-1)[0];
  const aiSummaryText = lastHistory ? (dedupedBugs.length > 0
    ? `检测完成，共发现 ${totalIssues} 个问题（阻断 ${stats['阻断']}、严重 ${stats['严重']}、中等 ${stats['中等']}、建议 ${stats['建议']}）。主要问题集中在 ${Object.entries(classified).filter(([k,v]) => v.issues.length > 0).map(([k,v]) => STANDARD_CATEGORIES.find(c=>c.key===k)?.name).filter(Boolean).join('、')} 方面。`
    : '检测完成，未发现明显问题。') : '';

  const durationSec = report.totalRounds ? report.totalRounds * 3 : 0; // 估算

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>审核报告 — ${escapeHtml(adName)}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
.container { max-width: 960px; margin: 0 auto; padding: 24px; }
.report-header { background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); color: white; padding: 40px; border-radius: 16px; margin-bottom: 32px; }
.report-header h1 { font-size: 28px; margin-bottom: 8px; }
.report-header .meta { opacity: 0.8; font-size: 14px; }
.report-header .meta span { margin-right: 16px; }

.summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 32px; }
.summary-card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
.summary-card .value { font-size: 36px; font-weight: 700; }
.summary-card .label { font-size: 14px; color: #64748b; margin-top: 4px; }

.section { margin-bottom: 32px; }
h2 { font-size: 22px; margin: 32px 0 16px; padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; }

.issue-card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-left: 4px solid #e2e8f0; }
.issue-card.severity-阻断 { border-left-color: #dc2626; }
.issue-card.severity-严重 { border-left-color: #ea580c; }
.issue-card.severity-中等 { border-left-color: #ca8a04; }
.issue-card.severity-建议 { border-left-color: #2563eb; }
.issue-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.issue-id { font-weight: 700; font-size: 16px; }
.severity-tag { color: white; padding: 2px 10px; border-radius: 12px; font-size: 13px; font-weight: 600; }
.issue-phase, .issue-round { font-size: 13px; color: #64748b; }
.issue-text { font-size: 15px; }

.timeline { position: relative; padding-left: 32px; }
.timeline::before { content: ''; position: absolute; left: 11px; top: 0; bottom: 0; width: 2px; background: #cbd5e1; }
.timeline-item { position: relative; margin-bottom: 16px; }
.timeline-dot { position: absolute; left: -28px; top: 4px; width: 14px; height: 14px; border-radius: 50%; background: #cbd5e1; border: 2px solid white; }
.timeline-item.has-issues .timeline-dot { background: #dc2626; }
.timeline-content { background: white; border-radius: 12px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.timeline-header { display: flex; gap: 8px; align-items: center; }
.timeline-round { font-weight: 600; font-size: 14px; }
.timeline-issue { font-size: 14px; color: #dc2626; margin-top: 4px; }

.engine-badge { display: inline-block; background: #dbeafe; color: #1d4ed8; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }

.footer { text-align: center; padding: 32px; color: #94a3b8; font-size: 13px; }
</style>
</head>
<body>
<div class="container">
  <div class="report-header">
    <h1>📋 审核报告 — ${escapeHtml(adName)}</h1>
    <div class="meta">
      <span>🔗 <a href="${escapeHtml(report.url)}" target="_blank" style="color:#93c5fd;text-decoration:none">${escapeHtml(report.url)}</a></span><br>
      <span>📅 ${escapeHtml(report.timestamp || new Date().toISOString())}</span>
      <span>🤖 <span class="engine-badge">Luna Agent</span> · ${report.totalRounds} 轮 · ${report.exitReason === 'ai_done' ? 'AI完成' : report.exitReason === 'stuck' ? '检测到卡住' : '检测完成'}</span>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="value" style="color:${score >= 80 ? '#16a34a' : score >= 60 ? '#ca8a04' : '#dc2626'}">${score}</div>
      <div class="label">综合得分</div>
    </div>
    <div class="summary-card">
      <div class="value">${totalIssues}</div>
      <div class="label">发现问题</div>
    </div>
    <div class="summary-card">
      <div class="value" style="color:#dc2626">${stats['阻断']}</div>
      <div class="label">阻断级</div>
    </div>
    <div class="summary-card">
      <div class="value" style="color:#ea580c">${stats['严重']}</div>
      <div class="label">严重级</div>
    </div>
    <div class="summary-card">
      <div class="value" style="color:#ca8a04">${stats['中等']}</div>
      <div class="label">中等级</div>
    </div>
    <div class="summary-card">
      <div class="value" style="color:#2563eb">${stats['建议']}</div>
      <div class="label">建议级</div>
    </div>
  </div>

  <div class="section">
    <h2>📋 9大类标准检查清单</h2>
    ${checklistHtml}
  </div>

  ${totalIssues > 0 ? `<div class="section"><h2>🔍 问题详情（去重后 ${totalIssues} 项）</h2>${issuesDetailHtml}</div>` : '<div class="section"><h2>✅ 未发现问题</h2><p>AI检测未发现明显问题。</p></div>'}

  ${aiSummaryText ? `<div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:12px 16px;margin:16px 0;border-radius:4px;font-size:14px;"><strong>🤖 AI 审核总结：</strong>${escapeHtml(aiSummaryText)}</div>` : ''}

  <div class="section">
    <h2>📊 操作时间线</h2>
    <div class="timeline">
      ${timelineHtml}
    </div>
  </div>

  <div class="footer">
    Generated by Luna Agent Browser · PlayCheck QC Standards v1.0 · ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;

  return html;
}

module.exports = { generateHtmlReport };
