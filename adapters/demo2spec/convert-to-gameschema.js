#!/usr/bin/env node
// spec-v3.json → blueprint gameSchema(adapters/schema/game-schema.json)
// 输出 gameschema-v3.json,同步跑 validateGameSchema + validateSemantics

const fs = require('fs');
const path = require('path');
const {
  buildCuaPlans,
  buildCuaSpecs,
  buildGameStateShim,
  writeSnapshotSchema,
} = require('./snapshot-schema.js');
const {
  loadVisualAssetManifest,
  resolveManifestPathForSpec,
} = require('./visual-assets.js');
const {
  buildUnityAssetPlan,
  writeUnityAssetPlan,
  writeUnityEditorBaker,
} = require('./unity-asset-plan.js');
const {
  sourceEntitySet,
  sourceResourceTarget,
} = require('./source-contract-mapping.js');

function parseArgs(argv) {
  const opts = { specPath: null, outPath: null, theme: process.env.DEMO2SPEC_THEME || 'default' };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--theme') {
      opts.theme = argv[++i] || opts.theme;
    } else if (!opts.specPath) {
      opts.specPath = arg;
    } else if (!opts.outPath) {
      opts.outPath = arg;
    } else {
      console.error('用法: node convert-to-gameschema.js <spec.json> [out.json] [--theme name]');
      process.exit(1);
    }
  }
  return opts;
}

const ARGS = parseArgs(process.argv);
const SPEC_PATH = ARGS.specPath;
if (!SPEC_PATH) { console.error('用法: node convert-to-gameschema.js <spec.json> [out.json] [--theme name]'); process.exit(1); }
const OUT_PATH  = ARGS.outPath || path.join(path.dirname(SPEC_PATH), 'gameschema.json');
const VALIDATOR = process.env.BLUEPRINT_VALIDATOR || '/opt/blueprint-editor/adapters/schema/validate-schema.cjs';
const SNAPSHOT_SCHEMA_PATH = process.env.DEMO2SPEC_SNAPSHOT_SCHEMA_OUT || path.join(path.dirname(OUT_PATH), 'snapshot-schema.json');
const CUA_SPECS_PATH = process.env.DEMO2SPEC_CUA_SPECS_OUT || path.join(path.dirname(OUT_PATH), 'cua-specs.json');
const CUA_PLANS_PATH = process.env.DEMO2SPEC_CUA_PLANS_OUT || path.join(path.dirname(OUT_PATH), 'cua-plans.json');
const GAME_STATE_SHIM_PATH = process.env.DEMO2SPEC_GAME_STATE_SHIM_OUT || path.join(path.dirname(OUT_PATH), 'game-state-shim.js');
const UNITY_ASSET_PLAN_PATH = process.env.DEMO2SPEC_UNITY_ASSET_PLAN_OUT || path.join(path.dirname(OUT_PATH), 'unity-asset-plan.json');
const UNITY_ASSET_BAKER_PATH = process.env.DEMO2SPEC_UNITY_ASSET_BAKER_OUT || path.join(path.dirname(OUT_PATH), 'Demo2SpecVisualAssetBaker.cs');

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
const assetManifest = loadVisualAssetManifest(resolveManifestPathForSpec(SPEC_PATH, spec));

function loadJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
}

function loadThemePreset(theme) {
  const explicit = process.env.DEMO2SPEC_THEME_PRESET;
  const presetDir = path.join(__dirname, 'theme-presets');
  const fallbackPath = path.join(presetDir, 'default.json');
  const requestedPath = explicit || path.join(presetDir, `${theme || 'default'}.json`);
  const preset = loadJsonIfExists(requestedPath) || loadJsonIfExists(fallbackPath);
  if (!preset) throw new Error(`theme preset not found: ${requestedPath}`);
  return {
    name: preset.name || theme || 'default',
    resources: preset.resources || {},
    npcs: preset.npcs || {},
    cta: preset.cta || { pool: '__Pool_Ui_Button_01', chineseName: '立即下载', initPos: [0, 2, 0], scale: 0.5 },
  };
}

// ---------- 1. gameConfig(从 demo 美术常量推默认值,缺失字段补合理值) ----------
const gameConfig = {
  cameraBackground: [0.04, 0.07, 0.16], // 0x0a1228 → rgb
  groundColor:      [0.10, 0.16, 0.13],
  moveSpeed: 5,
  collectRange: 2.5,
  maxCarry: 10,
  collectCooldown: 0.3,
};

