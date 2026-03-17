#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Get current blueprint, keep only shot_1, modify endCondition to end with CTA
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json

d=json.load(sys.stdin)
bp=d['blueprint']

# Keep only shot_1
bp['nodes'] = [n for n in bp['nodes'] if n['id'] == 'shot_1']
bp['edges'] = []

# Modify shot_1 triggerChain to add CTA at the end
shot1 = bp['nodes'][0]
tc = shot1['data']['triggerChain']
tc += '\n5. 传送带建造完成，展示2秒\n   → Luna.Unity.LifeCycle.GameEnded()\n   → 显示CTA按钮\n   → 点击CTA调用 Luna.Unity.Playable.InstallFullGame()'
shot1['data']['triggerChain'] = tc
shot1['data']['endCondition'] = 'CTA'

# Only keep objects relevant to shot_1
relevant = ['Ground','Player','Base','WoodFence','PineTree_L','PineTree_R','Generator','ConveyorBelt']
bp['objectRegistry'] = [o for o in bp['objectRegistry'] if o['name'] in relevant]

with open('/tmp/shot1-bp.json','w') as f:
    json.dump(bp, f, ensure_ascii=False)
print('Shot1 blueprint ready:', len(bp['nodes']), 'nodes,', len(bp['objectRegistry']), 'objects')
"

# Reset status and save
curl -s -X PUT -H 'Content-Type: application/json' -d '{"status":"editing"}' http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs > /dev/null

# Save blueprint
curl -s -X PUT -H 'Content-Type: application/json' -d @/tmp/shot1-bp.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint
echo ""

# Submit
curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit
echo ""
echo "--- Submitted Shot 1 only ---"
