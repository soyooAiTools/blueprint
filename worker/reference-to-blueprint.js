/**
 * Reference to Blueprint — 将竞品分析结果合成 V4 蓝图
 *
 * 输入: 截图 + 交互流程 + 静态分析 + 用户描述
 * 输出: V4 blueprint JSON (entities[], phases[], globalSettings)
 *
 * 调用豆包 Seed 2.0 Pro 多模态模型
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { GoogleGenAI } = require('../doubao-adapter.cjs');

const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || '197cb950-3cf3-4b30-b656-6afaa4306a7a';
const DOUBAO_MODEL = process.env.REFERENCE_MODEL || 'doubao-seed-2-0-pro-260215';

const ai = new GoogleGenAI({
  apiKey: DOUBAO_API_KEY,
});

// V4 schema 路径
const V4_SCHEMA_PATH = path.join(__dirname, '..', 'docs', 'v4-schema.json');
// 行为模板
const BEHAVIOR_TEMPLATES_PATH = path.join(__dirname, 'behavior-templates.md');

/**
 * 读取图片并转为 Gemini inline data part
 */
function readImagePart(imagePath) {
  var data = fs.readFileSync(imagePath);
  var ext = path.extname(imagePath).toLowerCase();
  var mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp',
  };
  return { inlineData: { data: data.toString('base64'), mimeType: mimeMap[ext] || 'image/png' } };
}

/**
 * 构建分析 prompt
 */
function buildPrompt(analysis, userDescription, metadata, htmlSnippet) {
  var v4Schema = '';
  try { v4Schema = fs.readFileSync(V4_SCHEMA_PATH, 'utf-8'); } catch (e) {}

  var behaviorTemplates = '';
  try { behaviorTemplates = fs.readFileSync(BEHAVIOR_TEMPLATES_PATH, 'utf-8').substring(0, 3000); } catch (e) {}

  var interactionSummary = (analysis.interactionFlow || []).map(function(i) {
    if (i.action === 'tap') return 'Tap at (' + i.x + ',' + i.y + ') → ' + i.result;
    if (i.action === 'drag') return 'Drag from ' + JSON.stringify(i.from) + ' to ' + JSON.stringify(i.to) + ' → ' + i.result;
    return i.action + ' → ' + i.result;
  }).join('\n');

  var staticSummary = '';
  var sa = analysis.staticAnalysis || {};
  if (sa.canvasCount !== undefined) {
    staticSummary = 'Canvas: ' + sa.canvasCount + (sa.canvasSize ? ' (' + sa.canvasSize.width + 'x' + sa.canvasSize.height + ')' : '') +
      '\nImages: ' + (sa.imgCount || 0) +
      '\nVisible text: ' + (sa.visibleText || []).join(', ') +
      '\nCTA elements: ' + (sa.ctaElements || 0) +
      '\nMRAID: ' + (sa.hasMraid ? 'yes' : 'no');
  }

  var prompt = `## Role
You are a playable ad analyst. Analyze the competitor's playable ad screenshots and interaction data below, then generate a V4 blueprint to recreate a similar game experience.

## Competitor Ad Analysis

**Framework:** ${metadata.framework || 'unknown'}
**Screenshots:** ${analysis.screenshots.length} stages captured
**Total interactions detected:** ${analysis.interactionFlow.length}
**CTA detected:** ${analysis.ctaDetected ? 'yes' : 'no'}

### Interaction Flow
${interactionSummary || 'No interactions detected - may be auto-play or require specific gestures'}

### Static Analysis
${staticSummary || 'Not available'}

${userDescription ? '### User Description\n' + userDescription + '\n' : ''}

${htmlSnippet ? '### HTML Code Snippet (key logic)\n```html\n' + htmlSnippet + '\n```\n' : ''}

## Output Requirements

Generate a V4 blueprint JSON with the following structure:
- **entities[]**: Game objects with name, label, visual (shape/scale/color/position), template, spawn, trigger, actions, behavior
- **phases[]**: Game stages (8-12 phases) with id, name, activate, endCondition, guide, camera
- **globalSettings**: gameType, cameraProjection, cameraAngle, backgroundColor

### Key Rules
1. Entities MUST use shapes: Cube, Sphere, Cylinder, Ground, UI (no custom meshes)
2. Phases MUST be 8-12 in count, last phase MUST be CTA with gameEnd action
3. Entity names MUST be English PascalCase (e.g., Player, Enemy, ScoreText)
4. Phase endConditions use expressions like: "timer:3s", "tap:Player", "entity:Enemy.state==dead", "score>=10"
5. Include a CTAButton entity (UI, initially hidden, shown in last phase)
6. Match the competitor's game type and interaction pattern as closely as possible
7. Each entity needs a label (Chinese name describing its role)

### V4 Schema Reference
\`\`\`json
${v4Schema}
\`\`\`

### Available Behavior Templates
${behaviorTemplates ? behaviorTemplates.substring(0, 2000) : 'Static, Buildable, Shooter, Mover, Spawner, Collectible, Draggable, Damageable, Upgradeable, PlayerController'}

## Output
Output ONLY valid JSON, no markdown fences, no explanation. The JSON must conform to the V4 schema above.`;

  return prompt;
}

