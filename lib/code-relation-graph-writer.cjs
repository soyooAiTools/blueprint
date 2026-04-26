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
  return walkCsFiles(dir, []);
}

function walkCsFiles(dir, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.svn' || entry.name === '.git' || entry.name === 'node_modules') continue;
      walkCsFiles(full, out);
    } else if (entry.isFile() && /\.cs$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function collectProjectInfo(root, options) {
  options = options || {};
  var csFiles = listCsFiles(root);
  var byName = {};
  csFiles.forEach(function(file) { byName[path.basename(file)] = file; });

  var mainText = readText(byName['GameFlowManagerMain.cs']);
  var baseLayerNames = [
    'GameFlowPhaseFlowBase.cs',
    'GameFlowPhaseAutoBase.cs',
    'GameFlowPhaseTapBase.cs',
    'GameFlowPhaseInitBase.cs',
    'GameFlowPhaseSnapshotBase.cs',
    'GameFlowPhaseSharedBase.cs',
    'GameFlowPhaseContentBase.cs',
    'GameFlowUiBase.cs',
    'GameFlowInputBase.cs',
    'GameFlowRuntimeBase.cs',
    'GameFlowSceneBase.cs',
    'GameFlowPreviewBase.cs',
    'GameFlowStateBase.cs'
  ].filter(function(name) { return !!byName[name]; });
  var legacyPhaseNames = [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Phases.cs',
    'GameFlowManagerMain.Flow.AutoPlay.cs'
  ].filter(function(name) { return !!byName[name]; });
  var phaseSourceText = [mainText]
    .concat(baseLayerNames.map(function(name) { return readText(byName[name]); }))
    .concat(legacyPhaseNames.map(function(name) { return readText(byName[name]); }))
    .join('\n');
  var phaseSet = {};
  var match;
  var caseRe = /case\s+"([^"]+)"/g;
  while ((match = caseRe.exec(phaseSourceText))) phaseSet[match[1]] = true;
  var phaseRe = /void\s+Phase_([A-Za-z0-9_]+)_Init\s*\(/g;
  while ((match = phaseRe.exec(phaseSourceText))) phaseSet[match[1]] = true;
  var phases = Object.keys(phaseSet);

  var files = [
    'GameFlowManagerMain.cs',
    'GameFlowPhaseFlowBase.cs',
    'GameFlowPhaseAutoBase.cs',
    'GameFlowPhaseTapBase.cs',
    'GameFlowPhaseInitBase.cs',
    'GameFlowPhaseSnapshotBase.cs',
    'GameFlowPhaseSharedBase.cs',
    'GameFlowPhaseContentBase.cs',
    'GameFlowUiBase.cs',
    'GameFlowInputBase.cs',
    'GameFlowRuntimeBase.cs',
    'GameFlowSceneBase.cs',
    'GameFlowPreviewBase.cs',
    'GameFlowStateBase.cs',
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

  var domainFiles = baseLayerNames.length
    ? baseLayerNames.slice()
    : csFiles
      .map(function(file) { return path.basename(file); })
      .filter(function(name) { return /^GameFlowManagerMain\.Flow\..+\.cs$/.test(name) && name !== 'GameFlowManagerMain.Flow.AutoPlay.cs'; })
      .sort();
  var entityClassFiles = csFiles
    .filter(function(file) { return /[\\/]Entities[\\/][^\\/]+\.cs$/i.test(file); })
    .map(function(file) { return path.basename(file); })
    .sort();
  var hasManagerPartials = csFiles.some(function(file) {
    var name = path.basename(file);
    return /^GameFlowManagerMain\..+\.cs$/.test(name);
  });

  var hasFullUnity = fs.existsSync(path.join(root, 'Assets')) && fs.existsSync(path.join(root, 'ProjectSettings'));
  var hasCommons = fs.existsSync(path.join(root, 'Assets', 'Program', 'Script', 'Commons')) || fs.existsSync(path.join(root, 'Scripts'));

  return {
    id: options.projectId || options.id || '',
    name: options.projectName || options.name || '',
    root: root,
    csFiles: csFiles,
    files: files,
    domainFiles: domainFiles,
    entityClassFiles: entityClassFiles,
    hasManagerPartials: hasManagerPartials,
    hasGameFlowBaseLayers: baseLayerNames.length > 0,
    baseLayerNames: baseLayerNames,
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
  var isBaseLayerDelivery = !!info.hasGameFlowBaseLayers;
  var domainText = isBaseLayerDelivery
    ? (info.domainFiles.length ? info.domainFiles.join(' / ') : 'GameFlow*Base.cs')
    : (info.hasManagerPartials
      ? (info.domainFiles.length ? info.domainFiles.join(' / ') : 'Flow/Input/Resource/UI/Scene')
      : 'GameFlowManagerMain.cs');
  var entityText = info.entityClassFiles.length
    ? ('Entities/*.cs (' + info.entityClassFiles.length + ' files)')
    : 'GameObject 字段';
  var structureNote = isBaseLayerDelivery
    ? '当前是程序员交付结构：`GameFlowManagerMain.cs` 是 Unity 挂载入口，`GameFlow*Base.cs` 用普通继承链分层，每个 GameFlow 脚本应保持在 1000 行以内。'
    : (info.hasManagerPartials
    ? '当前仍是 Blueprint 审核源结构，`GameFlowManagerMain` 可能存在 companion 文件。程序员交付版会合并为普通类。'
    : '当前是程序员交付结构：`GameFlowManagerMain` 是普通类，实体领域属性在 `Entities/` 下维护。');
  // 空层在 cleaner 里已被剔除；mermaid 标签只引用本次实际生成的层文件。
  // 若某节点对应的层在本次导出中没有内容（例如该项目根本没有 AutoPlay gate 逻辑），用"未启用"
  // 标签如实反映而非伪装到 Main 上，避免读者误以为该子系统被合并到了主入口。
  var hasLayer = function(name) { return info.baseLayerNames.indexOf(name) !== -1; };
  var flowNode = isBaseLayerDelivery
    ? (hasLayer('GameFlowPhaseFlowBase.cs')
        ? 'GameFlowPhaseFlowBase.cs<br/>阶段分发 / AutoPlay gate'
        : '阶段分发 / AutoPlay gate<br/>本次导出未启用')
    : 'Phase_* methods<br/>点击 / AutoPlay / gate';
  var resourceNode = isBaseLayerDelivery
    ? (hasLayer('GameFlowPreviewBase.cs')
        ? 'GameFlowPreviewBase.cs<br/>资源 API / Preview / evidence'
        : '资源 API / Preview<br/>本次导出未启用')
    : 'Resource.cs<br/>资源采集 / 花费 / 回收';
  var uiNode = isBaseLayerDelivery
    ? (hasLayer('GameFlowUiBase.cs')
        ? 'GameFlowUiBase.cs<br/>UI / CTA / state JSON'
        : (hasLayer('GameFlowStateBase.cs')
            ? 'GameFlowStateBase.cs<br/>UI helper / 实体绑定'
            : 'UI helper<br/>本次导出未启用'))
    : 'UI.cs<br/>guide / score / CTA';
  var sceneInputNode = isBaseLayerDelivery
    ? (hasLayer('GameFlowRuntimeBase.cs')
        ? 'GameFlowRuntimeBase.cs<br/>每帧系统 / 输入后的运行时更新'
        : '每帧运行时系统<br/>本次导出未启用')
    : 'Scene / Input<br/>摆放 / 镜头 / 输入';
  var runtimeTail = isBaseLayerDelivery
    ? '    Systems --> Export["UpdateFloatingText / UpdateGameState / CTA"]'
    : '    Systems --> Generated["RunGeneratedAssemblySlotRunners 默认关闭"] --> Export["UpdateFloatingText / UpdateGameState / CTA"]';
  var coreRows = [
    '| `GameFlowManagerMain.cs` | Unity 生命周期入口、主 `Update()`、阶段跳转出口 |'
  ];
  if (isBaseLayerDelivery) {
    var layerDescriptions = {
      'GameFlowPhaseFlowBase.cs': '阶段分发、AutoPlay tick、phase gate 顶层流程',
      'GameFlowPhaseAutoBase.cs': 'Phase AutoPlay 到达处理器',
      'GameFlowPhaseTapBase.cs': 'Phase 点击处理器',
      'GameFlowPhaseInitBase.cs': 'Phase 初始化处理器',
      'GameFlowPhaseSnapshotBase.cs': '阶段入口快照辅助',
      'GameFlowPhaseSharedBase.cs': '阶段计时、进入、完成和卡点上报共享流程',
      'GameFlowPhaseContentBase.cs': '按领域合并的 Phase 内容扩展',
      'GameFlowPreviewBase.cs': 'Preview/CUA 状态导出和资源 API 门面',
      'GameFlowUiBase.cs': 'UI、CTA、状态 JSON 和 phase evidence 输出',
      'GameFlowInputBase.cs': '输入和玩家控制辅助',
      'GameFlowRuntimeBase.cs': '每帧运行时系统与玩法资源循环',
      'GameFlowSceneBase.cs': '对象池摆放、隐藏、缩放和生成兼容包装',
      'GameFlowStateBase.cs': '状态字段和实体绑定'
    };
    // 仅列出本次实际生成的层，空层在 cleaner 里已被剔除，不能在文档里假装存在。
    info.baseLayerNames.forEach(function(name) {
      var desc = layerDescriptions[name];
      if (desc) coreRows.push('| `' + name + '` | ' + desc + ' |');
    });
  } else if (info.hasManagerPartials) {
    coreRows = coreRows.concat([
      '| `GameFlowManagerMain.Flow*.cs` | 阶段流程、AutoPlay、按领域拆分的 phase handler |',
      '| `GameFlowManagerMain.Resource/UI/Scene/Input.cs` | 资源、界面、场景和输入辅助 |'
    ]);
  }
  coreRows = coreRows.concat([
    '| `Entities/BaseBuildElement.cs` | 建筑通用属性，例如生命、攻击、等级 |',
    '| `Entities/BuildEntity.cs` 与具体实体类 | 面向对象实体模型，绑定对象池 `GameObject` 后承载领域状态 |',
    '| `Commons/GFM_*.cs` | 通用工具库；业务逻辑优先写在主流程或实体领域类中 |'
  ]);
  var reminders = [
    '- ' + structureNote,
    '- 实体引用只来自 `RegisterEntityBindings()/GameSceneCtrl`，不要在业务代码里二次 `GameObject.Find("__Pool_*")` 覆盖。',
    '- 新增建筑、兵营、炮塔等对象时，优先新增/扩展 `Entities/` 下的具体类，不要再用 `GameFlowManagerMain.*.cs` 分类文件表达领域对象。',
    '- 资源 ID 使用 `GFM_ResourceIds`，不要裸写 `"Gold"` / `"gold"`。',
    '- guide 文案统一通过 `SetGuideText()`。'
  ];
  if (!isBaseLayerDelivery) {
    reminders.push('- `AssemblySlot_*` 是装配/验证合约槽位；除非明确打开 runner，否则不是主运行路径。');
  }
  reminders.push('- 需要浏览器图表版时，打开 `CODE_RELATION_GRAPH.html`。');
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
    '    Main["GameFlowManagerMain.cs<br/>Start / Update / 阶段协调"]',
    '    Entities["' + entityText + '<br/>实体领域类 / 对象池绑定"]',
    '    Flow["' + flowNode + '"]',
    '    Domain["' + domainText + '<br/>流程与领域逻辑"]',
    '    Resource["' + resourceNode + '"]',
    '    UI["' + uiNode + '"]',
    '    SceneInput["' + sceneInputNode + '"]',
    '    Commons["Commons/GFM_*.cs<br/>通用库"]',
    '    Main --> Entities',
    '    Main --> Flow',
    '    Flow --> Domain',
    '    Main --> Resource',
    '    Main --> UI',
    '    Main --> SceneInput',
    '    Main --> Commons',
    '    Resource --> Commons',
    '    UI --> Commons',
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
    runtimeTail,
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
    '|---|---|'
  ].concat(coreRows, [
    '',
    '## 维护提醒',
    '',
  ]).concat(reminders, ['']).join('\n');
}

function phaseCards(phases) {
  if (!phases.length) return '<div class="card muted">未检测到阶段流</div>';
  return phases.map(function(phase, idx) {
    return '<div class="phase"><strong>' + (idx + 1) + '. ' + escapeHtml(phase) + '</strong></div>';
  }).join('<span class="arrow">→</span>');
}

function buildHtml(info) {
  var title = escapeHtml(info.name || info.id || path.basename(info.root));
  var isBaseLayerDelivery = !!info.hasGameFlowBaseLayers;
  var entityLabel = info.entityClassFiles.length
    ? 'Entities/*.cs'
    : '实体字段';
  var structureLabel = isBaseLayerDelivery
    ? '程序员交付版：GameFlowManagerMain 是普通入口，GameFlow*Base.cs 用普通继承链分层，实体领域属性在 Entities/。'
    : (info.hasManagerPartials
      ? 'Blueprint 审核源可能仍有 companion 文件；程序员交付版会合并为普通类。'
      : '程序员交付版：GameFlowManagerMain 是普通类，实体领域属性在 Entities/。');
  var cards = isBaseLayerDelivery ? [
    '<div class="card main"><strong>GameFlowManagerMain.cs</strong><span>Start / Update / Unity 挂载入口</span></div>',
    '<div class="card flow"><strong>GameFlowPhaseFlowBase.cs</strong><span>阶段分发 / AutoPlay gate</span></div>',
    '<div class="card flow"><strong>GameFlowPhaseAutoBase.cs</strong><span>AutoPlay 阶段处理</span></div>',
    '<div class="card flow"><strong>GameFlowPhaseTapBase.cs</strong><span>点击阶段处理</span></div>',
    '<div class="card flow"><strong>GameFlowPhaseInitBase.cs</strong><span>阶段初始化</span></div>',
    '<div class="card"><strong>GameFlowPhaseSnapshotBase.cs</strong><span>阶段入口快照</span></div>',
    '<div class="card"><strong>GameFlowRuntimeBase.cs</strong><span>每帧玩法系统</span></div>',
    '<div class="card"><strong>GameFlowSceneBase.cs</strong><span>对象摆放 / 生成包装</span></div>',
    '<div class="card"><strong>GameFlowInputBase.cs</strong><span>输入和玩家控制</span></div>',
    '<div class="card"><strong>GameFlowUiBase.cs</strong><span>UI / CTA / 状态 JSON</span></div>',
    '<div class="card"><strong>GameFlowPreviewBase.cs</strong><span>资源 API / Preview / evidence</span></div>',
    '<div class="card"><strong>GameFlowStateBase.cs</strong><span>状态字段 / 实体绑定</span></div>',
    '<div class="card data"><strong>' + escapeHtml(entityLabel) + '</strong><span>实体领域类 / 对象池绑定</span></div>',
    '<div class="card warn"><strong>Commons/GFM_*.cs</strong><span>通用库，业务优先写在主流程或实体类</span></div>'
  ] : [
    '<div class="card main"><strong>GameFlowManagerMain.cs</strong><span>Start / Update / 主状态</span></div>',
    '<div class="card data"><strong>' + escapeHtml(entityLabel) + '</strong><span>实体领域类 / 对象池绑定</span></div>',
    '<div class="card flow"><strong>Phase_* methods</strong><span>点击 / AutoPlay / gate</span></div>',
    '<div class="card flow"><strong>BaseBuildElement</strong><span>生命 / 攻击 / 等级</span></div>',
    '<div class="card flow"><strong>BuildEntity</strong><span>建筑实体基类</span></div>',
    '<div class="card"><strong>Resource.cs</strong><span>采集 / 花费 / 回收</span></div>',
    '<div class="card"><strong>UI / Scene / Input</strong><span>guide / score / 摆放 / 输入</span></div>',
    '<div class="card warn"><strong>Commons/GFM_*.cs</strong><span>通用库，业务优先写在主流程或实体类</span></div>'
  ];
  var readOrder = isBaseLayerDelivery
    ? '阅读顺序：先看 <code>GameFlowManagerMain.cs</code>，再沿 <code>GameFlowPhaseFlowBase</code> 到 <code>GameFlowStateBase</code>，最后看 <code>Entities/</code>。'
    : '阅读顺序：先看 <code>GameFlowManagerMain.cs</code> 的 <code>Start()</code> 和 <code>Update()</code>，再进入 <code>Entities/</code>。';
  return '<!doctype html>\n' +
'<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>代码关系图 - ' + title + '</title>\n' +
'<style>\n' +
'body{margin:0;background:#f6f7f9;color:#1d2430;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.45}header{padding:24px 32px 14px;background:#fff;border-bottom:1px solid #d8dee9}h1{margin:0 0 8px;font-size:24px}p{margin:0;color:#596579}main{padding:24px 32px 40px;display:grid;gap:22px}section{background:#fff;border:1px solid #d8dee9;border-radius:8px;padding:20px;overflow:auto}h2{margin:0 0 14px;font-size:18px}.grid{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:12px;min-width:850px}.card{border:1px solid #d8dee9;border-radius:8px;padding:14px;background:#fff}.main{background:#eff6ff;border-color:#2563eb}.flow{background:#ecfdf5;border-color:#0f766e}.data{background:#f5f3ff;border-color:#7c3aed}.warn{background:#fff7ed;border-color:#b45309}.card strong{display:block;margin-bottom:6px}.card span{color:#596579;font-size:13px}.edges{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.phase{border:1px solid #0f766e;background:#ecfdf5;border-radius:8px;padding:10px 12px}.arrow{color:#94a3b8;font-size:22px}.note{margin-top:12px;color:#596579;font-size:13px}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}\n' +
'</style></head><body>\n' +
'<header><h1>代码关系图</h1><p>项目：' + title + '。此页面由 Blueprint 导出链路自动生成，直接用浏览器打开即可查看。</p></header>\n' +
'<main>\n' +
'<section><h2>工程结构总览</h2><div class="grid">\n' +
cards.join('\n') + '\n' +
'</div><p class="note">' + escapeHtml(structureLabel) + ' ' + readOrder + '</p></section>\n' +
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
