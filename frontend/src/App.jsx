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
import JoinNode from './components/JoinNode';
import NoteNode from './components/NoteNode';
import Toolbar from './components/Toolbar';
import PropsPanel from './components/PropsPanel';
import TopBar from './components/TopBar';
import TaskPanel from './components/TaskPanel';
import StoryboardPanel from './components/StoryboardPanel';
import { ModalProviderWithContext, useModal } from './components/ModalProvider';
import shot1Preset from './presets/shot1';
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

function FlowEditor({ project, onBack, initialTab }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(project.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(project.edges || []);
  const [projectName, setProjectName] = useState(project.name || '未命名项目');
  const [projectStatus, setProjectStatus] = useState(project.status || 'editing');
  const [statusMessage, setStatusMessage] = useState(project.statusMessage || '');
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [activeTab, setActiveTab] = useState(initialTab || 'storyboard');
  // Default to storyboard for new/editing projects (unless explicitly set)
  
  const [webglInfo, setWebglInfo] = useState(null);
  const reactFlowInstance = useReactFlow();
  const shotCountRef = useRef((project.nodes || []).filter((n) => n.type === 'shotNode').length || 1);
  const autoSaveRef = useRef(null);
  const { showAlert, showConfirm } = useModal();

  const handleStoryboardConvert = useCallback((newNodes, newEdges) => {
    setNodes((nds) => [...nds, ...newNodes]);
    setEdges((eds) => [...eds, ...newEdges]);
    shotCountRef.current += newNodes.filter((n) => n.type === 'shotNode').length;
    setActiveTab('blueprint');
    setTimeout(() => {
      reactFlowInstance.fitView({ padding: 0.2 });
    }, 100);
  }, [setNodes, setEdges, reactFlowInstance]);

  // Fetch WebGL info when status warrants it
  useEffect(() => {
    if (['reviewing', 'approved', 'committed', 'feedback'].indexOf(projectStatus) >= 0) {
      getWebglInfo(project.id).then(setWebglInfo).catch(() => {});
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
    if (['submitted', 'building', 'approved', 'feedback'].indexOf(projectStatus) === -1) return;
    const interval = setInterval(() => {
      getProject(project.id)
        .then((p) => {
          if (p.status !== projectStatus) setProjectStatus(p.status);
          if (p.statusMessage !== undefined) setStatusMessage(p.statusMessage || '');
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [projectStatus, project.id]);

  // Auto-save to backend
  useEffect(() => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => {
      saveBlueprint(project.id, nodes, edges, projectName).catch((err) => {
        console.warn('自动保存失败:', err);
      });
    }, 2000);
    return () => { if (autoSaveRef.current) clearTimeout(autoSaveRef.current); };
  }, [nodes, edges, projectName, project.id]);

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
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, ...updates } };
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
    const data = exportToJSON(projectName, nodes, edges);
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
      await saveBlueprint(project.id, nodes, edges, projectName);
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
      await showAlert('✅ 反馈已提交！');
    } catch (err) {
      await showAlert('反馈失败: ' + err.message);
    }
  }, [project.id, showAlert]);

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
        shotCount={nodes.filter((n) => n.type === 'shotNode').length}
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
              </div>
              {webglInfo && webglInfo.available ? (
                <div className="preview-phone-frame">
                  <div className="preview-phone-notch" />
                  <iframe
                    className="preview-iframe"
                    src={webglInfo.url}
                    title="WebGL Preview"
                    sandbox="allow-scripts allow-same-origin"
                  />
                </div>
              ) : (
                <div className="preview-empty">
                  {projectStatus === 'submitted' ? (
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
              <div className="preview-actions">
                {(projectStatus === 'reviewing' || projectStatus === 'feedback') && (
                  <button className="preview-btn preview-btn-approve" onClick={handleApprove}>
                    ✅ 通过
                  </button>
                )}
              </div>
            </div>
            <div className="review-right">
              <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} />
            </div>
          </div>
        ) : (
          <TaskPanel nodes={nodes} onUpdateNode={onUpdateNode} />
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
        <GlobalBuildNotification user={user} currentProject={currentProject} onGoToProject={handleGoToProject} />
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
      <GlobalBuildNotification user={user} currentProject={currentProject} onGoToProject={handleGoToProject} />
    </ModalProviderWithContext>
  );
}
