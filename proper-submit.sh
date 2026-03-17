#!/bin/bash
PROJECT_ID="proj_1772426062293_qmjs"

echo "=== Step 1: Reset to editing ==="
curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"status":"editing","feedbackHistory":[]}'

echo ""
echo "=== Step 2: Upload V4 data ==="
cd /opt/blueprint-editor && node upload-v4.cjs

echo ""
echo "=== Step 3: Verify data ==="
curl -s "http://localhost:3901/api/projects/${PROJECT_ID}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('nodes:', len(bp.get('nodes',[])))
print('entities:', len(bp.get('entities',[])))
print('status:', d.get('status'))
"

echo ""
echo "=== Step 4: Submit ==="
curl -s -X POST "http://localhost:3901/api/projects/${PROJECT_ID}/submit"
echo ""
echo "=== Done ==="
