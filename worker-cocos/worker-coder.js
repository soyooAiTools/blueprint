// Worker Coder v3 — Cocos Creator TypeScript version
const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://crs.mindrix.app/api';
const API_KEY = process.env.LLM_API_KEY || 'cr_f891cb1046bf100addfc0bf027cb1b37fafa8cc214e1bdbbe5493e6fa3240e7c';
const MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 16384;
const MAX_FIX_ATTEMPTS = 10;

function callClaude(systemPrompt, userMessage, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] });
    var url = new URL(API_BASE + '/v1/messages');
    var opts = { hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false, timeout: timeoutMs };
    var req = https.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var data = Buffer.concat(chunks).toString('utf-8');
        try {
          var parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error('API: ' + (parsed.error.message || JSON.stringify(parsed.error))));
          var text = '';
          if (parsed.content) for (var i = 0; i < parsed.content.length; i++) { if (parsed.content[i].type === 'text') text += parsed.content[i].text; }
          resolve({ text: text, usage: parsed.usage, model: parsed.model });
        } catch(e) { reject(new Error('Parse: ' + data.slice(0,500))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('API timeout')); });
    req.write(body); req.end();
  });
}

function parseBlueprintToPrompt(blueprint) {
  var nodes = blueprint.nodes || [];
  var edges = blueprint.edges || [];
  if (nodes.length === 0) return null;
  var scenes = nodes.map(function(node, i) {
    var d = node.data || {};
    return { id: node.id, label: d.label || d.title || ('Scene '+(i+1)), description: d.description || '', interactions: d.interactions || [] };
  });
  var transitions = edges.map(function(edge) { return { from: edge.source, to: edge.target, condition: (edge.data && edge.data.condition) || 'click' }; });
  var feedbackText = '';
  if (blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0) {
    var latest = blueprint.feedbackHistory[blueprint.feedbackHistory.length - 1];
    feedbackText = '\n\n## Previous Feedback (MUST address):\n' + JSON.stringify(latest.data || latest, null, 2);
  }
  return { projectName: blueprint.projectName || 'Playable Ad', scenes: scenes, transitions: transitions, feedbackText: feedbackText };
}

