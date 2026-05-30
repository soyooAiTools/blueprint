/**
 * Project API handlers
 * Extracted from server.cjs — project CRUD, submit, feedback, approve, specs
 */
var fs = require('fs');
var crypto = require('crypto');
var { projectSM } = require('../lib/state-machine.cjs');
var { ensureProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');
var { normalizeProjectBlueprint } = require('../lib/project-blueprint-normalizer.cjs');
var programmerDeliveryCleaner = require('../lib/programmer-delivery-cleaner.cjs');
var { normalizeLegendShape, normalizeLegendColor } = require('../engine/legend-normalizer.cjs');
var path = require('path');

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

function sha256OfFile(filePath) {
  var hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function resolveSourceHtmlForExport(project, bp, visualAssets) {
  var candidates = [
    bp && bp.sourceHtmlPath,
    project && project.sourceHtmlPath,
    visualAssets && visualAssets.source,
    project && /\.html?$/i.test(String(project.source || '')) ? project.source : null,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var value = candidates[i];
    if (!value || !/\.html?$/i.test(String(value))) continue;
    var abs = path.resolve(String(value));
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { path: abs, sha256: sha256OfFile(abs) };
      }
    } catch(e) {}
  }
  return null;
}

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
  var SOURCES_DIR = config.SOURCES_DIR;

  // Strip base64 image data from blueprint for agent consumption
  function exportBlueprintForAgent(project) {
    normalizeProjectBlueprint(project);
    ensureProjectPlans(project);
    var bp = JSON.parse(JSON.stringify(project.blueprint || {}));
    var visualAssets = project.visualAssets
      ? JSON.parse(JSON.stringify(project.visualAssets))
      : (bp.visualAssets ? JSON.parse(JSON.stringify(bp.visualAssets)) : null);
    var sourceHtml = resolveSourceHtmlForExport(project, bp, visualAssets);
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
    var exported = {
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
      phases: (project.phases && project.phases.length > 0) ? project.phases : (bp.phases || []),
      specs: (Array.isArray(project.specs) && project.specs.length > 0) ? project.specs : [],
      plans: project.plans || null,
      planValidation: project.planValidation || null,
      exportedAt: new Date().toISOString()
    };
    if (visualAssets) exported.visualAssets = visualAssets;
    if (sourceHtml) {
      exported.sourceHtmlPath = sourceHtml.path;
      exported.sourceHtmlSha256 = sourceHtml.sha256;
      exported.storyboard.htmlPath = exported.storyboard.htmlPath || sourceHtml.path;
    }
    return exported;
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

function inferEntityDisplayName(desc) {
  var text = String(desc || '').trim();
  if (!text) return '';
  var m = text.match(/^([\u4e00-\u9fa5A-Za-z]{2,16}?)(已|可|正在|将|是|会|能|升级|建造|完成|启用|解锁|进入|触发|展示|开始|结束|出现|消失|到达|停止|达到|恢复|被|自动)/);
  if (m && m[1]) return m[1];
  return text.length > 12 ? text.slice(0, 12) : text;
}

function buildFallbackEntityMap(project, specs, entityHints, seen) {
  var entityMap = [];
  var known = seen || {};
  function addEntity(name, data, index) {
    var key = String(name || '').trim();
    if (!key || known[key]) return;
    known[key] = true;
    data = data || {};
    var visual = data.visual || {};
    var hint = entityHints[key] || {};
    entityMap.push({
      name: key,
      shape: normalizeLegendShape(data.shape || visual.shape || data.template, index),
      color: normalizeLegendColor(data.color || visual.color || data.template, index),
      displayName: data.chineseName || data.label || data.displayName || hint.displayName || '',
      aliases: []
        .concat(data.label || [])
        .concat(data.chineseName || [])
        .concat(data.aliases || [])
        .concat(hint.aliases || [])
        .filter(Boolean)
    });
  }

  var blueprint = (project && project.blueprint) || {};
  var entities = []
    .concat(Array.isArray(blueprint.entities) ? blueprint.entities : [])
    .concat(Array.isArray(project && project.entities) ? project.entities : []);
  for (var i = 0; i < entities.length; i++) {
    addEntity(entities[i] && entities[i].name, entities[i], i);
  }

  var nodes = blueprint.nodes || [];
  for (var n = 0; n < nodes.length; n++) {
    if (!nodes[n] || nodes[n].type !== 'entityNode') continue;
    var d = nodes[n].data || {};
    addEntity(d.name || nodes[n].id, d, n);
  }

  for (var s = 0; s < (specs || []).length; s++) {
    var required = (specs[s] && specs[s].entitiesRequired) || [];
    for (var r = 0; r < required.length; r++) {
      var er = required[r];
      addEntity(er && (er.name || er), {
        aliases: [er && er.description].filter(Boolean)
      }, r);
    }
  }
  return entityMap;
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
      if (data.globalSettings !== undefined) {
        project.blueprint.globalSettings = data.globalSettings;
        project.globalSettings = data.globalSettings;
      }
      // V4 实体列表
      if (data.entities !== undefined) {
        project.blueprint.entities = data.entities;
        project.entities = data.entities;
      }
      if (data.phases !== undefined) {
        project.blueprint.phases = data.phases;
        project.phases = data.phases;
      }
      normalizeProjectBlueprint(project);
      ensureProjectPlans(project);
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
      var entityHints = {};
      var blueprint = project.blueprint || {};
      var blueprintEntities = []
        .concat(Array.isArray(blueprint.entities) ? blueprint.entities : [])
        .concat(Array.isArray(project.entities) ? project.entities : []);
      blueprintEntities.forEach(function(e) {
        if (!e || !e.name) return;
        var hint = entityHints[e.name] || { aliases: [] };
        if (e.chineseName) hint.displayName = e.chineseName;
        else if (e.label) hint.displayName = e.label;
        if (e.label && hint.aliases.indexOf(e.label) === -1) hint.aliases.push(e.label);
        if (e.chineseName && hint.aliases.indexOf(e.chineseName) === -1) hint.aliases.push(e.chineseName);
        entityHints[e.name] = hint;
      });
      var nodes = blueprint.nodes || [];
      nodes.forEach(function(n) {
        if (!n || n.type !== 'entityNode') return;
        var d = n.data || {};
        var name = d.name || n.id;
        if (!name) return;
        var hint = entityHints[name] || { aliases: [] };
        if (d.chineseName) hint.displayName = d.chineseName;
        else if (d.showLabel) hint.displayName = d.showLabel;
        if (d.label && hint.aliases.indexOf(d.label) === -1) hint.aliases.push(d.label);
        entityHints[name] = hint;
      });
      specs.forEach(function(sp) {
        (sp.entitiesRequired || []).forEach(function(er) {
          if (!er || !er.name) return;
          var hint = entityHints[er.name] || { aliases: [] };
          var inferred = inferEntityDisplayName(er.description);
          if (!hint.displayName && inferred) hint.displayName = inferred;
          if (er.description && hint.aliases.indexOf(er.description) === -1) hint.aliases.push(er.description);
          entityHints[er.name] = hint;
        });
      });

      // Extract entity→visual mapping from compiled WebGL HTML
      // Two skeleton patterns coexist:
      //   new (>=2026-04-18): GameSceneCtrl.instance.Register("EntityName", "__Pool_Shape_Color_NN")
      //   legacy: this.varName = UnityEngine.GameObject.Find("__Pool_Shape_Color_NN")
      var entityMap = [];
      var htmlFile = path.join(WEBGL_DIR, id, 'index.html');
      if (fs.existsSync(htmlFile)) {
        try {
          var html = fs.readFileSync(htmlFile, 'utf-8');
          var seen = {};
          var skipRe = /^(groundPlane|crewObj|wallL|wallR|deb\d|pillar)/;
          var reNew = /GameSceneCtrl\.instance\.Register\("(\w+)"\s*,\s*"(__Pool_(\w+?)_(\w+?)_\d+)"\)/g;
          var m;
          while ((m = reNew.exec(html)) !== null) {
            var eName = m[1];
            if (skipRe.test(eName)) continue;
            if (seen[eName]) continue;
            seen[eName] = true;
            var hint = entityHints[eName] || {};
            entityMap.push({
              name: eName,
              shape: m[3],
              color: m[4],
              displayName: hint.displayName || '',
              aliases: hint.aliases || [],
            });
          }
          var reOld = /this\.(\w+)\s*=\s*UnityEngine\.GameObject\.Find\("(__Pool_(\w+?)_(\w+?)_\d+)"\)/g;
          while ((m = reOld.exec(html)) !== null) {
            var eName2 = m[1];
            if (skipRe.test(eName2)) continue;
            if (seen[eName2]) continue;
            seen[eName2] = true;
            var hint2 = entityHints[eName2] || {};
            entityMap.push({
              name: eName2,
              shape: m[3],
              color: m[4],
              displayName: hint2.displayName || '',
              aliases: hint2.aliases || [],
            });
          }
        } catch(e) {}
      }
      var fallbackMap = buildFallbackEntityMap(project, specs, entityHints, (function() {
        var seenMap = {};
        for (var si = 0; si < entityMap.length; si++) seenMap[entityMap[si].name] = true;
        return seenMap;
      })());
      entityMap = entityMap.concat(fallbackMap);
      sendJSON(res, {
        specs: specs,
        entityMap: entityMap,
        status: project.status,
        projectName: project.name,
        plans: project.plans || null,
        planValidation: project.planValidation || null,
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

      var projectService = require('../engine/project-service.cjs');
      try {
        var result = projectService.confirmProjectSpecs(project, {
          taskQueue: taskQueue,
          writeProject: writeProject,
          wakeOpenClaw: wakeOpenClaw,
          exportBlueprintForAgent: exportBlueprintForAgent,
          PORT: PORT,
          WEBGL_DIR: WEBGL_DIR,
        }, {
          mode: 'manual',
          reason: 'manual_confirm',
          statusReason: 'specs confirmed',
        });
        sendJSON(res, { success: true, status: result.status, specsCount: (project.specs || []).length });
      } catch(e) {
        sendJSON(res, { error: e.message }, 400);
      }
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

        // Copy C# source files + handoff docs (HANDOFF_README.md / STORYBOARD.md /
        // storyboard-images/) if available. Files go to Scripts/, subdirectories
        // are recursively copied to preserve storyboard-images/.
        var sourcesDir = path.join(SOURCES_DIR, id);
        if (fs.existsSync(sourcesDir)) {
          var scriptsDir = path.join(tmpDir, 'Scripts');
          fs.mkdirSync(scriptsDir, { recursive: true });
          var srcFiles = fs.readdirSync(sourcesDir);
          for (var si = 0; si < srcFiles.length; si++) {
            var srcPath = path.join(sourcesDir, srcFiles[si]);
            var dstPath = path.join(scriptsDir, srcFiles[si]);
            var srcStat = fs.statSync(srcPath);
            if (srcStat.isDirectory()) {
              exec('cp -r ' + JSON.stringify(srcPath) + ' ' + JSON.stringify(dstPath));
            } else {
              fs.copyFileSync(srcPath, dstPath);
            }
          }
        }

        var deliverySummary = programmerDeliveryCleaner.cleanProgrammerDelivery(tmpDir, { project: project });

        // Wave D 反馈 6 (2026-05-02): blocking 校验失败必须中断 commit,
        // 否则 GateReady 缺失 / CheckEventRules 内联回退会被无声放过。
        if (deliverySummary.errors && deliverySummary.errors.length > 0) {
          throw new Error('交付校验失败 — 必须修复以下问题后重试:\n' +
            deliverySummary.errors.map(function(err) {
              return '  [' + err.rule + '] ' + (err.file ? err.file + ': ' : '') + err.message;
            }).join('\n'));
        }

        // svn add new files (ignore already versioned)
        try { exec('svn add --force --parents ' + JSON.stringify(tmpDir) + '/*', { cwd: tmpDir }); } catch(e) {}

        // Commit
        var commitMsg = '提交程序员交付版 WebGL + C# 源码 — ' + (project.name || id);
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

        sendJSON(res, { success: true, revision: revision, message: output || '提交成功', programmerDelivery: deliverySummary });
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
