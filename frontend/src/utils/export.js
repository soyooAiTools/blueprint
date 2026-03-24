import JSZip from 'jszip';

export function exportToJSON(projectName, nodes, edges, extra) {
  const entityNodes = nodes.filter((n) => n.type === 'entityNode');
  const phaseNodes = nodes.filter((n) => n.type === 'phaseNode');
  const noteNodes = nodes.filter((n) => n.type === 'noteNode');
  const modelFiles = [];

  const entities = (extra && extra.entities) || entityNodes.map((n) => ({
    name: n.data.name || n.id,
    label: n.data.label || '',
    template: n.data.template || 'Static',
    visual: n.data.visual || {},
    spawn: n.data.spawn || {},
    trigger: n.data.trigger || {},
    actions: n.data.actions || [],
    behavior: n.data.behavior || {},
  }));

  const phases = phaseNodes.map((n, i) => ({
    id: n.data.id || i + 1,
    name: n.data.name || `Phase ${i + 1}`,
    activate: n.data.activate || [],
    endCondition: n.data.endCondition || '',
    guide: n.data.guide || '',
    camera: n.data.camera || {},
  }));

  const annotations = noteNodes.map((node) => ({
    id: node.id,
    text: node.data.text || '',
    x: node.position.x,
    y: node.position.y,
  }));

  const json = {
    version: 4,
    project: projectName,
    entities,
    phases,
    annotations,
    globalSettings: (extra && extra.globalSettings) || {},
    globalParams: (extra && extra.globalParams) || {},
  };

  return { json, modelFiles };
}

export function downloadJSON(data, filename) {
  const { json, modelFiles } = data;
  if (modelFiles && modelFiles.length > 0) {
    downloadZip(json, modelFiles, filename);
  } else {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'blueprint.json';
    a.click();
    URL.revokeObjectURL(url);
  }
}

function downloadZip(json, modelFiles, filename) {
  const zip = new JSZip();
  zip.file('blueprint.json', JSON.stringify(json, null, 2));
  for (const mf of modelFiles) {
    const base64 = mf.data.split(',')[1];
    if (base64) zip.file(mf.path, base64, { base64: true });
  }
  zip.generateAsync({ type: 'blob' }).then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (filename || 'blueprint').replace('.json', '') + '.zip';
    a.click();
    URL.revokeObjectURL(url);
  });
}
