/**
 * Luna Agent — AI 自主操控试玩广告的决策循环
 * 
 * 用法: node luna-agent.js <url> [--rounds 30] [--headed] [--output report.json]
 * 
 * 流程:
 *   1. Playwright 打开广告 URL
 *   2. 注入 playcheck-dom-input.js + luna-snapshot.js
 *   3. 循环: snapshot → Claude 决策 → exec 执行 → 观察变化
 *   4. 输出 QC 报告
 * 
 * 依赖: playwright, @anthropic-ai/sdk
 * 环境变量: ANTHROPIC_API_KEY
 */

// ─── 代理设置（必须在最前面） ───
process.env.https_proxy = process.env.https_proxy || 'http://127.0.0.1:7890';
process.env.http_proxy = process.env.http_proxy || 'http://127.0.0.1:7890';
process.env.HTTPS_PROXY = process.env.https_proxy;
process.env.HTTP_PROXY = process.env.http_proxy;
try {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch (e) { /* undici not available */ }

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── 依赖检查 ───
function checkDeps() {
  const missing = [];
  try { require('playwright'); } catch (e) { missing.push('playwright'); }
  try { require('@anthropic-ai/sdk'); } catch (e) { missing.push('@anthropic-ai/sdk'); }
  try { require('openai'); } catch (e) { missing.push('openai'); }
  if (missing.length > 0) {
    console.error('Missing dependencies. Run:');
    console.error('  npm install ' + missing.join(' ') + ' --legacy-peer-deps');
    console.error('  npx playwright install chromium');
    process.exit(1);
  }
}

checkDeps();

const { chromium } = require('playwright');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

// ─── 参数解析 ───
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    url: null,
    rounds: 30,
    headed: false,
    output: null,
    screenshotInterval: 5,
    verbose: false,
    model: 'claude',  // 'claude' | 'gpt' | 'cua'
    background: false, // 后台模式：日志写文件，进程独立运行
    logFile: null,      // 后台模式日志文件路径
    feedbackFile: null,  // 反馈验收模式：上一轮报告 JSON 路径
    scriptFile: null,    // 分镜脚本文件路径（.txt/.md/.json）
    refImages: null      // 参考图目录或文件路径（逗号分隔多张）
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--rounds' && args[i + 1]) { config.rounds = parseInt(args[++i]); }
    else if (arg === '--headed') { config.headed = true; }
    else if (arg === '--output' && args[i + 1]) { config.output = args[++i]; }
    else if (arg === '--screenshot-interval' && args[i + 1]) { config.screenshotInterval = parseInt(args[++i]); }
    else if (arg === '--verbose' || arg === '-v') { config.verbose = true; }
    else if (arg === '--model' && args[i + 1]) { config.model = args[++i].toLowerCase(); }
    else if (arg === '--background' || arg === '--bg') { config.background = true; }
    else if (arg === '--log-file' && args[i + 1]) { config.logFile = args[++i]; }
    else if (arg === '--feedback' && args[i + 1]) { config.feedbackFile = args[++i]; }
    else if ((arg === '--script' || arg === '--storyboard') && args[i + 1]) { config.scriptFile = args[++i]; }
    else if ((arg === '--ref-images' || arg === '--ref') && args[i + 1]) { config.refImages = args[++i]; }
    else if (!arg.startsWith('--') && !config.url) { config.url = arg; }
  }

  if (!config.url) {
    console.error('Usage: node luna-agent.js <url> [--rounds 30] [--headed] [--output report.json]');
    process.exit(1);
  }

  return config;
}

// ─── 读取注入脚本 ───
function loadInjectScripts() {
  const dir = __dirname;
  const domInputJS = fs.readFileSync(path.join(dir, 'playcheck-dom-input.js'), 'utf-8');
  const snapshotJS = fs.readFileSync(path.join(dir, 'luna-snapshot.js'), 'utf-8');
  return { domInputJS, snapshotJS };
}

// ─── LLM 调用 ───
async function callClaude(client, prompt, screenshotB64) {
  const content = [];

  content.push({ type: 'text', text: prompt });

  if (screenshotB64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: screenshotB64
      }
    });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: content }]
    });

    const text = response.content[0].text;

    // 从响应中提取 JSON（可能被包在 markdown code block 里）
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // 尝试找第一个 { 到最后一个 }
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        jsonStr = text.substring(start, end + 1);
      }
    }

    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[Claude] Error:', err.message);
    // 返回安全的默认操作
    return {
      thinking: 'LLM call failed, doing random exploration',
      actions: [{ type: 'click', clientX: 400, clientY: 300 }],
      waitMs: 1000,
      needScreenshot: false,
      bugs: [],
      done: false
    };
  }
}

// ─── GPT-5.4 调用 ───
async function callGPT(client, prompt, screenshotB64) {
  const content = [];
  content.push({ type: 'text', text: prompt });

  if (screenshotB64) {
    content.push({
      type: 'image_url',
      image_url: {
        url: 'data:image/jpeg;base64,' + screenshotB64,
        detail: 'high'
      }
    });
  }

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-5.4',
      max_completion_tokens: 1024,
      messages: [{ role: 'user', content: content }],
      response_format: { type: 'json_object' }
    });

    const text = response.choices[0].message.content;
    return JSON.parse(text);
  } catch (err) {
    console.error('[GPT] Error:', err.message);
    return {
      thinking: 'LLM调用失败，执行随机探索',
      actions: [{ type: 'click', clientX: 400, clientY: 300 }],
      waitMs: 1000,
      bugs: [],
      done: false
    };
  }
}

// ─── CUA 模式：GPT-5.4 直接操控浏览器 ───

/**
 * CUA（Computer Use Agent）循环
 * GPT-5.4 通过 Responses API 的 computer_use_preview 工具直接看屏幕+操控
 * 我们只负责：截图 → 发给 CUA → 执行它返回的鼠标/键盘命令 → 再截图
 */
