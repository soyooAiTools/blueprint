import { useState, useEffect, useCallback } from 'react';
import { fetchProjects, createProject, deleteProject as apiDeleteProject } from '../utils/api';
import { STATUS_LABELS } from '../utils/statusLabels';

// 为了向后兼容，保留 localStorage 相关的导出函数
const STORAGE_KEY = 'blueprint_projects';

export function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

export function saveProjects(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function saveProject(project) {
  const projects = loadProjects();
  const idx = projects.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], ...project, updatedAt: Date.now() };
  } else {
    projects.push({ ...project, createdAt: Date.now(), updatedAt: Date.now() });
  }
  saveProjects(projects);
}

export function deleteProject(id) {
  const projects = loadProjects().filter((p) => p.id !== id);
  saveProjects(projects);
}

export default function ProjectList({ user, onSelectProject, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [svnUrl, setSvnUrl] = useState('');
  const [error, setError] = useState('');

  const loadProjectList = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchProjects();
      setProjects(data);
    } catch (err) {
      console.error('加载项目列表失败:', err);
      setError('加载失败：' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjectList();
  }, [loadProjectList]);

  const handleCreate = async () => {
    if (!newName.trim()) {
      setError('请输入项目名称');
      return;
    }
    
    try {
      setError('');
      await createProject(newName.trim(), svnUrl.trim());
      await loadProjectList();
      setNewName('');
      setSvnUrl('');
      setShowCreate(false);
    } catch (err) {
      setError('创建失败：' + err.message);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`确认删除项目「${name}」？此操作不可撤销。`)) return;
    
    try {
      setError('');
      await apiDeleteProject(id);
      await loadProjectList();
    } catch (err) {
      setError('删除失败：' + err.message);
      console.error('删除项目失败:', err);
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

  if (loading) {
    return (
      <div className="project-list-page">
        <div className="project-list-loading">加载中...</div>
      </div>
    );
  }

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

      {error && (
        <div className="project-list-error">
          ⚠️ {error}
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}

      {showCreate && (
        <div className="project-create-modal">
          <div className="project-create-card">
            <h3>新建项目</h3>
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
              value={svnUrl}
              onChange={(e) => setSvnUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="SVN 地址（选填）"
            />
            {error && <div className="project-create-error">{error}</div>}
            <div className="project-create-actions">
              <button 
                className="project-create-cancel" 
                onClick={() => { 
                  setShowCreate(false); 
                  setNewName(''); 
                  setSvnUrl('');
                  setError('');
                }}
              >
                取消
              </button>
              <button className="project-create-confirm" onClick={handleCreate}>
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="project-list-empty">
          <div className="project-empty-icon">📂</div>
          <div className="project-empty-text">还没有项目</div>
          <div className="project-empty-hint">点击「+ 新建项目」开始</div>
        </div>
      ) : (
        <div className="project-grid">
          {projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((p) => {
            const shotCount = p.shotCount || 0;
            const statusLabel = STATUS_LABELS[p.status] || STATUS_LABELS.editing;
            
            return (
              <div key={p.id} className="project-card" onClick={() => onSelectProject(p)}>
                <div className="project-card-top">
                  <div className="project-card-name">{p.name}</div>
                  <button
                    className="project-card-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }}
                  >🗑</button>
                </div>
                <div className="project-card-status">
                  <span 
                    className="project-status-badge"
                    style={{
                      color: statusLabel.color,
                      backgroundColor: statusLabel.bg,
                    }}
                  >
                    {statusLabel.text}
                  </span>
                </div>
                <div className="project-card-stats">
                  <span className="project-stat">📷 {shotCount} 个镜头</span>
                </div>
                <div className="project-card-time">
                  <span>更新于 {formatDate(p.updatedAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
