const fs = require('fs');
const { execSync } = require('child_process');

// 读取原始蓝图数据
const recovered = JSON.parse(fs.readFileSync('recovered-qmjs.json', 'utf-8'));
const globalData = JSON.parse(fs.readFileSync('global-data.json', 'utf-8'));

// 合并：保留原始 nodes/edges + 加入全局数据
const merged = {
  nodes: recovered.nodes,
  edges: recovered.edges,
  projectName: recovered.projectName,
  objectRegistry: globalData.objectRegistry,
  globalParams: globalData.globalParams,
  globalSettings: globalData.globalSettings,
};

// 写合并文件
fs.writeFileSync('merged-blueprint.json', JSON.stringify(merged), 'utf-8');
console.log('Merged:', merged.nodes.length, 'nodes,', merged.edges.length, 'edges,', merged.objectRegistry.length, 'objects');
console.log('Uploading...');

// SCP + curl
execSync('scp -o StrictHostKeyChecking=no merged-blueprint.json root@120.55.70.226:/tmp/merged-blueprint.json', { stdio: 'inherit' });
const result = execSync('ssh root@120.55.70.226 "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; curl -s -X PUT -H \'Content-Type: application/json\' -d @/tmp/merged-blueprint.json http://127.0.0.1:3901/api/projects/proj_1772426062293_qmjs/blueprint"', { encoding: 'utf-8' });
console.log('Result:', result);
