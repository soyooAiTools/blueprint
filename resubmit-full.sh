#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Force reset status
python3 -c "
import json
f='/opt/blueprint-editor/data/projects/proj_1772426062293_qmjs.json'
with open(f) as fh:
    d=json.load(fh)
d['status']='editing'
with open(f,'w') as fh:
    json.dump(d,fh,ensure_ascii=False)
print('Reset to editing')
"

# Submit
curl -s -X POST http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/submit
echo ""

# Verify
bash /tmp/check-status.sh
