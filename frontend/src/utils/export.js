import JSZip from 'jszip';

export function exportToJSON(projectName, nodes, edges, extra) {
  // V4: entity-driven export
  const entityNodes = nodes.filter((n) => n.type === 'entityNode');
  const phaseNodes = nodes.filter((n) => n.type === 'phaseNode');
  const noteNodes = nodes.filter((n) => n.type === 'noteNode');

  // Legacy V3 shotNodes (backward compat)
  const shotNodes = nodes.filter((n) => n.type === 'shotNode');

  const isV4 = entityNodes.length > 0 || (extra && extra.entities && extra.entities.length > 0);

  const modelFiles = [];

  if (isV4) {
    // V4 export
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

  // Legacy V3 export
  const idMap = {};
  shotNodes.forEach((node, i) => { idMap[node.id] = `shot_${i + 1}`; });
  noteNodes.forEach((node, i) => { idMap[node.id] = `note_${i + 1}`; });

  const shots = shotNodes.map((node) => {
    const outEdges = edges.filter((e) => e.source === node.id);
    const shotId = idMap[node.id];
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
