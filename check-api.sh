#!/bin/bash
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
curl -s http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs | python3 -c "
import sys,json
d=json.load(sys.stdin)
b=d.get('blueprint',{})
print('blueprint keys:', list(b.keys()))
print('objectRegistry count:', len(b.get('objectRegistry',[])))
print('globalParams length:', len(b.get('globalParams','')))
print('globalSettings:', b.get('globalSettings'))
print('nodes count:', len(b.get('nodes',[])))
"
