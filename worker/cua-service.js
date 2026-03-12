/**
 * CUA Service — 运行在 Worker ECS 上的 CUA 分析服务
 * PlayCheck 主 ECS 通过 HTTP API 调用此服务执行 CUA 分析
 * 
 * 端口: 18860
 * POST /analyze   - 提交 CUA 分析任务
 * GET  /status/:id - 查询任务状态
 * GET  /result/:id - 获取分析结果
 * GET  /health     - 健康检查
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 18860;
const LUNA_AGENT = path.join(__dirname, 'luna-agent.js');
const RESULTS_DIR = path.join(__dirname, 'cua-results');
const MAX_CONCURRENT = 2;

// 确保结果目录存在
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// 任务管理
const tasks = new Map();
let runningCount = 0;
const queue = [];

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function runTask(task) {
  runningCount++;
  task.status = 'running';
  task.startedAt = Date.now();

  const taskDir = path.join(RESULTS_DIR, task.id);
  if (!fs.existsSync(taskDir)) fs.mkdirSync(taskDir, { recursive: true });

  const outputFile = path.join(taskDir, 'cua-report.json');
  const logFile = path.join(taskDir, 'cua.log');
  const statusFile = path.join(taskDir, 'cua.status.json');
  const videoDir = taskDir;

  task.outputFile = outputFile;
  task.logFile = logFile;

  const args = [
    LUNA_AGENT,
    task.url,
    '--model', 'cua',
    '--rounds', String(task.rounds || 20),
    '--output', outputFile,
    '--log-file', logFile,
    '--background',
  ];

  if (task.checkMode) args.push('--check-mode', task.checkMode);
  
  // 写入临时脚本文件
  if (task.gameScript) {
    const scriptFile = path.join(taskDir, 'script.txt');
    fs.writeFileSync(scriptFile, task.gameScript, 'utf-8');
    args.push('--script', scriptFile);
  }

  // 写入临时反馈文件
  if (task.feedbackReport) {
    const feedbackFile = path.join(taskDir, 'feedback-report.json');
    fs.writeFileSync(feedbackFile, JSON.stringify(task.feedbackReport), 'utf-8');
    args.push('--feedback', feedbackFile);
  }

  // 写入参考笔记
  if (task.refNotes) {
    const notesFile = path.join(taskDir, 'ref-notes.txt');
    fs.writeFileSync(notesFile, task.refNotes, 'utf-8');
    args.push('--ref-notes', notesFile);
  }

  console.log(`[CUA Service] Starting task ${task.id}: ${task.url}`);

  const child = spawn('node', args, {
    stdio: 'pipe',
    env: { ...process.env },
    cwd: __dirname,
  });

  task.pid = child.pid;

  // 监控状态文件
  const monitor = setInterval(() => {
    try {
      if (fs.existsSync(statusFile)) {
        const st = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
        task.progress = st;
      }
      if (fs.existsSync(logFile)) {
        const logContent = fs.readFileSync(logFile, 'utf-8');
        const lines = logContent.split('\n').filter(l => l.trim());
        // 扫描所有行找最大 round（不只看最后一行）
        let maxRound = task.currentRound || 0;
        for (const line of lines) {
          const rm = line.match(/\[CUA Round (\d+)\/(\d+)\]/);
          if (rm) {
            const r = parseInt(rm[1]);
            if (r > maxRound) maxRound = r;
            task.totalRounds = parseInt(rm[2]);
          }
        }
        task.currentRound = maxRound;
        // 检测 Gemini 阶段
        if (logContent.includes('Gemini') && logContent.includes('Uploading')) {
          task.phase = 'gemini';
        }
        task.lastLog = lines[lines.length - 1] || '';
      }
    } catch (e) { /* ignore */ }
  }, 2000);

  child.on('close', (code) => {
    clearInterval(monitor);
    runningCount--;
    task.completedAt = Date.now();
    task.duration = task.completedAt - task.startedAt;

    if (code === 0 && fs.existsSync(outputFile)) {
      try {
        task.result = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        task.status = 'completed';
        console.log(`[CUA Service] Task ${task.id} completed (${Math.round(task.duration / 1000)}s)`);
      } catch (e) {
        task.status = 'error';
        task.error = 'Failed to parse result: ' + e.message;
      }
    } else {
      task.status = 'error';
      task.error = `Luna Agent exited with code ${code}`;
      // 尝试读取日志获取错误信息
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(l => l.trim());
        task.errorDetail = lines.slice(-5).join('\n');
      }
    }

    // 找录制的视频
    try {
      const files = fs.readdirSync(taskDir);
      const videoFile = files.find(f => f.endsWith('.webm') || f.endsWith('.mp4'));
      if (videoFile) task.videoFile = path.join(taskDir, videoFile);
    } catch (e) { /* ignore */ }

    // 处理队列
    processQueue();
  });

  child.on('error', (err) => {
    clearInterval(monitor);
    runningCount--;
    task.status = 'error';
    task.error = err.message;
    task.completedAt = Date.now();
    processQueue();
  });
}

function processQueue() {
  while (queue.length > 0 && runningCount < MAX_CONCURRENT) {
    const task = queue.shift();
    runTask(task);
  }
}

// HTTP 服务
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      running: runningCount,
      queued: queue.length,
      total: tasks.size,
      lunaAgentExists: fs.existsSync(LUNA_AGENT),
    }));
    return;
  }

  // 提交分析任务
  if (pathname === '/analyze' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const params = JSON.parse(body);
        if (!params.url) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'url is required' }));
          return;
        }

        const task = {
          id: generateId(),
          status: 'queued',
          url: params.url,
          checkMode: params.checkMode || 'cua',
          rounds: params.rounds || 20,
          gameScript: params.gameScript || null,
          feedbackReport: params.feedbackReport || null,
          refNotes: params.refNotes || null,
          createdAt: Date.now(),
          currentRound: 0,
          totalRounds: 0,
          lastLog: '',
        };

        tasks.set(task.id, task);

        if (runningCount < MAX_CONCURRENT) {
          runTask(task);
        } else {
          queue.push(task);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: task.id, status: task.status }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 查询状态
  const statusMatch = pathname.match(/^\/status\/(.+)$/);
  if (statusMatch) {
    const task = tasks.get(statusMatch[1]);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task not found' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: task.id,
      status: task.status,
      currentRound: task.currentRound,
      totalRounds: task.totalRounds,
      phase: task.phase || 'cua',
      lastLog: task.lastLog,
      elapsed: task.startedAt ? Math.round((Date.now() - task.startedAt) / 1000) : 0,
      error: task.error || null,
    }));
    return;
  }

  // 获取结果
  const resultMatch = pathname.match(/^\/result\/(.+)$/);
  if (resultMatch) {
    const task = tasks.get(resultMatch[1]);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task not found' }));
      return;
    }
    if (task.status !== 'completed' && task.status !== 'error') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: task.status, message: 'not ready yet' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: task.id,
      status: task.status,
      result: task.result || null,
      error: task.error || null,
      errorDetail: task.errorDetail || null,
      duration: task.duration || 0,
      videoFile: task.videoFile || null,
    }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[CUA Service] Running on port ${PORT}`);
  console.log(`[CUA Service] Luna Agent: ${LUNA_AGENT} (exists: ${fs.existsSync(LUNA_AGENT)})`);
  console.log(`[CUA Service] Results dir: ${RESULTS_DIR}`);
  console.log(`[CUA Service] Max concurrent: ${MAX_CONCURRENT}`);
});
