/**
 * Asset API handlers
 * Extracted from server.cjs — status update, WebGL upload/get, image serving
 */
var fs = require('fs');
var { projectSM } = require("../lib/state-machine.cjs");
var path = require('path');

module.exports.init = function(ctx) {
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var serveStatic = ctx.serveStatic;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;

  var DATA_DIR = config.DATA_DIR;
  var WEBGL_DIR = config.WEBGL_DIR;

  return {
    updateStatus: function(req, res, body, params) {
      var id = params.id;
      var project = readProject(id);
      if (!project) return sendJSON(res, { error: '项目不存在' }, 404);
      var data = JSON.parse(body);
      if (!data.status) {
        return sendJSON(res, { error: '缺少 status 字段' }, 400);
      }
      var transResult = projectSM.validate(project.status, data.status);
      if (!transResult.valid) {
        return sendJSON(res, { error: transResult.error }, 400);
      }
      projectSM.forceTransition(project, data.status, 'assets-api');
      if (data.message) project.statusMessage = data.message;
      writeProject(project);
      sendJSON(res, { success: true, status: project.status });
    },

    uploadWebgl: function(req, res, body, params) {
      var id = params.id;
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
    },

    getWebgl: function(req, res, body, params) {
      var id = params.id;
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
    },

    serveImage: function(req, res, body, params) {
      var urlMod = require('url');
      var parsed = urlMod.parse(req.url);
      var m = parsed.pathname.match(/^\/api\/images\/([^/]+)\/(.+)$/);
      if (!m) return sendJSON(res, { error: 'Not found' }, 404);
      var imgPath = path.join(DATA_DIR, 'images', m[1], m[2]);
      if (!fs.existsSync(imgPath)) return sendJSON(res, { error: 'Image not found' }, 404);
      serveStatic(res, imgPath, req);
    },
  };
};
