var fs = require('fs');
var path = require('path');

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return '';
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function listCsFiles(root) {
  var candidates = [
    path.join(root, 'Assets', 'Program', 'Script', 'Manager'),
    path.join(root, 'Scripts'),
    root
  ];
  var dir = null;
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i]) && fs.statSync(candidates[i]).isDirectory()) {
      dir = candidates[i];
      break;
    }
  }
  if (!dir) return [];
  return fs.readdirSync(dir)
    .filter(function(name) { return /\.cs$/i.test(name); })
    .map(function(name) { return path.join(dir, name); });
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function collectProjectInfo(root, options) {
  options = options || {};
  var csFiles = listCsFiles(root);
  var byName = {};
  csFiles.forEach(function(file) { byName[path.basename(file)] = file; });

  var flowText = readText(byName['GameFlowManagerMain.Flow.cs']);
  var phasesText = readText(byName['GameFlowManagerMain.Phases.cs']);
  var mainText = readText(byName['GameFlowManagerMain.cs']);
  var phaseSet = {};
  var match;
  var caseRe = /case\s+"([^"]+)"/g;
  while ((match = caseRe.exec(flowText))) phaseSet[match[1]] = true;
  var phaseRe = /void\s+Phase_([A-Za-z0-9_]+)_Init\s*\(/g;
  while ((match = phaseRe.exec(phasesText))) phaseSet[match[1]] = true;
  var phases = Object.keys(phaseSet);

  var files = [
    'GameFlowManagerMain.cs',
    'GameFlowManagerMain.Entities.cs',
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Phases.cs',
    'GameFlowManagerMain.Flow.AutoPlay.cs',
    'GameFlowManagerMain.Resource.cs',
    'GameFlowManagerMain.UI.cs',
    'GameFlowManagerMain.PreviewState.cs',
    'GameFlowManagerMain.Scene.cs',
    'GameFlowManagerMain.Input.cs'
  ].filter(function(name) { return !!byName[name]; });

  var domainFiles = csFiles
    .map(function(file) { return path.basename(file); })
    .filter(function(name) { return /^GameFlowManagerMain\.Flow\..+\.cs$/.test(name) && name !== 'GameFlowManagerMain.Flow.AutoPlay.cs'; })
    .sort();

  var hasFullUnity = fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'ProjectSettings'));
  var hasCommons = fs.existsSync(path.join(root, 'Assets', 'Program', 'Script', 'Commons')) || fs.existsSync(path.join(root, 'Scripts'));

  return {
    id: options.projectId || options.id || '',
    name: options.projectName || options.name || '',
    root: root,
    csFiles: csFiles,
    files: files,
    domainFiles: domainFiles,
    phases: phases,
    hasFullUnity: hasFullUnity,
    hasCommons: hasCommons,
    hasStart: /void\s+Start\s*\(/.test(mainText),
    hasUpdate: /void\s+Update\s*\(/.test(mainText)
  };
}

function mermaidPhaseFlow(phases) {
  if (!phases.length) return 'flowchart LR\n    A["未检测到 Phase_*_Init 或 currentPhaseName switch"]';
  var lines = ['flowchart LR'];
  phases.forEach(function(phase, idx) {
    lines.push('    P' + (idx + 1) + '["' + phase + '"]');
  });
  for (var i = 0; i < phases.length - 1; i++) {
    lines.push('    P' + (i + 1) + ' --> P' + (i + 2));
  }
  return lines.join('\n');
}

function buildMarkdown(info) {
  var title = info.name || info.id || path.basename(info.root);
  var domainText = info.domainFiles.length ? info.domainFiles.join(' / ') : 'Flow.*.cs';
  return [
    '# 代码关系图',
    '',
    '项目：' + title,
    '',
    '本文件由 `lib/code-relation-graph-writer.cjs` 自动生成。用于给接手程序员快速说明工程的代码关联、运行时调用链和阶段顺序。',
    '',
    '## 总览',
    '',
    '```mermaid',
    'flowchart TD',
    '    Main["GameFlowManagerMain.cs<br/>Start / Update / 主状态"]',
    '    Entities["Entities.cs<br/>实体字段 / 对象池绑定"]',
    '    Flow["Flow.cs<br/>点击分发 / 阶段辅助"]',
    '    Phases["Phases.cs<br/>Init / OnTap / Snapshot"]',
    '    Auto["Flow.AutoPlay.cs<br/>CUA 自动推进"]',
    '    Domain["' + domainText + '<br/>领域 assembly slots"]',
    '    Resource["Resource.cs<br/>资源采集 / 花费 / 回收"]',
    '    UI["UI.cs<br/>guide / score / CTA"]',
    '    Preview["PreviewState.cs<br/>preview/CUA JSON"]',
    '    SceneInput["Scene*.cs / Input.cs<br/>摆放 / 镜头 / 输入"]',
    '    Commons["Commons/GFM_*.cs<br/>通用库"]',
    '    Main --> Entities',
    '    Main --> Flow',
    '    Flow --> Phases',
    '    Flow --> Auto',
    '    Flow --> Domain',
    '    Main --> Resource',
    '    Main --> UI',
    '    Main --> Preview',
    '    Main --> SceneInput',
    '    Main --> Commons',
    '    Resource --> Commons',
    '    UI --> Commons',
    '    Auto --> Commons',
    '```',
    '',
    '## 每帧调用链',
    '',
    '```mermaid',
    'flowchart TD',
    '    Start["Start()"] --> Boot["实体绑定 / UI / GFM_* 初始化"] --> FirstState["UpdateGameState()"]',
    '    Update["Update()"] --> Sync["SyncAutoPlayState / UpdatePhaseTimer / CheckEventRules"]',
    '    Sync --> Mode{"_autoPlayMode ?"}',
    '    Mode -->|是| AutoTick["AutoPlayUpdate / OnAutoPlayArrive"]',
    '    Mode -->|否| PlayerTick["GFM_Player.Tick / 玩家点击"]',
    '    PlayerTick --> Tap["Phase_OnTap -> Phase_*_OnTap"]',
    '    AutoTick --> Systems["敌人 / 单位 / 建筑 / 资源系统更新"]',
    '    Tap --> Systems',
    '    Systems --> Generated["RunGeneratedAssemblySlotRunners 默认关闭"] --> Export["UpdateFloatingText / UpdateGameState / CTA"]',
    '```',
    '',
    '## 阶段流',
    '',
    '```mermaid',
    mermaidPhaseFlow(info.phases),
    '```',
    '',
    '## 核心文件职责',
    '',
    '| 文件 | 职责 |',
    '|---|---|',
    '| `GameFlowManagerMain.cs` | 生命周期入口、主 `Update()`、运行时主状态、显式系统更新 |',
    '| `GameFlowManagerMain.Entities.cs` | 实体字段、对象池名映射、实体绑定校验 |',
    '| `GameFlowManagerMain.Flow.cs` | 点击/AutoPlay 分发、阶段进入、完成、卡住上报、assembly runner 清单 |',
    '| `GameFlowManagerMain.Phases.cs` | 每个阶段的 `Init`、真实点击 `OnTap`、阶段快照 |',
    '| `GameFlowManagerMain.Flow.AutoPlay.cs` | CUA/AutoPlay 到达目标后的自动推进 |',
    '| `GameFlowManagerMain.Flow.*.cs` | 按领域拆分的 generated assembly slots，默认不在主运行路径 |',
    '| `GameFlowManagerMain.Resource.cs` | 资源循环、花费、回收、经济辅助 |',
    '| `GameFlowManagerMain.UI.cs` | guide 文案、score、world label、CTA UI 辅助 |',
    '| `GameFlowManagerMain.PreviewState.cs` | preview/CUA JSON、phase evidence、`ShowCTA()` |',
    '| `Commons/GFM_*.cs` | 通用工具库；业务逻辑优先写在 `GameFlowManagerMain*.cs` |',
    '',
    '## 维护提醒',
    '',
    '- 实体引用只来自 `RegisterEntityBindings()/GameSceneCtrl`，不要在业务代码里二次 `GameObject.Find("__Pool_*")` 覆盖。',
    '- 资源 ID 使用 `GFM_ResourceIds`，不要裸写 `"Gold"` / `"gold"`。',
    '- guide 文案统一通过 `SetGuideText()`。',
    '- `AssemblySlot_*` 是装配/验证合约槽位；除非明确打开 runner，否则不是主运行路径。',
    '- 需要浏览器图表版时，打开 `CODE_RELATION_GRAPH.html`。',
    ''
  ].join('\n');
}

function phaseCards(phases) {
  if (!phases.length) return '<div class="card muted">未检测到阶段流</div>';
  return phases.map(function(phase, idx) {
    return '<div class="phase"><strong>' + (idx + 1) + '. ' + escapeHtml(phase) + '</strong></div>';
  }).join('<span class="arrow">→</span>');
}

function buildHtml(info) {
  var title = escapeHtml(info.name || info.id || path.basename(info.root));
  return '<!doctype html>\n' +
'<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>代码关系图 - ' + title + '</title>\n' +
'<style>\n' +
'body{margin:0;background:#f6f7f9;color:#1d2430;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.45}header{padding:24px 32px 14px;background:#fff;border-bottom:1px solid #d8dee9}h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#596579}main{padding:24px 32px 40px;display:grid;gap:22px}section{background:#fff;border:1px solid #d8dee9;border-radius:8px;padding:20px;overflow:auto}h2{margin:0 0 14px;font-size:18px}.grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;min-width:850px}.card{border:1px solid #d8dee9;border-radius:8px;padding:14px;background:#fff}.main{background:#eff6ff;border-color:#2563eb}.flow{background:#ecfdf5;border-color:#0f766e}.data{background:#f5f3ff;border-color:#7c3aed}.warn{background:#fff7ed;border-color:#b45309}.card strong{display:block;margin-bottom:6px}.card span{color:#596579;font-size:13px}.edges{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.phase{border:1px solid #0f766e;background:#ecfdf5;border-radius:8px;padding:10px 12px}.arrow{color:#94a3b8;font-size:22px}.note{margin-top:12px;color:#596579;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}\n' +
'</style></head><body>\n' +
'<header><h1>代码关系图</h1><p>项目：' + title + '。此页面由 Blueprint 导出链路自动生成，直接用浏览器打开即可查看。</p></header>\n' +
'<main>\n' +
'<section><h2>工程结构总览</h2><div class="grid">\n' +
'<div class="card main"><strong>GameFlowManagerMain.cs</strong><span>Start / Update / 主状态</span></div>\n' +
'<div class="card data"><strong>Entities.cs</strong><span>实体字段 / 对象池绑定</span></div>\n' +
'<div class="card flow"><strong>Flow.cs</strong><span>点击分发 / 阶段辅助</span></div>\n' +
'<div class="card flow"><strong>Phases.cs</strong><span>Init / OnTap / Snapshot</span></div>\n' +
'<div class="card flow"><strong>Flow.AutoPlay.cs</strong><span>CUA 自动推进</span></div>\n' +
'<div class="card"><strong>Resource.cs</strong><span>采集 / 花费 / 回收</span></div>\n' +
'<div class="card"><strong>UI.cs / PreviewState.cs</strong><span>guide / score / CTA / CUA JSON</span></div>\n' +
'<div class="card warn"><strong>Commons/GFM_*.cs</strong><span>通用库，业务优先写在 Manager partial</span></div>\n' +
'</div><p class="note">阅读顺序：先看 <code>GameFlowManagerMain.cs</code> 的 <code>Start()</code> 和 <code>Update()</code>，再按职责进入 partial 文件。</p></section>\n' +
'<section><h2>运行时调用链</h2><div class="edges">\n' +
'<div class="phase">Start()</div><span class="arrow">→</span><div class="phase">实体绑定 / UI / Manager 初始化</div><span class="arrow">→</span><div class="phase">Update()</div><span class="arrow">→</span><div class="phase">CheckEventRules</div><span class="arrow">→</span><div class="phase">Phase_OnTap 或 AutoPlayUpdate</div><span class="arrow">→</span><div class="phase">系统更新</div><span class="arrow">→</span><div class="phase">UpdateGameState / CTA</div>\n' +
'</div></section>\n' +
'<section><h2>阶段流</h2><div class="edges">' + phaseCards(info.phases) + '</div></section>\n' +
'</main></body></html>\n';
}

function ensureReadmeLinks(root) {
  var file = path.join(root, 'README.md');
  if (!fs.existsSync(file)) return false;
  var text = fs.readFileSync(file, 'utf8');
  var changed = false;
  if (text.indexOf('CODE_RELATION_GRAPH.md') === -1) {
    text = text.replace(/(## 目录\n)/, '$1- CODE_RELATION_GRAPH.md — 代码关系图、运行时调用链和维护入口\n');
    changed = true;
  }
  if (text.indexOf('CODE_RELATION_GRAPH.html') === -1) {
    text = text.replace(/(CODE_RELATION_GRAPH\.md[^\n]*\n)/, '$1- CODE_RELATION_GRAPH.html — 可直接用浏览器打开的图表化关系图\n');
    changed = true;
  }
  if (changed) fs.writeFileSync(file, text);
  return changed;
}

function writeCodeRelationGraphs(root, options) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('delivery root not found: ' + root);
  }
  var info = collectProjectInfo(root, options || {});
  fs.writeFileSync(path.join(root, 'CODE_RELATION_GRAPH.md'), buildMarkdown(info));
  fs.writeFileSync(path.join(root, 'CODE_RELATION_GRAPH.html'), buildHtml(info));
  ensureReadmeLinks(root);
  return {
    markdown: path.join(root, 'CODE_RELATION_GRAPH.md'),
    html: path.join(root, 'CODE_RELATION_GRAPH.html'),
    phases: info.phases.length,
    csFiles: info.csFiles.length
  };
}

module.exports = {
  collectProjectInfo: collectProjectInfo,
  writeCodeRelationGraphs: writeCodeRelationGraphs
};

if (require.main === module) {
  var root = process.argv[2];
  if (!root) {
    console.error('Usage: node lib/code-relation-graph-writer.cjs <unity-or-delivery-root> [projectId] [projectName]');
    process.exit(2);
  }
  var summary = writeCodeRelationGraphs(root, {
    projectId: process.argv[3] || '',
    projectName: process.argv[4] || ''
  });
  console.log(JSON.stringify(summary, null, 2));
}
