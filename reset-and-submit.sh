#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Reset status to editing
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs
echo ""
echo "--- Status reset ---"

# Submit
curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit
echo ""
echo "--- Submitted ---"
