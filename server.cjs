const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const AdmZip = require('adm-zip');

const PORT = process.env.PORT || 3901;
const __dir = __dirname;

// 启动前清理占端口的孤儿进程（内联，避免 require 路径问题）
try {
  var pgResult = require('child_process').execSync(
    'ss -tlnp sport = :' + PORT + ' 2>/dev/null || true',
    { encoding: 'utf-8', timeout: 3000 }
  ).trim();
  var pgPidMatch = pgResult.match(/pid=(\d+)/);
  if (pgPidMatch) {
    var pgPid = parseInt(pgPidMatch[1]);
    if (pgPid !== process.pid) {
      console.log('[port-guard] Port ' + PORT + ' occupied by PID ' + pgPid + ', killing...');
      try { process.kill(pgPid, 'SIGTERM'); } catch(e) {}
      require('child_process').execSync('sleep 1');
      try { process.kill(pgPid, 'SIGKILL'); } catch(e) {}
      require('child_process').execSync('sleep 1');
      console.log('[port-guard] Cleaned up PID ' + pgPid);
    }
  }
} catch (e) { console.warn('[port-guard] skipped:', e.message); }

// 非 PM2 启动时警告（防止手动 node server.cjs 产生孤儿进程）
if (!process.env.pm_id) {
  console.warn('\n⚠️  未通过 PM2 启动！手动测试请用: node server.cjs &  测完记得 kill');
  console.warn('⚠️  生产启动请用: pm2 start ecosystem.config.js\n');
}

// Data directories
const DATA_DIR = path.join(__dir, 'server-data');

// autoCoding pipeline integration
const AUTOCODING_DIR = path.join(__dir, '..', 'autoCoding-tasks');
const AUTOCODING_QUEUE = path.join(AUTOCODING_DIR, 'queue');

// Signal file for OpenClaw wake — write a signal file that HEARTBEAT.md checks
const WAKE_SIGNAL_FILE = path.join(AUTOCODING_DIR, 'wake-signal.json');

function wakeOpenClaw(text) {
  try {
    fs.writeFileSync(WAKE_SIGNAL_FILE, JSON.stringify({
      text: text,
      timestamp: new Date().toISOString()
    }), 'utf-8');
    console.log('[wake] Signal file written: ' + WAKE_SIGNAL_FILE);
  } catch(e) {
    console.warn('[wake] Signal write failed: ' + e.message);
  }
}
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const WEBGL_DIR = path.join(DATA_DIR, 'webgl');
const DIST_DIR = path.join(__dir, 'dist');

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(WEBGL_DIR)) fs.mkdirSync(WEBGL_DIR, { recursive: true });

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

// ============ Helpers ============

function sendJSON(res, data, status) {
  status = status || 200;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

function readProject(id) {
  var filePath = path.join(PROJECTS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeProject(project) {
  var filePath = path.join(PROJECTS_DIR, project.id + '.json');
  fs.writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
}

function listProjects() {
  var files = fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); });
  return files.map(function(f) {
    var data = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
    var blueprint = data.blueprint;
    var summary = Object.assign({}, data);
    delete summary.blueprint;
    summary.shotCount = (blueprint && blueprint.nodes)
      ? blueprint.nodes.filter(function(n) { return n.type === 'shotNode'; }).length
      : 0;
    return summary;
  });
}

function generateId() {
  return 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  var ext = path.extname(filePath).toLowerCase();
  var mime = MIME[ext] || 'application/octet-stream';
  var content = fs.readFileSync(filePath);
  var headers = {
    'Content-Type': mime,
    'Content-Length': content.length,
    'Cache-Control': 'public, max-age=3600',
  };
  // Unity WebGL: .wasm files need correct MIME
  if (filePath.endsWith('.wasm')) {
    headers['Content-Type'] = 'application/wasm';
  }
  res.writeHead(200, headers);
  res.end(content);
  return true;
}

// ============ Route matching ============

