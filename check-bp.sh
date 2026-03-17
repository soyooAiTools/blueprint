#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
bp=d.get('blueprint',{})
print('=== SERVER BLUEPRINT ===')
print('Status:', d.get('status'))
print('Nodes:', len(bp.get('nodes',[])))
print('ObjectRegistry:', len(bp.get('objectRegistry',[])))
print('GlobalParams:', 'yes' if bp.get('globalParams') else 'no')
print('GlobalSettings:', 'yes' if bp.get('globalSettings') else 'no')
if bp.get('objectRegistry'):
    for o in bp['objectRegistry'][:5]:
        print('  -', o.get('name'), '| shape:', o.get('shape'), '| role:', o.get('role'), '| interaction:', o.get('interactionType'))
for n in bp.get('nodes',[]):
    so = n.get('data',{}).get('sceneObjects','')[:100]
    print('Node:', n['id'], '|', n['data'].get('label',''), '| sceneObjects:', so)
"

echo ""
echo "=== AUTOCODING QUEUE ==="
QUEUE_DIR="/opt/blueprint-editor/autocoding-queue"
if [ -f "$QUEUE_DIR/proj_1772426062293_qmjs.json" ]; then
    python3 -c "
import json
with open('$QUEUE_DIR/proj_1772426062293_qmjs.json') as f:
    t=json.load(f)
bp=t.get('blueprint',{})
print('Queue task status:', t.get('status'))
print('Queue nodes:', len(bp.get('nodes',[])))
print('Queue objectRegistry:', len(bp.get('objectRegistry',[])))
if bp.get('objectRegistry'):
    for o in bp['objectRegistry'][:3]:
        print('  -', o.get('name'), '| role:', o.get('role'))
for n in bp.get('nodes',[]):
    print('Queue node:', n['id'], '|', n['data'].get('label',''))
"
else
    echo "No queue file found"
fi
