'use strict';

var childProcess = require('child_process');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var briefCards = require('./storyboard-visual-brief-cards.cjs');

var REPORT_VERSION = 'storyboard-visual-production.v1';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function phaseFileStem(index) {
  return 'phase' + String(index + 1).padStart(2, '0');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function normalizeCameraMode(value) {
  var mode = stringValue(value || process.env.STORYBOARD_CAMERA_MODE).toLowerCase();
  if (mode === 'orthographic' || mode === 'ortho' || mode === '正交相机' || mode === '正交') return 'orthographic';
  return 'perspective';
}

function cameraModePromptLine(cameraMode) {
  if (normalizeCameraMode(cameraMode) === 'orthographic') {
    return '镜头方式：正交相机。画面无近大远小透视变形，偏等距/俯视构图，适合清楚展示位置关系、UI 指引和操作路径。';
  }
  return '镜头方式：透视相机。画面保留近大远小和空间纵深，偏 3D 实机截图质感，主目标要清晰突出。';
}

function buildVisualPrompt(storyboard, phase, index, total, options) {
  options = options || {};
  var brief = phase.visualBrief || {};
  var lines = [
    '你是试玩广告客户确认分镜的画面生成器。请输出一张横版 16:9 单画面，用来放进 PDF 的“画面”列。',
    '画面目标：准确表达本 phase 的玩家动作、目标对象、结果反馈和 UI 引导；不要添加未在文案中出现的核心玩法。',
    '',
    '项目：' + stringValue(storyboard && storyboard.project && storyboard.project.name),
    '核心流程：' + stringValue(storyboard && storyboard.project && storyboard.project.coreLoop),
    'Phase：' + (index + 1) + '/' + total + ' ' + stringValue(phase.title),
    '玩家看到什么：' + stringValue(phase.sceneText || phase.visualPrompt),
    '玩家做什么：' + stringValue(phase.playerAction),
    '操作反馈：' + stringValue(phase.feedback),
    'UI/引导：' + stringValue(phase.uiText),
    '主目标：' + stringValue(phase.primaryTarget),
    '交互语义：' + stringValue(phase.canonicalInteraction),
    cameraModePromptLine(options.cameraMode),
  ];
  var mustShow = safeArray(brief.mustShow).map(stringValue).filter(Boolean);
  var mustNotShow = safeArray(brief.mustNotShow).map(stringValue).filter(Boolean);
  var sourceEvidence = safeArray(phase.sourceEvidence || brief.sourceEvidence).map(stringValue).filter(Boolean);
  if (mustShow.length) lines.push('必须出现：' + mustShow.join('、'));
  if (mustNotShow.length) lines.push('不能出现：' + mustNotShow.join('、'));
  if (brief.camera) lines.push('镜头：' + stringValue(brief.camera));
  if (safeArray(brief.ui).length) lines.push('UI 细节：' + safeArray(brief.ui).map(stringValue).filter(Boolean).join('、'));
  if (sourceEvidence.length) lines.push('来源证据：' + sourceEvidence.slice(0, 6).join('；'));
  lines.push('风格：清晰、可读、偏试玩广告实机分镜，不要做营销海报，不要遮挡关键 UI 和目标对象。');
  return lines.filter(function(line) { return line !== ''; }).join('\n');
}

function runExternalCommand(command, env, cwd, timeoutMs) {
  timeoutMs = timeoutMs || 300000;
  return new Promise(function(resolve) {
    var stdout = '';
    var stderr = '';
    var settled = false;
    var child;
    try {
      child = childProcess.spawn(command, {
        shell: true,
        cwd: cwd || process.cwd(),
        env: Object.assign({}, process.env, env || {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error: e });
      return;
    }
    function appendLimited(target, chunk) {
      target += chunk.toString('utf8');
      if (target.length > 1024 * 1024) target = target.slice(-1024 * 1024);
      return target;
    }
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch (e) {}
      resolve({
        status: null,
        signal: 'SIGTERM',
        stdout: stdout,
        stderr: stderr,
        error: new Error('external command timeout after ' + timeoutMs + 'ms'),
      });
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', function(chunk) { stdout = appendLimited(stdout, chunk); });
    if (child.stderr) child.stderr.on('data', function(chunk) { stderr = appendLimited(stderr, chunk); });
    child.on('error', function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, signal: null, stdout: stdout, stderr: stderr, error: err });
    });
    child.on('close', function(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code,
        signal: signal,
        stdout: stdout,
        stderr: stderr,
        error: null,
      });
    });
  });
}

function fileLooksUsable(filePath) {
  try {
    var stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 32;
  } catch (e) {
    return false;
  }
}

async function renderFallbackCard(phase, outPath, options) {
  await briefCards.renderVisualBriefCard(phase, outPath, options || {});
  return outPath;
}

