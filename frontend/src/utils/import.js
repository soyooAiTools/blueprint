import JSZip from 'jszip';

export function importFromJSON(json) {
  return buildNodesFromJSON(json, {});
}

function buildNodesFromJSON(json, modelDataMap) {
  const nodes = [];
  const edges = [];

  if (json.shots) {
    json.shots.forEach((shot, index) => {
      // Rebuild model data from zip if available
      let models = [];
      if (shot.models && shot.models.length > 0) {
        models = shot.models.map((m) => ({
          name: m.name,
          size: modelDataMap[m.path] ? modelDataMap[m.path].length : 0,
          data: modelDataMap[m.path] || '',
        }));
      }

      nodes.push({
        id: shot.id,
        type: 'shotNode',
        position: { x: 300, y: index * 400 + 50 },
        data: {
          label: shot.id.replace('shot_', '镜头'),
          name: shot.name || '',
          scene: shot.scene || '',
          controlTarget: shot.controlTarget || '',
          controlMethod: shot.controlMethod || '',
          triggers: shot.triggers || '',
          behavior: shot.behavior || '',
          entryCondition: shot.entryCondition || '',
          endCondition: shot.endCondition || '',
          branchCondition: shot.branch ? shot.branch.condition || '' : '',
          branchTrue: shot.branch ? shot.branch.ifTrue || '' : '',
          branchFalse: shot.branch ? shot.branch.ifFalse || '' : '',
          branchCondition2: shot.branch2 ? shot.branch2.condition || '' : '',
          branchTrue2: shot.branch2 ? shot.branch2.ifTrue || '' : '',
          branchFalse2: shot.branch2 ? shot.branch2.ifFalse || '' : '',
          images: shot.images || [],
          models: models.length > 0 ? models : [],
        },
      });

      if (shot.transitions) {
        shot.transitions.forEach((t, ti) => {
          const edge = {
            id: `e-${shot.id}-${t.target}-${ti}`,
            source: shot.id,
            target: t.target,
            type: 'smoothstep',
            animated: true,
            style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 },
            markerEnd: {
              type: 'arrowclosed',
              color: 'rgba(255,255,255,0.5)',
            },
          };
          if (t.condition) {
            edge.label = t.condition;
            edge.labelStyle = { fill: '#fff', fontWeight: 700, fontSize: 12 };
            edge.labelBgStyle = { fill: '#f59e0b', fillOpacity: 0.9 };
            edge.labelBgPadding = [6, 4];
            edge.labelBgBorderRadius = 4;
          }
          edges.push(edge);
        });
      }
    });
  }

  if (json.annotations) {
    json.annotations.forEach((ann) => {
      nodes.push({
        id: ann.id,
        type: 'noteNode',
        position: { x: ann.x, y: ann.y },
        data: { text: ann.text || '' },
      });
    });
  }

  return { nodes, edges, projectName: json.project || '未命名项目' };
}

export async function readFileAsJSON(file) {
  // Handle zip files
  if (file.name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    
    // Find blueprint.json in zip
    const jsonFile = zip.file('blueprint.json');
    if (!jsonFile) {
      throw new Error('zip 中未找到 blueprint.json');
    }
    const jsonText = await jsonFile.async('string');
    const json = JSON.parse(jsonText);

    // Extract model files as data URLs
    const modelDataMap = {};
    const modelFiles = zip.file(/^models\//);
    for (const mf of modelFiles) {
      if (!mf.dir) {
        const base64 = await mf.async('base64');
        modelDataMap[mf.name] = `data:application/octet-stream;base64,${base64}`;
      }
    }

    const result = buildNodesFromJSON(json, modelDataMap);
    return { __parsed: true, ...result };
  }

  // Handle plain JSON
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        resolve(JSON.parse(e.target.result));
      } catch (err) {
        reject(new Error('无效的 JSON 文件'));
      }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}
