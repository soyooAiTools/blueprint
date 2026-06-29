'use strict';

var fs = require('fs');
var path = require('path');

var {
  FLOW_CONTRACT_PATH,
  buildSourceSceneIrFromStoryboardFlow,
  preflightStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');
var {
  buildStoryboardFlowDiffReport,
  writeDiffReport,
} = require('../engine/storyboard-flow-diff.cjs');

function safeProjectId(value) {
  var id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('非法项目 ID');
  return id;
}

function parseJsonBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  return JSON.parse(body);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function issueCountsFromReport(report) {
  return report && report.issueCounts || { blocker: 0, warn: 0, info: 0 };
}

function sourceArtifactUrl(projectId, relPath) {
  return '/api/projects/' + encodeURIComponent(projectId) + '/storyboard-flow/artifacts/' + relPath.split(path.sep).map(encodeURIComponent).join('/');
}

function normalizeFlowBody(data, project) {
  var flow = data && data.flow ? data.flow : data;
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
    flow = project && (project.storyboardFlow || project.blueprint && project.blueprint.storyboardFlow) || null;
  }
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) throw new Error('缺少 storyboard flow');
  return flow;
}

module.exports.init = function(ctx) {
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var serveStatic = ctx.serveStatic;
  var DATA_DIR = config.DATA_DIR;

  function flowRoot(projectId) {
    return path.join(DATA_DIR, 'storyboard-flows', safeProjectId(projectId));
  }

  function sourceOutDir(projectId) {
    return path.join(flowRoot(projectId), 'source-ir');
  }

  function diffOutDir(projectId) {
    return path.join(flowRoot(projectId), 'diff');
  }

  function flowPath(projectId) {
    return path.join(flowRoot(projectId), 'storyboard-flow.json');
  }

  function persistFlow(project, flow, now) {
    project.storyboardFlow = flow;
    project.blueprint = project.blueprint || {};
    project.blueprint.storyboardFlow = flow;
    project.updatedAt = now;
    writeProject(project);
    writeJson(flowPath(project.id), flow);
  }

  function latestPayload(projectId) {
    var root = flowRoot(projectId);
    var sourceDir = sourceOutDir(projectId);
    return {
      flow: readJsonIfExists(path.join(root, 'storyboard-flow.json')),
      authoringReport: readJsonIfExists(path.join(root, 'storyboard-flow-authoring-report.json')),
      sourceIrReport: readJsonIfExists(path.join(sourceDir, 'storyboard-flow-source-ir-report.json')),
      diffReport: readJsonIfExists(path.join(diffOutDir(projectId), 'storyboard-flow-diff-report.json')),
      paths: {
        flow: fs.existsSync(path.join(root, 'storyboard-flow.json')) ? path.join(root, 'storyboard-flow.json') : '',
        sourceSceneIr: fs.existsSync(path.join(sourceDir, 'source-scene-ir.json')) ? path.join(sourceDir, 'source-scene-ir.json') : '',
        html: fs.existsSync(path.join(sourceDir, 'source-ir-preview.html')) ? path.join(sourceDir, 'source-ir-preview.html') : '',
        authoringReport: fs.existsSync(path.join(root, 'storyboard-flow-authoring-report.json')) ? path.join(root, 'storyboard-flow-authoring-report.json') : '',
        sourceIrReport: fs.existsSync(path.join(sourceDir, 'storyboard-flow-source-ir-report.json')) ? path.join(sourceDir, 'storyboard-flow-source-ir-report.json') : '',
        diffReport: fs.existsSync(path.join(diffOutDir(projectId), 'storyboard-flow-diff-report.json')) ? path.join(diffOutDir(projectId), 'storyboard-flow-diff-report.json') : '',
      },
      urls: {
        flow: sourceArtifactUrl(projectId, 'storyboard-flow.json'),
        sourceSceneIr: sourceArtifactUrl(projectId, 'source-ir/source-scene-ir.json'),
        html: sourceArtifactUrl(projectId, 'source-ir/source-ir-preview.html'),
        authoringReport: sourceArtifactUrl(projectId, 'storyboard-flow-authoring-report.json'),
        sourceIrReport: sourceArtifactUrl(projectId, 'source-ir/storyboard-flow-source-ir-report.json'),
        diffReport: sourceArtifactUrl(projectId, 'diff/storyboard-flow-diff-report.json'),
      },
    };
  }

  function saveAuthoringReport(project, report) {
    writeJson(path.join(flowRoot(project.id), 'storyboard-flow-authoring-report.json'), report);
    project.storyboardFlowAuthoringSummary = {
      passed: report.passed,
      issueCounts: issueCountsFromReport(report),
      phaseCount: report.phaseCount,
      generatedAt: report.generatedAt,
    };
    project.blueprint = project.blueprint || {};
    project.blueprint.storyboardFlowAuthoringSummary = project.storyboardFlowAuthoringSummary;
  }

  return {
    getStoryboardFlow: function(req, res, body, params) {
      var project = readProject(params.id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var latest = latestPayload(project.id);
      sendJSON(res, Object.assign({}, latest, {
        ok: true,
        projectId: project.id,
        flow: project.storyboardFlow || project.blueprint && project.blueprint.storyboardFlow || latest.flow || null,
        sourceHtmlPath: project.sourceHtmlPath || project.blueprint && project.blueprint.sourceHtmlPath || '',
        sourceHtmlUrl: project.sourceHtmlUrl || project.blueprint && project.blueprint.sourceHtmlUrl || '',
        contract: FLOW_CONTRACT_PATH,
      }));
    },

    saveStoryboardFlow: function(req, res, body, params) {
      var project = readProject(params.id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = parseJsonBody(body);
      var flow = normalizeFlowBody(data, project);
      var now = new Date().toISOString();
      persistFlow(project, flow, now);
      sendJSON(res, { ok: true, updatedAt: now, paths: { flow: flowPath(project.id) }, urls: { flow: sourceArtifactUrl(project.id, 'storyboard-flow.json') } });
    },

    validateStoryboardFlow: function(req, res, body, params) {
      var project = readProject(params.id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = parseJsonBody(body);
      var flow = normalizeFlowBody(data, project);
      var now = new Date().toISOString();
      persistFlow(project, flow, now);
      var report = preflightStoryboardFlow(flow, { generatedAt: now });
      saveAuthoringReport(project, report);
      project.updatedAt = now;
      writeProject(project);
      sendJSON(res, { ok: true, report: report, paths: latestPayload(project.id).paths, urls: latestPayload(project.id).urls });
    },

    generateStoryboardFlowSourceIr: function(req, res, body, params) {
      var project = readProject(params.id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = parseJsonBody(body);
      var flow = normalizeFlowBody(data, project);
      var now = new Date().toISOString();
      persistFlow(project, flow, now);
      var authoring = preflightStoryboardFlow(flow, { generatedAt: now });
      saveAuthoringReport(project, authoring);
      if (authoring.passed !== true) {
        project.updatedAt = now;
        writeProject(project);
        return sendJSON(res, { error: 'Flow 校验未通过', report: authoring, paths: latestPayload(project.id).paths, urls: latestPayload(project.id).urls }, 400);
      }

      var outDir = sourceOutDir(project.id);
      fs.mkdirSync(outDir, { recursive: true });
      var htmlPath = path.join(outDir, 'source-ir-preview.html');
      var sourceIrPath = path.join(outDir, 'source-scene-ir.json');
      var preflightPath = path.join(outDir, 'source-ir-preflight.json');
      var reportPath = path.join(outDir, 'storyboard-flow-source-ir-report.json');
      var sourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
        sourceHtmlPath: htmlPath,
        generatedAt: now,
      });
      writeJson(sourceIrPath, sourceIr);
      var html = buildSourceIrPreviewHtml(sourceIr, { generatedAt: now });
      fs.writeFileSync(htmlPath, html);
      var preflight = preflightSourceSceneIrHtml(html, {
        sourceHtmlPath: htmlPath,
        requireSourceIrRenderer: true,
      });
      writeJson(preflightPath, preflight);
      var report = {
        schemaVersion: 'storyboard-flow-source-ir-report.v1',
        inputPath: flowPath(project.id),
        outDir: outDir,
        sourceSceneIrPath: sourceIrPath,
        sourceIrPreviewHtmlPath: htmlPath,
        authoringPreflightPath: path.join(flowRoot(project.id), 'storyboard-flow-authoring-report.json'),
        preflightPath: preflightPath,
        contract: FLOW_CONTRACT_PATH,
        phaseCount: sourceIr.phases.length,
        entityCount: sourceIr.entities.length,
        resourceCount: sourceIr.resources.length,
        authoringIssueCounts: authoring.issueCounts,
        resourceSnapshots: authoring.resourceSnapshots,
        semanticHash: sourceIr.semanticHash,
        passed: preflight.passed === true,
      };
      writeJson(reportPath, report);
      project.sourceHtmlPath = htmlPath;
      project.sourceHtmlUrl = sourceArtifactUrl(project.id, 'source-ir/source-ir-preview.html');
      project.sourceHtmlJobId = 'storyboard-flow:' + now.replace(/[^0-9A-Za-z]+/g, '');
      project.blueprint = project.blueprint || {};
      project.blueprint.sourceHtmlPath = project.sourceHtmlPath;
      project.blueprint.sourceHtmlUrl = project.sourceHtmlUrl;
      project.blueprint.sourceHtmlJobId = project.sourceHtmlJobId;
      project.specs = [];
      project.plans = null;
      project.planValidation = null;
      project.planReview = null;
      project.updatedAt = now;
      writeProject(project);
      var latest = latestPayload(project.id);
      sendJSON(res, {
        ok: preflight.passed === true,
        report: report,
        authoringReport: authoring,
        preflight: preflight,
        paths: latest.paths,
        urls: latest.urls,
        sourceHtmlPath: htmlPath,
        sourceHtmlUrl: project.sourceHtmlUrl,
      }, preflight.passed === true ? 200 : 500);
    },

    diffStoryboardFlow: function(req, res, body, params) {
      var project = readProject(params.id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = parseJsonBody(body);
      var flow = normalizeFlowBody(data, project);
      var sourceHtmlPath = data.sourceHtmlPath || project.sourceHtmlPath || project.blueprint && project.blueprint.sourceHtmlPath || '';
      if (!sourceHtmlPath) return sendJSON(res, { error: '缺少 sourceHtmlPath，无法对比 storyboard2html HTML' }, 400);
      var now = new Date().toISOString();
      persistFlow(project, flow, now);
      var report = buildStoryboardFlowDiffReport(flow, sourceHtmlPath, {
        generatedAt: now,
        flowPath: flowPath(project.id),
        flowSourceHtmlPath: path.join(sourceOutDir(project.id), 'source-ir-preview.html'),
      });
      var reportPath = writeDiffReport(report, diffOutDir(project.id));
      project.storyboardFlowDiffSummary = {
        passed: report.passed,
        diffCounts: report.diffCounts,
        generatedAt: report.generatedAt,
      };
      project.blueprint = project.blueprint || {};
      project.blueprint.storyboardFlowDiffSummary = project.storyboardFlowDiffSummary;
      project.updatedAt = now;
      writeProject(project);
      sendJSON(res, {
        ok: true,
        report: report,
        paths: Object.assign(latestPayload(project.id).paths, { diffReport: reportPath }),
        urls: latestPayload(project.id).urls,
      });
    },

    serveStoryboardFlowArtifact: function(req, res, body, params) {
      var projectId = safeProjectId(params.id);
      var root = path.resolve(flowRoot(projectId));
      var rel = decodeURIComponent(String(params.flowFile || ''));
      var filePath = path.resolve(root, rel);
      if (filePath !== root && filePath.indexOf(root + path.sep) !== 0) {
        return sendJSON(res, { error: '非法文件路径' }, 400);
      }
      if (serveStatic(res, filePath, req)) return;
      return sendJSON(res, { error: '文件不存在' }, 404);
    },
  };
};
