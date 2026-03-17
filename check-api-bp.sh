#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Check what the task blueprint API returns
echo "=== /api/tasks/proj_1772426062293_qmjs/blueprint ==="
curl -s http://127.0.0.1:3901/api/tasks/proj_1772426062293_qmjs/blueprint | python3 -c "
import sys,json
bp=json.load(sys.stdin)
print('Keys:', list(bp.keys()))
print('Nodes:', len(bp.get('nodes',[])))
print('ObjectRegistry:', len(bp.get('objectRegistry',[])))
print('GlobalParams:', bp.get('globalParams','(missing)')[:100] if bp.get('globalParams') else '(missing)')
print('GlobalSettings:', json.dumps(bp.get('globalSettings','(missing)'))[:100] if bp.get('globalSettings') else '(missing)')
if bp.get('objectRegistry'):
    for o in bp['objectRegistry'][:3]:
        print('  obj:', o.get('name'), '| shape:', o.get('shape'), '| role:', o.get('role'), '| color:', o.get('color'))
else:
    print('  NO objectRegistry!')
"
