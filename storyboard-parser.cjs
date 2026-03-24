// Using official Google Gemini API with proxy

/**
 * Storyboard Parser — Gemini 2.5 Pro
 * Extracted from storyboard skill for blueprint-editor integration
 */
const fs = require('fs');
const path = require('path');

// === Direct connection: ECS can reach Google API directly (no proxy needed) ===
// Proxy removed 2026-03-24: direct connection is faster and more reliable
console.log('[StoryboardParser] Using direct connection (no proxy)');
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

const { GoogleGenAI } = require('@google/genai');

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
  if (docPath) {
    const docExt = path.extname(docPath).toLowerCase();
    if (docExt === '.pdf') {
      // PDF: upload via Files API then reference by URI (avoids proxy size limits)
      console.log(`[StoryboardParser] Uploading PDF via Files API...`);
      const uploaded = await ai.files.upload({ file: docPath, config: { mimeType: 'application/pdf' } });
      let file = uploaded;
      while (file.state === 'PROCESSING') {
        await new Promise(r => setTimeout(r, 2000));
        file = await ai.files.get({ name: file.name });
      }
      if (file.state !== 'ACTIVE') throw new Error(`PDF upload failed: ${file.state}`);
      pdfPart = { fileData: { fileUri: file.uri, mimeType: 'application/pdf' } };
      console.log(`[StoryboardParser] PDF uploaded: ${file.uri}`);
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
  } else if (fullText) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}\n\n请参考以上图片分析结果，在生成分镜时融入图片中的风格、场景元素和 UI 设计。` : '';
    parts.push({ text: `文案/需求：\n${fullText}${analysisContext}` });
  } else if (images.length > 0) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}` : '';
    parts.push({ text: `请根据这些参考图片，设计一个试玩广告的分镜板。推断游戏类型、核心玩法，设计合理的交互流程。${analysisContext}` });
  } else {
    throw new Error('请提供文案、图片或文档中的至少一种作为输入');
  }

  // === Degradation chain: original → resize → fallback model → fail ===
  const proxyDoctor = require('./proxy-doctor.cjs');
  const notify = require('./notify.cjs');

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
        const timeoutMs = thinkingBudget > 0 ? 60000 : 45000;
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

  // Phase 1: Pro model first (gemini-3.1-pro-preview — default, best quality)
  try {
    result = await tryGemini(CONFIG.textModel, parts, 1024, 'Phase1:' + CONFIG.textModel);
  } catch(phase1Err) {
    console.log('[StoryboardParser] Phase 1 (pro) failed, trying flash model...');
    notify.alert('warning', '分镜解析：pro 失败，尝试 flash 模型', phase1Err.message?.substring(0, 100));

    // Phase 2: Fallback to flash (gemini-2.5-flash — stable & fast)
    try {
      result = await tryGemini('gemini-2.5-flash', parts, 0, 'Phase2:gemini-2.5-flash');
    } catch(phase2Err) {
      console.log('[StoryboardParser] Phase 2 (flash) failed, trying resize + flash...');
      notify.alert('warning', '分镜解析降级：缩图 + flash 重试', phase2Err.message?.substring(0, 100));

      // Phase 3: Resize images + flash (last resort)
      try {
        const resizedParts = await resizeParts(parts);
        result = await tryGemini('gemini-2.5-flash', resizedParts, 0, 'Phase3:resize+gemini-2.5-flash');
      } catch(phase3Err) {
        // All phases failed
        notify.alert('critical', '分镜解析全部降级失败', phase3Err.message?.substring(0, 200));
        throw phase3Err;
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
    // Last resort: try to fix common issues and retry
    console.error(`[StoryboardParser] JSON parse failed, attempting repair. Error: ${jsonErr.message.substring(0, 100)}`);
    // Try removing all non-JSON content between objects
    const repaired = jsonStr.replace(/}[\s\S]{1,5}?\{/g, (match) => {
      if (match.includes('"') || match.includes('[') || match.includes(']')) return match;
      return '},{';
    });
    parsed = JSON.parse(repaired);
    console.log('[StoryboardParser] JSON repair succeeded');
  }

  let frames, characterSheet = {};
  if (Array.isArray(parsed)) {
    frames = parsed;
  } else if (parsed.frames && Array.isArray(parsed.frames)) {
    frames = parsed.frames;
    characterSheet = parsed.characterSheet || {};
  } else {
    throw new Error('Gemini 返回格式不正确');
  }

  // Inject character descriptions
  for (const f of frames) {
    if (!f.id || !f.prompt || !f.title || !f.interaction || !f.ui) {
      throw new Error(`帧 ${f.id || '?'} 格式不完整`);
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
  const { style = '', cameraAngle = '', orientation = '', perspective = '', styleRefBase64 = null, styleRefMime = null, charRefBase64 = null, charRefMime = null } = opts;
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

  const result = await aiInstance.models.generateContent({
    model: CONFIG.imageModel,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.8 },
  });
  let imageData = null, textResponse = '';
  for (const part of (result.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData) imageData = { base64: part.inlineData.data, mimeType: part.inlineData.mimeType };
    if (part.text) textResponse = part.text;
  }
  if (!imageData) throw new Error('Gemini did not return an image');
  return { ...imageData, text: textResponse };
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
