import { useState, useCallback, useRef, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Login from './components/Login';
import ProjectList from './components/ProjectList';
import ShotNode from './components/ShotNode';
import PhaseNode from './components/PhaseNode';
import EntityNode from './components/EntityNode';
import JoinNode from './components/JoinNode';
import NoteNode from './components/NoteNode';
import Toolbar from './components/Toolbar';
import PropsPanel from './components/PropsPanel';
import TopBar from './components/TopBar';
import TaskPanel from './components/TaskPanel';
import StoryboardPanel from './components/StoryboardPanel';
import SpecReviewPanel from './components/SpecReviewPanel';
import { ModalProviderWithContext, useModal } from './components/ModalProvider';
import { exportToJSON, downloadJSON } from './utils/export';
import { importFromJSON, readFileAsJSON } from './utils/import';
import {
  saveBlueprint,
  submitProject,
  submitFeedback,
  approveProject,
  getWebglInfo,
  getProject,
  fetchProjects,
} from './utils/api';

const nodeTypes = {
  shotNode: ShotNode,
  phaseNode: PhaseNode,
  entityNode: EntityNode,
  joinNode: JoinNode,
  noteNode: NoteNode,
};

const defaultEdgeOptions = {
  type: 'smoothstep',
  animated: true,
  style: { stroke: 'rgba(255,255,255,0.5)', strokeWidth: 2 },
  markerEnd: { type: 'arrowclosed', color: 'rgba(255,255,255,0.5)' },
};

let idCounter = 100;
const getNextId = (prefix) => `${prefix}_${++idCounter}`;

/**
 * V4 方案A: 从 entities 数组生成画布上的实体节点和条件连线
 */
function generateEntityNodesAndEdges(entities) {
  const nodes = [];
  const edges = [];
  const nameToId = {};
  
  // Layout: group by spawn condition
  const groups = { gameStart: [], runtime: [], conditional: [] };
  entities.forEach((e) => {
    const cond = e.spawn?.condition || '';
    if (cond === 'runtime') groups.runtime.push(e);
    else if (cond.startsWith('phase:1') || cond === 'gameStart' || cond.startsWith('phase:1')) groups.gameStart.push(e);
    else groups.conditional.push(e);
  });
  
  let x = 50, y = 50;
  const COL_WIDTH = 260, ROW_HEIGHT = 130;
  
  // Column 1: gameStart entities
  groups.gameStart.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Column 2: conditional entities
  x += COL_WIDTH + 80;
  groups.conditional.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Column 3: runtime/pool entities
  x += COL_WIDTH + 80;
  groups.runtime.forEach((e, i) => {
    const id = 'entity_' + e.name;
    nameToId[e.name] = id;
    nodes.push({
      id,
      type: 'entityNode',
      position: { x, y: y + i * ROW_HEIGHT },
      data: { ...e },
    });
  });
  
  // Generate edges from spawn.condition (entity:XXX references)
  entities.forEach((e) => {
    const cond = e.spawn?.condition || '';
    if (cond.startsWith('entity:')) {
      // entity:ConveyorBelt.state==built → source is ConveyorBelt
      const ref = cond.split(':')[1];
      const sourceName = ref.split('.')[0];
      const sourceId = nameToId[sourceName];
      const targetId = nameToId[e.name];
      if (sourceId && targetId) {
        edges.push({
          id: `edge_${sourceName}_${e.name}`,
          source: sourceId,
          target: targetId,
          type: 'smoothstep',
          label: ref.includes('.') ? ref.split('.').slice(1).join('.') : '',
          style: { stroke: '#7c5cfc' },
          labelStyle: { fontSize: 10, fill: '#a0aec0' },
          animated: true,
        });
      }
    }
    // onBuilt activate links
    if (e.behavior?.onBuilt) {
      e.behavior.onBuilt.forEach((a) => {
        if (a.type === 'activate' && a.params?.target) {
          const sourceId = nameToId[e.name];
          const targetId = nameToId[a.params.target];
          if (sourceId && targetId) {
            edges.push({
              id: `edge_built_${e.name}_${a.params.target}`,
              source: sourceId,
              target: targetId,
              type: 'smoothstep',
              label: 'onBuilt',
              style: { stroke: '#48bb78' },
              labelStyle: { fontSize: 10, fill: '#48bb78' },
              animated: true,
            });
          }
        }
      });
    }
  });
  
  return { nodes, edges };
}

function FlowEditor({ project, onBack, initialTab }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(project.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges || []);
  const [projectName, setProjectName] = useState(project.name || '未命名项目');
  const [projectStatus, setProjectStatus] = useState(project.status || 'editing');
  const [statusMessage, setStatusMessage] = useState(project.statusMessage || '');
  const [previewLandscape, setPreviewLandscape] = useState(false);
  const [feedbackHistory, setFeedbackHistory] = useState(project.feedbackHistory || []);
  const [hasPendingFeedback, setHasPendingFeedback] = useState(false);

  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [activeTab, setActiveTab] = useState(initialTab || 'storyboard');
  const [objectRegistry, setObjectRegistry] = useState(project.objectRegistry || []);
  const [entities, setEntities] = useState(project.entities || []);
  const isV4 = entities.length > 0;
  
  // V4 方案A: 自动从 entities 生成画布节点（仅在首次加载且无 entityNode 时）
  const entityNodesGenerated = useRef(false);
  useEffect(() => {
    if (isV4 && !entityNodesGenerated.current) {
      const hasEntityNodes = nodes.some((n) => n.type === 'entityNode');
      if (!hasEntityNodes && entities.length > 0) {
        const { nodes: eNodes, edges: eEdges } = generateEntityNodesAndEdges(entities);
        setNodes((nds) => [...nds.filter((n) => n.type !== 'phaseNode'), ...eNodes]);
        setEdges((eds) => [...eds.filter((e) => !e.id.startsWith('e_')), ...eEdges]);
        entityNodesGenerated.current = true;
      }
    }
  }, [isV4, entities]);
  
  const [globalParams, setGlobalParams] = useState(project.globalParams || '');
  const [globalSettings, setGlobalSettings] = useState(project.globalSettings || {
    gameType: 'slg',
    cameraMode: 'topDown45',
    cameraProjection: 'orthographic',
    cameraFOV: 60,
    cameraBgColor: '(0.6,0.8,1)',
    defaultInput: 'virtualJoystick',
  });
  // Default to storyboard for new/editing projects (unless explicitly set)
  
  const [webglInfo, setWebglInfo] = useState(null);
  const reactFlowInstance = useReactFlow();
  const shotCountRef = useRef((project.nodes || []).filter((n) => n.type === 'shotNode').length || 1);
  const autoSaveRef = useRef(null);
  const { showAlert, showConfirm, showPrompt } = useModal();

  const handleStoryboardConvert = useCallback((newNodes, newEdges, v4Data) => {
    if (v4Data && v4Data.entities) {
      // V4 entity-driven: set entities + phases, generate entity/phase nodes
      setEntities(v4Data.entities);
      if (v4Data.phases) {
        // Generate phase nodes
        const phaseNodes = v4Data.phases.map((p, i) => ({
          id: 'phase_' + Date.now() + '_' + (i + 1),
          type: 'phaseNode',
          position: { x: 50, y: i * 300 },
          data: {
            name: p.name || 'Phase ' + (p.id || i + 1),
            activate: p.activate || [],
            endCondition: p.endCondition || '',
            guide: p.guide || '',
            camera: p.camera || {},
          },
        }));
        // Generate entity nodes using existing function
        const { nodes: eNodes, edges: eEdges } = generateEntityNodesAndEdges(v4Data.entities);
        setNodes([...phaseNodes, ...eNodes]);
        setEdges(eEdges);
      }
      if (v4Data.globalSettings) {
        setGlobalSettings(v4Data.globalSettings);
      }
      setActiveTab('blueprint');
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      }, 100);
    } else if (newNodes && newEdges) {
      // Legacy V3 path (fallback)
      setNodes((nds) => [...nds, ...newNodes]);
      setEdges((eds) => [...eds, ...newEdges]);
      shotCountRef.current += newNodes.filter((n) => n.type === 'shotNode').length;
      setActiveTab('blueprint');
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      }, 100);
    }
  }, [setNodes, setEdges, setEntities, reactFlowInstance]);

  // Fetch WebGL info + feedback history when status warrants it
  useEffect(() => {
    if (['reviewing', 'approved', 'committed', 'feedback'].indexOf(projectStatus) >= 0) {
      getWebglInfo(project.id).then(setWebglInfo).catch(() => {});
      getProject(project.id).then((p) => {
        if (p.feedbackHistory && p.feedbackHistory.length > 0) {
          setFeedbackHistory(p.feedbackHistory);
          // Mark existing revisions as done if feedback was already submitted
          setNodes((nds) => nds.map((n) => {
            if (n.type === 'shotNode' && n.data.inFeedbackList && n.data.revisions) {
              const updatedRevs = n.data.revisions.map((r) =>
                r.status === 'pending' ? { ...r, status: 'done' } : r
              );
              return { ...n, data: { ...n.data, revisions: updatedRevs } };
            }
            return n;
          }));
        }
      }).catch(() => {});
    }
  }, [projectStatus, project.id]);

  // Poll for WebGL build completion
  const buildNotified = useRef(false);
  useEffect(() => {
    if (['submitted', 'building', 'feedback'].indexOf(projectStatus) === -1 || buildNotified.current) return;
    const interval = setInterval(() => {
      getWebglInfo(project.id)
        .then((info) => {
          if (info && info.available && !buildNotified.current) {
            buildNotified.current = true;
            setWebglInfo(info);
            setProjectStatus('reviewing');
            showConfirm('🎉 WebGL 构建完成！是否立即查看预览？').then((yes) => {
              if (yes) setActiveTab('review');
            });
            clearInterval(interval);
          }
        })
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [projectStatus, project.id, showConfirm]);

  // Poll for status changes
  useEffect(() => {
    if (['submitted', 'building', 'approved', 'feedback', 'spec_extracting', 'spec_review'].indexOf(projectStatus) === -1) return;
    const interval = setInterval(() => {
      getProject(project.id)
        .then((p) => {
          if (p.status !== projectStatus) setProjectStatus(p.status);
          if (p.statusMessage !== undefined) setStatusMessage(p.statusMessage || '');
          if (p.feedbackHistory) setFeedbackHistory(p.feedbackHistory);
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [projectStatus, project.id]);

  // Auto-save to backend
  useEffect(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      saveBlueprint(project.id, nodes, edges, projectName, { objectRegistry, globalParams, globalSettings, entities }).catch((err) => {
        console.warn('自动保存失败:', err);
      });
    }, 2000);
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current); };
  }, [nodes, edges, projectName, project.id, objectRegistry, globalParams, globalSettings]);

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge({ ...params, ...defaultEdgeOptions }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node);
    setSelectedEdge(null);
  }, []);

  const onEdgeClick = useCallback((_, edge) => {
    setSelectedEdge(edge);
    setSelectedNode(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const onUpdateNode = useCallback(
    (nodeId, updates) => {
      setNodes((nds) => {
        const newNds = nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, ...updates } };
          }
          return n;
        });
        // Check if any shot has pending revisions → enable feedback button
        const hasPending = newNds.some((n) =>
          n.type === 'shotNode' && n.data.inFeedbackList &&
          (n.data.revisions || []).some((r) => r.status === 'pending' && r.instruction && r.instruction.trim())
        );
        setHasPendingFeedback(hasPending);
        return newNds;
      });
      setSelectedNode((prev) => {
        if (prev && prev.id === nodeId) {
          return { ...prev, data: { ...prev.data, ...updates } };
        }
        return prev;
      });
    },
    [setNodes]
  );

  const onUpdateEdge = useCallback(
    (edgeId, label) => {
      setEdges((eds) =>
        eds.map((e) => {
          if (e.id === edgeId) {
            const updated = { ...e };
            if (label) {
              updated.label = label;
              updated.labelStyle = { fill: '#fff', fontWeight: 700, fontSize: 12 };
              updated.labelBgStyle = { fill: '#f59e0b', fillOpacity: 0.9 };
              updated.labelBgPadding = [6, 4];
              updated.labelBgBorderRadius = 4;
            } else {
              delete updated.label;
              delete updated.labelStyle;
              delete updated.labelBgStyle;
              delete updated.labelBgPadding;
              delete updated.labelBgBorderRadius;
            }
            return updated;
          }
          return e;
        })
      );
      setSelectedEdge((prev) => {
        if (prev && prev.id === edgeId) {
          return { ...prev, label: label || '' };
        }
        return prev;
      });
    },
    [setEdges]
  );

  const onDeleteNode = useCallback(
    (nodeId) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNode(null);
    },
    [setNodes, setEdges]
  );

  const getViewportCenter = useCallback(() => {
    const vp = reactFlowInstance.getViewport();
    const bounds = document.querySelector('.react-flow')?.getBoundingClientRect();
    if (!bounds) return { x: 300, y: 200 };
    const centerX = (-vp.x + bounds.width / 2) / vp.zoom;
    const centerY = (-vp.y + bounds.height / 2) / vp.zoom;
    return { x: centerX - 140, y: centerY - 150 };
  }, [reactFlowInstance]);

  const onAddShot = useCallback(() => {
    shotCountRef.current += 1;
    const pos = getViewportCenter();
    const newNode = isV4 ? {
      id: getNextId('entity'),
      type: 'entityNode',
      position: { x: pos.x + Math.random() * 60 - 30, y: pos.y + Math.random() * 60 - 30 },
      data: {
        name: `Entity_${shotCountRef.current}`,
        label: '',
        template: 'Static',
        visual: { shape: 'Cube', scale: '1×1×1', color: '(0.5,0.5,0.5)', position: '(0,0,0)' },
        spawn: { condition: 'gameStart', style: 'instant' },
        behavior: {},
        trigger: { type: 'none' },
      },
    } : {
      id: getNextId('shot'),
      type: 'shotNode',
      position: { x: pos.x + Math.random() * 60 - 30, y: pos.y + Math.random() * 60 - 30 },
      data: {
        label: `镜头${shotCountRef.current}`,
        name: '',
        scene: '',
        controlTarget: '',
        controlMethod: '',
        triggers: '',
        endCondition: '',
      },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter, isV4]);

  const onAddJoin = useCallback(() => {
    const pos = getViewportCenter();
    const newNode = {
      id: getNextId('join'),
      type: 'joinNode',
      position: { x: pos.x + 100, y: pos.y + Math.random() * 60 },
      data: { label: '汇合' },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter]);

  const onAddNote = useCallback(() => {
    const pos = getViewportCenter();
    const newNode = {
      id: getNextId('note'),
      type: 'noteNode',
      position: { x: pos.x + Math.random() * 60, y: pos.y + Math.random() * 60 },
      data: { text: '' },
    };
    setNodes((nds) => [...nds, newNode]);
  }, [setNodes, getViewportCenter]);

  const onLoadTemplate = useCallback(
    async (tpl) => {
      if (nodes.length > 0) {
        if (!(await showConfirm(`加载模板「${tpl.name}」将覆盖当前画布，确认？`))) return;
      }
      setNodes(tpl.nodes || []);
      setEdges(tpl.edges || []);
      setSelectedNode(null);
      setSelectedEdge(null);
      if (tpl.name) {
        setProjectName(tpl.name);
      }
      shotCountRef.current = (tpl.nodes || []).filter((n) => n.type === 'shotNode').length;
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.2 });
      }, 50);
    },
    [nodes, setNodes, setEdges, reactFlowInstance, showConfirm]
  );

  const onExportJSON = useCallback(async () => {
    const data = exportToJSON(projectName, nodes, edges, { objectRegistry, globalParams, globalSettings });
    downloadJSON(data, `${projectName || 'blueprint'}.json`);
    // Auto-submit feedback when exporting in reviewing state
    if (projectStatus === 'reviewing') {
      try {
        const result = await submitFeedback(project.id, { blueprint: data, text: '蓝图反馈更新' });
        setProjectStatus(result.status);
        await showAlert('✅ 反馈已同步提交给 Coding Agent！');
      } catch (err) {
        console.warn('自动提交反馈失败:', err);
      }
    }
  }, [projectName, nodes, edges, projectStatus, project.id, showAlert]);

  const onImportJSON = useCallback(
    async (file) => {
      try {
        const result = await readFileAsJSON(file);
        let newNodes, newEdges, pn;
        if (result.__parsed) {
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = result);
        } else {
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = importFromJSON(result));
        }
        setNodes(newNodes);
        setEdges(newEdges);
        setProjectName(pn);
        if (result.objectRegistry) setObjectRegistry(result.objectRegistry);
        if (result.globalParams) setGlobalParams(result.globalParams);
        if (result.globalSettings) setGlobalSettings(result.globalSettings);
        setSelectedNode(null);
        setSelectedEdge(null);
        setTimeout(() => {
          reactFlowInstance.fitView({ padding: 0.2 });
        }, 50);
      } catch (err) {
        await showAlert('导入失败: ' + err.message);
      }
    },
    [setNodes, setEdges, reactFlowInstance, showAlert]
  );

  const onClearCanvas = useCallback(async () => {
    if (!(await showConfirm('确认清空画布？所有数据将丢失。'))) return;
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [setNodes, setEdges, showConfirm]);

  const handleSubmit = useCallback(async () => {
    try {
      await saveBlueprint(project.id, nodes, edges, projectName, { objectRegistry, globalParams, globalSettings });
      const result = await submitProject(project.id);
      setProjectStatus(result.status);
      await showAlert('✅ 已成功提交给 Coding Agent！');
    } catch (err) {
      await showAlert('提交失败: ' + err.message);
    }
  }, [project.id, nodes, edges, projectName, showAlert]);

  const handleApprove = useCallback(async () => {
    try {
      const result = await approveProject(project.id);
      setProjectStatus(result.status);
      await showAlert('✅ 审核已通过！');
    } catch (err) {
      await showAlert('通过失败: ' + err.message);
    }
  }, [project.id, showAlert]);

  const handleFeedback = useCallback(async (text) => {
    try {
      const result = await submitFeedback(project.id, { text });
      setProjectStatus(result.status);
      if (result.feedbackHistory) setFeedbackHistory(result.feedbackHistory);
      else setFeedbackHistory((prev) => [...prev, { text, timestamp: new Date().toISOString() }]);
      // Mark all pending revisions in TaskPanel as done
      setNodes((nds) => nds.map((n) => {
        if (n.type === 'shotNode' && n.data.inFeedbackList && n.data.revisions) {
          const updatedRevs = n.data.revisions.map((r) =>
            r.status === 'pending' ? { ...r, status: 'done' } : r
          );
          return { ...n, data: { ...n.data, revisions: updatedRevs } };
        }
        return n;
      }));
      setHasPendingFeedback(false);
      await showAlert('✅ 反馈已提交！');
    } catch (err) {
      await showAlert('反馈失败: ' + err.message);
    }
  }, [project.id, showAlert, setNodes]);

  return (
    <div className="app-container">
      <TopBar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onExportJSON={onExportJSON}
        onImportJSON={onImportJSON}
        onClearCanvas={onClearCanvas}
        onBack={onBack}
        projectStatus={projectStatus}
                statusMessage={statusMessage}
        onSubmit={handleSubmit}
        onApprove={handleApprove}
        onFeedback={handleFeedback}
        shotCount={nodes.filter((n) => n.type === 'shotNode' || n.type === 'entityNode').length}
      />
      <div className="app-tabs">
        <button
          className={`app-tab ${activeTab === 'storyboard' ? 'app-tab-active' : ''}`}
          onClick={() => setActiveTab('storyboard')}
        >
          🎬 分镜
        </button>
        <button
          className={`app-tab ${activeTab === 'blueprint' ? 'app-tab-active' : ''}`}
          onClick={() => setActiveTab('blueprint')}
        >
          🗺 蓝图
        </button>

        {['reviewing', 'approved', 'committed', 'feedback'].indexOf(projectStatus) >= 0 && (
          <button
            className={`app-tab ${activeTab === 'review' ? 'app-tab-active' : ''}`}
            onClick={() => setActiveTab('review')}
          >
            📱 审核
          </button>
        )}
      </div>
      <div className="app-body">
        {activeTab === 'storyboard' ? (
          <StoryboardPanel
            projectId={project.id}
            onConvertToBlueprint={handleStoryboardConvert}
            hasExistingNodes={nodes.length > 0}
            showAlert={showAlert}
            showConfirm={showConfirm}
          />
        ) : activeTab === 'blueprint' ? (
          <>
            <Toolbar
              onAddShot={onAddShot}
              onAddJoin={onAddJoin}
              onAddNote={onAddNote}
              onLoadTemplate={onLoadTemplate}
              isV4={isV4}
            />
            <div className="canvas-container">
              <ReactFlow
                nodes={nodes.map(n => {
                  if (n.type === 'shotNode') return { ...n, data: { ...n.data, _objectRegistry: objectRegistry } };
                  if (n.type === 'phaseNode') return { ...n, data: { ...n.data, _entities: entities } };
                  return n;
                })}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onEdgeClick={onEdgeClick}
                onPaneClick={onPaneClick}
                nodeTypes={nodeTypes}
                defaultEdgeOptions={defaultEdgeOptions}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                deleteKeyCode={['Backspace', 'Delete']}
                snapToGrid
                snapGrid={[20, 20]}
              >
                <Background color="#1a1a3a" gap={20} size={1} variant="dots" />
                <Controls position="bottom-left" />
              </ReactFlow>
            </div>
            <PropsPanel
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              onUpdateNode={onUpdateNode}
              onUpdateEdge={onUpdateEdge}
              onDeleteNode={onDeleteNode}
              objectRegistry={objectRegistry}
              globalParams={globalParams}
              globalSettings={globalSettings}
              onChangeRegistry={setObjectRegistry}
              onChangeParams={setGlobalParams}
              onChangeGlobalSettings={setGlobalSettings}
              entities={entities}
              onChangeEntities={setEntities}
              isV4={isV4}
            />
          </>
        ) : activeTab === 'review' ? (
          <div className="review-split">
            <div className="review-left">
              <div className="preview-status-bar">
                {projectStatus === 'reviewing' && (
                  <span className="preview-status-text">👀 开发完成，请审核预览效果</span>
                )}
                {projectStatus === 'feedback' && (
                  <span className="preview-status-text">💬 反馈已提交，等待修改</span>
                )}
                {projectStatus === 'approved' && (
                  <span className="preview-status-text">⏳ 已通过，正在提交 SVN...</span>
                )}
                {projectStatus === 'committed' && (
                  <span className="preview-status-text preview-status-committed">✅ 已提交 SVN</span>
                )}
                <button className="preview-refresh-btn" onClick={() => {
                  const iframe = document.querySelector('.preview-iframe');
                  if (iframe) { iframe.src = iframe.src; }
                }} title="刷新预览">🔄</button>
                <button className="preview-orientation-btn" onClick={() => setPreviewLandscape(!previewLandscape)}
                  title={previewLandscape ? '切换竖屏' : '切换横屏'}>
                  {previewLandscape ? '📱 竖屏' : '📲 横屏'}
                </button>
              </div>
              {webglInfo && webglInfo.available ? (
                <div className={`preview-phone-frame ${previewLandscape ? 'landscape' : ''}`}>
                  {!previewLandscape && <div className="preview-phone-notch" />}
                  <iframe
                    className="preview-iframe"
                    src={webglInfo.url}
                    title="WebGL Preview"
                    allow="autoplay; fullscreen; webgl; webgl2"
                    allowFullScreen
                    scrolling="no"
                    style={{ overflow: 'hidden' }}
                    onLoad={(e) => {
                      // Luna Dev builds check _isInsideIframe() and won't auto-start in iframes.
                      // Send postMessage to trigger luna:build + luna:start via setPlaygroundAssetOverrides handler.
                      try {
                        e.target.contentWindow.postMessage(JSON.stringify({
                          name: 'setPlaygroundAssetOverrides',
                          data: '{}'
                        }), '*');
                      } catch(err) { console.warn('Failed to send start message to iframe:', err); }
                    }}
                  />
                </div>
              ) : (
                <div className="preview-empty">
                  {(projectStatus === 'spec_extracting' || projectStatus === 'spec_review') ? (
                    <SpecReviewPanel
                      projectId={project.id}
                      onConfirmed={() => setProjectStatus('submitted')}
                      showAlert={showAlert}
                    />
                  ) : projectStatus === 'submitted' ? (
                    <>
                      <div className="preview-empty-icon">⏳</div>
                      <div className="preview-empty-text">已提交开发</div>
                      <div className="preview-empty-hint">Coding Agent 正在生成代码，请耐心等待...</div>
                    </>
                  ) : projectStatus === 'building' ? (
                    <>
                      <div className="preview-empty-icon">🔨</div>
                      <div className="preview-empty-text">正在构建 WebGL</div>
                      <div className="preview-empty-hint">代码已完成，正在打包中...</div>
                    </>
                  ) : projectStatus === 'feedback' ? (
                    <>
                      <div className="preview-empty-icon">💬</div>
                      <div className="preview-empty-text">反馈修改中</div>
                      <div className="preview-empty-hint">Coding Agent 正在根据反馈修改，完成后会推送新版本</div>
                    </>
                  ) : (
                    <>
                      <div className="preview-empty-icon">📱</div>
                      <div className="preview-empty-text">暂无预览</div>
                      <div className="preview-empty-hint">等待 Coding Agent 交付 WebGL 包</div>
                    </>
                  )}
                </div>
              )}
              <div className="preview-actions-vertical">
                {(projectStatus === 'reviewing' || projectStatus === 'feedback') && (
                  <>
                    <button className="preview-action-outline preview-action-approve" onClick={handleApprove}>
                      ✅ 效果审核通过
                    </button>
                    <button
                      className={`preview-action-outline preview-action-feedback${!hasPendingFeedback ? ' preview-action-disabled' : ''}`}
                      disabled={!hasPendingFeedback}
                      title={!hasPendingFeedback ? '请先在右侧添加反馈内容' : ''}
                      onClick={async () => {
                        const text = await showPrompt('请输入反馈内容：');
                        if (text) handleFeedback(text);
                      }}
                    >
                      💬 提交反馈，继续修改
                    </button>
                  </>
                )}
              </div>
              {/* feedback history removed per Nick's request — shown in TaskPanel instead */}
            </div>
            <div className="review-right">
              <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} feedbackSubmitted={feedbackHistory.length > 0} />
            </div>
          </div>
        ) : (
          <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} feedbackSubmitted={feedbackHistory.length > 0} />
        )}
      </div>
    </div>
  );
}

