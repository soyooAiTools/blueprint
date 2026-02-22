import JSZip from 'jszip';

export function exportToJSON(projectName, nodes, edges) {
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

    // Build transitions from edges (map old IDs to new sequential IDs)
    const transitions = outEdges
      .filter((e) => idMap[e.target])
      .map((e) => ({
        target: idMap[e.target],
        condition: e.label || '',
        sourceHandle: e.sourceHandle || '',
        targetHandle: e.targetHandle || '',
      }));

    // Process assets: strip base64 data, save model files for zip
    let assetRefs;
    if (node.data.assets && node.data.assets.length > 0) {
      assetRefs = node.data.assets.filter(a => a.targetName).map((asset) => {
        const assetModels = (asset.models || []).map((m) => {
          const path = `models/${shotId}/${asset.targetName}/${m.name}`;
          modelFiles.push({ path, data: m.data, name: m.name });
          return { name: m.name, path };
        });
        return {
          targetName: asset.targetName,
          models: assetModels.length > 0 ? assetModels : undefined,
          images: (asset.images && asset.images.length > 0) ? asset.images : undefined,
        };
      });
    }

    return {
      id: shotId,
      position: { x: node.position.x, y: node.position.y },
      transitions: transitions.length > 0 ? transitions : undefined,
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
      assets: assetRefs || undefined,
      feedback: (node.data.feedback && node.data.feedback.filter(f => f.status !== 'fixed').length > 0)
        ? node.data.feedback.filter(f => f.status !== 'fixed').map(f => ({
            type: f.type,
            status: f.status,
            text: f.text,
          }))
        : undefined,
      revisions: (node.data.revisions && node.data.revisions.filter(r => r.status === 'pending').length > 0)
        ? node.data.revisions.filter(r => r.status === 'pending').map(r => ({
            type: r.type,
            priority: r.priority,
            instruction: r.instruction,
          }))
        : undefined,
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
