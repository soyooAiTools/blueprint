// API 工具函数
const API_BASE = '/api';

const LEGACY_STORAGE_KEY = 'blueprint_projects';
let migrationDone = false;

async function request(path, options) {
  options = options || {};
  const res = await fetch(API_BASE + path, {
    headers: {
      'Content-Type': 'application/json',
    },
    ...options,
  });
  
  const data = await res.json();
  
  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  
  return data;
}

// localStorage 数据迁移到后端
async function migrateLegacyData() {
  if (migrationDone) return;
  migrationDone = true;
  
  try {
    const legacyData = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyData) return;
    
    const projects = JSON.parse(legacyData);
    if (!Array.isArray(projects) || projects.length === 0) return;
    
    console.log(`[api] 发现 localStorage 中有 ${projects.length} 个项目，正在迁移到后端...`);
    
    for (const project of projects) {
      try {
        // 检查项目是否已存在
        await request(`/projects/${project.id}`);
        console.log(`[api] 跳过已存在: ${project.name}`);
      } catch (err) {
        // 项目不存在，创建新项目
        const newProject = await request('/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: project.name || '未命名',
            svnUrl: project.svnUrl || '',
          }),
        });
        
        // 如果有蓝图数据，保存蓝图
        if (project.nodes && project.nodes.length > 0) {
          await request(`/projects/${newProject.id}/blueprint`, {
            method: 'PUT',
            body: JSON.stringify({
              nodes: project.nodes,
              edges: project.edges,
              projectName: project.name,
            }),
          });
        }
        
        console.log(`[api] 已迁移: ${project.name} → ${newProject.id}`);
      }
    }
    
    // 迁移完成，清除 localStorage
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    console.log('[api] 迁移完成，localStorage 已清理');
  } catch (err) {
    console.warn('[api] 迁移失败:', err.message);
  }
}

// 项目相关 API
export async function fetchProjects() {
  await migrateLegacyData();
  return request('/projects');
}

export async function createProject(name, svnUrl) {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, svnUrl }),
  });
}

export async function getProject(id) {
  return request(`/projects/${id}`);
}

export async function updateProject(id, updates) {
  return request(`/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function saveBlueprint(projectId, nodes, edges, projectName) {
  return request(`/projects/${projectId}/blueprint`, {
    method: 'PUT',
    body: JSON.stringify({ nodes, edges, projectName }),
  });
}

export async function submitProject(id) {
  return request(`/projects/${id}/submit`, {
    method: 'POST',
  });
}

export async function submitFeedback(id, feedbackData) {
  return request(`/projects/${id}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ data: feedbackData }),
  });
}

export async function approveProject(id) {
  return request(`/projects/${id}/approve`, {
    method: 'POST',
  });
}

export async function getWebglInfo(id) {
  return request(`/projects/${id}/webgl`);
}

export async function fetchPendingProjects() {
  return request('/projects/pending');
}

export async function updateProjectStatus(id, status) {
  return request(`/projects/${id}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

export async function uploadWebgl(id, htmlContent) {
  return request(`/projects/${id}/upload-webgl`, {
    method: 'POST',
    body: JSON.stringify({ html: htmlContent }),
  });
}

export async function commitProject(id, svnRevision) {
  return request(`/projects/${id}/committed`, {
    method: 'POST',
    body: JSON.stringify({ svnRevision }),
  });
}

export async function deleteProject(id) {
  return request(`/projects/${id}`, {
    method: 'DELETE',
  });
}
