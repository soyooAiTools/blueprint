'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Doubao (豆包) API for video understanding
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY || '';
const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DOUBAO_VIDEO_MODEL = process.env.DOUBAO_VIDEO_MODEL || 'doubao-seed-2-0-pro-260215';

const BLUEPRINT_PROMPT = `You are a game flow analyst. Analyze this gameplay video and extract a structured blueprint for recreating the game as a playable ad.

## Step 1: Observe — What do you see?
List ALL visible game objects: characters, obstacles, UI elements, background items, ground/platforms.
For each object identify:
- A descriptive name (English, PascalCase, e.g. "Player", "RedObstacle", "ScoreText")
- Shape type: ONLY one of: Cube, Sphere, Cylinder, Ground, UI
- Approximate color
- When it first appears (which phase)

## Step 2: Understand — What happens?
Identify the game flow:
- How many distinct phases/stages are there? (MUST be 8-12)
- What player interaction is used? (none, tap, swipe, drag, virtualJoystick)
- What triggers transitions between phases? (time, collision, tap, distance, score)
- What actions happen in each phase? (show/hide objects, move, animate, score changes)

## Step 3: Structure — Output the blueprint
Output a JSON object with this EXACT structure:

{
  "objectRegistry": [
    {
      "name": "UniqueObjectName",
      "shape": "Cube|Sphere|Cylinder|Ground|UI",
      "scale": [1, 1, 1],
      "color": "red|blue|green|yellow|white|gray|brown|orange|purple|black",
      "rgb": "#FF0000",
      "initiallyVisible": true,
      "firstStep": 0
    }
  ],
  "nodes": [
    {
      "id": "shot_0",
      "type": "shotNode",
      "position": {"x": 0, "y": 200},
      "data": {
        "label": "Phase Name",
        "description": "What happens in this phase",
        "sceneObjects": [
          {
            "name": "ObjectName",
            "position": [0, 1, 0],
            "visible": true,
            "actions": ["idle"]
          }
        ],
        "inputType": "none|tap|swipe|drag|virtualJoystick",
        "triggerChain": [
          {
            "event": "start|tap|collision|timer",
            "actions": [
              {"type": "show|hide|move|animate|score", "target": "ObjectName"}
            ]
          }
        ],
        "endCondition": {
          "type": "time|input|collision|distance|score",
          "value": 3,
          "description": "Human-readable condition"
        }
      }
    }
  ],
  "edges": [
    {"id": "e_0_1", "source": "shot_0", "target": "shot_1"}
  ]
}

## CRITICAL RULES:
1. You MUST output exactly 8-12 shotNode nodes. No fewer than 8.
2. Node IDs MUST be shot_0, shot_1, shot_2, ... in order.
3. The LAST shotNode MUST be a CTA (call-to-action) with these EXACT trigger actions:
   {"type": "call", "method": "Luna.Unity.LifeCycle.GameEnded()"}
   {"type": "show", "target": "CTAButton"}
   {"type": "on_click", "target": "CTAButton", "action": "Luna.Unity.Playable.InstallFullGame()"}
4. objectRegistry shapes MUST be one of: Cube, Sphere, Cylinder, Ground, UI
5. objectRegistry MUST include a "CTAButton" with shape "UI" and initiallyVisible false
6. edges connect adjacent nodes sequentially: shot_0→shot_1→shot_2→...
7. position.x = index * 300, position.y = 200 for all nodes
8. Each object in objectRegistry must have a unique name
9. All object names referenced in nodes must exist in objectRegistry

Output ONLY the JSON object, no other text.`;

/**
 * Get video metadata (duration, resolution) via ffprobe.
 * @param {string} videoPath
 * @returns {Promise<{duration: number, width: number, height: number}>}
 */