// Global build notification component
function GlobalBuildNotification({ user, currentProject, onGoToProject }) {
  const [notification, setNotification] = useState(null);
  const notifiedRef = useRef({});

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        const projects = await fetchProjects();
        for (const p of projects) {
          if (['submitted', 'building', 'feedback'].indexOf(p.status) !== -1 && !notifiedRef.current[p.id]) {
            try {
              const info = await getWebglInfo(p.id);
              if (info && info.available) {
                notifiedRef.current[p.id] = true;
                setNotification({ project: p, url: info.url });
              }
            } catch {}
          }
        }
      } catch {}
    }, 15000);
    return () => clearInterval(interval);
  }, [user]);

  if (!notification) return null;

  return (
    <div className="global-notification-overlay" onClick={() => setNotification(null)}>
      <div className="global-notification" onClick={(e) => e.stopPropagation()}>
        <div className="global-notification-icon">🎉</div>
        <div className="global-notification-title">WebGL 构建完成</div>
        <div className="global-notification-text">
          项目「{notification.project.name}」已完成构建，可以预览了！
        </div>
        <div className="global-notification-actions">
          <button
            className="global-notification-btn global-notification-btn-primary"
            onClick={() => { onGoToProject(notification.project); setNotification(null); }}
          >
            🚀 立即查看
          </button>
          <button
            className="global-notification-btn"
            onClick={() => setNotification(null)}
          >
            稍后再看
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => localStorage.getItem('blueprint_user'));
  const [currentProject, setCurrentProject] = useState(null);
  const [goToReview, setGoToReview] = useState(false);

  const handleGoToProject = useCallback((project) => {
    setGoToReview(true);
    setCurrentProject(project);
  }, []);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  if (!currentProject) {
    return (
      <>
        <ProjectList
          user={user}
          onSelectProject={(p) => { setGoToReview(false); setCurrentProject(p); }}
          onLogout={() => {
            localStorage.removeItem('blueprint_user');
            setUser(null);
          }}
        />
        {/* GlobalBuildNotification disabled */}
      </>
    );
  }

  return (
    <ModalProviderWithContext>
      <ReactFlowProvider>
        <FlowEditor
          key={currentProject.id}
          project={currentProject}
          onBack={() => setCurrentProject(null)}
          initialTab={goToReview ? 'review' : 'storyboard'}
        />
      </ReactFlowProvider>
      {/* GlobalBuildNotification disabled */}
    </ModalProviderWithContext>
  );
}
