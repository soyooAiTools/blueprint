#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

echo "=== shot1-bp.json structure ==="
python3 -c "
import json
with open('/tmp/shot1-bp.json') as f:
    bp=json.load(f)
print('Top keys:', sorted(bp.keys()))
print('objectRegistry:', len(bp.get('objectRegistry',[])))
print('globalParams:', ('yes' if bp.get('globalParams') else 'no'))
print('globalSettings:', ('yes' if bp.get('globalSettings') else 'no'))
"

echo ""
echo "=== project.blueprint structure ==="
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('blueprint keys:', sorted(bp.keys()))
print('objectRegistry:', len(bp.get('objectRegistry',[])))
print('globalParams:', ('yes' if bp.get('globalParams') else 'no'))
print('globalSettings:', ('yes' if bp.get('globalSettings') else 'no'))
"
