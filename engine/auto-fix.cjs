/**
 * Auto-fix engine (L4)
 *
 * 把 "dashboard 里看到的失败指纹" 翻译成 "一个 sub-agent 运行的结果":
 *   1. 从 worker/fix-recipes.json 找到匹配的 recipe (正则命中 fingerprint)
 *   2. 读 recipe markdown (诊断步骤 + 修复指令 + 护栏)
 *   3. 读 recipe.affectedFiles 里的文件作为附件
 *   4. spawn claude --print text-mode sub-agent (走 runClaudeCodeText adapter)
 *   5. 返回 {patch, subagentLog, recipe} — 不自动提交、不自动修改 repo
 *
 * 铁律 (~/.claude/CLAUDE.md):
 *   - NEVER make Git commits automatically in loops
 *   - NEVER deploy to production in loops
 * 所以本模块只产出 "sub-agent 的文本输出", 由 dashboard 交给人审查决定是否落地。
 *
 * 调用点:
 *   - api/dashboard.cjs 的 runAutoFix handler
 *   - POST /api/auto-fix/:fingerprintId
 *
 * 2026-04-16 — 随 failure-fingerprint.cjs / fix-recipes.json 一同引入 (L4).
 */

var fs = require('fs');
var path = require('path');
var { loadRecipes } = require('./failure-fingerprint.cjs');

var REPO_ROOT = path.join(__dirname, '..');

// 懒加载 runClaudeCodeText — 避免 require 时触发 worker 模块的副作用
var _runClaudeCodeText = null;
function getRunner() {
  if (_runClaudeCodeText) return _runClaudeCodeText;
  try {
    _runClaudeCodeText = require(path.join(REPO_ROOT, 'worker', 'claude-code-coder.js')).runClaudeCodeText;
  } catch(e) {
    _runClaudeCodeText = null;
  }
  return _runClaudeCodeText;
}

// ─── Recipe matching ─────────────────────────────────────────────────
// fingerprintId 可能是:
//   (a) 已知 recipe 的 id (来自 dashboard "运行自动修复" 按钮)
//   (b) 原始 fingerprint 字符串 (由 recipe 的 fingerprintPattern 正则匹配)
function findRecipe(fingerprintId) {
  var recipes = loadRecipes();
  if (!fingerprintId) return null;
  // 先试 id 精确匹配
  for (var i = 0; i < recipes.length; i++) {
    if (recipes[i].id === fingerprintId) return recipes[i];
  }
  // 再试 fingerprintPattern 正则命中
  for (var j = 0; j < recipes.length; j++) {
    var r = recipes[j];
    try {
      var re = new RegExp(r.fingerprintPattern, 'i');
      if (re.test(fingerprintId)) return r;
    } catch(e) { continue; }
  }
  return null;
}

// ─── File collection ─────────────────────────────────────────────────
// 把 recipe.affectedFiles 读成 {filename: content} map, 喂给 sub-agent
// 注意: filename 只保留 basename — 避免 sub-agent 的临时 workDir 下建目录
function collectAffectedFiles(recipe) {
  var out = {};
  if (!recipe || !Array.isArray(recipe.affectedFiles)) return out;
  for (var i = 0; i < recipe.affectedFiles.length; i++) {
    var rel = recipe.affectedFiles[i];
    var abs = path.join(REPO_ROOT, rel);
    var basename = path.basename(rel);
    try {
      var body = fs.readFileSync(abs, 'utf-8');
      // 前缀注释让 sub-agent 知道原路径, 因为 basename 可能重名
      out[basename] = '// Original path: ' + rel + '\n' + body;
    } catch(e) {
      // 文件不存在也不致命 — recipe markdown 会列出期待路径
      out[basename] = '// Original path: ' + rel + '\n// (file not found: ' + e.message + ')';
    }
  }
  return out;
}

// ─── Recipe body load ────────────────────────────────────────────────
function loadRecipeBody(recipe) {
  if (!recipe || !recipe.recipeFile) return null;
  var abs = path.join(REPO_ROOT, 'worker', recipe.recipeFile);
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch(e) {
    return null;
  }
}

