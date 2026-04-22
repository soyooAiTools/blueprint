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

export async function parseStoryboard(projectId, formData, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 360000); // 6 min timeout
  try {
    const res = await fetch(API_BASE + '/projects/' + projectId + '/parse-storyboard', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timer);

    // SSE stream response
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'progress' && onProgress) {
              onProgress(evt.percent, evt.stage);
            } else if (evt.type === 'done') {
              result = evt.data;
            } else if (evt.type === 'error') {
              throw new Error(evt.message || '解析失败');
            }
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
          }
        }
      }
      if (!result) throw new Error('解析未返回结果');
      return result;
    }

    // Fallback: legacy JSON response
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('解析失败，请联系管理员Nick');
    }
    if (!res.ok) throw new Error(data.error || '解析失败，请联系管理员Nick');
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('解析超时（超过6分钟），请检查网络后重试');
    throw err;
  }
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

// P3: Upload WebGL
export async function uploadWebgl(id, htmlContent) {
  return request('/projects/' + id + '/upload-webgl', { method: 'POST', body: JSON.stringify({ html: htmlContent }) });
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

export async function analyzeReference(projectId, formData, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000); // 5 min timeout
  try {
    const res = await fetch(API_BASE + '/projects/' + projectId + '/analyze-reference', {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'progress' && onProgress) {
              onProgress(evt.percent, evt.stage);
            } else if (evt.type === 'done') {
              result = evt;
            } else if (evt.type === 'error') {
              throw new Error(evt.message || '分析失败');
            }
          } catch (parseErr) {
            if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
          }
        }
      }
      if (!result) throw new Error('分析未返回结果');
      return result;
    }

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      throw new Error('分析失败');
    }
    if (!res.ok) throw new Error(data.error || '分析失败');
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('分析超时（超过5分钟）');
    throw err;
  }
}