// ---------- 2. entities(从 R11 factory patterns + spec.resources + theme preset 反推) ----------
// 资源型 entity (每个 resource 至少一个 source entity 对应)
// pool 格式: __Pool_<Word>_<Word>_NN (每段首字母大写其余小写,无内部驼峰)
const THEME_PRESET = loadThemePreset(ARGS.theme);
const ENTITY_TEMPLATES = THEME_PRESET.resources;
const NPC_TEMPLATES = THEME_PRESET.npcs;
const SOURCE_ENTITY_CONTRACT = assetManifest && assetManifest.sourceEntityContract || null;
const SOURCE_ENTITY_NAMES = sourceEntitySet(assetManifest);
const SOURCE_ENTITY_STYLES = assetManifest && assetManifest.sourceEntityContract && assetManifest.sourceEntityContract.entityStyles || {};
const SOURCE_SCENE_CONTRACT = assetManifest && assetManifest.sourceSceneContract || null;

function rgb01FromSceneColor(color, fallback) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) return fallback;
  return [
    Number((parseInt(color.slice(1, 3), 16) / 255).toFixed(4)),
    Number((parseInt(color.slice(3, 5), 16) / 255).toFixed(4)),
    Number((parseInt(color.slice(5, 7), 16) / 255).toFixed(4)),
  ];
}

if (SOURCE_SCENE_CONTRACT && SOURCE_SCENE_CONTRACT.backgroundColor) {
  gameConfig.cameraBackground = rgb01FromSceneColor(SOURCE_SCENE_CONTRACT.backgroundColor, gameConfig.cameraBackground);
}
if (SOURCE_SCENE_CONTRACT && SOURCE_SCENE_CONTRACT.ground && SOURCE_SCENE_CONTRACT.ground.color) {
  gameConfig.groundColor = rgb01FromSceneColor(SOURCE_SCENE_CONTRACT.ground.color, gameConfig.groundColor);
}

const POOL_COUNTERS = {};
const POOL_LIMITS = { Cube: 5, Sphere: 5, Cylinder: 3, Plane: 3 };
const POOL_COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Orange', 'Purple', 'White', 'Brown', 'Cyan', 'Pink'];

function normalizePoolShape(shape) {
  const s = String(shape || 'Cube').replace(/[^A-Za-z]/g, '');
  return POOL_LIMITS[s] ? s : 'Cube';
}

function normalizePoolColor(color) {
  const c = String(color || 'White').replace(/[^A-Za-z]/g, '');
  return POOL_COLORS.includes(c) ? c : 'White';
}

function nextPool(shape, color) {
  const preferredShape = normalizePoolShape(shape);
  const preferredColor = normalizePoolColor(color);
  const shapes = [preferredShape].concat(Object.keys(POOL_LIMITS).filter(s => s !== preferredShape));
  const colors = [preferredColor].concat(POOL_COLORS.filter(c => c !== preferredColor));
  for (const s of shapes) {
    for (const c of colors) {
      const key = s + '_' + c;
      const next = (POOL_COUNTERS[key] || 0) + 1;
      if (next <= POOL_LIMITS[s]) {
        POOL_COUNTERS[key] = next;
        return '__Pool_' + s + '_' + c + '_' + String(next).padStart(2, '0');
      }
    }
  }
  return '__Pool_Cube_White_01';
}

function reservePool(pool) {
  const m = String(pool || '').match(/^__Pool_([A-Za-z]+)_([A-Za-z]+)_(\d+)$/);
  if (!m) return;
  if (!POOL_LIMITS[m[1]] || !POOL_COLORS.includes(m[2])) return;
  if (Number(m[3]) > POOL_LIMITS[m[1]]) return;
  const key = m[1] + '_' + m[2];
  POOL_COUNTERS[key] = Math.max(POOL_COUNTERS[key] || 0, Number(m[3]) || 0);
}

