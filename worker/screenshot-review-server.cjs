// Screenshot Review API Server — runs on Main ECS alongside blueprint editor
// Listens on port 18820, provides /api/tasks/:taskId/screenshot-review
// Requires: playwright, node 18+

const http = require('http');
const fs = require('fs');
const path = require('path');
const { takeScreenshot, reviewScreenshot } = require('./screenshot-review.cjs');

const PORT = 18820;
const WEBGL_BASE = '/opt/blueprint-editor/server-data/webgl';
const PROJECTS_BASE = '/opt/blueprint-editor/server-data/projects';
const AUTOCODING_QUEUE = '/opt/blueprint-editor/server-data/autocoding-queue';

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // POST /api/tasks/:taskId/screenshot-review
  const match = req.url.match(/\/api\/tasks\/([^/]+)\/screenshot-review/);
  if (match && req.method === 'POST') {
    const taskId = match[1];
    console.log(`[${new Date().toISOString()}] Screenshot review: ${taskId}`);

    try {
      // Find blueprint
      let blueprint = null;
      const blueprintPath = path.join(AUTOCODING_QUEUE, taskId + '-blueprint.json');
      const projectPath = path.join(PROJECTS_BASE, taskId + '.json');
      
      if (fs.existsSync(blueprintPath)) {
        blueprint = JSON.parse(fs.readFileSync(blueprintPath, 'utf-8'));
      } else if (fs.existsSync(projectPath)) {
        const project = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
        blueprint = { projectName: project.name, nodes: project.nodes || [], edges: project.edges || [] };
      }

      if (!blueprint) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, warning: true, reason: 'Blueprint not found, skipping review' }));
        return;
      }

      // Take screenshot
      const ssResult = await takeScreenshot(taskId, WEBGL_BASE);
      if (!ssResult.ok) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, warning: true, reason: 'Screenshot failed: ' + ssResult.error }));
        return;
      }

      // AI review
      const reviewPath = fs.existsSync(ssResult.screenshot2Path) ? ssResult.screenshot2Path : ssResult.screenshotPath;
      const review = await reviewScreenshot(reviewPath, blueprint);
      
      console.log(`[${new Date().toISOString()}] Review result: ${JSON.stringify(review)}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ...review, screenshotPath: ssResult.screenshotPath }));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error: ${e.message}`);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, warning: true, reason: 'Review error: ' + e.message }));
    }
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'screenshot-review' }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Screenshot Review Server listening on port ${PORT}`);
});
