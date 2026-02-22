// Worker Client v4 — Cocos Creator version
// Flow: Poll task → SVN update → AI coding → Cocos build → Upload zip → Report status

const http = require('http');
const https = require('https');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectScenes, fixProjectSettings } = require('./worker-patch.js');
const { runCocosBuild } = require('./worker-cocos-build.js');
const { generateCode } = require('./worker-coder.js');
const { convertAndSave } = require('./worker-html-converter.js');

const WORKER_ID = process.env.WORKER_ID || 'workerA-cocos';
const BASE_URL = process.env.BASE_URL || 'https://playcools.top/blueprintEditorCocos';
const POLL_INTERVAL = 8000;
const HEARTBEAT_INTERVAL = 30000;
const WORK_DIR = 'D:\\work';
const FIXED_PROJECT_DIR = path.join(WORK_DIR, 'test-cocos');
const SVN_USER = 'openclaw';
const SVN_PASS = 'openclaw';
const SVN_FLAGS = '--non-interactive --no-auth-cache --username ' + SVN_USER + ' --password ' + SVN_PASS;
const MAX_CONCURRENT = 1;

const activeTasks = new Map();
const startTime = Date.now();
var pollLock = false;

function log(msg, taskId) {
  var prefix = taskId ? '[' + taskId.slice(-8) + ']' : '[MAIN]';
  console.log('[' + new Date().toISOString() + '] ' + prefix + ' ' + msg);
}