// ─── [REMOVED] Gemini 3.1 Pro 视频审核 — 已移除，CUA 是唯一验证方式 ───
async function runGeminiVideoReview(videoPath, config, cuaResult) {
  return null; // Gemini Phase 2 removed
  const GEMINI_API_KEY_UNUSED = 'removed';
  const GEMINI_MODEL = 'gemini-3.1-pro-preview';

  const { ProxyAgent, fetch: uFetch } = require('undici');
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || 'http://127.0.0.1:7890';
  const proxyAgent = new ProxyAgent({ uri: proxyUrl, requestTls: { timeout: 300000 }, connect: { timeout: 30000 } });
  const gemFetch = (url, opts = {}) => {
    // 大文件上传加长超时
    const timeout = opts.body && opts.body.length > 1000000 ? 300000 : 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return uFetch(url, { ...opts, dispatcher: proxyAgent, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { fetch: gemFetch } });

  // 1. 上传视频（手动 REST API，SDK file upload 路由有代理兼容问题）
  // 支持 retry 和降级到截图模式
  console.log('[Gemini] Uploading video...');
  const videoData = fs.readFileSync(videoPath);
  const uploadUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + GEMINI_API_KEY;

  let file = null;
  const MAX_UPLOAD_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      if (attempt > 0) console.log(`[Gemini] Upload retry ${attempt}/${MAX_UPLOAD_RETRIES}...`);

      // Resumable upload: initiate
      const initRes = await gemFetch(uploadUrl, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(videoData.length),
          'X-Goog-Upload-Header-Content-Type': 'video/webm',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { displayName: 'cua-recording.webm' } }),
      });

      const uploadUri = initRes.headers.get('x-goog-upload-url');
      let uploadJson;
      if (!uploadUri) {
        // Fallback: 直接小文件上传
        const directRes = await gemFetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'video/webm' },
          body: videoData,
        });
        uploadJson = await directRes.json();
      } else {
        // Upload the bytes
        const uploadRes = await gemFetch(uploadUri, {
          method: 'POST',
          headers: {
            'X-Goog-Upload-Command': 'upload, finalize',
            'X-Goog-Upload-Offset': '0',
            'Content-Type': 'video/webm',
          },
          body: videoData,
        });
        uploadJson = await uploadRes.json();
      }

      if (!uploadJson || !uploadJson.file) {
        throw new Error('Upload response missing file field: ' + JSON.stringify(uploadJson).substring(0, 200));
      }
      file = uploadJson.file;
      break; // success
    } catch (uploadErr) {
      console.error(`[Gemini] Upload attempt ${attempt} failed: ${uploadErr.message}`);
      if (attempt >= MAX_UPLOAD_RETRIES) {
        throw new Error('Video upload failed after retries: ' + uploadErr.message);
      }
      await new Promise(r => setTimeout(r, 3000)); // wait before retry
    }
  }

  // Wait for ACTIVE
  let waitAttempts = 0;
  while (file.state === 'PROCESSING' && waitAttempts < 60) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const checkRes = await gemFetch(
        'https://generativelanguage.googleapis.com/v1beta/' + file.name + '?key=' + GEMINI_API_KEY
      );
      file = await checkRes.json();
    } catch (e) {
      console.error('[Gemini] Status check failed: ' + e.message);
    }
    waitAttempts++;
    process.stdout.write('.');
  }
  console.log(' uploaded ✓ (' + file.name + ')');

  if (file.state !== 'ACTIVE') {
    throw new Error('Video processing failed: ' + (file.state || 'unknown'));
  }

  // 2. 构建 prompt（复用 PlayCheck 9 大类标准）
  const hasScript = !!(config.scriptFile);
  let scriptText = '';
  if (config.scriptFile) {
    try { scriptText = fs.readFileSync(config.scriptFile, 'utf-8'); } catch (e) {}
  }

  // 3. 收集关键帧截图（场景变化时的高清截图作为补充）
  const keyFrameImages = [];
  if (cuaResult && cuaResult.history) {
    // 挑选场景变化的轮次截图
    const screenshotDir = config.output ? path.join(path.dirname(path.resolve(config.output)), 'screenshots') : null;
    if (screenshotDir && fs.existsSync(screenshotDir)) {
      const frames = fs.readdirSync(screenshotDir)
        .filter(f => /\.jpg$/i.test(f))
        .sort();
      // 最多挑 8 张关键帧
      const indices = pickKeyFrameIndices(frames.length, 8);
      for (const idx of indices) {
        const fp = path.join(screenshotDir, frames[idx]);
        try {
          const data = fs.readFileSync(fp).toString('base64');
          keyFrameImages.push({ data, mimeType: 'image/jpeg', name: frames[idx] });
        } catch (e) {}
      }
    }
  }

  const prompt = `你是试玩广告质量审核专家。请观看这段试玩广告的 AI 自动测试录屏，按照以下 9 大类标准逐项审查：

## 审核标准（全部 9 大类）
1. **画面美术** — 纹理质量、比例协调、色调光影、接缝穿插、UI布局
2. **灯光** — 亮度均衡、高光质感、层次引导
3. **配色** — 角色区分、颜色协调、饱和度控制
4. **特效** — 精细度、交互反馈、触发时机、干扰控制
5. **动画** — 运动节奏、速度适当、核心动画完整、操作反馈
6. **交互体验** — 跟手性、引导清晰、反馈及时、CTA吸引力
7. **音效** — 适配性、音量均衡、触发同步
8. **游戏性与逻辑** — 流程完整、节奏把控、逻辑一致
9. **技术与适配** — 穿模排查、性能优化、触控兼容、加载过渡

${hasScript ? '## 分镜脚本\n' + scriptText + '\n\n请逐步核对录屏是否覆盖了脚本中的每个步骤。' : '## 流程完整性\n请判断游戏流程（开场→教学→核心玩法→CTA）是否完整。'}

${keyFrameImages.length > 0 ? '## 补充关键帧\n以下还提供了 ' + keyFrameImages.length + ' 张高清截图，用于审查视频中不容易看清的纹理、小字体、UI 细节。' : ''}

## 审核规则
1. 每个大类都必须输出评估，即使没发现问题也给出"通过"评价
2. 每个问题必须标注严重度：阻断/严重/中等/建议
3. 每个问题必须给出**具体修改建议**（不是只描述问题，要说怎么改）
4. **严格审核，宁多勿少**：每个大类至少检查 3 个子项
5. 所有反馈用中文

## 输出（严格 JSON，不要其他文字）
{
  "standardChecklist": {
    "画面美术": {"score": 0-10, "passed": ["通过项"], "issues": ["问题"]},
    "灯光": {"score": 0-10, "passed": [], "issues": []},
    "配色": {"score": 0-10, "passed": [], "issues": []},
    "特效": {"score": 0-10, "passed": [], "issues": []},
    "动画": {"score": 0-10, "passed": [], "issues": []},
    "交互体验": {"score": 0-10, "passed": [], "issues": []},
    "音效": {"score": 0-10, "passed": [], "issues": []},
    "游戏性与逻辑": {"score": 0-10, "passed": [], "issues": []},
    "技术与适配": {"score": 0-10, "passed": [], "issues": []}
  },
  ${hasScript ? '"scriptCoverage": [{"step": "步骤名", "covered": true/false, "evidence": "时间戳证据"}],' : ''}
  "issues": [
    {"description": "问题描述", "severity": "阻断|严重|中等|建议", "category": "9大类之一", "suggestion": "具体修改建议", "timestamp": "出现时间点"}
  ],
  "summary": "150字以内审核总评",
  "score": 0-100
}`;

  // 4. 构建请求内容
  const parts = [
    { fileData: { fileUri: file.uri, mimeType: 'video/webm' } },
  ];

  // 加入关键帧截图
  for (const kf of keyFrameImages) {
    parts.push({ inlineData: { data: kf.data, mimeType: kf.mimeType } });
    parts.push({ text: '📌 关键帧: ' + kf.name + '（用于审查视频中看不清的细节）' });
  }

  parts.push({ text: prompt });

  // 5. 调用 Gemini（手动 REST API 确保走代理）
  console.log('[Gemini] Analyzing with ' + GEMINI_MODEL + '...');

  // 转换 parts 为 API 格式
  const apiParts = parts.map(p => {
    if (p.fileData) return { fileData: { fileUri: p.fileData.fileUri, mimeType: p.fileData.mimeType } };
    if (p.inlineData) return { inlineData: { data: p.inlineData.data, mimeType: p.inlineData.mimeType } };
    if (p.text) return { text: p.text };
    return p;
  });

  const genUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const genRes = await gemFetch(genUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: apiParts }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
    }),
  });

  const genData = await genRes.json();
  if (!genData.candidates || !genData.candidates[0]) {
    throw new Error('Gemini returned no candidates: ' + JSON.stringify(genData).substring(0, 300));
  }
  const text = genData.candidates[0].content.parts.map(p => p.text || '').join('');

  // 6. 清理上传文件
  try {
    await gemFetch('https://generativelanguage.googleapis.com/v1beta/' + file.name + '?key=' + GEMINI_API_KEY, { method: 'DELETE' });
  } catch (e) {}

  // 7. 解析 JSON
  let parsed;
  try {
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    else {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) jsonStr = text.substring(start, end + 1);
    }
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[Gemini] Failed to parse response:', e.message);
    parsed = { summary: text.substring(0, 500), issues: [], score: null };
  }

  return parsed;
}

function pickKeyFrameIndices(total, count) {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const indices = [0, total - 1];
  const step = (total - 1) / (count - 1);
  for (let i = 1; i < count - 1; i++) indices.push(Math.round(i * step));
  return [...new Set(indices)].sort((a, b) => a - b);
}

