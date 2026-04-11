/**
 * Project API handlers
 * Extracted from server.cjs — project CRUD, submit, feedback, approve, specs
 */
var fs = require('fs');
var { projectSM } = require('../lib/state-machine.cjs');

/**
 * Validate project state transition. Returns error string or null if valid.
 * Never accepts force from external API — use forceProjectTransition() for internal actors.
 */
function validateProjectTransition(project, newStatus) {
  var result = projectSM.validate(project.status, newStatus);
  if (!result.valid) return result.error;
  return null;
}

/**
 * Force transition for internal actors only (watchdog, admin scripts).
 * Logs warning but allows invalid transitions.
 */
function forceProjectTransition(project, newStatus, actor) {
  var result = projectSM.validate(project.status, newStatus);
  if (!result.valid) {
    console.warn('[force][' + (actor || 'unknown') + '] ' + result.error);
  }
  project.status = newStatus;
  project.updatedAt = new Date().toISOString();
  return project;
}
var path = require('path');

module.exports.init = function(ctx) {
  var taskQueue = ctx.taskQueue;
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var listProjects = ctx.listProjects;
  var generateId = ctx.generateId;
  var notify = ctx.notify;
  var wakeOpenClaw = ctx.wakeOpenClaw;
  var resetCUARetries = ctx.resetCUARetries;

  var PORT = config.PORT;
  var DATA_DIR = config.DATA_DIR;
  var PROJECTS_DIR = config.PROJECTS_DIR;
  var WEBGL_DIR = config.WEBGL_DIR;

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
      globalSettings: bp.globalSettings || {},
      entities: (bp.entities && bp.entities.length > 0) ? bp.entities : (project.entities || []),
      feedbackHistory: project.feedbackHistory || [],
      storyboard: {
        frames: (project.storyboardFrames && project.storyboardFrames.length > 0) ? project.storyboardFrames : (bp.storyboardFrames || []),
        characterSheet: project.characterSheet || {},
        sceneSheet: project.sceneSheet || {},
        config: project.storyboardConfig || {},
      },
      phases: project.phases || [],
      exportedAt: new Date().toISOString()
    };
  }

  // 删除项目时清理 autoCoding 队列 + 标记任务取消
  function cleanupAutoCodingTask(projectId) {
    try {
      taskQueue.cancel(projectId, 'server');
      console.log('[autoCoding] 任务已取消 (SQLite): ' + projectId);
    } catch (e) {
      console.warn('[autoCoding] 清理失败: ' + e.message);
    }
  }

  return {
    listProjects: function(req, res, body, params) {
      var projects = listProjects();
      projects.sort(function(a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
      sendJSON(res, projects);
    },

    createProject: function(req, res, body, params) {
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
    },

    getProject: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      sendJSON(res, project);
    },

    updateProject: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = JSON.parse(body);
      if (data.name !== undefined) project.name = data.name.trim();
      if (data.svnUrl !== undefined) project.svnUrl = data.svnUrl.trim();
      if (data.status !== undefined) {
        var transErr = validateProjectTransition(project, data.status);
        if (transErr) return sendJSON(res, { error: transErr }, 400);
        project.status = data.status;
      }
      project.updatedAt = new Date().toISOString();
      writeProject(project);

      // Sync status to SQLite task queue (if task exists)
      try {
        var existingTask = taskQueue.get(id);
        if (existingTask) {
          var needSync = false;
          if (data.status !== undefined) {
            var statusMap = { 'editing': 'cancelled', 'submitted': 'pending', 'reviewing': 'reviewing' };
            if (statusMap[data.status]) {
              taskQueue.updateStatus(id, statusMap[data.status], 'synced from project update', 'server');
              needSync = true;
            }
          }
          if (needSync) {
            console.log('[updateProject] Synced task queue: ' + id);
          }
        }
      } catch(syncErr) {
        console.error('[updateProject] Task sync failed:', syncErr.message);
      }

      sendJSON(res, project);
    },

    saveBlueprint: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = JSON.parse(body);
      project.blueprint = {
        nodes: data.nodes || [],
        edges: data.edges || [],
        projectName: data.projectName || (project.blueprint && project.blueprint.projectName) || '',
      };
      // V4 全局设置
      if (data.globalSettings !== undefined) project.blueprint.globalSettings = data.globalSettings;
      // V4 实体列表
      if (data.entities !== undefined) project.blueprint.entities = data.entities;
      project.updatedAt = new Date().toISOString();
      writeProject(project);
      sendJSON(res, { success: true, updatedAt: project.updatedAt });
    },

    submitProject: async function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);

      var projectService = require('../engine/project-service.cjs');
      try {
        var result = await projectService.submitProject(project, {
          taskQueue: taskQueue,
          writeProject: writeProject,
          resetCUARetries: resetCUARetries,
          wakeOpenClaw: wakeOpenClaw,
          exportBlueprintForAgent: exportBlueprintForAgent,
          PORT: PORT,
          WEBGL_DIR: config.WEBGL_DIR,
        });
        sendJSON(res, { success: true, status: result.status, message: result.message || '', taskId: result.taskId });
      } catch(e) {
        sendJSON(res, { error: e.message }, 400);
      }
    },


    submitFeedback: function(req, res, body, params) {
      var id = params.id;
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
      var fbErr = validateProjectTransition(project, 'feedback');
      if (fbErr) return sendJSON(res, { error: fbErr }, 400);
      project.status = 'feedback';
      project.updatedAt = new Date().toISOString();
      writeProject(project);

      // Auto-resubmit to autoCoding pipeline after feedback (SQLite TaskQueue)
      try {
        console.log('[feedback] Auto-resubmitting project ' + id + ' to autoCoding pipeline...');
        var taskId = id;
        var blueprintExport = exportBlueprintForAgent(project);
        var feedback = project.feedbackHistory[project.feedbackHistory.length - 1];
        taskQueue.resubmit(taskId, blueprintExport, feedback);
        console.log('[feedback] Task resubmitted via SQLite: ' + taskId);
        wakeOpenClaw('Feedback resubmitted for ' + project.name);
      } catch(e) {
        console.error('[feedback] Auto-resubmit failed: ' + e.message);
      }

      sendJSON(res, { success: true, status: project.status, feedbackId: entry.id });
    },

    approveProject: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      if (project.status !== 'reviewing') {
        return sendJSON(res, { error: '当前状态「' + project.status + '」不允许通过' }, 400);
      }
      var apErr = validateProjectTransition(project, 'approved');
      if (apErr) return sendJSON(res, { error: apErr }, 400);
      project.status = 'approved';
      project.updatedAt = new Date().toISOString();
      writeProject(project);
      sendJSON(res, { success: true, status: 'approved', message: '已通知 Coding Agent 提交 SVN' });
    },

    listPending: function(req, res, body, params) {
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
    },

    committedProject: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = {};
      try { data = JSON.parse(body); } catch(e) {}
      var cmErr = validateProjectTransition(project, 'committed');
      if (cmErr) return sendJSON(res, { error: cmErr }, 400);
      project.status = 'committed';
      if (data.svnRevision) project.svnRevision = data.svnRevision;
      if (data.message) project.commitMessage = data.message;
      project.updatedAt = new Date().toISOString();
      writeProject(project);
      sendJSON(res, { success: true, status: 'committed', svnRevision: project.svnRevision || null });
    },

    deleteProject: function(req, res, body, params) {
      var id = params.id;
      var filePath = path.join(PROJECTS_DIR, id + '.json');
      if (!fs.existsSync(filePath)) return sendJSON(res, { error: '项目不存在' }, 404);
      fs.unlinkSync(filePath);
      var webglDir = path.join(WEBGL_DIR, id);
      if (fs.existsSync(webglDir)) fs.rmSync(webglDir, { recursive: true, force: true });

      // 清理 autoCoding 队列任务
      cleanupAutoCodingTask(id);

      sendJSON(res, { success: true });
    },

    getSpecs: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var specs = project.specs || [];
      // Fallback: read from spec-data file if project.specs is empty
      if (specs.length === 0) {
        var specFile = path.join(config.SPEC_DIR || path.join(DATA_DIR, '..', 'spec-data'), id, 'specs.json');
        if (fs.existsSync(specFile)) {
          try { specs = JSON.parse(fs.readFileSync(specFile, 'utf-8')); } catch(e) {}
        }
      }
      // Extract entity→visual mapping from compiled WebGL HTML
      var entityMap = [];
      var htmlFile = path.join(WEBGL_DIR, id, 'index.html');
      if (fs.existsSync(htmlFile)) {
        try {
          var html = fs.readFileSync(htmlFile, 'utf-8');
          var re = /this\.(\w+)\s*=\s*UnityEngine\.GameObject\.Find\("(__Pool_(\w+?)_(\w+?)_\d+)"\)/g;
          var m;
          var seen = {};
          while ((m = re.exec(html)) !== null) {
            var eName = m[1];
            // Skip internal/decorator names
            if (/^(groundPlane|crewObj|wallL|wallR|deb\d|pillar)/.test(eName)) continue;
            if (seen[eName]) continue;
            seen[eName] = true;
            entityMap.push({ name: eName, shape: m[3], color: m[4] });
          }
        } catch(e) {}
      }
      sendJSON(res, {
        specs: specs,
        entityMap: entityMap,
        status: project.status,
        projectName: project.name,
      });
    },

    confirmSpecs: function(req, res, body, params) {
      var id = params.id;
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

      // Now proceed with normal submit flow via SQLite TaskQueue
      var taskId = id;
      var blueprintExport = exportBlueprintForAgent(project);
      blueprintExport.specs = project.specs;

      // Update or create task in SQLite
      var existingTask = taskQueue.get(taskId);
      if (existingTask) {
        taskQueue.updateBlueprint(taskId, blueprintExport);
        taskQueue.updateStatus(taskId, 'pending', 'specs confirmed', 'server');
      } else {
        var metadata = {
          svnUrl: project.svnUrl || '',
          blueprintEditorId: id,
          blueprintServerUrl: 'http://localhost:' + PORT,
          source: 'blueprint-editor',
        };
        taskQueue.enqueue(taskId, id, project.name, blueprintExport, metadata);
      }

      var submitErr = validateProjectTransition(project, 'submitted');
      if (submitErr) return sendJSON(res, { error: submitErr }, 400);
      project.status = 'submitted';
      project.updatedAt = new Date().toISOString();
      writeProject(project);

      wakeOpenClaw('[蓝图编辑器] Spec 已确认，任务已提交。项目: ' + project.name + ', taskId: ' + taskId);
      sendJSON(res, { success: true, status: 'submitted', specsCount: (project.specs || []).length });
    },

    svnCommit: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var svnUrl = (project.svnUrl || '').trim();
      if (!svnUrl) return sendJSON(res, { error: '该项目未配置 SVN 地址' }, 400);

      var webglDir = path.join(WEBGL_DIR, id);
      if (!fs.existsSync(webglDir)) return sendJSON(res, { error: '没有可提交的 WebGL 构建文件' }, 400);

      var exec = require('child_process').execSync;
      var tmpDir = path.join(DATA_DIR, 'svn-tmp', id);
      if (fs.existsSync(tmpDir)) {
        try { exec('rm -rf ' + JSON.stringify(tmpDir)); } catch(e) {}
      }
      fs.mkdirSync(tmpDir, { recursive: true });

      try {
        // Checkout SVN target directory
        exec('svn checkout --depth=infinity ' + JSON.stringify(svnUrl) + ' ' + JSON.stringify(tmpDir) + ' --non-interactive --trust-server-cert-failures=unknown-ca,cn-mismatch,expired', { timeout: 60000 });

        // Copy webgl build files into checkout
        var buildFiles = fs.readdirSync(webglDir);
        for (var i = 0; i < buildFiles.length; i++) {
          var fname = buildFiles[i];
          if (fname === 'versions' || fname === 'specs.json') continue;
          var src = path.join(webglDir, fname);
          var dst = path.join(tmpDir, fname);
          var stat = fs.statSync(src);
          if (stat.isDirectory()) {
            exec('cp -r ' + JSON.stringify(src) + ' ' + JSON.stringify(dst));
          } else {
            fs.copyFileSync(src, dst);
          }
        }

        // svn add new files (ignore already versioned)
        try { exec('svn add --force ' + JSON.stringify(tmpDir) + '/*', { cwd: tmpDir }); } catch(e) {}

        // Commit
        var commitMsg = '提交 WebGL 构建 — ' + (project.name || id);
        var result = exec('svn commit -m ' + JSON.stringify(commitMsg) + ' --non-interactive --trust-server-cert-failures=unknown-ca,cn-mismatch,expired', { cwd: tmpDir, timeout: 120000 });
        var output = result.toString().trim();

        // Extract revision number
        var revMatch = output.match(/Committed revision (\d+)/);
        var revision = revMatch ? revMatch[1] : null;

        // Update project
        if (revision) project.svnRevision = revision;
        project.updatedAt = new Date().toISOString();
        writeProject(project);

        // Cleanup
        try { exec('rm -rf ' + JSON.stringify(tmpDir)); } catch(e) {}

        sendJSON(res, { success: true, revision: revision, message: output || '提交成功' });
      } catch(e) {
        // Cleanup on error
        try { exec('rm -rf ' + JSON.stringify(tmpDir)); } catch(e2) {}
        sendJSON(res, { error: 'SVN 提交失败: ' + e.message }, 500);
      }
    },

    // Expose for other modules that need it
    exportBlueprintForAgent: exportBlueprintForAgent,
  };
};