/**
 * 从 HTML 中提取关键代码片段（去掉 base64 资源，保留逻辑代码）
 */
function extractHtmlSnippet(html, maxChars) {
  maxChars = maxChars || 8000;
  if (!html) return '';

  // 移除 base64 data URI（图片/音频等大资源）
  var cleaned = html.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]{100,}/g, 'DATA_URI_REMOVED');
  // 移除超长的内联 CSS
  cleaned = cleaned.replace(/<style[^>]*>[\s\S]{2000,}?<\/style>/gi, '<style>/* CSS_REMOVED */</style>');

  if (cleaned.length <= maxChars) return cleaned;

  // 提取 <script> 标签内容（核心逻辑）
  var scripts = [];
  var scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  var match;
  while ((match = scriptRegex.exec(cleaned)) !== null) {
    var content = match[1].trim();
    if (content.length > 50 && content.length < 50000) {
      scripts.push(content);
    }
  }

  if (scripts.length > 0) {
    var combined = scripts.join('\n\n// --- next script ---\n\n');
    return combined.substring(0, maxChars);
  }

  // 无法提取有意义的脚本，返回截断的 HTML
  return cleaned.substring(0, maxChars);
}

/**
 * 调用 Gemini 生成 V4 蓝图
 */
async function generateBlueprint(analysis, userDescription, metadata, html, log, taskId) {
  log('[reference-to-blueprint] Generating V4 blueprint via Gemini...', taskId);

  var htmlSnippet = extractHtmlSnippet(html, 8000);

  // 构建多模态 parts
  var parts = [];

  // 添加截图（最多6张）
  var ssToSend = (analysis.screenshots || []).slice(0, 6);
  for (var i = 0; i < ssToSend.length; i++) {
    var ss = ssToSend[i];
    if (fs.existsSync(ss.path)) {
      parts.push(readImagePart(ss.path));
      log('[reference-to-blueprint] Attached screenshot: ' + ss.stage, taskId);
    }
  }

  // 添加文本 prompt
  var prompt = buildPrompt(analysis, userDescription, metadata, htmlSnippet);
  parts.push({ text: prompt });

  log('[reference-to-blueprint] Prompt length: ' + prompt.length + ' chars, images: ' + ssToSend.length, taskId);

  // 调用豆包
  var result = await Promise.race([
    ai.models.generateContent({
      model: DOUBAO_MODEL,
      contents: [{ role: 'user', parts: parts }],
      config: {
        temperature: 0.2,
        maxOutputTokens: 65536,
        responseMimeType: 'application/json',
      },
    }),
    new Promise(function(_, reject) {
      setTimeout(function() { reject(new Error('Doubao timeout (120s)')); }, 120000);
    })
  ]);

  var text = (result.text || '').trim();
  // 清理可能的 markdown 包裹
  text = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

  log('[reference-to-blueprint] Gemini response: ' + text.length + ' chars', taskId);

  var blueprint;
  try {
    blueprint = JSON.parse(text);
  } catch (e) {
    // 尝试提取 JSON 子串
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      blueprint = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Failed to parse Gemini response as JSON: ' + text.substring(0, 200));
    }
  }

  // 基础校验
  if (!blueprint.entities || !Array.isArray(blueprint.entities)) {
    throw new Error('Blueprint missing entities array');
  }
  if (!blueprint.phases || !Array.isArray(blueprint.phases)) {
    throw new Error('Blueprint missing phases array');
  }

  log('[reference-to-blueprint] Blueprint generated: ' + blueprint.entities.length + ' entities, ' + blueprint.phases.length + ' phases', taskId);

  // 确保最后一个 phase 有 CTA
  var lastPhase = blueprint.phases[blueprint.phases.length - 1];
  if (lastPhase && !/cta|game.*end|结束/i.test(lastPhase.name || '')) {
    log('[reference-to-blueprint] Warning: last phase may not be CTA: ' + (lastPhase.name || ''), taskId);
  }

  // 确保有 CTAButton entity
  var hasCTA = blueprint.entities.some(function(e) { return /cta/i.test(e.name); });
  if (!hasCTA) {
    blueprint.entities.push({
      name: 'CTAButton',
      label: '下载按钮',
      visual: { shape: 'UI', scale: '3×1×1', color: '(0.2,0.8,0.2)', position: '(0,0,0)' },
      template: 'Static',
      spawn: { condition: 'phase:' + blueprint.phases.length, style: 'popUp', persistent: true },
      trigger: { type: 'click', params: {}, once: true },
      actions: [{ type: 'gameEnd', params: {} }],
      behavior: {},
    });
    log('[reference-to-blueprint] Auto-added CTAButton entity', taskId);
  }

  return blueprint;
}

module.exports = { generateBlueprint, extractHtmlSnippet, buildPrompt };