function matchRoute(method, pathname) {
  // GET /api/projects
  if (method === 'GET' && pathname === '/api/projects') return { handler: 'listProjects' };
  // P3: GET /api/projects/pending (must be before :id match)
  if (method === 'GET' && pathname === '/api/projects/pending') return { handler: 'listPending' };
  // POST /api/projects
  if (method === 'POST' && pathname === '/api/projects') return { handler: 'createProject' };

  var m;
  // /api/projects/:id/...
  m = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (m) {
    if (method === 'GET') return { handler: 'getProject', id: m[1] };
    if (method === 'PUT') return { handler: 'updateProject', id: m[1] };
    if (method === 'DELETE') return { handler: 'deleteProject', id: m[1] };
  }
  m = pathname.match(/^\/api\/projects\/([^/]+)\/blueprint$/);
  if (m && method === 'PUT') return { handler: 'saveBlueprint', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/submit$/);
  if (m && method === 'POST') return { handler: 'submitProject', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/feedback$/);
  if (m && method === 'POST') return { handler: 'submitFeedback', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/approve$/);
  if (m && method === 'POST') return { handler: 'approveProject', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/webgl$/);
  if (m && method === 'GET') return { handler: 'getWebgl', id: m[1] };

  // P3: New routes
  m = pathname.match(/^\/api\/projects\/([^/]+)\/status$/);
  if (m && method === 'POST') return { handler: 'updateStatus', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/upload-webgl$/);
  if (m && method === 'POST') return { handler: 'uploadWebgl', id: m[1] };
  // P5: committed callback
  m = pathname.match(/^\/api\/projects\/([^/]+)\/committed$/);
  if (m && method === 'POST') return { handler: 'committedProject', id: m[1] };

  // Storyboard routes
  m = pathname.match(/^\/api\/projects\/([^/]+)\/parse-storyboard$/);
  if (m && method === 'POST') return { handler: 'parseStoryboard', id: m[1], rawBody: true };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/storyboard$/);
  if (m && method === 'PUT') return { handler: 'saveStoryboard', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/edit-frame$/);
  m = pathname.match(/^\/api\/projects\/([^/]+)\/generate-storyboard$/);   
  if (m && method === "POST") return { handler: "generateStoryboard", id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/generate-storyboard-pdf$/);
  if (m && method === "POST") return { handler: "generateStoryboardPDF", id: m[1] };
  if (m && method === 'POST') return { handler: 'editFrame', id: m[1] };

  // Worker API routes
  if (method === 'GET' && pathname === '/api/worker/poll') return { handler: 'workerPoll' };
  m = pathname.match(/^\/api\/tasks\/([^/]+)\/blueprint$/);
  if (m && method === 'GET') return { handler: 'getTaskBlueprint', taskId: m[1] };
  if (method === 'POST' && pathname === '/api/worker/status') return { handler: 'workerStatus' };
  if (method === 'POST' && pathname === '/api/worker/heartbeat') return { handler: 'workerHeartbeat' };
  m = pathname.match(/^\/api\/tasks\/([^/]+)\/upload-build$/);
  if (m && method === 'POST') return { handler: 'uploadBuild', taskId: m[1], rawBody: true };

  // Dashboard API routes
  if (method === 'GET' && pathname === '/api/dashboard') return { handler: 'getDashboard' };
  if (method === 'GET' && pathname === '/api/workers') return { handler: 'getWorkers' };
  if (method === 'GET' && pathname === '/api/tasks') return { handler: 'getTasks' };

  // Serve generated images
  m = pathname.match(/^\/api\/images\/([^/]+)\/(.+)$/);
  if (m && method === 'GET') return { handler: 'serveImage', projectId: m[1], filename: m[2] };

  return null;
}

// ============ API Handlers ============

var handlers = {};

handlers.listProjects = function(req, res) {
  var projects = listProjects();
  projects.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
  sendJSON(res, projects);
};

handlers.createProject = function(req, res, body) {
  var data = JSON.parse(body);
  if (!data.name || !data.name.trim()) return sendJSON(res, { error: '项目名称不能为空' }, 400);
  var now = new Date().toISOString();
  var project = {
    id: generateId(),
    name: data.name.trim(),
    svnUrl: (data.svnUrl || '').trim(),
    status: 'editing',
    blueprint: { nodes: [], edges: [], projectName: data.name.trim() },
    webglPath: null,
    feedbackHistory: [],
    createdBy: '',
    createdAt: now,
    updatedAt: now,
  };
  writeProject(project);
  sendJSON(res, project, 201);
};

handlers.getProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  sendJSON(res, project);
};

handlers.updateProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var data = JSON.parse(body);
  if (data.name !== undefined) project.name = data.name.trim();
  if (data.svnUrl !== undefined) project.svnUrl = data.svnUrl.trim();
  if (data.status !== undefined) project.status = data.status;
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, project);
};

handlers.saveBlueprint = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var data = JSON.parse(body);
  project.blueprint = {
    nodes: data.nodes || [],
    edges: data.edges || [],
    projectName: data.projectName || (project.blueprint && project.blueprint.projectName) || '',
  };
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, updatedAt: project.updatedAt });
};

