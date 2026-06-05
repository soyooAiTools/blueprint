'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seed-2-0-pro-260215';
const DEFAULT_FPS = 4;
const DEFAULT_TIMEOUT_MS = 180000;

const ISSUE_TYPES = [
  'movement_jump',
  'movement_not_continuous',
  'label_opposite_direction',
  'label_not_above_head',
  'label_far_from_entity',
  'touch_unresponsive',
  'inconclusive',
];

function loadDotenv() {
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  } catch(e) {}
  try {
    require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
  } catch(e) {}
}

function getApiKey(options) {
  options = options || {};
  return options.apiKey || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '';
}

function getBaseUrl(options) {
  options = options || {};
  return (options.baseUrl || process.env.ARK_BASE_URL || process.env.DOUBAO_API_BASE || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function getVideoAuditModel(options) {
  options = options || {};
  return options.model ||
    process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_MODEL ||
    process.env.DOUBAO_VIDEO_AUDIT_MODEL ||
    process.env.DOUBAO_VIDEO_MODEL ||
    DEFAULT_MODEL;
}

function getVideoAuditFps(options) {
  options = options || {};
  var raw = options.fps != null ? options.fps : process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_FPS;
  var fps = Number(raw);
  if (!Number.isFinite(fps) || fps <= 0) fps = DEFAULT_FPS;
  return Math.max(0.2, Math.min(8, fps));
}

function hasVolcengineVideoAuditCredentials(options) {
  loadDotenv();
  return !!getApiKey(options || {});
}

function buildVideoAuditPrompt(extraContext) {
  extraContext = extraContext ? String(extraContext).trim() : '';
  return [
    '你是试玩广告的运动视觉审核员。请完整观看视频，重点审核虚拟摇杆控制人物移动和实体 label 锚定。',
    '',
    '必须检查的问题：',
    '1. 人物移动是否连续、丝滑；不能出现明显瞬移、单帧大位移、拖动后跳到很远处。',
    '2. 上/下/左/右移动时，人物头顶 label 是否跟随同方向移动；如果人物朝上，label 不能朝下漂移；人物朝下，label 不能朝上漂移。',
    '3. 所有可见实体的 label 是否在对应实体头顶附近；不能离头顶很远、横向明显错位、贴到其他实体上。',
    '4. 触控/摇杆是否真实响应；如果用户在拖摇杆但人物不动或延迟很大，也算失败。',
    '',
    '判断原则：',
    '- 如果视频分辨率、遮挡或时长导致无法确认，返回 inconclusive，passed 必须为 false。',
    '- 不要只描述画面，要给出能定位问题的时间段和证据。',
    '- 如果有多个实体 label，只要任意一个明显不在对应实体头顶，就要报 label_not_above_head 或 label_far_from_entity。',
    '- 如果人物与 label 的垂直移动方向相反，必须报 label_opposite_direction。',
    '',
    '只输出 JSON，不要输出 Markdown。JSON 结构必须是：',
    '{',
    '  "passed": false,',
    '  "summary": "一句话总结",',
    '  "issues": [',
    '    {',
    '      "type": "movement_jump|movement_not_continuous|label_opposite_direction|label_not_above_head|label_far_from_entity|touch_unresponsive|inconclusive",',
    '      "severity": "blocker|major|minor",',
    '      "time_range": "HH:mm:ss-HH:mm:ss",',
    '      "entity": "Player 或实体名；未知则填 unknown",',
    '      "evidence": "具体观察证据",',
    '      "confidence": 0.0',
    '    }',
    '  ]',
    '}',
    extraContext ? '\n额外上下文：\n' + extraContext : '',
  ].join('\n');
}

function buildResponsesRequest(fileId, options) {
  options = options || {};
  if (!fileId) throw new Error('fileId is required');
  return {
    model: getVideoAuditModel(options),
    temperature: options.temperature != null ? options.temperature : 0,
    max_output_tokens: options.maxOutputTokens || 4096,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_video',
            file_id: fileId,
          },
          {
            type: 'input_text',
            text: buildVideoAuditPrompt(options.context || options.extraContext || ''),
          },
        ],
      },
    ],
  };
}

