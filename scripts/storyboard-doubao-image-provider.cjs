#!/usr/bin/env node
'use strict';

var fs = require('fs');
var http = require('http');
var https = require('https');
var path = require('path');
var sharp = require('sharp');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
} catch (e) {}

var DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
var DEFAULT_MODEL = 'doubao-seedream-5-0-260128';
var DEFAULT_SIZE = '2560x1440';

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
  console.error('Usage: STORYBOARD_PHASE_PROMPT_FILE=<prompt> STORYBOARD_PHASE_OUTPUT=<out.png> node scripts/storyboard-doubao-image-provider.cjs');
  console.error('Optional env: DOUBAO_API_KEY, ARK_API_KEY, DOUBAO_IMAGE_MODEL, DOUBAO_IMAGE_SIZE, STORYBOARD_DOUBAO_DRY_RUN=1');
  process.exit(2);
}

function requestJson(url, apiKey, payload, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var urlObj = new URL(url);
    var transport = urlObj.protocol === 'http:' ? http : https;
    var req = transport.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'http:' ? 80 : 443),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8');
        var json = null;
        try { json = text ? JSON.parse(text) : {}; } catch (e) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('Doubao image API HTTP ' + res.statusCode + ': ' + (json && json.error && json.error.message || text.slice(0, 500))));
          return;
        }
        if (!json) {
          reject(new Error('Doubao image API returned non-JSON response: ' + text.slice(0, 200)));
          return;
        }
        if (json.error) {
          reject(new Error('Doubao image API error: ' + (json.error.message || JSON.stringify(json.error))));
          return;
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy(new Error('Doubao image API timeout after ' + timeoutMs + 'ms'));
    });
    req.write(body);
    req.end();
  });
}

function fetchBytes(url, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(url);
    var transport = urlObj.protocol === 'http:' ? http : https;
    var req = transport.get(urlObj, { timeout: timeoutMs }, function(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchBytes(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('image url returned HTTP ' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
    });
    req.on('error', reject);
    req.on('timeout', function() {
      req.destroy(new Error('image url timeout after ' + timeoutMs + 'ms'));
    });
  });
}

function parseDataUrl(url) {
  var match = /^data:([^;,]+)?;base64,(.+)$/i.exec(String(url || ''));
  if (!match) return null;
  return Buffer.from(match[2], 'base64');
}

async function extractImageBytes(response, timeoutMs) {
  var first = response && response.data && response.data[0] || {};
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first.url) {
    var dataBytes = parseDataUrl(first.url);
    return dataBytes || fetchBytes(first.url, timeoutMs);
  }
  if (first.image_url && first.image_url.url) {
    var imageUrlBytes = parseDataUrl(first.image_url.url);
    return imageUrlBytes || fetchBytes(first.image_url.url, timeoutMs);
  }
  if (typeof first === 'string') {
    var stringBytes = parseDataUrl(first);
    if (stringBytes) return stringBytes;
  }
  throw new Error('Doubao image response did not include b64_json or url');
}

function buildProviderPrompt(prompt) {
  var title = stringValue(process.env.STORYBOARD_PHASE_TITLE);
  var index = stringValue(process.env.STORYBOARD_PHASE_INDEX);
  var count = stringValue(process.env.STORYBOARD_PHASE_COUNT);
  var prefix = [
    '请生成一张横版试玩广告客户确认分镜图。',
    '画面必须准确表达分镜语义，包含关键玩法对象、玩家动作、结果反馈和必要 UI 引导。',
    '不要做营销海报，不要添加无关角色、无关文案或不在需求中的玩法。',
    '视觉要求：清晰可读，适合放入 PDF 的单格画面，16:9 构图。',
  ];
  if (title) prefix.push('当前画面标题：' + title);
  if (index && count) prefix.push('当前序号：Phase ' + index + '/' + count);
  return prefix.join('\n') + '\n\n' + prompt;
}

