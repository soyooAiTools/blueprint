const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const assetsApi = require('../api/assets.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-webgl-url-'));
const webglDir = path.join(root, 'webgl');
const projectId = 'proj_preview_url';
fs.mkdirSync(path.join(webglDir, projectId), { recursive: true });
fs.writeFileSync(path.join(webglDir, projectId, 'index.html'), '<html></html>');

let payload = null;
const handlers = assetsApi.init({
  config: {
    DATA_DIR: root,
    WEBGL_DIR: webglDir,
  },
  sendJSON: function(_res, data) {
    payload = data;
  },
  serveStatic: function() {},
  readProject: function(id) {
    if (id !== projectId) return null;
    return { id: projectId, webglPath: '/webgl/' + projectId + '/index.html' };
  },
  writeProject: function() {},
});

handlers.getWebgl({}, {}, '', { id: projectId });

assert.strictEqual(payload.available, true);
assert.match(payload.url, /^\/webgl\/proj_preview_url\/index\.html\?t=\d+$/);
assert.doesNotMatch(payload.url, /[?&]autoplay=1(?:&|$)/);

fs.rmSync(root, { recursive: true, force: true });

console.log('api webgl url tests passed');
