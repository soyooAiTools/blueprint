/**
 * Spec Extractor — Extract structured experience specs from storyboard frames
 * 
 * Input: Gemini-generated storyboard frames (JSON array)
 * Output: Phase specs with duration, interactions, triggers, entity requirements
 * 
 * Uses Gemini second-pass to convert free-text interaction/timing into structured specs.
 */

const fs = require('fs');
const path = require('path');

// Gemini via relay — direct, no proxy needed
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

const { GoogleGenAI } = require('@google/genai');

const VERBS = JSON.parse(fs.readFileSync(path.join(__dirname, 'worker', 'interaction-verbs.json'), 'utf8'));

const GEMINI_BASE_URL = process.env.GOOGLE_GEMINI_BASE_URL || 'https://sub.mindrix.app';
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: { baseUrl: GEMINI_BASE_URL },
});

function buildVerbDoc() {
  const lines = [];
  for (const [category, verbs] of Object.entries(VERBS.verbs)) {
    lines.push(`## ${category}`);
    for (const [verb, def] of Object.entries(verbs)) {
      lines.push(`- \`${def.example}\` — ${def.description} (args: ${def.args.join(', ')})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `你是一个试玩广告体验规格提取专家。

你的任务是从分镜帧数据中，为每个章节（chapter）提取一个结构化的体验规格（spec）。

## 交互动词表

${buildVerbDoc()}

## 输出格式

输出 JSON 数组，每项代表一个 phase（按 chapter 分组，一个 chapter = 一个 phase）：

\`\`\`json
{
  "phaseId": "buildConveyor",        // 英文 camelCase 标识
  "phaseName": "开局+传送带",          // 中文名
  "chapterId": 1,                     // 对应分镜的 chapter 号
  
  "duration": {
    "min": 3,                         // 最少停留秒数
    "max": 8                          // 最长停留秒数
  },
  
  "requiredInteractions": [           // 标准动词数组
    "move_to:conveyor",
    "spend:gold:1",
    "build:conveyor"
  ],
  
  "triggerNext": {
    "condition": "conveyorState == 2", // C# 条件表达式
    "description": "传送带建造完成"
  },
  
  "entitiesRequired": [
    {
      "name": "conveyor",             // 实体名
      "terminalState": 2,             // 终态值
      "description": "传送带已建造"
    }
  ],
  
  "playerMustAct": true,              // 是否必须玩家操作
  "autoAllowed": false                // 是否允许自动完成
}
\`\`\`

## 提取规则

1. **duration** 从分镜的 timing 字段提取：
   - "自动播放 1.5s" → min:1, max:2
   - "玩家操作，预计 3-5s" → min:3, max:8（给 CUA 额外时间）
   - "10-15秒" → min:10, max:15
   - 如果没有 timing 信息，默认 min:5, max:15

2. **requiredInteractions** 从 interaction 字段提取，映射到标准动词：
   - "移动到传送带" → move_to:conveyor
   - "搬运木头到木屋" → collect:wood:3, deliver:wood:woodHouse
   - "点击弩炮射击" → click:crossbow, attack:enemy
   - "点击主基地升级" → click:base, upgrade:base:2

3. **playerMustAct** 默认 true。只有以下情况为 false：
   - 纯过场动画（"无操作，纯欣赏"）
   - 自动播放镜头（"自动播放 1.5s"）

4. **autoAllowed** 默认 false。只有以下情况为 true：
   - 工人/NPC 自动采集类 phase
   - 明确说"自动"的流程

5. **entitiesRequired** 提取所有需要建造/解锁的实体。终态一般是 2（built/completed）。

6. **triggerNext** 写成 C# 风格的条件表达式。

7. 如果一个 chapter 内有多个子步骤（step），合并成一个 phase spec。

只输出 JSON 数组，不要其他内容。`;

/**
 * Extract specs from storyboard frames
 * @param {Array} frames - Gemini-generated storyboard frames
 * @param {object} opts - { projectName, gameType }
 * @returns {Array} specs array
 */
async function extractSpecs(frames, opts = {}) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames provided');
  }

  // Group frames by chapter for context
  const chapters = {};
  for (const frame of frames) {
    const ch = frame.chapter || frame.chapterId || 1;
    if (!chapters[ch]) chapters[ch] = { title: frame.chapterTitle || '', frames: [] };
    chapters[ch].frames.push(frame);
  }

  const contextText = JSON.stringify(frames, null, 2);

  const userPrompt = `以下是一个试玩广告的分镜数据（${frames.length} 帧，${Object.keys(chapters).length} 个章节）：

${opts.projectName ? `项目名：${opts.projectName}` : ''}
${opts.gameType ? `游戏类型：${opts.gameType}` : ''}

分镜数据：
${contextText}

请提取每个章节的体验规格。`;

  let result;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[SpecExtractor] Calling Gemini (attempt ${attempt}/3)...`);
      result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          temperature: 0.2,
          maxOutputTokens: 16384,
          systemInstruction: SYSTEM_PROMPT,
        },
      });
      break;
    } catch (err) {
      console.error(`[SpecExtractor] Attempt ${attempt} failed: ${err.message?.substring(0, 100)}`);
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const rawText = result.text || '';

  // Parse JSON from response
  let jsonStr;
  const codeBlock = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    jsonStr = codeBlock[1].trim();
  } else {
    const startIdx = rawText.search(/[\[{]/);
    if (startIdx >= 0) {
      jsonStr = rawText.substring(startIdx);
      const lastBracket = Math.max(jsonStr.lastIndexOf(']'), jsonStr.lastIndexOf('}'));
      if (lastBracket >= 0) jsonStr = jsonStr.substring(0, lastBracket + 1);
    }
  }

  if (!jsonStr) {
    throw new Error('Failed to extract JSON from Gemini response');
  }

  const specs = JSON.parse(jsonStr);

  // Validate specs
  const validated = specs.map((spec, i) => ({
    phaseId: spec.phaseId || `phase${i + 1}`,
    phaseName: spec.phaseName || `Phase ${i + 1}`,
    chapterId: spec.chapterId || i + 1,
    duration: {
      min: (spec.duration && spec.duration.min) || 5,
      max: (spec.duration && spec.duration.max) || 15,
    },
    requiredInteractions: spec.requiredInteractions || [],
    triggerNext: spec.triggerNext || { condition: '', description: '' },
    entitiesRequired: (spec.entitiesRequired || []).map(e => ({
      name: e.name || '',
      terminalState: e.terminalState !== undefined ? e.terminalState : 2,
      description: e.description || '',
    })),
    playerMustAct: spec.playerMustAct !== false,
    autoAllowed: spec.autoAllowed === true,
  }));

  console.log(`[SpecExtractor] Extracted ${validated.length} phase specs`);
  return validated;
}

/**
 * Save specs to project data directory
 */
function saveSpecs(specs, projectId, dataDir) {
  const specsDir = path.join(dataDir, projectId);
  fs.mkdirSync(specsDir, { recursive: true });
  const specsPath = path.join(specsDir, 'specs.json');
  fs.writeFileSync(specsPath, JSON.stringify(specs, null, 2));
  console.log(`[SpecExtractor] Specs saved to ${specsPath}`);
  return specsPath;
}

/**
 * Load specs for a project
 */
function loadSpecs(projectId, dataDir) {
  const specsPath = path.join(dataDir, projectId, 'specs.json');
  if (!fs.existsSync(specsPath)) return null;
  return JSON.parse(fs.readFileSync(specsPath, 'utf8'));
}

module.exports = { extractSpecs, saveSpecs, loadSpecs };