function arkRequest(method, apiPath, body, options) {
  options = options || {};
  var apiKey = getApiKey(options);
  if (!apiKey) return Promise.reject(new Error('MODEL_FATAL: ARK_API_KEY or DOUBAO_API_KEY is required for Volcengine video audit'));

  return new Promise(function(resolve, reject) {
    var endpoint = new URL(getBaseUrl(options) + apiPath);
    var headers = {
      Authorization: 'Bearer ' + apiKey,
    };
    var bodyData = null;
    if (body instanceof Buffer) {
      bodyData = body;
      headers['Content-Type'] = options.contentType;
      headers['Content-Length'] = body.length;
    } else if (body != null) {
      bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = options.contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    var req = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: endpoint.pathname + endpoint.search,
      method: method,
      headers: headers,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks).toString();
        var parsed;
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch(e) {
          return reject(new Error('Volcengine API response parse error: ' + e.message + ' body=' + raw.slice(0, 300)));
        }
        if (parsed.error) {
          var message = parsed.error.message || JSON.stringify(parsed.error);
          var fatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(message);
          return reject(new Error((fatal ? 'MODEL_FATAL: ' : '') + 'Volcengine API: ' + message));
        }
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error('Volcengine API: HTTP ' + res.statusCode + ' ' + raw.slice(0, 300)));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', function() {
      req.destroy(new Error('Volcengine API timeout after ' + (options.timeoutMs || DEFAULT_TIMEOUT_MS) + 'ms'));
    });
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function uploadVideo(videoPath, options) {
  options = options || {};
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error('video file not found: ' + videoPath);

  var boundary = '----VolcVideoAudit' + Date.now();
  var fileName = path.basename(videoPath);
  var videoData = fs.readFileSync(videoPath);
  var fps = getVideoAuditFps(options);
  var mime = /\.webm$/i.test(fileName) ? 'video/webm' : /\.mov$/i.test(fileName) ? 'video/mov' : 'video/mp4';

  var fields = [
    '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="purpose"\r\n\r\n' +
      'user_data\r\n',
    '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="preprocess_configs[video][fps]"\r\n\r\n' +
      String(fps) + '\r\n',
  ];
  if (options.modelForUpload) {
    fields.push(
      '--' + boundary + '\r\n' +
        'Content-Disposition: form-data; name="model"\r\n\r\n' +
        String(options.modelForUpload) + '\r\n'
    );
  }
  fields.push(
    '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + fileName.replace(/"/g, '') + '"\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n'
  );

  var body = Buffer.concat([
    Buffer.from(fields.join('')),
    videoData,
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  var result = await arkRequest('POST', '/files', body, Object.assign({}, options, {
    contentType: 'multipart/form-data; boundary=' + boundary,
  }));
  if (!result.id) throw new Error('Volcengine file upload returned no file id: ' + JSON.stringify(result).slice(0, 300));
  return result;
}

function prepareVideoForUpload(videoPath, options) {
  options = options || {};
  if (options.skipPreprocess || /\.mp4$/i.test(videoPath)) {
    return Promise.resolve({ videoPath: videoPath, cleanupPath: null });
  }
  var outDir = options.tmpDir || path.dirname(videoPath);
  var outPath = path.join(outDir, path.basename(videoPath).replace(/\.[^.]+$/, '') + '.volc-audit.mp4');
  var maxDuration = Number(options.maxDurationSeconds || process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_MAX_SECONDS || 30);
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) maxDuration = 30;
  return new Promise(function(resolve, reject) {
    execFile('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-t', String(Math.min(maxDuration, 120)),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-pix_fmt', 'yuv420p',
      '-an',
      outPath,
    ], { timeout: 180000 }, function(err) {
      if (err) return reject(new Error('ffmpeg video audit preprocess failed: ' + err.message));
      resolve({ videoPath: outPath, cleanupPath: outPath });
    });
  });
}

async function waitForFileProcessing(fileId, options) {
  options = options || {};
  var deadline = Date.now() + (options.processingTimeoutMs || 180000);
  var last = null;
  while (Date.now() < deadline) {
    last = await arkRequest('GET', '/files/' + encodeURIComponent(fileId), null, options);
    var status = String(last.status || '').toLowerCase();
    if (!status || status === 'active' || status === 'processed' || status === 'succeeded' || status === 'success' || status === 'ready') return last;
    if (status === 'failed' || status === 'error') throw new Error('Volcengine file processing failed: ' + JSON.stringify(last).slice(0, 300));
    await new Promise(function(resolve) { setTimeout(resolve, options.pollIntervalMs || 3000); });
  }
  throw new Error('Volcengine file processing timeout for ' + fileId + ': ' + JSON.stringify(last || {}).slice(0, 300));
}