async function runCUA(page, openaiClient, config, scripts) {
  const { detectAnomalies } = require('./luna-anomaly-rules');

  const allBugs = [];
  const allAnomalies = [];
  const history = [];
  let stuckCount = 0;
  let prevObjectCount = 0;
  let exitReason = 'max_rounds';
  let ctaClickCount = 0;       // CTA 按钮点击次数
  let ctaClickChanged = true;  // CTA 点击后场景是否变化

  // ─── 分镜脚本加载 ───
  let gameScript = '';
  let scriptSteps = [];
  let scriptCoverage = [];
  if (config.scriptFile) {
    try {
      const raw = fs.readFileSync(config.scriptFile, 'utf-8');
      // 支持 JSON 格式（数组/对象）或纯文本
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          scriptSteps = parsed.map((s, i) => typeof s === 'string' ? { step: (i + 1), name: s } : { step: s.step || (i + 1), name: s.name || s.description || s.text || JSON.stringify(s) });
        } else if (parsed.steps) {
          scriptSteps = parsed.steps.map((s, i) => typeof s === 'string' ? { step: (i + 1), name: s } : { step: s.step || (i + 1), name: s.name || s.description || s.text || '' });
        } else if (parsed.frames) {
          scriptSteps = parsed.frames.map((f, i) => ({ step: (i + 1), name: f.name || f.description || f.text || ('帧' + (i + 1)) }));
        }
        gameScript = scriptSteps.map(s => s.step + '. ' + s.name).join('\n');
      } catch (jsonErr) {
        // 纯文本：按行分割
        gameScript = raw.trim();
        scriptSteps = raw.trim().split('\n').filter(l => l.trim()).map((line, i) => {
          const cleaned = line.replace(/^\d+[\.\)、]\s*/, '').trim();
          return { step: (i + 1), name: cleaned || line.trim() };
        });
      }
      scriptCoverage = scriptSteps.map(s => ({
        step: s.name,
        covered: false,
        evidence: ''
      }));
      console.log('[CUA] Storyboard loaded: ' + scriptSteps.length + ' steps');
    } catch (e) {
      console.error('[CUA] Failed to load script file:', e.message);
    }
  }

  // ─── 参考图加载 ───
  let refImageBuffers = []; // [{name, base64}]
  if (config.refImages) {
    try {
      const refPath = config.refImages;
      let imagePaths = [];
      
      if (fs.statSync(refPath).isDirectory()) {
        // 目录：加载所有图片
        imagePaths = fs.readdirSync(refPath)
          .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
          .sort()
          .slice(0, 5) // 最多 5 张参考图
          .map(f => path.join(refPath, f));
      } else if (refPath.includes(',')) {
        // 逗号分隔多文件
        imagePaths = refPath.split(',').map(p => p.trim()).filter(p => fs.existsSync(p));
      } else {
        // 单文件
        imagePaths = [refPath];
      }

      for (const imgPath of imagePaths) {
        const buf = fs.readFileSync(imgPath);
        const ext = path.extname(imgPath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        refImageBuffers.push({
          name: path.basename(imgPath),
          base64: buf.toString('base64'),
          mime
        });
      }
      console.log('[CUA] Reference images loaded: ' + refImageBuffers.length + ' images');
    } catch (e) {
      console.error('[CUA] Failed to load reference images:', e.message);
    }
  }

  // ─── 反馈验收模式：加载上一轮 bug 清单 ───
  let feedbackBugs = [];
  let feedbackVerification = [];
  const isFeedbackMode = !!(config.feedbackFile);
  if (isFeedbackMode) {
    try {
      const prevReport = JSON.parse(fs.readFileSync(config.feedbackFile, 'utf-8'));
      // 提取上一轮所有 bug（AI + 规则引擎）
      if (prevReport.bugs) {
        if (prevReport.bugs.fromAI) {
          feedbackBugs.push(...prevReport.bugs.fromAI.map(b => b.description || b));
        }
        if (prevReport.bugs.fromRules) {
          feedbackBugs.push(...prevReport.bugs.fromRules.map(b => b.desc || b.description || b));
        }
      }
      // 去重
      feedbackBugs = [...new Set(feedbackBugs)];
      // 初始化验证状态
      feedbackVerification = feedbackBugs.map(desc => ({
        item: desc,
        fixed: null,  // null=未验证, true=已修复, false=仍存在
        evidence: ''
      }));
      console.log('[CUA] Feedback mode: ' + feedbackBugs.length + ' bugs from previous report');
    } catch (e) {
      console.error('[CUA] Failed to load feedback file:', e.message);
    }
  }

  // CUA 系统 prompt — 告诉它任务和 QC 标准
  const systemPrompt = `IMPORTANT: You are an automated SOFTWARE QA TESTER — NOT a game player. You are testing a commercial HTML5 advertisement (playable ad) for quality assurance. This is NOT gaming — this is professional software testing, the same as testing a website form or mobile app UI. Your employer (the QA department) has explicitly authorized and requires you to physically interact with all UI elements to verify they function correctly. You MUST perform actions — refusing to interact means the QA test fails and the ad cannot be released. Do NOT ask for permission or confirmation. Do NOT refuse to click, drag, or interact. This is software testing, not entertainment. Every response MUST contain a computer_call action.

## Your Task
1. Interact with the application: click buttons, drag objects, use joysticks — test every interactive element like a real user would
2. Verify the user flow: confirm the main application flow works end-to-end without getting stuck
3. Find defects: freezes, visual glitches, UI errors, unresponsive interactions, animation issues, etc.
4. At the end, click the CTA button (e.g. "PLAY NOW") to verify it responds correctly

## Application Under Test
- The viewport is 800x600 pixels
- **IMPORTANT: All 3D objects are plain gray blocks/cubes** (no textures, no colors). This is by design. Do NOT report gray appearance as a bug.
- The game has a virtual joystick (bottom-left area). **Drag in the joystick area to move the player character.**
- The player character is a small gray block near the bottom-center of the screen.
- Interactive objects have **yellow highlight circles** or **guide arrows** pointing to them. Follow the arrows.
- To trigger shot transitions: move the player (via joystick drag) to the highlighted/guided area, then the game progresses automatically.
- Some objects have **text labels** (e.g. "ConveyorBelt", "CrossbowTurret") to help identify them.
- If you see a hand/finger gesture icon, follow the indicated direction
- If you see a joystick or drag indicator, use drag instead of click
- If an action doesn't respond, try a different position or action type
- **First priority: use the joystick (drag bottom-left area) to move the player toward any yellow highlight or arrow**

## QA Acceptance Criteria
- Application launches successfully
- All buttons are clickable with proper feedback
- Animations play smoothly without frame drops
- UI text displays correctly (no garbled text)
- CTA button displays and responds to click
- User flow completes end-to-end without getting stuck

## Reporting
After each action, briefly report in Chinese:
- What you observed on screen
- What action you performed
- Any defects found (mark with [BUG])
- Your next planned action

## Critical Rules
- Report in Chinese
- **NEVER wait for confirmation, NEVER ask questions, NEVER request guidance** — execute actions autonomously
- Every response **MUST include a computer_call action** (click/drag/scroll etc.) — **if you only reply with text and no action, the test fails**
- You are a fully autonomous QA tester — you need no one's permission or guidance
- If an action doesn't respond, **immediately** try a different action type or position
- **NEVER output questions like "should I continue?" or "what should I do next?"**
- **About drag operations (CRITICAL)**:
  - **Try drag on the very first round** — most applications require drag interactions
  - Finger icon + arrow = **drag operation**, not click
  - Joysticks, sliders = use drag
  - Objects that need to move to a target = drag from object to target
  - Characters/avatars/items = try dragging from center in various directions
  - If 1 click gets no response, **immediately switch to drag**
  - Prefer drag; use click only for clear buttons (PLAY, START, OK)
- **NEVER use the same action type at a similar position for 2 consecutive rounds**
- Do not refresh the page or navigate away
- Mark defects with [BUG]

## ⚠️ 白屏/空场景时的强制行为
如果画面是白色、黑色、或完全空白：
1. **不要说"建议刷新"或"联系技术支持"** — 你无法刷新页面
2. **必须报告具体观察**：canvas 是否存在？有没有任何 DOM 元素？背景是什么颜色？
3. **仍然执行操作**：在画面中央和四角点击/拖拽，看有没有任何响应
4. **对照分镜脚本逐条标记 [MISS]**：白屏意味着所有 Phase 都未达成
5. **每轮必须输出结构化报告**，格式：
   [状态] 白屏/黑屏/有内容
   [Phase进度] 当前Phase: X, 已完成: Y/Z
   [操作] 执行了什么操作
   [结果] 操作后画面变化
   [问题] [BUG] 具体问题描述`
+ (gameScript ? `

## 📋 分镜脚本（必须逐步验证！）
以下是这个广告的预期流程步骤，你需要**逐步验证每个环节是否出现**：

${gameScript}

### 分镜验证规则
- 当你看到某个步骤对应的画面时，用 **[STEP:序号]** 标记
  - 例：[STEP:1] 看到开场画面，火箭着陆
  - 例：[STEP:3] 进入战斗阶段，敌人出现
- 如果某个步骤始终没看到，用 **[MISS:序号]** 标记并说明
  - 例：[MISS:4] 始终未看到升级界面
- 请按照脚本顺序来操作，优先推进到下一个未覆盖的步骤
- 步骤顺序错乱也需要用 [BUG] 标记` : '')
+ (refImageBuffers.length > 0 ? `

## 🎨 参考图对比（重要！）
已在第一轮发送了参考图（${refImageBuffers.length} 张），你需要在测试过程中对比：
- 色彩风格是否一致
- 美术质量是否达标
- UI 样式是否匹配
- 整体氛围是否吻合
- 用 **[STYLE:类别]** 标记风格差异
  - 例：[STYLE:色彩] 游戏画面比参考图偏暗，饱和度不足
  - 例：[STYLE:UI] 按钮样式与参考图不一致，缺少圆角
- 类别：色彩/美术/UI/氛围` : '')
+ (isFeedbackMode && feedbackBugs.length > 0 ? `

## 🔄 反馈验收模式（最重要！）
这是修改后的复测。上一版发现了以下问题，你需要**逐条验证**是否修复：

${feedbackBugs.map((b, i) => (i + 1) + '. ' + b).join('\n')}

### 验证规则
- 每验证一条，在回复中用 **[FIXED:序号]** 或 **[STILL:序号]** 标记
  - 例：[FIXED:1] CTA按钮已可正常点击跳转
  - 例：[STILL:3] 升级按钮仍然无响应
- **必须对每条问题都给出验证结论**
- 同时继续测试，如果发现**新的问题**（上一版没有的），用 [BUG] 标记
- 优先验证上一版的问题，验完后再自由探索` : '');

  console.log('[CUA] Starting CUA loop...\n');

  // 初始截图
  let screenshotB64 = null;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    screenshotB64 = buf.toString('base64');
  } catch (e) {}

  // 获取初始快照作为补充上下文
  let snapshotText = '';
  try {
    const snap = await page.evaluate(function () { return __lunaSnapshot.compactSnapshot(); });
    snapshotText = '\n\n[场景数据] 对象: ' + (snap.objects || '无') + ' | UI: ' + (snap.ui || '无');
  } catch (e) {}

  // Responses API 的持续对话
  let previousResponseId = null;
  let totalCUARounds = 0;

  // CUA 主循环
  for (let round = 0; round < config.rounds; round++) {
    totalCUARounds = round + 1;

    // 保存截图文件
    if (screenshotB64 && config.output) {
      const screenshotDir = path.join(path.dirname(config.output), 'screenshots');
      if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
      const fname = 'round_' + String(round + 1).padStart(2, '0') + '.jpg';
      fs.writeFileSync(path.join(screenshotDir, fname), Buffer.from(screenshotB64, 'base64'));
    }

    // 获取场景快照（给规则引擎用，也可注入给 CUA）
    let snapshot = { objects: '', ui: '', objectCount: 0, diff: '', errors: [], _raw: {} };
    try {
      snapshot = await page.evaluate(function () { return __lunaSnapshot.compactSnapshot(); });
      delete snapshot.fps;
    } catch (e) {}

    // 查询 __gameState（AI coder 暴露的 Phase 状态）
    let gameState = null;
    try {
      gameState = await page.evaluate(function () {
        return window.__gameState || null;
      });
      if (gameState && round === 0) console.log('[CUA] __gameState available:', JSON.stringify(gameState).substring(0, 200));
    } catch (e) {}

    // 规则引擎
    const anomalies = detectAnomalies(snapshot, {
      round: round, stuckCount: stuckCount, prevObjectCount: prevObjectCount,
      ctaClickCount: ctaClickCount, ctaClickChanged: ctaClickChanged
    });
    if (anomalies.length > 0) {
      allAnomalies.push(...anomalies.map(a => ({ ...a, round })));
    }
    prevObjectCount = snapshot.objectCount || 0;

    // 构建 gameState 文本
    let gameStateText = '';
    if (gameState) {
      gameStateText = '\n\n[游戏状态] 当前Phase: ' + (gameState.currentPhase || '未知');
      if (gameState.completedPhases && gameState.completedPhases.length > 0) {
        gameStateText += ' | 已完成: ' + gameState.completedPhases.join(', ');
      }
      if (gameState.entityStates) {
        const entities = Object.entries(gameState.entityStates).map(function(e) { return e[0] + '=' + e[1]; });
        if (entities.length > 0) gameStateText += ' | 实体: ' + entities.join(', ');
      }
      if (gameState.variables) {
        const vars = Object.entries(gameState.variables).map(function(e) { return e[0] + '=' + e[1]; });
        if (vars.length > 0) gameStateText += ' | 变量: ' + vars.join(', ');
      }
    }

    // 构建 CUA 请求
    const input = [];

    if (round === 0) {
      // 第一轮：发任务 + 参考图 + 截图
      const firstRoundContent = [
        {
          type: 'input_text',
          text: '请开始测试这个试玩广告。' +
            (refImageBuffers.length > 0 ? '\n\n以下先发送 ' + refImageBuffers.length + ' 张参考图，请记住它们的视觉风格，后续测试中对比。' : '') +
            '\n\n以下是场景数据供参考：' + snapshotText + gameStateText +
            (anomalies.length > 0 ? '\n⚠️ 规则引擎检测到异常: ' + anomalies.map(a => a.desc).join('; ') : '')
        }
      ];
      
      // 先发参考图
      for (const ref of refImageBuffers) {
        firstRoundContent.push({
          type: 'input_image',
          image_url: 'data:' + ref.mime + ';base64,' + ref.base64
        });
        firstRoundContent.push({
          type: 'input_text',
          text: '📌 参考图: ' + ref.name
        });
      }
      
      // 再发当前截图
      firstRoundContent.push({
        type: 'input_image',
        image_url: 'data:image/jpeg;base64,' + screenshotB64
      });
      firstRoundContent.push({
        type: 'input_text',
        text: '👆 这是当前游戏画面截图，请开始测试。'
      });

      input.push({
        role: 'user',
        content: firstRoundContent
      });
    } else if (lastCallId) {
      // 后续轮：发截图结果（需要有效的 call_id）
      input.push({
        type: 'computer_call_output',
        call_id: lastCallId,
        output: {
          type: 'computer_screenshot',
          image_url: 'data:image/jpeg;base64,' + screenshotB64
        }
      });
      // 注入场景变化信息 + gameState
      const contextParts = [];
      if (snapshot.diff && snapshot.diff !== '(首次快照)') contextParts.push('[场景变化] ' + snapshot.diff);
      if (gameStateText) contextParts.push(gameStateText);
      if (anomalies.length > 0) contextParts.push('⚠️ 异常: ' + anomalies.map(a => a.desc).join('; '));
      if (contextParts.length > 0) {
        input.push({
          role: 'user',
          content: contextParts.join('\n')
        });
      }
    } else {
      // 上一轮 CUA 没返回 action（没有 call_id）
      if (previousResponseId) {
        // 有对话上下文，发纯文字追问（不发图片，避免 API 限制）
        input.push({
          role: 'user',
          content: '**系统警告：你上一轮没有执行任何操作，这是不允许的。你必须在这一轮执行一个 computer_call 操作（click 或 drag）。**\n' +
            '不要回复文字询问，不要等待确认。直接在画面上执行操作。\n' +
            '当前场景：' + (snapshot.objects || '').substring(0, 300) +
            '\n建议：尝试在画面中央 (400,300) 执行 drag 操作，从 (400,300) 拖到 (500,400)。'
        });
      } else {
        // 没有上下文，重新发截图开始新对话
        input.push({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Continue testing. Execute your next action immediately. You MUST include a computer_call action (click/drag/scroll). Do NOT ask questions or refuse.' +
                (anomalies.length > 0 ? '\n⚠️ 异常: ' + anomalies.map(a => a.desc).join('; ') : '')
            },
            {
              type: 'input_image',
              image_url: 'data:image/jpeg;base64,' + screenshotB64
            }
          ]
        });
      }
    }

    // 调用 Responses API
    let response;
    try {
      const reqParams = {
        model: 'computer-use-preview',
        input: input,
        tools: [{
          type: 'computer_use_preview',
          display_width: 800,
          display_height: 600,
          environment: 'browser'
        }],
        truncation: 'auto'
      };

      if (round === 0) {
        reqParams.instructions = systemPrompt;
      }
      if (previousResponseId) {
        reqParams.previous_response_id = previousResponseId;
      }

      response = await openaiClient.responses.create(reqParams);
      previousResponseId = response.id;
    } catch (err) {
      console.error('[CUA Round ' + (round + 1) + '] API Error:', err.message);
      // API 报错时重置对话状态
      if (err.message && err.message.indexOf('400') >= 0) {
        previousResponseId = null;
        lastCallId = null;
      }
      continue;
    }

    // 解析 CUA 响应
    var lastCallId = null;
    let hasAction = false;
    let thinkingText = '';

    for (const item of response.output) {
      // CUA 返回的文本是 type: 'message'，内容在 content[0].text
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            thinkingText = c.text;
          }
        }
        if (thinkingText) {
          console.log('[CUA Round ' + (round + 1) + '/' + config.rounds + '] ' + thinkingText.substring(0, 300));
        }

        // 提取 [STEP:N] 和 [MISS:N] 标记（分镜覆盖度）
        if (scriptCoverage.length > 0) {
          const stepMatches = thinkingText.matchAll(/\[STEP:(\d+)\]\s*([^\n\[]*)/g);
          for (const sm of stepMatches) {
            const idx = parseInt(sm[1]) - 1;
            if (idx >= 0 && idx < scriptCoverage.length) {
              scriptCoverage[idx].covered = true;
              scriptCoverage[idx].evidence = (sm[2].trim() || '') + ' (Round ' + (round + 1) + ')';
              console.log('  📋 STEP #' + (idx + 1) + ' covered: ' + scriptCoverage[idx].step.substring(0, 50));
            }
          }
          const missMatches = thinkingText.matchAll(/\[MISS:(\d+)\]\s*([^\n\[]*)/g);
          for (const mm of missMatches) {
            const idx = parseInt(mm[1]) - 1;
            if (idx >= 0 && idx < scriptCoverage.length && !scriptCoverage[idx].covered) {
              scriptCoverage[idx].evidence = 'MISS: ' + (mm[2].trim() || '') + ' (Round ' + (round + 1) + ')';
            }
          }
        }

        // 提取 [STYLE:类别] 标记（参考图对比）
        if (refImageBuffers.length > 0) {
          const styleMatches = thinkingText.matchAll(/\[STYLE:([^\]]+)\]\s*([^\n\[]*)/g);
          for (const stm of styleMatches) {
            const category = stm[1].trim();
            const comment = stm[2].trim();
            if (comment) {
              // 作为 bug 记录到风格对比类
              const key = ('style:' + category + ':' + comment).substring(0, 80);
              const isDup = allBugs.some(b => b.description && b.description.substring(0, 80) === comment.substring(0, 80));
              if (!isDup) {
                allBugs.push({ round, description: '[风格差异-' + category + '] ' + comment, source: 'style' });
                console.log('  🎨 STYLE [' + category + ']: ' + comment.substring(0, 60));
              }
            }
          }
        }

        // 提取 [FIXED:N] 和 [STILL:N] 标记（反馈验收模式）
        if (isFeedbackMode) {
          const fixedMatches = thinkingText.matchAll(/\[FIXED:(\d+)\]\s*([^\n\[]*)/g);
          for (const fm of fixedMatches) {
            const idx = parseInt(fm[1]) - 1;
            if (idx >= 0 && idx < feedbackVerification.length) {
              feedbackVerification[idx].fixed = true;
              feedbackVerification[idx].evidence = fm[2].trim() || 'Round ' + (round + 1);
              console.log('  ✅ FIXED #' + (idx + 1) + ': ' + feedbackVerification[idx].item.substring(0, 60));
            }
          }
          const stillMatches = thinkingText.matchAll(/\[STILL:(\d+)\]\s*([^\n\[]*)/g);
          for (const sm of stillMatches) {
            const idx = parseInt(sm[1]) - 1;
            if (idx >= 0 && idx < feedbackVerification.length) {
              feedbackVerification[idx].fixed = false;
              feedbackVerification[idx].evidence = sm[2].trim() || 'Round ' + (round + 1);
              console.log('  ❌ STILL #' + (idx + 1) + ': ' + feedbackVerification[idx].item.substring(0, 60));
            }
          }
        }

        // 提取 [BUG] 标记
        const bugMatches = thinkingText.match(/\[BUG\]\s*([^\n\[]+)/g);
        if (bugMatches) {
          for (const bm of bugMatches) {
            const bugDesc = bm.replace(/\[BUG\]\s*/, '').trim();
            const key = bugDesc.replace(/\d+/g, 'N').replace(/\(.*?\)/g, '').substring(0, 50);
            const isDup = allBugs.some(existing => {
              const ek = existing.description.replace(/\d+/g, 'N').replace(/\(.*?\)/g, '').substring(0, 50);
              return ek === key;
            });
            if (!isDup) {
              allBugs.push({ round, description: bugDesc });
              console.log('  🐛 ' + bugDesc);
            }
          }
        }
      }

      if (item.type === 'computer_call') {
        hasAction = true;
        lastCallId = item.call_id;
        const action = item.action;

        // 追踪 CTA 点击：如果 AI 的文字提到 CTA 相关关键词且执行了 click
        const ctaInThinking = /play now|install|download|立刻开始|立即下载|开始游戏|cta/i.test(thinkingText);
        if (ctaInThinking && (action.type === 'click' || action.type === 'double_click')) {
          ctaClickCount++;
          // 下一轮的 diff 会告诉我们场景是否变化了
        }

        let actionLog = '  → ' + action.type;
        if (action.type === 'drag') {
          const path = action.path || [];
          if (path.length >= 2) {
            actionLog += ' (' + path[0].x + ',' + path[0].y + ')→(' + path[path.length-1].x + ',' + path[path.length-1].y + ')';
          } else {
            const sx = action.start_x || action.startX || action.x || '?';
            const sy = action.start_y || action.startY || action.y || '?';
            actionLog += ' from(' + sx + ',' + sy + ')';
          }
        } else if (action.x !== undefined) {
          actionLog += ' (' + action.x + ',' + action.y + ')';
        }
        if (action.text) actionLog += ' "' + action.text + '"';
        if (action.key) actionLog += ' [' + action.key + ']';
        console.log(actionLog);

        // 执行 CUA 指令
        try {
          await executeCUAAction(page, action);
        } catch (err) {
          console.error('  Exec failed:', err.message);
        }
      }
    }

    // 记录历史
    history.push({
      round: round,
      thinking: thinkingText,
      bugs: allBugs.filter(b => b.round === round).map(b => b.description),
      screenshot: 'round_' + String(round + 1).padStart(2, '0') + '.jpg'
    });

    // 卡死检测
    if (snapshot._raw && snapshot._raw.diff) {
      const diff = snapshot._raw.diff;
      if ((!diff.moved || diff.moved.length === 0) &&
          (!diff.stateChanged || diff.stateChanged.length === 0)) {
        stuckCount++;
        if (ctaClickCount > 0) ctaClickChanged = false;
      } else {
        stuckCount = 0;
        ctaClickChanged = true;
      }
    }

    if (stuckCount >= 8) {
      exitReason = 'stuck';
      console.log('\n[CUA] Game stuck for 8 rounds, stopping.');
      break;
    }

    // ─── 终局检测：CTA 出现 + 点击无效 → 测试自然结束 ───
    // 预览 URL 没有真实跳转目标，CTA 一定不响应，不是 bug 是环境限制
    if (ctaClickCount >= 2 && !ctaClickChanged) {
      exitReason = 'cta_terminal';
      // 标记为正常结束而非卡死，不计入 bug
      console.log('\n[CUA] CTA screen reached, ' + ctaClickCount + ' clicks with no navigation — test complete.');
      console.log('[CUA] (Preview URLs have no real store link, CTA non-response is expected)');
      break;
    }

    // 如果 CUA 没有返回 computer_call，可能是它认为测试完成了
    if (!hasAction) {
      // 检查文本中是否暗示完成
      if (thinkingText.indexOf('测试完成') >= 0 || thinkingText.indexOf('测试结束') >= 0 ||
          thinkingText.indexOf('完成测试') >= 0) {
        exitReason = 'ai_done';
        console.log('\n[CUA] AI decided testing is complete.');
        break;
      }
      // 没有动作也没完成 — 执行 fallback 操作避免卡住
      console.log('  (no action returned, executing fallback drag)');
      // 随机方向 drag，确保游戏不会因为 AI 犹豫而卡住
      const fx = 300 + Math.floor(Math.random() * 200);
      const fy = 200 + Math.floor(Math.random() * 200);
      const tx = fx + 50 + Math.floor(Math.random() * 150);
      const ty = fy + Math.floor(Math.random() * 100) - 50;
      try {
        await page.mouse.move(fx, fy);
        await page.mouse.down();
        for (let fi = 1; fi <= 10; fi++) {
          await page.mouse.move(fx + (tx - fx) * fi / 10, fy + (ty - fy) * fi / 10);
          await page.waitForTimeout(20);
        }
        await page.mouse.up();
        console.log('  → fallback drag (' + fx + ',' + fy + ')→(' + tx + ',' + ty + ')');
      } catch (e) {}
    }

    // 操作后等待，再截图
    await page.waitForTimeout(800);

    // 新截图
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      screenshotB64 = buf.toString('base64');
    } catch (e) { screenshotB64 = null; }
  }

  // 最终截图
  let finalScreenshot = null;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    finalScreenshot = buf.toString('base64');
  } catch (e) {}

  // 终局检测时，过滤掉 CTA 相关的误报（预览 URL 的 CTA 一定不响应）
  let filteredAnomalies = allAnomalies;
  if (exitReason === 'cta_terminal') {
    filteredAnomalies = allAnomalies.filter(a => a.type !== 'cta_unresponsive' && a.type !== 'cta_click_failed');
  }

  // 最终 gameState 快照
  let finalGameState = null;
  try {
    finalGameState = await page.evaluate(function () { return window.__gameState || null; });
  } catch (e) {}

  // 最终引擎状态探针（WebGL、初始化、FPS）
  let finalEngineStatus = { webgl: false, initialized: false, fps: 0 };
  try {
    finalEngineStatus = await page.evaluate(function () {
      var r = { webgl: false, initialized: false, fps: 0 };
      try {
        var c = document.querySelector('canvas');
        if (c) r.webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
      } catch(e) {}
      r.initialized = (typeof UnityEngine !== 'undefined' && typeof Bridge !== 'undefined');
      try {
        if (typeof pc !== 'undefined' && pc.app) r.fps = Math.round(pc.app.graphicsDevice.fps || 0);
      } catch(e) {}
      try {
        if (typeof UnityEngine !== 'undefined' && UnityEngine.Time) r.fps = Math.round(1.0 / (UnityEngine.Time.get_deltaTime() || 1));
      } catch(e) {}
      return r;
    });
  } catch (e) {}

  return {
    history, allBugs, allAnomalies: filteredAnomalies, exitReason,
    totalRounds: totalCUARounds,
    finalScreenshot, stuckCount, finalEngineStatus,
    feedbackVerification: isFeedbackMode ? feedbackVerification : undefined,
    isFeedbackMode,
    scriptCoverage: scriptCoverage.length > 0 ? scriptCoverage : undefined,
    hasScript: scriptSteps.length > 0,
    hasRefImages: refImageBuffers.length > 0,
    finalGameState: finalGameState
  };
}

