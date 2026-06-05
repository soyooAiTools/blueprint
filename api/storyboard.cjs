/**
 * Storyboard API handlers
 * Extracted from server.cjs — parse, generate, edit, PDF, parse-and-blueprint, video, convert, analyze
 */
var fs = require('fs');
var path = require('path');
var Busboy = require('busboy');
var storyboardParser = require('../adapters/storyboard-parser.cjs');
var storyboardPdf = require('../adapters/storyboard-pdf.cjs');
var { ensureProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');

module.exports.init = function(ctx) {
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var notify = ctx.notify;
  var parseStats = ctx.parseStats;
  var recordParseStat = ctx.recordParseStat;
  var activeGenerations = ctx.activeGenerations;
  var modelProvider = ctx.modelProvider;

  var PORT = config.PORT;
  var DATA_DIR = config.DATA_DIR;
  var WEBGL_DIR = config.WEBGL_DIR;
  var UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  return {
    parseStoryboard: function(req, res, body, params) {
      var projectId = params.id;
      console.log('[parse-storyboard] REQ headers:', JSON.stringify({ct: req.headers['content-type'], cl: req.headers['content-length']}));
      // Multipart form: text, orientation, cameraAngle, perspective, style, files[], images[]
      var fields = {};
      var files = [];
      var images = [];

      var bb;
      try {
        bb = Busboy({ headers: req.headers });
      } catch(e) {
        return sendJSON(res, { error: 'Invalid multipart request: ' + e.message }, 400);
      }

      // SSE helpers
      var sseStarted = false;
      function startSSE() {
        if (sseStarted) return;
        sseStarted = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
      }
      function sendSSE(evt) {
        if (!sseStarted) startSSE();
        res.write('data: ' + JSON.stringify(evt) + '\n\n');
      }

      bb.on('field', function(name, val) { fields[name] = val; });
      var _fileWrites = [];
      bb.on('file', function(name, stream, info) {
        var savePath = path.join(UPLOAD_DIR, Date.now() + '_' + (info.filename || 'file'));
        var ws = fs.createWriteStream(savePath);
        stream.pipe(ws);
        _fileWrites.push(new Promise(function(resolve) {
          ws.on('close', function() {
            if (name === 'images') {
              images.push({ path: savePath, mime: info.mimeType, filename: info.filename });
            } else if (name === 'charRef') {
              images.push({ path: savePath, mime: info.mimeType, filename: info.filename, isCharRef: true });
            } else {
              files.push({ path: savePath, filename: info.filename });
            }
            resolve();
          });
        }));
      });
      bb.on('close', async function() {
        startSSE();
        try {
          await Promise.all(_fileWrites);
          sendSSE({ type: 'progress', percent: 5, stage: '文件上传完成' });

          // Build text from docs + text field
          var allText = fields.text || '';
          var pdfPath = null;
          var imageParts = [];
          console.log("[parse-storyboard] files detail:", JSON.stringify(files.map(f => ({name: f.filename, path: f.path}))));
          for (var f of files) {
            try {
              var fname = (f.filename || '').toLowerCase();
              if (fname.endsWith('.pdf')) {
                pdfPath = f.path;
                console.log('[parse-storyboard] PDF detected:', f.filename);
              } else if (/\.(png|jpg|jpeg|webp)$/.test(fname)) {
                var imgPart = storyboardParser.readImagePart(f.path);
                imageParts.push(imgPart);
                console.log('[parse-storyboard] Image doc detected:', f.filename);
              } else {
                var docText = await storyboardParser.extractDocText(f.path);
                allText += '\n\n' + docText;
              }
            } catch(e) { console.warn('[parse-storyboard] Doc extract failed:', f.filename, e.message); }
          }
          sendSSE({ type: 'progress', percent: 15, stage: '文档解析完成' });

          // Read additional image attachments
          var charRefPart = null;
          for (var img of images) {
            try {
              var part = storyboardParser.readImagePart(img.path);
              if (img.isCharRef) {
                charRefPart = part;
                console.log('[parse-storyboard] Character ref image detected');
              } else {
                imageParts.push(part);
              }
            } catch(e) { console.warn('[parse-storyboard] Image read failed:', e.message); }
          }

          if (!allText.trim() && imageParts.length === 0 && !pdfPath) {
            sendSSE({ type: 'error', message: '请提供文案或文档' });
            return res.end();
          }

          sendSSE({ type: 'progress', percent: 20, stage: 'AI 分镜解析中...' });

          // Call parser
          var parserConfig = {
            orientation: fields.orientation || 'landscape',
            cameraAngle: fields.cameraAngle || 'isometric45',
            perspective: fields.perspective || 'third',
            style: fields.style || '',
            targetFrames: parseInt(fields.targetFrames, 10) || 15,
          };

          // Set up a heartbeat to track long AI calls
          var aiStartTime = Date.now();
          var heartbeat = setInterval(function() {
            var elapsed = Math.round((Date.now() - aiStartTime) / 1000);
            // Slowly advance from 20 to 85 based on elapsed time (typical parse: 30-120s)
            var aiPercent = Math.min(85, 20 + Math.round(elapsed * 0.5));
            sendSSE({ type: 'progress', percent: aiPercent, stage: 'AI 深度分析中（已等待 ' + elapsed + ' 秒）' });
          }, 3000);

          var frames;
          try {
            frames = await storyboardParser.parseScript(allText, { ...parserConfig, images: imageParts, docPath: pdfPath, charRefImage: charRefPart });
          } finally {
            clearInterval(heartbeat);
          }

          sendSSE({ type: 'progress', percent: 90, stage: '解析完成，保存中...' });

          // Save frames to project
          try {
            var proj = readProject(projectId);
            if (proj) {
              proj.storyboardFrames = frames.frames || [];
              proj.storyboardConfig = parserConfig;
              proj.characterSheet = frames.characterSheet || {};
              proj.sceneSheet = frames.sceneSheet || {};
              ensureProjectPlans(proj);
              proj.updatedAt = new Date().toISOString();
              writeProject(proj);
              console.log('[parse-storyboard] Saved', (frames.frames || []).length, 'frames to project', projectId);
            }
          } catch(saveErr) { console.error('[parse-storyboard] Save frames error:', saveErr.message); }

          sendSSE({ type: 'progress', percent: 100, stage: '完成！' });
          sendSSE({ type: 'done', data: frames });
          res.end();

          // Cleanup uploaded files
          for (var f2 of [...files, ...images]) {
            try { fs.unlinkSync(f2.path); } catch(e) {}
          }
        } catch(e) {
          console.error('[parse-storyboard] Error:', e.message);
          try { notify.alert('critical', '分镜解析失败', e.message); } catch(ne) {}
          sendSSE({ type: 'error', message: '分镜解析失败: ' + e.message });
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
    },

    parseVideo: function(req, res, body, params) {
      var projectId = params.id;
      console.log('[parse-video] REQ headers:', JSON.stringify({ct: req.headers['content-type'], cl: req.headers['content-length']}));

      var videoToBlueprint = require('../worker/video-to-blueprint.cjs');

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

          // Heartbeat for long LLM calls
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
              // V3 node/edge/objectRegistry save removed — V4 uses entities
              proj.videoSource = true;
              proj.updatedAt = new Date().toISOString();
              writeProject(proj);
              console.log('[parse-video] Marked project videoSource for', projectId);
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
    },

    saveStoryboard: function(req, res, body, params) {
      var id = params.id;
      try {
        var data = JSON.parse(body);
        var proj = readProject(id);
        if (!proj) return sendJSON(res, { error: 'Project not found' }, 404);
        var newFrames = data.frames || [];
        var oldFrames = proj.storyboardFrames || [];
        // Guard: reject if frame count drops by >50% (likely frontend state loss)
        if (oldFrames.length >= 4 && newFrames.length < oldFrames.length * 0.5) {
          console.error('[saveStoryboard] BLOCKED: frame count drop ' + oldFrames.length + ' -> ' + newFrames.length + ' (>50% loss). Use force=true to override.');
          if (!data.force) {
            return sendJSON(res, { error: 'Frame count dropped from ' + oldFrames.length + ' to ' + newFrames.length + '. This looks like data loss. Add force:true to override.', blocked: true, oldCount: oldFrames.length, newCount: newFrames.length }, 409);
          }
        }
        proj.storyboardFrames = newFrames;
        if (data.characterSheet) proj.characterSheet = data.characterSheet;
        if (data.sceneSheet) proj.sceneSheet = data.sceneSheet;
        proj.updatedAt = new Date().toISOString();
        writeProject(proj);
        sendJSON(res, { ok: true });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    editFrame: function(req, res, body, params) {
      (async function() {
        try {
          var data = JSON.parse(body);
          var frame = data.frame;
          var instruction = data.instruction;
          if (!frame || !instruction) return sendJSON(res, { error: 'frame and instruction required' }, 400);
          var newFrame = await storyboardParser.editFrame(frame, instruction);
          sendJSON(res, { frame: newFrame });
        } catch(e) {
          console.error('[edit-frame] Error:', e.message);
          sendJSON(res, { error: '编辑失败: ' + e.message }, 500);
        }
      })();
    },

    uploadStyleRef: function(req, res, body, params) {
      var projectId = params.id;
      var bb = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
      var savedFile = null;
      bb.on('file', function(fieldname, file, info) {
        var imgDir = path.join(DATA_DIR, 'images', projectId || 'default');
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
        var filename = 'style_ref_' + Date.now() + '.jpg';
        var filePath = path.join(imgDir, filename);
        var ws = fs.createWriteStream(filePath);
        file.pipe(ws);
        ws.on('finish', function() {
          savedFile = { filename: filename, url: '/api/images/' + (projectId || 'default') + '/' + filename };
        });
      });
      bb.on('finish', function() {
        if (savedFile) {
          sendJSON(res, { ok: true, styleRefUrl: savedFile.url, filename: savedFile.filename });
        } else {
          sendJSON(res, { error: 'No file uploaded' }, 400);
        }
      });
      bb.on('error', function(e) { sendJSON(res, { error: e.message }, 500); });
      req.pipe(bb);
    },

    generateStoryboard: function(req, res, body, params) {
      var projectId = params.id;
      activeGenerations.count++;
      (async function() {
        try {
          var data = JSON.parse(body);
          var frames = data.frames || [];
          if (frames.length === 0) return sendJSON(res, { error: 'No frames' }, 400);
          var orientation = data.orientation || 'landscape';
          var styleRefUrl = data.styleRefUrl || null;
          var charRefUrl = data.charRefUrl || null;

          // Use SSE for progress
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });

          var imgDir = path.join(DATA_DIR, 'images', projectId || 'default');
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

          // Load user-uploaded style reference if provided
          var styleRefBase64 = null, styleRefMime = null;
          if (styleRefUrl) {
            try {
              var refPath = path.join(imgDir, path.basename(styleRefUrl));
              if (!fs.existsSync(refPath) && styleRefUrl.startsWith('/api/images/')) {
                refPath = path.join(DATA_DIR, 'images', styleRefUrl.replace('/api/images/', ''));
              }
              if (fs.existsSync(refPath)) {
                styleRefBase64 = fs.readFileSync(refPath).toString('base64');
                styleRefMime = refPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
                console.log('[generate-storyboard] Using user style ref: ' + refPath);
              }
            } catch(e) { console.warn('[generate-storyboard] Failed to load style ref:', e.message); }
          }

          // Load character reference image if provided
          var charRefBase64 = null, charRefMime = null;
          if (charRefUrl) {
            try {
              var charPath = path.join(imgDir, path.basename(charRefUrl));
              if (!fs.existsSync(charPath) && charRefUrl.startsWith('/api/images/')) {
                charPath = path.join(DATA_DIR, 'images', charRefUrl.replace('/api/images/', ''));
              }
              if (fs.existsSync(charPath)) {
                charRefBase64 = fs.readFileSync(charPath).toString('base64');
                charRefMime = charPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
                console.log('[generate-storyboard] Using char ref: ' + charPath);
              }
            } catch(e) { console.warn('[generate-storyboard] Failed to load char ref:', e.message); }
          }

          var updatedFrames = [...frames];
          var completed = 0;
          var prevImagePath = null; // Track previous frame image for consistency

          // Generate frames SEQUENTIALLY for consistency (each frame uses prev as reference)
          for (var fi = 0; fi < frames.length; fi++) {
            var frame = frames[fi];
            try {
              var genOpts = { orientation: orientation };
              if (charRefBase64) { genOpts.charRefBase64 = charRefBase64; genOpts.charRefMime = charRefMime; }
              if (prevImagePath) { genOpts.prevImagePath = prevImagePath; }

              var imgResult = await storyboardParser.generateImage(frame.prompt || frame.title, genOpts);
              var rawBuf = Buffer.from(imgResult.base64, 'base64');
              var normBuf = await storyboardParser.normalizeImageSize(rawBuf, orientation);
              var fn = 'frame_' + frame.id + '.jpg';
              var framePath = path.join(imgDir, fn);
              fs.writeFileSync(framePath, normBuf);
              updatedFrames[fi] = { ...frame, imageUrl: '/api/images/' + (projectId || 'default') + '/' + fn };

              // Save full-res PNG for next frame's reference (edit API needs the uncompressed version)
              var prevPngPath = path.join(imgDir, 'prev_frame.png');
              if (imgResult.outputPath && fs.existsSync(imgResult.outputPath)) {
                fs.copyFileSync(imgResult.outputPath, prevPngPath);
                try { fs.unlinkSync(imgResult.outputPath); } catch(e) {}
              } else {
                fs.writeFileSync(prevPngPath, rawBuf);
              }
              prevImagePath = prevPngPath;

              console.log('[generate-storyboard] Frame ' + frame.id + ' generated' + (fi > 0 ? ' (edit mode, consistent)' : ' (base frame)'));
            } catch(imgErr) {
              console.error('[generate-storyboard] Frame ' + frame.id + ' failed:', imgErr.message?.substring(0, 150));
              updatedFrames[fi] = { ...frame, imageUrl: null, imageError: imgErr.message };
            }
            completed++;
            res.write('data: ' + JSON.stringify({ type: 'progress', current: completed, total: frames.length, frameId: frame.id }) + '\n\n');

            // Save after each frame (merge into existing, don't overwrite)
            if (projectId) {
              try {
                var _p = readProject(projectId);
                if (_p) {
                  var _existing = _p.storyboardFrames || [];
                  if (_existing.length >= updatedFrames.length) {
                    var _imgMap = {};
                    for (var _uf of updatedFrames) { if (_uf.imageUrl) _imgMap[_uf.id] = _uf.imageUrl; }
                    _p.storyboardFrames = _existing.map(function(_ef) {
                      return _imgMap[_ef.id] ? Object.assign({}, _ef, { imageUrl: _imgMap[_ef.id], imageError: undefined }) : _ef;
                    });
                  } else {
                    _p.storyboardFrames = updatedFrames;
                  }
                  _p.updatedAt = new Date().toISOString();
                  writeProject(_p);
                }
              } catch(_se) {}
            }
          }
          // Retry failed frames (without prev-image to avoid chain failure)
          var MAX_RETRY_ROUNDS = 2;
          for (var retryRound = 1; retryRound <= MAX_RETRY_ROUNDS; retryRound++) {
            var failedIdxs = [];
            for (var ri = 0; ri < updatedFrames.length; ri++) {
              if (!updatedFrames[ri].imageUrl) failedIdxs.push(ri);
            }
            if (failedIdxs.length === 0) break;
            console.log('[generate-storyboard] Retry round ' + retryRound + ': ' + failedIdxs.length + ' failed');
            await new Promise(function(r) { setTimeout(r, 3000); });
            for (var rfi = 0; rfi < failedIdxs.length; rfi++) {
              var ridx = failedIdxs[rfi];
              var rframe = frames[ridx];
              try {
                // Find nearest successful prev frame for reference
                var retryPrev = null;
                for (var pi = ridx - 1; pi >= 0; pi--) {
                  if (updatedFrames[pi].imageUrl) {
                    retryPrev = path.join(imgDir, 'frame_' + frames[pi].id + '.jpg');
                    if (!fs.existsSync(retryPrev)) retryPrev = null;
                    break;
                  }
                }
                var retryOpts = { orientation: orientation };
                if (retryPrev) retryOpts.prevImagePath = retryPrev;
                var retryResult = await storyboardParser.generateImage(rframe.prompt || rframe.title, retryOpts);
                var retryBuf = Buffer.from(retryResult.base64, 'base64');
                var retryNorm = await storyboardParser.normalizeImageSize(retryBuf, orientation);
                var retryFn = 'frame_' + rframe.id + '.jpg';
                fs.writeFileSync(path.join(imgDir, retryFn), retryNorm);
                updatedFrames[ridx] = { ...rframe, imageUrl: '/api/images/' + (projectId || 'default') + '/' + retryFn };
                console.log('[generate-storyboard] Retry success for frame ' + rframe.id);
              } catch(retryErr) {
                console.error('[generate-storyboard] Retry failed for frame ' + rframe.id + ':', retryErr.message?.substring(0, 100));
              }
              res.write('data: ' + JSON.stringify({ type: 'progress', current: ++completed, total: frames.length, frameId: rframe.id, retry: true }) + '\n\n');
            }
          }
          var finalFailed = updatedFrames.filter(function(f) { return !f.imageUrl; }).length;
          if (finalFailed > 0) {
            try { notify.alert('warning', '图片生成部分失败', finalFailed + '/' + frames.length + ' 张未生成'); } catch(ne) {}
          }

          // Save to project — merge imageUrl into existing frames (don't overwrite all frames)
          if (projectId) {
            try {
              var proj = readProject(projectId);
              if (proj) {
                var existingFrames = proj.storyboardFrames || [];
                // Build map from generated frames
                var imgMap = {};
                for (var uf of updatedFrames) { if (uf.imageUrl) imgMap[uf.id] = uf.imageUrl; }
                // Merge into existing frames
                if (existingFrames.length >= updatedFrames.length) {
                  proj.storyboardFrames = existingFrames.map(function(ef) {
                    return imgMap[ef.id] ? Object.assign({}, ef, { imageUrl: imgMap[ef.id], imageError: undefined }) : ef;
                  });
                } else {
                  proj.storyboardFrames = updatedFrames;
                }
                proj.updatedAt = new Date().toISOString();
                writeProject(proj);
              }
            } catch(saveErr) { console.error('[generate-storyboard] Save error:', saveErr.message); }
          }

          res.write('data: ' + JSON.stringify({ type: 'done', frames: updatedFrames }) + '\n\n');
          res.end();
          activeGenerations.count--;
        } catch(e) {
          console.error('[generate-storyboard] Error:', e.message);
          try { notify.alert('critical', '配图生成失败', e.message); } catch(ne) {}
          try { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n'); res.end(); } catch(x) {}
          activeGenerations.count--;
        }
      })();
    },

    generateStoryboardPDF: function(req, res, body, params) {
      var projectId = params.id;
      (async function() {
        try {
          var data = JSON.parse(body);
          var frames = data.frames || [];
          var projectName = data.projectName || '分镜板';
          var subtitle = data.subtitle || '';
          if (frames.length === 0) return sendJSON(res, { error: 'No frames' }, 400);

          var serverBaseUrl = 'http://localhost:' + PORT;
          var pdfBuffer = await storyboardPdf.generateStoryboardPDF(frames, {
            projectName: projectName,
            subtitle: subtitle,
            serverBaseUrl: serverBaseUrl,
          });

          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="' + encodeURIComponent(projectName) + '_storyboard.pdf"',
            'Content-Length': pdfBuffer.length,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(pdfBuffer);
        } catch(e) {
          console.error('[generate-storyboard-pdf] Error:', e.message);
          sendJSON(res, { error: e.message }, 500);
        }
      })();
    },

    parseAndBlueprint: async function(req, res, body, params) {
      var projectId = params.id;

      // *** STEP 1: Collect raw body BEFORE starting SSE response ***
      var rawChunks = [];
      await new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() {
          console.error('[parse-and-blueprint] Body read timeout 60s');
          reject(new Error('文件上传超时'));
        }, 60000);
        req.on('data', function(chunk) { rawChunks.push(chunk); });
        req.on('end', function() { clearTimeout(timeout); resolve(); });
        req.on('error', function(e) { clearTimeout(timeout); reject(e); });
        if (req.complete) { clearTimeout(timeout); resolve(); }
      });
      var rawBody = Buffer.concat(rawChunks);
      console.log('[parse-and-blueprint] Body received: ' + rawBody.length + ' bytes');

      // *** STEP 2: Now start SSE response ***
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      function sendSSE(data) {
        try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
      }

      var _parseStart = Date.now();
      try {
        sendSSE({ type: 'progress', percent: 2, stage: '检查项目...' });

        var project = readProject(projectId);
        if (!project) { sendSSE({ type: 'error', message: 'Project not found' }); res.end(); return; }

        sendSSE({ type: 'progress', percent: 5, stage: '处理上传文件...' });

        // Parse multipart to get PDF file
        var uploadedFiles = [];
        var formFields = {};

        // *** STEP 3: Parse multipart from buffer ***
        await new Promise(function(resolve, reject) {
          try {
            var bb = Busboy({ headers: req.headers });
            var pendingWrites = 0;
            var busboyDone = false;
            function checkResolve() {
              if (busboyDone && pendingWrites === 0) resolve();
            }
            bb.on('file', function(fieldname, file, info) {
              var filename = info.filename || info;
              if (typeof filename === 'object') filename = filename.filename;
              console.log('[parse-and-blueprint] Receiving file: ' + filename);
              var uploadDir = path.join(DATA_DIR, 'uploads');
              if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
              var dest = path.join(uploadDir, Date.now() + '_' + filename);
              var ws = fs.createWriteStream(dest);
              pendingWrites++;
              file.pipe(ws);
              ws.on('close', function() {
                var size = 0;
                try { size = fs.statSync(dest).size; } catch(e) {}
                console.log('[parse-and-blueprint] File saved: ' + dest + ' (' + size + ' bytes)');
                uploadedFiles.push({ name: filename, path: dest });
                pendingWrites--;
                checkResolve();
              });
            });
            bb.on('field', function(name, val) { formFields[name] = val; });
            bb.on('close', function() {
              console.log('[parse-and-blueprint] Busboy close, pendingWrites=' + pendingWrites);
              busboyDone = true;
              checkResolve();
            });
            bb.on('error', function(e) {
              console.error('[parse-and-blueprint] Busboy error:', e.message);
              reject(e);
            });
            // Feed collected buffer through PassThrough stream
            var { PassThrough } = require('stream');
            var pt = new PassThrough();
            pt.pipe(bb);
            pt.end(rawBody);
          } catch(e) {
            console.error('[parse-and-blueprint] Busboy init error:', e.message);
            try {
              var parsed = JSON.parse(rawBody.toString());
              formFields = parsed;
            } catch(e2) {}
            resolve();
          }
        });

        // Find PDF file
        var pdfFile = uploadedFiles.find(function(f) { return /\.pdf$/i.test(f.name); });
        var imageFiles = uploadedFiles.filter(function(f) { return /\.(png|jpg|jpeg)$/i.test(f.name); });

        // If no new upload, check existing storyboard upload or saved frames
        if (!pdfFile && !imageFiles.length) {
          var uploadsDir = path.join(DATA_DIR, 'uploads');
          if (fs.existsSync(uploadsDir)) {
            var dirFiles = fs.readdirSync(uploadsDir).filter(function(f) { return /\.pdf$/i.test(f); }).sort().reverse();
            if (dirFiles.length > 0) {
              pdfFile = { name: dirFiles[0], path: path.join(uploadsDir, dirFiles[0]) };
            }
          }
        }

        if (!pdfFile && !imageFiles.length) {
          sendSSE({ type: 'error', message: '请上传 PDF 分镜文件' });
          res.end();
          return;
        }

        var orientation = formFields.orientation || 'landscape';
        var targetFrames = parseInt(formFields.targetFrames) || 11;
        var userText = formFields.text || '';

        sendSSE({ type: 'progress', percent: 10, stage: '准备 AI 分析...' });
        console.log('[parse-and-blueprint] One-shot PDF→V4 for project ' + projectId);

        // Call Python one-shot script via spawn
        var { spawn: spawnProc } = require('child_process');

        // SSE keepalive: send heartbeat every 15s to prevent proxy/browser timeout
        var keepalive = setInterval(function() {
          try { res.write(': keepalive\n\n'); } catch(e) { clearInterval(keepalive); }
        }, 15000);

        var pyResult;
        try {
        pyResult = await new Promise(function(resolve, reject) {
          var args = [
            path.join(__dirname, '..', 'python', 'pdf_to_blueprint.py'),
            '--schema-file', path.join(__dirname, '..', 'docs', 'v4-schema.json'),
            '--templates-file', path.join(__dirname, '..', 'worker', 'behavior-templates.md'),
            '--orientation', orientation,
            '--target-frames', String(targetFrames),
          ];
          if (pdfFile) {
            args.push('--pdf', pdfFile.path);
          }
          if (imageFiles.length > 0) {
            args.push('--images');
            imageFiles.forEach(function(f) { args.push(f.path); });
          }
          if (userText) {
            args.push('--text', userText);
          }

          var env = Object.assign({}, process.env, { OPENAI_API_KEY: process.env.OPENAI_API_KEY || '' });
          var child = spawnProc('python3.8', args, { env: env, timeout: 600000 });
          var stdout = '';
          var stderr = '';
          var lastProgress = Date.now();

          child.stdout.on('data', function(data) { stdout += data.toString(); });
          child.stderr.on('data', function(data) {
            var chunk = data.toString();
            stderr += chunk;
            lastProgress = Date.now();
            // Parse structured progress lines
            var lines = chunk.split('\n');
            for (var i = 0; i < lines.length; i++) {
              var pm = lines[i].match(/^PROGRESS:(\d+):(.+)/);
              if (pm) {
                sendSSE({ type: 'progress', percent: parseInt(pm[1]), stage: pm[2] });
              }
            }
          });
          child.on('close', function(code) {
            if (stderr) console.log('[parse-and-blueprint] Python: ' + stderr.substring(0, 500));
            if (code !== 0 && !stdout) return reject(new Error('Python one-shot failed (exit ' + code + '): ' + (stderr || '').substring(0, 300)));
            resolve(stdout);
          });
          child.on('error', reject);

          // Detect client disconnect: if res is closed, kill child process
          res.on('close', function() {
            if (!child.killed) {
              console.log('[parse-and-blueprint] Client disconnected, killing Python process');
              child.kill('SIGTERM');
            }
          });
        });
        } finally {
          clearInterval(keepalive);
        }

        sendSSE({ type: 'progress', percent: 90, stage: '解析结果...' });

        var parsed = JSON.parse(pyResult);
        if (parsed.error) throw new Error(parsed.error);
        var v4Data = parsed.data;

        // Validate
        if (!v4Data.entities || !Array.isArray(v4Data.entities)) throw new Error('Missing entities');
        if (!v4Data.phases || !Array.isArray(v4Data.phases)) throw new Error('Missing phases');

        sendSSE({ type: 'progress', percent: 95, stage: '保存数据 (' + v4Data.entities.length + ' 实体, ' + v4Data.phases.length + ' 阶段)...' });

        // Save storyboard frames
        if (v4Data.storyboardFrames && v4Data.storyboardFrames.length > 0) {
          project.storyboardFrames = v4Data.storyboardFrames;
        }
        // Save V4 data
        project.entities = v4Data.entities;
        project.phases = v4Data.phases;
        project.globalSettings = v4Data.globalSettings || {};
        project.version = 4;
        ensureProjectPlans(project);
        writeProject(project);

        console.log('[parse-and-blueprint] Done: ' + v4Data.entities.length + ' entities, ' + v4Data.phases.length + ' phases, ' + (v4Data.storyboardFrames || []).length + ' frames');
        recordParseStat(true, Date.now() - _parseStart, v4Data.entities.length, v4Data.phases.length, null);

        sendSSE({ type: 'progress', percent: 100, stage: '完成！' });
        sendSSE({
          type: 'done',
          storyboardFrames: v4Data.storyboardFrames || [],
          entities: v4Data.entities,
          phases: v4Data.phases,
          globalSettings: v4Data.globalSettings || {},
        });
        res.end();
      } catch(e) {
        console.error('[parse-and-blueprint] Error:', e.message);
        recordParseStat(false, Date.now() - _parseStart, 0, 0, e.message);
        sendSSE({ type: 'error', message: e.message });
        res.end();
      }
    },

    convertToV4: async function(req, res, body, params) {
      var projectId = params.id;
      // SSE streaming response for real-time progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      function sendSSE(data) {
        try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
      }
      try {
        sendSSE({ type: 'progress', percent: 5, stage: '读取项目数据...' });

        var project = readProject(projectId);
        if (!project) { sendSSE({ type: 'error', message: 'Project not found' }); res.end(); return; }
        var frames = project.storyboardFrames || project.storyboard || [];
        if (!frames.length && body && body.frames) frames = body.frames;
        if (!frames.length) { sendSSE({ type: 'error', message: 'No storyboard frames' }); res.end(); return; }

        console.log('[convert-to-v4] Converting ' + frames.length + ' frames for project ' + projectId);
        sendSSE({ type: 'progress', percent: 10, stage: '准备分镜数据 (' + frames.length + ' 帧)...' });

        // Build prompt for Doubao to extract entities + phases from storyboard frames
        var framesDesc = frames.map(function(f, i) {
          var parts = ['帧' + (i+1)];
          if (f.title) parts.push('标题: ' + f.title);
          if (f.scene) parts.push('场景: ' + f.scene);
          if (f.interaction) parts.push('交互: ' + f.interaction);
          if (f.camera) parts.push('镜头: ' + f.camera);
          if (f.feeling) parts.push('感受: ' + f.feeling);
          if (f.prompt) parts.push('场景描述: ' + f.prompt);
          if (f.ui) parts.push('UI: ' + f.ui);
          if (f.animation) parts.push('动画: ' + f.animation);
          if (f.note) parts.push('备注: ' + f.note);
          if (f.scriptExcerpt) parts.push('脚本: ' + f.scriptExcerpt);
          return parts.join('\n');
        }).join('\n---\n');

        sendSSE({ type: 'progress', percent: 15, stage: '加载 V4 Schema 和模板...' });

        var v4SchemaStr = fs.readFileSync(path.join(__dirname, '..', 'docs', 'v4-schema.json'), 'utf8');
        var behaviorTemplatesStr = fs.readFileSync(path.join(__dirname, '..', 'worker', 'behavior-templates.md'), 'utf8').substring(0, 3000);

        var systemPrompt = '你是试玩广告蓝图架构师。你的任务是将分镜板（storyboard frames）转换为 V4 实体驱动蓝图。\n\n## 核心原则\n- **非线性**：不要按时间线顺序映射，而是提取所有游戏实体和它们的事件触发关系\n- **实体为中心**：每个游戏对象（角色、建筑、道具、UI、敌人）都是独立实体\n- **条件驱动**：Phase 只管"激活哪些实体"和"结束条件"，实体自己知道怎么行为\n\n## V4 数据 Schema\n' + v4SchemaStr + '\n\n## 行为模板参考\n' + behaviorTemplatesStr + '\n\n## 输出要求\n返回纯 JSON，包含:\n1. entities: 所有游戏实体数组，每个实体遵循 V4 Schema\n2. phases: 阶段数组，每个阶段定义激活的实体和结束条件\n3. globalSettings: 游戏全局设置\n\n确保:\n- 每个实体有唯一英文 name 和中文 label\n- 模板类型(template)必须是 Schema 中定义的类型之一\n- 触发条件用表达式格式如 "phase:1" 或 "entity:X.state==built"\n- Phase 的 endCondition 用简洁表达式\n- 尽量从分镜描述中推断合理的数值参数';

        var userPrompt = '请将以下分镜板转换为 V4 实体驱动蓝图：\n\n' + framesDesc + '\n\n返回纯 JSON（不要 markdown code fence）。';

        // Call OpenAI-compatible converter via Python subprocess.
        var text = '';

        sendSSE({ type: 'progress', percent: 20, stage: '调用 AI 提取实体中...' });
        console.log('[v4-convert] Calling Python AI converter for blueprint conversion...');
        var tmpFrames = '/tmp/v4-frames-' + Date.now() + '.json';
        fs.writeFileSync(tmpFrames, JSON.stringify(project.storyboard || project.storyboardFrames || []), 'utf8');

        var { spawn: spawnProc } = require('child_process');

        try {
          var pyResult = await new Promise(function(resolve, reject) {
            var args = [
              path.join(__dirname, '..', 'python', 'blueprint_converter.py'),
              '--frames-file', tmpFrames,
              '--schema-file', path.join(__dirname, '..', 'docs', 'v4-schema.json'),
              '--templates-file', path.join(__dirname, '..', 'worker', 'behavior-templates.md')
            ];
            var env = Object.assign({}, process.env, { OPENAI_API_KEY: process.env.OPENAI_API_KEY || '' });
            var child = spawnProc('python3.8', args, { env: env, timeout: 600000 });
            var stdout = '';
            var stderr = '';
            child.stdout.on('data', function(data) { stdout += data.toString(); });
            child.stderr.on('data', function(data) {
              var chunk = data.toString();
              stderr += chunk;
              // Parse structured progress lines: PROGRESS:<chars>:<seconds>
              var lines = chunk.split('\n');
              for (var li = 0; li < lines.length; li++) {
                var pm = lines[li].match(/^PROGRESS:(\d+):(\d+)/);
                if (pm) {
                  var chars = parseInt(pm[1]);
                  var secs = parseInt(pm[2]);
                  var pct = Math.min(85, 20 + Math.round((chars / 25000) * 60));
                  sendSSE({ type: 'progress', percent: pct, stage: 'AI 生成中... ' + Math.round(chars/1000) + 'K 字符, ' + secs + '秒' });
                }
              }
            });
            child.on('close', function(code) {
              try { fs.unlinkSync(tmpFrames); } catch(e) {}
              if (stderr) console.log('[v4-convert] Python: ' + stderr.substring(0, 500));
              if (code !== 0 && !stdout) return reject(new Error('Python converter failed (exit ' + code + ')'));
              resolve(stdout);
            });
            child.on('error', function(err) {
              try { fs.unlinkSync(tmpFrames); } catch(e) {}
              reject(err);
            });
          });
          sendSSE({ type: 'progress', percent: 88, stage: '解析 AI 返回结果...' });
          var parsedResult = JSON.parse(pyResult);
          if (parsedResult.error) throw new Error(parsedResult.error);
          text = JSON.stringify(parsedResult.data);
          console.log('[v4-convert] Python AI converter returned ' + text.length + ' chars');
        } catch(pyErr) {
          console.log('[v4-convert] Python AI converter failed, falling back to modelProvider: ' + pyErr.message?.substring(0, 100));
          sendSSE({ type: 'progress', percent: 30, stage: '切换到豆包备选模型...' });
          var doubaoPercent = 30;
          var doubaoTicker = setInterval(function() {
            doubaoPercent = Math.min(doubaoPercent + 3, 85);
            sendSSE({ type: 'progress', percent: doubaoPercent, stage: '豆包 AI 分析中...' });
          }, 2000);
          // Fallback via modelProvider chain.
          var mpChain = modelProvider.createDefaultChain();
          var mpResult = await Promise.race([
            mpChain.generate({ system: systemPrompt, user: userPrompt }, { temperature: 0.3, maxOutputTokens: 65536, timeoutMs: 120000 }),
            new Promise(function(_, reject) { setTimeout(function() { reject(new Error("Model provider timeout (120s)")); }, 120000); })
          ]);
          clearInterval(doubaoTicker);
          sendSSE({ type: "progress", percent: 88, stage: "解析 AI 返回结果..." });
          text = mpResult.text || "";
          console.log("[v4-convert] modelProvider fallback (" + mpResult.provider + ") returned " + text.length + " chars");
        }

        sendSSE({ type: 'progress', percent: 90, stage: '解析 JSON 结构...' });

        // Clean markdown fences
        text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

        var v4Data;
        try {
          v4Data = JSON.parse(text);
        } catch(parseErr) {
          // Try to find JSON in response
          var jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            v4Data = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('Failed to parse AI response as JSON');
          }
        }

        // Validate basic structure
        if (!v4Data.entities || !Array.isArray(v4Data.entities)) {
          throw new Error('AI response missing entities array');
        }
        if (!v4Data.phases || !Array.isArray(v4Data.phases)) {
          throw new Error('AI response missing phases array');
        }

        sendSSE({ type: 'progress', percent: 95, stage: '保存蓝图数据 (' + v4Data.entities.length + ' 实体, ' + v4Data.phases.length + ' 阶段)...' });
        console.log('[convert-to-v4] Extracted ' + v4Data.entities.length + ' entities, ' + v4Data.phases.length + ' phases');

        // Save V4 data to project
        project.entities = v4Data.entities;
        project.phases = v4Data.phases;
        project.globalSettings = v4Data.globalSettings || {};
        project.version = 4;
        ensureProjectPlans(project);
        writeProject(project);

        sendSSE({ type: 'progress', percent: 100, stage: '完成！' });
        sendSSE({
          type: 'done',
          entities: v4Data.entities,
          phases: v4Data.phases,
          globalSettings: v4Data.globalSettings || {},
        });
        res.end();
      } catch(e) {
        console.error('[convert-to-v4] Error:', e.message);
        sendSSE({ type: 'error', message: e.message });
        res.end();
      }
    },

    analyzeReference: async function(req, res, body, params) {
      var projectId = params.id;

      // Lazy-load modules
      var referenceFetcher = require('../worker/reference-fetcher.js');
      var referenceAnalyzer = require('../worker/reference-analyzer.js');
      var referenceToBlueprint = require('../worker/reference-to-blueprint.js');

      // Collect raw body before SSE
      var rawChunks = [];
      await new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() { reject(new Error('Upload timeout')); }, 60000);
        req.on('data', function(chunk) { rawChunks.push(chunk); });
        req.on('end', function() { clearTimeout(timeout); resolve(); });
        req.on('error', function(e) { clearTimeout(timeout); reject(e); });
        if (req.complete) { clearTimeout(timeout); resolve(); }
      });
      var rawBody = Buffer.concat(rawChunks);
      console.log('[analyze-reference] Body received: ' + rawBody.length + ' bytes');

      // Start SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      function sendSSE(data) {
        try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
      }

      // SSE keepalive
      var keepalive = setInterval(function() {
        try { res.write(': keepalive\n\n'); } catch(e) { clearInterval(keepalive); }
      }, 15000);

      try {
        sendSSE({ type: 'progress', percent: 2, stage: '检查项目...' });

        var project = readProject(projectId);
        if (!project) { sendSSE({ type: 'error', message: 'Project not found' }); res.end(); return; }

        sendSSE({ type: 'progress', percent: 5, stage: '处理上传...' });

        // Parse multipart
        var uploadedFiles = [];
        var formFields = {};

        await new Promise(function(resolve, reject) {
          try {
            var bb = Busboy({ headers: req.headers });
            var pendingWrites = 0;
            var busboyDone = false;
            function checkResolve() { if (busboyDone && pendingWrites === 0) resolve(); }

            bb.on('file', function(fieldname, file, info) {
              var filename = info.filename || info;
              if (typeof filename === 'object') filename = filename.filename;
              console.log('[analyze-reference] Receiving file: ' + filename);
              var uploadDir = path.join(DATA_DIR, 'uploads');
              if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
              var dest = path.join(uploadDir, 'ref_' + Date.now() + '_' + filename);
              var ws = fs.createWriteStream(dest);
              pendingWrites++;
              file.pipe(ws);
              ws.on('close', function() {
                uploadedFiles.push({ name: filename, path: dest });
                pendingWrites--;
                checkResolve();
              });
            });
            bb.on('field', function(name, val) { formFields[name] = val; });
            bb.on('close', function() { busboyDone = true; checkResolve(); });
            bb.on('error', function(e) { reject(e); });

            var { PassThrough } = require('stream');
            var pt = new PassThrough();
            pt.pipe(bb);
            pt.end(rawBody);
          } catch(e) {
            try { formFields = JSON.parse(rawBody.toString()); } catch(e2) {}
            resolve();
          }
        });

        var url = formFields.url || '';
        var description = formFields.description || '';
        var htmlFile = uploadedFiles.find(function(f) { return /\.html?$/i.test(f.name); });

        if (!url && !htmlFile) {
          sendSSE({ type: 'error', message: '请提供竞品链接或上传 HTML 文件' });
          res.end();
          return;
        }

        // Step 1: Fetch reference
        sendSSE({ type: 'progress', percent: 10, stage: '获取竞品资源...' });
        function log(msg) { console.log(msg); }

        var fetchResult;
        try {
          fetchResult = await referenceFetcher.fetchReference(
            { url: url || null, htmlPath: htmlFile ? htmlFile.path : null },
            log, projectId
          );
        } catch (e) {
          sendSSE({ type: 'error', message: '获取资源失败: ' + e.message });
          res.end();
          return;
        }

        sendSSE({ type: 'progress', percent: 25, stage: '资源获取完成，框架: ' + (fetchResult.metadata.framework || 'unknown') });

        // Step 2: Analyze with Playwright
        sendSSE({ type: 'progress', percent: 30, stage: '运行截图分析...' });

        var analysis;
        try {
          analysis = await referenceAnalyzer.analyzeReference(
            fetchResult.htmlPath, fetchResult.metadata, log, projectId
          );
        } catch (e) {
          console.error('[analyze-reference] Analyzer error:', e.message);
          analysis = {
            screenshots: [],
            interactionFlow: [],
            staticAnalysis: {},
            ctaDetected: false,
            phaseCount: 0,
          };
          sendSSE({ type: 'progress', percent: 40, stage: '截图分析失败，使用纯代码分析...' });
        }

        sendSSE({ type: 'progress', percent: 50, stage: '截图: ' + analysis.screenshots.length + ' 张, 交互: ' + analysis.interactionFlow.length + ' 个' });

        // Step 3: Generate blueprint via LLM
        sendSSE({ type: 'progress', percent: 60, stage: 'AI 生成蓝图...' });

        var blueprint;
        try {
          blueprint = await referenceToBlueprint.generateBlueprint(
            analysis, description, fetchResult.metadata, fetchResult.html, log, projectId
          );
        } catch (e) {
          sendSSE({ type: 'error', message: 'AI 生成蓝图失败: ' + e.message });
          res.end();
          return;
        }

        sendSSE({ type: 'progress', percent: 90, stage: '蓝图生成完成: ' + blueprint.entities.length + ' 个实体, ' + blueprint.phases.length + ' 个阶段' });

        // Step 4: Save to project
        project.blueprint = project.blueprint || {};
        project.blueprint.entities = blueprint.entities;
        project.blueprint.phases = blueprint.phases;
        project.blueprint.globalSettings = blueprint.globalSettings || {};
        project.blueprint.referenceSource = {
          type: url ? 'url' : 'file',
          value: url || (htmlFile && htmlFile.name) || '',
          framework: fetchResult.metadata.framework,
          analyzedAt: new Date().toISOString(),
          screenshotCount: analysis.screenshots.length,
          interactionCount: analysis.interactionFlow.length,
        };
        ensureProjectPlans(project);
        project.updatedAt = new Date().toISOString();
        writeProject(project);

        console.log('[analyze-reference] Done: ' + blueprint.entities.length + ' entities, ' + blueprint.phases.length + ' phases for project ' + projectId);

        sendSSE({
          type: 'done',
          entities: blueprint.entities.length,
          phases: blueprint.phases.length,
          globalSettings: blueprint.globalSettings,
          framework: fetchResult.metadata.framework,
        });
        res.end();

      } catch (e) {
        console.error('[analyze-reference] Error:', e.message);
        sendSSE({ type: 'error', message: e.message });
        res.end();
      } finally {
        clearInterval(keepalive);
      }
    },
  };
};
