#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

cd /tmp
node restore-full.cjs

# Reset status
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs > /dev/null

# Save full blueprint
curl -s -X PUT -H 'Content-Type: application/json' -d @/tmp/full-bp.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint
echo ""

# Verify
echo "=== Verify ==="
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('Nodes:', len(bp.get('nodes',[])))
print('Objects:', len(bp.get('objectRegistry',[])))
print('GlobalParams:', ('yes' if bp.get('globalParams') else 'no'))
for n in bp.get('nodes',[]):
    print(' ', n['id'], '|', n['data'].get('label',''))
"
