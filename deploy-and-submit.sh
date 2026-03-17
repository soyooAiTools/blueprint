#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Deploy server.cjs
cd /opt/blueprint-editor
git pull origin main

# Restart server
fuser -k 3901/tcp 2>/dev/null
sleep 1
pm2 delete blueprint 2>/dev/null
pm2 start server.cjs --name blueprint

sleep 3

# Verify the fix
echo "=== Verifying API ==="
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs > /dev/null

# Re-save shot1 blueprint
curl -s -X PUT -H 'Content-Type: application/json' -d @/tmp/shot1-bp.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint > /dev/null

# Submit
curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit > /dev/null

# Check blueprint API now
echo ""
echo "=== /api/tasks blueprint check ==="
curl -s http://127.0.0.1:3901/api/tasks/proj_1772426062293_qmjs/blueprint | python3 -c "
import sys,json
bp=json.load(sys.stdin)
print('Keys:', sorted(bp.keys()))
print('ObjectRegistry:', len(bp.get('objectRegistry',[])))
print('GlobalParams:', ('yes' if bp.get('globalParams') else 'no'))
print('GlobalSettings:', ('yes' if bp.get('globalSettings') else 'no'))
if bp.get('objectRegistry'):
    for o in bp['objectRegistry'][:3]:
        print('  -', o.get('name'), '| role:', o.get('role'), '| interaction:', o.get('interactionType'))
"
