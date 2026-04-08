#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Get current project to check
echo "=== Before restore ==="
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('Nodes:', len(bp.get('nodes',[])))
print('Objects:', len(bp.get('objectRegistry',[])))
"

# Reset status first
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs > /dev/null

# Restore the full blueprint from backup (the original 10-shot data)
# We need to rebuild from the recovered-qmjs.json or use the API backup
# Check if we have the full backup
if [ -f "/tmp/full-bp-backup.json" ]; then
    echo "Restoring from backup..."
    curl -s -X PUT -H 'Content-Type: application/json' -d @/tmp/full-bp-backup.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint
else
    echo "No backup found at /tmp/full-bp-backup.json"
fi

echo ""
echo "=== After restore ==="
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('Nodes:', len(bp.get('nodes',[])))
print('Objects:', len(bp.get('objectRegistry',[])))
for n in bp.get('nodes',[]):
    print(' ', n['id'], '|', n['data'].get('label',''))
"