async function produceStoryboardVisuals(storyboard, outDir, options) {
  options = options || {};
  var mode = stringValue(options.visualMode || options.mode || process.env.STORYBOARD_VISUAL_MODE) || 'brief-card';
  var visualCommand = stringValue(options.visualCommand || process.env.STORYBOARD_VISUAL_COMMAND);
  if (mode === 'external-command') mode = 'external';
  if (mode === 'external' && !visualCommand) {
    throw new Error('visualMode=external requires --visual-command or STORYBOARD_VISUAL_COMMAND');
  }
  if (mode !== 'brief-card' && mode !== 'external') {
    throw new Error('unsupported storyboard visual mode: ' + mode);
  }

  fs.mkdirSync(outDir, { recursive: true });
  var baseDir = path.resolve(options.baseDir || path.dirname(outDir));
  var promptsDir = path.resolve(options.promptsDir || path.join(baseDir, 'visual-prompts'));
  fs.mkdirSync(promptsDir, { recursive: true });
  var cameraMode = normalizeCameraMode(options.cameraMode);

  var phases = safeArray(storyboard && storyboard.phases);
  var report = {
    schemaVersion: REPORT_VERSION,
    mode: mode,
    provider: mode === 'external' ? 'external-command' : 'none',
    cameraMode: cameraMode,
    status: 'ok',
    assetsDir: path.resolve(outDir),
    promptsDir: promptsDir,
    phases: [],
    diagnostics: [],
  };
  var previousImage = '';
  for (var i = 0; i < phases.length; i += 1) {
    var phase = phases[i];
    var stem = phaseFileStem(i);
    var outPath = path.join(outDir, stem + '.png');
    var promptPath = path.join(promptsDir, stem + '.prompt.txt');
    var promptJsonPath = path.join(promptsDir, stem + '.json');
    var prompt = buildVisualPrompt(storyboard, phase, i, phases.length, { cameraMode: cameraMode });
    fs.writeFileSync(promptPath, prompt);
    writeJson(promptJsonPath, {
      schemaVersion: 'storyboard-visual-prompt.v1',
      phaseId: phase.phaseId,
      phaseIndex: i + 1,
      phaseCount: phases.length,
      prompt: prompt,
      promptHash: sha256(prompt),
      cameraMode: cameraMode,
      phase: phase,
    });

    var phaseReport = {
      phaseId: phase.phaseId,
      output: outPath,
      promptPath: promptPath,
      promptJsonPath: promptJsonPath,
      promptHash: sha256(prompt),
      mode: mode,
      status: '',
      fallback: false,
    };

    if (typeof options.onPhaseStart === 'function') {
      options.onPhaseStart({
        phase: phase,
        phaseId: phase.phaseId,
        index: i,
        total: phases.length,
        output: outPath,
        promptPath: promptPath,
        promptJsonPath: promptJsonPath,
        mode: mode,
      });
    }

    if (mode === 'external') {
      var external = await runExternalCommand(visualCommand, {
        STORYBOARD_PROJECT_NAME: stringValue(storyboard && storyboard.project && storyboard.project.name),
        STORYBOARD_PHASE_ID: stringValue(phase.phaseId),
        STORYBOARD_PHASE_INDEX: String(i + 1),
        STORYBOARD_PHASE_COUNT: String(phases.length),
        STORYBOARD_PHASE_TITLE: stringValue(phase.title),
        STORYBOARD_PHASE_OUTPUT: outPath,
        STORYBOARD_PHASE_PROMPT_FILE: promptPath,
        STORYBOARD_PHASE_PROMPT_JSON: promptJsonPath,
        STORYBOARD_PREVIOUS_IMAGE: previousImage,
      }, options.commandCwd || process.cwd(), options.timeoutMs || 300000);
      if (external.error || external.status !== 0 || !fileLooksUsable(outPath)) {
        var reason = external.error ? external.error.message : ('exit=' + external.status + (external.signal ? ' signal=' + external.signal : ''));
        if (options.strictVisual) {
          phaseReport.status = 'failed';
          phaseReport.error = reason;
          if (typeof options.onPhaseComplete === 'function') options.onPhaseComplete(phaseReport, i, phases.length);
          throw new Error('external visual producer failed for ' + phase.phaseId + ': ' + reason + ' ' + external.stderr.slice(0, 300));
        }
        report.status = 'fallback';
        phaseReport.fallback = true;
        phaseReport.fallbackReason = reason;
        report.diagnostics.push({
          code: 'external_visual_producer_fallback',
          severity: 'warning',
          phaseId: phase.phaseId,
          reason: reason,
          stderr: external.stderr.slice(0, 500),
        });
        await renderFallbackCard(phase, outPath, options);
        phaseReport.status = 'fallback_brief_card';
      } else {
        phaseReport.status = 'external_ok';
      }
    } else {
      await renderFallbackCard(phase, outPath, options);
      phaseReport.status = 'brief_card';
    }

    previousImage = outPath;
    phase.image = path.relative(baseDir, outPath);
    report.phases.push(phaseReport);
    if (typeof options.onPhaseComplete === 'function') options.onPhaseComplete(phaseReport, i, phases.length);
  }
  return report;
}

module.exports = {
  REPORT_VERSION: REPORT_VERSION,
  buildVisualPrompt: buildVisualPrompt,
  normalizeCameraMode: normalizeCameraMode,
  produceStoryboardVisuals: produceStoryboardVisuals,
  _internals: {
    runExternalCommand: runExternalCommand,
    sha256: sha256,
    fileLooksUsable: fileLooksUsable,
  },
};
