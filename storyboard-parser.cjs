// Storyboard Parser — GPT-5.4 (primary) + Gemini (fallback)

/**
 * Storyboard Parser — GPT-5.4 primary, Gemini fallback
 * Phase 1: GPT-5.4 (best quality)
 * Phase 2: Gemini 3.1 Pro (fallback)
 * Phase 3: Gemini 2.5 Flash (fast fallback)
 * Phase 4: Gemini 2.5 Flash + resize (last resort)
 */
const fs = require('fs');
const path = require('path');

// === Proxy: ECS needs proxy to reach Google API ===
const PROXY_URL = 'http://127.0.0.1:7890';
process.env.HTTPS_PROXY = PROXY_URL;
process.env.HTTP_PROXY = PROXY_URL;
process.env.NO_PROXY = 'localhost,127.0.0.1,120.55.70.226';

// Node.js v24 built-in fetch reads HTTPS_PROXY env var automatically.
// But @google/genai SDK uses its own fetch that may not. Force undici proxy.
try {
  const undici = require('undici');
  // Use EnvHttpProxyAgent which auto-reads env vars and handles connection lifecycle
  const agent = new undici.EnvHttpProxyAgent({
    httpProxy: PROXY_URL,
    httpsProxy: PROXY_URL,
    noProxy: 'localhost,127.0.0.1,120.55.70.226',
  });
  undici.setGlobalDispatcher(agent);
  // Override globalThis.fetch for @google/genai SDK
  const origNodeFetch = globalThis.fetch; // Save original Node.js fetch for OpenAI SDK
  globalThis.fetch = function(url, init) {
    return undici.fetch(url, { ...init, dispatcher: agent });
  };
  globalThis._origNodeFetch = origNodeFetch; // Expose for OpenAI file uploads
  console.log('[StoryboardParser] Proxy configured via EnvHttpProxyAgent: ' + PROXY_URL);
} catch(e) {
  console.warn('[StoryboardParser] Proxy setup failed:', e.message);
}

const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai').default || require('openai');

// === OpenAI (GPT-5.4) setup ===
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
let openaiClient = null;
let openaiFileClient = null; // Separate client for file uploads (no custom fetch)
if (OPENAI_API_KEY) {
  // Create OpenAI client with fresh ProxyAgent per-request to avoid stale connections
  const undiciMod = require('undici');
  function makeOpenAIFetch(url, init) {
    const pa = new undiciMod.ProxyAgent(PROXY_URL);
    return undiciMod.fetch(url, { ...init, dispatcher: pa });
  }
  openaiClient = new OpenAI({
    apiKey: OPENAI_API_KEY,
    fetch: makeOpenAIFetch,
  });
  openaiFileClient = null; // Will use curl for file uploads
  console.log('[StoryboardParser] OpenAI configured, key prefix:', OPENAI_API_KEY.substring(0, 15) + '...');
} else {
  console.warn('[StoryboardParser] No OPENAI_API_KEY — GPT-5.4 unavailable, will use Gemini only');
}

// [key-rotation] Round-robin Gemini API key pool
const _geminiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').filter(Boolean);
let _geminiKeyIndex = 0;
function getNextGeminiKey() {
  if (_geminiKeys.length === 0) return '';
  const key = _geminiKeys[_geminiKeyIndex % _geminiKeys.length];
  _geminiKeyIndex++;
  return key;
}
function getAllGeminiKeys() { return _geminiKeys; }
console.log('[key-rotation] Loaded ' + _geminiKeys.length + ' Gemini API keys');
const CONFIG = {
  apiKey: getNextGeminiKey(),
  textModel: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview',
  imageModel: 'gemini-3-pro-image-preview',
};
console.log('[StoryboardParser] API Key prefix:', CONFIG.apiKey ? CONFIG.apiKey.substring(0, 15) + '...' : 'EMPTY');

// [key-pool] Create one GoogleGenAI instance per key for round-robin
const aiPool = _geminiKeys.map(k => new GoogleGenAI({ apiKey: k }));
let _keyIndex = 0;
function getAI() {
  if (aiPool.length === 0) throw new Error('No Gemini API keys configured');
  const inst = aiPool[_keyIndex % aiPool.length];
  _keyIndex++;
  return inst;
}
const ai = new GoogleGenAI({ apiKey: CONFIG.apiKey });

// === Document extraction ===

async function extractDocText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.csv') return fs.readFileSync(filePath, 'utf8');

  if (ext === '.doc' || ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === '.pdf') {
    // PDF will be sent directly to Gemini as inline data (native PDF support)
    return null; // signal caller to use PDF inline
  }

  if (ext === '.xls' || ext === '.xlsx') {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath);
    const lines = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (workbook.SheetNames.length > 1) lines.push(`\n## ${sheetName}\n`);
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      for (const row of rows) {
        const cells = row.map(c => String(c).trim()).filter(Boolean);
        if (cells.length > 0) lines.push(cells.join(' | '));
      }
    }
    return lines.join('\n');
  }

  throw new Error(`不支持的文件格式: ${ext}`);
}

// === Image reading ===

function readImagePart(imagePath) {
  const data = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  };
  return { inlineData: { data: data.toString('base64'), mimeType: mimeMap[ext] || 'image/jpeg' } };
}

