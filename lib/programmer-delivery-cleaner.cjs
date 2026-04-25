var fs = require('fs');
var path = require('path');
var codeRelationGraphWriter = require('./code-relation-graph-writer.cjs');

function walkFiles(root, out) {
  out = out || [];
  if (!fs.existsSync(root)) return out;
  var entries = fs.readdirSync(root, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.svn' || entry.name === '.git' || entry.name === 'node_modules') continue;
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function shouldDropContractComment(text) {
  var t = String(text || '').trim();
  if (!t) return false;
  if (/^TODO_[A-Za-z0-9_]+(?:_(?:START|END))?$/.test(t)) return true;
  if (/^\[ASSEMBLY (?:SLOT|PHASE|OWNER MANIFEST)\]/.test(t)) return true;
  if (/^ownerFile:\s*/.test(t)) return true;
  if (/^phaseEvidenceSchema:\s*/.test(t)) return true;
  if (/^(?:数据:\s*)?"(?:signal|kind|phaseEvidencePath|variableEvidenceKey)"\s*:/.test(t)) return true;
  if (/机器可读\s+\[ASSEMBLY/.test(t)) return true;
  if (/供\s*Blueprint\/CUA\s*追踪/.test(t)) return true;
  return false;
}

function cleanCSharpForProgrammerDelivery(code) {
  var lines = String(code || '').split(/\r?\n/);
  var changed = false;
  var removedContractComments = 0;
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var match = line.match(/^(\s*)\/\/\s?(.*)$/);
    if (match && shouldDropContractComment(match[2])) {
      changed = true;
      removedContractComments++;
      continue;
    }
    out.push(line);
  }

  var next = out.join('\n');
  next = next.replace(
    /const bool ENABLE_GENERATED_ASSEMBLY_RUNNERS = false; \/\/ true 时才执行生成槽位 runner；默认走手写可玩路径/g,
    'const bool ENABLE_GENERATED_ASSEMBLY_RUNNERS = false; // 保留生成槽位作为参考实现；默认使用手写可玩路径。'
  );
  if (next !== out.join('\n')) changed = true;

  return {
    code: next,
    changed: changed,
    removedContractComments: removedContractComments
  };
}

function removeIfExists(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function writeHandoff(root, project, summary) {
  var id = project && project.id ? project.id : '';
  var name = project && project.name ? project.name : id;
  var lines = [
    '# 程序员交付版说明',
    '',
    '项目：' + (name || '未命名') + (id ? ' (' + id + ')' : ''),
    '生成时间：' + new Date().toISOString(),
    '',
    '## 已清理内容',
    '- 移除 Blueprint/CUA 自动验证用的机器契约注释，例如 `[ASSEMBLY SLOT]`、`[ASSEMBLY PHASE]`、`phaseEvidenceSchema`、`TODO_*_START/END`。',
    '- 移除 `BlueprintArtifacts/` 这类仅供流水线追踪的验证附件。',
    '- 移除根目录 `tools/`，避免把构建/转换辅助脚本提交给程序员交付仓库。',
    '- 保留可运行代码、Unity/Luna 依赖、WebGL 构建产物和 C# 脚本结构。',
    '',
    '## 后续维护建议',
    '- 玩法主流程从 `GameFlowManagerMain.cs` 和 `GameFlowManagerMain.Flow*.cs` 开始阅读。',
    '- 场景、输入、资源、UI 逻辑按 `Scene/Input/Resource/UI` partial 文件维护。',
    '- `GFM_*.cs` 是通用工具库；业务逻辑优先写在 `GameFlowManagerMain*.cs`，不要直接改工具库公共行为。',
    '',
    '## 清理统计',
    '- C# 文件处理数：' + summary.csFiles,
    '- 修改的 C# 文件数：' + summary.changedFiles,
    '- 移除机器契约注释行：' + summary.removedContractComments,
    '- 移除验证附件目录数：' + summary.removedArtifactDirs,
    '- 移除 tools 目录数：' + summary.removedToolDirs
  ];
  fs.writeFileSync(path.join(root, 'PROGRAMMER_HANDOFF.md'), lines.join('\n') + '\n');
}

function cleanProgrammerDelivery(root, options) {
  options = options || {};
  var summary = {
    root: root,
    csFiles: 0,
    changedFiles: 0,
    removedContractComments: 0,
    removedArtifactDirs: 0,
    removedToolDirs: 0,
    handoff: path.join(root, 'PROGRAMMER_HANDOFF.md')
  };

  var artifactDir = path.join(root, 'BlueprintArtifacts');
  if (removeIfExists(artifactDir)) summary.removedArtifactDirs++;
  var toolsDir = path.join(root, 'tools');
  if (removeIfExists(toolsDir)) summary.removedToolDirs++;

  var files = walkFiles(root);
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (path.extname(file).toLowerCase() !== '.cs') continue;
    summary.csFiles++;
    var before = fs.readFileSync(file, 'utf8');
    var result = cleanCSharpForProgrammerDelivery(before);
    if (!result.changed) continue;
    fs.writeFileSync(file, result.code);
    summary.changedFiles++;
    summary.removedContractComments += result.removedContractComments;
  }

  writeHandoff(root, options.project || {}, summary);
  var graphSummary = codeRelationGraphWriter.writeCodeRelationGraphs(root, {
    projectId: options.project && options.project.id,
    projectName: options.project && options.project.name
  });
  summary.codeRelationGraph = graphSummary;
  return summary;
}

module.exports = {
  cleanCSharpForProgrammerDelivery: cleanCSharpForProgrammerDelivery,
  cleanProgrammerDelivery: cleanProgrammerDelivery,
  shouldDropContractComment: shouldDropContractComment
};

if (require.main === module) {
  var target = process.argv[2];
  if (!target) {
    console.error('Usage: node lib/programmer-delivery-cleaner.cjs <delivery-root>');
    process.exit(2);
  }
  var summary = cleanProgrammerDelivery(target, {});
  console.log(JSON.stringify(summary, null, 2));
}