function getVideoInfo(videoPath) {
  return new Promise(function(resolve, reject) {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format', '-show_streams',
      videoPath
    ], function(err, stdout) {
      if (err) return reject(new Error('ffprobe failed: ' + err.message));
      try {
        var info = JSON.parse(stdout);
        var vs = (info.streams || []).find(function(s) { return s.codec_type === 'video'; });
        resolve({
          duration: parseFloat(info.format.duration) || 0,
          width: vs ? vs.width : 0,
          height: vs ? vs.height : 0,
        });
      } catch(e) { reject(new Error('ffprobe parse failed: ' + e.message)); }
    });
  });
}

/**
 * Preprocess video: truncate to maxDuration, convert to mp4.
 * @param {string} inputPath - Raw uploaded video
 * @param {string} outputPath - Processed mp4 path
 * @param {number} maxDuration - Max seconds (default 60)
 * @returns {Promise<string>} outputPath
 */
function preprocessVideo(inputPath, outputPath, maxDuration) {
  maxDuration = maxDuration || 60;
  return new Promise(function(resolve, reject) {
    var args = ['-y', '-i', inputPath, '-t', String(maxDuration), '-c:v', 'libx264', '-preset', 'fast', '-an', outputPath];
    execFile('ffmpeg', args, { timeout: 120000 }, function(err) {
      if (err) return reject(new Error('ffmpeg preprocess failed: ' + err.message));
      resolve(outputPath);
    });
  });
}

/**
 * Extract evenly-spaced keyframes from video.
 * @param {string} videoPath
 * @param {string} outDir - Directory to save frame_1.jpg ... frame_N.jpg
 * @param {number} count - Number of frames (default 8)
 * @param {number} duration - Video duration in seconds
 * @returns {Promise<string[]>} Array of frame filenames
 */
function extractFrames(videoPath, outDir, count, duration) {
  count = count || 8;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  var interval = duration / (count + 1);
  var promises = [];
  var filenames = [];

  for (var i = 1; i <= count; i++) {
    (function(idx) {
      var timestamp = (interval * idx).toFixed(2);
      var filename = 'frame_' + idx + '.jpg';
      var outPath = path.join(outDir, filename);
      filenames.push(filename);
      promises.push(new Promise(function(resolve, reject) {
        execFile('ffmpeg', [
          '-y', '-ss', timestamp, '-i', videoPath,
          '-frames:v', '1', '-q:v', '2', outPath
        ], { timeout: 30000 }, function(err) {
          if (err) return reject(new Error('Frame extract failed at ' + timestamp + 's: ' + err.message));
          resolve();
        });
      }));
    })(i);
  }

  return Promise.all(promises).then(function() { return filenames; });
}

/**
 * Extract a single thumbnail from the first second.
 * @param {string} videoPath
 * @param {string} outPath
 * @returns {Promise<void>}
 */
function extractThumbnail(videoPath, outPath) {
  return new Promise(function(resolve, reject) {
    execFile('ffmpeg', [
      '-y', '-ss', '1', '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', outPath
    ], { timeout: 15000 }, function(err) {
      if (err) return reject(new Error('Thumbnail extract failed: ' + err.message));
      resolve();
    });
  });
}

// ────────────── Doubao API helpers ──────────────

/**
 * Make an HTTPS request to Doubao API (direct, no proxy).
 */
function _doubaoRequest(method, apiPath, body, contentType) {
  return new Promise(function(resolve, reject) {
    var urlObj = new URL(DOUBAO_BASE + apiPath);
    var headers = {
      'Authorization': 'Bearer ' + DOUBAO_API_KEY,
    };
    var bodyData;
    if (body instanceof Buffer) {
      // multipart — contentType already includes boundary
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = body.length;
      bodyData = body;
    } else if (body) {
      bodyData = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    // Direct connection (bypass proxy for domestic API)
    var prevHttps = process.env.HTTPS_PROXY;
    var prevHttp = process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;

    var req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: headers,
      timeout: 180000,
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        if (prevHttps) process.env.HTTPS_PROXY = prevHttps;
        if (prevHttp) process.env.HTTP_PROXY = prevHttp;
        var raw = Buffer.concat(chunks).toString();
        try {
          resolve(JSON.parse(raw));
        } catch(e) {
          reject(new Error('Doubao response parse error: ' + e.message + ' body=' + raw.substring(0, 300)));
        }
      });
    });
    req.on('error', function(e) {
      if (prevHttps) process.env.HTTPS_PROXY = prevHttps;
      if (prevHttp) process.env.HTTP_PROXY = prevHttp;
      reject(new Error('Doubao request error: ' + e.message));
    });
    req.on('timeout', function() {
      req.destroy();
      reject(new Error('Doubao API timeout'));
    });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

