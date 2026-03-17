const fs = require('fs');
const http = require('http');
const v4 = JSON.parse(fs.readFileSync('docs/qmjs-v4-blueprint.json', 'utf8'));

// Convert phases to event-driven rules (条件→动作)
// Each phase's endCondition becomes the NEXT phase's triggerCondition
const phases = v4.phases;
const nodes = phases.map((ph, i) => {
  // Phase 1's trigger is gameStart
  // Phase N's trigger is Phase (N-1)'s endCondition
  let triggerCondition;
  if (i === 0) {
    triggerCondition = 'gameStart';
  } else {
    triggerCondition = phases[i - 1].endCondition || '';
  }

  return {
    id: `phase_${i + 1}`,
    type: 'phaseNode',
    // Layout: spread out in a grid, not linear
    position: {
      x: (i % 3) * 320 + 100,
      y: Math.floor(i / 3) * 220 + 50,
    },
    data: {
      phaseId: ph.id,
      label: ph.name,
      name: ph.name,
      triggerCondition,
      activate: ph.activate || [],
      actions: [],
      guide: ph.guide || '',
      camera: ph.camera || { lookAt: '', zoom: 8 },
    },
  };
});

// Edges: connect based on condition dependencies, not linear
// A → B means: A's triggerCondition result enables B's triggerCondition
const edges = [];
for (let i = 0; i < phases.length - 1; i++) {
  // Only connect if there's a real dependency (endCondition → next trigger)
  if (phases[i].endCondition) {
    edges.push({
      id: `e_${i + 1}_${i + 2}`,
      source: nodes[i].id,
      target: nodes[i + 1].id,
      type: 'smoothstep',
      label: phases[i].endCondition, // Show condition on edge
      style: { stroke: '#7c5cfc' },
      labelStyle: { fontSize: 10, fill: '#aaa' },
    });
  }
}

const entities = v4.entities;

const body = JSON.stringify({
  nodes,
  edges,
  name: '取木射箭',
  objectRegistry: [],
  globalParams: v4.globalParams || {},
  globalSettings: v4.globalSettings || {},
  entities,
});

const req = http.request({
  hostname: 'localhost',
  port: 3901,
  path: '/api/projects/proj_1772426062293_qmjs/blueprint',
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log('Status:', res.statusCode, d));
});
req.write(body);
req.end();
