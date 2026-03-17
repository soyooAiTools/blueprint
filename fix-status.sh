#!/bin/bash
curl -s -X PUT http://localhost:3901/api/projects/proj_1772426062293_qmjs \
  -H "Content-Type: application/json" \
  -d '{"status":"editing"}'
