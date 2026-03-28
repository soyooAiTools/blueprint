// Load .env before anything else (no dotenv dependency - manual parse)
try {
  var _envPath = require('path').join(__dirname, '.env');
  if (require('fs').existsSync(_envPath)) {
    require('fs').readFileSync(_envPath, 'utf8').split('\n').forEach(function(line) {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      var eq = line.indexOf('=');
      if (eq > 0) {
        var key = line.substring(0, eq).trim();
        var val = line.substring(eq + 1).trim().replace(/^["']|["']$/g, '');
        process.env[key] = val; // always override
      }
    });
    console.log('[env] Loaded .env from', _envPath);
  }
} catch(e) { console.warn('[env] Failed to load .env:', e.message); }

// [config-guard] Refuse to start with wrong model
(function() {
  var requiredModel = 'gemini-3.1-pro-preview';
  var currentModel = process.env.GEMINI_MODEL;
  if (!currentModel) { console.error('[config-guard] FATAL: GEMINI_MODEL not set'); process.exit(1); }
  if (currentModel !== requiredModel) { console.error('[config-guard] FATAL: GEMINI_MODEL=' + currentModel + ', expected ' + requiredModel); process.exit(1); }
  console.log('[config-guard] GEMINI_MODEL=' + currentModel + ' OK');
})();


const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const AdmZip = require('adm-zip');
const { triggerCUAReview, resetCUARetries } = require('./server-cua-review.cjs');
const notify = require('./notify.cjs');

const PORT = process.env.PORT || 3901;
const __dir = __dirname;

// 启动前清理占端口的孤儿进程（跨平台：先试 ss/lsof/fuser，都没有就用 /proc/net/tcp）
try {
  var pgPid = null;
  var pgCmds = [
    'ss -tlnp sport = :' + PORT + ' 2>/dev/null',
    'lsof -ti :' + PORT + ' 2>/dev/null',
    'fuser ' + PORT + '/tcp 2>/dev/null',
  ];
  for (var pgCmd of pgCmds) {
    try {
      var pgResult = require('child_process').execSync(pgCmd, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (pgResult) {
        var pgPidMatch = pgResult.match(/pid=(\d+)/) || pgResult.match(/^(\d+)/m);
        if (pgPidMatch) { pgPid = parseInt(pgPidMatch[1]); break; }
      }
    } catch(e2) { /* tool not available, try next */ }
  }
  // Fallback: parse /proc/net/tcp (Linux)
  if (!pgPid) {
    try {
      var pgHex = PORT.toString(16).toUpperCase().padStart(4, '0');
      var pgTcp = require('fs').readFileSync('/proc/net/tcp', 'utf8');
      var pgLines = pgTcp.split('\n').filter(function(l) { return l.indexOf(':' + pgHex) !== -1 && l.indexOf('0A') !== -1; });
      if (pgLines.length > 0) {
        var pgInode = pgLines[0].trim().split(/\s+/)[9];
        // Find PID owning this inode
        var pgDirs = require('fs').readdirSync('/proc').filter(function(d) { return /^\d+$/.test(d); });
        for (var pgDir of pgDirs) {
          try {
            var pgFds = require('fs').readdirSync('/proc/' + pgDir + '/fd');
            for (var pgFd of pgFds) {
              try {
                var pgLink = require('fs').readlinkSync('/proc/' + pgDir + '/fd/' + pgFd);
                if (pgLink.indexOf('socket:[' + pgInode + ']') !== -1) { pgPid = parseInt(pgDir); break; }
              } catch(e3) {}
            }
            if (pgPid) break;
          } catch(e3) {}
        }
      }
    } catch(e2) { /* /proc not available */ }
  }
  if (pgPid && pgPid !== process.pid) {
    console.log('[port-guard] Port ' + PORT + ' occupied by PID ' + pgPid + ', killing...');
    try { process.kill(pgPid, 'SIGTERM'); } catch(e2) {}
    var pgWait = Date.now(); while (Date.now() - pgWait < 1000) {} // busy wait 1s (no sleep cmd needed)
    try { process.kill(pgPid, 'SIGKILL'); } catch(e2) {}
    pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    console.log('[port-guard] Cleaned up PID ' + pgPid);
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
  if (status >= 500) {
    try { notify.alert('critical', 'API ' + status, JSON.stringify(data).substring(0, 200)); } catch(e) {}
  }
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
  // Auto-backup: keep last version before overwrite
  if (fs.existsSync(filePath)) {
    var backupDir = path.join('/opt/blueprint-backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var backupPath = path.join(backupDir, project.id + '.' + ts + '.json');
    try { fs.copyFileSync(filePath, backupPath); } catch(e) { console.error('[backup] Failed:', e.message); }
    // Keep max 20 backups per project, prune oldest
    try {
      var prefix = project.id + '.';
      var backups = fs.readdirSync(backupDir).filter(function(f) { return f.startsWith(prefix); }).sort();
      while (backups.length > 20) {
        fs.unlinkSync(path.join(backupDir, backups.shift()));
      }
    } catch(e) { /* ignore prune errors */ }
  }
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
  // HTML files: no cache (so new deploys take effect immediately)
  // Assets (JS/CSS with hash filenames): cache 1 year
  var cacheControl = ext === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=31536000, immutable';
  var headers = {
    'Content-Type': mime,
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
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
  if (m && method === 'POST') return { handler: 'editFrame', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/upload-style-ref$/);
  if (m && method === 'POST') return { handler: 'uploadStyleRef', id: m[1], rawBody: true };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/generate-storyboard$/);   
  if (m && method === "POST") return { handler: "generateStoryboard", id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/generate-storyboard-pdf$/);
  if (m && method === "POST") return { handler: "generateStoryboardPDF", id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/parse-and-blueprint$/);
  if (m && method === 'POST') return { handler: 'parseAndBlueprint', id: m[1], rawBody: true };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/parse-video$/);
  if (m && method === 'POST') return { handler: 'parseVideo', id: m[1], rawBody: true };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/convert-to-v4$/);
  if (m && method === 'POST') return { handler: 'convertToV4', id: m[1] };

  // Spec review routes
  m = pathname.match(/^\/api\/projects\/([^/]+)\/specs$/);
  if (m && method === 'GET') return { handler: 'getSpecs', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/confirm-specs$/);
  if (m && method === 'POST') return { handler: 'confirmSpecs', id: m[1] };

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
  if (method === 'GET' && pathname === '/api/dashboard/stats') return { handler: 'getDashboardStats' };
  if (method === 'GET' && pathname === '/api/dashboard/api-health') return { handler: 'getApiHealth' };

  // Serve generated images
  m = pathname.match(/^\/api\/images\/([^/]+)\/(.+)$/);
  if (m && method === 'GET') return { handler: 'serveImage', projectId: m[1], filename: m[2] };

  return null;
}

// ============ API Handlers ============

var activeGenerations = 0;  // Track ongoing image generations for graceful shutdown
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

  // Sync status to autocoding task file (if exists)
  try {
    var taskFile = path.join(AUTOCODING_QUEUE, id + '.json');
    if (fs.existsSync(taskFile)) {
      var task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      var needSync = false;
      if (data.status !== undefined && task.status !== data.status) {
        // Map project status to task status
        var statusMap = { 'editing': 'cancelled', 'submitted': 'pending', 'reviewing': 'reviewing' };
        if (statusMap[data.status]) { task.status = statusMap[data.status]; needSync = true; }
      }
      if (data.name !== undefined && task.projectName !== project.name) {
        task.projectName = project.name; needSync = true;
      }
      if (needSync) {
        task.updatedAt = new Date().toISOString();
        fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');
        console.log('[updateProject] Synced task file: ' + id + ' status=' + task.status);
      }
    }
  } catch(syncErr) {
    console.error('[updateProject] Task sync failed:', syncErr.message);
  }

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
  // V3 全局字段
  if (data.objectRegistry !== undefined) project.blueprint.objectRegistry = data.objectRegistry;
  if (data.globalParams !== undefined) project.blueprint.globalParams = data.globalParams;
  if (data.globalSettings !== undefined) project.blueprint.globalSettings = data.globalSettings;
  // V4 实体列表
  if (data.entities !== undefined) project.blueprint.entities = data.entities;
  project.updatedAt = new Date().toISOString();
  writeProject(project);
  sendJSON(res, { success: true, updatedAt: project.updatedAt });
};

handlers.submitProject = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  if (project.status !== 'editing' && project.status !== 'feedback' && project.status !== 'failed') {
    return sendJSON(res, { error: '当前状态「' + project.status + '」不允许提交' }, 400);
  }

  // Reset CUA retry counter on manual submit
  resetCUARetries(id);

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

  project.autoCodingTaskId = taskId;
  project.updatedAt = new Date().toISOString();

  // If storyboard frames exist and not a feedback resubmit, extract specs first
  var hasStoryboard = project.storyboardFrames && project.storyboardFrames.length > 0;
  if (hasStoryboard && !isFeedbackResubmit) {
    project.status = 'spec_extracting';
    writeProject(project);
    
    // Async spec extraction — don't block response
    (async function() {
      try {
        var specExtractor = require('./spec-extractor.cjs');
        console.log('[submit] Extracting specs from ' + project.storyboardFrames.length + ' frames...');
        var specs = await specExtractor.extractSpecs(project.storyboardFrames, {
          projectName: project.name,
          gameType: 'SLG',
        });
        project.specs = specs;
        project.status = 'spec_review';
        project.updatedAt = new Date().toISOString();
        writeProject(project);
        console.log('[submit] Specs extracted: ' + specs.length + ' phases, waiting for review');
      } catch(specErr) {
        console.error('[submit] Spec extraction failed, proceeding without specs:', specErr.message);
        // Fallback: skip spec review, go directly to submitted
        project.status = 'submitted';
        project.updatedAt = new Date().toISOString();
        writeProject(project);
        task.status = 'pending';
        fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');
        wakeOpenClaw('[蓝图编辑器] 新任务已提交(spec提取失败,跳过)。项目: ' + project.name + ', taskId: ' + taskId);
      }
    })();
    
    sendJSON(res, { success: true, status: 'spec_extracting', message: '正在提取体验规格，完成后请确认...' });
    return;
  }

  project.status = 'submitted';
  writeProject(project);
  task.status = 'pending';
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');

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
    objectRegistry: bp.objectRegistry || [],
    globalParams: bp.globalParams || '',
    globalSettings: bp.globalSettings || {},
    entities: bp.entities || [],
    feedbackHistory: project.feedbackHistory || [],
    storyboard: {
      frames: project.storyboardFrames || [],
      characterSheet: project.characterSheet || {},
      sceneSheet: project.sceneSheet || {},
      config: project.storyboardConfig || {},
    },
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

  // Auto-resubmit to autoCoding pipeline after feedback
  try {
    console.log('[feedback] Auto-resubmitting project ' + id + ' to autoCoding pipeline...');
    var taskId = id;
    var blueprintExport = exportBlueprintForAgent(project);
    var bpPath = path.join(AUTOCODING_QUEUE, taskId + '-blueprint.json');
    fs.writeFileSync(bpPath, JSON.stringify(blueprintExport, null, 2), 'utf-8');

    var taskFile = path.join(AUTOCODING_QUEUE, taskId + '.json');
    var task;
    if (fs.existsSync(taskFile)) {
      task = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));
      task.status = 'fix_needed';
      task.blueprintPath = bpPath;
      if (project.feedbackHistory && project.feedbackHistory.length > 0) {
        task.latestFeedback = project.feedbackHistory[project.feedbackHistory.length - 1];
      }
      task.updatedAt = new Date().toISOString();
    } else {
      task = {
        taskId: taskId,
        projectName: project.name,
        svnUrl: project.svnUrl || '',
        blueprintPath: bpPath,
        status: 'fix_needed',
        latestFeedback: project.feedbackHistory[project.feedbackHistory.length - 1],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');
    console.log('[feedback] Task resubmitted: ' + taskFile);
    wakeOpenClaw('Feedback resubmitted for ' + project.name);
  } catch(e) {
    console.error('[feedback] Auto-resubmit failed: ' + e.message);
  }

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

  var uploadedFile = fs.existsSync(path.join(webglDir, 'iframe.html')) ? 'iframe.html' : 'index.html';
  project.webglPath = '/webgl/' + id + '/' + uploadedFile;
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
  var hasIframe = fs.existsSync(path.join(webglDir, 'iframe.html'));
  var hasIndex = fs.existsSync(path.join(webglDir, 'index.html'));
  var hasWebgl = hasIframe || hasIndex;
  // Prefer iframe.html (actual game) over index.html (Luna Dev Environment)
  var webglFile = hasIframe ? 'iframe.html' : 'index.html';
  sendJSON(res, {
    available: hasWebgl,
    url: hasWebgl ? '/webgl/' + id + '/' + webglFile : null,
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
    
    // Find first task this worker hasn't claimed yet
    // Multi-worker support: each worker independently processes the same task
    var workerType = workerId.startsWith('linux') ? 'linux' : 'windows';
    for (var i = 0; i < taskFiles.length; i++) {
      var taskPath = path.join(AUTOCODING_QUEUE, taskFiles[i]);
      var task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
      
      // Initialize workerAssignments if missing
      if (!task.workerAssignments) task.workerAssignments = {};
      
      var workerState = task.workerAssignments[workerType];
      var taskAvailable = (task.status === 'pending' || task.status === 'fix_needed' || task.status === 'assigned');
      
      // This worker can claim if: task is available AND this workerType hasn't claimed it yet
      if (taskAvailable && (!workerState || workerState === 'pending' || workerState === 'fix_needed')) {
        var originalStatus = workerState || task.status;
        
        // Mark this worker's assignment
        task.workerAssignments[workerType] = 'assigned';
        task.workerAssignments[workerType + '_workerId'] = workerId;
        task.workerAssignments[workerType + '_assignedAt'] = new Date().toISOString();
        
        // Overall task status: assigned if any worker has it
        task.status = 'assigned';
        task.assignedTo = workerId;
        task.assignedAt = new Date().toISOString();
        fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), 'utf-8');
        
        task.originalStatus = (originalStatus === 'pending' || originalStatus === 'fix_needed') ? originalStatus : 'pending';
        console.log('[Worker Poll] Assigned task ' + task.taskId + ' (' + task.originalStatus + ') to ' + workerType + ' worker ' + workerId);
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

    // Update task file if exists (with per-worker tracking)
    var taskPath = path.join(AUTOCODING_QUEUE, taskId + '.json');
    if (fs.existsSync(taskPath)) {
      var task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
      var wType = workerId.startsWith('linux') ? 'linux' : 'windows';
      
      // Update per-worker status
      if (!task.workerAssignments) task.workerAssignments = {};
      task.workerAssignments[wType] = status;
      task.workerAssignments[wType + '_message'] = message || '';
      task.workerAssignments[wType + '_updatedAt'] = new Date().toISOString();
      
      // Overall task status = best of both workers
      // done > processing > assigned > fix_needed > pending > failed
      var statusPriority = { done: 6, cua_passed: 5, processing: 4, assigned: 3, fix_needed: 2, pending: 1, failed: 0 };
      var bestStatus = status;
      var types = ['linux', 'windows'];
      for (var ti = 0; ti < types.length; ti++) {
        var ws = task.workerAssignments[types[ti]];
        if (ws && (statusPriority[ws] || 0) > (statusPriority[bestStatus] || 0)) {
          bestStatus = ws;
        }
      }
      task.status = bestStatus;
      if (message) task.statusMessage = message;
      if (data.previewUrl) task.previewUrl = data.previewUrl;
      task.updatedAt = new Date().toISOString();

      // Append to timeline for dashboard live tracking
      if (!task.timeline) task.timeline = [];
      task.timeline.push({
        status: status,
        message: message || '',
        workerId: workerId,
        timestamp: Date.now()
      });
      // Keep last 50 entries
      if (task.timeline.length > 50) task.timeline = task.timeline.slice(-50);

      // Save quality gate data if provided
      if (data.qualityData) {
        if (data.qualityData.reviewResult) task.reviewResult = data.qualityData.reviewResult;
        if (data.qualityData.quickTestResult) task.quickTestResult = data.qualityData.quickTestResult;
        if (data.qualityData.cuaResult) task.cuaResult = data.qualityData.cuaResult;
        if (data.qualityData.cuaRetries) task.cuaRetries = data.qualityData.cuaRetries;
      }

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

// In-memory parse-and-blueprint stats (persisted to file on update)
var parseStats = { total: 0, success: 0, failed: 0, totalTimeMs: 0, history: [] };
var PARSE_STATS_FILE = path.join(__dir, 'server-data', 'parse-stats.json');
try {
  if (fs.existsSync(PARSE_STATS_FILE)) {
    parseStats = JSON.parse(fs.readFileSync(PARSE_STATS_FILE, 'utf-8'));
    if (!parseStats.history) parseStats.history = [];
  }
} catch(e) { console.warn('[stats] Failed to load parse-stats.json:', e.message); }

function recordParseStat(success, timeMs, entities, phases, error) {
  parseStats.total++;
  if (success) parseStats.success++;
  else parseStats.failed++;
  if (timeMs) parseStats.totalTimeMs += timeMs;
  parseStats.history.push({
    success: success,
    timeMs: timeMs || 0,
    entities: entities || 0,
    phases: phases || 0,
    error: error || null,
    timestamp: Date.now()
  });
  // Keep last 100 entries
  if (parseStats.history.length > 100) parseStats.history = parseStats.history.slice(-100);
  try { fs.writeFileSync(PARSE_STATS_FILE, JSON.stringify(parseStats, null, 2)); } catch(e) {}
}

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

      // Fix absolute paths to relative in HTML files (Luna uses absolute /static/, /favicon/ etc.)
      ['index.html', 'iframe.html'].forEach(function(htmlFile) {
        var htmlPath = path.join(webglDir, htmlFile);
        if (fs.existsSync(htmlPath)) {
          var content = fs.readFileSync(htmlPath, 'utf-8');
          content = content.replace(/href="\//g, 'href="./').replace(/src="\//g, 'src="./');
          // Fix Windows backslashes in paths (Luna on Windows generates backslash paths)
          content = content.replace(/src="([^"]*?)\\([^"]*?)"/g, function(m) { return m.replace(/\\/g, '/'); });
          fs.writeFileSync(htmlPath, content, 'utf-8');
          console.log('[Upload Build] Fixed paths in ' + htmlFile);
        }
      });

      // Update project status
      var project = readProject(taskId);
      var buildFile = fs.existsSync(path.join(taskDir, 'iframe.html')) ? 'iframe.html' : 'index.html';
      if (project) {
        project.status = 'reviewing';
        project.webglPath = '/webgl/' + taskId + '/' + buildFile;
        project.buildCompletedAt = new Date().toISOString();
        project.updatedAt = new Date().toISOString();
        writeProject(project);
        console.log('[Upload Build] Project updated: status=reviewing, webglPath=' + project.webglPath);
      }

      sendJSON(res, {
        success: true,
        url: '/webgl/' + taskId + '/' + buildFile,
        webglPath: '/webgl/' + taskId + '/index.html',
      });

      // CUA verification is now done on Worker side (before upload)
      // Only verified builds reach this point
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
      var config = {
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
        frames = await storyboardParser.parseScript(allText, { ...config, images: imageParts, docPath: pdfPath, charRefImage: charRefPart });
      } finally {
        clearInterval(heartbeat);
      }

      sendSSE({ type: 'progress', percent: 90, stage: '解析完成，保存中...' });

      // Save frames to project
      try {
        var proj = readProject(projectId);
        if (proj) {
          proj.storyboardFrames = frames.frames || [];
          proj.storyboardConfig = config;
          proj.characterSheet = frames.characterSheet || {};
          proj.sceneSheet = frames.sceneSheet || {};
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
};

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

handlers.saveStoryboard = function(req, res, body, id) {
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

handlers.uploadStyleRef = function(req, res, body, projectId) {
  var Busboy = require('busboy');
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
};

handlers.generateStoryboard = function(req, res, body, projectId) {
  activeGenerations++;
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
          // styleRefUrl could be /api/images/projId/filename or just a filename
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
      activeGenerations--;
    } catch(e) {
      console.error('[generate-storyboard] Error:', e.message);
      try { notify.alert('critical', '配图生成失败', e.message); } catch(ne) {}
      try { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n'); res.end(); } catch(x) {}
      activeGenerations--;
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


// ========================
// Parse & Blueprint (One-Shot): PDF → V4 蓝图，一次 AI 调用
// ========================
handlers.parseAndBlueprint = async function(req, res, body, projectId) {
  var fs = require('fs');
  var path = require('path');
  
  // Parse multipart form data (same as parseStoryboard)
  var Busboy;
  try { Busboy = require('busboy'); } catch(e) {
    // Fallback: try to get files from existing upload handling
  }
  
  // *** STEP 1: Collect raw body BEFORE starting SSE response ***
  // This prevents the req stream from conflicting with the SSE response
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
    // Collect raw body first, then parse with busboy from buffer
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
          var uploadDir = path.join(__dirname, 'server-data', 'uploads');
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          var dest = path.join(uploadDir, Date.now() + '_' + filename);
          var ws = fs.createWriteStream(dest);
          pendingWrites++;
          file.pipe(ws);
          ws.on('close', function() {
            var size = 0;
            try { size = require('fs').statSync(dest).size; } catch(e) {}
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
      // Try to find the most recent upload
      var uploadsDir = path.join(__dirname, 'server-data', 'uploads');
      if (fs.existsSync(uploadsDir)) {
        var files = fs.readdirSync(uploadsDir).filter(function(f) { return /\.pdf$/i.test(f); }).sort().reverse();
        if (files.length > 0) {
          pdfFile = { name: files[0], path: path.join(uploadsDir, files[0]) };
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
        '/opt/blueprint-editor/python/pdf_to_blueprint.py',
        '--schema-file', '/opt/blueprint-editor/docs/v4-schema.json',
        '--templates-file', '/opt/blueprint-editor/worker/behavior-templates.md',
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
};

handlers.convertToV4 = async function(req, res, body, projectId) {
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
    if (!frames.length && body.frames) frames = body.frames;
    if (!frames.length) { sendSSE({ type: 'error', message: 'No storyboard frames' }); res.end(); return; }

    console.log('[convert-to-v4] Converting ' + frames.length + ' frames for project ' + projectId);
    sendSSE({ type: 'progress', percent: 10, stage: '准备分镜数据 (' + frames.length + ' 帧)...' });

    // Build prompt for Gemini to extract entities + phases from storyboard frames
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

    var v4SchemaStr = require('fs').readFileSync('/opt/blueprint-editor/docs/v4-schema.json', 'utf8');
    var behaviorTemplatesStr = require('fs').readFileSync('/opt/blueprint-editor/worker/behavior-templates.md', 'utf8').substring(0, 3000);

    var systemPrompt = `你是试玩广告蓝图架构师。你的任务是将分镜板（storyboard frames）转换为 V4 实体驱动蓝图。

## 核心原则
- **非线性**：不要按时间线顺序映射，而是提取所有游戏实体和它们的事件触发关系
- **实体为中心**：每个游戏对象（角色、建筑、道具、UI、敌人）都是独立实体
- **条件驱动**：Phase 只管"激活哪些实体"和"结束条件"，实体自己知道怎么行为

## V4 数据 Schema
${v4SchemaStr}

## 行为模板参考
${behaviorTemplatesStr}

## 输出要求
返回纯 JSON，包含:
1. entities: 所有游戏实体数组，每个实体遵循 V4 Schema
2. phases: 阶段数组，每个阶段定义激活的实体和结束条件
3. globalSettings: 游戏全局设置

确保:
- 每个实体有唯一英文 name 和中文 label
- 模板类型(template)必须是 Schema 中定义的类型之一
- 触发条件用表达式格式如 "phase:1" 或 "entity:X.state==built"
- Phase 的 endCondition 用简洁表达式
- 尽量从分镜描述中推断合理的数值参数`;

    var userPrompt = `请将以下分镜板转换为 V4 实体驱动蓝图：

${framesDesc}

返回纯 JSON（不要 markdown code fence）。`;

    // Call GPT-5.4 via Python subprocess (stable streaming)
    var fs = require('fs');
    var text = '';
    
    sendSSE({ type: 'progress', percent: 20, stage: '调用 AI 提取实体中...' });
    console.log('[v4-convert] Calling GPT-5.4 via Python for blueprint conversion...');
    var tmpFrames = '/tmp/v4-frames-' + Date.now() + '.json';
    fs.writeFileSync(tmpFrames, JSON.stringify(project.storyboard || project.storyboardFrames || []), 'utf8');
    
    var { spawn: spawnProc } = require('child_process');

    try {
      var pyResult = await new Promise(function(resolve, reject) {
        var args = [
          '/opt/blueprint-editor/python/blueprint_converter.py',
          '--frames-file', tmpFrames,
          '--schema-file', '/opt/blueprint-editor/docs/v4-schema.json',
          '--templates-file', '/opt/blueprint-editor/worker/behavior-templates.md'
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
              // Estimate percent: typical response is 15000-30000 chars over 60-120s
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
      var parsed = JSON.parse(pyResult);
      if (parsed.error) throw new Error(parsed.error);
      text = JSON.stringify(parsed.data);
      console.log('[v4-convert] Python GPT-5.4 returned ' + text.length + ' chars');
    } catch(pyErr) {
      console.log('[v4-convert] Python failed, falling back to Gemini: ' + pyErr.message?.substring(0, 100));
      sendSSE({ type: 'progress', percent: 30, stage: '切换到 Gemini 备选模型...' });
      // Simple ticker for Gemini (no stderr progress)
      var geminiPercent = 30;
      var geminiTicker = setInterval(function() {
        geminiPercent = Math.min(geminiPercent + 3, 85);
        sendSSE({ type: 'progress', percent: geminiPercent, stage: 'Gemini AI 分析中...' });
      }, 2000);
      // Fallback to Gemini
      var ai = require('./storyboard-parser.cjs').getAI ? require('./storyboard-parser.cjs').getAI() : null;
      if (!ai) {
        var { GoogleGenAI } = require('@google/genai');
        var keyRotation = require('./key-rotation.cjs');
        ai = new GoogleGenAI({ apiKey: keyRotation.getKey() });
      }
      var result = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: { temperature: 0.3, maxOutputTokens: 65536, systemInstruction: systemPrompt },
        }),
        new Promise(function(_, reject) { setTimeout(function() { reject(new Error('Gemini timeout (120s)')); }, 120000); })
      ]);
      clearInterval(geminiTicker);
      sendSSE({ type: 'progress', percent: 88, stage: '解析 AI 返回结果...' });
      if (result.candidates && result.candidates[0]) {
        var parts = result.candidates[0].content.parts || [];
        for (var p = 0; p < parts.length; p++) {
          if (parts[p].text) text += parts[p].text;
        }
      } else if (result.text) {
        text = typeof result.text === 'function' ? result.text() : result.text;
      }
      console.log('[v4-convert] Gemini returned ' + text.length + ' chars');
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

// ============ Spec Review Handlers ============

handlers.getSpecs = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  sendJSON(res, {
    specs: project.specs || [],
    status: project.status,
    projectName: project.name,
  });
};

handlers.confirmSpecs = function(req, res, body, id) {
  var project = readProject(id);
  if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
  if (project.status !== 'spec_review') {
    return sendJSON(res, { error: '当前状态「' + project.status + '」不在 spec 审核阶段' }, 400);
  }

  try {
    var data = JSON.parse(body);
    if (data.specs && Array.isArray(data.specs)) {
      project.specs = data.specs; // Save edited specs
    }
  } catch(e) { /* no body or parse error, keep existing specs */ }

  // Save specs for CUA verification
  try {
    var specsDir = path.join(WEBGL_DIR, id);
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'specs.json'), JSON.stringify(project.specs, null, 2), 'utf-8');
    console.log('[confirm-specs] Specs saved for CUA verification: ' + project.specs.length + ' phases');
  } catch(e) {
    console.error('[confirm-specs] Failed to save specs for CUA:', e.message);
  }

  // Now proceed with normal submit flow
  var taskId = id;
  var blueprintExport = exportBlueprintForAgent(project);
  var blueprintPath = path.join(AUTOCODING_QUEUE, taskId + '-blueprint.json');

  // Inject specs into blueprint export
  blueprintExport.specs = project.specs;
  fs.writeFileSync(blueprintPath, JSON.stringify(blueprintExport, null, 2), 'utf-8');

  var taskFile = path.join(AUTOCODING_QUEUE, taskId + '.json');
  var task = {
    taskId: taskId,
    projectName: project.name,
    svnUrl: project.svnUrl || '',
    blueprintPath: blueprintPath,
    blueprintEditorId: id,
    blueprintServerUrl: 'http://localhost:' + PORT,
    status: 'pending',
    source: 'blueprint-editor',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), 'utf-8');

  project.status = 'submitted';
  project.updatedAt = new Date().toISOString();
  writeProject(project);

  wakeOpenClaw('[蓝图编辑器] Spec 已确认，任务已提交。项目: ' + project.name + ', taskId: ' + taskId);
  sendJSON(res, { success: true, status: 'submitted', specsCount: (project.specs || []).length });
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

// GET /api/dashboard/stats — comprehensive dashboard stats
handlers.getDashboardStats = function(req, res) {
  var workers = Object.values(workerHeartbeats);
  var now = Date.now();
  var onlineThreshold = 90000;

  // Worker stats
  var onlineWorkers = workers.filter(function(w) { return w.lastSeen && (now - new Date(w.lastSeen).getTime()) < onlineThreshold; });
  
  // Task stats from queue
  var taskStats = { pending: 0, assigned: 0, processing: 0, developing: 0, building: 0, completed: 0, failed: 0, retry_pending: 0 };
  var recentTasks = [];
  try {
    if (fs.existsSync(AUTOCODING_QUEUE)) {
      var files = fs.readdirSync(AUTOCODING_QUEUE).filter(function(f) { return f.endsWith('.json') && !f.includes('-blueprint'); });
      files.forEach(function(f) {
        try {
          var t = JSON.parse(fs.readFileSync(path.join(AUTOCODING_QUEUE, f), 'utf-8'));
          var isCancelled = f.includes('.cancelled');
          var s = isCancelled ? 'cancelled' : (t.status || 'pending');
          if (!isCancelled) {
            if (taskStats[s] !== undefined) taskStats[s]++;
            else taskStats[s] = 1;
          }
          recentTasks.push({
            taskId: t.taskId || f.replace('.cancelled.json', '').replace('.json', ''),
            projectName: t.projectName || '-',
            status: s,
            statusMessage: t.statusMessage || null,
            previewUrl: t.previewUrl || null,
            workerId: t.assignedTo || null,
            progress: t.progress || 0,
            createdAt: t.createdAt ? new Date(t.createdAt).getTime() : null,
            updatedAt: t.updatedAt ? new Date(t.updatedAt).getTime() : null,
            timeline: (t.timeline || []).slice(-20),
            reviewResult: t.reviewResult || null,
            quickTestResult: t.quickTestResult || null,
            cuaResult: t.cuaResult || null,
            cuaRetries: t.cuaRetries || 0
          });
        } catch(e) {}
      });
    }
  } catch(e) {}
  recentTasks.sort(function(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

  // Project stats
  var projectStats = { total: 0, editing: 0, submitted: 0, reviewing: 0, approved: 0, feedback: 0, committed: 0, failed: 0 };
  try {
    var projDir = path.join(__dir, 'server-data', 'projects');
    if (fs.existsSync(projDir)) {
      fs.readdirSync(projDir).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
        try {
          var p = JSON.parse(fs.readFileSync(path.join(projDir, f), 'utf-8'));
          projectStats.total++;
          var s = p.status || 'editing';
          if (projectStats[s] !== undefined) projectStats[s]++;
          else projectStats[s] = 1;
        } catch(e) {}
      });
    }
  } catch(e) {}

  // Parse stats
  var avgTimeMs = parseStats.success > 0 ? Math.round(parseStats.totalTimeMs / parseStats.success) : 0;
  var last24h = parseStats.history.filter(function(h) { return h.timestamp > now - 86400000; });
  var last24hSuccess = last24h.filter(function(h) { return h.success; }).length;
  var last24hFailed = last24h.filter(function(h) { return !h.success; }).length;
  var successRate = parseStats.total > 0 ? Math.round(parseStats.success / parseStats.total * 100) : 0;

  // Quality gate stats
  var qualityStats = { reviewPassed: 0, reviewFailed: 0, quickTestPassed: 0, quickTestFailed: 0, cuaPassed: 0, cuaFailed: 0, totalCuaRounds: 0, cuaCount: 0 };
  recentTasks.forEach(function(t) {
    if (t.reviewResult === 'pass') qualityStats.reviewPassed++;
    else if (t.reviewResult === 'fail') qualityStats.reviewFailed++;
    if (t.quickTestResult === 'pass') qualityStats.quickTestPassed++;
    else if (t.quickTestResult === 'fail') qualityStats.quickTestFailed++;
    if (t.cuaResult === 'pass') qualityStats.cuaPassed++;
    else if (t.cuaResult === 'fail') qualityStats.cuaFailed++;
    if (t.cuaRetries > 0) { qualityStats.totalCuaRounds += t.cuaRetries; qualityStats.cuaCount++; }
  });

  sendJSON(res, {
    workers: {
      total: workers.length,
      online: onlineWorkers.length,
      offline: workers.length - onlineWorkers.length,
      list: workers.map(function(w) {
        var lastHbMs = w.lastSeen ? new Date(w.lastSeen).getTime() : null;
        var isOnline = lastHbMs && (now - lastHbMs) < onlineThreshold;
        return {
          workerId: w.workerId,
          status: isOnline ? (w.status || 'idle') : 'offline',
          currentTask: w.currentTask ? (typeof w.currentTask === 'string' ? w.currentTask : w.currentTask.taskId || null) : null,
          currentTaskName: w.currentTask && w.currentTask.projectName ? w.currentTask.projectName : null,
          lastHeartbeat: lastHbMs,
          uptime: w.uptime || 0
        };
      })
    },
    tasks: taskStats,
    recentTasks: recentTasks.slice(0, 10),
    projects: projectStats,
    quality: {
      reviewPassed: qualityStats.reviewPassed,
      reviewFailed: qualityStats.reviewFailed,
      quickTestPassed: qualityStats.quickTestPassed,
      quickTestFailed: qualityStats.quickTestFailed,
      cuaPassed: qualityStats.cuaPassed,
      cuaFailed: qualityStats.cuaFailed,
      avgCuaRounds: qualityStats.cuaCount > 0 ? Math.round(qualityStats.totalCuaRounds / qualityStats.cuaCount * 10) / 10 : 0
    },
    parse: {
      total: parseStats.total,
      success: parseStats.success,
      failed: parseStats.failed,
      successRate: successRate,
      avgTimeMs: avgTimeMs,
      avgTimeSec: Math.round(avgTimeMs / 1000),
      last24h: { success: last24hSuccess, failed: last24hFailed },
      recentHistory: parseStats.history.slice(-10).reverse()
    }
  });
};

// GET /api/dashboard/api-health — check GPT-5.4 API availability
handlers.getApiHealth = async function(req, res) {
  var results = {};
  
  // Check GPT-5.4
  try {
    var start = Date.now();
    var { default: fetch } = await import('node-fetch');
    var apiBase = process.env.OPENAI_BASE_URL || 'https://sub.mindrix.app/v1';
    var apiKey = process.env.OPENAI_API_KEY || '';
    var resp = await Promise.race([
      fetch(apiBase + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'ping' }], max_completion_tokens: 5 })
      }),
      new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 15000); })
    ]);
    var latency = Date.now() - start;
    if (resp.ok) {
      results.gpt54 = { status: 'ok', latencyMs: latency };
    } else {
      var body = await resp.text().catch(function() { return ''; });
      results.gpt54 = { status: 'error', latencyMs: latency, error: resp.status + ': ' + body.substring(0, 100) };
    }
  } catch(e) {
    results.gpt54 = { status: 'down', error: e.message };
  }

  // Check Gemini relay
  try {
    var start2 = Date.now();
    var geminiBase = process.env.GOOGLE_GEMINI_BASE_URL || 'https://sub.mindrix.app';
    var geminiKey = process.env.GEMINI_API_KEY || '';
    var { default: fetch2 } = await import('node-fetch');
    var resp2 = await Promise.race([
      fetch2(geminiBase + '/v1/models', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + geminiKey }
      }),
      new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, 10000); })
    ]);
    var latency2 = Date.now() - start2;
    results.gemini = { status: resp2.ok ? 'ok' : 'error', latencyMs: latency2 };
    if (!resp2.ok) results.gemini.error = 'HTTP ' + resp2.status;
  } catch(e) {
    results.gemini = { status: 'down', error: e.message };
  }

  // Blueprint server uptime
  results.server = { status: 'ok', uptimeMs: process.uptime() * 1000, uptimeHuman: Math.round(process.uptime() / 3600) + 'h' };

  sendJSON(res, results);
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
    console.error('[FATAL] Port ' + PORT + ' still in use after port-guard. Retrying in 2s...');
    setTimeout(function() {
      server.close();
server.listen(PORT);
    }, 2000);
    return;
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
  if (activeGenerations > 0) {
    console.log('[server] ' + signal + ' received, waiting for ' + activeGenerations + ' active generation(s) to finish...');
    var waitCount = 0;
    var waitTimer = setInterval(function() {
      waitCount++;
      if (activeGenerations <= 0 || waitCount > 60) {  // Max 60s wait
        clearInterval(waitTimer);
        if (activeGenerations > 0) console.log('[server] Force shutdown after 60s with ' + activeGenerations + ' generation(s) still running');
        else console.log('[server] All generations finished, shutting down');
        process.exit(0);
      }
    }, 1000);
    return;
  }
  console.log('[server] ' + signal + ' received, closing...');
  server.close(function() {
    console.log('[server] Closed.');
    process.exit(0);
  });
  setTimeout(function() { process.exit(1); }, 3000);
}
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