function colorNameFromHex(hex) {
  const text = String(hex || '').replace(/^#/, '').trim();
  if (!/^[0-9a-f]{6}$/i.test(text)) return 'White';
  const r = parseInt(text.slice(0, 2), 16);
  const g = parseInt(text.slice(2, 4), 16);
  const b = parseInt(text.slice(4, 6), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max < 80) return 'Brown';
  if (max - min < 35) return max > 180 ? 'White' : 'Brown';
  if (r > 210 && g > 140 && b < 120) return 'Orange';
  if (r > 200 && g > 180 && b < 130) return 'Yellow';
  if (r > g + 45 && r > b + 45) return 'Red';
  if (g > r + 35 && g > b + 20) return 'Green';
  if (b > r + 35 && b > g + 15) return 'Blue';
  if (g > 160 && b > 160) return 'Cyan';
  if (r > 170 && b > 150) return 'Purple';
  return 'White';
}

function visualStylePoolSpec(style) {
  const kind = String(style && style.kind || '').toLowerCase();
  if (kind === 'astronaut') return { shape: 'Cylinder', color: 'Cyan', scale: 0.65 };
  if (kind === 'ship') return { shape: 'Cylinder', color: 'Blue', scale: 0.7 };
  if (kind === 'base') return { shape: 'Cylinder', color: 'Blue', scale: 0.7 };
  if (kind === 'station') return { shape: 'Cube', color: 'Cyan', scale: 0.65 };
  if (kind === 'counter') return { shape: 'Cube', color: 'Yellow', scale: 0.65 };
  if (kind === 'pad') return { shape: 'Cylinder', color: 'Yellow', scale: 0.6 };
  if (kind === 'crystal') return { shape: 'Sphere', color: 'Cyan', scale: 0.55 };
  if (kind === 'cargo') return { shape: 'Cube', color: 'Blue', scale: 0.65 };
  if (kind === 'beacon') return { shape: 'Sphere', color: colorNameFromHex(style && style.color), scale: 0.45 };
  if (kind === 'debris') return { shape: 'Cube', color: 'Brown', scale: 0.75 };
  if (kind === 'gate') return { shape: 'Cylinder', color: colorNameFromHex(style && style.color), scale: 0.55 };
  return { shape: 'Cube', color: colorNameFromHex(style && style.color), scale: 0.65 };
}

function visualEntityMeta(name) {
  const style = SOURCE_ENTITY_STYLES[name];
  if (!style) return null;
  const poolSpec = visualStylePoolSpec(style);
  const pos = style.position || {};
  return {
    pool: nextPool(poolSpec.shape, poolSpec.color),
    chineseName: style.label || name,
    initPos: [
      Number.isFinite(Number(pos.x)) ? Number(pos.x) : -3 + genericEntityIndex * 1.5,
      Number.isFinite(Number(pos.y)) ? Number(pos.y) : 0,
      Number.isFinite(Number(pos.z)) ? Number(pos.z) : genericEntityIndex % 2 === 0 ? 2 : -2,
    ],
    scale: poolSpec.scale,
  };
}

const allPats = [...spec.phases.flatMap(p => p.patterns || []), ...spec.functions.flatMap(f => f.patterns || [])];
const factories = new Set(allPats.filter(p => p.rule === 'R11').map(p => p.templateId));
const phaseEntityNames = new Set(spec.phases.flatMap(p => p.showEntities || []));

const entities = [];
const entitiesByName = {};
function addEntity(name, meta) {
  if (entitiesByName[name]) return;
  const e = { name, chineseName: meta.chineseName || name, showLabel: true, pool: meta.pool, initPos: meta.initPos, scale: meta.scale };
  entities.push(e);
  entitiesByName[name] = e;
  reservePool(e.pool);
}
// 1) 资源型
for (const r of spec.resources) {
  if (SOURCE_ENTITY_CONTRACT && !SOURCE_ENTITY_NAMES[r.id]) continue;
  const tpl = ENTITY_TEMPLATES[r.id];
  if (tpl) addEntity(r.id, tpl);
}
// 2) NPC 型(R11 factory 触发)
for (const tid of factories) {
  if (NPC_TEMPLATES[tid]) addEntity(tid, NPC_TEMPLATES[tid]);
}
// 3) storyboard2html PHASES.showEntities can declare important entities even
// when no legacy factory pattern exists in the HTML source.
let genericEntityIndex = 0;
function genericEntityMeta(name) {
  genericEntityIndex++;
  const preset = ENTITY_TEMPLATES[name] || NPC_TEMPLATES[name];
  if (preset) return preset;
  const visual = visualEntityMeta(name);
  if (visual) return visual;
  return {
    pool: /enemy|alien|monster/i.test(name) ? '__Pool_Enemy_Alien_01' : '__Pool_Cube_White_01',
    chineseName: name,
    initPos: [-3 + genericEntityIndex * 1.5, 0, genericEntityIndex % 2 === 0 ? 2 : -2],
    scale: 0.8,
  };
}
for (const name of phaseEntityNames) {
  if (!name || name === 'CtaButton') continue;
  addEntity(name, genericEntityMeta(name));
}
// 4) 兜底 CTA. storyboard2html L7 fixtures usually declare CtaButton in
// ENTITY_STYLE; prefer that visual position/shape over the generic UI prefab.
addEntity('CtaButton', visualEntityMeta('CtaButton') || THEME_PRESET.cta);

// ---------- 3. resources ----------
const resources = spec.resources
  .filter(r => r.kind !== 'flag')
  .map(r => {
    // 有 source contract 时，资源不是独立 carrier entity；它来自 PHASES.steps
    // 里的真实 target，如 IceSmall / BigDebris / SellCounter。
    const sourceTarget = sourceResourceTarget(assetManifest, r.id);
    const ent = sourceTarget && entitiesByName[sourceTarget]
      ? sourceTarget
      : entitiesByName[r.id] ? r.id : 'CtaButton';
    return { name: r.id, entity: ent, convertRatio: 1 };
  });

// ---------- 4. phases(用 derivedTriggers 推 trigger 类型) ----------
// 策略:
//   - 有 derivedTriggers 的 dwell → timer + seconds
//   - tip 文本 → guideText
//   - 没明确 trigger 的 → 默认 click_entity:CtaButton(终态 fallback)
const phases = spec.phases.map((p, i) => {
  const phaseId = `phase${i + 1}`;
  const guideText = p.tip || `Phase ${i + 1}`;
  let trigger;
  const derived = (p.derivedTriggers && p.derivedTriggers[0]);
  const internal = (p.triggers && p.triggers[0]);
  const dwell = derived || internal;
  // timer 必须包在 compound:配对一个真实玩家行为(resource_collected:第一个 resource)
  const r0 = resources[0];
  function timerWith(seconds) {
    if (!r0) return { type: 'timer', seconds };
    return {
      type: 'compound',
      operator: 'and',
      triggers: [
        { type: 'timer', seconds },
        { type: 'resource_collected', resource: r0.name, amount: 1 },
      ],
    };
  }
  if (p.contractTrigger) {
    trigger = normalizeContractTrigger(p.contractTrigger);
    if (trigger && trigger.type === 'timer') trigger = timerWith(trigger.seconds);
  } else if (i === spec.phases.length - 1) {
    trigger = { type: 'click_entity', entity: 'CtaButton' };
  } else if (dwell && dwell.kind === 'click') {
    trigger = { type: 'click_entity', entity: 'CtaButton' };
  } else if (dwell && dwell.kind === 'dwell') {
    trigger = timerWith(dwell.durationSec);
  } else if (p.durRaw && /^\d/.test(p.durRaw)) {
    trigger = timerWith(+p.durRaw);
  } else if (r0) {
    trigger = { type: 'resource_collected', resource: r0.name, amount: 1 };
  } else {
    trigger = timerWith(3);
  }

  return {
    phaseId,
    showEntities: (p.showEntities && p.showEntities.length)
      ? p.showEntities.filter(name => entitiesByName[name])
      : entities.map(e => e.name).filter((_, idx) => idx < 3 || i === spec.phases.length - 1), // 简化:前 3 实体始终显示 + 最后 phase 显示 CTA
    guideText,
    trigger,
    onEnter: [],
    onComplete: [],
  };
});

function normalizeContractTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return null;
  if (trigger.type === 'compound') {
    return {
      type: 'compound',
      operator: trigger.operator || 'and',
      triggers: (trigger.triggers || []).map(normalizeContractTrigger).filter(Boolean),
    };
  }
  if (trigger.type === 'resource_collected') {
    return { type: 'resource_collected', resource: trigger.resource || 'Resource', amount: trigger.amount || trigger.count || 1 };
  }
  if (trigger.type === 'timer') return { type: 'timer', seconds: Number(trigger.seconds) || 1 };
  if (trigger.type === 'click_entity') return { type: 'click_entity', entity: trigger.entity || 'CtaButton' };
  if (trigger.type === 'near_entity') return { type: 'near_entity', entity: trigger.entity || 'Entity', range: Number(trigger.range) || 2 };
  if (trigger.type === 'entity_state_reached') return { type: 'entity_state_reached', entity: trigger.entity || 'Entity', state: normalizeStateValue(trigger.state) };
  return trigger;
}

