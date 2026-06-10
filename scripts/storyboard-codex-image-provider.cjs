#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var sharp = require('sharp');

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function usage() {
  console.error('Usage: STORYBOARD_PHASE_PROMPT_FILE=<prompt> STORYBOARD_PHASE_OUTPUT=<out.png> node scripts/storyboard-codex-image-provider.cjs');
  console.error('Optional env: CODEX_BIN, STORYBOARD_CODEX_TIMEOUT_MS, STORYBOARD_CODEX_SANDBOX, STORYBOARD_CODEX_DRY_RUN=1');
  process.exit(2);
}

function walkImages(dir, sinceMs, out) {
  if (!fs.existsSync(dir)) return;
  var entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.forEach(function(entry) {
    var filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkImages(filePath, sinceMs, out);
      return;
    }
    if (!entry.isFile() || !/\.(png|jpg|jpeg|webp)$/i.test(entry.name)) return;
    try {
      var stat = fs.statSync(filePath);
      if (stat.mtimeMs >= sinceMs - 1000) out.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (e) {}
  });
}

function newestGeneratedImage(sinceMs) {
  var codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  var root = path.join(codexHome, 'generated_images');
  var images = [];
  walkImages(root, sinceMs, images);
  images.sort(function(a, b) {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.size - a.size;
  });
  return images[0] && images[0].path || '';
}

function buildCodexExecEnv() {
  var cleanEnv = Object.assign({}, process.env);
  [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT',
    'CODEX_API_KEY',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ].forEach(function(name) {
    delete cleanEnv[name];
  });
  cleanEnv.HOME = cleanEnv.HOME || '/root';
  cleanEnv.USER = cleanEnv.USER || 'root';
  cleanEnv.LOGNAME = cleanEnv.LOGNAME || 'root';
  cleanEnv.CODEX_HOME = cleanEnv.CODEX_HOME || path.join(cleanEnv.HOME, '.codex');
  return cleanEnv;
}

async function normalizeImage(inputPath, outputPath) {
  await sharp(inputPath)
    .resize(1536, 864, { fit: 'cover', position: 'center' })
    .png()
    .toFile(outputPath);
}

async function dryRunImage(prompt, outputPath) {
  var title = stringValue(process.env.STORYBOARD_PHASE_TITLE || process.env.STORYBOARD_PHASE_ID || 'phase');
  var svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864" viewBox="0 0 1536 864">',
    '<rect width="1536" height="864" fill="#eef5ff"/>',
    '<rect x="72" y="70" width="1392" height="724" fill="#ffffff" stroke="#2563eb" stroke-width="8"/>',
    '<text x="128" y="172" font-size="68" font-weight="800" fill="#1e3a8a">' + escapeXml(title) + '</text>',
    '<text x="128" y="276" font-size="34" fill="#334155">' + escapeXml(prompt.slice(0, 260)) + '</text>',
    '<text x="128" y="740" font-size="28" fill="#64748b">Codex image provider dry run</text>',
    '</svg>',
  ].join('\n');
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

function buildCodexPrompt(visualPrompt, outputPath) {
  var title = stringValue(process.env.STORYBOARD_PHASE_TITLE);
  var index = stringValue(process.env.STORYBOARD_PHASE_INDEX);
  var count = stringValue(process.env.STORYBOARD_PHASE_COUNT);
  var phaseLabel = index && count ? ('Phase ' + index + '/' + count) : stringValue(process.env.STORYBOARD_PHASE_ID || 'Phase');
  return [
    '$imagegen',
    '',
    'Generate exactly one polished 16:9 PNG storyboard frame for an internal mobile playable-ad PDF.',
    'Use case: stylized-concept',
    'Asset type: customer storyboard phase image',
    'Phase: ' + phaseLabel + (title ? ' - ' + title : ''),
    '',
    'Hard requirements:',
    '- The image must look like a playable ad gameplay screenshot, not a poster.',
    '- Show the key player action, target object, result feedback, and UI guidance from the prompt.',
    '- Keep UI readable and simple. Do not add unrelated characters, logos, watermarks, or extra gameplay.',
    '- Horizontal 16:9 composition.',
    '',
    'Storyboard prompt:',
    visualPrompt,
    '',
    'Output handling:',
    '- Save or copy the final generated PNG exactly to: ' + outputPath,
    '- Do not edit repository files.',
    '- If the image generation tool saves the file under CODEX_HOME/generated_images, copy that generated PNG to the exact output path.',
    '- End with JSON only: {"success":true,"output":"' + outputPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"}',
  ].join('\n');
}

async function main() {
  var promptFile = stringValue(process.env.STORYBOARD_PHASE_PROMPT_FILE);
  var outputPath = stringValue(process.env.STORYBOARD_PHASE_OUTPUT);
  if (!promptFile || !outputPath) usage();
  var visualPrompt = fs.readFileSync(promptFile, 'utf8');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (envFlag('STORYBOARD_CODEX_DRY_RUN')) {
    await dryRunImage(visualPrompt, outputPath);
    console.log(JSON.stringify({ success: true, mode: 'dry_run', output: outputPath, model: 'codex-dry-run' }));
    return;
  }

  var codexBin = stringValue(process.env.CODEX_BIN) || 'codex';
  var timeoutMs = Number(process.env.STORYBOARD_CODEX_TIMEOUT_MS || 900000);
  var sandbox = stringValue(process.env.STORYBOARD_CODEX_SANDBOX) || 'danger-full-access';
  var startedAt = Date.now();
  var finalMessagePath = path.join(os.tmpdir(), 'storyboard_codex_image_' + process.pid + '_' + Date.now() + '.txt');
  var codexPrompt = buildCodexPrompt(visualPrompt, outputPath);
  var args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox', sandbox,
    '--cd', path.resolve(__dirname, '..'),
    '--output-last-message', finalMessagePath,
    codexPrompt,
  ];
  var result = childProcess.spawnSync(codexBin, args, {
    cwd: path.resolve(__dirname, '..'),
    env: buildCodexExecEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 80 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    var failureText = String(result.stderr || result.stdout || '').slice(-1600);
    if (/401|unauthor|authentication|auth_failed|failed to connect to websocket/i.test(failureText)) {
      throw new Error('Codex image worker auth failed after stripping API env; run `codex exec --skip-git-repo-check "Return ok"` on the server or refresh `/root/.codex/auth.json`. Detail: ' + failureText);
    }
    throw new Error('Codex image worker failed: exit=' + result.status + ' ' + failureText);
  }

  var sourcePath = fs.existsSync(outputPath) ? outputPath : newestGeneratedImage(startedAt);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    var finalText = '';
    try { finalText = fs.readFileSync(finalMessagePath, 'utf8'); } catch (e) {}
    throw new Error('Codex image worker completed but no generated image was found. ' + finalText.slice(0, 500));
  }

  var tmpPath = outputPath + '.codex-normalized-' + process.pid + '.png';
  await normalizeImage(sourcePath, tmpPath);
  fs.renameSync(tmpPath, outputPath);
  console.log(JSON.stringify({
    success: true,
    mode: 'codex-imagegen',
    output: outputPath,
    source: sourcePath,
    bytes: fs.statSync(outputPath).size,
  }));
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