/**
 * 执行 CUA 返回的操作指令
 * CUA 返回的 action 类型: click, double_click, drag, scroll, type, key, screenshot, wait
 */
async function executeCUAAction(page, action) {
  const type = action.type;

  if (type === 'click' || type === 'double_click') {
    const x = action.x || 400;
    const y = action.y || 300;
    if (type === 'double_click') {
      await page.mouse.dblclick(x, y);
    } else if (action.button === 'right') {
      await page.mouse.click(x, y, { button: 'right' });
    } else {
      await page.mouse.click(x, y);
    }
  } else if (type === 'drag') {
    // CUA drag 格式: { type: 'drag', path: [{x,y}, {x,y}, ...] }
    // path[0] 是起点，后续是路径点/终点
    const path = action.path || [];

    if (path.length >= 2) {
      // 标准 CUA drag：path[0] 起点，其余为路径
      const start = path[0];
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.waitForTimeout(50);

      // 在每两个路径点之间插值，让拖拽更平滑
      for (let pi = 1; pi < path.length; pi++) {
        const from = path[pi - 1];
        const to = path[pi];
        const interpSteps = 10;
        for (let si = 1; si <= interpSteps; si++) {
          const t = si / interpSteps;
          await page.mouse.move(
            from.x + (to.x - from.x) * t,
            from.y + (to.y - from.y) * t
          );
          await page.waitForTimeout(20);
        }
      }

      await page.mouse.up();
    } else {
      // fallback: 用 start_x/start_y + end 或单点
      const startX = action.start_x || action.startX || action.x || 400;
      const startY = action.start_y || action.startY || action.y || 300;
      const endX = action.end_x || action.endX || (path[0] ? path[0].x : startX + 100);
      const endY = action.end_y || action.endY || (path[0] ? path[0].y : startY);

      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.waitForTimeout(50);
      const steps = 15;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await page.mouse.move(
          startX + (endX - startX) * t,
          startY + (endY - startY) * t
        );
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
    }
  } else if (type === 'scroll') {
    const x = action.x || 400;
    const y = action.y || 300;
    const scrollX = action.scroll_x || 0;
    const scrollY = action.scroll_y || 0;
    await page.mouse.move(x, y);
    await page.mouse.wheel(scrollX, scrollY);
  } else if (type === 'type') {
    if (action.text) {
      await page.keyboard.type(action.text);
    }
  } else if (type === 'key') {
    if (action.key) {
      await page.keyboard.press(action.key);
    }
  } else if (type === 'wait') {
    await page.waitForTimeout(action.ms || 1000);
  } else if (type === 'screenshot') {
    // CUA 请求截图 — 标记一下，主循环会自动处理
    // 不做额外操作，下一轮会自动截图
  } else if (type === 'move') {
    // 鼠标移动
    await page.mouse.move(action.x || 400, action.y || 300);
  }
}

