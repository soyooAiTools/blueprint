# Video-to-Blueprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a video input path to the blueprint pipeline — upload a game video, Gemini 2.5 Pro analyzes it, outputs a V3 blueprint JSON (nodes + edges + objectRegistry) ready for the existing build pipeline.

**Architecture:** Single new module `worker/video-to-blueprint.cjs` handles FFmpeg preprocessing + Gemini video understanding + blueprint validation. One new SSE route in `server.cjs` receives video uploads via busboy. Output feeds directly into existing `parseBlueprintToPrompt` → AI coding → build → CUA pipeline.

**Tech Stack:** Node.js (CommonJS), `@google/genai` SDK (existing), FFmpeg (system), busboy (existing)

**Spec:** `docs/superpowers/specs/2026-03-28-video-to-blueprint-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `worker/video-to-blueprint.cjs` | **Create** | FFmpeg preprocessing, Gemini File API upload + video understanding, blueprint JSON validation/fixup |
| `server.cjs` | **Modify** (~280, ~1024 area) | Add route match + handler for `POST /api/projects/:id/parse-video` |

---

## Task 0: Install FFmpeg

**Files:** None (system dependency)

- [ ] **Step 1: Install FFmpeg**

```bash
apt-get update && apt-get install -y ffmpeg
```

- [ ] **Step 2: Verify installation**

```bash
ffmpeg -version | head -1
```

Expected: `ffmpeg version X.X.X ...`

- [ ] **Step 3: Commit** — No code change, skip commit.

---

## Task 1: video-to-blueprint.cjs — FFmpeg helpers

**Files:**
- Create: `worker/video-to-blueprint.cjs`

This task creates the module with FFmpeg utility functions only. Gemini integration comes in Task 2.

- [ ] **Step 1: Create the module with FFmpeg helpers**

Create `worker/video-to-blueprint.cjs` with these functions:

```javascript
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

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