async function dryRunImage(prompt, outputPath) {
  var title = stringValue(process.env.STORYBOARD_PHASE_TITLE || process.env.STORYBOARD_PHASE_ID || 'phase');
  var svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="864" viewBox="0 0 1536 864">',
    '<rect width="1536" height="864" fill="#edf7f2"/>',
    '<rect x="78" y="74" width="1380" height="716" rx="0" fill="#ffffff" stroke="#15803d" stroke-width="8"/>',
    '<text x="130" y="178" font-size="68" font-weight="800" fill="#14532d">' + escapeXml(title) + '</text>',
    '<text x="130" y="278" font-size="34" fill="#334155">' + escapeXml(prompt.slice(0, 260)) + '</text>',
    '<text x="130" y="738" font-size="28" fill="#64748b">Doubao image provider dry run</text>',
    '</svg>',
  ].join('\n');
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function main() {
  var promptFile = stringValue(process.env.STORYBOARD_PHASE_PROMPT_FILE);
  var outputPath = stringValue(process.env.STORYBOARD_PHASE_OUTPUT);
  if (!promptFile || !outputPath) usage();
  var rawPrompt = fs.readFileSync(promptFile, 'utf8');
  var prompt = buildProviderPrompt(rawPrompt).slice(0, Number(process.env.STORYBOARD_DOUBAO_PROMPT_LIMIT || 32000));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (envFlag('STORYBOARD_DOUBAO_DRY_RUN')) {
    await dryRunImage(prompt, outputPath);
    console.log(JSON.stringify({ success: true, mode: 'dry_run', output: outputPath, model: 'dry-run' }));
    return;
  }

  var apiKey = stringValue(process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || process.env.VOLCANO_ENGINE_API_KEY);
  if (!apiKey) throw new Error('DOUBAO_API_KEY is required unless STORYBOARD_DOUBAO_DRY_RUN=1');
  var baseUrl = stringValue(process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL) || DEFAULT_BASE_URL;
  var model = stringValue(process.env.STORYBOARD_DOUBAO_IMAGE_MODEL || process.env.DOUBAO_IMAGE_MODEL) || DEFAULT_MODEL;
  var size = stringValue(process.env.STORYBOARD_DOUBAO_IMAGE_SIZE || process.env.DOUBAO_IMAGE_SIZE) || DEFAULT_SIZE;
  var timeoutMs = Number(process.env.STORYBOARD_DOUBAO_IMAGE_TIMEOUT_MS || 300000);
  var payload = {
    model: model,
    prompt: prompt,
    size: size,
    response_format: stringValue(process.env.STORYBOARD_DOUBAO_RESPONSE_FORMAT) || 'b64_json',
    watermark: envFlag('STORYBOARD_DOUBAO_WATERMARK'),
  };
  if (process.env.STORYBOARD_DOUBAO_SEED) payload.seed = Number(process.env.STORYBOARD_DOUBAO_SEED);
  if (process.env.STORYBOARD_DOUBAO_SEQUENTIAL) payload.sequential_image_generation = stringValue(process.env.STORYBOARD_DOUBAO_SEQUENTIAL);
  if (process.env.STORYBOARD_DOUBAO_OUTPUT_FORMAT) payload.output_format = stringValue(process.env.STORYBOARD_DOUBAO_OUTPUT_FORMAT);

  var url = baseUrl.replace(/\/+$/, '') + '/images/generations';
  var response = await requestJson(url, apiKey, payload, timeoutMs);
  var bytes = await extractImageBytes(response, timeoutMs);
  await sharp(bytes)
    .resize(1536, 864, { fit: 'cover', position: 'center' })
    .png()
    .toFile(outputPath);
  console.log(JSON.stringify({
    success: true,
    mode: 'generate',
    output: outputPath,
    model: model,
    size: size,
    bytes: bytes.length,
  }));
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err && err.message || err);
    process.exit(1);
  });
}
