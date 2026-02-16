#!/bin/bash
FILE="/opt/blueprint-editor/server.cjs"

# Add dashboard route before "// WebGL static files"
sed -i '/\/\/ WebGL static files/i\
  // Dashboard\
  if (pathname === "/dashboard" || pathname === "/dashboard/") {\
    var dashFile = path.join(__dir, "dashboard.html");\
    if (fs.existsSync(dashFile)) {\
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });\
      res.end(fs.readFileSync(dashFile, "utf-8"));\
      return;\
    }\
  }\
' "$FILE"

echo "Dashboard route added"
grep -n "dashboard" "$FILE"