module.exports = { getVideoInfo, preprocessVideo, extractFrames, extractThumbnail };
```

- [ ] **Step 2: Smoke test the FFmpeg helpers**

```bash
cd /opt/blueprint-editor
# Create a 3-second test video with ffmpeg
ffmpeg -y -f lavfi -i testsrc=duration=3:size=320x240:rate=10 /tmp/test_video.mp4
node -e "
var vtb = require('./worker/video-to-blueprint.cjs');
(async () => {
  var info = await vtb.getVideoInfo('/tmp/test_video.mp4');
  console.log('Info:', JSON.stringify(info));
  if (info.duration < 2 || info.duration > 4) throw new Error('Bad duration: ' + info.duration);
  if (info.width !== 320) throw new Error('Bad width: ' + info.width);

  await vtb.preprocessVideo('/tmp/test_video.mp4', '/tmp/test_processed.mp4', 60);
  console.log('Preprocess OK, exists:', require('fs').existsSync('/tmp/test_processed.mp4'));

  var frames = await vtb.extractFrames('/tmp/test_video.mp4', '/tmp/test_frames', 4, info.duration);
  console.log('Frames:', frames);
  if (frames.length !== 4) throw new Error('Expected 4 frames, got ' + frames.length);

  await vtb.extractThumbnail('/tmp/test_video.mp4', '/tmp/test_thumb.jpg');
  console.log('Thumbnail OK, exists:', require('fs').existsSync('/tmp/test_thumb.jpg'));

  console.log('ALL PASSED');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
"
```

Expected: `ALL PASSED`

- [ ] **Step 3: Commit**

```bash
cd /opt/blueprint-editor
git add worker/video-to-blueprint.cjs
git commit -m "feat(video): add FFmpeg helper functions for video preprocessing"
```

---

## Task 2: video-to-blueprint.cjs — Gemini video understanding + blueprint generation

**Files:**
- Modify: `worker/video-to-blueprint.cjs`

Add Gemini integration: upload video via File API, send to Gemini 2.5 Pro with blueprint extraction prompt, parse and validate output.

- [ ] **Step 1: Add Gemini init and prompt constant**

Add at the top of `worker/video-to-blueprint.cjs`, after the existing requires:

```javascript
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
```

- [ ] **Step 2: Add Gemini upload + generate function**

Add after the prompt constant:

```javascript
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
```

- [ ] **Step 3: Add blueprint validation/fixup function**

Add after `analyzeVideo`:

```javascript
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
```

- [ ] **Step 4: Add the main parseVideo function**

Add after `validateBlueprint`, and update the `module.exports`:

```javascript
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
```

- [ ] **Step 5: Test the complete module with a synthetic video**

```bash
cd /opt/blueprint-editor
node -e "
var vtb = require('./worker/video-to-blueprint.cjs');
// Just verify the module loads without error and exports are correct
var exports = Object.keys(vtb);
console.log('Exports:', exports);
if (!exports.includes('parseVideo')) throw new Error('Missing parseVideo export');
if (!exports.includes('getVideoInfo')) throw new Error('Missing getVideoInfo export');
if (!exports.includes('extractFrames')) throw new Error('Missing extractFrames export');
console.log('Module loads OK');
"
```

Expected: `Module loads OK`

- [ ] **Step 6: Test validateBlueprint with mock data**

```bash
cd /opt/blueprint-editor
node -e "
var vtb = require('./worker/video-to-blueprint.cjs');
var validate = vtb.validateBlueprint;

// Test 1: missing CTA button gets auto-injected
var bp1 = {
  objectRegistry: [
    { name: 'Player', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    { name: 'Enemy', shape: 'Sphere', scale: [1,1,1], color: 'blue', rgb: '#0000FF', initiallyVisible: true, firstStep: 0 },
    { name: 'Ground', shape: 'Ground', scale: [10,1,10], color: 'gray', rgb: '#888888', initiallyVisible: true, firstStep: 0 },
  ],
  nodes: Array.from({length: 8}, function(_, i) {
    return { id: 'n' + i, type: 'shotNode', data: { label: 'Phase ' + i } };
  }),
};
var result1 = validate(bp1);
if (!result1.objectRegistry.find(function(o) { return o.name === 'CTAButton'; })) throw new Error('Test 1 FAIL: CTAButton not injected');
if (result1.nodes.length !== 8) throw new Error('Test 1 FAIL: expected 8 nodes, got ' + result1.nodes.length);
if (result1.edges.length !== 7) throw new Error('Test 1 FAIL: expected 7 edges, got ' + result1.edges.length);
if (result1.nodes[0].id !== 'shot_0') throw new Error('Test 1 FAIL: first node id should be shot_0');
if (result1.nodes[0].position.x !== 0) throw new Error('Test 1 FAIL: first node x should be 0');
console.log('Test 1 PASS: CTA injection + ID/position fixup + edge generation');

// Test 2: invalid shapes get fixed to Cube
var bp2 = {
  objectRegistry: [
    { name: 'A', shape: 'Plane', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    { name: 'B', shape: 'Capsule', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    { name: 'C', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
  ],
  nodes: Array.from({length: 8}, function(_, i) {
    return { id: 'n' + i, type: 'shotNode', data: { label: 'Phase ' + i } };
  }),
};
var result2 = validate(bp2);
if (result2.objectRegistry[0].shape !== 'Cube') throw new Error('Test 2 FAIL: Plane should be fixed to Cube');
if (result2.objectRegistry[1].shape !== 'Cube') throw new Error('Test 2 FAIL: Capsule should be fixed to Cube');
if (result2.objectRegistry[2].shape !== 'Cube') throw new Error('Test 2 FAIL: Cube should stay Cube');
console.log('Test 2 PASS: invalid shapes fixed to Cube');

// Test 3: too few nodes throws retry error
try {
  validate({
    objectRegistry: [
      { name: 'A', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
      { name: 'B', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
      { name: 'C', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    ],
    nodes: [{ id: 'n0', type: 'shotNode', data: {} }],
  });
  throw new Error('Test 3 FAIL: should have thrown');
} catch(e) {
  if (e.message.indexOf('retry needed') === -1) throw new Error('Test 3 FAIL: wrong error: ' + e.message);
}
console.log('Test 3 PASS: too few nodes throws retry error');

// Test 4: >12 nodes get trimmed
var bp4 = {
  objectRegistry: [
    { name: 'A', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    { name: 'B', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
    { name: 'C', shape: 'Cube', scale: [1,1,1], color: 'red', rgb: '#FF0000', initiallyVisible: true, firstStep: 0 },
  ],
  nodes: Array.from({length: 15}, function(_, i) {
    return { id: 'n' + i, type: 'shotNode', data: { label: 'Phase ' + i } };
  }),
};
var result4 = validate(bp4);
if (result4.nodes.length !== 12) throw new Error('Test 4 FAIL: expected 12 nodes, got ' + result4.nodes.length);
console.log('Test 4 PASS: >12 nodes trimmed to 12');

console.log('ALL validateBlueprint TESTS PASSED');
"
```

- [ ] **Step 7: Commit**

```bash
cd /opt/blueprint-editor
git add worker/video-to-blueprint.cjs
git commit -m "feat(video): add Gemini video understanding and blueprint generation"
```

---

## Task 3: server.cjs — Add route and handler

**Files:**
- Modify: `server.cjs:~288` (route matching, add after parse-and-blueprint route)
- Modify: `server.cjs:~1190` (handler, add after parseStoryboard handler)

- [ ] **Step 1: Add route match**

In `server.cjs`, find this block (around line 288-289):

```javascript
  m = pathname.match(/^\/api\/projects\/([^/]+)\/parse-and-blueprint$/);
  if (m && method === 'POST') return { handler: 'parseAndBlueprint', id: m[1], rawBody: true };
```

Add immediately AFTER it:

```javascript
  m = pathname.match(/^\/api\/projects\/([^/]+)\/parse-video$/);
  if (m && method === 'POST') return { handler: 'parseVideo', id: m[1], rawBody: true };
```

- [ ] **Step 2: Add handler**

In `server.cjs`, find the end of the `parseStoryboard` handler (around line 1191, look for `req.pipe(bb);` followed by `};`). Add the new handler AFTER the `parseStoryboard` handler closes:

```javascript
// ---- Video-to-Blueprint handler ----
handlers.parseVideo = function(req, res, body, projectId) {
  console.log('[parse-video] REQ headers:', JSON.stringify({ct: req.headers['content-type'], cl: req.headers['content-length']}));

  var videoToBlueprint = require('./worker/video-to-blueprint.cjs');

  var bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } });
  } catch(e) {
    return sendJSON(res, { error: 'Invalid multipart request: ' + e.message }, 400);
  }

  var sseStarted = false;
  function startSSE() {
    if (sseStarted) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
  }
  function sendSSE(evt) {
    if (!sseStarted) startSSE();
    try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch(e) {}
  }

  var videoFile = null;
  var _fileWrite = null;
  var fileLimitHit = false;

  bb.on('file', function(fieldname, stream, info) {
    var ext = path.extname(info.filename || '').toLowerCase();
    if (['.mp4', '.mov', '.webm'].indexOf(ext) === -1) {
      stream.resume(); // drain
      return;
    }
    var savePath = path.join(DATA_DIR, 'webgl', projectId || 'tmp', 'source_video' + ext);
    var dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    var ws = fs.createWriteStream(savePath);
    stream.pipe(ws);

    stream.on('limit', function() { fileLimitHit = true; });

    _fileWrite = new Promise(function(resolve) {
      ws.on('close', function() {
        videoFile = savePath;
        resolve();
      });
    });
  });

  bb.on('close', async function() {
    startSSE();
    try {
      if (_fileWrite) await _fileWrite;

      if (fileLimitHit) {
        sendSSE({ type: 'error', message: '视频文件超过 20MB 限制' });
        return res.end();
      }

      if (!videoFile) {
        sendSSE({ type: 'error', message: '请上传视频文件 (mp4/mov/webm)' });
        return res.end();
      }

      sendSSE({ type: 'progress', percent: 5, stage: '视频上传完成' });

      // Heartbeat for long Gemini calls
      var heartbeat = null;
      var startTime = Date.now();
      var lastPercent = 5;
      heartbeat = setInterval(function() {
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        sendSSE({ type: 'progress', percent: Math.min(lastPercent + 1, 89), stage: '处理中（已等待 ' + elapsed + ' 秒）' });
      }, 5000);

      var result = await videoToBlueprint.parseVideo(videoFile, projectId, function(percent, stage) {
        lastPercent = percent;
        sendSSE({ type: 'progress', percent: percent, stage: stage });
      });

      clearInterval(heartbeat);

      // Save blueprint to project
      try {
        var proj = readProject(projectId);
        if (proj) {
          proj.nodes = result.blueprint.nodes;
          proj.edges = result.blueprint.edges;
          proj.objectRegistry = result.blueprint.objectRegistry;
          proj.videoSource = true;
          proj.updatedAt = new Date().toISOString();
          writeProject(proj);
          console.log('[parse-video] Saved blueprint (' + result.blueprint.nodes.length + ' nodes) to project', projectId);
        }
      } catch(saveErr) {
        console.error('[parse-video] Save blueprint error:', saveErr.message);
      }

      sendSSE({ type: 'progress', percent: 100, stage: '完成！' });
      sendSSE({ type: 'done', data: { blueprint: result.blueprint, frames: result.frames } });
      res.end();

      // Cleanup source video
      try { fs.unlinkSync(videoFile); } catch(e) {}

    } catch(e) {
      if (heartbeat) clearInterval(heartbeat);
      console.error('[parse-video] Error:', e.message);
      try { notify.alert('critical', '视频解析失败', e.message); } catch(ne) {}
      sendSSE({ type: 'error', message: '视频解析失败: ' + e.message });
      res.end();
    }
  });

  bb.on('error', function(e) {
    if (sseStarted) {
      sendSSE({ type: 'error', message: 'Upload failed: ' + e.message });
      res.end();
    } else {
      sendJSON(res, { error: 'Upload failed: ' + e.message }, 500);
    }
  });

  req.pipe(bb);
};
```

- [ ] **Step 3: Verify server loads without errors**

```bash
cd /opt/blueprint-editor
node -e "
// Quick syntax check - require the server module structure parts
try {
  require('./worker/video-to-blueprint.cjs');
  console.log('video-to-blueprint module OK');
} catch(e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
"
```

- [ ] **Step 4: Commit**

```bash
cd /opt/blueprint-editor
git add server.cjs
git commit -m "feat(video): add POST /api/projects/:id/parse-video SSE endpoint"
```

---

## Task 4: Integration test with real server

**Files:** None (manual testing)

- [ ] **Step 1: Restart the server**

```bash
cd /opt/blueprint-editor
pm2 delete blueprint 2>/dev/null; pm2 start server.cjs --name blueprint -- --port 3901
pm2 logs blueprint --lines 5 --nostream
```

Expected: Server starts on port 3901, no errors.

- [ ] **Step 2: Test the endpoint with a synthetic video**

```bash
# Create a 5-second test video
ffmpeg -y -f lavfi -i testsrc=duration=5:size=640x480:rate=15 /tmp/integration_test.mp4

# Test the endpoint (will fail at Gemini step if no API key, but validates upload + FFmpeg)
curl -N -X POST http://localhost:3901/api/projects/test_video_001/parse-video \
  -F "video=@/tmp/integration_test.mp4" \
  2>/dev/null | head -20
```

Expected: Should see SSE progress events (`data: {"type":"progress",...}`). If Gemini API key is configured, should complete with a blueprint. If not, should show an error about Gemini at the analysis step (but upload + FFmpeg preprocessing should succeed).

- [ ] **Step 3: Test file size limit**

```bash
# Create an oversized file (>20MB)
dd if=/dev/zero of=/tmp/big_video.mp4 bs=1M count=25 2>/dev/null
curl -N -X POST http://localhost:3901/api/projects/test_video_002/parse-video \
  -F "video=@/tmp/big_video.mp4" \
  2>/dev/null | head -5
```

Expected: Should see `{"type":"error","message":"视频文件超过 20MB 限制"}`

- [ ] **Step 4: Test invalid file type**

```bash
echo "not a video" > /tmp/fake.txt
curl -N -X POST http://localhost:3901/api/projects/test_video_003/parse-video \
  -F "video=@/tmp/fake.txt" \
  2>/dev/null | head -5
```

Expected: Should see `{"type":"error","message":"请上传视频文件 (mp4/mov/webm)"}`

- [ ] **Step 5: Commit** — No code changes needed, skip.

---

## Task 5: End-to-end test with real video (manual)

**Prerequisites:** Gemini API key configured in the server's `.env` (`GEMINI_API_KEY=...`)

- [ ] **Step 1: Upload a real game recording**

Find or record a short gameplay video (15-30s, under 20MB) and test:

```bash
curl -N -X POST http://localhost:3901/api/projects/test_real_001/parse-video \
  -F "video=@/path/to/game_recording.mp4"
```

- [ ] **Step 2: Verify the output blueprint**

```bash
# Check the saved project
cat /opt/blueprint-editor/server-data/projects/test_real_001.json | python3 -m json.tool | head -50
```

Verify:
- `nodes` array has 8-12 entries with `type: "shotNode"`
- `edges` connect them sequentially
- `objectRegistry` has 3+ objects with valid shapes
- Last node has CTA trigger actions
- `videoSource: true` flag is set

- [ ] **Step 3: Open in blueprint editor**

Navigate to `https://playcools.top/blueprint/` and open the test project. Verify the nodes render correctly in the editor and can be manually edited.

- [ ] **Step 4: Submit for build (optional)**

If the blueprint looks reasonable, submit for build to verify the full pipeline works end-to-end with a video-generated blueprint.