handlers.submitProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  if (project.status !== 'editing' && project.status !== 'feedback') {
    return sendJSON(res, { error: '当前状态「' + project.status + '」不允许提交' }, 400);
  }

  // === autoCoding pipeline integration ===
  var taskId = id; // use project id as task id for easy mapping
  var isFeedbackResubmit = project.status === 'feedback';

  // Export blueprint JSON (strip base64 images to keep it small)
  var blueprintExport = exportBlueprintForAgent(project);
  var blueprintPath = path.join(AUTOCODING_QUEUE, taskId + '-blueprint.json');
  fs.writeFileSync(blueprintPath, JSON.stringify(blueprintExport, null, 2), 'utf-8');

  // Check if task already exists (feedback resubmit)
  var taskFile = path.join(AUTOCODING_QUEUE, taskId + '.json');
  var task;
  if (isFeedbackResubmit && fs.existsSync(taskFile)) {
    // Update existing task — set status to trigger Agent B fix
    task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
    task.status = 'fix_needed';
    task.blueprintPath = blueprintPath;
    // Append feedback history
    if (project.feedbackHistory && project.feedbackHistory.length > 0) {
      task.latestFeedback = project.feedbackHistory[project.feedbackHistory.length - 1];
    }
    task.updatedAt = new Date().toISOString();
  } else {
    // Create new task
    task = {
      taskId: taskId,
      projectName: project.name,
      svnUrl: project.svnUrl || '',
      blueprintPath: blueprintPath,
      blueprintEditorId: id,
      blueprintServerUrl: 'http://localhost:' + PORT,
      unityPort: 18801,
      unityBridge: 'http://localhost:18801',
      unityProjectPath: 'C:\\Users\\S\\Desktop\\templete-SLG\\templete-SLG\\Client',
      status: 'pending',
      source: 'blueprint-editor',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agents: {
        agentA: { sessionKey: null, status: 'pending', startedAt: null, completedAt: null },
        agentB: { sessionKey: null, status: 'pending', startedAt: null, completedAt: null, fixAttempts: 0 },
        agentC: { sessionKey: null, status: 'pending', startedAt: null, completedAt: null, reviewRounds: 0 }
      },
      outputs: {
        systemYaml: null, experienceMd: null, overviewMd: null,
        unityScriptsDir: null, agentBReport: null, qcReport: null
      },
      errors: [],
      result: null
    };
  }
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');

  project.status = 'submitted';
  project.autoCodingTaskId = taskId;
  project.updatedAt = new Date().toISOString();
  writeProject(project);

  // 即时触发 OpenClaw，让编排器立刻接单
  wakeOpenClaw('[蓝图编辑器] 新任务已提交到 autoCoding 队列，请立即运行 node autoCoding-tasks/orchestrate.cjs 并执行返回的 actions。项目: ' + project.name + ', taskId: ' + taskId);

  sendJSON(res, { success: true, status: project.status, taskId: taskId });
};

// Strip base64 image data from blueprint for agent consumption
function exportBlueprintForAgent(project) {
  var bp = JSON.parse(JSON.stringify(project.blueprint));
  var nodes = bp.nodes || [];
  for (var i = 0; i < nodes.length; i++) {
    var d = nodes[i].data;
    if (!d) continue;
    // Replace base64 images with descriptions only
    if (d.images && Array.isArray(d.images)) {
      d.images = d.images.map(function(img, idx) {
        return { index: idx, name: img.name || ('image_' + idx), hasImage: true };
      });
    }
    // Strip asset binary data but keep metadata
    if (d.assets && Array.isArray(d.assets)) {
      d.assets = d.assets.map(function(a) {
        var clean = { targetName: a.targetName || '' };
        if (a.modelFile) clean.modelFileName = a.modelFile.name || 'model.fbx';
        if (a.referenceImages && a.referenceImages.length > 0) {
          clean.referenceImageCount = a.referenceImages.length;
        }
        return clean;
      });
    }
    // Keep feedback/revisions as-is (text only)
  }
  return {
    projectName: project.name,
    svnUrl: project.svnUrl || '',
    nodes: nodes,
    edges: bp.edges || [],
    feedbackHistory: project.feedbackHistory || [],
    exportedAt: new Date().toISOString()
  };
}

handlers.submitFeedback = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  if (project.status !== 'reviewing') {
    return sendJSON(res, { error: '当前状态「' + project.status + '」不允许提交反馈' }, 400);
  }
  var data = JSON.parse(body);
  var entry = {
    id: (project.feedbackHistory || []).length + 1,
    timestamp: new Date().toISOString(),
    data: data.data || data,
    status: 'pending',
  };
  if (!project.feedbackHistory) project.feedbackHistory = [];
  project.feedbackHistory.push(entry);
  project.status = 'feedback';
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, status: project.status, feedbackId: entry.id });
};

handlers.approveProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  if (project.status !== 'reviewing') {
    return sendJSON(res, { error: '当前状态「' + project.status + '」不允许通过' }, 400);
  }
  project.status = 'approved';
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, status: 'approved', message: '已通知 Coding Agent 提交 SVN' });
};

// P3: GET /api/projects/pending — return submitted/feedback projects (full data with blueprint)
handlers.listPending = function(req, res) {
  var files = fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); });
  var pending = [];
  files.forEach(function(f) {
    var data = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
    if (data.status === 'submitted' || data.status === 'feedback') {
      pending.push(data);
    }
  });
  pending.sort(function(a, b) { return new Date(a.updatedAt) - new Date(b.updatedAt); });
  sendJSON(res, pending);
};

