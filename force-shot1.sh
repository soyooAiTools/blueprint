#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Force the current task to stop by marking it failed
QUEUE_DIR="/opt/blueprint-editor/autocoding-queue"
TASK_FILE="$QUEUE_DIR/proj_1772426062293_qmjs.json"

if [ -f "$TASK_FILE" ]; then
    python3 -c "
import json
with open('$TASK_FILE') as f:
    t = json.load(f)
print('Current task status:', t.get('status'))
t['status'] = 'completed'
with open('$TASK_FILE','w') as f:
    json.dump(t,f)
print('Set to completed')
"
fi

# Now reset project and resubmit
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs > /dev/null

# Re-save the shot1-only blueprint (already in /tmp/shot1-bp.json from before)
curl -s -X PUT -H 'Content-Type: application/json' -d @/tmp/shot1-bp.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint
echo ""

# Submit fresh
curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit
echo ""