/**
 * Upload video to Doubao Files API and wait for processing.
 * @param {string} videoPath - Path to mp4 file
 * @returns {Promise<string>} file_id for use in Responses API
 */
async function uploadVideo(videoPath) {
  console.log('[video-to-blueprint] Uploading video to Doubao Files API...');

  // Build multipart/form-data manually
  var boundary = '----DoubaoUpload' + Date.now();
  var videoData = fs.readFileSync(videoPath);
  var fileName = path.basename(videoPath);

  var parts = [];
  // purpose field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="purpose"\r\n\r\n' +
    'user_data\r\n'
  );
  // video fps preprocessing config
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="preprocess_configs[video][fps]"\r\n\r\n' +
    '0.5\r\n'
  );
  // file field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + fileName + '"\r\n' +
    'Content-Type: video/mp4\r\n\r\n'
  );

  var preamble = Buffer.from(parts.join(''));
  var epilogue = Buffer.from('\r\n--' + boundary + '--\r\n');
  var fullBody = Buffer.concat([preamble, videoData, epilogue]);

  var contentType = 'multipart/form-data; boundary=' + boundary;

  var result = await _doubaoRequest('POST', '/files', fullBody, contentType);

  if (result.error) {
    throw new Error('Doubao file upload error: ' + (result.error.message || JSON.stringify(result.error)));
  }

  var fileId = result.id;
  if (!fileId) {
    throw new Error('Doubao file upload: no file id returned: ' + JSON.stringify(result).substring(0, 300));
  }

  // Wait for file to be processed (poll status)
  var maxWait = 120; // seconds
  var waited = 0;
  var status = result.status || 'uploaded';
  while (status === 'uploaded' || status === 'processing' || status === 'pending') {
    if (waited >= maxWait) throw new Error('Doubao file processing timeout (' + maxWait + 's)');
    await new Promise(function(r) { setTimeout(r, 3000); });
    waited += 3;
    try {
      var check = await _doubaoRequest('GET', '/files/' + fileId, null, null);
      status = check.status || 'processed';
      if (check.error) {
        throw new Error('File status check error: ' + JSON.stringify(check.error));
      }
    } catch(e) {
      console.warn('[video-to-blueprint] File status check failed: ' + e.message);
    }
    process.stdout.write('.');
  }

  console.log('\n[video-to-blueprint] Video uploaded, file_id=' + fileId);
  return fileId;
}

/**
 * Call Doubao Responses API to analyze video and output blueprint JSON.
 * @param {string} fileId - Doubao file_id from uploadVideo
 * @param {number} temperature
 * @returns {Promise<object>} Raw parsed JSON from Doubao
 */