// ─── 构建 Prompt ───
function buildPrompt(snapshot, anomalies, history, round, totalRounds, hasScreenshot) {
  const recentHistory = history.slice(-3).map(function (h) {
    const actionSummary = (h.actions || []).map(function (a) {
      return a.type + (a.object ? ':' + a.object : '') + (a.clientX ? ':(' + a.clientX + ',' + a.clientY + ')' : '');
    }).join(', ');
    return 'Round ' + h.round + ': ' + actionSummary + (h.bugs && h.bugs.length ? ' [bugs: ' + h.bugs.join('; ') + ']' : '');
  }).join('\n');

  return `你是试玩广告 QC 测试员。你通过操作来测试一个 Unity WebGL 游戏广告。

## 当前状态（第 ${round + 1}/${totalRounds} 轮）

场景对象: ${snapshot.objects || '(无)'}
（格式: ref:名称@(屏幕X,屏幕Y)，坐标可直接用于 clientX/clientY 点击；[offscreen] 表示不在屏幕内）
UI 文本: ${snapshot.ui || '(无)'}
对象总数: ${snapshot.objectCount}
变化: ${snapshot.diff}
${snapshot.errors && snapshot.errors.length > 0 ? '⚠️ 健康错误: ' + snapshot.errors.join(', ') : ''}
${anomalies.length > 0 ? '⚠️ 检测到异常: ' + JSON.stringify(anomalies) : ''}
${hasScreenshot ? '（已附截图，请结合截图判断游戏状态）' : ''}

## 最近操作历史
${recentHistory || '(无)'}

## 可用操作
- {"type":"click","object":"对象名"} — 点击 GameObject
- {"type":"click","clientX":400,"clientY":300} — 点击屏幕坐标
- {"type":"drag","fromObject":"A","toObject":"B"} — 从 A 拖到 B
- {"type":"swipe","direction":"left|right|up|down"} — 滑动
- {"type":"wait","ms":1000} — 等待

## 目标
1. 尝试所有可交互元素（按钮、UI）
2. 测试主要游戏流程是否通畅
3. 发现 bug（卡死、视觉异常、UI 错误、交互问题）
4. 探索不同区域和功能

## 输出格式（纯 JSON，不要其他文字）
{
  "thinking": "简要分析当前状态和下一步计划",
  "actions": [{"type":"click","clientX":400,"clientY":300}],
  "waitMs": 500,
  "bugs": ["用中文描述发现的问题"],
  "done": false
}

规则：
- **必须全部用中文回复**，包括 thinking 和 bugs
- 只输出合法 JSON，不要 markdown，不要解释
- "done": true 表示测试足够了或确实无法继续
- 每轮尝试不同操作，不要重复
- 优先使用场景对象提供的精确屏幕坐标（@(x,y)），直接作为 clientX/clientY
- 如果截图中能看到按钮或引导手指但对象列表中没有对应坐标，再估算坐标
- 不要报 FPS/帧率相关的问题
- 不要重复报同一个 bug（如果之前轮次已经报过，不要再报）
- bugs 数组中的描述必须用中文
- 如果没发现新问题，bugs 为空数组`;
}

