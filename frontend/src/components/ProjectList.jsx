import { useState, useEffect } from 'react';

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
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    setProjects(loadProjects());
  }, []);

  const handleCreate = () => {
    if (!newName.trim()) return;
    const project = {
      id: 'proj_' + Date.now(),
      name: newName.trim(),
      nodes: [],
      edges: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    saveProject(project);
    setProjects(loadProjects());
    setNewName('');
    setShowCreate(false);
  };

  const handleDelete = (id, name) => {
    if (!window.confirm('确认删除项目「' + name + '」？此操作不可撤销。')) return;
    deleteProject(id);
    setProjects(loadProjects());
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

  const getShotCount = (p) => (p.nodes || []).filter((n) => n.type === 'shotNode').length;
  const getRevisionCount = (p) => {
    let count = 0;
    (p.nodes || []).forEach((n) => {
      (n.data?.revisions || []).forEach((r) => {
        if (r.status === 'pending') count++;
      });
    });
    return count;
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
            <div className="project-create-actions">
              <button className="project-create-cancel" onClick={() => { setShowCreate(false); setNewName(''); }}>
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
            const shots = getShotCount(p);
            const revisions = getRevisionCount(p);
            return (
              <div key={p.id} className="project-card" onClick={() => onSelectProject(p)}>
                <div className="project-card-top">
                  <div className="project-card-name">{p.name}</div>
                  <button
                    className="project-card-delete"
                    onClick={(e) => { e.stopPropagation(); handleDelete(p.id, p.name); }}
                  >🗑</button>
                </div>
                <div className="project-card-stats">
                  <span className="project-stat">📷 {shots} 个镜头</span>
                  {revisions > 0 && <span className="project-stat project-stat-rev">🔴 {revisions} 待修</span>}
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
