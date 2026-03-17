#!/bin/bash
# Reset project status and submit V4 task
PROJECT_ID="proj_1772426062293_qmjs"

# Clear feedback history and set editing
curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"status":"editing","feedbackHistory":[]}'

echo ""
echo "=== Submitting project ==="

# Submit
curl -s -X POST "http://localhost:3901/api/projects/${PROJECT_ID}/submit" \
  -H "Content-Type: application/json"

echo ""
echo "=== Done ==="