// ─── System prompt builder ───────────────────────────────────────────
// sub-agent 拿到的 CLAUDE.md — 明确三条铁律:
//   1. 你是只读的诊断/修复建议 agent, 不要真的改文件系统
//   2. 你的输出必须是: 诊断说明 + 具体 patch (diff 或 "建议修改: ..." )
//   3. 不要写 git commit, 不要 shell out 任何副作用命令
function buildSystemPrompt(recipe, recipeBody) {
  var parts = [];
  parts.push('You are an auto-fix sub-agent for the Blueprint Editor pipeline.');
  parts.push('');
  parts.push('# Your role');
  parts.push('Diagnose one specific failure fingerprint and propose a concrete fix.');
  parts.push('You are running inside a headless text-mode Claude Code CLI session.');
  parts.push('');
  parts.push('# Output format (required)');
  parts.push('1. **Diagnosis** — in 2-4 sentences, explain what is broken and why.');
  parts.push('2. **Root cause** — cite the exact file:line of the offending code.');
  parts.push('3. **Patch** — either a unified diff, or "Edit X line Y: before / after" blocks.');
  parts.push('4. **Verification** — one-line command the human reviewer can run to confirm the fix.');
  parts.push('');
  parts.push('# Hard rules');
  parts.push('- DO NOT run git commit, git push, or any shell commands with side effects.');
  parts.push('- DO NOT modify files on disk. Your output is text only.');
  parts.push('- DO NOT suggest "restart worker" or "restart pm2" — see ~/.claude memory feedback_avoid_restart.');
  parts.push('- If the recipe tells you to Read() affected files, do so via the Read tool.');
  parts.push('- If you cannot find the root cause, say "UNABLE_TO_DIAGNOSE" and list what you checked.');
  parts.push('');
  parts.push('# Recipe metadata');
  parts.push('- id: ' + (recipe.id || 'unknown'));
  parts.push('- risk: ' + (recipe.risk || 'unknown'));
  parts.push('- description: ' + (recipe.description || ''));
  if (Array.isArray(recipe.relatedCommits) && recipe.relatedCommits.length) {
    parts.push('- related commits: ' + recipe.relatedCommits.join(', '));
  }
  if (Array.isArray(recipe.relatedMemories) && recipe.relatedMemories.length) {
    parts.push('- related memory files: ' + recipe.relatedMemories.join(', '));
  }
  parts.push('');
  if (recipeBody) {
    parts.push('# Recipe body (diagnostic playbook)');
    parts.push(recipeBody);
  }
  return parts.join('\n');
}

function buildUserPrompt(recipe, affectedFileNames) {
  var parts = [];
  parts.push('Please diagnose and propose a patch for fingerprint: ' + (recipe.id || recipe.description));
  parts.push('');
  if (affectedFileNames.length > 0) {
    parts.push('The following files have been staged in your working directory:');
    affectedFileNames.forEach(function(n) { parts.push('  - ' + n); });
    parts.push('Use Read() to inspect them.');
    parts.push('');
  }
  parts.push('Follow the output format in your system prompt exactly.');
  return parts.join('\n');
}

// ─── applyRecipe ─────────────────────────────────────────────────────
/**
 * Look up a recipe by fingerprintId and run the sub-agent against it.
 * Returns: { ok, recipe, patch, subagentLog, error }
 *
 * "patch" is the sub-agent's raw text output (since we told it to emit diagnosis+diff).
 * The caller (dashboard) shows this to the human — NO auto-apply.
 */
async function applyRecipe(fingerprintId) {
  var recipe = findRecipe(fingerprintId);
  if (!recipe) {
    return {
      ok: false,
      error: 'No recipe found for fingerprint: ' + fingerprintId,
      hint: 'Add a recipe to worker/fix-recipes.json or check the fingerprint string.',
    };
  }

  var recipeBody = loadRecipeBody(recipe);
  if (!recipeBody) {
    return {
      ok: false,
      recipe: recipe,
      error: 'Recipe file not found: worker/' + recipe.recipeFile,
      hint: 'Create the recipe markdown file.',
    };
  }

  var runner = getRunner();
  if (typeof runner !== 'function') {
    return {
      ok: false,
      recipe: recipe,
      error: 'runClaudeCodeText adapter unavailable (worker/claude-code-coder.js did not export it)',
    };
  }

  var files = collectAffectedFiles(recipe);
  var fileNames = Object.keys(files);
  var systemPrompt = buildSystemPrompt(recipe, recipeBody);
  var userPrompt = buildUserPrompt(recipe, fileNames);

  var startedAt = new Date().toISOString();
  var result;
  try {
    result = await runner({
      systemPrompt: systemPrompt,
      userPrompt: userPrompt,
      additionalFiles: files,
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      timeoutMs: 4 * 60 * 1000,
      minOutputLen: 100,
      taskId: 'autofix-' + (recipe.id || 'unknown'),
      log: function(/* msg, tid */) { /* silent */ },
    });
  } catch(e) {
    return {
      ok: false,
      recipe: recipe,
      error: 'Sub-agent spawn threw: ' + e.message,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  return {
    ok: !!(result && result.ok),
    recipe: {
      id: recipe.id,
      description: recipe.description,
      risk: recipe.risk,
      recipeFile: recipe.recipeFile,
      affectedFiles: recipe.affectedFiles,
      relatedCommits: recipe.relatedCommits,
      relatedMemories: recipe.relatedMemories,
    },
    patch: result && result.text ? result.text : null,
    subagentLog: {
      exitCode: result ? result.exitCode : null,
      error: result ? result.error : null,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      filesStaged: fileNames,
    },
    // Explicit reminder: dashboard displays this, does NOT apply it
    autoApplied: false,
    notice: 'L4 auto-fix produces a patch proposal only. The human reviewer must apply it.',
  };
}

module.exports = {
  applyRecipe: applyRecipe,
  findRecipe: findRecipe,
};