async function analyzeVideo(fileId, temperature) {
  temperature = temperature || 0.2;
  console.log('[video-to-blueprint] Analyzing video via Doubao (temp=' + temperature + ')...');

  var requestBody = {
    model: DOUBAO_VIDEO_MODEL,
    temperature: temperature,
    max_output_tokens: 65536,
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
            text: BLUEPRINT_PROMPT,
          }
        ]
      }
    ]
  };

  var result = await _doubaoRequest('POST', '/responses', requestBody, 'application/json');

  if (result.error) {
    throw new Error('Doubao video analysis error: ' + (result.error.message || JSON.stringify(result.error)));
  }

  // Extract text from Responses API output
  var text = '';
  if (result.output) {
    // Responses API format: output is array of message items
    var outputItems = Array.isArray(result.output) ? result.output : [];
    for (var i = 0; i < outputItems.length; i++) {
      var item = outputItems[i];
      if (item.type === 'message' && item.content) {
        var contentArr = Array.isArray(item.content) ? item.content : [];
        for (var j = 0; j < contentArr.length; j++) {
          if (contentArr[j].type === 'output_text') {
            text += contentArr[j].text || '';
          }
        }
      }
    }
  }
  if (!text && result.choices && result.choices[0]) {
    // Fallback: Chat API format
    text = result.choices[0].message ? result.choices[0].message.content : '';
  }
  if (!text) {
    throw new Error('Doubao returned empty response: ' + JSON.stringify(result).substring(0, 500));
  }

  // Strip markdown code fences if present
  text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

const VALID_SHAPES = ['Cube', 'Sphere', 'Cylinder', 'Ground', 'UI'];

/**
 * Validate and fix blueprint JSON from LLM.
 * @param {object} raw - Raw blueprint from LLM
 * @returns {object} Fixed blueprint
 * @throws {Error} If blueprint is unfixable
 */
function validateBlueprint(raw) {
  var bp = raw;

  // Ensure objectRegistry exists and is non-empty
  if (!Array.isArray(bp.objectRegistry) || bp.objectRegistry.length === 0) {
    throw new Error('objectRegistry is empty — video may not contain recognizable game objects');
  }
  if (bp.objectRegistry.length < 3) {
    throw new Error('Only ' + bp.objectRegistry.length + ' objects detected — need at least 3');
  }

  // Deduplicate objectRegistry names
  var seen = {};
  bp.objectRegistry = bp.objectRegistry.filter(function(obj) {
    if (seen[obj.name]) return false;
    seen[obj.name] = true;
    return true;
  });

  // Fix shapes
  bp.objectRegistry.forEach(function(obj) {
    if (VALID_SHAPES.indexOf(obj.shape) === -1) {
      console.log('[video-to-blueprint] Fixing invalid shape "' + obj.shape + '" → "Cube" for ' + obj.name);
      obj.shape = 'Cube';
    }
  });

  // Ensure CTAButton exists in objectRegistry
  if (!bp.objectRegistry.find(function(o) { return o.name === 'CTAButton'; })) {
    bp.objectRegistry.push({
      name: 'CTAButton',
      shape: 'UI',
      scale: [1, 1, 1],
      color: 'green',
      rgb: '#00FF00',
      initiallyVisible: false,
      firstStep: bp.nodes ? bp.nodes.length - 1 : 0,
    });
  }

  // Ensure nodes array
  if (!Array.isArray(bp.nodes) || bp.nodes.length === 0) {
    throw new Error('No shotNodes generated from video');
  }

  // Filter to shotNode type only
  var shotNodes = bp.nodes.filter(function(n) { return n.type === 'shotNode'; });

  // Check count
  if (shotNodes.length < 8) {
    throw new Error('Only ' + shotNodes.length + ' shotNodes (need 8-12) — retry needed');
  }
  if (shotNodes.length > 12) {
    console.log('[video-to-blueprint] Trimming ' + shotNodes.length + ' shotNodes to 12');
    shotNodes = shotNodes.slice(0, 12);
  }

  // Fix node IDs, positions
  shotNodes.forEach(function(node, i) {
    node.id = 'shot_' + i;
    node.type = 'shotNode';
    node.position = { x: 300 * i, y: 200 };
    if (!node.data) node.data = {};
  });

  // Ensure last node has CTA
  var lastNode = shotNodes[shotNodes.length - 1];
  if (!lastNode.data.triggerChain) lastNode.data.triggerChain = [];
  var hasCTA = lastNode.data.triggerChain.some(function(t) {
    return (t.actions || []).some(function(a) {
      return a.method && a.method.indexOf('GameEnded') !== -1;
    });
  });
  if (!hasCTA) {
    lastNode.data.label = lastNode.data.label || 'CTA';
    lastNode.data.triggerChain.push({
      event: 'start',
      actions: [
        { type: 'call', method: 'Luna.Unity.LifeCycle.GameEnded()' },
        { type: 'show', target: 'CTAButton' },
        { type: 'on_click', target: 'CTAButton', action: 'Luna.Unity.Playable.InstallFullGame()' }
      ]
    });
  }

  // Generate edges
  var edges = [];
  for (var i = 0; i < shotNodes.length - 1; i++) {
    edges.push({
      id: 'e_' + i + '_' + (i + 1),
      source: 'shot_' + i,
      target: 'shot_' + (i + 1),
    });
  }

  return {
    objectRegistry: bp.objectRegistry,
    nodes: shotNodes,
    edges: edges,
  };
}

