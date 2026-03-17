#!/bin/bash
PROJECT_ID="proj_1772426062293_qmjs"

# Reset status and clear ALL feedback
curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"status":"editing","feedbackHistory":[]}'

# Also clear feedbackHistory from blueprint
curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}/blueprint" \
  -H "Content-Type: application/json" \
  -d '{"feedbackHistory":[]}'

# Re-upload V4 data  
cd /opt/blueprint-editor && node upload-v4.cjs

# Verify
echo ""
echo "=== Verify ==="
curl -s "http://localhost:3901/api/projects/${PROJECT_ID}" | python3 -c "
import sys,json; d=json.load(sys.stdin); bp=d.get('blueprint',{})
print('nodes:', len(bp.get('nodes',[])), 'entities:', len(bp.get('entities',[])))
print('feedbackHistory:', len(d.get('feedbackHistory',[])))
print('status:', d.get('status'))
"

# Submit
echo ""
curl -s -X POST "http://localhost:3901/api/projects/${PROJECT_ID}/submit"
echo ""
