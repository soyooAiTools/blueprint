import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import {
  diffStoryboardFlow,
  generateStoryboardFlowSourceIr,
  getStoryboardFlow,
  saveStoryboardFlow,
  validateStoryboardFlow,
} from '../utils/api';

const FLOW_SCHEMA_VERSION = 'storyboard-flow-prototype.v1';
const FLOW_KIND = 'blueprint.storyboardFlowPrototype';

const ACTIONS = [
  'move_to',
  'collect',
  'produce',
  'deliver',
  'transfer',
  'unlock',
  'build',
  'upgrade',
  'show',
  'select',
  'attack',
  'wait',
  'cta_finish',
];

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(value, fallback) {
  const text = String(value || fallback || '').trim()
    .replace(/[^A-Za-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || fallback || '';
}

function listToText(value) {
  return safeArray(value).join('\n');
}

function textToList(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function nextPhaseId(phases) {
  let i = safeArray(phases).length + 1;
  const used = new Set(safeArray(phases).map((phase) => phase.id));
  while (used.has('phase' + String(i).padStart(2, '0'))) i += 1;
  return 'phase' + String(i).padStart(2, '0');
}

function actionColor(action) {
  if (action === 'collect') return '#235b73';
  if (action === 'produce') return '#4d6744';
  if (action === 'deliver' || action === 'transfer') return '#5c4b24';
  if (action === 'unlock' || action === 'upgrade' || action === 'build') return '#734627';
  if (action === 'cta_finish') return '#6b263d';
  return '#26395f';
}

function actionDefaultInteraction(phase) {
  const action = String(phase.action || 'show');
  const target = cleanId(phase.target, 'Target');
  const resource = cleanId(phase.resource, 'Item');
  const amount = Number(phase.amount || phase.cost || 1) || 1;
  if (action === 'move_to') return ['move_to:' + target];
  if (action === 'collect') return ['collect:' + resource + ':' + amount];
  if (action === 'produce') return ['produce:' + resource + ':' + amount];
  if (action === 'deliver') return ['deliver:' + resource + ':' + target + ':' + amount];
  if (action === 'transfer') return ['transfer:' + resource + ':' + target + ':' + amount];
  if (action === 'unlock') return ['unlock:' + target];
  if (action === 'build') return ['build:' + target];
  if (action === 'upgrade') return ['upgrade:' + target + ':2'];
  if (action === 'select') return ['select:' + target];
  if (action === 'attack') return ['attack:' + target];
  if (action === 'wait') return ['wait:' + amount];
  if (action === 'cta_finish') return ['click:CtaButton'];
  return ['show:' + target];
}

function defaultChefFlow(projectName) {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    kind: FLOW_KIND,
    projectName: projectName || 'MC原创_3D流水线小主厨解锁餐厅',
    project: { name: projectName || 'MC原创_3D流水线小主厨解锁餐厅', theme: 'restaurant' },
    entities: [
      { id: 'Player', label: '小主厨', kind: 'player' },
      { id: 'OrderCounter', label: '订单柜台', kind: 'station' },
      { id: 'IngredientBox', label: '食材箱', kind: 'station' },
      { id: 'Fryer', label: '炸炉', kind: 'station' },
      { id: 'CustomerQueue', label: '顾客队列', kind: 'npc' },
      { id: 'MoneyRegister', label: '收银台', kind: 'station' },
      { id: 'UnlockCircle', label: '解锁圈', kind: 'unlock' },
      { id: 'NewRestaurant', label: '新餐厅', kind: 'building' },
      { id: 'CtaButton', label: '下载按钮', kind: 'cta' },
    ],
    resources: [
      { id: 'Ingredient', label: '食材', carrierEntity: 'IngredientBox', initial: 0 },
      { id: 'Meal', label: '餐食', carrierEntity: 'Fryer', initial: 0 },
      { id: 'Coin', label: '金币', carrierEntity: 'MoneyRegister', initial: 0 },
    ],
    phases: [
      { id: 'phase01_order', order: 1, title: '接到订单', action: 'show', target: 'OrderCounter', guideText: '查看顾客订单，准备开始烹饪。', visibleEntities: ['Player', 'OrderCounter', 'CustomerQueue'], requiredInteractions: ['show:OrderCounter'], completeCondition: 'OrderCounter.visible' },
      { id: 'phase02_collect', order: 2, title: '领取食材', action: 'collect', target: 'IngredientBox', resource: 'Ingredient', amount: 1, guideText: '移动到食材箱，领取本次订单食材。', visibleEntities: ['Player', 'IngredientBox', 'OrderCounter'], requiredInteractions: ['collect:Ingredient:1'], completeCondition: 'Ingredient >= 1' },
      { id: 'phase03_cook', order: 3, title: '烹饪餐食', action: 'produce', target: 'Fryer', resource: 'Meal', amount: 1, guideText: '把食材送到炸炉，制作餐食。', visibleEntities: ['Player', 'Fryer', 'IngredientBox'], requiredInteractions: ['transfer:Ingredient:Fryer:1', 'produce:Meal:1'], completeCondition: 'Meal >= 1' },
      { id: 'phase04_deliver', order: 4, title: '交付餐食', action: 'deliver', target: 'CustomerQueue', resource: 'Meal', amount: 1, guideText: '将餐食交给排队顾客。', visibleEntities: ['Player', 'CustomerQueue', 'Fryer'], requiredInteractions: ['deliver:Meal:CustomerQueue:1'], completeCondition: 'CustomerQueue.packed' },
      { id: 'phase05_reward', order: 5, title: '获得金币', action: 'produce', target: 'MoneyRegister', resource: 'Coin', amount: 20, guideText: '收取订单金币，准备扩建餐厅。', visibleEntities: ['Player', 'MoneyRegister', 'CustomerQueue'], requiredInteractions: ['reward:Coin:20'], completeCondition: 'Coin >= 20' },
      { id: 'phase06_unlock_area', order: 6, title: '进入解锁圈', action: 'unlock', target: 'UnlockCircle', resource: 'Coin', cost: 20, guideText: '移动到解锁圈，消耗金币开启新区域。', visibleEntities: ['Player', 'UnlockCircle', 'MoneyRegister'], requiredInteractions: ['unlock:UnlockCircle'], completeCondition: 'UnlockCircle.unlocked' },
      { id: 'phase07_new_restaurant', order: 7, title: '展示新餐厅', action: 'show', target: 'NewRestaurant', guideText: '新餐厅区域出现，继续完成下一单。', visibleEntities: ['Player', 'NewRestaurant', 'UnlockCircle'], requiredInteractions: ['show:NewRestaurant'], completeCondition: 'NewRestaurant.visible' },
      { id: 'phase08_second_order', order: 8, title: '第二单生产', action: 'produce', target: 'Fryer', resource: 'Meal', amount: 1, guideText: '在新区域继续制作餐食。', visibleEntities: ['Player', 'NewRestaurant', 'Fryer'], requiredInteractions: ['collect:Ingredient:1', 'transfer:Ingredient:Fryer:1', 'produce:Meal:1'], completeCondition: 'Meal >= 1' },
      { id: 'phase09_second_deliver', order: 9, title: '第二单交付', action: 'deliver', target: 'CustomerQueue', resource: 'Meal', amount: 1, guideText: '把新做好的餐食交给顾客。', visibleEntities: ['Player', 'CustomerQueue', 'NewRestaurant'], requiredInteractions: ['deliver:Meal:CustomerQueue:1', 'reward:Coin:30'], completeCondition: 'Coin >= 30' },
      { id: 'phase10_cta', order: 10, title: '下载引导', action: 'cta_finish', target: 'CtaButton', guideText: '完成餐厅解锁，点击按钮下载完整游戏。', visibleEntities: ['Player', 'NewRestaurant', 'CtaButton'], requiredInteractions: ['click:CtaButton'], completeCondition: 'CtaButton.clicked' },
    ],
  };
}

function defaultGenericFlow(projectName) {
  const phases = Array.from({ length: 10 }).map((_, index) => {
    const order = index + 1;
    const id = 'phase' + String(order).padStart(2, '0');
    const final = order === 10;
    return {
      id,
      order,
      title: final ? '结束下载' : '阶段 ' + order,
      action: final ? 'cta_finish' : 'show',
      target: final ? 'CtaButton' : 'Target' + order,
      guideText: final ? '点击按钮下载完整游戏。' : '完成第 ' + order + ' 个操作。',
      visibleEntities: final ? ['Player', 'CtaButton'] : ['Player', 'Target' + order],
      requiredInteractions: final ? ['click:CtaButton'] : ['show:Target' + order],
      completeCondition: final ? 'CtaButton.clicked' : 'Target' + order + '.visible',
    };
  });
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    kind: FLOW_KIND,
    projectName: projectName || 'storyboard-flow',
    project: { name: projectName || 'storyboard-flow', theme: 'default' },
    entities: [{ id: 'Player', label: '玩家', kind: 'player' }, { id: 'CtaButton', label: '下载按钮', kind: 'cta' }],
    resources: [],
    phases,
  };
}

function createDefaultFlow(projectName) {
  if (/小主厨|厨|餐厅|restaurant/i.test(String(projectName || ''))) return defaultChefFlow(projectName);
  return defaultGenericFlow(projectName);
}

function normalizeFlow(flow, projectName) {
  const base = flow && typeof flow === 'object' ? flow : createDefaultFlow(projectName);
  return {
    ...base,
    schemaVersion: base.schemaVersion || FLOW_SCHEMA_VERSION,
    kind: base.kind || FLOW_KIND,
    projectName: base.projectName || projectName || 'storyboard-flow',
    project: base.project || { name: base.projectName || projectName || 'storyboard-flow' },
    entities: safeArray(base.entities),
    resources: safeArray(base.resources),
    phases: safeArray(base.phases).map((phase, index) => ({
      ...phase,
      id: cleanId(phase.id, 'phase' + String(index + 1).padStart(2, '0')),
      order: Number(phase.order || index + 1),
      title: phase.title || phase.name || phase.id || 'Phase ' + (index + 1),
      action: phase.action || 'show',
      target: phase.target || '',
      resource: phase.resource || '',
      amount: phase.amount || '',
      cost: phase.cost || '',
      guideText: phase.guideText || phase.guide || '',
      visibleEntities: safeArray(phase.visibleEntities || phase.entities),
      requiredInteractions: safeArray(phase.requiredInteractions && phase.requiredInteractions.length ? phase.requiredInteractions : actionDefaultInteraction(phase)),
      completeCondition: phase.completeCondition || '',
      visualNotes: phase.visualNotes || '',
      notes: phase.notes || '',
      position: phase.position || { x: index * 260, y: (index % 2) * 110 },
    })).sort((a, b) => Number(a.order || 0) - Number(b.order || 0)),
  };
}

function inferCatalogs(flow) {
  const entityIds = new Set();
  const resourceIds = new Set();
  safeArray(flow.entities).forEach((entity) => entity?.id && entityIds.add(entity.id));
  safeArray(flow.resources).forEach((resource) => resource?.id && resourceIds.add(resource.id));
  safeArray(flow.phases).forEach((phase) => {
    if (phase.target) entityIds.add(cleanId(phase.target, ''));
    safeArray(phase.visibleEntities).forEach((id) => entityIds.add(cleanId(id, '')));
    if (phase.resource) resourceIds.add(cleanId(phase.resource, ''));
    safeArray(phase.requiredInteractions).forEach((raw) => {
      const parts = String(raw || '').split(':').map((item) => item.trim());
      const verb = parts[0];
      if (['collect', 'produce', 'reward', 'deliver', 'transfer', 'combine'].includes(verb) && parts[1]) resourceIds.add(cleanId(parts[1], ''));
      if (['move_to', 'move', 'show', 'unlock', 'build', 'upgrade', 'select', 'attack', 'deliver', 'transfer', 'combine'].includes(verb) && parts[2]) entityIds.add(cleanId(parts[2], ''));
      if (['move_to', 'move', 'show', 'unlock', 'build', 'upgrade', 'select', 'attack'].includes(verb) && parts[1]) entityIds.add(cleanId(parts[1], ''));
      if (verb === 'click') entityIds.add(cleanId(parts[1], 'CtaButton'));
    });
  });
  entityIds.add('Player');
  const entities = Array.from(entityIds).filter(Boolean).sort().map((id) => {
    const existing = safeArray(flow.entities).find((entity) => entity.id === id);
    return existing || { id, label: id, kind: id === 'Player' ? 'player' : id === 'CtaButton' ? 'cta' : 'prop' };
  });
  const resources = Array.from(resourceIds).filter(Boolean).sort().map((id) => {
    const existing = safeArray(flow.resources).find((resource) => resource.id === id);
    return existing || { id, label: id, carrierEntity: id, initial: 0 };
  });
  return { entities, resources };
}

function buildNodes(flow, selectedPhaseId) {
  return safeArray(flow.phases).map((phase, index) => ({
    id: phase.id,
    type: 'default',
    position: phase.position || { x: index * 260, y: 0 },
    data: {
      label: (
        <div className="flow-node-label">
          <strong>{String(index + 1).padStart(2, '0')} · {phase.title || phase.id}</strong>
          <span>{phase.action || 'show'} {phase.target ? '→ ' + phase.target : ''}</span>
        </div>
      ),
    },
    style: {
      width: 210,
      minHeight: 76,
      borderRadius: 8,
      border: selectedPhaseId === phase.id ? '2px solid #f8fafc' : '1px solid rgba(148, 163, 184, 0.45)',
      background: actionColor(phase.action),
      color: '#f8fafc',
      boxShadow: selectedPhaseId === phase.id ? '0 0 0 4px rgba(56, 189, 248, 0.18)' : '0 16px 28px rgba(0, 0, 0, 0.22)',
    },
  }));
}

function buildEdges(flow) {
  const phases = safeArray(flow.phases);
  return phases.slice(0, -1).map((phase, index) => ({
    id: phase.id + '__' + phases[index + 1].id,
    source: phase.id,
    target: phases[index + 1].id,
    type: 'smoothstep',
    animated: true,
    style: { stroke: 'rgba(226, 232, 240, 0.72)', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed', color: 'rgba(226, 232, 240, 0.72)' },
  }));
}

function summarizeIssues(report) {
  const counts = report?.issueCounts || report?.diffCounts || {};
  return `${counts.blocker || 0} blocker · ${counts.warn || 0} warn · ${counts.info || 0} info`;
}

function ResourceSnapshots({ report }) {
  const rows = safeArray(report?.resourceSnapshots);
  if (!rows.length) return null;
  return (
    <div className="flow-report-block">
      <div className="flow-report-title">资源快照</div>
      <div className="flow-snapshot-list">
        {rows.map((row) => (
          <div key={row.phaseId} className="flow-snapshot-row">
            <span>{row.phaseOrder}. {row.phaseId}</span>
            <code>{JSON.stringify(row.after || {})}</code>
            {row.cost && <strong className={row.cost.affordable ? 'ok' : 'warn'}>{row.cost.resource} -{row.cost.amount}</strong>}
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffList({ report }) {
  const diffs = safeArray(report?.diffs).slice(0, 12);
  if (!diffs.length) return null;
  return (
    <div className="flow-report-block">
      <div className="flow-report-title">差异</div>
      <div className="flow-diff-list">
        {diffs.map((diff, index) => (
          <div key={index} className={'flow-diff-row ' + diff.severity}>
            <strong>{diff.severity}</strong>
            <span>{diff.code}</span>
            <small>{diff.message}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function FlowAuthoringPanel({
  projectId,
  projectName,
  sourceHtmlPath,
  onSourceHtmlGenerated,
  showAlert,
}) {
  const [flow, setFlow] = useState(() => normalizeFlow(null, projectName));
  const [selectedPhaseId, setSelectedPhaseId] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState(null);
  const [diffReport, setDiffReport] = useState(null);
  const [sourceResult, setSourceResult] = useState(null);
  const [entitiesText, setEntitiesText] = useState('[]');
  const [resourcesText, setResourcesText] = useState('[]');
  const [catalogError, setCatalogError] = useState('');

  const selectedPhase = useMemo(
    () => safeArray(flow.phases).find((phase) => phase.id === selectedPhaseId) || safeArray(flow.phases)[0] || null,
    [flow.phases, selectedPhaseId],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStoryboardFlow(projectId)
      .then((data) => {
        if (cancelled) return;
        const nextFlow = normalizeFlow(data.flow || null, projectName);
        setFlow(nextFlow);
        setSelectedPhaseId(nextFlow.phases[0]?.id || '');
        setReport(data.authoringReport || null);
        setDiffReport(data.diffReport || null);
        setSourceResult(data.sourceIrReport ? { report: data.sourceIrReport, urls: data.urls, paths: data.paths } : null);
      })
      .catch(() => {
        if (cancelled) return;
        const nextFlow = normalizeFlow(null, projectName);
        setFlow(nextFlow);
        setSelectedPhaseId(nextFlow.phases[0]?.id || '');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, projectName]);

  useEffect(() => {
    setNodes(buildNodes(flow, selectedPhase?.id));
    setEdges(buildEdges(flow));
    setEntitiesText(JSON.stringify(safeArray(flow.entities), null, 2));
    setResourcesText(JSON.stringify(safeArray(flow.resources), null, 2));
  }, [flow, selectedPhase?.id, setEdges, setNodes]);

  const updateFlow = useCallback((updater) => {
    setFlow((prev) => normalizeFlow(typeof updater === 'function' ? updater(prev) : updater, projectName));
  }, [projectName]);

  const updateSelectedPhase = useCallback((patch) => {
    if (!selectedPhase) return;
    updateFlow((prev) => ({
      ...prev,
      phases: safeArray(prev.phases).map((phase) => (
        phase.id === selectedPhase.id ? { ...phase, ...patch } : phase
      )),
    }));
    if (patch.id) setSelectedPhaseId(patch.id);
  }, [selectedPhase, updateFlow]);

  const materializeFlow = useCallback(() => {
    let entities = flow.entities;
    let resources = flow.resources;
    try {
      entities = JSON.parse(entitiesText || '[]');
      resources = JSON.parse(resourcesText || '[]');
      setCatalogError('');
    } catch (err) {
      setCatalogError(err.message);
      throw new Error('实体或资源目录 JSON 格式错误: ' + err.message);
    }
    const base = normalizeFlow({ ...flow, entities, resources }, projectName);
    const inferred = inferCatalogs(base);
    return normalizeFlow({
      ...base,
      entities: inferred.entities,
      resources: inferred.resources,
      phases: safeArray(base.phases).map((phase, index) => ({
        ...phase,
        order: index + 1,
        requiredInteractions: safeArray(phase.requiredInteractions).length ? phase.requiredInteractions : actionDefaultInteraction(phase),
      })),
    }, projectName);
  }, [entitiesText, flow, projectName, resourcesText]);

  const runAction = useCallback(async (label, fn) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      await showAlert?.('Flow 操作失败: ' + (err.message || err));
    } finally {
      setBusy('');
    }
  }, [showAlert]);

  const handleSave = useCallback(() => runAction('保存中', async () => {
    const nextFlow = materializeFlow();
    setFlow(nextFlow);
    await saveStoryboardFlow(projectId, nextFlow);
    await showAlert?.('Flow 已保存');
  }), [materializeFlow, projectId, runAction, showAlert]);

  const handleValidate = useCallback(() => runAction('校验中', async () => {
    const nextFlow = materializeFlow();
    setFlow(nextFlow);
    const data = await validateStoryboardFlow(projectId, nextFlow);
    setReport(data.report);
  }), [materializeFlow, projectId, runAction]);

  const handleGenerate = useCallback(() => runAction('生成中', async () => {
    const nextFlow = materializeFlow();
    setFlow(nextFlow);
    const data = await generateStoryboardFlowSourceIr(projectId, nextFlow);
    setSourceResult(data);
    setReport(data.authoringReport || data.report || null);
    onSourceHtmlGenerated?.(data);
  }), [materializeFlow, onSourceHtmlGenerated, projectId, runAction]);

  const handleDiff = useCallback(() => runAction('对比中', async () => {
    const nextFlow = materializeFlow();
    setFlow(nextFlow);
    const data = await diffStoryboardFlow(projectId, nextFlow, sourceHtmlPath);
    setDiffReport(data.report);
  }), [materializeFlow, projectId, runAction, sourceHtmlPath]);

  const handleAddPhase = useCallback(() => {
    const id = nextPhaseId(flow.phases);
    updateFlow((prev) => ({
      ...prev,
      phases: safeArray(prev.phases).concat({
        id,
        order: safeArray(prev.phases).length + 1,
        title: '新增阶段',
        action: 'show',
        target: 'Target',
        guideText: '完成新增阶段操作。',
        visibleEntities: ['Player', 'Target'],
        requiredInteractions: ['show:Target'],
        completeCondition: 'Target.visible',
        position: { x: safeArray(prev.phases).length * 260, y: 0 },
      }),
    }));
    setSelectedPhaseId(id);
  }, [flow.phases, updateFlow]);

  const handleDeletePhase = useCallback(() => {
    if (!selectedPhase || safeArray(flow.phases).length <= 1) return;
    const remaining = safeArray(flow.phases).filter((phase) => phase.id !== selectedPhase.id)
      .map((phase, index) => ({ ...phase, order: index + 1 }));
    updateFlow((prev) => ({ ...prev, phases: remaining }));
    setSelectedPhaseId(remaining[0]?.id || '');
  }, [flow.phases, selectedPhase, updateFlow]);

  const handleNodeDragStop = useCallback((_, node) => {
    updateFlow((prev) => ({
      ...prev,
      phases: safeArray(prev.phases).map((phase) => (
        phase.id === node.id ? { ...phase, position: node.position } : phase
      )),
    }));
  }, [updateFlow]);

  const handleCatalogBlur = useCallback(() => {
    try {
      const entities = JSON.parse(entitiesText || '[]');
      const resources = JSON.parse(resourcesText || '[]');
      setCatalogError('');
      updateFlow((prev) => ({ ...prev, entities, resources }));
    } catch (err) {
      setCatalogError(err.message);
    }
  }, [entitiesText, resourcesText, updateFlow]);

  const exportFlow = useCallback(() => {
    const nextFlow = materializeFlow();
    const blob = new Blob([JSON.stringify(nextFlow, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (projectName || 'storyboard-flow') + '.flow.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [materializeFlow, projectName]);

  if (loading) {
    return <div className="flow-authoring-panel"><div className="flow-loading">加载 Flow...</div></div>;
  }

  return (
    <div className="flow-authoring-panel">
      <div className="flow-authoring-toolbar">
        <button onClick={handleSave} disabled={!!busy}>{busy === '保存中' ? '保存中...' : '保存 Flow'}</button>
        <button onClick={handleValidate} disabled={!!busy}>{busy === '校验中' ? '校验中...' : '校验 Flow'}</button>
        <button onClick={handleGenerate} disabled={!!busy}>{busy === '生成中' ? '生成中...' : '生成 SourceIR'}</button>
        <button onClick={handleDiff} disabled={!!busy || !sourceHtmlPath}>{busy === '对比中' ? '对比中...' : '对比 HTML'}</button>
        <button onClick={exportFlow} disabled={!!busy}>导出 JSON</button>
        <span className="flow-toolbar-state">
          {report ? '校验 ' + summarizeIssues(report) : '未校验'}
          {diffReport ? ' · diff ' + summarizeIssues(diffReport) : ''}
        </span>
      </div>

      <div className="flow-authoring-layout">
        <div className="flow-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => setSelectedPhaseId(node.id)}
            onPaneClick={() => setSelectedPhaseId('')}
            onNodeDragStop={handleNodeDragStop}
            nodesDraggable
            panOnDrag={[1, 2]}
            zoomOnScroll
            zoomOnPinch
            fitView
            fitViewOptions={{ padding: 0.24 }}
            minZoom={0.2}
          >
            <Background color="#334155" gap={22} size={1} variant="dots" />
            <Controls position="bottom-left" />
            <MiniMap position="bottom-right" pannable zoomable nodeStrokeWidth={2} />
          </ReactFlow>
        </div>

        <aside className="flow-inspector">
          <div className="flow-inspector-header">
            <strong>{selectedPhase ? selectedPhase.title : 'Flow'}</strong>
            <div>
              <button onClick={handleAddPhase}>新增</button>
              <button onClick={handleDeletePhase} disabled={!selectedPhase || safeArray(flow.phases).length <= 1}>删除</button>
            </div>
          </div>

          {selectedPhase ? (
            <div className="flow-form">
              <label>Phase ID<input value={selectedPhase.id} onChange={(e) => updateSelectedPhase({ id: cleanId(e.target.value, selectedPhase.id) })} /></label>
              <label>标题<input value={selectedPhase.title || ''} onChange={(e) => updateSelectedPhase({ title: e.target.value })} /></label>
              <label>动作
                <select value={selectedPhase.action || 'show'} onChange={(e) => {
                  const action = e.target.value;
                  const next = { ...selectedPhase, action };
                  updateSelectedPhase({ action, requiredInteractions: actionDefaultInteraction(next) });
                }}>
                  {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                </select>
              </label>
              <label>目标<input value={selectedPhase.target || ''} onChange={(e) => updateSelectedPhase({ target: e.target.value })} /></label>
              <div className="flow-form-row">
                <label>资源<input value={selectedPhase.resource || ''} onChange={(e) => updateSelectedPhase({ resource: e.target.value })} /></label>
                <label>数量<input value={selectedPhase.amount || ''} onChange={(e) => updateSelectedPhase({ amount: e.target.value })} /></label>
                <label>成本<input value={selectedPhase.cost || ''} onChange={(e) => updateSelectedPhase({ cost: e.target.value })} /></label>
              </div>
              <label>玩家提示<textarea rows={3} value={selectedPhase.guideText || ''} onChange={(e) => updateSelectedPhase({ guideText: e.target.value })} /></label>
              <label>requiredInteractions<textarea rows={4} value={listToText(selectedPhase.requiredInteractions)} onChange={(e) => updateSelectedPhase({ requiredInteractions: textToList(e.target.value) })} /></label>
              <label>completeCondition<input value={selectedPhase.completeCondition || ''} onChange={(e) => updateSelectedPhase({ completeCondition: e.target.value })} /></label>
              <label>visibleEntities<textarea rows={3} value={listToText(selectedPhase.visibleEntities)} onChange={(e) => updateSelectedPhase({ visibleEntities: textToList(e.target.value) })} /></label>
              <label>画面备注<textarea rows={3} value={selectedPhase.visualNotes || ''} onChange={(e) => updateSelectedPhase({ visualNotes: e.target.value })} /></label>
              <label>备注<textarea rows={2} value={selectedPhase.notes || ''} onChange={(e) => updateSelectedPhase({ notes: e.target.value })} /></label>
            </div>
          ) : (
            <div className="flow-empty-selection">选择一个 phase 编辑</div>
          )}

          <div className="flow-catalog-editors">
            <label>实体目录 JSON<textarea rows={6} value={entitiesText} onChange={(e) => setEntitiesText(e.target.value)} onBlur={handleCatalogBlur} /></label>
            <label>资源目录 JSON<textarea rows={5} value={resourcesText} onChange={(e) => setResourcesText(e.target.value)} onBlur={handleCatalogBlur} /></label>
            {catalogError && <div className="flow-catalog-error">{catalogError}</div>}
          </div>
        </aside>
      </div>

      <div className="flow-report-grid">
        {report && (
          <div className="flow-report-card">
            <div className="flow-report-title">校验报告 · {summarizeIssues(report)}</div>
            <ResourceSnapshots report={report} />
            {safeArray(report.issues).slice(0, 8).map((issue, index) => (
              <div key={index} className={'flow-issue-row ' + issue.severity}>
                <strong>{issue.severity}</strong>
                <span>{issue.code}</span>
                <small>{issue.message}</small>
              </div>
            ))}
          </div>
        )}
        {sourceResult?.urls?.html && (
          <div className="flow-report-card">
            <div className="flow-report-title">SourceIR 产物</div>
            <div className="flow-artifact-links">
              <a href={sourceResult.urls.html} target="_blank" rel="noreferrer">预览 HTML</a>
              <a href={sourceResult.urls.sourceSceneIr} target="_blank" rel="noreferrer">SourceSceneIR</a>
              <a href={sourceResult.urls.sourceIrReport} target="_blank" rel="noreferrer">生成报告</a>
            </div>
          </div>
        )}
        {diffReport && (
          <div className="flow-report-card">
            <div className="flow-report-title">HTML 对比 · {summarizeIssues(diffReport)}</div>
            <DiffList report={diffReport} />
          </div>
        )}
      </div>
    </div>
  );
}