/**
 * Main entry point: video → blueprint JSON.
 * @param {string} videoPath - Raw uploaded video path
 * @param {string} projectId - Project ID for saving frames
 * @param {function} onProgress - Callback: (percent, stage) => void
 * @returns {Promise<{blueprint: object, frames: string[]}>}
 */
async function parseVideo(videoPath, projectId, onProgress) {
  onProgress = onProgress || function() {};

  // Step 1: Get video info
  onProgress(10, '读取视频信息...');
  var info = await getVideoInfo(videoPath);
  console.log('[video-to-blueprint] Video info: ' + JSON.stringify(info));

  // Step 2: Preprocess (truncate + convert to mp4)
  onProgress(15, 'FFmpeg 预处理...');
  var processedPath = videoPath.replace(/\.[^.]+$/, '') + '_processed.mp4';
  if (info.duration > 60 || !videoPath.endsWith('.mp4')) {
    await preprocessVideo(videoPath, processedPath, 60);
  } else {
    processedPath = videoPath; // Already mp4 and under 60s
  }

  // Step 3: Extract thumbnail + keyframes
  onProgress(20, '提取关键帧...');
  var dataDir = path.join(__dirname, '..', 'server-data', 'webgl', projectId);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  var framesDir = path.join(dataDir, 'frames');
  var actualDuration = Math.min(info.duration, 60);

  await extractThumbnail(processedPath, path.join(dataDir, 'thumbnail.jpg'));
  var frameFiles = await extractFrames(processedPath, framesDir, 8, actualDuration);

  // Step 4: Upload video to Doubao Files API
  onProgress(30, '豆包视频上传中...');
  var fileId = await uploadVideo(processedPath);

  // Step 5: Analyze video via Doubao Responses API
  onProgress(50, '豆包 AI 视频分析中（约30-90秒）...');
  var raw;
  try {
    raw = await analyzeVideo(fileId, 0.2);
  } catch(e) {
    console.log('[video-to-blueprint] First attempt failed: ' + e.message);
    onProgress(60, '豆包 AI 重试中 (temperature=0.5)...');
    raw = await analyzeVideo(fileId, 0.5);
  }

  // Step 6: Validate + fix
  onProgress(80, '蓝图校验修补...');
  var blueprint;
  try {
    blueprint = validateBlueprint(raw);
  } catch(valErr) {
    // If shotNodes < 8, retry once
    if (valErr.message.indexOf('retry needed') !== -1) {
      console.log('[video-to-blueprint] Validation failed (' + valErr.message + '), retrying...');
      onProgress(85, 'shotNode 不足，豆包 AI 重试...');
      raw = await analyzeVideo(fileId, 0.5);
      blueprint = validateBlueprint(raw); // Let it throw if still bad
    } else {
      throw valErr;
    }
  }

  // Cleanup processed file if different from input
  if (processedPath !== videoPath) {
    try { fs.unlinkSync(processedPath); } catch(e) {}
  }

  onProgress(95, '完成');
  return { blueprint: blueprint, frames: frameFiles };
}

module.exports = {
  getVideoInfo,
  preprocessVideo,
  extractFrames,
  extractThumbnail,
  parseVideo,
  validateBlueprint,
};