function normalizeStateValue(value) {
  if (value == null || value === '') return 1;
  if (Number.isFinite(Number(value))) return Number(value);
  var text = String(value).trim();
  if (/^(built|complete|completed|done)$/i.test(text)) return 2;
  if (/^(active|shown|visible|ready)$/i.test(text)) return 1;
  if (/^(hidden|idle|none|init)$/i.test(text)) return 0;
  return 1;
}

// ---------- 5. customLogic(把 GFM gaps + 高价值函数 unityMethod 草稿摘要) ----------
const customLogic = [];
for (const g of (spec.gfmGaps || [])) {
  customLogic.push(`GFM 缺口: ${g.key} — 建议 ${g.suggestedApi}`);
}
const TOP_FNS = ['tickPlayer', 'tickIceMachine', 'tickPopMachine', 'tickCustomers', 'tickAliens', 'sellOnce'];
for (const name of TOP_FNS) {
  const f = spec.functions.find(x => x.name === name);
  if (f && (f.patterns || []).length > 0) {
    customLogic.push(`函数 ${name}(${(f.patterns || []).length} pattern): see spec-v3.md`);
  }
}

// ---------- 6. 组装 + 写文件 + 校验 ----------
const schema = { gameConfig, entities, resources, phases, customLogic };
fs.writeFileSync(OUT_PATH, JSON.stringify(schema, null, 2));
console.log(`📦 wrote ${OUT_PATH}: ${entities.length} entities, ${resources.length} resources, ${phases.length} phases, ${customLogic.length} customLogic, theme=${THEME_PRESET.name}`);

