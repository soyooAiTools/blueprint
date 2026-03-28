'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { GoogleGenAI } = require('@google/genai');

const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL || 'https://sub.mindrix.app';
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: { baseUrl: GEMINI_BASE_URL },
});

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

/**
 * Upload video to Gemini File API and wait for processing.
 * @param {string} videoPath - Path to mp4 file
 * @returns {Promise<{uri: string, mimeType: string}>}
 */
async function uploadToGemini(videoPath) {
  console.log('[video-to-blueprint] Uploading video to Gemini File API...');
  var uploaded = await ai.files.upload({
    file: videoPath,
    config: { mimeType: 'video/mp4' }
  });

  var file = uploaded;
  var maxWait = 60; // seconds
  var waited = 0;
  while (file.state === 'PROCESSING') {
    await new Promise(function(r) { setTimeout(r, 2000); });
    waited += 2;
    if (waited > maxWait) throw new Error('Gemini file processing timeout (' + maxWait + 's)');
    file = await ai.files.get({ name: file.name });
  }
  if (file.state !== 'ACTIVE') throw new Error('Gemini file upload failed, state: ' + file.state);

  console.log('[video-to-blueprint] Video uploaded: ' + file.uri);
  return { uri: file.uri, mimeType: 'video/mp4' };
}

/**
 * Call Gemini to analyze video and output blueprint JSON.
 * @param {{uri: string, mimeType: string}} fileRef
 * @param {number} temperature
 * @returns {Promise<object>} Raw parsed JSON from Gemini
 */
async function analyzeVideo(fileRef, temperature) {
  temperature = temperature || 0.2;
  console.log('[video-to-blueprint] Calling Gemini 2.5 Pro (temp=' + temperature + ')...');

  var result = await Promise.race([
    ai.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: fileRef.uri, mimeType: fileRef.mimeType } },
        { text: BLUEPRINT_PROMPT }
      ]}],
      config: {
        temperature: temperature,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
      },
    }),
    new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('Gemini video analysis timeout (180s)')); }, 180000);
    })
  ]);

  var text = result.text || '';
  // Strip markdown code fences if present
  text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(text);
}

const VALID_SHAPES = ['Cube', 'Sphere', 'Cylinder', 'Ground', 'UI'];

/**
 * Validate and fix blueprint JSON from Gemini.
 * @param {object} raw - Raw blueprint from Gemini
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

  // Step 4: Upload to Gemini
  onProgress(30, 'Gemini 视频上传中...');
  var fileRef = await uploadToGemini(processedPath);

  // Step 5: Analyze video
  onProgress(50, 'Gemini 视频分析中（约30-90秒）...');
  var raw;
  try {
    raw = await analyzeVideo(fileRef, 0.2);
  } catch(e) {
    console.log('[video-to-blueprint] First attempt failed: ' + e.message);
    onProgress(60, 'Gemini 重试中 (temperature=0.5)...');
    raw = await analyzeVideo(fileRef, 0.5);
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
      onProgress(85, 'shotNode 不足，Gemini 重试...');
      raw = await analyzeVideo(fileRef, 0.5);
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