function apiRequest(method, urlPath, body, isBinary, extraHeaders) {
  return new Promise(function(resolve, reject) {
    var fullUrl = new URL(BASE_URL + urlPath);
    var isHttps = fullUrl.protocol === 'https:';
    var lib = isHttps ? https : http;
    var opts = {
      hostname: fullUrl.hostname, port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search, method: method,
      headers: {}, rejectUnauthorized: false, timeout: 120000
    };
    if (body && !isBinary) {
      var jsonStr = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(jsonStr);
    }
    if (isBinary) { opts.headers['Content-Type'] = 'application/zip'; opts.headers['Content-Length'] = body.length; }
    if (extraHeaders) Object.assign(opts.headers, extraHeaders);
    var req = lib.request(opts, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (res.statusCode === 204) return resolve(null);
        var data = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Request timeout')); });
    if (body) { if (isBinary) req.write(body); else req.write(JSON.stringify(body)); }
    req.end();
  });
}

function reportStatus(taskId, status, extra) {
  var payload = { workerId: WORKER_ID, taskId: taskId, status: status };
  if (extra) Object.assign(payload, extra);
  return apiRequest('POST', '/api/worker/status', payload).then(function() {
    log('Status -> ' + status + (extra && extra.message ? ': ' + extra.message : ''), taskId);
  }).catch(function(e) { log('Status report failed: ' + e.message, taskId); });
}

function runCmd(cmd, cwd, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  try {
    var out = execSync(cmd, { cwd: cwd, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
    return { ok: true, output: out.trim() };
  } catch(e) {
    return { ok: false, output: ((e.stdout||'') + '\n' + (e.stderr||'')).trim(), error: e.message };
  }
}

async function processTask(task) {
  var taskId = task.taskId;
  if (task.originalStatus) { task.status = task.originalStatus; delete task.originalStatus; }
  if (task.status === 'commit_needed') return await handleCommit(task);

  try {
    await reportStatus(taskId, 'processing', { message: 'SVN update ...' });
    if (!fs.existsSync(FIXED_PROJECT_DIR)) {
      var svnUrl = task.svnUrl || 'svn://47.101.191.213:3690/test0213';
      log('SVN checkout...', taskId);
      var checkout = runCmd('svn checkout ' + SVN_FLAGS + ' "' + svnUrl + '" "' + FIXED_PROJECT_DIR + '"', undefined, 600000);
      if (!checkout.ok) { await reportStatus(taskId, 'failed', { message: 'SVN checkout failed: ' + checkout.output.slice(0,300) }); return; }
    } else {
      var update = runCmd('svn update ' + SVN_FLAGS, FIXED_PROJECT_DIR, 120000);
      if (!update.ok) { await reportStatus(taskId, 'failed', { message: 'SVN update failed: ' + update.output.slice(0,300) }); return; }
      log('SVN update OK: ' + update.output.split('\n').pop(), taskId);
    }

    await reportStatus(taskId, 'processing', { message: 'AI coding...' });
    var blueprint = null;
    try { blueprint = await apiRequest('GET', '/api/tasks/' + taskId + '/blueprint'); } catch(e) { log('Failed to fetch blueprint: ' + e.message, taskId); }
    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log('Blueprint: ' + blueprint.nodes.length + ' nodes', taskId);
      var codeResult = await generateCode(blueprint, FIXED_PROJECT_DIR, log, taskId);
      if (codeResult.ok && !codeResult.skipped) {
        log('AI coding done: ' + codeResult.filesWritten + ' files', taskId);
        await reportStatus(taskId, 'processing', { message: 'AI coding done (' + codeResult.filesWritten + ' files)' });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error, taskId);
        await reportStatus(taskId, 'processing', { message: 'AI coding failed, using existing code' });
      }
    }

    await reportStatus(taskId, 'building', { message: 'Cocos build...' });
    var buildDir = path.join(FIXED_PROJECT_DIR, 'build', 'web-mobile');
    if (fs.existsSync(buildDir)) { try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {} }
    var scenes = detectScenes(FIXED_PROJECT_DIR);
    if (scenes.length === 0) { await reportStatus(taskId, 'failed', { message: 'No scenes found' }); return; }
    log('Detected ' + scenes.length + ' scene(s)', taskId);
    fixProjectSettings(FIXED_PROJECT_DIR, scenes);

    var buildResult = await runCocosBuild(FIXED_PROJECT_DIR, log, taskId);
    if (!buildResult.ok) { await reportStatus(taskId, 'failed', { message: 'Cocos build failed: ' + (buildResult.error||'').slice(0,300) }); return; }
    log('Cocos build OK in ' + buildResult.buildTime + 's', taskId);

    await reportStatus(taskId, 'processing', { message: 'HTML conversion...' });
    var htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
    try {
      var htmlResults = await convertAndSave(buildDir, htmlOutputDir, { channels: ['appLovin'], projectName: taskId });
      log('HTML conversion done: ' + htmlResults.length + ' channels', taskId);
    } catch(e) { log('HTML conversion failed (non-fatal): ' + e.message, taskId); }

    await reportStatus(taskId, 'processing', { message: 'Uploading HTML...' });
    if (fs.existsSync(htmlOutputDir)) {
      var htmlFiles = fs.readdirSync(htmlOutputDir).filter(function(f) { return f.endsWith('.html'); });
      var uploadOk = false;
      for (var i = 0; i < htmlFiles.length; i++) {
        var htmlBuffer = fs.readFileSync(path.join(htmlOutputDir, htmlFiles[i]));
        log('Uploading ' + htmlFiles[i] + ' (' + (htmlBuffer.length/1024/1024).toFixed(1) + 'MB)', taskId);
        try {
          await apiRequest('POST', '/api/tasks/' + taskId + '/upload-html', htmlBuffer, true, { 'Content-Type': 'text/html', 'X-Filename': htmlFiles[i] });
          uploadOk = true;
        } catch(e) { log('HTML upload failed: ' + e.message, taskId); }
      }
      try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch(e) {}
      if (!uploadOk) { await reportStatus(taskId, 'failed', { message: 'HTML upload failed' }); return; }
    } else {
      await reportStatus(taskId, 'failed', { message: 'No HTML output' }); return;
    }

    await reportStatus(taskId, 'reviewing', { message: 'Build done (' + buildResult.buildTime + 's), awaiting review' });
  } catch(e) {
    log('Task error: ' + e.message, taskId);
    await reportStatus(taskId, 'failed', { message: 'Error: ' + e.message.slice(0,300) });
  }
}

async function uploadBuild(taskId, buildDir) {
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) { log('No build output', taskId); return false; }
  var zipPath = path.join(WORK_DIR, taskId + '-build.zip');
  try { fs.unlinkSync(zipPath); } catch(e) {}
  var zipResult = runCmd('powershell -Command "Compress-Archive -Path \'' + buildDir + '\\*\' -DestinationPath \'' + zipPath + '\' -Force"', undefined, 60000);
  if (!zipResult.ok || !fs.existsSync(zipPath)) return false;
  var zipBuffer = fs.readFileSync(zipPath);
  try {
    var result = await apiRequest('POST', '/api/tasks/' + taskId + '/upload-build', zipBuffer, true);
    try { fs.unlinkSync(zipPath); } catch(e) {}
    return result && result.success;
  } catch(e) { return false; }
}

