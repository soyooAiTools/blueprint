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
import ProjectList, { saveProject } from './components/ProjectList';
import ShotNode from './components/ShotNode';
import JoinNode from './components/JoinNode';
import NoteNode from './components/NoteNode';
import Toolbar from './components/Toolbar';
import PropsPanel from './components/PropsPanel';
import TopBar from './components/TopBar';
import TaskPanel from './components/TaskPanel';
import shot1Preset from './presets/shot1';
import { exportToJSON, downloadJSON } from './utils/export';
import { importFromJSON, readFileAsJSON } from './utils/import';

const nodeTypes = {
  shotNode: ShotNode,
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

function FlowEditor({ project, onBack }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(project.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges || []);
  const [projectName, setProjectName] = useState(project.name || '未命名项目');
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [activeTab, setActiveTab] = useState('blueprint');
  const reactFlowInstance = useReactFlow();
  const shotCountRef = useRef((project.nodes || []).filter((n) => n.type === 'shotNode').length || 1);
  const autoSaveRef = useRef(null);

  // Auto-save to localStorage
  useEffect(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      saveProject({ id: project.id, name: projectName, nodes, edges });
    }, 1000);
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current); };
  }, [nodes, edges, projectName, project.id]);

  const onConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge({ ...params, ...defaultEdgeOptions }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback(
    (_, node) => {
      setSelectedNode(node);
      setSelectedEdge(null);
    },
    []
  );

  const onEdgeClick = useCallback(
    (_, edge) => {
      setSelectedEdge(edge);
      setSelectedNode(null);
    },
    []
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
  }, []);

  const onUpdateNode = useCallback(
    (nodeId, updates) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            const newData = { ...n.data, ...updates };
            return { ...n, data: newData };
          }
          return n;
        })
      );
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
    const newNode = {
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
  }, [setNodes, getViewportCenter]);

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
    (tpl) => {
      if (nodes.length > 0) {
        if (!window.confirm(`加载模板「${tpl.name}」将覆盖当前画布，确认？`)) return;
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
    [nodes, setNodes, setEdges, reactFlowInstance]
  );

  const onExportJSON = useCallback(() => {
    const data = exportToJSON(projectName, nodes, edges);
    downloadJSON(data, `${projectName || 'blueprint'}.json`);
  }, [projectName, nodes, edges]);

  const onImportJSON = useCallback(
    async (file) => {
      try {
        const result = await readFileAsJSON(file);
        let newNodes, newEdges, pn;
        if (result.__parsed) {
          // Zip import: already parsed with model data
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = result);
        } else {
          // Plain JSON import
          ({ nodes: newNodes, edges: newEdges, projectName: pn } = importFromJSON(result));
        }
        setNodes(newNodes);
        setEdges(newEdges);
        setProjectName(pn);
        setSelectedNode(null);
        setSelectedEdge(null);
        setTimeout(() => {
          reactFlowInstance.fitView({ padding: 0.2 });
        }, 50);
      } catch (err) {
        alert('导入失败: ' + err.message);
      }
    },
    [setNodes, setEdges, reactFlowInstance]
  );

  const onClearCanvas = useCallback(() => {
    if (!window.confirm('确认清空画布？所有数据将丢失。')) return;
    setNodes([]);
    setEdges([]);
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [setNodes, setEdges]);

  return (
    <div className="app-container">
      <TopBar
        projectName={projectName}
        onProjectNameChange={setProjectName}
        onExportJSON={onExportJSON}
        onImportJSON={onImportJSON}
        onClearCanvas={onClearCanvas}
        onBack={onBack}
      />
      <div className="app-tabs">
        <button
          className={`app-tab ${activeTab === 'blueprint' ? 'app-tab-active' : ''}`}
          onClick={() => setActiveTab('blueprint')}
        >
          🗺 蓝图
        </button>
        <button
          className={`app-tab ${activeTab === 'tasks' ? 'app-tab-active' : ''}`}
          onClick={() => setActiveTab('tasks')}
        >
          💬 镜头反馈
          {(() => {
            let pending = 0;
            nodes.forEach((n) => {
              (n.data.revisions || []).forEach((r) => {
                if (r.status === 'pending') pending++;
              });
            });
            return pending > 0 ? <span className="app-tab-badge">{pending}</span> : null;
          })()}
        </button>
      </div>
      <div className="app-body">
        {activeTab === 'blueprint' ? (
          <>
            <Toolbar
              onAddShot={onAddShot}
              onAddJoin={onAddJoin}
              onAddNote={onAddNote}
              onLoadTemplate={onLoadTemplate}
            />
            <div className="canvas-container">
              <ReactFlow
                nodes={nodes}
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
            />
          </>
        ) : (
          <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} />
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => localStorage.getItem('blueprint_user'));
  const [currentProject, setCurrentProject] = useState(null);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  if (!currentProject) {
    return (
      <ProjectList
        user={user}
        onSelectProject={(p) => setCurrentProject(p)}
        onLogout={() => {
          localStorage.removeItem('blueprint_user');
          setUser(null);
        }}
      />
    );
  }

  return (
    <ReactFlowProvider>
      <FlowEditor
        key={currentProject.id}
        project={currentProject}
        onBack={() => setCurrentProject(null)}
      />
    </ReactFlowProvider>
  );
}