var GENERATE_PROMPT = [
  'You are a Cocos Creator 3.8.x TypeScript code generator for playable ads (HTML5 Web Mobile).',
  '',
  '## 踩坑经验（公司实战，必须遵守！）',
  '- 音频绝对不要用 .ogg 格式，必须用 .mp3。苹果手机黑屏大概率是 .ogg 导致',
  '- 打包不要勾选 MD5 缓存，可能导致打包失败',
  '- 打包 web-mobile 后压缩 zip 不要多套一层目录，否则渠道包黑屏',
  '- 打包后黑屏但调试模式正常 + JSON.parse undefined 报错 → 缓存没清干净，删 library/Build/temp 重新打包',
  '- 打包后出现进度条 → 游戏初始化时加 document.body.style.overflow = "hidden"',
  '',
  '## CRITICAL COCOS CREATOR CONSTRAINTS',
  '',
  '### DO NOT use:',
  '- Multi-threading (SharedArrayBuffer restricted in WebView)',
  '- VideoPlayer component (fails in many mobile WebViews)',
  '- localStorage (some WebViews block it)',
  '- cc.resources.load for assets not in resources/ folder',
  '- Dynamic creation of many nodes (use NodePool for pooling)',
  '- Heavy physics engines (Bullet/PhysX slow on Web, use Builtin or manual)',
  '- cc.find() for global lookups (use @property references or getChildByName)',
  '- Heavy computation in update() (use schedule() or events)',
  '- Accessing other components in onLoad (may not be initialized; use start())',
  '',
  '### MUST do:',
  '- Use TypeScript with @ccclass / @property decorators',
  '- Components extend Component (import from "cc")',
  '- import { _decorator, Component, Node, ... } from "cc"',
  '- const { ccclass, property } = _decorator',
  '- Use tween() for animations instead of manual interpolation',
  '- Use EventTarget for decoupled communication',
  '- iOS audio: play silent clip on first touch to unlock AudioContext',
  '- Implement mute/unmute callbacks (channel requirement)',
  '- CTA button: call channel SDK (e.g. mraid.open(url))',
  '- Total bundle < 5MB (AppLovin channel limit)',
  '- First screen < 3 seconds load',
  '- Scene transitions via director.loadScene() or node.active toggling',
  '- Clean up singletons on replay',
  '- Use compressed textures and sprite atlases to reduce DrawCall',
  '- Disable Mipmap on UI/static textures',
  '- MP3 audio format (best compatibility), max 30 seconds',
  '- Canvas: set Fit Width/Fit Height, anchor key UI with Widget',
  '- Use BlockInputEvents to prevent touch passthrough',
  '',
  '### Allowed:',
  '- Component, Node, Vec2, Vec3, Color, Quat, Mat4',
  '- UI: Button, Label, Sprite, Layout, Widget, Canvas, RichText',
  '- tween(), Tween',
  '- AudioSource, AudioClip',
  '- Collider, RigidBody (Builtin physics preferred)',
  '- Spine (match runtime version)',
  '- Scheduler (schedule/unschedule)',
  '- resources.load / assetManager',
  '- director.loadScene',
  '',
  '## Work with the existing project',
  'Read and understand the existing codebase. Follow same patterns and architecture.',
  'Extend/modify existing scripts rather than creating from scratch.',
  'Reuse existing utility classes, managers, helpers.',
  '',
  'Output format: Each file as:',
  '```typescript:assets/scripts/FileName.ts',
  '// code',
  '```',
  '',
  'Generate code that integrates naturally with the existing project.'
].join('\n');

var FIX_PROMPT = [
  'You are fixing Cocos Creator 3.8.x TypeScript compilation errors for a playable ad.',
  '',
  '## Key constraints:',
  '- Must use @ccclass decorator on all component classes',
  '- @property decorator for serialized fields',
  '- Import from "cc": import { _decorator, Component, Node } from "cc"',
  '- const { ccclass, property } = _decorator',
  '- Do NOT use cc.find() — use @property references',
  '- Do NOT access uninitialized components in onLoad — use start()',
  '- Check null before accessing optional references',
  '',
  'Fix ALL errors. If same errors recur, try a different approach.',
  '',
  'Output corrected files as:',
  '```typescript:assets/scripts/FileName.ts',
  '// fixed code',
  '```',
  'Only include files that need changes.'
].join('\n');