function readImagePartFromBuffer(buffer, mimeType) {
  return { inlineData: { data: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' } };
}

// === Core parse function ===

async function parseScript(text, opts = {}) {
  const { orientation = 'landscape', cameraAngle = 'isometric-45', perspective = 'third-person', images = [], docPath, style = '', targetFrames = 15, charRefImage = null } = opts;

  const cameraMap = {
    'isometric-45': 'isometric 45-degree orthographic camera',
    'side-scroll': 'side-scrolling 2D camera view',
    'top-down': 'top-down overhead camera view',
    '3/4-view': '3/4 perspective angled camera view',
    'topdown45': 'top-down oblique 45-degree orthographic camera (bird\'s-eye view tilted at 45°, no perspective distortion)',
  };
  const cameraDesc = cameraMap[cameraAngle] || cameraAngle;
  const perspectiveRule = perspective === 'first-person'
    ? '可以使用第一人称视角'
    : perspective === 'mixed'
    ? '根据分镜需要灵活选择第一人称或第三人称'
    : '绝对禁止第一人称视角，始终使用第三人称';

  let docText = '';
  let pdfPart = null;
  let pdfOriginalPath = null; // Keep original PDF path for GPT-5.4
  if (docPath) {
    const docExt = path.extname(docPath).toLowerCase();
    if (docExt === '.pdf') {
      // PDF: save path for GPT-5.4, then try Gemini Files API upload (non-blocking)
      pdfOriginalPath = docPath;
      try {
        console.log(`[StoryboardParser] Uploading PDF via Gemini Files API...`);
        const uploaded = await ai.files.upload({ file: docPath, config: { mimeType: 'application/pdf' } });
        let file = uploaded;
        while (file.state === 'PROCESSING') {
          await new Promise(r => setTimeout(r, 2000));
          file = await ai.files.get({ name: file.name });
        }
        if (file.state !== 'ACTIVE') throw new Error(`PDF upload state: ${file.state}`);
        pdfPart = { fileData: { fileUri: file.uri, mimeType: 'application/pdf' } };
        console.log(`[StoryboardParser] PDF uploaded to Gemini: ${file.uri}`);
      } catch(geminiUploadErr) {
        console.warn(`[StoryboardParser] Gemini PDF upload failed (will use GPT-5.4 directly): ${geminiUploadErr.message?.substring(0, 100)}`);
        // pdfPart stays null — Gemini phases will be skipped if no pdfPart, but GPT-5.4 uses pdfOriginalPath
      }
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(docExt)) {
      // Image: send as inline data to Gemini for visual understanding
      pdfPart = readImagePart(docPath);
      console.log(`[StoryboardParser] 图片文档已读取: ${docPath}`);
    } else {
      docText = await extractDocText(docPath);
      console.log(`[StoryboardParser] 从文档提取了 ${docText.length} 字`);
    }
  }

  const fullText = [text, docText].filter(Boolean).join('\n\n');

  const systemPrompt = `你是一个资深试玩广告分镜专家。请根据需求拆分为**带章节的详细分镜**。

## 角色一致性（最重要！）
你必须在输出的第一帧之前，先定义一个 characterSheet 对象，描述主角和关键角色的固定外观特征（服装颜色、发型、体型、武器、标志性元素）。之后每一帧的 prompt 都必须引用这些角色描述，确保全部帧中角色外观完全一致。

## 输出格式
输出一个 JSON 对象，包含两个字段：
- characterSheet: 对象，key 为角色名，value 为英文外观描述（50-80词，固定不变）
- frames: 帧数组

每个大场景（章节）下拆 3-5 个子步骤，描述进入→操作→反馈→过渡的完整流程。

每帧输出 JSON 对象：
- id: 全局帧序号（从1开始，连续编号）
- chapter: 章节号（大场景编号）
- chapterTitle: 章节标题
- step: 章节内子步骤号
- prompt: 英文画面描述（给 AI 出图用）。**必须遵守以下规则：**
  - **角色描述**：每帧 prompt 开头必须引用 characterSheet 中的角色外观描述，逐字重复角色服装、发型、体型等关键特征，确保 AI 画出一致的角色形象
  - 视角：高空远景，使用 ${cameraDesc}，镜头拉高拉远，必须能看到整体地图/场景的全貌布局
  - ${perspectiveRule}
  - 画面内容要极其详细（至少 150 英文单词）：
    * 精确描述每个角色的位置（用屏幕坐标如 center, top-left, bottom-right）、姿态、朝向、大小比例
    * 场景元素要全部列出：地形、建筑、道具、障碍物、装饰物的位置和状态，每个元素的大小、颜色、材质
    * 环境氛围：光源方向、色调、天气、时间段，雪花/烟雾/火光等粒子效果
  - UI overlay 标注必须包含：箭头方向和起止点、手指图标位置和手势类型（tap/drag/swipe）、高亮区域范围、按钮的文字和位置
- title: 中文标题（动词·结果 格式，如"拖动木材 · 点燃篝火"）
- scene: 中文场景描述（**至少 80 字**，对应"玩家看到什么"）。必须详细到：
  - 整体场景布局：地形、背景、主要建筑/物体的位置关系
  - 主角和NPC的位置、姿态、外观状态（大小、朝向）
  - 关键道具/物体的状态（颜色、大小、是否发光/动画）
  - 视觉层次：前景、中景、远景各有什么
  - 光照/氛围：色调、光源、天气、粒子效果
  - 与上一帧的视觉变化：新增了什么、消失了什么、变化了什么
- interaction: 中文交互指引（**至少 100 字**）。必须详细到：
  - 完整的操作步骤分解：第一步做什么→第二步做什么→触发什么结果
  - 玩家手势：点击/长按/拖拽/滑动，在屏幕哪个精确区域（如"从屏幕底部中央的木材图标拖拽到画面中央偏上的火堆位置"）
  - 即时反馈：操作成功/失败的视觉反馈（特效颜色、大小）、音效描述、震动反馈
  - 数值变化：具体数字变化（如"木材数量 10→0，篝火等级 Lv1→Lv2"）
  - 衔接逻辑：上一步的结果如何触发本步骤，本步骤完成后如何过渡到下一步
- ui: 中文 UI 说明（**至少 80 字**）。详细描述：
  - 全部可见的 UI 元素清单及其精确像素位置
  - 每个 UI 元素的当前状态和数值
  - 本帧新出现/消失/变化的 UI 元素，变化前后的对比
  - 引导性 UI：箭头、高亮圈、手指动画的出现时机和位置
- timing: 持续时间（如"自动播放 1.5s"、"玩家操作，预计 3-5s"、"过渡动画 2s"）
- camera: 相机指令（如"固定高空正交45°全景"、"从全景缓慢推进到角色特写，2s"、"跟随角色从右侧小屋平移到中央火堆"）
- scriptExcerpt: 原脚本对应文案（从输入文档中摘录与该帧对应的原始段落，保留原文不改写，方便用户对照。如果输入没有明确对应段落，留空字符串）
- animation: 动画说明（**至少 60 字**），详细描述：
  - 每个运动元素的起点→终点→运动曲线（线性/缓入缓出/弹跳）
  - 出场/退场动画类型和时长
  - 粒子特效（类型、颜色、数量、持续时间）
  - 与下一帧的过渡方式（硬切/淡入淡出/滑动/缩放）

要求：
1. 总帧数严格控制在 ${targetFrames - 1} 到 ${targetFrames + 1} 帧（目标 ${targetFrames} 帧），绝对不能超出此范围
2. 根据总帧数目标合理分配每章节的子步骤数（总帧数 / 章节数 = 每章步骤数）
3. 帧之间要有明确的叙事递进和过渡
4. prompt 中必须包含 UI 标注元素的描述
5. 适配 ${orientation === 'portrait' ? '竖屏（手机竖握）' : '横屏（手机横握）'} 布局
6. **每帧描述必须极其详细**，interaction 至少 100 字，ui 至少 80 字，animation 至少 60 字。要让读者仅凭文字就能完全还原画面
7. 视角统一使用 ${cameraDesc}，${perspectiveRule}
8. **角色一致性是最高优先级**：每帧 prompt 必须重复角色外观描述
${style ? `9. 额外风格要求：${style}` : ''}

只输出 JSON 数组，不要其他内容。`;

  // Build multimodal parts
  const parts = [];

  // images can be file paths OR {inlineData} objects (from multer buffers)
  if (images.length > 0) {
    for (const img of images) {
      if (typeof img === 'string') {
        if (fs.existsSync(img)) {
          parts.push(readImagePart(img));
        }
      } else if (img.inlineData) {
        parts.push(img);
      }
    }
  }

  // Add character reference image if provided
  if (charRefImage && charRefImage.inlineData) {
    parts.push(charRefImage);
    parts.push({ text: '上面是角色参考图。分镜中的主角必须完全基于这张图的外观来描述（服装、发型、体型、颜色等）。characterSheet 中的描述必须精确匹配此参考图中的角色形象。' });
  }

  // Pre-analyze images if present
  let imageAnalysis = '';
  if (images.length > 0) {
    const imgParts = [];
    for (const img of images) {
      if (typeof img === 'string') {
        if (fs.existsSync(img)) imgParts.push(readImagePart(img));
      } else if (img.inlineData) {
        imgParts.push(img);
      }
    }
    if (imgParts.length > 0) {
      imageAnalysis = await analyzeImages(imgParts);
    }
  }

  if (pdfPart) {
    parts.push(pdfPart);
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}\n\n请参考以上图片分析结果，在生成分镜时融入图片中的风格、场景元素和 UI 设计。` : '';
    const extraText = text ? `\n\n补充说明：${text}` : '';
    parts.push({ text: `请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。${extraText}${analysisContext}` });
  } else if (pdfOriginalPath) {
    // Gemini upload failed but we have the PDF file — GPT-5.4 will handle it via file_id
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}` : '';
    const extraText = text ? `\n\n补充说明：${text}` : '';
    parts.push({ text: `请解析 PDF 文档内容，设计试玩广告分镜板。${extraText}${analysisContext}` });
    console.log('[StoryboardParser] PDF available for GPT-5.4 only (Gemini upload failed)');
  } else if (fullText) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}\n\n请参考以上图片分析结果，在生成分镜时融入图片中的风格、场景元素和 UI 设计。` : '';
    parts.push({ text: `文案/需求：\n${fullText}${analysisContext}` });
  } else if (images.length > 0) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}` : '';
    parts.push({ text: `请根据这些参考图片，设计一个试玩广告的分镜板。推断游戏类型、核心玩法，设计合理的交互流程。${analysisContext}` });
  } else {
    throw new Error('请提供文案、图片或文档中的至少一种作为输入');
  }

  // === Degradation chain: GPT-5.4 → Gemini Pro → Gemini Flash → Flash+resize ===
  const proxyDoctor = require('./proxy-doctor.cjs');
  const notify = require('./notify.cjs');

  // Helper: try GPT-5.4 with PDF/images, 2 attempts
  async function tryGPT(partsToUse, label) {
    if (!openaiClient) throw new Error('OpenAI not configured');

    const preCheck = await proxyDoctor.quickCheck();
    if (!preCheck.ok) {
      const repaired = await proxyDoctor.ensure();
      if (!repaired.ok) throw new Error('代理不可用: ' + (repaired.error || 'repair failed'));
      console.log('[StoryboardParser] Pre-flight: proxy recovered via ' + (repaired.method || '?'));
    }

    // Convert parts to OpenAI messages format
    const contentParts = [];
    for (const p of partsToUse) {
      if (p.text) {
        contentParts.push({ type: 'text', text: p.text });
      } else if (p.inlineData && p.inlineData.data) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${p.inlineData.mimeType || 'image/jpeg'};base64,${p.inlineData.data}` }
        });
      } else if (p.fileData && p.fileData.fileUri) {
        // Files API URI — need to download and convert to base64, or use PDF text
        // For PDF uploaded to Gemini Files API, we need to read original file
        contentParts.push({ type: 'text', text: '[PDF document provided — see file content below]' });
      }
    }

    // If we have the original PDF path, upload to OpenAI Files API
    if (pdfOriginalPath && fs.existsSync(pdfOriginalPath)) {
      let uploaded = false;
      // Method 1: Upload via OpenAI Files API using separate client (no proxy needed for upload)
      if (openaiFileClient) {
        try {
          console.log('[StoryboardParser] Uploading PDF to OpenAI Files API...');
          const fileStream = fs.createReadStream(pdfOriginalPath);
          const uploadedFile = await openaiFileClient.files.create({
            file: fileStream,
            purpose: 'assistants',
          });
          console.log('[StoryboardParser] PDF uploaded to OpenAI: ' + uploadedFile.id);
          contentParts.unshift({
            type: 'file',
            file: { file_id: uploadedFile.id }
          });
          uploaded = true;
        } catch(uploadErr) {
          console.error('[StoryboardParser] OpenAI Files API upload failed: ' + uploadErr.message?.substring(0, 150));
        }
      }
      // Method 2: Use curl to upload (bypasses fetch issues)
      if (!uploaded) {
        try {
          console.log('[StoryboardParser] Uploading PDF via curl...');
          const { execSync } = require('child_process');
          const curlResult = execSync(
            `curl -s -x ${PROXY_URL} --max-time 60 https://api.openai.com/v1/files -H "Authorization: Bearer ${OPENAI_API_KEY}" -F "purpose=assistants" -F "file=@${pdfOriginalPath}"`,
            { encoding: 'utf8' }
          );
          const parsed = JSON.parse(curlResult);
          if (parsed.id) {
            console.log('[StoryboardParser] PDF uploaded via curl: ' + parsed.id);
            contentParts.unshift({ type: 'file', file: { file_id: parsed.id } });
            uploaded = true;
          }
        } catch(curlErr) {
          console.error('[StoryboardParser] curl upload also failed: ' + curlErr.message?.substring(0, 100));
        }
      }
      // Remove placeholder
      if (uploaded) {
        const placeholderIdx = contentParts.findIndex(p => p.type === 'text' && p.text.includes('[PDF document provided'));
        if (placeholderIdx >= 0) contentParts.splice(placeholderIdx, 1);
      }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[StoryboardParser] ${label} (attempt ${attempt}/2)...`);
        // Use Python openai SDK for stable streaming (replaces curl hack)
        const { exec: execAsync } = require('child_process');
        const tmpPromptFile = '/tmp/gpt54-prompt-' + Date.now() + '.txt';
        fs.writeFileSync(tmpPromptFile, systemPrompt, 'utf8');
        
        // Build Python command args
        const pyScript = '/opt/blueprint-editor/python/storyboard_parser.py';
        let pyArgs = `--system-prompt-file ${tmpPromptFile} --max-tokens 65536 --raw-output /tmp/gpt54-raw-output.txt`;
        
        // Determine input: PDF file or file_id
        if (pdfOriginalPath && fs.existsSync(pdfOriginalPath)) {
          pyArgs += ` --pdf ${pdfOriginalPath}`;
        } else if (openaiFileId) {
          pyArgs += ` --file-id ${openaiFileId}`;
        }
        
        // Add extra user text if any
        const userText = contentParts.find(p => p.type === 'text')?.text || '';
        if (userText) {
          const tmpUserFile = '/tmp/gpt54-user-' + Date.now() + '.txt';
          fs.writeFileSync(tmpUserFile, userText, 'utf8');
          pyArgs += ` --user-text "$(cat ${tmpUserFile})"`;
        }

        const startMs = Date.now();
        const pyOutput = await new Promise((resolve, reject) => {
          execAsync(
            `python3.8 ${pyScript} ${pyArgs}`,
            { timeout: 600000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, OPENAI_API_KEY } },
            (err, stdout, stderr) => {
              try { fs.unlinkSync(tmpPromptFile); } catch(e) {}
              if (stderr) console.log('[StoryboardParser] Python stderr: ' + stderr.substring(0, 500));
              if (err && !stdout) {
                return reject(new Error('Python parser failed: ' + (err.message || '').substring(0, 200)));
              }
              resolve(stdout);
            }
          );
        });
        
        const elapsed = Date.now() - startMs;
        const result = JSON.parse(pyOutput);
        
        if (result.error) {
          throw new Error('GPT-5.4 parse error: ' + result.error);
        }
        
        const data = result.data;
        const meta = result.meta || {};
        const text = JSON.stringify(data);
        
        console.log(`[StoryboardParser] ${label} returned ${text.length} chars in ${(elapsed/1000).toFixed(1)}s, finish=${meta.finish_reason}, parser=python`);
        return { text };
      } catch (err) {
        console.error(`[StoryboardParser] ${label} attempt ${attempt} failed: ${err.message?.substring(0, 150)}`);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }
  }

  // Helper: try calling Gemini with given config, 2 attempts
  async function tryGemini(model, partsToUse, thinkingBudget, label) {
    // Pre-flight: quick proxy check (2s) before wasting time on a dead proxy
    const preCheck = await proxyDoctor.quickCheck();
    if (!preCheck.ok) {
      console.warn('[StoryboardParser] Pre-flight: proxy down, attempting repair...');
      const repaired = await proxyDoctor.ensure();
      if (!repaired.ok) {
        throw new Error('代理不可用，请检查网络: ' + (repaired.error || 'repair failed'));
      }
      console.log('[StoryboardParser] Pre-flight: proxy recovered via ' + (repaired.method || '?'));
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[StoryboardParser] ${label} (attempt ${attempt}/2)...`);
        const cfg = {
          temperature: 0.3,
          maxOutputTokens: 65536,
          systemInstruction: systemPrompt,
        };
        if (thinkingBudget > 0) {
          cfg.thinkingConfig = { thinkingBudget };
        }
        // Add timeout to prevent hanging on slow/unresponsive models
        const timeoutMs = thinkingBudget > 0 ? 120000 : 90000;
        const result = await Promise.race([
          ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: partsToUse }],
            config: cfg,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout (' + timeoutMs/1000 + 's)')), timeoutMs))
        ]);
        return result;
      } catch (err) {
        console.error(`[StoryboardParser] ${label} attempt ${attempt} failed: ${err.message?.substring(0, 150)}`);
        if (attempt < 2) {
          // Before retry, ensure proxy is working
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw err;
        }
      }
    }
  }

  // Helper: resize images in parts to max 1024px JPEG 80%
  async function resizeParts(originalParts) {
    let sharp;
    try { sharp = require('sharp'); } catch(e) { return originalParts; /* no sharp, skip resize */ }
    const resized = [];
    for (const p of originalParts) {
      if (p.inlineData && p.inlineData.data) {
        try {
          const buf = Buffer.from(p.inlineData.data, 'base64');
          if (buf.length > 500 * 1024) { // Only resize if > 500KB
            const out = await sharp(buf).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
            resized.push({ inlineData: { data: out.toString('base64'), mimeType: 'image/jpeg' } });
            console.log(`[StoryboardParser] Resized image: ${buf.length} → ${out.length} bytes`);
          } else {
            resized.push(p);
          }
        } catch(e) {
          resized.push(p); // Keep original if resize fails
        }
      } else {
        resized.push(p);
      }
    }
    return resized;
  }

  // Phase 0: Pre-process all images — convert to JPEG, resize, then upload via Files API
  // gemini-3.1-pro-preview has issues with inlineData images, but works perfectly with Files API references
  const imgCount0 = parts.filter(p => p.inlineData && p.inlineData.data).length;
  console.log('[StoryboardParser] Phase0: ' + parts.length + ' parts total, ' + imgCount0 + ' with inlineData');
  let sharp0;
  try { sharp0 = require('sharp'); console.log('[StoryboardParser] Phase0: sharp loaded OK'); } catch(e0) { console.log('[StoryboardParser] Phase0: sharp NOT available: ' + e0.message); }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.inlineData && p.inlineData.data) {
      try {
        let buf = Buffer.from(p.inlineData.data, 'base64');
        let mimeType = 'image/jpeg';
        // Pre-process with sharp if available
        if (sharp0) {
          const meta = await sharp0(buf).metadata();
          const out = await sharp0(buf)
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 85 })
            .toBuffer();
          console.log('[StoryboardParser] Phase0 pre-process: ' + meta.format + ' ' + meta.width + 'x' + meta.height + ' (' + buf.length + 'B) -> JPEG (' + out.length + 'B)');
          buf = out;
        }
        // Upload via Files API to avoid inlineData issues with gemini-3.1-pro-preview
        const tmpPath = '/tmp/phase0_img_' + i + '_' + Date.now() + '.jpg';
        fs.writeFileSync(tmpPath, buf);
        const uploaded = await ai.files.upload({ file: tmpPath, config: { mimeType } });
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        parts[i] = { fileData: { fileUri: uploaded.uri, mimeType } };
        console.log('[StoryboardParser] Phase0 uploaded image ' + i + ' via Files API: ' + uploaded.uri);
      } catch(e0) {
        console.log('[StoryboardParser] Phase0 pre-process/upload FAILED, removing image from parts: ' + e0.message);
        parts.splice(i, 1);
        i--;
      }
    }
  }

  let result;

  // Phase 1: GPT-5.4 (primary — best quality for client delivery)
  if (openaiClient) {
    try {
      result = await tryGPT(parts, 'Phase1:GPT-5.4');
    } catch(phase1Err) {
      console.log('[StoryboardParser] Phase 1 (GPT-5.4) failed: ' + phase1Err.message?.substring(0, 100));
      notify.alert('warning', '分镜解析：GPT-5.4 失败，降级到 Gemini Pro', phase1Err.message?.substring(0, 100));
      result = null;
    }
  }

  // Phase 2: Gemini Pro (fallback)
  if (!result) {
    try {
      result = await tryGemini(CONFIG.textModel, parts, 1024, 'Phase2:' + CONFIG.textModel);
    } catch(phase2Err) {
      console.log('[StoryboardParser] Phase 2 (Gemini Pro) failed, trying flash...');
      notify.alert('warning', '分镜解析：Gemini Pro 失败，尝试 flash', phase2Err.message?.substring(0, 100));

      // Phase 3: Flash (fast fallback)
      try {
        result = await tryGemini('gemini-2.5-flash', parts, 0, 'Phase3:gemini-2.5-flash');
      } catch(phase3Err) {
        console.log('[StoryboardParser] Phase 3 (flash) failed, trying resize + flash...');
        notify.alert('warning', '分镜解析降级：缩图 + flash 重试', phase3Err.message?.substring(0, 100));

        // Phase 4: Resize + flash (last resort)
        try {
          const resizedParts = await resizeParts(parts);
          result = await tryGemini('gemini-2.5-flash', resizedParts, 0, 'Phase4:resize+gemini-2.5-flash');
        } catch(phase4Err) {
          notify.alert('critical', '分镜解析全部降级失败（GPT-5.4 → Pro → Flash → Flash+缩图）', phase4Err.message?.substring(0, 200));
          throw phase4Err;
        }
      }
    }
  }

  let rawText = result.text || '';
  // Extract JSON: try code block first, then find first [ or {
  let jsonStr;
  const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    // Find the first [ or { and match to the end
    const startIdx = rawText.search(/[\[{]/);
    if (startIdx >= 0) {
      jsonStr = rawText.substring(startIdx).trim();
      // Trim trailing non-JSON text after last ] or }
      const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
      if (lastBracket >= 0) jsonStr = jsonStr.substring(0, lastBracket + 1);
    } else {
      jsonStr = rawText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
    }
  }
  // Clean common Gemini artifacts: stray characters between JSON objects
  jsonStr = jsonStr.replace(/},\s*[a-zA-Z]\s*\{/g, '},{');
  // Remove trailing commas before ] or }
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1');
  console.log(`[StoryboardParser] JSON extraction: raw ${rawText.length} chars → json ${jsonStr.length} chars`);
  
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch(jsonErr) {
    console.error(`[StoryboardParser] JSON parse failed, attempting repair. Error: ${jsonErr.message.substring(0, 100)}`);
    let repaired = jsonStr;
    // Fix 1: Remove non-JSON content between objects
    repaired = repaired.replace(/}[\s\S]{1,5}?\{/g, (match) => {
      if (match.includes('"') || match.includes('[') || match.includes(']')) return match;
      return '},{';
    });
    try {
      parsed = JSON.parse(repaired);
      console.log('[StoryboardParser] JSON repair succeeded (fix 1)');
    } catch(e2) {
      // Fix 2: Truncated JSON (finish_reason=length) — close open brackets
      console.log('[StoryboardParser] Attempting truncated JSON repair...');
      // Find last complete object (ending with })
      const lastCompleteObj = repaired.lastIndexOf('}');
      if (lastCompleteObj > 0) {
        let truncated = repaired.substring(0, lastCompleteObj + 1);
        // Count open/close brackets to close properly
        const openBrackets = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length;
        const openBraces = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length;
        for (let b = 0; b < openBraces; b++) truncated += '}';
        for (let b = 0; b < openBrackets; b++) truncated += ']';
        // Remove trailing commas before closing
        truncated = truncated.replace(/,\s*([\]}])/g, '$1');
        try {
          parsed = JSON.parse(truncated);
          console.log('[StoryboardParser] Truncated JSON repair succeeded, recovered ' + truncated.length + ' chars');
        } catch(e3) {
          throw new Error('JSON repair failed after all attempts: ' + e3.message.substring(0, 100));
        }
      } else {
        throw jsonErr;
      }
    }
  }

  let frames, characterSheet = {};
  if (Array.isArray(parsed)) {
    // GPT-5.4 sometimes wraps {characterSheet, frames} in an outer array
    if (parsed.length === 1 && parsed[0].frames && Array.isArray(parsed[0].frames)) {
      frames = parsed[0].frames;
      characterSheet = parsed[0].characterSheet || {};
      console.log('[StoryboardParser] Unwrapped single-element array wrapper');
    } else {
      frames = parsed;
    }
  } else if (parsed.frames && Array.isArray(parsed.frames)) {
    frames = parsed.frames;
    characterSheet = parsed.characterSheet || {};
  } else {
    throw new Error('Gemini 返回格式不正确');
  }

  // Inject character descriptions
  for (const f of frames) {
    if (!f.id || !f.prompt || !f.title) {
      console.warn(`[StoryboardParser] Frame ${f.id || '?'} missing fields: id=${!!f.id} prompt=${!!f.prompt} title=${!!f.title} interaction=${!!f.interaction} ui=${!!f.ui}`);
      // Only throw if critical fields missing (id + prompt are essential for image gen)
      if (!f.id || !f.prompt) {
        throw new Error(`帧 ${f.id || '?'} 格式不完整（缺少 id 或 prompt）`);
      }
      // Fill optional missing fields with placeholders
      if (!f.title) f.title = `帧 ${f.id}`;
      if (!f.interaction) f.interaction = '';
      if (!f.ui) f.ui = '';
    }
    if (Object.keys(characterSheet).length > 0) {
      const charDesc = Object.entries(characterSheet).map(([name, desc]) => `${name}: ${desc}`).join('. ');
      if (!f.prompt.includes(charDesc.substring(0, 30))) {
        f.prompt = `[Character Reference] ${charDesc}. [Scene] ${f.prompt}`;
      }
    }
    f._characterSheet = characterSheet;
    f._cameraAngle = cameraAngle;
    f._perspective = perspective;
  }

  return { frames, characterSheet };
}


