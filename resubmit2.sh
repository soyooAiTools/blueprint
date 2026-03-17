#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

F='/opt/blueprint-editor/server-data/projects/proj_1772426062293_qmjs.json'
python3 -c "
import json
with open('$F') as fh:
    d=json.load(fh)
d['status']='editing'
with open('$F','w') as fh:
    json.dump(d,fh,ensure_ascii=False)
print('Reset to editing')
"

curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit
echo ""
bash /tmp/check-status.sh