// P3: POST /api/projects/:id/status — generic status update (for Coding Agent callbacks)
handlers.updateStatus = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var data = JSON.parse(body);
  var allowed = ['building', 'reviewing', 'committed', 'editing', 'submitted', 'feedback', 'approved'];
  if (!data.status || allowed.indexOf(data.status) === -1) {
    return sendJSON(res, { error: '无效的状态: ' + data.status }, 400);
  }
  project.status = data.status;
  if (data.message) project.statusMessage = data.message;
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, status: project.status });
};

// P3: POST /api/projects/:id/upload-webgl — upload WebGL files (JSON body)
handlers.uploadWebgl = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var data = JSON.parse(body);
  var webglDir = path.join(WEBGL_DIR, id);
  if (!fs.existsSync(webglDir)) fs.mkdirSync(webglDir, { recursive: true });

  if (data.html) {
    // Single HTML file mode
    fs.writeFileSync(path.join(webglDir, 'index.html'), data.html, 'utf-8');
  } else if (data.files && typeof data.files === 'object') {
    // Multi-file mode: { files: { "index.html": "base64...", "game.js": "base64..." } }
    var keys = Object.keys(data.files);
    for (var i = 0; i < keys.length; i++) {
      var filename = keys[i];
      // Sanitize filename — prevent path traversal
      var safeName = filename.replace(/\.\./g, '').replace(/^[/\\]+/, '');
      var fileDir = path.join(webglDir, path.dirname(safeName));
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      var content = data.files[filename];
      // Detect base64 or raw string
      if (content.match && content.match(/^[A-Za-z0-9+/=\r\n]+$/) && content.length > 100) {
        fs.writeFileSync(path.join(webglDir, safeName), Buffer.from(content, 'base64'));
      } else {
        fs.writeFileSync(path.join(webglDir, safeName), content, 'utf-8');
      }
    }
  } else {
    return sendJSON(res, { error: '请提供 html 或 files 字段' }, 400);
  }

  project.webglPath = '/webgl/' + id + '/index.html';
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, webglPath: project.webglPath });
};

// P5: POST /api/projects/:id/committed — Coding Agent SVN commit callback
handlers.committedProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var data = {};
  try { data = JSON.parse(body); } catch(e) {}
  project.status = 'committed';
  if (data.svnRevision) project.svnRevision = data.svnRevision;
  if (data.message) project.commitMessage = data.message;
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, status: 'committed', svnRevision: project.svnRevision || null });
};

handlers.getWebgl = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  var webglDir = path.join(WEBGL_DIR, id);
  var hasWebgl = fs.existsSync(webglDir) && fs.existsSync(path.join(webglDir, 'index.html'));
  sendJSON(res, {
    available: hasWebgl,
    url: hasWebgl ? '/webgl/' + id + '/index.html' : null,
    webglPath: project.webglPath,
  });
};

handlers.deleteProject = function(req, res, body, id) {
  var filePath = path.join(PROJECTS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return sendJSON(res, { error: '项目不存在' }, 404);
  fs.unlinkSync(filePath);
  var webglDir = path.join(WEBGL_DIR, id);
  if (fs.existsSync(webglDir)) fs.rmSync(webglDir, { recursive: true, force: true });

  // 清理 autoCoding 队列任务
  cleanupAutoCodingTask(id);

  sendJSON(res, { success: true });
};

// ============ Worker API Handlers ============

// GET /api/worker/poll?workerId=xxx
handlers.workerPoll = function(req, res, body) {
  var parsedUrl = url.parse(req.url, true);
  var workerId = parsedUrl.query.workerId;
  
  if (!workerId) {
    return sendJSON(res, { error: 'workerId required' }, 400);
  }

  try {
    if (!fs.existsSync(AUTOCODING_QUEUE)) {
      res.writeHead(204);
      res.end();
      return;
    }

    var files = fs.readdirSync(AUTOCODING_QUEUE);
    var taskFiles = files.filter(function(f) { return f.endsWith('.json') && !f.endsWith('.cancelled.json'); });
    
    // Find first pending task (atomic assign to prevent race condition)
    for (var i = 0; i < taskFiles.length; i++) {
      var taskPath = path.join(AUTOCODING_QUEUE, taskFiles[i]);
      var task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
      
      if (task.status === 'pending' || task.status === 'fix_needed') {
        var originalStatus = task.status;
        // Atomic lock: mark as assigned before returning
        task.status = 'assigned';
        task.assignedTo = workerId;
        task.assignedAt = new Date().toISOString();
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
        
        // Return with originalStatus so worker knows if it's new or fix
        task.originalStatus = originalStatus;
        console.log('[Worker Poll] Assigned task ' + task.taskId + ' (' + originalStatus + ') to worker ' + workerId);
        sendJSON(res, task);
        return;
      }
    }

    // No pending tasks
    res.writeHead(204);
    res.end();
  } catch (e) {
    console.error('[Worker Poll] Error: ' + e.message);
    sendJSON(res, { error: 'Poll failed: ' + e.message }, 500);
  }
};

// GET /api/tasks/:taskId/blueprint
handlers.getTaskBlueprint = function(req, res, body, taskId) {
  try {
    var blueprintPath = path.join(AUTOCODING_QUEUE, taskId + '-blueprint.json');
    
    if (!fs.existsSync(blueprintPath)) {
      return sendJSON(res, { error: 'Blueprint not found for task ' + taskId }, 404);
    }

    var blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));
    sendJSON(res, blueprint);
  } catch (e) {
    console.error('[Get Blueprint] Error: ' + e.message);
    sendJSON(res, { error: 'Failed to read blueprint: ' + e.message }, 500);
  }
};