function extractResponseText(response) {
  var text = '';
  if (response && Array.isArray(response.output)) {
    response.output.forEach(function(item) {
      if (!item) return;
      if (typeof item.content === 'string') text += item.content;
      if (Array.isArray(item.content)) {
        item.content.forEach(function(content) {
          if (!content) return;
          if (content.type === 'output_text' || content.type === 'text') text += content.text || '';
        });
      }
    });
  }
  if (!text && response && Array.isArray(response.choices) && response.choices[0]) {
    var msg = response.choices[0].message || {};
    text = typeof msg.content === 'string' ? msg.content : '';
  }
  if (!text && response && typeof response.output_text === 'string') text = response.output_text;
  return text.trim();
}

function extractJsonObject(text) {
  text = String(text || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!text) throw new Error('empty video audit response');
  if (text[0] === '{') return text;
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  throw new Error('video audit response did not contain JSON object');
}

function normalizeIssue(issue) {
  issue = issue || {};
  var type = ISSUE_TYPES.indexOf(issue.type) >= 0 ? issue.type : 'inconclusive';
  var severity = /^(blocker|major|minor)$/.test(String(issue.severity || '')) ? issue.severity : (type === 'inconclusive' ? 'major' : 'major');
  var confidence = Number(issue.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    type: type,
    severity: severity,
    time_range: String(issue.time_range || issue.timeRange || 'unknown'),
    entity: String(issue.entity || 'unknown'),
    evidence: String(issue.evidence || '').slice(0, 1000),
    confidence: confidence,
  };
}

function normalizeAuditResult(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('video audit JSON must be an object');
  var issues = Array.isArray(raw.issues) ? raw.issues.map(normalizeIssue) : [];
  var blocking = issues.some(function(issue) {
    return issue.severity === 'blocker' || issue.severity === 'major' || issue.type === 'inconclusive';
  });
  return {
    passed: raw.passed === true && !blocking,
    summary: String(raw.summary || '').slice(0, 1000),
    issues: issues,
    rawPassed: raw.passed === true,
  };
}

function parseVideoAuditResponse(response) {
  var text = typeof response === 'string' ? response : extractResponseText(response);
  var jsonText = extractJsonObject(text);
  return normalizeAuditResult(JSON.parse(jsonText));
}

async function analyzeUploadedVideo(fileId, options) {
  var requestBody = buildResponsesRequest(fileId, options);
  var response = await arkRequest('POST', '/responses', requestBody, Object.assign({}, options, {
    contentType: 'application/json',
  }));
  return Object.assign(parseVideoAuditResponse(response), {
    model: requestBody.model,
    fileId: fileId,
    usage: response.usage || null,
  });
}

async function runVolcengineVideoAudit(videoPath, options) {
  options = options || {};
  loadDotenv();
  var prepared = await prepareVideoForUpload(videoPath, options);
  try {
    var upload = await uploadVideo(prepared.videoPath, options);
    await waitForFileProcessing(upload.id, options);
    var audit = await analyzeUploadedVideo(upload.id, options);
    audit.videoPath = prepared.videoPath;
    audit.originalVideoPath = videoPath;
    audit.fps = getVideoAuditFps(options);
    return audit;
  } finally {
    if (prepared.cleanupPath && !options.keepPreparedVideo) {
      try { fs.unlinkSync(prepared.cleanupPath); } catch(e) {}
    }
  }
}

function parseArgs(argv) {
  var args = { _: [] };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--video' || arg === '-v') args.video = argv[++i];
    else if (arg === '--output' || arg === '-o') args.output = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--fps') args.fps = Number(argv[++i]);
    else if (arg === '--context') args.context = argv[++i];
    else args._.push(arg);
  }
  if (!args.video && args._[0]) args.video = args._[0];
  return args;
}

async function main() {
  var args = parseArgs(process.argv.slice(2));
  if (!args.video) {
    console.error('Usage: node worker/volcengine-video-audit.cjs --video <recording.mp4|webm> [--model doubao-seed-2-0-pro-260215] [--fps 4] [--output result.json]');
    process.exit(2);
  }
  var result = await runVolcengineVideoAudit(args.video, args);
  var json = JSON.stringify(result, null, 2);
  if (args.output) {
    fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, json, 'utf8');
    console.log('[volc-video-audit] result saved:', args.output);
  } else {
    console.log(json);
  }
  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(function(err) {
    console.error('[volc-video-audit] ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_FPS,
  ISSUE_TYPES,
  buildVideoAuditPrompt,
  buildResponsesRequest,
  hasVolcengineVideoAuditCredentials,
  extractResponseText,
  extractJsonObject,
  normalizeAuditResult,
  parseVideoAuditResponse,
  runVolcengineVideoAudit,
  prepareVideoForUpload,
  uploadVideo,
  waitForFileProcessing,
  analyzeUploadedVideo,
};
