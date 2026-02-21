#!/usr/bin/env node
/**
 * frames-to-blueprint.cjs — Storyboard frames.json → Blueprint shots JSON
 * 
 * 将 storyboard 输出的帧数据转换为 blueprint 蓝图格式。
 * 注意：自动转换只能生成骨架，scene/triggers/behavior 需要 Agent 或人工细化。
 * 
 * Usage:
 *   node frames-to-blueprint.cjs <frames.json> [--project "项目名"] [--out blueprint.json]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const inputPath = args.find(a => !a.startsWith('--'));
if (!inputPath) {
  console.error('Usage: node frames-to-blueprint.cjs <frames.json> [--project "name"] [--out output.json]');
  process.exit(1);
}

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

const projectName = getArg('--project') || path.basename(inputPath, '.json');
const outputPath = getArg('--out') || inputPath.replace('.json', '-blueprint.json');

// Read frames
const frames = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

if (!Array.isArray(frames) || frames.length === 0) {
  console.error('Error: frames.json must be a non-empty array');
  process.exit(1);
}

// Group frames into shots (by chapter or every 3-5 frames)
// Strategy: if frames have chapter field, group by chapter; otherwise group by 3
function groupFrames(frames) {
  if (frames[0] && frames[0].chapter !== undefined) {
    // Group by chapter
    const groups = {};
    for (const f of frames) {
      const ch = f.chapter || 1;
      if (!groups[ch]) groups[ch] = { title: f.chapterTitle || `镜头${ch}`, frames: [] };
      groups[ch].frames.push(f);
    }
    return Object.values(groups);
  }
  // No chapter info: group every 3 frames
  const groups = [];
  for (let i = 0; i < frames.length; i += 3) {
    const chunk = frames.slice(i, i + 3);
    groups.push({
      title: chunk[0].title || `镜头${groups.length + 1}`,
      frames: chunk
    });
  }
  return groups;
}

const groups = groupFrames(frames);
const shots = [];
const SHOT_SPACING_X = 400;

for (let i = 0; i < groups.length; i++) {
  const group = groups[i];
  const shotId = `shot_${i + 1}`;
  const nextShotId = i < groups.length - 1 ? `shot_${i + 2}` : null;

  // Merge frames in this group into one shot description
  const sceneLines = group.frames.map((f, j) => 
    `${j + 1}. ${f.title || ''}: ${f.prompt || ''}`
  );
  const interactionLines = group.frames.map((f, j) =>
    f.interaction ? `${j + 1}. ${f.interaction}` : ''
  ).filter(Boolean);
  const uiLines = group.frames.map((f, j) =>
    f.ui ? `${j + 1}. ${f.ui}` : ''
  ).filter(Boolean);

  const shot = {
    id: shotId,
    position: { x: i * SHOT_SPACING_X, y: 0 },
    transitions: nextShotId ? [{ target: nextShotId }] : [],
    name: group.title,
    scene: `【待细化】\n${sceneLines.join('\n')}`,
    controlTarget: '【待填写】',
    controlMethod: '【待填写】',
    triggers: `【待细化】\n${interactionLines.join('\n')}`,
    behavior: '【待填写数值参数】',
    entryCondition: i === 0 ? '游戏开始' : `镜头${i}完成`,
    endCondition: '',
    branch: nextShotId ? {
      condition: '【待填写分支条件】',
      ifTrue: nextShotId,
      ifFalse: ''
    } : null,
    branch2: null,
    images: []
  };

  // Last shot: add CTA note
  if (i === groups.length - 1) {
    shot.triggers += '\n\n⚠️ 最后镜头必须包含：\n- 调用 Luna.Unity.LifeCycle.GameEnded()\n- CTA 按钮调用 Luna.Unity.Playable.InstallFullGame()';
    shot.endCondition = '玩家点击CTA按钮';
  }

  shots.push(shot);
}

const blueprint = {
  project: projectName,
  shots: shots,
  _meta: {
    source: inputPath,
    generatedAt: new Date().toISOString(),
    note: '自动生成的骨架，scene/triggers/behavior/branch 中的【待细化】【待填写】需要 Agent 或人工补充详细描述'
  }
};

fs.writeFileSync(outputPath, JSON.stringify(blueprint, null, 2), 'utf-8');
console.log(`✅ 转换完成: ${shots.length} 个镜头`);
console.log(`   输出: ${outputPath}`);
console.log(`   ⚠️ 标记了【待细化】的字段需要补充详细描述后再提交`);