// POST /api/worker/status
handlers.workerStatus = function(req, res, body) {
  try {
    var data = JSON.parse(body);
    var workerId = data.workerId;
    var taskId = data.taskId;
    var status = data.status;
    var message = data.message;

    if (!workerId || !taskId || !status) {
      return sendJSON(res, { error: 'workerId, taskId and status required' }, 400);
    }

    console.log('[Worker Status] ' + workerId + ' - Task ' + taskId + ': ' + status + (message ? ' (' + message + ')' : ''));

    // Update project status if exists
    var project = readProject(taskId);
    if (project) {
      project.status = status;
      if (message) project.statusMessage = message;
      project.updatedAt = new Date().toISOString();
      writeProject(project);
    }

    // Update task file if exists
    var taskPath = path.join(AUTOCODING_QUEUE, taskId + '.json');
    if (fs.existsSync(taskPath)) {
      var task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
      task.status = status;
      if (message) task.statusMessage = message;
      task.updatedAt = new Date().toISOString();
      fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
    }

    sendJSON(res, { success: true, taskId: taskId, status: status });
  } catch (e) {
    console.error('[Worker Status] Error: ' + e.message);
    sendJSON(res, { error: 'Status update failed: ' + e.message }, 500);
  }
};

// In-memory worker heartbeat storage
var workerHeartbeats = {};

// POST /api/worker/heartbeat
// POST /api/tasks/:id/upload-build — receives zip binary, extracts to webgl dir, updates project
handlers.uploadBuild = function(req, res, body, id) {
  // id comes from taskId in route match
  var taskId = id;
  console.log('[Upload Build] Receiving build for task:', taskId);

  // Read raw binary body
  var chunks = [];
  req.on('data', function(c) { chunks.push(c); });
  req.on('end', function() {
    try {
      var buffer = Buffer.concat(chunks);
      console.log('[Upload Build] Received ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB');

      // Extract zip to webgl dir
      var webglDir = path.join(WEBGL_DIR, taskId);
      if (fs.existsSync(webglDir)) fs.rmSync(webglDir, { recursive: true, force: true });
      fs.mkdirSync(webglDir, { recursive: true });

      var zip = new AdmZip(buffer);
      zip.extractAllTo(webglDir, true);
      console.log('[Upload Build] Extracted to:', webglDir);

      // Update project status
      var project = readProject(taskId);
      if (project) {
        project.status = 'reviewing';
        project.webglPath = '/webgl/' + taskId + '/index.html';
        project.buildCompletedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
        writeProject(project);
        console.log('[Upload Build] Project updated: status=reviewing, webglPath=' + project.webglPath);
      }

      sendJSON(res, {
        success: true,
        url: '/webgl/' + taskId + '/index.html',
        webglPath: '/webgl/' + taskId + '/index.html',
      });
    } catch (e) {
      console.log('[Upload Build] Error:', e.message);
      sendJSON(res, { error: e.message }, 500);
    }
  });
  return; // don't let the normal body handler process this
};

// ============ Storyboard Handlers ============
const Busboy = require('busboy');
const storyboardParser = require('./storyboard-parser.cjs');
const storyboardPdf = require('./storyboard-pdf.cjs');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

