#!/usr/bin/env node
// submit-blueprint.cjs — 分镜 JSON → Blueprint 流水线一键提交
// Usage: node submit-blueprint.cjs <storyboard.json> [--server http://localhost:3901] [--svn svn://...]
//
// 输入格式（分镜 JSON）:
// {
//   "project": "项目名",
//   "shots": [
//     {
//       "id": "shot_1",
//       "position": { "x": 80, "y": 20 },
//       "transitions": [{ "target": "shot_2" }],
//       "name": "镜头名称",
//       "scene": "场景描述",
//       "controlTarget": "操控对象",
//       "controlMethod": "操控方式",
//       "triggers": "触发逻辑",
//       "behavior": "数值/行为",
//       "entryCondition": "进入条件",
//       "endCondition": "结束条件",
//       "branch": { "condition": "xxx", "ifTrue": "shot_2", "ifFalse": "" },
//       "branch2": null,
//       "images": ["data:image/png;base64,..."]  // 可选，会被去掉
//     }
//   ]
// }

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ Config ============
const args = process.argv.slice(2);
const jsonPath = args.find(a => !a.startsWith('--'));
if (!jsonPath) {
  console.error('Usage: node submit-blueprint.cjs <storyboard.json> [--server URL] [--svn URL]');
  process.exit(1);
}

const SERVER = getArg('--server') || 'http://localhost:3901';
const SVN_URL = getArg('--svn') || 'svn://47.101.191.213:3690/test0213';

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

// ============ Convert storyboard JSON → blueprint format ============
function convertToBlueprint(storyboard) {
  const shots = storyboard.shots || [];
  const nodes = [];
  const edges = [];

  for (const shot of shots) {
    // Build node
    const node = {
      id: shot.id,
      type: 'shotNode',
      position: shot.position || { x: nodes.length * 400, y: 0 },
      data: {
        name: shot.name || '',
        scene: shot.scene || '',
        controlTarget: shot.controlTarget || '',
        controlMethod: shot.controlMethod || '',
        triggers: shot.triggers || '',
        behavior: shot.behavior || '',
        entryCondition: shot.entryCondition || '',
        endCondition: shot.endCondition || '',
        branch: shot.branch || null,
        branch2: shot.branch2 || null,
        images: [] // Strip base64 images
      }
    };
    nodes.push(node);

    // Build edges from transitions
    if (shot.transitions) {
      for (const t of shot.transitions) {
        if (t.target) {
          edges.push({
            id: `e_${shot.id}_${t.target}`,
            source: shot.id,
            target: t.target,
            sourceHandle: t.sourceHandle || '',
            targetHandle: t.targetHandle || ''
          });
        }
      }
    }
  }

  return {
    nodes,
    edges,
    projectName: storyboard.project || path.basename(jsonPath, '.json')
  };
}

// ============ HTTP helper ============
function apiRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, SERVER);
    const isHttps = fullUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const opts = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      rejectUnauthorized: false,
      timeout: 15000
    };

    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try {
          const data = JSON.parse(text);
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data.error || text}`));
          else resolve(data);
        } catch (e) {
          reject(new Error(`Parse error: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ============ Main ============
async function main() {
  // 1. Read storyboard JSON
  console.log(`Reading: ${jsonPath}`);
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const storyboard = JSON.parse(raw);
  const projectName = storyboard.project || path.basename(jsonPath, '.json');

  // 2. Convert to blueprint
  const blueprint = convertToBlueprint(storyboard);
  console.log(`Converted: ${blueprint.nodes.length} nodes, ${blueprint.edges.length} edges`);

  // 3. Create project
  console.log(`Creating project: ${projectName}`);
  const project = await apiRequest('POST', '/api/projects', {
    name: projectName,
    svnUrl: SVN_URL
  });
  console.log(`Project created: ${project.id}`);

  // 4. Save blueprint
  console.log('Saving blueprint...');
  await apiRequest('PUT', `/api/projects/${project.id}/blueprint`, blueprint);
  console.log('Blueprint saved');

  // 5. Submit
  console.log('Submitting to pipeline...');
  const result = await apiRequest('POST', `/api/projects/${project.id}/submit`);
  console.log(`✅ Submitted! Task ID: ${result.taskId || project.id}`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Monitor: ${SERVER}/api/projects/${project.id}`);

  return project.id;
}

main().catch(e => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
