#!/bin/bash
PROJECT_ID="proj_1772426062293_qmjs"

# Clear feedback and reset to editing
curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}/blueprint" \
  -H "Content-Type: application/json" \
  -d '{"feedbackHistory":[]}'
echo ""

curl -s -X PUT "http://localhost:3901/api/projects/${PROJECT_ID}" \
  -H "Content-Type: application/json" \
  -d '{"status":"editing","feedbackHistory":[]}'
echo ""

# Submit fresh
curl -s -X POST "http://localhost:3901/api/projects/${PROJECT_ID}/submit"
echo ""