function tryCompile(projectDir, log, taskId) {
  var cocosExe = process.env.COCOS_CREATOR || 'D:\\CocosCreator-v3.8.8-win-121518\\CocosCreator.exe';
  var { execSync } = require('child_process');
  var buildDir = path.join(projectDir, 'build', 'web-mobile');
  // Clean previous build output so we can detect fresh build success
  try { if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
  try {
    execSync('"' + cocosExe + '" --project "' + projectDir + '" --build "platform=web-mobile;debug=false"', { timeout: 180000, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
    log('[coder] Build passed!', taskId);
    return { ok: true };
  } catch(e) {
    // Check if build output exists (exit code 36 = non-fatal warnings)
    if (fs.existsSync(path.join(buildDir, 'index.html'))) {
      log('[coder] Build exit non-zero but output exists, treating as pass', taskId);
      return { ok: true };
    }
    var output = ((e.stdout||'') + '\n' + (e.stderr||'')).trim();
    // Filter real TS errors (not asset warnings)
    var errors = output.split('\n').filter(function(l) { return /error TS\d+/i.test(l); });
    if (errors.length === 0) errors = output.split('\n').filter(function(l) { return /error/i.test(l) && !/warning|asset|SIGTERM|Exit process with code:null/i.test(l); });
    log('[coder] Build failed: ' + errors.length + ' errors', taskId);
    if (errors.length > 0) errors.forEach(function(e) { log('[coder] ERROR: ' + e.trim(), taskId); });
    return { ok: false, errors: errors.length > 0 ? errors : ['Build failed: ' + output.slice(-500)] };
  }
}

async function generateCode(blueprint, projectDir, log, taskId) {
  log = log || console.log;
  var parsed = parseBlueprintToPrompt(blueprint);
  if (!parsed) return { ok: true, skipped: true };

  log('[coder] Generating for ' + parsed.scenes.length + ' scenes', taskId);
  var projectCtx = readProjectContext(projectDir);
  var existingClasses = listExistingClasses(projectDir);
  var classWarning = existingClasses.length > 0 ? '\n\n## EXISTING CLASSES (do NOT reuse):\n' + existingClasses.join(', ') : '';
  var projectSection = '';
  if (projectCtx.fileList) projectSection = '\n\n## PROJECT FILES:\n```\n' + projectCtx.fileList + '\n```';
  if (projectCtx.context) projectSection += '\n\n## PROJECT CODE:\n' + projectCtx.context;

  var userMsg = '## Project: ' + parsed.projectName + '\n\n## Scenes:\n' + JSON.stringify(parsed.scenes, null, 2) + '\n\n## Transitions:\n' + JSON.stringify(parsed.transitions, null, 2) + classWarning + projectSection + parsed.feedbackText + '\n\nGenerate Cocos Creator TypeScript scripts.';

  try {
    var response = await callClaude(GENERATE_PROMPT, userMsg);
    var files = parseCodeBlocks(response.text);
    if (files.length === 0) return { ok: false, error: 'No code blocks' };
    writeFiles(projectDir, files, log, taskId);

    var prevErrorSig = '', sameErrorCount = 0;
    for (var attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      var result = tryCompile(projectDir, log, taskId);
      if (result.ok) return { ok: true, filesWritten: files.length, files: files.map(function(f) { return f.path; }), attempts: attempt };

      var errorSig = result.errors.sort().join('|');
      if (errorSig === prevErrorSig) sameErrorCount++; else { sameErrorCount = 0; prevErrorSig = errorSig; }
      if (sameErrorCount >= 3) {
        var regenResp = await callClaude(GENERATE_PROMPT, userMsg + '\n\n## PERSISTENT ERRORS:\n```\n' + result.errors.join('\n') + '\n```\nGenerate completely different code.');
        var regenFiles = parseCodeBlocks(regenResp.text);
        if (regenFiles.length > 0) { writeFiles(projectDir, regenFiles, log, taskId); files = regenFiles; }
        sameErrorCount = 0; prevErrorSig = ''; continue;
      }

      log('[coder] Fix attempt ' + attempt + '/' + MAX_FIX_ATTEMPTS, taskId);
      var fixMsg = '## Errors:\n```\n' + result.errors.join('\n') + '\n```\n\n## Current Scripts:\n' + readCurrentScripts(projectDir) + '\n\nFix ALL errors.';
      var fixResp = await callClaude(FIX_PROMPT, fixMsg);
      var fixed = parseCodeBlocks(fixResp.text);
      if (fixed.length > 0) { writeFiles(projectDir, fixed, log, taskId); files = fixed; }
    }
    return { ok: false, error: 'Build failed after ' + MAX_FIX_ATTEMPTS + ' attempts' };
  } catch(e) { return { ok: false, error: e.message }; }
}

function writeFiles(projectDir, files, log, taskId) {
  for (var i = 0; i < files.length; i++) {
    var fullPath = path.join(projectDir, files[i].path);
    var dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, files[i].content, 'utf-8');
    log('[coder] Written: ' + files[i].path, taskId);
  }
}

function parseCodeBlocks(text) {
  var files = [];
  var regex = /```(?:typescript|ts)[:\s]+([^\n`]+\.ts)\s*\n([\s\S]*?)```/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    var fp = match[1].trim();
    if (!fp.startsWith('assets/')) fp = 'assets/scripts/' + path.basename(fp);
    files.push({ path: fp, content: match[2].trim() + '\n' });
  }
  if (files.length === 0) {
    var fb = /```(?:typescript|ts)\s*\n([\s\S]*?)```/g;
    var idx = 0;
    while ((match = fb.exec(text)) !== null) {
      var code = match[1].trim() + '\n';
      var cm = code.match(/class\s+(\w+)/);
      files.push({ path: 'assets/scripts/' + (cm ? cm[1] : 'Script' + idx) + '.ts', content: code });
      idx++;
    }
  }
  return files;
}

function listExistingClasses(projectDir) {
  var classes = [];
  var dirs = ['assets/scripts', 'assets/Script', 'assets/src'];
  for (var d = 0; d < dirs.length; d++) {
    var full = path.join(projectDir, dirs[d]);
    if (fs.existsSync(full)) {
      var tsFiles = listTsFiles(full);
      for (var i = 0; i < tsFiles.length; i++) {
        try {
          var content = fs.readFileSync(tsFiles[i], 'utf-8');
          var matches = content.match(/class\s+(\w+)/g);
          if (matches) for (var j = 0; j < matches.length; j++) classes.push(matches[j].replace('class ', ''));
        } catch(e) {}
      }
    }
  }
  return classes;
}

function readProjectContext(projectDir) {
  var MAX = 30000, parts = [], total = 0;
  var scanDirs = ['assets/scripts', 'assets/Script', 'assets/src'];
  var allFiles = [];
  for (var d = 0; d < scanDirs.length; d++) {
    var full = path.join(projectDir, scanDirs[d]);
    if (fs.existsSync(full)) {
      var tsFiles = listTsFiles(full);
      for (var i = 0; i < tsFiles.length; i++) {
        try { var stat = fs.statSync(tsFiles[i]); allFiles.push({ path: tsFiles[i], rel: path.relative(projectDir, tsFiles[i]).replace(/\\/g,'/'), size: stat.size }); } catch(e) {}
      }
    }
  }
  if (allFiles.length === 0) return { context: '', fileList: '' };
  var fileList = allFiles.map(function(f) { return f.rel + ' (' + Math.round(f.size/1024) + 'KB)'; }).join('\n');
  allFiles.sort(function(a,b) { return a.size - b.size; });
  for (var i = 0; i < allFiles.length; i++) {
    if (total >= MAX || allFiles[i].size > 8000) continue;
    try { var c = fs.readFileSync(allFiles[i].path, 'utf-8'); if (total + c.length > MAX) continue; parts.push('```typescript:' + allFiles[i].rel + '\n' + c + '\n```'); total += c.length; } catch(e) {}
  }
  return { context: parts.join('\n\n'), fileList: fileList };
}

function readCurrentScripts(projectDir) {
  var scriptsDir = path.join(projectDir, 'assets', 'scripts');
  if (!fs.existsSync(scriptsDir)) return '(no scripts)';
  var files = listTsFiles(scriptsDir), parts = [];
  for (var i = 0; i < files.length; i++) {
    parts.push('```typescript:' + path.relative(projectDir, files[i]).replace(/\\/g,'/') + '\n' + fs.readFileSync(files[i], 'utf-8') + '\n```');
  }
  return parts.join('\n\n') || '(no scripts)';
}

function listTsFiles(dir) {
  var results = [];
  try {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var fp = path.join(dir, entries[i].name);
      if (entries[i].isDirectory()) results = results.concat(listTsFiles(fp));
      else if (entries[i].name.endsWith('.ts') && !entries[i].name.endsWith('.d.ts')) results.push(fp);
    }
  } catch(e) {}
  return results;
}

module.exports = { generateCode, callClaude, parseBlueprintToPrompt };