handlers.parseStoryboard = function(req, res, body, projectId) {
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
        } else {
          files.push({ path: savePath, filename: info.filename });
        }
        resolve();
      });
    }));
  });
  bb.on('close', async function() {
    try {
      await Promise.all(_fileWrites);
      // Build text from docs + text field
      var allText = fields.text || '';
      var pdfPath = null;
      console.log("[parse-storyboard] files detail:", JSON.stringify(files.map(f => ({name: f.filename, path: f.path}))));
      for (var f of files) {
        try {
          if (f.filename && f.filename.toLowerCase().endsWith('.pdf')) {
            pdfPath = f.path;
            console.log('[parse-storyboard] PDF detected:', f.filename);
          } else {
            var docText = await storyboardParser.extractDocText(f.path);
            allText += '\n\n' + docText;
          }
        } catch(e) { console.warn('[parse-storyboard] Doc extract failed:', f.filename, e.message); }
      }

      // Read image parts
      var imageParts = [];
      for (var img of images) {
        try {
          var part = storyboardParser.readImagePart(img.path);
          imageParts.push(part);
        } catch(e) { console.warn('[parse-storyboard] Image read failed:', e.message); }
      }

      if (!allText.trim() && imageParts.length === 0 && !pdfPath) {
        return sendJSON(res, { error: '请提供文案或文档' }, 400);
      }

      // Call Gemini parser
      var config = {
        orientation: fields.orientation || 'landscape',
        cameraAngle: fields.cameraAngle || 'isometric45',
        perspective: fields.perspective || 'third',
        style: fields.style || '',
      };
      var frames = await storyboardParser.parseScript(allText, { ...config, images: imageParts, docPath: pdfPath });
      // Save frames to project
      try {
        var proj = readProject(projectId);
        if (proj) {
          proj.storyboardFrames = frames.frames || [];
          proj.storyboardConfig = config;
          proj.characterSheet = frames.characterSheet || {};
          proj.updatedAt = new Date().toISOString();
          writeProject(proj);
          console.log('[parse-storyboard] Saved', (frames.frames || []).length, 'frames to project', projectId);
        }
      } catch(saveErr) { console.error('[parse-storyboard] Save frames error:', saveErr.message); }
      sendJSON(res, frames);

      // Cleanup uploaded files
      for (var f2 of [...files, ...images]) {
        try { fs.unlinkSync(f2.path); } catch(e) {}
      }
    } catch(e) {
      console.error('[parse-storyboard] Error:', e.message);
      sendJSON(res, { error: '分镜解析失败: ' + e.message }, 500);
    }
  });

  bb.on('error', function(e) {
    sendJSON(res, { error: 'Upload failed: ' + e.message }, 500);
  });

  req.pipe(bb);
};

handlers.saveStoryboard = function(req, res, body, id) {
  try {
    var data = JSON.parse(body);
    var proj = readProject(id);
    if (!proj) return sendJSON(res, { error: 'Project not found' }, 404);
    proj.storyboardFrames = data.frames || [];
    if (data.characterSheet) proj.characterSheet = data.characterSheet;
    proj.updatedAt = new Date().toISOString();
    writeProject(proj);
    sendJSON(res, { ok: true });
  } catch(e) {
    sendJSON(res, { error: e.message }, 500);
  }
};

handlers.serveImage = function(req, res, body, id) {
  // id is not used; projectId and filename come from route
  var url = require('url');
  var parsed = url.parse(req.url);
  var m = parsed.pathname.match(/^\/api\/images\/([^/]+)\/(.+)$/);
  if (!m) return sendJSON(res, { error: 'Not found' }, 404);
  var imgPath = path.join(DATA_DIR, 'images', m[1], m[2]);
  if (!fs.existsSync(imgPath)) return sendJSON(res, { error: 'Image not found' }, 404);
  serveStatic(res, imgPath);
};

