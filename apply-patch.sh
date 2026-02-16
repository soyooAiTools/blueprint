#!/bin/bash
# Patch server.cjs to integrate worker pool
FILE="/opt/blueprint-editor/server.cjs"

# Restore from backup first (idempotent)
cp "${FILE}.bak" "$FILE"

# 1. Add require after url require line
sed -i "/^const url = require('url');$/a var workerPool = require('./autoCoding-tasks/worker-pool-patch.cjs');" "$FILE"

# 2. Insert worker pool intercept before "// API routes"
# The block needs to: check if it's a worker pool route, if so read body then handle
sed -i '/^  \/\/ API routes$/i\
  // Worker Pool routes\
  if (workerPool.matchWorkerPoolRoute(method, pathname)) {\
    readBody(req).then(function(body) {\
      var parsed2 = url.parse(req.url, true);\
      var bodyData = {};\
      try { bodyData = JSON.parse(body); } catch(e) {}\
      workerPool.handleWorkerPoolRequest(req, res, method, pathname, parsed2.query, bodyData);\
    });\
    return;\
  }\
' "$FILE"

echo "Patch applied successfully!"
echo "--- Verification ---"
grep -n "workerPool" "$FILE"