// === Image pre-analysis ===
async function analyzeImages(imageParts) {
  if (!imageParts || imageParts.length === 0) return '';
  
  const prompt = `请仔细分析以下${imageParts.length}张参考图片，对每张图片提取：
1. 场景描述：整体场景、环境、氛围
2. 图中文字/文案：所有可见的文字内容（按钮文字、标题、提示语等）
3. UI 元素：按钮、进度条、图标、面板等 UI 组件及其位置
4. 美术风格：色调、画风（卡通/写实/像素等）、渲染风格
5. 角色/物体：主要角色外观特征、关键道具和物体
6. 游戏类型推断：基于画面推断可能的游戏类型和玩法

请用中文详细描述，每张图片单独分析。输出纯文本，不要 JSON。`;

  // Upload inlineData images via Files API (gemini-3.1-pro-preview has issues with inlineData)
  const uploadedParts = [];
  for (let i = 0; i < imageParts.length; i++) {
    const p = imageParts[i];
    if (p.inlineData && p.inlineData.data) {
      try {
        const buf = Buffer.from(p.inlineData.data, 'base64');
        let outBuf = buf;
        let mimeType = 'image/jpeg';
        let sharp0;
        try { sharp0 = require('sharp'); } catch(e) {}
        if (sharp0) {
          outBuf = await sharp0(buf)
            .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 85 })
            .toBuffer();
        }
        const tmpPath = '/tmp/analyze_img_' + i + '_' + Date.now() + '.jpg';
        fs.writeFileSync(tmpPath, outBuf);
        const uploaded = await ai.files.upload({ file: tmpPath, config: { mimeType } });
        try { fs.unlinkSync(tmpPath); } catch(e) {}
        uploadedParts.push({ fileData: { fileUri: uploaded.uri, mimeType } });
        console.log('[StoryboardParser] analyzeImages: uploaded image ' + i + ' via Files API');
      } catch(e) {
        console.log('[StoryboardParser] analyzeImages: upload failed for image ' + i + ': ' + e.message);
      }
    } else if (p.fileData) {
      uploadedParts.push(p);
    }
  }

  if (uploadedParts.length === 0) return '';
  const parts = [...uploadedParts, { text: prompt }];
  
  try {
    const result = await Promise.race([
      ai.models.generateContent({
        model: CONFIG.textModel,
        contents: [{ role: 'user', parts }],
        config: { temperature: 0.2, thinkingConfig: { thinkingBudget: 1024 } },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Image analysis timeout (120s)')), 120000))
    ]);
    console.log('[StoryboardParser] Image analysis done, length=' + result.text.length);
    return result.text;
  } catch (err) {
    console.error('[StoryboardParser] Image analysis failed:', err.message);
    return '';
  }
}

// === Frame editing with AI ===
async function editFrame(frame, instruction) {
  const prompt = `你是分镜编辑助手。请根据用户的修改指令，修改下面这个分镜帧的内容。

当前帧数据：
\`\`\`json
${JSON.stringify(frame, null, 2)}
\`\`\`

用户修改指令：${instruction}

请输出修改后的完整帧 JSON。保持所有字段（id, title, interaction, ui, prompt 等），只修改用户要求改的部分。
其他未提及的字段保持不变。只输出 JSON，不要其他内容。`;

  const result = await ai.models.generateContent({
    model: CONFIG.textModel,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.3 },
  });

  const jsonStr = result.text.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`/g, '').trim();
  const newFrame = JSON.parse(jsonStr);
  // Preserve original id
  newFrame.id = frame.id;
  return newFrame;
}


// === Image Generation (Gemini native) ===
async function generateImage(prompt, opts = {}, aiInstance) {
  if (!aiInstance) aiInstance = aiPool[_keyIndex++ % aiPool.length];
  const { style = '', cameraAngle = '', orientation = '', perspective = '', styleRefBase64 = null, styleRefMime = null, charRefBase64 = null, charRefMime = null, prevImagePath = null } = opts;
  let fullPrompt = prompt;
  // Append camera/orientation hints if not already in prompt
  const cameraHints = [];
  if (cameraAngle && !prompt.toLowerCase().includes(cameraAngle.toLowerCase())) cameraHints.push('Camera: ' + cameraAngle);
  if (orientation && !prompt.toLowerCase().includes(orientation)) cameraHints.push('Orientation: ' + orientation);
  if (perspective && !prompt.toLowerCase().includes(perspective)) cameraHints.push('Perspective: ' + perspective + ' person');
  if (cameraHints.length) fullPrompt += '. ' + cameraHints.join(', ');
  if (style) fullPrompt += '. Style: ' + style;

  // Build parts: optional reference images + text prompt
  const parts = [];
  const prefixes = [];
  if (styleRefBase64) {
    parts.push({ inlineData: { data: styleRefBase64, mimeType: styleRefMime || 'image/jpeg' } });
    prefixes.push('Generate an image in EXACTLY the same art style, color palette, and rendering technique as the style reference image.');
  }
  if (charRefBase64) {
    parts.push({ inlineData: { data: charRefBase64, mimeType: charRefMime || 'image/jpeg' } });
    prefixes.push('The character in the image MUST look exactly like the character reference image — same face, hair, clothing, body proportions, and colors.');
  }
  if (prefixes.length) fullPrompt = prefixes.join(' ') + ' ' + fullPrompt;
  parts.push({ text: fullPrompt });

  // Use Python image_generator.py for gpt-image-1 with frame consistency
  const { exec: execAsync } = require('child_process');
  const tmpPromptFile = '/tmp/imggen-prompt-' + Date.now() + '.txt';
  const tmpOutFile = '/tmp/imggen-out-' + Date.now() + '.png';
  fs.writeFileSync(tmpPromptFile, fullPrompt.substring(0, 4000), 'utf8');
  const sizeStr = (orientation === 'portrait') ? '1024x1536' : '1536x1024';
  
  let pyArgs = `--prompt-file ${tmpPromptFile} --size ${sizeStr} --quality medium --output ${tmpOutFile}`;
  if (prevImagePath && fs.existsSync(prevImagePath)) {
    pyArgs += ` --prev-image ${prevImagePath}`;
    console.log('[generateImage] Using prev frame for consistency: ' + prevImagePath);
  }
  
  const pyResult = await new Promise((resolve, reject) => {
    const cmd = `python3.8 /opt/blueprint-editor/python/image_generator.py ${pyArgs}`;
    execAsync(cmd, { timeout: 180000, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, OPENAI_API_KEY } }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmpPromptFile); } catch(e) {}
      if (stderr) console.log('[generateImage] ' + stderr.trim().split('\n').slice(-2).join(' | '));
      if (err && !stdout) {
        return reject(new Error('gpt-image-1 failed: ' + (stderr || err.message || '').substring(0, 300)));
      }
      try {
        const result = JSON.parse(stdout);
        if (!result.success) return reject(new Error(result.error || 'Unknown error'));
        // Read the generated image as base64
        const imgBuf = fs.readFileSync(tmpOutFile);
        resolve({ base64: imgBuf.toString('base64'), mimeType: 'image/png', outputPath: tmpOutFile });
      } catch(e) {
        reject(new Error('Failed to parse image result: ' + e.message));
      }
    });
  });
  
  return { base64: pyResult.base64, mimeType: pyResult.mimeType || 'image/png', text: '', outputPath: pyResult.outputPath };
}

// Resize image buffer to target dimensions using sharp
async function normalizeImageSize(buffer, orientation) {
  const sharp = require('sharp');
  const targetW = orientation === 'portrait' ? 576 : 1024;
  const targetH = orientation === 'portrait' ? 1024 : 576;
  return sharp(buffer).resize(targetW, targetH, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
}

async function generateFrameImages(frames, outputDir, onProgress, { concurrency = 4 } = {}) {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const results = new Array(frames.length);
  let completed = 0;

  // Process frames with concurrency limit
  async function worker(startIdx) {
    for (let i = startIdx; i < frames.length; i += concurrency) {
      const frame = frames[i];
      try {
        const { base64, mimeType } = await generateImage(frame.prompt);
        const ext = mimeType.includes('png') ? '.png' : '.jpg';
        const filename = frame.id + ext;
        const filePath = path.join(outputDir, filename);
        fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
        results[i] = { id: frame.id, imagePath: filePath, filename };
        console.log('[StoryboardParser] Generated image for ' + frame.id);
      } catch (err) {
        console.error('[StoryboardParser] Image gen failed for ' + frame.id + ':', err.message);
        results[i] = { id: frame.id, imagePath: null, error: err.message };
      }
      completed++;
      if (onProgress) onProgress(completed - 1, frames.length);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, frames.length); w++) {
    workers.push(worker(w));
  }
  await Promise.all(workers);
  return results.filter(Boolean);
}

module.exports = { parseScript, extractDocText, readImagePart, readImagePartFromBuffer, editFrame, analyzeImages, generateImage, generateFrameImages, normalizeImageSize };
