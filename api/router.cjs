/**
 * Router — route matching + dispatch
 * Extracted from server.cjs matchRoute() + request handler
 */
var url = require('url');
var middleware = require('./middleware.cjs');

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
  // SVN commit
  m = pathname.match(/^\/api\/projects\/([^/]+)\/svn-commit$/);
  if (m && method === 'POST') return { handler: 'svnCommit', id: m[1] };

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
  m = pathname.match(/^\/api\/projects\/([^/]+)\/analyze-reference$/);
  if (m && method === 'POST') return { handler: 'analyzeReference', id: m[1], rawBody: true };

  // Spec review routes
  m = pathname.match(/^\/api\/projects\/([^/]+)\/specs$/);
  if (m && method === 'GET') return { handler: 'getSpecs', id: m[1] };
  m = pathname.match(/^\/api\/projects\/([^/]+)\/confirm-specs$/);
  if (m && method === 'POST') return { handler: 'confirmSpecs', id: m[1] };

  // Worker API routes
  if (method === 'GET' && pathname === '/api/worker/poll') return { handler: 'workerPoll' };
  m = pathname.match(/^\/api\/tasks\/([^/]+)\/blueprint$/);
  if (m && method === 'GET') return { handler: 'getTaskBlueprint', taskId: m[1] };
  m = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (m && method === 'GET') return { handler: 'getTaskStatus', taskId: m[1] };
  m = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (m && method === 'POST') return { handler: 'cancelTask', taskId: m[1] };
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
  if (method === 'GET' && pathname === '/api/watchdog') return { handler: 'getWatchdogStatus' };
  if (method === 'POST' && pathname === '/api/watchdog/run') return { handler: 'runWatchdog' };
  if (method === 'GET' && pathname === '/api/dashboard/pipeline-metrics') return { handler: 'getPipelineMetrics' };

  // Serve generated images
  m = pathname.match(/^\/api\/images\/([^/]+)\/(.+)$/);
  if (m && method === 'GET') return { handler: 'serveImage', projectId: m[1], filename: m[2] };

  return null;
}

/**
 * createRouter(handlers) — returns (req, res) => boolean
 * handlers is a flat object: { handlerName: function(req, res, body, params) {} }
 * Returns true if route was handled, false if not matched
 */
function createRouter(handlers) {
  var sendJSON = middleware.sendJSON;
  var readBody = middleware.readBody;

  return function(req, res) {
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
      return true;
    }

    // API routes
    var route = matchRoute(method, pathname);
    if (route && handlers[route.handler]) {
      var params = {};
      if (route.id) params.id = route.id;
      if (route.taskId) params.taskId = route.taskId;
      if (route.projectId) params.projectId = route.projectId;
      if (route.filename) params.filename = route.filename;

      if (route.rawBody) {
        // Binary upload — pass req directly, handler reads raw body
        try {
          handlers[route.handler](req, res, null, params);
        } catch (e) {
          sendJSON(res, { error: e.message }, 500);
        }
      } else {
        readBody(req).then(function(body) {
          try {
            handlers[route.handler](req, res, body, params);
          } catch (e) {
            sendJSON(res, { error: e.message }, 500);
          }
        });
      }
      return true; // handled
    }

    return false; // not an API route
  };
}

module.exports = {
  matchRoute: matchRoute,
  createRouter: createRouter,
};
