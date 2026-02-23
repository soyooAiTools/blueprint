/**
 * Storyboard Parser — Gemini 2.5 Pro
 * Extracted from storyboard skill for blueprint-editor integration
 */
const fs = require('fs');
const path = require('path');

// === Proxy (only when env var set) ===
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
if (PROXY_URL) {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    console.log(`[StoryboardParser][Proxy] Using ${PROXY_URL}`);
  } catch (e) {
    console.warn('[StoryboardParser][Proxy] undici not available');
  }
}

const { GoogleGenAI } = require('@google/genai');

const CONFIG = {
  apiKey: process.env.GEMINI_API_KEY || 'sk-d0hBOKM0YLUraKKcrjWY19zMpQJ1XxNP06I9lmGf4ImkzgQf',
  baseUrl: process.env.GOOGLE_GEMINI_BASE_URL || 'https://api.yyds168.net',
  textModel: 'gemini-3.1-pro-preview',
};

const ai = new GoogleGenAI({
  apiKey: CONFIG.apiKey,
  ...(CONFIG.baseUrl ? { httpOptions: { baseUrl: CONFIG.baseUrl } } : {}),
});

// === Document extraction ===

async function extractDocText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.csv') return fs.readFileSync(filePath, 'utf8');

  if (ext === '.doc' || ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
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
  const { orientation = 'landscape', cameraAngle = 'isometric-45', perspective = 'third-person', images = [], docPath, style = '' } = opts;

  const cameraMap = {
    'isometric-45': 'isometric 45-degree orthographic camera',
    'side-scroll': 'side-scrolling 2D camera view',
    'top-down': 'top-down overhead camera view',
    '3/4-view': '3/4 perspective angled camera view',
  };
  const cameraDesc = cameraMap[cameraAngle] || cameraAngle;
  const perspectiveRule = perspective === 'first-person'
    ? '可以使用第一人称视角'
    : perspective === 'mixed'
    ? '根据分镜需要灵活选择第一人称或第三人称'
    : '绝对禁止第一人称视角，始终使用第三人称';

  let docText = '';
  if (docPath) {
    docText = await extractDocText(docPath);
    console.log(`[StoryboardParser] 从文档提取了 ${docText.length} 字`);
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
- animation: 动画说明（**至少 60 字**），详细描述：
  - 每个运动元素的起点→终点→运动曲线（线性/缓入缓出/弹跳）
  - 出场/退场动画类型和时长
  - 粒子特效（类型、颜色、数量、持续时间）
  - 与下一帧的过渡方式（硬切/淡入淡出/滑动/缩放）

要求：
1. 总帧数控制在 15-25 帧
2. 每个章节 3-5 个子步骤
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

  if (fullText) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}\n\n请参考以上图片分析结果，在生成分镜时融入图片中的风格、场景元素和 UI 设计。` : '';
    parts.push({ text: `文案/需求：\n${fullText}${analysisContext}` });
  } else if (images.length > 0) {
    const analysisContext = imageAnalysis ? `\n\n## 参考图片 AI 分析结果\n${imageAnalysis}` : '';
    parts.push({ text: `请根据这些参考图片，设计一个试玩广告的分镜板。推断游戏类型、核心玩法，设计合理的交互流程。${analysisContext}` });
  } else {
    throw new Error('请提供文案、图片或文档中的至少一种作为输入');
  }

  const result = await ai.models.generateContent({
    model: CONFIG.textModel,
    contents: [{ role: 'user', parts }],
    config: {
      temperature: 0.3,
      systemInstruction: systemPrompt,
    },
  });

  const jsonStr = result.text.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(jsonStr);

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

  const parts = [...imageParts, { text: prompt }];
  
  try {
    const result = await ai.models.generateContent({
      model: CONFIG.textModel,
      contents: [{ role: 'user', parts }],
      config: { temperature: 0.2 },
    });
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

module.exports = { parseScript, extractDocText, readImagePart, readImagePartFromBuffer, editFrame, analyzeImages };
