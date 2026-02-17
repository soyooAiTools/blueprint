/**
 * SLG 试玩广告经验库 API
 * 
 * 使用方法：在 server.cjs 中添加：
 * const casesAPI = require('./cases-api-patch.cjs');
 * casesAPI.attachCasesAPI(server, '/opt/blueprint-editor/cases');
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CASES_DIR = '/opt/blueprint-editor/cases';

/**
 * 附加 Cases API 路由到现有 HTTP server
 * @param {http.Server} server - Node.js HTTP server 实例
 * @param {string} casesDir - 案例存储目录（可选）
 */
function attachCasesAPI(server, casesDir = CASES_DIR) {
  const originalListeners = server.listeners('request').slice();
  server.removeAllListeners('request');

  server.on('request', async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Cases API 路由
    if (pathname.startsWith('/api/cases')) {
      try {
        await handleCasesAPI(req, res, pathname, url, casesDir);
      } catch (error) {
        console.error('[Cases API Error]', error);
        sendJSON(res, 500, { error: error.message });
      }
      return;
    }

    // 否则交给原有的请求处理器
    for (const listener of originalListeners) {
      listener.call(server, req, res);
    }
  });
}

/**
 * 处理 Cases API 请求
 */
async function handleCasesAPI(req, res, pathname, url, casesDir) {
  // POST /api/cases - 提交案例
  if (pathname === '/api/cases' && req.method === 'POST') {
    const body = await readBody(req);
    const data = JSON.parse(body);

    // 验证
    if (!data.type || !data.name) {
      return sendJSON(res, 400, { error: '缺少必填字段' });
    }

    if (!['finished', 'semi', 'broken'].includes(data.type)) {
      return sendJSON(res, 400, { error: '无效的案例类型' });
    }

    // 生成 case ID
    const caseId = generateCaseId();
    const caseDir = path.join(casesDir, caseId);
    const filesDir = path.join(caseDir, 'files');

    // 创建目录
    fs.mkdirSync(filesDir, { recursive: true });

    // 保存文件
    const fileNames = [];
    if (data.files && Array.isArray(data.files)) {
      for (const file of data.files) {
        if (!file.name || !file.data) continue;
        
        const fileName = sanitizeFilename(file.name);
        const filePath = path.join(filesDir, fileName);
        
        // 解码 base64
        const buffer = Buffer.from(file.data, 'base64');
        fs.writeFileSync(filePath, buffer);
        fileNames.push(fileName);
      }
    }

    // 保存 metadata
    const metadata = {
      id: caseId,
      type: data.type,
      name: data.name,
      categories: data.categories || [],
      description: data.description || '',
      suggestion: data.suggestion || '',
      files: fileNames,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(caseDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );

    sendJSON(res, 200, { success: true, id: caseId });
    return;
  }

  // GET /api/cases - 获取案例列表
  if (pathname === '/api/cases' && req.method === 'GET') {
    const typeFilter = url.searchParams.get('type');

    // 确保目录存在
    if (!fs.existsSync(casesDir)) {
      fs.mkdirSync(casesDir, { recursive: true });
    }

    const cases = [];
    const dirs = fs.readdirSync(casesDir);

    for (const dir of dirs) {
      const metadataPath = path.join(casesDir, dir, 'metadata.json');
      if (!fs.existsSync(metadataPath)) continue;

      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

      // 类型筛选
      if (typeFilter && metadata.type !== typeFilter) continue;

      cases.push(metadata);
    }

    // 按时间倒序
    cases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    sendJSON(res, 200, cases);
    return;
  }

  // GET /api/cases/:id - 获取单个案例详情
  const detailMatch = pathname.match(/^\/api\/cases\/([^\/]+)$/);
  if (detailMatch && req.method === 'GET') {
    const caseId = detailMatch[1];
    const metadataPath = path.join(casesDir, caseId, 'metadata.json');

    if (!fs.existsSync(metadataPath)) {
      return sendJSON(res, 404, { error: '案例不存在' });
    }

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    sendJSON(res, 200, metadata);
    return;
  }

  // GET /api/cases/:id/files/:filename - 下载文件
  const fileMatch = pathname.match(/^\/api\/cases\/([^\/]+)\/files\/(.+)$/);
  if (fileMatch && req.method === 'GET') {
    const [, caseId, filename] = fileMatch;
    const filePath = path.join(casesDir, caseId, 'files', filename);

    if (!fs.existsSync(filePath)) {
      return sendJSON(res, 404, { error: '文件不存在' });
    }

    // 安全检查：确保路径在允许范围内
    const resolvedPath = path.resolve(filePath);
    const allowedDir = path.resolve(casesDir, caseId, 'files');
    if (!resolvedPath.startsWith(allowedDir)) {
      return sendJSON(res, 403, { error: '非法访问' });
    }

    // 发送文件
    const stat = fs.statSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.zip': 'application/zip'
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return;
  }

  // 404
  sendJSON(res, 404, { error: '未找到 API 端点' });
}

/**
 * 读取请求体
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * 发送 JSON 响应
 */
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

/**
 * 生成唯一 case ID
 */
function generateCaseId() {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = Math.random().toString(36).substring(2, 6);
  return `case_${timestamp}_${random}`;
}

/**
 * 清理文件名，防止路径穿越
 */
function sanitizeFilename(filename) {
  return path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
}

module.exports = { attachCasesAPI };
