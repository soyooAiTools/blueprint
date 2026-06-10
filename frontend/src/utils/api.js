// API 层 — 统一走后端，启动时自动迁移 localStorage 数据
const API_BASE = '/api';
const LS_KEY = 'blueprint_projects';

// ============ API 请求 ============
async function request(url, options) {
  options = options || {};
  var res = await fetch(API_BASE + url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch (_) {
    throw new Error('服务异常，请联系管理员Nick');
  }
  if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
  return data;
}

// ============ 启动时迁移 localStorage → 后端 ============
let _migrated = false;
async function migrateIfNeeded() {
  if (_migrated) return;
  _migrated = true;
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    var projects = JSON.parse(raw);
    if (!Array.isArray(projects) || projects.length === 0) return;
    console.log('[api] 发现 localStorage 中有 ' + projects.length + ' 个项目，正在迁移到后端...');
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      try {
        // 先检查后端是否已有同 id 的项目
        await request('/projects/' + p.id);
        // 已存在，跳过
        console.log('[api] 跳过已存在: ' + p.name);
      } catch (e) {
        // 不存在，创建
        var created = await request('/projects', {
          method: 'POST',
          body: JSON.stringify({ name: p.name || '未命名', svnUrl: p.svnUrl || '' })
        });
        // 保存蓝图数据
        if (p.blueprint && (p.blueprint.nodes || []).length > 0) {
          await request('/projects/' + created.id + '/blueprint', {
            method: 'PUT',
            body: JSON.stringify({
              nodes: p.blueprint.nodes,
              edges: p.blueprint.edges,
              projectName: p.blueprint.projectName || p.name
            })
          });
        }
        console.log('[api] 已迁移: ' + p.name + ' → ' + created.id);
      }
    }
    // 迁移完成，清理 localStorage
    localStorage.removeItem(LS_KEY);
    console.log('[api] 迁移完成，localStorage 已清理');
  } catch (e) {
    console.warn('[api] 迁移失败:', e.message);
  }
}

// ============ 公开接口 ============

export async function fetchProjects() {
  await migrateIfNeeded();
  return request('/projects');
}

export async function fetchTasks(limit) {
  await migrateIfNeeded();
  var suffix = '';
  if (typeof limit === 'number' && limit > 0) suffix = '?limit=' + limit;
  return request('/tasks' + suffix);
}

export async function createProject(name, svnUrl, engine) {
  return request('/projects', { method: 'POST', body: JSON.stringify({ name, svnUrl, engine }) });
}

export async function getProject(id) {
  return request('/projects/' + id);
}

export async function updateProject(id, data) {
  return request('/projects/' + id, { method: 'PUT', body: JSON.stringify(data) });
}

export async function saveBlueprint(id, nodes, edges, projectName, extra) {
  return request('/projects/' + id + '/blueprint', { method: 'PUT', body: JSON.stringify({ nodes, edges, projectName, ...(extra || {}) }) });
}

export async function submitProject(id) {
  return request('/projects/' + id + '/submit', { method: 'POST' });
}

export async function submitFeedback(id, feedbackData) {
  return request('/projects/' + id + '/feedback', { method: 'POST', body: JSON.stringify({ data: feedbackData }) });
}

export async function approveProject(id) {
  return request('/projects/' + id + '/approve', { method: 'POST' });
}

export async function getWebglInfo(id) {
  return request('/projects/' + id + '/webgl');
}

// P3: Fetch pending projects (submitted/feedback)
export async function fetchPendingProjects() {
  return request('/projects/pending');
}

// P3: Generic status update
export async function updateStatus(id, status) {
  return request('/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
}

// P5: Mark project as committed
export async function commitProject(id, svnRevision) {
  return request('/projects/' + id + '/committed', { method: 'POST', body: JSON.stringify({ svnRevision }) });
}

// SVN commit
export async function svnCommit(id) {
  return request('/projects/' + id + '/svn-commit', { method: 'POST' });
}

export async function deleteProject(id) {
  return request('/projects/' + id, { method: 'DELETE' });
}

export async function getSpecs(id) {
  return request('/projects/' + id + '/specs');
}

export async function confirmSpecs(id, specs) {
  return request('/projects/' + id + '/confirm-specs', { method: 'POST', body: JSON.stringify({ specs }) });
}

export async function generateStoryboardHtmlPackage(formData) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900000);
  try {
    const res = await fetch(API_BASE + '/storyboard-html-package', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('HTML 生成失败');
    }
    if (!res.ok) throw new Error(data.error || 'HTML 生成失败');
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('生成超时（超过15分钟）');
    throw err;
  }
}

export async function getStoryboardHtmlPackageJob(jobId) {
  return request('/storyboard-html-package/' + encodeURIComponent(jobId) + '/status');
}