const snapshotSchema = writeSnapshotSchema(SNAPSHOT_SCHEMA_PATH, { spec, gameSchema: schema, assetManifest });
console.log(`🧭 wrote ${SNAPSHOT_SCHEMA_PATH}: snapshotSchema=${snapshotSchema.schemaVersion}, modules=${Object.keys(snapshotSchema.moduleVocabulary).length}, planned=${(snapshotSchema.project && snapshotSchema.project.plannedModuleIds || []).length}`);

const unityAssetPlan = buildUnityAssetPlan(assetManifest, {
  source: SPEC_PATH,
  project: spec.meta && spec.meta.project,
});
writeUnityAssetPlan(UNITY_ASSET_PLAN_PATH, unityAssetPlan);
writeUnityEditorBaker(UNITY_ASSET_BAKER_PATH, unityAssetPlan);
console.log(`🎨 wrote ${UNITY_ASSET_PLAN_PATH}, ${UNITY_ASSET_BAKER_PATH}: actions=${unityAssetPlan.summary.actionCount}, external=${unityAssetPlan.summary.externalImportCount}, pendingSource=${unityAssetPlan.summary.pendingSourceAssetCount}`);

fs.writeFileSync(CUA_SPECS_PATH, JSON.stringify(buildCuaSpecs(schema), null, 2));
fs.writeFileSync(CUA_PLANS_PATH, JSON.stringify(buildCuaPlans(snapshotSchema), null, 2));
fs.writeFileSync(GAME_STATE_SHIM_PATH, buildGameStateShim(snapshotSchema));
console.log(`🧪 wrote ${CUA_SPECS_PATH}, ${CUA_PLANS_PATH}, ${GAME_STATE_SHIM_PATH}`);

// 校验
const { validateGameSchema, validateSemantics } = require(VALIDATOR);
const ajvErr = validateGameSchema(schema);
const semErr = validateSemantics(schema);
console.log('\n=== validateGameSchema ===');
console.log(ajvErr ? JSON.stringify(ajvErr, null, 2) : '✅ pass');
console.log('\n=== validateSemantics ===');
console.log(Array.isArray(semErr) && semErr.length > 0 ? JSON.stringify(semErr, null, 2) : '✅ pass');
