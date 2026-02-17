#!/bin/bash
FILE="/opt/blueprint-editor/server.cjs"

# Replace the old SPA fallback section with blueprintEditor prefix support
# 1. Add /blueprintEditor static file serving before "// WebGL static files"
sed -i '/\/\/ Dashboard/i\
  // Blueprint Editor SPA at /blueprintEditor\
  if (pathname === "/blueprintEditor" || pathname === "/blueprintEditor/") {\
    var bpIndex = path.join(DIST_DIR, "index.html");\
    if (fs.existsSync(bpIndex)) { serveStatic(res, bpIndex); return; }\
  }\
  if (pathname.indexOf("/blueprintEditor/") === 0) {\
    var bpPath = pathname.slice("/blueprintEditor".length);\
    var bpFile = path.join(DIST_DIR, bpPath);\
    if (fs.existsSync(bpFile) && fs.statSync(bpFile).isFile()) {\
      serveStatic(res, bpFile);\
      return;\
    }\
    var bpFallback = path.join(DIST_DIR, "index.html");\
    if (fs.existsSync(bpFallback)) { serveStatic(res, bpFallback); return; }\
  }\
' "$FILE"

# 2. Add root redirect to /blueprintEditor
sed -i '/\/\/ Blueprint Editor SPA/i\
  // Root redirect\
  if (pathname === "/" || pathname === "") {\
    res.writeHead(302, { "Location": "/blueprintEditor" });\
    res.end();\
    return;\
  }\
' "$FILE"

echo "Prefix routes added"
grep -n "blueprintEditor\|Root redirect" "$FILE"
