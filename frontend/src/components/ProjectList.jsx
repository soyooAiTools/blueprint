import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchProjects, fetchTasks, createProject, deleteProject, getProject } from '../utils/api';

export default function ProjectList({ user, onSelectProject, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [taskMap, setTaskMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSvnUrl, setNewSvnUrl] = useState('');
  const [newEngine, setNewEngine] = useState('unity');

  const initialLoad = useRef(true);
  const loadProjects = useCallback(async () => {
    try {
      // Only show loading spinner on first load, not on refresh (prevents flashing)
      if (initialLoad.current) setLoading(true);
      const [list, taskResp] = await Promise.all([
        fetchProjects(),
        fetchTasks(100).catch(() => ({ tasks: [] })),
      ]);
      const nextTaskMap = {};
      (taskResp.tasks || []).forEach((t) => {
        if (t && t.taskId) nextTaskMap[t.taskId] = t;
      });
      setTaskMap(nextTaskMap);
      setProjects(list);
    } catch (err) {
      console.error('加载项目列表失败:', err);
    } finally {
      if (initialLoad.current) { setLoading(false); initialLoad.current = false; }
    }
  }, []);

  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    loadProjects();
    // Only poll when there are active (in-progress) projects; otherwise stay idle
    const ACTIVE_STATUSES = ['submitted', 'assigned', 'building', 'developing', 'feedback', 'spec_extracting', 'spec_review', 'processing', 'preview_ready'];
    const timer = setInterval(() => {
      const hasActive = projectsRef.current.some((p) => {
        const task = taskMap[p.id];
        return ACTIVE_STATUSES.indexOf(p.status) !== -1 || (task && ACTIVE_STATUSES.indexOf(task.status) !== -1);
      });
      if (hasActive) loadProjects();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadProjects, taskMap]);

  const openProject = async (id) => {
    try {
      const full = await getProject(id);
      const bp = full.blueprint || {};
      onSelectProject({
        id: full.id,
        name: full.name,
        svnUrl: full.svnUrl,
        status: full.status,
        engine: full.engine,
        nodes: bp.nodes || [],
        edges: bp.edges || [],
        objectRegistry: bp.objectRegistry || [],
        globalParams: bp.globalParams || '',
        globalSettings: bp.globalSettings || {},
        entities: bp.entities || [],
        feedbackHistory: full.feedbackHistory || [],
      });
    } catch (err) {
      alert('加载项目失败: ' + err.message);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const project = await createProject(newName.trim(), newSvnUrl.trim(), newEngine);
      setProjects((prev) => [project, ...prev]);
      setNewName('');
      setNewSvnUrl('');
      setNewEngine('unity');
      setShowCreate(false);
      // Auto-open the newly created project
      await openProject(project.id);
    } catch (err) {
      alert('创建失败: ' + err.message);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm('确认删除项目「' + name + '」？此操作不可撤销。')) return;
    try {
      await deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  };

  const formatDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0');
  };

  const getShotCount = (p) => {
    if (typeof p.shotCount === 'number') return p.shotCount;
    const bp = p.blueprint || p;
    return (bp.entities || []).length || (bp.nodes || []).filter((n) => n.type === 'entityNode').length;
  };
  const getRevisionCount = (p) => {
    const bp = p.blueprint || p;
    let count = 0;
    (bp.nodes || []).forEach((n) => {
      (n.data?.revisions || []).forEach((r) => {
        if (r.status === 'pending') count++;
      });
    });
    return count;
  };

  const STATUS_LABELS = {
    editing: '编辑中',
    spec_extracting: '提取规格中...',
    spec_review: '规格待确认',
    submitted: '排队中',
    processing: '准备中',
    building: '开发中',
    developing: '开发中',
    preview_ready: '可预览',
    reviewing: '待审核',
    approved: '已通过',
    feedback: '反馈中',
    committed: '已提交SVN',
    failed: '失败',
  };

  const ENGINE_LABELS = { unity: 'Unity', cocos: 'Cocos' };

  return (
    <div className="project-list-page">
      <div className="project-list-header">
        <div className="project-list-header-left">
          <h1>🎮 试玩广告蓝图工作台</h1>
          <span className="project-list-user">👤 {user}</span>
        </div>
        <div className="project-list-header-right">
          <button className="project-create-btn" onClick={() => setShowCreate(true)}>
            + 新建项目
          </button>
          <button className="project-logout-btn" onClick={onLogout}>
            退出
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="project-create-modal">
          <div className="project-create-card">
            <h3>新建项目</h3>

            <div className="project-create-field">
              <label className="project-create-label">引擎</label>
              <div className="project-create-radios">
                <label className={'project-radio-option' + (newEngine === 'unity' ? ' project-radio-selected' : '')}>
                  <input type="radio" name="engine" value="unity" checked={newEngine === 'unity'} onChange={() => setNewEngine('unity')} />
                  <span className="project-radio-icon">🎮</span> Unity
                </label>
                <label className={'project-radio-option' + (newEngine === 'cocos' ? ' project-radio-selected' : '')}>
                  <input type="radio" name="engine" value="cocos" checked={newEngine === 'cocos'} onChange={() => setNewEngine('cocos')} />
                  <span className="project-radio-icon">🐦</span> Cocos
                </label>
              </div>
            </div>

            <input
              className="project-create-input"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="项目名称（如：太空打冰块）"
              autoFocus
            />
            <input
              className="project-create-input"
              type="text"
              value={newSvnUrl}
              onChange={(e) => setNewSvnUrl(e.target.value)}
              placeholder="SVN 地址（可选）"
            />
            <div className="project-create-actions">
              <button className="project-create-cancel" onClick={() => { setShowCreate(false); setNewName(''); setNewSvnUrl(''); setNewEngine('unity'); }}>
                取消
              </button>
              <button className="project-create-confirm" onClick={handleCreate} disabled={!newName.trim()}>
                创建并打开
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="project-list-empty">
          <div className="project-empty-text">加载中...</div>
        </div>
      ) : projects.length === 0 ? (
        <div className="project-list-empty">
          <div className="project-empty-icon">📂</div>
          <div className="project-empty-text">还没有项目</div>
          <div className="project-empty-hint">点击「+ 新建项目」开始</div>
        </div>
      ) : (
        <div className="project-grid">
          {projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((p) => {
            const shots = getShotCount(p);
            const revisions = getRevisionCount(p);
            const task = taskMap[p.id];
            const effectiveStatus = task && task.status ? task.status : p.status;
            const effectiveMessage = task && task.statusMessage ? task.statusMessage : p.statusMessage;
            const effectiveUpdatedAt = task && task.updatedAt ? task.updatedAt : p.updatedAt;
            const statusLabel = STATUS_LABELS[effectiveStatus] || effectiveStatus;
            return (
              <div key={p.id} className="project-card" onClick={() => openProject(p.id)}>
                <div className="project-card-top">
                  <div className="project-card-name">{p.name}</div>
                  <button
                    className="project-card-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }}
                  >🗑</button>
                </div>
                <div className="project-card-stats">
                  {p.engine && <span className={'project-stat project-engine-badge project-engine-' + p.engine}>{ENGINE_LABELS[p.engine] || p.engine}</span>}
                  <span className="project-stat">📷 {shots} 个镜头</span>
                  {revisions > 0 && <span className="project-stat project-stat-rev">🔴 {revisions} 待修</span>}
                  {effectiveStatus && effectiveStatus !== 'editing' && (
                    <span className={'project-stat project-stat-status project-status-' + effectiveStatus}>{statusLabel}</span>
                  )}
                </div>
                {effectiveStatus === 'failed' && effectiveMessage && (
                  <div className="project-card-error" title={effectiveMessage}>
                    ⚠️ {effectiveMessage.length > 50 ? effectiveMessage.slice(0, 50) + '...' : effectiveMessage}
                  </div>
                )}
                {effectiveStatus !== 'failed' && effectiveStatus !== 'editing' && effectiveMessage && (
                  <div className="project-card-progress" title={effectiveMessage}>
                    {effectiveMessage.length > 60 ? effectiveMessage.slice(0, 60) + '...' : effectiveMessage}
                  </div>
                )}
                <div className="project-card-time">
                  <span>更新于 {formatDate(effectiveUpdatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