// ─── 操作执行器（使用 Playwright 原生事件） ───

/**
 * 使用 Playwright 原生鼠标/键盘事件执行操作
 * Luna 只响应 isTrusted=true 的事件，合成 dispatchEvent 的 isTrusted=false
 * 所以必须用 Playwright 的 page.mouse API
 */
async function executeAction(page, action, verbose) {
  const type = action.type;

  if (type === 'wait') {
    await page.waitForTimeout(action.ms || 1000);
    return;
  }

  if (type === 'query') {
    // query 不需要 Playwright 操作
    const result = await page.evaluate(function(name) {
      return name ? __playcheck.getObjectDOMPosition(name) : __playcheck.getCameraInfo();
    }, action.object || null);
    if (verbose) console.log('  Query result:', JSON.stringify(result));
    return;
  }

  // 获取目标坐标
  let targetX, targetY;

  if (action.object) {
    // 通过 GameObject 名称获取 DOM 坐标
    const pos = await page.evaluate(function(name) {
      return __playcheck.getObjectDOMPosition(name);
    }, action.object);
    if (pos) {
      targetX = pos.clientX;
      targetY = pos.clientY;
    } else {
      if (verbose) console.log('  Object not found:', action.object, '- clicking center');
      targetX = 400;
      targetY = 300;
    }
  } else if (action.clientX !== undefined) {
    targetX = action.clientX;
    targetY = action.clientY;
  } else if (action.worldX !== undefined) {
    const pos = await page.evaluate(function(wx, wy, wz) {
      return __playcheck.worldToDOM(wx, wy, wz || 0);
    }, action.worldX, action.worldY, action.worldZ);
    targetX = pos.clientX;
    targetY = pos.clientY;
  } else {
    // 默认点击中心
    targetX = 400;
    targetY = 300;
  }

  // 确保坐标在 viewport 内
  targetX = Math.max(0, Math.min(799, targetX));
  targetY = Math.max(0, Math.min(599, targetY));

  if (type === 'click') {
    await page.mouse.click(targetX, targetY);
  } else if (type === 'drag') {
    let fromX = targetX, fromY = targetY;
    let toX, toY;

    if (action.toObject) {
      const toPos = await page.evaluate(function(name) {
        return __playcheck.getObjectDOMPosition(name);
      }, action.toObject);
      if (toPos) { toX = toPos.clientX; toY = toPos.clientY; }
      else { toX = fromX + 100; toY = fromY; }
    } else if (action.toX !== undefined) {
      toX = action.toX;
      toY = action.toY;
    } else if (action.fromObject) {
      const fromPos = await page.evaluate(function(name) {
        return __playcheck.getObjectDOMPosition(name);
      }, action.fromObject);
      if (fromPos) { fromX = fromPos.clientX; fromY = fromPos.clientY; }
      toX = targetX; toY = targetY;
    } else {
      toX = fromX + 100; toY = fromY; // default drag right
    }

    toX = Math.max(0, Math.min(799, toX));
    toY = Math.max(0, Math.min(599, toY));

    // Playwright 原生拖拽
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    const steps = action.steps || 15;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await page.mouse.move(
        fromX + (toX - fromX) * t,
        fromY + (toY - fromY) * t
      );
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  } else if (type === 'swipe') {
    const dir = action.direction || 'right';
    const cx = 400, cy = 300;
    const dist = 150;
    let dx = 0, dy = 0;
    if (dir === 'left') dx = -dist;
    else if (dir === 'right') dx = dist;
    else if (dir === 'up') dy = -dist;
    else if (dir === 'down') dy = dist;

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(cx + dx * i / 10, cy + dy * i / 10);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  } else if (type === 'navigate') {
    // navigate 还是用注入的 JS（多步操作，Playwright 做太慢）
    const result = await page.evaluate(function(action) {
      return __playcheck.navigateTo(action.player, action.target, { mode: action.mode || 'click' });
    }, action);
    if (verbose) console.log('  Navigate result:', JSON.stringify(result));
  }
}