async function handleCommit(task) {
  var taskId = task.taskId;
  await reportStatus(taskId, 'processing', { message: 'SVN commit...' });
  if (!fs.existsSync(FIXED_PROJECT_DIR)) { await reportStatus(taskId, 'failed', { message: 'Working copy not found' }); return; }
  var cacheList = ['build', 'temp', 'local', 'library', 'node_modules', '.vs'];
  for (var i = 0; i < cacheList.length; i++) {
    var dirPath = path.join(FIXED_PROJECT_DIR, cacheList[i]);
    if (fs.existsSync(dirPath)) {
      try { runCmd('svn revert --depth infinity "' + cacheList[i] + '" ' + SVN_FLAGS, FIXED_PROJECT_DIR); fs.rmSync(dirPath, { recursive: true, force: true }); } catch(e) {}
    }
  }
  runCmd('svn add --force . ' + SVN_FLAGS, FIXED_PROJECT_DIR);
  var commitMsg = '[AutoCoding] ' + (task.projectName || 'Project') + ' - ' + taskId;
  var result = runCmd('svn commit -m "' + commitMsg + '" ' + SVN_FLAGS, FIXED_PROJECT_DIR, 600000);
  if (!result.ok) { await reportStatus(taskId, 'failed', { message: 'SVN commit failed' }); return; }
  var revMatch = result.output.match(/Committed revision (\d+)/);
  var svnRevision = revMatch ? parseInt(revMatch[1]) : null;
  try { await apiRequest('POST', '/api/projects/' + taskId + '/committed', { svnRevision: svnRevision, message: commitMsg }); } catch(e) {}
  await reportStatus(taskId, 'committed', { message: 'SVN committed r' + svnRevision });
}

async function poll() {
  if (pollLock || activeTasks.size >= MAX_CONCURRENT) return;
  pollLock = true;
  try {
    var task = await apiRequest('GET', '/api/worker/poll?workerId=' + WORKER_ID);
    if (!task || !task.taskId) return;
    if (activeTasks.has(task.taskId)) return;
    log('Got task: ' + task.taskId, task.taskId);
    activeTasks.set(task.taskId, { task: task, startedAt: Date.now() });
    processTask(task).catch(function(e) { log('Unhandled: ' + e.message, task.taskId); }).finally(function() { activeTasks.delete(task.taskId); });
  } catch(e) {}
  finally { pollLock = false; }
}

function heartbeat() {
  var tasks = [];
  for (var entry of activeTasks) { tasks.push({ taskId: entry[0], elapsed: Math.floor((Date.now() - entry[1].startedAt)/1000) }); }
  apiRequest('POST', '/api/worker/heartbeat', { workerId: WORKER_ID, status: activeTasks.size > 0 ? 'busy' : 'idle', activeTasks: tasks, uptime: Math.floor((Date.now()-startTime)/1000) }).catch(function() {});
}

log('Worker v4 (Cocos) starting | ID: ' + WORKER_ID + ' | Server: ' + BASE_URL);
poll(); setInterval(poll, POLL_INTERVAL); setInterval(heartbeat, HEARTBEAT_INTERVAL); heartbeat();