handlers.generateStoryboard = function(req, res, body, projectId) {
  (async function() {
    try {
      var data = JSON.parse(body);
      var frames = data.frames || [];
      if (frames.length === 0) return sendJSON(res, { error: 'No frames' }, 400);

      // Use SSE for progress
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      var imgDir = path.join(DATA_DIR, 'images', projectId || 'default');
      if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

      var updatedFrames = [...frames];
      var completed = 0;
      var CONCURRENCY = 4;

      // Process in batches of CONCURRENCY
      for (var batchStart = 0; batchStart < frames.length; batchStart += CONCURRENCY) {
        var batch = [];
        for (var bi = batchStart; bi < Math.min(batchStart + CONCURRENCY, frames.length); bi++) {
          (function(idx) {
            batch.push((async function() {
              var frame = frames[idx];
              try {
                var imgResult = await storyboardParser.generateImage(frame.prompt || frame.title);
                var ext = (imgResult.mimeType || '').includes('png') ? '.png' : '.jpg';
                var filename = 'frame_' + frame.id + ext;
                var filePath = path.join(imgDir, filename);
                fs.writeFileSync(filePath, Buffer.from(imgResult.base64, 'base64'));
                updatedFrames[idx] = { ...frame, imageUrl: '/api/images/' + (projectId || 'default') + '/' + filename };
                console.log('[generate-storyboard] Image generated for frame ' + frame.id);
              } catch(imgErr) {
                console.error('[generate-storyboard] Image gen failed for frame ' + frame.id + ':', imgErr.message);
                updatedFrames[idx] = { ...frame, imageUrl: null, imageError: imgErr.message };
              }
              completed++;
              res.write('data: ' + JSON.stringify({ type: 'progress', current: completed, total: frames.length, frameId: frame.id }) + '\n\n');
            })());
          })(bi);
        }
        await Promise.all(batch);
      }

      // Save to project
      if (projectId) {
        try {
          var proj = readProject(projectId);
          if (proj) {
            proj.storyboardFrames = updatedFrames;
            proj.updatedAt = new Date().toISOString();
            writeProject(proj);
          }
        } catch(saveErr) { console.error('[generate-storyboard] Save error:', saveErr.message); }
      }

      res.write('data: ' + JSON.stringify({ type: 'done', frames: updatedFrames }) + '\n\n');
      res.end();
    } catch(e) {
      console.error('[generate-storyboard] Error:', e.message);
      try { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n'); res.end(); } catch(x) {}
    }
  })();
};
handlers.generateStoryboardPDF = function(req, res, body, projectId) {
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
};


handlers.editFrame = function(req, res, body) {
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
};

handlers.workerHeartbeat = function(req, res, body) {
  try {
    var data = JSON.parse(body);
    var workerId = data.workerId;
    
    if (!workerId) {
      return sendJSON(res, { error: 'workerId required' }, 400);
    }

    workerHeartbeats[workerId] = {
      workerId: workerId,
      status: data.status || 'unknown',
      currentTask: data.currentTask || null,
      uptime: data.uptime || 0,
      lastSeen: new Date().toISOString()
    };

    console.log('[Worker Heartbeat] ' + workerId + ' - ' + workerHeartbeats[workerId].status + 
                (data.currentTask ? ' (task: ' + data.currentTask.taskId + ')' : ''));

    sendJSON(res, { success: true, workerId: workerId });
  } catch (e) {
    console.error('[Worker Heartbeat] Error: ' + e.message);
    sendJSON(res, { error: 'Heartbeat failed: ' + e.message }, 500);
  }
};

// ============ Dashboard API Handlers ============

// GET /api/dashboard — summary stats
handlers.getDashboard = function(req, res) {
  var workers = Object.values(workerHeartbeats);
  var now = Date.now();
  var onlineThreshold = 90000; // 90s
  var online = workers.filter(function(w) { return w.lastSeen && (now - new Date(w.lastSeen).getTime()) < onlineThreshold; }).length;
  var offline = workers.length - online;

  // Scan queue for task stats
  var taskStats = { pending: 0, assigned: 0, developing: 0, building: 0, completed: 0, failed: 0, retry_pending: 0 };
  try {
    if (fs.existsSync(AUTOCODING_QUEUE)) {
      fs.readdirSync(AUTOCODING_QUEUE).filter(function(f) { return f.endsWith('.json') && !f.includes('-blueprint') && !f.includes('.cancelled'); }).forEach(function(f) {
        try {
          var t = JSON.parse(fs.readFileSync(path.join(AUTOCODING_QUEUE, f), 'utf-8'));
          var s = t.status || 'pending';
          if (taskStats[s] !== undefined) taskStats[s]++;
          else taskStats[s] = 1;
        } catch(e) {}
      });
    }
  } catch(e) {}

  sendJSON(res, {
    workers: { total: workers.length, online: online, offline: offline },
    tasks: taskStats
  });
};

// GET /api/workers — list all registered workers
handlers.getWorkers = function(req, res) {
  var workers = Object.values(workerHeartbeats).map(function(w) {
    var lastHbMs = w.lastSeen ? new Date(w.lastSeen).getTime() : null;
    return {
      workerId: w.workerId,
      status: w.status || 'unknown',
      currentTask: w.currentTask ? (typeof w.currentTask === 'string' ? w.currentTask : w.currentTask.taskId || w.currentTask) : null,
      currentTaskName: w.currentTask && w.currentTask.projectName ? w.currentTask.projectName : null,
      ip: w.ip || null,
      port: w.port || null,
      lastHeartbeat: lastHbMs,
      registeredAt: lastHbMs,
      uptime: w.uptime || 0
    };
  });
  sendJSON(res, { workers: workers });
};

// GET /api/tasks?limit=30 — list tasks from queue
handlers.getTasks = function(req, res) {
  var u = new URL(req.url, 'http://localhost');
  var limit = parseInt(u.searchParams.get('limit')) || 30;
  var tasks = [];
  try {
    if (fs.existsSync(AUTOCODING_QUEUE)) {
      var files = fs.readdirSync(AUTOCODING_QUEUE).filter(function(f) { return f.endsWith('.json') && !f.includes('-blueprint'); });
      files.forEach(function(f) {
        try {
          var t = JSON.parse(fs.readFileSync(path.join(AUTOCODING_QUEUE, f), 'utf-8'));
          tasks.push({
            taskId: t.taskId || f.replace('.json', ''),
            projectName: t.projectName || t.taskId || '-',
            status: t.status || 'pending',
            statusMessage: t.statusMessage || null,
            workerId: t.assignedTo || null,
            progress: t.progress || 0,
            createdAt: t.createdAt ? new Date(t.createdAt).getTime() : null,
            updatedAt: t.updatedAt ? new Date(t.updatedAt).getTime() : null
          });
        } catch(e) {}
      });
    }
  } catch(e) {}
  // Sort by updatedAt desc
  tasks.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  tasks = tasks.slice(0, limit);
  sendJSON(res, { tasks: tasks });
};

// 删除项目时清理 autoCoding 队列 + 标记任务取消
function cleanupAutoCodingTask(projectId) {
  try {
    var taskFile = path.join(AUTOCODING_QUEUE, projectId + '.json');
    var blueprintFile = path.join(AUTOCODING_QUEUE, projectId + '-blueprint.json');

    if (fs.existsSync(taskFile)) {
      // 读取任务，标记为 cancelled 再删除（留审计记录）
      var task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      var cancelledFile = path.join(AUTOCODING_QUEUE, projectId + '.cancelled.json');
      task.status = 'cancelled';
      task.cancelledAt = new Date().toISOString();
      task.cancelReason = 'project_deleted';
      fs.writeFileSync(cancelledFile, JSON.stringify(task, null, 2), 'utf-8');
      fs.unlinkSync(taskFile);
      console.log('[autoCoding] 任务已取消: ' + projectId);
    }
    if (fs.existsSync(blueprintFile)) fs.unlinkSync(blueprintFile);
  } catch (e) {
    console.warn('[autoCoding] 清理失败: ' + e.message);
  }
}

// ============ Server ============

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;
  var method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // API routes
  var route = matchRoute(method, pathname);
  if (route) {
    if (route.rawBody) {
      // Binary upload — pass req directly, handler reads raw body
      try {
        handlers[route.handler](req, res, null, route.id || route.taskId);
      } catch (e) {
        sendJSON(res, { error: e.message }, 500);
      }
    } else {
      readBody(req).then(function(body) {
        try {
          handlers[route.handler](req, res, body, route.id || route.taskId);
        } catch (e) {
          sendJSON(res, { error: e.message }, 500);
        }
      });
    }
    return;
  }

  // WebGL static files
  if (pathname.startsWith('/webgl/')) {
    var webglFile = path.join(WEBGL_DIR, pathname.slice(7));
    if (serveStatic(res, webglFile)) return;
  }

  // Dashboard page (served from project root, not dist)
  if (pathname === '/dashboard' || pathname === '/dashboard.html') {
    var dashFile = path.join(__dir, 'dashboard.html');
    if (serveStatic(res, dashFile)) return;
  }

  // Frontend static files
  var staticFile = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (serveStatic(res, staticFile)) return;

  // SPA fallback — serve index.html for non-file routes
  var indexFile = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    serveStatic(res, indexFile);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', function(err) {
  if (err.code === 'EADDRINUSE') {
    console.error('[FATAL] 端口 ' + PORT + ' 被占用！port-guard 未能清理。');
    console.error('[FATAL] 手动执行: kill $(ss -tlnp sport = :' + PORT + ' | grep -oP "pid=\\K\\d+")');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, function() {
  console.log('Blueprint Editor Server running on http://localhost:' + PORT);
  console.log('  Projects dir: ' + PROJECTS_DIR);
});

// ============ Stale Task Recovery (3 min timeout) ============
setInterval(function() {
  try {
    if (!fs.existsSync(AUTOCODING_QUEUE)) return;
    var files = fs.readdirSync(AUTOCODING_QUEUE);
    var now = Date.now();
    var STALE_MS = 3 * 60 * 1000; // 3 minutes
    files.filter(function(f) { return f.endsWith('.json') && !f.includes('-blueprint') && !f.includes('.cancelled'); }).forEach(function(f) {
      var fp = path.join(AUTOCODING_QUEUE, f);
      var task = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if ((task.status === 'processing' || task.status === 'assigned') && task.updatedAt) {
        var elapsed = now - new Date(task.updatedAt).getTime();
        if (elapsed > STALE_MS) {
          console.log('[Stale Recovery] Task ' + task.taskId + ' stuck in ' + task.status + ' for ' + Math.round(elapsed/1000) + 's, resetting to pending');
          task.status = 'pending';
          task.assignedTo = null;
          task.assignedAt = null;
          task.statusMessage = 'Auto-reset from stale ' + task.status;
          task.updatedAt = new Date().toISOString();
          fs.writeFileSync(fp, JSON.stringify(task, null, 2), 'utf-8');
        }
      }
    });
  } catch (e) {
    console.warn('[Stale Recovery] Error: ' + e.message);
  }
}, 60000); // Check every 60s


// Graceful shutdown
function gracefulShutdown(signal) {
  console.log('[server] ' + signal + ' received, closing...');
  server.close(function() {
    console.log('[server] Closed.');
    process.exit(0);
  });
  setTimeout(function() { process.exit(1); }, 3000);
}
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
