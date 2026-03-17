import JSZip from 'jszip';

export function exportToJSON(projectName, nodes, edges, extra) {
  const shotNodes = nodes.filter((n) => n.type === 'shotNode');
  const noteNodes = nodes.filter((n) => n.type === 'noteNode');

  // Build old→new ID mapping (sequential: shot_1, shot_2, ...)
  const idMap = {};
  shotNodes.forEach((node, i) => {
    idMap[node.id] = `shot_${i + 1}`;
  });
  noteNodes.forEach((node, i) => {
    idMap[node.id] = `note_${i + 1}`;
  });

  // Collect all model files for zip
  const modelFiles = [];

  const shots = shotNodes.map((node) => {
    const outEdges = edges.filter((e) => e.source === node.id);
    const shotId = idMap[node.id];

    // Process models: strip base64 data, save references
    let modelRefs;
    if (node.data.models && node.data.models.length > 0) {
      modelRefs = node.data.models.map((m) => {
        const path = `models/${shotId}/${m.name}`;
        modelFiles.push({ path, data: m.data, name: m.name });
        return { name: m.name, path };
      });
    }

    return {
      id: shotId,
      name: node.data.name || '',
      scene: node.data.scene || '',
      controlTarget: node.data.controlTarget || '',
      controlMethod: node.data.controlMethod || '',
      triggers: node.data.triggers || '',
      behavior: node.data.behavior || '',
      entryCondition: node.data.entryCondition || '',
      endCondition: node.data.endCondition || '',
      branch: node.data.branchCondition ? {
        condition: node.data.branchCondition,
        ifTrue: node.data.branchTrue || '',
        ifFalse: node.data.branchFalse || '',
      } : null,
      branch2: node.data.branchCondition2 ? {
        condition: node.data.branchCondition2,
        ifTrue: node.data.branchTrue2 || '',
        ifFalse: node.data.branchFalse2 || '',
      } : null,
      images: (node.data.images && node.data.images.length > 0) ? node.data.images : undefined,
      models: modelRefs || undefined,
    };
  });

  const annotations = noteNodes.map((node) => ({
    id: idMap[node.id],
    text: node.data.text || '',
    x: node.position.x,
    y: node.position.y,
  }));

  const json = {
    project: projectName,
    shots,
    annotations,
    ...(extra && extra.objectRegistry ? { objectRegistry: extra.objectRegistry } : {}),
    ...(extra && extra.globalParams ? { globalParams: extra.globalParams } : {}),
  };

  return { json, modelFiles };
}

export function downloadJSON(data, filename) {
  const { json, modelFiles } = data;

  if (modelFiles && modelFiles.length > 0) {
    // Export as zip with JSON + model files
    downloadZip(json, modelFiles, filename);
  } else {
    // No models, export plain JSON
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: 'application/json',
    });
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

  // Add JSON
  zip.file('blueprint.json', JSON.stringify(json, null, 2));

  // Add model files
  for (const mf of modelFiles) {
    // mf.data is a data URL like "data:application/octet-stream;base64,..."
    const base64 = mf.data.split(',')[1];
    if (base64) {
      zip.file(mf.path, base64, { base64: true });
    }
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
