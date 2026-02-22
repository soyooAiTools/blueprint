import { useState, useEffect, useCallback } from 'react';
import { fetchProjects, createProject, deleteProject as apiDeleteProject, getProject } from '../utils/api';
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

  const loadProjectList = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchProjects();
      setProjects(data);
    } catch (err) {
      console.error('加载项目列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjectList();
  }, [loadProjectList]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      const created = await createProject(newName.trim(), svnUrl.trim());
      setProjects((prev) => [created, ...prev]);
      setNewName('');
      setSvnUrl('');
      setShowCreate(false);
    } catch (err) {
      alert('创建失败: ' + err.message);
    }
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`确认删除项目「${name}」？此操作不可撤销。`)) return;
    try {
      await apiDeleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      alert('删除失败: ' + err.message);
    }
  };

  const handleSelectProject = async (project) => {
    try {
      const full = await getProject(project.id);
      onSelectProject({
        id: full.id,
        name: full.name,
        svnUrl: full.svnUrl,
        status: full.status,
        nodes: full.blueprint?.nodes || [],
        edges: full.blueprint?.edges || [],
        feedbackHistory: full.feedbackHistory || [],
      });
    } catch (err) {
      alert('加载项目失败: ' + err.message);
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
              placeholder="SVN 地址（如：svn://xxx/playable-ads/space-ice）"
              style={{ marginTop: 0 }}
            />
            <div className="project-create-actions">
              <button
                className="project-create-cancel"
                onClick={() => { setShowCreate(false); setNewName(''); setSvnUrl(''); }}
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

      {loading ? (
        <div className="project-list-empty">
          <div className="project-empty-icon">⏳</div>
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
          {projects.map((p) => {
            const shotCount = p.shotCount || 0;
            const statusLabel = STATUS_LABELS[p.status] || STATUS_LABELS.editing;

            return (
              <div key={p.id} className="project-card" onClick={() => handleSelectProject(p)}>
                <div className="project-card-top">
                  <div className="project-card-name">{p.name}</div>
                  <button
                    className="project-card-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }}
                  >🗑</button>
                </div>
                <div className="project-card-status-row">
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
