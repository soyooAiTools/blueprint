/**
 * Spec Extractor — Extract structured experience specs from storyboard frames
 *
 * Input: Storyboard frames (JSON array) + blueprint entities
 * Output: Phase specs with duration, interactions, triggers, entity requirements
 *
 * Uses Doubao to convert free-text interaction/timing into structured specs.
 */

const fs = require('fs');
const path = require('path');

// LLM via Doubao (豆包) directly
const modelProvider = require('../lib/model-provider.cjs');
var _specProvider = modelProvider.createProvider('doubao', {});

const VERBS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'worker', 'interaction-verbs.json'), 'utf8'));

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
   **重要：实体名必须严格使用 blueprint.entities 中给出的 name 值**，不要自行编造或简化名称。如果分镜描述的实体能对应到 blueprint.entities 中的某个实体，则必须使用该实体的精确 name。

6. **triggerNext** 写成 C# 风格的条件表达式。

7. 每个 chapter 对应一个 phase spec（一一对应，不要合并多个 chapter）。
8. 重要：输出的 phase 数量必须等于输入的 chapter 数量。如果输入有 11 个 chapter，就必须输出 11 个 phase。绝对不要把所有内容合并成一个 phase。

只输出 JSON 数组，不要其他内容。`;

/**
 * Extract specs from storyboard frames
 * @param {Array} frames - Storyboard frames
 * @param {object} opts - { projectName, gameType, entities }
 * @returns {Array} specs array
 */
async function extractSpecs(frames, opts = {}) {
  if (!frames || frames.length === 0) {
    throw new Error('No frames provided');
  }

  // Group frames by chapter for context
  // Assign chapter numbers: if frames lack chapter info, each frame = 1 chapter
  // This prevents LLM from merging all frames into a single mega-phase
  const chapters = {};
  let autoChapter = 1;
  for (const frame of frames) {
    let ch = frame.chapter || frame.chapterId;
    if (!ch) {
      // No chapter assigned — treat each frame as its own chapter
      ch = autoChapter++;
      frame.chapter = ch;  // mutate so LLM sees chapter numbers in the JSON
    }
    if (!chapters[ch]) chapters[ch] = { title: frame.chapterTitle || frame.title || '', frames: [] };
    chapters[ch].frames.push(frame);
  }

  const contextText = JSON.stringify(frames, null, 2);

  // Build entity list section for the prompt
  const entities = opts.entities || [];
  let entitySection = '';
  if (entities.length > 0) {
    const entityNames = entities.map(e => e.name).filter(Boolean);
    entitySection = `\n## 蓝图实体列表（blueprint.entities）\n以下是本项目蓝图中已定义的全部实体，entitiesRequired 中的 name 必须严格使用以下名称之一：\n${entityNames.map(n => `- ${n}`).join('\n')}\n\n禁止使用不在上述列表中的实体名。如果分镜描述的实体无法对应到列表中的任何一项，则该 phase 的 entitiesRequired 留空数组。\n`;
  }

  const userPrompt = `以下是一个试玩广告的分镜数据（${frames.length} 帧，${Object.keys(chapters).length} 个章节）：

${opts.projectName ? `项目名：${opts.projectName}` : ''}
${opts.gameType ? `游戏类型：${opts.gameType}` : ''}
${entitySection}
分镜数据：
${contextText}

请提取每个章节的体验规格。`;

  const expectedCount = Object.keys(chapters).length;
  const minAcceptable = Math.ceil(expectedCount * 0.5);
  const MAX_TRUNCATION_RETRIES = 2;

  let validated;

  for (let truncRetry = 0; truncRetry <= MAX_TRUNCATION_RETRIES; truncRetry++) {
    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[SpecExtractor] Calling Doubao (attempt ${attempt}/3, round ${truncRetry + 1}/${MAX_TRUNCATION_RETRIES + 1})...`);
        result = await _specProvider.generate(
          { system: SYSTEM_PROMPT, user: userPrompt },
          { temperature: 0.2, maxTokens: 16384, timeoutMs: 120000 }
        );
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
      if (truncRetry < MAX_TRUNCATION_RETRIES) {
        console.warn(`[SpecExtractor] No JSON in response — likely truncated. Retrying (${truncRetry + 1}/${MAX_TRUNCATION_RETRIES})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw new Error('Failed to extract JSON from Doubao response');
    }

    let specs;
    try {
      specs = JSON.parse(jsonStr);
    } catch (parseErr) {
      if (truncRetry < MAX_TRUNCATION_RETRIES) {
        console.warn(`[SpecExtractor] JSON parse failed (truncated response?) — retrying (${truncRetry + 1}/${MAX_TRUNCATION_RETRIES})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw parseErr;
    }

    // Validate specs
    validated = specs.map((spec, i) => ({
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

    // Truncation guard: if we got far fewer specs than expected chapters, retry
    if (validated.length < minAcceptable) {
      console.warn(`[SpecExtractor] Truncation detected: got ${validated.length} specs but expected ~${expectedCount} (min acceptable: ${minAcceptable}). ${truncRetry < MAX_TRUNCATION_RETRIES ? 'Retrying...' : 'Giving up, using what we have.'}`);
      if (truncRetry < MAX_TRUNCATION_RETRIES) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
    }

    // Good enough — break out
    break;
  }

  // --- Post-extraction: auto-correct entity names against blueprint.entities ---
  if (entities.length > 0) {
    const knownNames = new Set(entities.map(e => e.name).filter(Boolean));
    // Build lowercase→original map for fuzzy matching
    const lowerMap = {};
    for (const name of knownNames) {
      lowerMap[name.toLowerCase()] = name;
    }
    let corrected = 0;
    for (const spec of validated) {
      for (const ent of spec.entitiesRequired) {
        if (!ent.name || knownNames.has(ent.name)) continue;
        // Try case-insensitive exact match
        const lower = ent.name.toLowerCase();
        if (lowerMap[lower]) {
          console.log(`[SpecExtractor] Auto-correct entity: "${ent.name}" → "${lowerMap[lower]}"`);
          ent.name = lowerMap[lower];
          corrected++;
          continue;
        }
        // Try substring match: find a known entity whose lowercase name contains or is contained by the spec name
        let bestMatch = null;
        for (const known of knownNames) {
          const kl = known.toLowerCase();
          if (kl.includes(lower) || lower.includes(kl)) {
            bestMatch = known;
            break;
          }
        }
        if (bestMatch) {
          console.log(`[SpecExtractor] Auto-correct entity (fuzzy): "${ent.name}" → "${bestMatch}"`);
          ent.name = bestMatch;
          corrected++;
        } else {
          console.warn(`[SpecExtractor] Entity "${ent.name}" not found in blueprint.entities, clearing to avoid validation failure`);
          ent.name = '';
        }
      }
      // Remove entries with empty names
      spec.entitiesRequired = spec.entitiesRequired.filter(e => e.name);
    }
    if (corrected > 0) {
      console.log(`[SpecExtractor] Auto-corrected ${corrected} entity name(s) to match blueprint.entities`);
    }
  }

  console.log(`[SpecExtractor] Extracted ${validated.length} phase specs (expected ${expectedCount})`);
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