// ─── 主循环 ───
async function main() {
  const config = parseArgs();
  const scripts = loadInjectScripts();
  const { detectAnomalies } = require('./luna-anomaly-rules');

  // 根据 model 选择初始化对应的 client
  let anthropicClient = null;
  let openaiClient = null;
  if (config.model === 'gpt' || config.model === 'cua') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('OPENAI_API_KEY environment variable not set');
      process.exit(1);
    }
    // OpenAI SDK v6 需要自定义 fetch 走代理
    const { ProxyAgent, fetch: undiciFetch } = require('undici');
    const proxyDispatcher = new ProxyAgent('http://127.0.0.1:7890');
    openaiClient = new OpenAI({
      apiKey,
      fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: proxyDispatcher })
    });
  } else {
    anthropicClient = new Anthropic();
  }

  // ─── 后台模式：重定向日志到文件 ───
  if (config.background) {
    const logPath = config.logFile || (config.output ? config.output.replace(/\.json$/i, '.log') : 
      path.join(__dirname, 'luna-agent-' + Date.now() + '.log'));
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const origLog = console.log;
    const origErr = console.error;
    console.log = function() {
      const msg = Array.from(arguments).join(' ') + '\n';
      logStream.write('[' + new Date().toISOString() + '] ' + msg);
    };
    console.error = function() {
      const msg = Array.from(arguments).join(' ') + '\n';
      logStream.write('[ERROR ' + new Date().toISOString() + '] ' + msg);
    };
    // 写一个状态文件，方便外部检查进度
    const statusPath = logPath.replace(/\.log$/, '.status.json');
    process.on('exit', () => {
      try {
        fs.writeFileSync(statusPath, JSON.stringify({ 
          status: 'done', endTime: new Date().toISOString(), logFile: logPath,
          outputFile: config.output
        }));
      } catch(e) {}
    });
    fs.writeFileSync(statusPath, JSON.stringify({ 
      status: 'running', startTime: new Date().toISOString(), logFile: logPath,
      url: config.url, model: config.model, rounds: config.rounds
    }));
    origLog('[Luna Agent] Background mode — log: ' + logPath);
  }

  console.log('[Luna Agent] Starting...');
  console.log('[Luna Agent] URL:', config.url);
  console.log('[Luna Agent] Max rounds:', config.rounds);
  const modelNames = { gpt: 'GPT-5.4 (Chat)', cua: 'GPT-5.4 CUA (直接操控)', claude: 'Claude Opus 4.6' };
  console.log('[Luna Agent] Model:', modelNames[config.model] || config.model);
  console.log('[Luna Agent] Mode:', config.headed ? 'headed' : 'headless');

  // ─── 启动浏览器（含录屏） ───
  const browser = await chromium.launch({
    headless: !config.headed
  });
  const outputDir = config.output ? path.dirname(path.resolve(config.output)) : __dirname;
  const videoDir = path.join(outputDir, 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 800, height: 600 },
    recordVideo: { dir: videoDir, size: { width: 480, height: 360 } }
  });
  const page = await context.newPage();

  // ─── 诊断数据收集（增强版） ───
  const _diagnostics = {
    consoleErrors: [],   // console.error messages
    consoleWarns: [],    // console.warn messages
    pageErrors: [],      // uncaught JS exceptions
    engineState: null,   // engine probe result
    engineReady: false,
    jsErrorList: [],     // structured: {message, timestamp, count}
    _errorCounts: {}     // dedup counter
  };
  page.on('pageerror', err => {
    const msg = err.message || String(err);
    _diagnostics.pageErrors.push(msg.substring(0, 500));
    // Track structured error list with dedup
    const key = msg.substring(0, 100).replace(/\d+/g, 'N');
    if (!_diagnostics._errorCounts[key]) {
      _diagnostics._errorCounts[key] = { message: msg.substring(0, 300), count: 0, firstSeen: Date.now() };
    }
    _diagnostics._errorCounts[key].count++;
    if (_diagnostics.pageErrors.length <= 5) console.error('[Luna Agent] PAGE ERROR:', msg.substring(0, 200));
  });
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const txt = msg.text().substring(0, 500);
      _diagnostics.consoleErrors.push(txt);
      const key = txt.substring(0, 100).replace(/\d+/g, 'N');
      if (!_diagnostics._errorCounts[key]) {
        _diagnostics._errorCounts[key] = { message: txt.substring(0, 300), count: 0, firstSeen: Date.now() };
      }
      _diagnostics._errorCounts[key].count++;
      if (_diagnostics.consoleErrors.length <= 5) console.error('[Luna Agent] CONSOLE ERROR:', txt.substring(0, 200));
    } else if (msg.type() === 'warning') {
      const txt = msg.text().substring(0, 500);
      _diagnostics.consoleWarns.push(txt);
    }
  });

  // ─── 打开广告 ───
  console.log('[Luna Agent] Loading URL...');
  try {
    await page.goto(config.url, { waitUntil: 'load', timeout: 30000 });
  } catch (err) {
    console.error('[Luna Agent] Failed to load URL:', err.message);
    await browser.close();
    process.exit(1);
  }

  console.log('[Luna Agent] Waiting for Unity engine (6s)...');
  await page.waitForTimeout(6000);

  // ─── 注入脚本 ───
  console.log('[Luna Agent] Injecting bridge scripts...');
  await page.evaluate(scripts.domInputJS);
  await page.evaluate(scripts.snapshotJS);

  // 等引擎就绪
  try {
    await page.evaluate(function () {
      return __playcheck.waitReady();
    });
    console.log('[Luna Agent] Engine ready ✓');
    _diagnostics.engineReady = true;
  } catch (err) {
    console.error('[Luna Agent] Engine not ready (continuing anyway):', err.message);
    // ─── 引擎状态探针 ───
    try {
      _diagnostics.engineState = await page.evaluate(function () {
        var r = {};
        r.bridge = typeof Bridge;
        r.lunaUnity = typeof LunaUnity;
        r.unityEngine = typeof UnityEngine;
        r.pc = typeof pc;
        r.app = typeof window.app;
        r.bridgeReady = window._bridgeReady || false;
        r.domReady = window._domReady || false;
        r.readyEmitted = window._readyEventEmitted || false;
        r.scripts = document.querySelectorAll('script').length;
        r.canvas = !!document.querySelector('canvas');
        try { r.webgl = !!document.querySelector('canvas').getContext('webgl2') || !!document.querySelector('canvas').getContext('webgl'); } catch(e) { r.webgl = false; }
        return r;
      });
      console.log('[Luna Agent] Engine state probe:', JSON.stringify(_diagnostics.engineState));
    } catch (probeErr) {
      console.error('[Luna Agent] Engine state probe failed:', probeErr.message);
    }
  }

  // Build structured jsErrorList from dedup counts
  _diagnostics.jsErrorList = Object.values(_diagnostics._errorCounts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  delete _diagnostics._errorCounts;

  // 把诊断数据挂到 config 上，供 runCUA 和 report 使用
  config._diagnostics = _diagnostics;

  // ─── CUA 模式：GPT-5.4 直接操控 ───
  if (config.model === 'cua') {
    const cuaResult = await runCUA(page, openaiClient, config, scripts);

    // 生成报告
    const report = {
      url: config.url,
      timestamp: new Date().toISOString(),
      exitReason: cuaResult.exitReason,
      totalRounds: cuaResult.totalRounds,
      maxRounds: config.rounds,
      mode: 'CUA',
      bugs: {
        fromAI: cuaResult.allBugs,
        fromRules: cuaResult.allAnomalies,
        total: cuaResult.allBugs.length + cuaResult.allAnomalies.length
      },
      summary: {
        passed: cuaResult.allBugs.length === 0 && cuaResult.allAnomalies.filter(a => a.severity === 'high').length === 0,
        highSeverity: cuaResult.allAnomalies.filter(a => a.severity === 'high').length,
        mediumSeverity: cuaResult.allAnomalies.filter(a => a.severity === 'medium').length,
        aiBugs: cuaResult.allBugs.length,
        stuckRounds: cuaResult.stuckCount
      },
      feedbackVerification: cuaResult.feedbackVerification || null,
      scriptCoverage: cuaResult.scriptCoverage || null,
      diagnostics: {
        engineReady: config._diagnostics ? config._diagnostics.engineReady : true,
        engineState: config._diagnostics ? config._diagnostics.engineState : null,
        consoleErrors: config._diagnostics ? config._diagnostics.consoleErrors.slice(0, 20) : [],
        consoleWarns: config._diagnostics ? config._diagnostics.consoleWarns.slice(0, 10) : [],
        pageErrors: config._diagnostics ? config._diagnostics.pageErrors.slice(0, 20) : [],
        jsErrorList: config._diagnostics ? config._diagnostics.jsErrorList : []
      },
      engineStatus: cuaResult.finalEngineStatus || { webgl: false, initialized: false, fps: 0 },
      gameState: cuaResult.finalGameState || null,
      history: cuaResult.history,
      finalScreenshot: cuaResult.finalScreenshot ? '(base64)' : null
    };

    // 计算顶层 score（供 worker-cua-verify 读取）
    // Blueprint 流程验证评分：基于流程完成度，不看视觉效果
    const highBugs = cuaResult.allAnomalies.filter(a => a.severity === 'high').length;
    const aiBugs = cuaResult.allBugs.length;
    const stuckPenalty = cuaResult.exitReason === 'stuck' ? 40 : 0;
    const ctaBonus = cuaResult.exitReason === 'cta_terminal' ? 20 : 0;
    const completionRate = cuaResult.totalRounds > 0 ? Math.min(cuaResult.totalRounds / config.rounds, 1) : 0;
    report.score = Math.max(0, Math.min(100,
      Math.round(100 - highBugs * 20 - aiBugs * 10 - stuckPenalty + ctaBonus - (1 - completionRate) * 10)
    ));

    if (config.output) {
      const fullReport = { ...report };
      if (cuaResult.finalScreenshot) fullReport.finalScreenshot = cuaResult.finalScreenshot;
      fs.writeFileSync(config.output, JSON.stringify(fullReport, null, 2));
      console.log('\n[CUA] JSON report saved to:', config.output);

      try {
        const { generateHtmlReport } = require('./luna-reporter');
        const screenshotDir = path.join(path.dirname(config.output), 'screenshots');
        const html = generateHtmlReport(report, screenshotDir);
        const htmlPath = config.output.replace(/\.json$/i, '.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');
        console.log('[CUA] HTML report saved to:', htmlPath);
      } catch (err) {
        console.error('[CUA] HTML report failed:', err.message);
      }
    }

    console.log('\n════════════════════════════════════════');
    console.log('  Luna Agent QC Report (CUA Mode)');
    console.log('════════════════════════════════════════');
    console.log('  URL:          ', config.url);
    console.log('  Rounds:       ', cuaResult.totalRounds + '/' + config.rounds);
    const exitReasonLabel = {
      'max_rounds': 'max_rounds',
      'stuck': 'stuck (卡死)',
      'ai_done': 'ai_done (AI判定完成)',
      'cta_terminal': 'cta_terminal ✅ (到达CTA终局，测试正常结束)'
    };
    console.log('  Exit reason:  ', exitReasonLabel[cuaResult.exitReason] || cuaResult.exitReason);
    console.log('  Passed:       ', report.summary.passed ? '✅ YES' : '❌ NO');
    console.log('  Bugs (AI):    ', cuaResult.allBugs.length);
    console.log('  Bugs (Rules): ', cuaResult.allAnomalies.length);
    console.log('════════════════════════════════════════');

    if (cuaResult.allBugs.length > 0) {
      console.log('\n🐛 AI-detected bugs:');
      cuaResult.allBugs.forEach(b => console.log('  [Round ' + b.round + '] ' + b.description));
    }

    // 分镜覆盖度汇总
    if (cuaResult.scriptCoverage && cuaResult.scriptCoverage.length > 0) {
      const sc = cuaResult.scriptCoverage;
      const covered = sc.filter(s => s.covered).length;
      console.log('\n📋 分镜覆盖度: ' + covered + '/' + sc.length + ' (' + Math.round(covered / sc.length * 100) + '%)');
      sc.forEach((s, i) => {
        const status = s.covered ? '✅' : '❌';
        console.log('  ' + status + ' #' + (i + 1) + ' ' + s.step.substring(0, 80));
        if (s.evidence) console.log('     ' + s.evidence);
      });
    }

    // 风格差异汇总
    if (cuaResult.hasRefImages) {
      const styleBugs = cuaResult.allBugs.filter(b => b.source === 'style');
      if (styleBugs.length > 0) {
        console.log('\n🎨 参考图风格差异: ' + styleBugs.length + ' 条');
        styleBugs.forEach(b => console.log('  ' + b.description));
      } else {
        console.log('\n🎨 参考图对比: 未发现明显风格差异');
      }
    }

    // 反馈验收汇总
    if (cuaResult.isFeedbackMode && cuaResult.feedbackVerification) {
      const fv = cuaResult.feedbackVerification;
      const fixed = fv.filter(v => v.fixed === true).length;
      const still = fv.filter(v => v.fixed === false).length;
      const unchecked = fv.filter(v => v.fixed === null).length;

      console.log('\n🔄 反馈验收结果:');
      console.log('  已修复: ' + fixed + '/' + fv.length);
      console.log('  仍存在: ' + still + '/' + fv.length);
      if (unchecked > 0) console.log('  未验证: ' + unchecked + '/' + fv.length);
      console.log('');
      fv.forEach((v, i) => {
        const status = v.fixed === true ? '✅' : v.fixed === false ? '❌' : '❓';
        console.log('  ' + status + ' #' + (i + 1) + ' ' + v.item.substring(0, 80));
        if (v.evidence) console.log('     ' + v.evidence);
      });
    }

    // ─── 录屏保存 ───
    const videoPath = await page.video().path();
    await page.close();
    await context.close();

    // 移动视频到输出目录并命名
    let finalVideoPath = null;
    if (videoPath && fs.existsSync(videoPath)) {
      finalVideoPath = config.output
        ? config.output.replace(/\.json$/i, '.webm')
        : path.join(outputDir, 'cua-recording.webm');
      try {
        fs.copyFileSync(videoPath, finalVideoPath);
        console.log('[Luna Agent] Recording saved:', finalVideoPath);
      } catch (e) {
        console.error('[Luna Agent] Failed to save recording:', e.message);
        finalVideoPath = videoPath; // fallback to original
      }
    }

    // [REMOVED] ffmpeg 视频压缩 — 仅 Gemini 需要，已移除

    // [REMOVED] Gemini Phase 2 视频审核 — CUA 是唯一验证方式

    await browser.close();
    console.log('\n[Luna Agent] Done (CUA mode).');
    return;
  }

  // ─── Chat 模式 AI 决策循环 ───
  const history = [];
  const allBugs = [];
  const allAnomalies = [];
  let stuckCount = 0;
  let prevObjectCount = 0;
  let exitReason = 'max_rounds';

  console.log('[Luna Agent] Starting AI loop...\n');

  for (let round = 0; round < config.rounds; round++) {
    // 1. 获取快照
    let snapshot;
    try {
      snapshot = await page.evaluate(function () {
        return __lunaSnapshot.compactSnapshot();
      });
      // FPS 不给 AI 看（无论 headless 还是真机，FPS 不作为检测项）
      delete snapshot.fps;
    } catch (err) {
      console.error('[Round ' + (round + 1) + '] Snapshot failed:', err.message);
      snapshot = { objects: '(error)', ui: '', fps: -1, objectCount: 0, errors: ['snapshot_failed'], diff: 'error', _raw: {} };
    }

    // 2. 每轮都截图（用于报告和 AI 视觉辅助）
    let screenshotB64 = null;
    let screenshotFilename = null;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
      screenshotB64 = buf.toString('base64');
      // 保存截图文件
      if (config.output) {
        const screenshotDir = path.join(path.dirname(config.output), 'screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        screenshotFilename = 'round_' + String(round + 1).padStart(2, '0') + '.jpg';
        fs.writeFileSync(path.join(screenshotDir, screenshotFilename), buf);
      }
    } catch (err) {
      console.error('[Round ' + (round + 1) + '] Screenshot failed');
    }

    // 3. 卡死检测
    if (snapshot._raw && snapshot._raw.diff) {
      const diff = snapshot._raw.diff;
      if ((!diff.moved || diff.moved.length === 0) &&
          (!diff.stateChanged || diff.stateChanged.length === 0)) {
        stuckCount++;
      } else {
        stuckCount = 0;
      }
    }

    // 4. 规则引擎异常检测
    const anomalies = detectAnomalies(snapshot, {
      round: round,
      stuckCount: stuckCount,
      prevObjectCount: prevObjectCount
    });
    if (anomalies.length > 0) {
      allAnomalies.push(...anomalies.map(a => ({ ...a, round })));
    }
    prevObjectCount = snapshot.objectCount || 0;

    // 5. AI 决策
    const prompt = buildPrompt(snapshot, anomalies, history, round, config.rounds, !!screenshotB64);
    const decision = config.model === 'gpt'
      ? await callGPT(openaiClient, prompt, screenshotB64)
      : await callClaude(anthropicClient, prompt, screenshotB64);

    // 日志
    const actionSummary = (decision.actions || []).map(a =>
      a.type + (a.object ? ':' + a.object : '')
    ).join(', ');
    console.log(`[Round ${round + 1}/${config.rounds}] ${decision.thinking || ''}`);
    console.log(`  Actions: ${actionSummary || 'none'}`);
    if (decision.bugs && decision.bugs.length > 0) {
      console.log(`  🐛 Bugs: ${decision.bugs.join('; ')}`);
    }
    if (anomalies.length > 0) {
      console.log(`  ⚠️ Anomalies: ${anomalies.map(a => a.desc).join('; ')}`);
    }

    // 记录
    history.push({
      round: round,
      actions: decision.actions || [],
      thinking: decision.thinking,
      bugs: decision.bugs || [],
      screenshot: screenshotFilename
    });

    if (decision.bugs && decision.bugs.length > 0) {
      // 实时去重：同样的 bug 只记一次
      for (const b of decision.bugs) {
        const key = b.replace(/\d+/g, 'N').replace(/\(.*?\)/g, '').substring(0, 50);
        const isDup = allBugs.some(existing => {
          const ek = existing.description.replace(/\d+/g, 'N').replace(/\(.*?\)/g, '').substring(0, 50);
          return ek === key;
        });
        if (!isDup) {
          allBugs.push({ round, description: b });
        }
      }
    }

    // 6. 执行操作（使用 Playwright 原生事件，确保 isTrusted=true）
    if (decision.actions && decision.actions.length > 0) {
      try {
        for (const action of decision.actions) {
          await executeAction(page, action, config.verbose);
        }
      } catch (err) {
        console.error('  Exec failed:', err.message);
      }
    }

    // 6.5 卡死恢复：连续 2 轮无变化时，撒网点击覆盖全屏
    if (stuckCount >= 2 && stuckCount <= 4) {
      console.log('  🔄 卡死恢复：撒网点击全屏...');
      const scatterPoints = [
        [200,150],[400,150],[600,150],
        [200,300],[400,300],[600,300],
        [200,450],[400,450],[600,450],
        [350,280],[450,320],[700,560],
      ];
      // 每次卡死用不同的点击顺序
      const offset = (stuckCount - 2) * 4;
      for (let si = 0; si < 4; si++) {
        const pt = scatterPoints[(offset + si) % scatterPoints.length];
        await page.mouse.click(pt[0], pt[1]);
        await page.waitForTimeout(300);
      }
      // 也试一次拖拽
      await page.mouse.move(350, 280);
      await page.mouse.down();
      for (let di = 1; di <= 10; di++) {
        await page.mouse.move(350 + 10*di, 280 + 4*di);
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
      await page.waitForTimeout(500);
    }

    // 7. 等待
    await page.waitForTimeout(decision.waitMs || 500);

    // 8. 终止检查
    if (decision.done) {
      exitReason = 'ai_done';
      console.log('\n[Luna Agent] AI decided to stop: ' + (decision.thinking || ''));
      break;
    }

    if (stuckCount >= 5) {
      exitReason = 'stuck';
      console.log('\n[Luna Agent] Stopping: game appears stuck for 5 rounds');
      break;
    }
  }

  // ─── 最终截图 ───
  let finalScreenshot = null;
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
    finalScreenshot = buf.toString('base64');
  } catch (err) { /* 忽略 */ }

  // ─── 生成报告 ───
  const report = {
    url: config.url,
    timestamp: new Date().toISOString(),
    exitReason: exitReason,
    totalRounds: history.length,
    maxRounds: config.rounds,
    bugs: {
      fromAI: allBugs,
      fromRules: allAnomalies,
      total: allBugs.length + allAnomalies.length
    },
    summary: {
      passed: allBugs.length === 0 && allAnomalies.filter(a => a.severity === 'high').length === 0,
      highSeverity: allAnomalies.filter(a => a.severity === 'high').length,
      mediumSeverity: allAnomalies.filter(a => a.severity === 'medium').length,
      aiBugs: allBugs.length,
      stuckRounds: stuckCount
    },
    history: history.map(h => ({
      round: h.round,
      actions: h.actions.map(a => a.type + (a.object ? ':' + a.object : '')),
      bugs: h.bugs
    })),
    finalScreenshot: finalScreenshot ? '(base64, ' + finalScreenshot.length + ' chars)' : null
  };

  // ─── 输出 ───
  if (config.output) {
    // 保存 JSON 报告
    const fullReport = { ...report };
    if (finalScreenshot) {
      fullReport.finalScreenshot = finalScreenshot;
    }
    fs.writeFileSync(config.output, JSON.stringify(fullReport, null, 2));
    console.log('\n[Luna Agent] JSON report saved to:', config.output);

    // 生成 HTML 报告（PlayCheck 标准，内嵌截图）
    try {
      const { generateHtmlReport } = require('./luna-reporter');
      const screenshotDir = path.join(path.dirname(config.output), 'screenshots');
      const html = generateHtmlReport(report, screenshotDir);
      const htmlPath = config.output.replace(/\.json$/i, '.html');
      fs.writeFileSync(htmlPath, html, 'utf-8');
      console.log('[Luna Agent] HTML report saved to:', htmlPath);
    } catch (err) {
      console.error('[Luna Agent] HTML report generation failed:', err.message);
    }
  }

  console.log('\n════════════════════════════════════════');
  console.log('  Luna Agent QC Report');
  console.log('════════════════════════════════════════');
  console.log('  URL:          ', config.url);
  console.log('  Rounds:       ', history.length + '/' + config.rounds);
  console.log('  Exit reason:  ', exitReason);
  console.log('  Passed:       ', report.summary.passed ? '✅ YES' : '❌ NO');
  console.log('  Bugs (AI):    ', allBugs.length);
  console.log('  Bugs (Rules): ', allAnomalies.length);
  console.log('  High severity:', report.summary.highSeverity);
  console.log('════════════════════════════════════════');

  if (allBugs.length > 0) {
    console.log('\n🐛 AI-detected bugs:');
    allBugs.forEach(function (b) {
      console.log('  [Round ' + b.round + '] ' + b.description);
    });
  }
  if (allAnomalies.length > 0) {
    console.log('\n⚠️ Rule-detected anomalies:');
    allAnomalies.forEach(function (a) {
      console.log('  [Round ' + a.round + '] [' + a.severity + '] ' + a.desc);
    });
  }

  await browser.close();
  console.log('\n[Luna Agent] Done.');
}

// 全局错误兜底（后台模式下确保错误写入日志）
process.on('unhandledRejection', (reason) => {
  console.error('[Luna Agent] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Luna Agent] Uncaught exception:', err.message, err.stack);
  process.exit(1);
});

main().catch(function (err) {
  console.error('[Luna Agent] Fatal error:', err);
  process.exit(1);
});
