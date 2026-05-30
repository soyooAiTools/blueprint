#!/usr/bin/env node
// demo2spec extractor v0.3 — three.js HTML demo → blueprint spec.json
//
// v0.3 新增(基于 THREEJS-TO-UNITY-MAPPING.md 13 类规则):
//   - JS 函数级解析(tick* / spawn* / start* / on*),每函数 → Unity method spec
//   - 13 类 pattern → DSL + GFM 调用预生成
//   - state.X 资源 ID 标准化 → ResourceDef[]
//   - GFM API gap 自动标注(Shake/WarningOverlay/Shockwave/Lightning/...)
//   - 输出 spec-v3.json + spec-v3.md,保留 v0.2 baseline
//
// 用法: node extract-v3.js [src.html] [out_dir]

const fs = require('fs');
const path = require('path');
const {
  extractVisualAssetManifest,
  validateVisualAssetReadiness,
  writeVisualAssetManifest,
  collectEntityNamesFromHtml,
} = require('./visual-assets.js');

const SRC = process.argv[2];
if (!SRC) { console.error('用法: node extract.js <src.html> [out_dir]'); process.exit(1); }
const OUT_DIR = process.argv[3] || process.cwd();
const PROJECT_NAME = process.env.DEMO2SPEC_PROJECT || path.basename(SRC, path.extname(SRC));
const EXTRACTOR_VERSION = 'v1.0';

const html = fs.readFileSync(SRC, 'utf8');
const fullText = html;
const js = fullText;

// ---------- utils ----------
function findLine(idx) {
  let n = 1;
  for (let i = 0; i < idx && i < fullText.length; i++) if (fullText[i] === '\n') n++;
  return n;
}
function sliceBalanced(text, startIdx, open, close) {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
  }
  return null;
}
function findTopLevelObjects(arrBody) {
  const inner = arrBody.slice(1, -1);
  const blocks = [];
  let depth = 0, start = -1;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { blocks.push(inner.slice(start, i + 1)); start = -1; } }
  }
  return blocks;
}
function uniq(arr) { return [...new Set(arr)]; }

// ---------- resource id 标准化表 ----------
const STATE_TO_RESOURCE = {
  ice:      { id: 'Ice',      kind: 'consumable', ui: '冰块',     icon: 'IceCube' },
  pop:      { id: 'Popcorn',  kind: 'consumable', ui: '爆米花',   icon: 'Popcorn' },
  popcorn:  { id: 'Popcorn',  kind: 'consumable', ui: '爆米花',   icon: 'Popcorn' },
  corn:     { id: 'Corn',     kind: 'consumable', ui: '玉米',     icon: 'Corn' },
  coin:     { id: 'Gold',     kind: 'currency',   ui: '金币',     icon: 'Coin' },
  gold:     { id: 'Gold',     kind: 'currency',   ui: '金币',     icon: 'Coin' },
  wood:     { id: 'Wood',     kind: 'consumable', ui: '木材',     icon: 'Wood' },
  hp:       { id: 'HomeHp',   kind: 'health',     ui: '家园HP',   icon: 'Heart' },
  homeHp:   { id: 'HomeHp',   kind: 'health',     ui: '家园HP',   icon: 'Heart' },
};
// state 名 → flag(状态机/计数器/布尔标记) 的判定:不计入 resource
const FLAG_KEYS = new Set(['phase','shot','time','phaseTime','tick','frame','t','dt','ended','started','ready','active','running']);
const FLAG_SUFFIX = /(Spawned|Done|Active|Ready|Started|Ended|Built|Killed|Cleared|Triggered)$/;
function isFlagKey(k) {
  if (String(k || '').charAt(0) === '_') return true;
  if (FLAG_KEYS.has(k)) return true;
  if (FLAG_SUFFIX.test(k)) return true;
  return false;
}
function normalizeRes(stateKey) {
  const direct = STATE_TO_RESOURCE[stateKey] || STATE_TO_RESOURCE[String(stateKey || '').charAt(0).toLowerCase() + String(stateKey || '').slice(1)];
  if (direct) return direct;
  const cap = stateKey[0].toUpperCase() + stateKey.slice(1);
  return { id: cap, kind: isFlagKey(stateKey) ? 'flag' : 'consumable', ui: cap, icon: cap };
}

// ---------- audio asset map ----------
const DEFAULT_AUDIO_MAP = [
  { match: '^(pick|pickup|grab|collect)(Ice|Pop|Coin|Corn|up)?$', clip: 'AudioClips.PickupSparkle' },
  { match: '^drop$', clip: 'AudioClips.Place' },
  { match: '^(machine|cannon)$', clip: 'AudioClips.Machine' },
  { match: '^growth$', clip: 'AudioClips.Growth' },
  { match: '^(unlock|sell|upgrade)$', clip: 'AudioClips.Unlock' },
  { match: '^(alarm|homeDmg|warn)$', clip: 'AudioClips.Alarm' },
  { match: '^(hit|gunfire|shoot)$', clip: 'AudioClips.Hit' },
  { match: '^(kill|alienKill|explode|blast|boom)$', clip: 'AudioClips.Explosion' },
  { match: '^tick$', clip: 'AudioClips.Tick' },
  { match: '^win$', clip: 'AudioClips.Victory' },
  { match: '^boss$', clip: 'AudioClips.BossRoar' },
];
function compileAudioMap(rows) {
  return rows.map(row => ({ match: new RegExp(row.match, 'i'), clip: row.clip })).filter(row => row.clip);
}
function loadAudioMap() {
  const configPath = process.env.DEMO2SPEC_AUDIO_MAP || path.join(__dirname, 'audio-map.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return compileAudioMap(cfg.patterns || DEFAULT_AUDIO_MAP);
  } catch (err) {
    console.error(`[demo2spec] audio-map load failed, using defaults: ${err.message}`);
    return compileAudioMap(DEFAULT_AUDIO_MAP);
  }
}
const AUDIO_MAP = loadAudioMap();
function mapSfx(name) {
  for (const m of AUDIO_MAP) if (m.match.test(name)) return m.clip;
  return `AudioClips.${name[0].toUpperCase() + name.slice(1)}  /* TODO: 未匹配,需补 */`;
}

// ---------- GFM gap 标记 ----------
const GFM_GAPS = {
  shake:         'GFM_CameraController.Shake(intensity, duration)',
  warning:       'GFM_UIManager.SetWarningOverlay(intensity)',
  shockwave:     'GFM_VisualGuide.Shockwave(pos, color, maxR)',
  lightning:     'GFM_FX.Lightning(from, to, color, segments)',
  spawnqueue:    'GFM_NpcManager.SpawnQueue(anchor, count, spacing)',
  machineanim:   'MachineAnimator.cs (codegen 新 MonoBehaviour)',
  mecharm:       'MechArmController.cs (codegen 新 MonoBehaviour)',
  blueprint:     'GFM_VisualGuide.BlueprintOutline(center, size, color)',
};
const gapsUsed = new Set();

// ---------- spec 容器 ----------
const spec = {
  meta: {
    project: PROJECT_NAME,
    extractor: EXTRACTOR_VERSION,
    src: SRC,
    generatedAt: new Date().toISOString(),
  },
  resources: [],
  entities: [],
  phases: [],
  functions: [],
  gfmGaps: [],
  notes: [],
};
const unknownFactories = new Set();

function loadFactoryPatterns() {
  const configPath = process.env.DEMO2SPEC_FACTORY_PATTERNS || path.join(__dirname, 'factory-patterns.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (cfg.patterns || []).map(p => ({
      match: new RegExp(p.match),
      api: p.api || 'SpawnNpc',
      templateId: p.templateId,
      primitive: p.primitive || 'Cube',
    })).filter(p => p.templateId);
  } catch (err) {
    spec.notes.push(`factory-patterns load failed: ${err.message}`);
    return [];
  }
}
const FACTORY_PATTERNS = loadFactoryPatterns();

function matchFactoryPattern(fn) {
  for (const p of FACTORY_PATTERNS) {
    if (p.match.test(fn)) return p;
  }
  return null;
}

// ---------- 主流程 stub(后续 chunk 填充) ----------
function run() {
  parsePhases();
  parseFunctions();
  applyRules();
  buildResources();
  buildOutputs();
}

// ---------- PASS 1: PHASES 数组 ----------
function parsePhases() {
  const phaseDecl = /\b(?:const|let|var)\s+PHASES\s*=|\bwindow\.PHASES\s*=/.exec(js);
  const phasesIdx = phaseDecl ? phaseDecl.index : -1;
  if (phasesIdx < 0) { parsePhasesFallback('PHASES array not found'); return; }
  const phasesArrStart = js.indexOf('[', phasesIdx);
  if (phasesArrStart < 0) { parsePhasesFallback('PHASES array start not found'); return; }
  const phasesArr = sliceBalanced(js, phasesArrStart, '[', ']');
  if (!phasesArr) { parsePhasesFallback('PHASES array unterminated'); return; }
  const phaseBlocks = findTopLevelObjects(phasesArr);

  for (let i = 0; i < phaseBlocks.length; i++) {
    const block = phaseBlocks[i];
    const blockGlobalOffset = js.indexOf(block, phasesArrStart);
    pushPhaseFromBlock(block, blockGlobalOffset, null);
  }
  spec.notes.push(`PASS1: ${spec.phases.length} phases`);
}

function pushPhaseFromBlock(block, blockGlobalOffset, fallbackId) {
  const phase = {
    index: spec.phases.length,
    id: fallbackId || null,
    durRaw: null,
    tip: null,
    tipDurationMs: null,
    body: block,
    lineStart: findLine(Math.max(0, blockGlobalOffset || 0)),
    sideEffects: [],
    triggers: [],
    showEntities: [],
    contractTrigger: null,
    unityMethods: [],
  };

  const idMatch = block.match(/\bid\s*:\s*(\d+)/);
  if (idMatch) phase.id = +idMatch[1];
  const stringIdMatch = block.match(/\bid\s*:\s*['"]phase[_-]?(\d+)['"]/i);
  if (!idMatch && stringIdMatch) phase.id = +stringIdMatch[1];

  const durMatch = block.match(/\b(?:dur|durationSec)\s*:\s*([^,}]+)/);
  if (durMatch) phase.durRaw = durMatch[1].trim();

  const tipM = block.match(/setTip\(\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*\)/);
  if (tipM) { phase.tip = tipM[1]; phase.tipDurationMs = +tipM[2]; }
  if (!phase.tip) {
    const guideM = block.match(/\b(?:guideText|goalText|name)\s*:\s*['"`]([^'"`]+)['"`]/);
    if (guideM) phase.tip = guideM[1];
  }
  const showM = block.match(/\bshowEntities\s*:\s*\[([^\]]*)\]/);
  if (showM) {
    phase.showEntities = uniq((showM[1].match(/['"`]([^'"`]+)['"`]/g) || [])
      .map(s => s.replace(/^['"`]|['"`]$/g, '')));
  }
  phase.contractTrigger = parseContractTrigger(block);

  spec.phases.push(phase);
}

function readStringProp(text, key) {
  const re = new RegExp("\\b" + key + "\\s*:\\s*['\"`]([^'\"`]+)['\"`]");
  const m = text.match(re);
  return m ? m[1] : null;
}

function readNumberProp(text, key) {
  const re = new RegExp('\\b' + key + '\\s*:\\s*(-?\\d+(?:\\.\\d+)?)');
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

function parseStateValue(value) {
  if (value == null || value === '') return 1;
  const text = String(value).trim().replace(/^['"`]|['"`]$/g, '');
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^(built|complete|completed|done)$/i.test(text)) return 2;
  if (/^(active|shown|visible|ready)$/i.test(text)) return 1;
  if (/^(hidden|idle|none|init)$/i.test(text)) return 0;
  return 1;
}

function addTriggerOnce(triggers, trigger) {
  if (!trigger || !trigger.type) return;
  const key = JSON.stringify(trigger);
  for (let i = 0; i < triggers.length; i++) {
    if (JSON.stringify(triggers[i]) === key) return;
  }
  triggers.push(trigger);
}

function parseConditionTriggers(block) {
  const triggers = [];
  const re = /['"`](timer|resource_collected|near_entity|entity_state_reached|click_entity)\(([^'"`]*)\)['"`]/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const kind = m[1];
    const args = String(m[2] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (kind === 'timer') {
      addTriggerOnce(triggers, { type: 'timer', seconds: Number.parseFloat(args[0]) || 1 });
    } else if (kind === 'resource_collected') {
      addTriggerOnce(triggers, { type: 'resource_collected', resource: normalizeRes(args[0] || 'Resource').id, amount: Number(args[1]) || 1 });
    } else if (kind === 'near_entity') {
      addTriggerOnce(triggers, { type: 'near_entity', entity: args[0] || 'Entity', range: Number(args[1]) || 2 });
    } else if (kind === 'entity_state_reached') {
      addTriggerOnce(triggers, { type: 'entity_state_reached', entity: args[0] || 'Entity', state: parseStateValue(args[1]) });
    } else if (kind === 'click_entity') {
      addTriggerOnce(triggers, { type: 'click_entity', entity: args[0] || 'CtaButton' });
    }
  }
  return triggers;
}

function parseContractTrigger(block) {
  const type = readStringProp(block, 'type');
  if (!type) return null;
  const triggers = parseConditionTriggers(block);
  const timerSeconds = readNumberProp(block, 'seconds');
  if (/timer/.test(block) && timerSeconds != null) {
    addTriggerOnce(triggers, { type: 'timer', seconds: timerSeconds });
  }
  if (/resource_collected/.test(block)) {
    const resource = readStringProp(block, 'resource') || 'Resource';
    const amount = readNumberProp(block, 'amount') || readNumberProp(block, 'count') || 1;
    if (resource !== 'Resource' || triggers.filter(t => t.type === 'resource_collected').length === 0) {
      addTriggerOnce(triggers, { type: 'resource_collected', resource: normalizeRes(resource).id, amount });
    }
  }
  if (/near_entity/.test(block)) {
    addTriggerOnce(triggers, {
      type: 'near_entity',
      entity: readStringProp(block, 'entity') || 'Entity',
      range: readNumberProp(block, 'range') || 2,
    });
  }
  if (/entity_state_reached/.test(block)) {
    const entity = readStringProp(block, 'entity') || 'Entity';
    const stateString = readStringProp(block, 'state');
    const stateNumber = readNumberProp(block, 'state');
    if (entity !== 'Entity' || triggers.filter(t => t.type === 'entity_state_reached').length === 0) addTriggerOnce(triggers, {
      type: 'entity_state_reached',
      entity,
      state: parseStateValue(stateString != null ? stateString : (stateNumber != null ? stateNumber : 'built')),
    });
  }
  if (/click_entity/.test(block)) {
    return { type: 'click_entity', entity: readStringProp(block, 'entity') || 'CtaButton' };
  }
  if (type === 'compound' || triggers.length > 1) {
    return { type: 'compound', operator: 'and', triggers };
  }
  return triggers[0] || { type };
}

function inferPhaseOrdinal(name) {
  const text = String(name || '');
  const m = text.match(/(?:enter|init|setup|start)?Phase[_-]?(\d+)/i)
    || text.match(/phase[_-]?(\d+)(?:OnEnter|Enter|Init|Start|Setup)?/i);
  return m ? Number(m[1]) : null;
}

function parsePhasesFallback(reason) {
  spec.notes.push(reason);
  const candidates = [];

  function collectNamedFunction(name, bodyStart, offset) {
    const ordinal = inferPhaseOrdinal(name);
    if (!ordinal) return;
    const body = sliceBalanced(js, bodyStart, '{', '}');
    if (!body) return;
    candidates.push({ ordinal, offset, body, name });
  }

  let m;
  const fnDeclRe = /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  while ((m = fnDeclRe.exec(js)) !== null) {
    collectNamedFunction(m[1], js.indexOf('{', m.index + m[0].length - 1), m.index);
  }
  const arrowDeclRe = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*\{/g;
  while ((m = arrowDeclRe.exec(js)) !== null) {
    collectNamedFunction(m[1], js.indexOf('{', m.index + m[0].length - 1), m.index);
  }

  candidates
    .sort((a, b) => a.ordinal - b.ordinal || a.offset - b.offset)
    .forEach(c => pushPhaseFromBlock(c.body, c.offset, c.ordinal));

  if (spec.phases.length > 0) {
    spec.notes.push(`PASS1 fallback:function-name phases=${spec.phases.length}`);
    return;
  }

  const tipHits = [];
  const tipRe = /setTip\(\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*\)/g;
  while ((m = tipRe.exec(js)) !== null) tipHits.push({ offset: m.index });
  for (let i = 0; i < tipHits.length; i++) {
    const start = tipHits[i].offset;
    const end = i + 1 < tipHits.length ? tipHits[i + 1].offset : Math.min(js.length, start + 1800);
    pushPhaseFromBlock('{' + js.slice(start, end) + '}', start, i + 1);
  }
  if (spec.phases.length > 0) {
    spec.notes.push(`PASS1 fallback:setTip phases=${spec.phases.length}`);
    return;
  }

  pushPhaseFromBlock('{' + js.slice(0, Math.min(js.length, 12000)) + '}', 0, 1);
  spec.notes.push('PASS1 fallback:whole-script phases=1');
}

// ---------- PASS 2: 顶层函数定义抽取 ----------
function parseFunctions() {
  // 匹配 `function name(...) { ... }` 或 `const name = (...) => { ... }`
  const fnDeclRe = /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g;
  const arrowDeclRe = /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*\{/g;

  const found = [];
  let m;
  while ((m = fnDeclRe.exec(js)) !== null) {
    const bodyStart = js.indexOf('{', m.index + m[0].length - 1);
    const body = sliceBalanced(js, bodyStart, '{', '}');
    if (!body) continue;
    found.push({ name: m[1], args: m[2].trim(), body, offset: m.index, kind: 'function' });
  }
  while ((m = arrowDeclRe.exec(js)) !== null) {
    const bodyStart = js.indexOf('{', m.index + m[0].length - 1);
    const body = sliceBalanced(js, bodyStart, '{', '}');
    if (!body) continue;
    found.push({ name: m[1], args: m[2].trim(), body, offset: m.index, kind: 'arrow' });
  }

  // 只保留语义上"游戏逻辑"函数 — tick/spawn/start/on/make/update/handle 前缀
  const SEMANTIC_PREFIX = /^(tick|spawn|start|stop|on[A-Z]|make|update|handle|advance|enter|exit|init|setup|fire|trigger|reset|grow|sell|build|pick|drop|move|cast|render|draw|step)/;

  for (const f of found) {
    if (!SEMANTIC_PREFIX.test(f.name)) continue;
    spec.functions.push({
      name: f.name,
      args: f.args,
      lineStart: findLine(f.offset),
      bodySize: f.body.length,
      body: f.body,
      patterns: [],
      unityMethod: null,
    });
  }
  spec.notes.push(`PASS2: ${spec.functions.length} semantic functions`);
}
// ---------- PASS 3: 13 类 pattern → DSL + Unity 调用 ----------
function applyRules() {
  // 所有可分析的文本集合: phase block + 每个函数 body
  const targets = [
    ...spec.phases.map(p => ({ scope: `Phase_${p.id ?? p.index}`, body: p.body, sink: p })),
    ...spec.functions.map(f => ({ scope: f.name, body: f.body, sink: f })),
  ];

  for (const t of targets) {
    t.sink.patterns = t.sink.patterns || [];
    R1_positionAssign(t);
    R2_cameraDirect(t);
    R3_setTimeoutAdvance(t);
    R4_inventoryAdvance(t);
    R5_stateOps(t);
    R6_setTip(t);
    R7_sfx(t);
    R8_shockwave(t);
    R9_floatText(t);
    R10_sceneRemove(t);
    R11_factoryCalls(t);
    R12_threePrimitives(t);
    R13_cameraFlyTo(t);
    R14_pointerPhaseAdvance(t);
  }

  // 反向关联:function-scope R3 triggers → phase[toPhase-1].derivedTriggers
  // 含义:"被 Phase N-1 推进到 Phase N",落到 Phase N-1 的 outgoing 上更合理
  for (const ph of spec.phases) ph.derivedTriggers = [];
  for (const f of spec.functions) {
    for (const trg of (f.triggers || [])) {
      if (!trg.toPhase) continue;
      const fromIdx = trg.toPhase - 1 - 1; // toPhase 是 1-based 目标,from 是 toPhase-1,而 phases 数组下标 0-based
      const fromPhase = spec.phases.find(p => p.id === trg.toPhase - 1) || spec.phases[fromIdx];
      if (fromPhase) {
        fromPhase.derivedTriggers.push({ ...trg, viaFunction: f.name, viaLine: f.lineStart });
      }
    }
  }

  // 把每个 function 的 patterns 折叠成 unityMethod 草稿
  for (const f of spec.functions) {
    f.unityMethod = synthesizeUnityMethod(f);
  }
  spec.notes.push(`PASS3: applied 14 rule classes to ${targets.length} scopes`);
}

// === R1: obj.position.x/y/z += / -= → SmoothMover ===
function R1_positionAssign(t) {
  const re = /([a-zA-Z_$][\w$.]*)\.position\.([xyz])\s*([+\-]?=)\s*([^;]+);/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const [_, obj, axis, op, rhs] = m;
    if (/^camera\b/.test(obj)) continue; // 相机走 R2
    t.sink.patterns.push({
      rule: 'R1',
      verb: 'move',
      target: obj,
      axis, op, rhs: rhs.trim(),
      risk: op !== '=' ? null : 'player-teleport-in-update',
      unity: `// ${obj} ${axis}-axis ${op} ${rhs.trim()}\nGFM_SmoothMover.MoveTo(${obj}.gameObject, new Vector3(/* target */), /* duration */);`,
    });
  }
}

// === R2: camera.position.lerp/copy/set/直写 → CameraController ===
function R2_cameraDirect(t) {
  const patterns = [
    { re: /camera\.position\.lerp\s*\(([^)]+)\)/g,    api: 'MoveTo' },
    { re: /camera\.position\.copy\s*\(([^)]+)\)/g,    api: 'MoveTo' },
    { re: /camera\.position\.set\s*\(([^)]+)\)/g,     api: 'SetCameraHeight' },
    { re: /camera\.position\.[xyz]\s*[+\-]?=\s*([^;]+);/g, api: 'Shake', gap: 'shake' },
    { re: /camera\.lookAt\s*\(([^)]+)\)/g,            api: 'LookAt' },
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(t.body)) !== null) {
      if (p.gap) gapsUsed.add(p.gap);
      t.sink.patterns.push({
        rule: 'R2',
        verb: p.gap ? 'shake' : 'framepoint',
        api: p.api,
        argsRaw: m[1] || '',
        unity: p.gap
          ? `GFM_CameraController.Instance.Shake(/* intensity */, /* duration */); // TODO GFM gap`
          : `GFM_CameraController.Instance.${p.api}(${m[1] || ''});`,
      });
    }
  }
}

// === R3: setTimeout(advancePhase, N) → dwell trigger ===
// 兼容尾注释 `// → Phase N` 抽出 toPhase
function R3_setTimeoutAdvance(t) {
  const re = /setTimeout\s*\(\s*(?:\(\s*\)\s*=>\s*)?(?:advancePhase|enterPhase\([^)]*\))[^,]*,\s*(\d+)\s*\)\s*;?\s*(?:\/\/\s*(?:→|->|=>)?\s*Phase\s*(\d+)[^\n]*)?/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const sec = (+m[1] / 1000).toFixed(2);
    const toPhase = m[2] ? +m[2] : null;
    t.sink.triggers = t.sink.triggers || [];
    t.sink.triggers.push({ kind: 'dwell', durationSec: +sec, toPhase, dsl: `dwell:${sec}s${toPhase ? ` → Phase ${toPhase}` : ''}` });
    t.sink.patterns.push({ rule: 'R3', verb: 'phaseTrigger', durationSec: +sec, toPhase, dsl: `dwell:${sec}s${toPhase ? ` → Phase ${toPhase}` : ''}` });
  }
}

// === R4: if (state.X >= N) advancePhase() → inventory trigger ===
function R4_inventoryAdvance(t) {
  const re = /if\s*\(\s*state\.([a-zA-Z_$][\w$]*)\s*([><=!]+)\s*(-?\d+(?:\.\d+)?)\s*\)\s*\{?\s*(?:advancePhase|enterPhase)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const [_, key, op, n] = m;
    const res = normalizeRes(key);
    t.sink.triggers = t.sink.triggers || [];
    t.sink.triggers.push({ kind: 'inventory', resource: res.id, op, value: +n, dsl: `inventory:${res.id}:${op}${n}` });
    t.sink.patterns.push({ rule: 'R4', verb: 'phaseTrigger', dsl: `inventory:${res.id}:${op}${n}` });
  }
}

// === R5: state.X += / -= / = N → EconomyManager.AddResource ===
function R5_stateOps(t) {
  // op 必须不是 ==/===/<=/>= 比较 — 用负前瞻 + 排除前导 < > ! =
  const re = /(?<![<>=!])(?:state|_res|resources|inventory)\.([a-zA-Z_$][\w$]*)\s*([+\-]?=)(?!=)\s*([^;]+);/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const [_, key, op, rhs] = m;
    const prev = t.body[m.index - 1] || '';
    if (/[A-Za-z0-9_$.]/.test(prev)) continue;
    if (isFlagKey(key)) continue;
    if (op === '=' && !/^-?\d+(?:\.\d+)?$/.test(rhs.trim())) continue;
    const res = normalizeRes(key);
    if (res.kind === 'flag') continue;
    const delta = op === '+=' ? rhs.trim() : op === '-=' ? `-(${rhs.trim()})` : rhs.trim();
    const api = res.kind === 'currency' ? 'AddGold' : 'AddResource';
    const call = res.kind === 'currency'
      ? `GFM_EconomyManager.Instance.AddGold(${delta});`
      : `GFM_EconomyManager.Instance.AddResource("${res.id}", ${delta});`;
    t.sink.patterns.push({ rule: 'R5', verb: 'econ', resource: res.id, op, rhs: rhs.trim(), unity: call });
  }
}

// === R6: setTip → TipsManager.Show ===
function R6_setTip(t) {
  const re = /setTip\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\d+)\s*\)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const sec = (+m[2] / 1000).toFixed(2);
    t.sink.patterns.push({
      rule: 'R6', verb: 'tip', text: m[1], durationSec: +sec,
      unity: `GFM_TipsManager.Show("${m[1]}", ${sec}f);`,
    });
  }
}

// === R7: SFX.X() / sfx() → Audio Asset Map → PlaySFX ===
function R7_sfx(t) {
  const calls = [];
  const re = /\bSFX\.([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(t.body)) !== null) calls.push(m[1]);
  const namedRe = /\b(?:playSound|playSfx|playAudio|audio\.play|sfx\.play)\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = namedRe.exec(t.body)) !== null) calls.push(m[1]);
  for (const name of calls) {
    const clip = mapSfx(name);
    t.sink.patterns.push({
      rule: 'R7', verb: 'sfx', name, clip,
      unity: `GFM_Audio.Instance.PlaySFX(${clip});`,
    });
  }
}
// === R8: spawnShockwave(pos, color, maxR) → VisualGuide.Shockwave ===
function R8_shockwave(t) {
  const re = /spawnShockwave\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    gapsUsed.add('shockwave');
    t.sink.patterns.push({
      rule: 'R8', verb: 'fx', kind: 'shockwave', argsRaw: m[1],
      unity: `GFM_VisualGuide.Shockwave(${m[1]}); // TODO GFM gap`,
    });
  }
}

// === R9: spawnFloatText(pos, text, color) → UIManager.ShowFloatingText ===
function R9_floatText(t) {
  const re = /spawnFloatText\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    t.sink.patterns.push({
      rule: 'R9', verb: 'fx', kind: 'floatText', argsRaw: m[1],
      unity: `GFM_UIManager.Instance.ShowFloatingText(${m[1]});`,
    });
  }
}

// === R10: scene.remove(x) / xs.splice 等 → GFM_Pool.Return ===
function R10_sceneRemove(t) {
  const re = /scene\.remove\s*\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    t.sink.patterns.push({
      rule: 'R10', verb: 'despawn', target: m[1].trim(),
      unity: `GFM_Pool.Return(${m[1].trim()}); // 优先 pool,否则 Destroy(${m[1].trim()})`,
    });
  }
}

// === R11: makePerson/makeHero/spawnHelper 工厂 → GFM_NpcManager / GFM_Player ===
function R11_factoryCalls(t) {
  const re = /\b((?:make|spawn|create)[A-Z][A-Za-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const fn = m[1];
    const pattern = matchFactoryPattern(fn);
    const api = pattern ? pattern.api : 'SpawnNpc';
    const templateId = pattern ? pattern.templateId : fn.replace(/^(make|spawn|create)/, '');
    const primitive = pattern ? pattern.primitive : 'Cube';
    if (!pattern) unknownFactories.add(fn);
    t.sink.patterns.push({
      rule: 'R11', verb: 'spawn', factory: fn, api, templateId,
      unity: api === 'CreateObstacle'
        ? `var ${templateId.toLowerCase()} = GFM_Create.Obj(PrimitiveType.${primitive}, /* pos */, /* scale */, "${templateId}");`
        : `GFM_NpcManager.Instance.${api}("${templateId}", /* pos */);`,
    });
  }
}

// === R12: new THREE.XGeometry/Material/Mesh → GFM_Create.Obj + Material ===
function R12_threePrimitives(t) {
  const geomRe = /new\s+THREE\.(Box|Cylinder|Sphere|Icosahedron|Octahedron|Cone|Plane|Ring|Torus|Tetrahedron)Geometry\s*\(/g;
  let m;
  while ((m = geomRe.exec(t.body)) !== null) {
    const shape = m[1];
    const prim = ({ Box: 'Cube', Cylinder: 'Cylinder', Sphere: 'Sphere', Icosahedron: 'Sphere', Octahedron: 'Sphere', Tetrahedron: 'Sphere', Cone: 'Cone(prefab)', Plane: 'Plane', Ring: 'RingFlat(prefab)', Torus: 'Torus(prefab)' })[shape];
    t.sink.patterns.push({
      rule: 'R12', verb: 'create', shape, primitive: prim,
      unity: `var obj = GFM_Create.Obj(PrimitiveType.${prim.includes('(') ? 'Cube' : prim}, /* pos */, /* scale */, "/* label */"); // ${shape}Geometry`,
    });
  }
  const matRe = /new\s+THREE\.Mesh(Lambert|Basic|Physical|Standard)Material\s*\(\s*\{([^}]*)\}/g;
  while ((m = matRe.exec(t.body)) !== null) {
    const colorM = m[2].match(/color\s*:\s*(0x[0-9a-fA-F]+|['"]#?[0-9a-fA-F]+['"])/);
    const color = colorM ? colorM[1].replace(/^0x/, '#').replace(/['"]/g, '') : null;
    t.sink.patterns.push({
      rule: 'R12', verb: 'material', matKind: m[1], color,
      unity: color ? `GFM_Create.SetColor(obj, ColorFromHex("#${color.replace(/^#/, '')}"));` : '/* material set */',
    });
  }
}

// === R13: cameraFlyTo(target, dur) → GFM_CameraController.FramePoint ===
function R13_cameraFlyTo(t) {
  const re = /cameraFlyTo\s*\(([^,)]+)(?:,\s*([\d.]+))?\s*\)/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    t.sink.patterns.push({
      rule: 'R13', verb: 'framepoint', target: m[1].trim(), durSec: m[2] ? +m[2] : null,
      unity: `GFM_CameraController.Instance.FramePoint(${m[1].trim()}, /* orthoSize */ 8f);`,
    });
  }
}

// === R14: onPointerDown / click handler 中 state.phase === N → advancePhase ===
function R14_pointerPhaseAdvance(t) {
  const isPointerScope = /pointer|click|tap/i.test(t.scope || '') || /onPointerDown|pointerdown|click/i.test(t.body || '');
  if (!isPointerScope) return;
  const re = /if\s*\(\s*state\.phase\s*(?:===|==)\s*(\d+)\s*\)\s*\{?([\s\S]{0,800}?)(?:advancePhase|enterPhase)\s*\(/g;
  let m;
  while ((m = re.exec(t.body)) !== null) {
    const fromPhase = +m[1];
    const toPhase = fromPhase + 1;
    const dsl = `click_phase:${fromPhase}->${toPhase}`;
    t.sink.triggers = t.sink.triggers || [];
    t.sink.triggers.push({ kind: 'click', fromPhase, toPhase, dsl });
    t.sink.patterns.push({
      rule: 'R14', verb: 'phaseTrigger', kind: 'click', fromPhase, toPhase, dsl,
      unity: `// click_entity:CtaButton 推进 Phase ${fromPhase} → Phase ${toPhase}`,
    });
  }
}

// === 合成 unityMethod 草稿 ===
function synthesizeUnityMethod(f) {
  const pats = f.patterns || [];
  if (pats.length === 0) return null;
  const lines = [`// [ASSEMBLY SLOT] ${f.name} — auto-translated from HTML`];
  lines.push(`void ${pascal(f.name)}() {`);
  for (const p of pats.slice(0, 30)) {
    if (p.unity) lines.push('    ' + p.unity.split('\n').join('\n    '));
    else if (p.dsl) lines.push(`    // phaseTrigger DSL: ${p.dsl}`);
  }
  if (pats.length > 30) lines.push(`    // ...${pats.length - 30} more patterns elided`);
  lines.push('}');
  return lines.join('\n');
}
function pascal(s) { return s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase()); }
// ---------- PASS 4: resources from R5 patterns ----------
function buildResources() {
  const seen = new Map();
  const allPats = [
    ...spec.phases.flatMap(p => p.patterns || []),
    ...spec.functions.flatMap(f => f.patterns || []),
  ];
  for (const p of allPats) {
    if (p.rule !== 'R5') continue;
    // 跳过 flag 类(从 normalizeRes 返回 kind:'flag')
    const meta = Object.values(STATE_TO_RESOURCE).find(r => r.id === p.resource);
    if (!meta) {
      // 反查 source key 看是否 flag
      const srcKey = Object.keys(STATE_TO_RESOURCE).find(k => STATE_TO_RESOURCE[k].id === p.resource);
      if (!srcKey && isFlagKey(p.resource.charAt(0).toLowerCase() + p.resource.slice(1))) continue;
    }
    if (!seen.has(p.resource)) {
      const finalMeta = meta || { id: p.resource, kind: 'consumable', ui: p.resource, icon: p.resource };
      seen.set(p.resource, { ...finalMeta, firstUsedRule: 'R5', sample: p.unity });
    }
  }
  // 也从 R4 inventory triggers 收
  for (const ph of spec.phases) for (const t of (ph.triggers || [])) {
    if (t.kind === 'inventory' && !seen.has(t.resource)) {
      const meta = Object.values(STATE_TO_RESOURCE).find(r => r.id === t.resource) || { id: t.resource, kind: 'consumable', ui: t.resource, icon: t.resource };
      seen.set(t.resource, { ...meta, firstUsedRule: 'R4' });
    }
  }
  // storyboard2html v1 PHASES trigger contract can declare resources without
  // using legacy state.X mutation syntax.
  function visitTrigger(trigger) {
    if (!trigger || typeof trigger !== 'object') return;
    if (trigger.type === 'compound') return (trigger.triggers || []).forEach(visitTrigger);
    if (trigger.type === 'resource_collected' && trigger.resource && !seen.has(trigger.resource)) {
      const meta = Object.values(STATE_TO_RESOURCE).find(r => r.id === trigger.resource) || { id: trigger.resource, kind: 'consumable', ui: trigger.resource, icon: trigger.resource };
      seen.set(trigger.resource, { ...meta, firstUsedRule: 'PHASES.trigger' });
    }
  }
  for (const ph of spec.phases) visitTrigger(ph.contractTrigger);
  spec.resources = [...seen.values()];
  spec.notes.push(`PASS4: ${spec.resources.length} resources`);
}

// ---------- PASS 5: gaps → spec.gfmGaps ----------
function collectGaps() {
  spec.gfmGaps = [...gapsUsed].map(k => ({ key: k, suggestedApi: GFM_GAPS[k] || '(unknown)' }));
  if (unknownFactories.size > 0) {
    const list = [...unknownFactories].sort();
    spec.notes.push(`R11 unmatched factories: ${list.join(', ')}`);
    console.error(`[demo2spec] R11 unmatched factories: ${list.join(', ')}`);
  }
}

// ---------- PASS 6: 写 spec-v3.json + spec-v3.md ----------
function buildOutputs() {
  collectGaps();

  const htmlPhaseSlices = {};
  for (let i = 0; i < spec.phases.length; i++) {
    htmlPhaseSlices[`phase${i + 1}`] = spec.phases[i].body || '';
  }
  fs.writeFileSync(path.join(OUT_DIR, 'html-phase-slices.json'), JSON.stringify(htmlPhaseSlices, null, 2));

  const sourceEntityNames = collectEntityNamesFromHtml(fullText);
  const entityNames = uniq(spec.phases.flatMap(p => p.showEntities || []).concat(sourceEntityNames));
  const assetManifest = extractVisualAssetManifest(fullText, {
    source: SRC,
    project: PROJECT_NAME,
    entityNames,
  });
  const readiness = validateVisualAssetReadiness(assetManifest, {
    minExtractedMeshRate: 0.9,
    minAssetBindingRate: sourceEntityNames.length ? 0.9 : 0,
    minEntityBindingRate: sourceEntityNames.length ? 0.7 : null,
    minExpectedEntityCoverageRate: sourceEntityNames.length ? 0.9 : null,
    expectedEntities: sourceEntityNames,
  });
  if (!readiness.passed) {
    console.error('[demo2spec] visual asset readiness failed:');
    console.error(JSON.stringify(readiness.violations, null, 2));
    process.exit(1);
  }
  writeVisualAssetManifest(path.join(OUT_DIR, 'asset-manifest.json'), assetManifest);
  spec.entities = entityNames.map(name => {
    const binding = assetManifest.entityBindings && assetManifest.entityBindings[name];
    return {
      name,
      visualAssetIds: binding ? binding.assetIds : [],
      primaryAssetId: binding ? binding.primaryAssetId : null,
      source: assetManifest.sourceEntityContract && assetManifest.sourceEntityContract.entities.indexOf(name) >= 0 ? 'source_html' : 'phase_showEntities',
    };
  });

  // 精简 phases/functions(剥掉 body 大文本)
  const slim = JSON.parse(JSON.stringify(spec));
  slim.meta.htmlPhaseSlicesPath = 'html-phase-slices.json';
  slim.meta.assetManifestPath = 'asset-manifest.json';
  slim.visualAssetSummary = assetManifest.extractionSummary;
  for (const p of slim.phases) delete p.body;
  for (const f of slim.functions) delete f.body;

  fs.writeFileSync(path.join(OUT_DIR, 'spec.json'), JSON.stringify(slim, null, 2));

  // markdown 报告
  const md = renderMarkdown(slim);
  fs.writeFileSync(path.join(OUT_DIR, 'spec.md'), md);

  console.log(`✅ ${path.join(OUT_DIR, 'spec.json')} (${spec.phases.length} phases, ${spec.functions.length} fns, ${spec.resources.length} resources, ${spec.gfmGaps.length} gaps)`);
  console.log(`✅ ${path.join(OUT_DIR, 'html-phase-slices.json')}`);
  console.log(`✅ ${path.join(OUT_DIR, 'asset-manifest.json')} (${assetManifest.assets.length} assets, bindingRate=${assetManifest.extractionSummary.assetBindingRate})`);
  console.log(`✅ ${path.join(OUT_DIR, 'spec.md')}`);
}

function renderMarkdown(s) {
  const allPats = [...s.phases.flatMap(p => p.patterns || []), ...s.functions.flatMap(f => f.patterns || [])];
  const ruleHits = {};
  for (const p of allPats) ruleHits[p.rule] = (ruleHits[p.rule] || 0) + 1;

  const lines = [];
  lines.push(`# ${s.meta.project} — demo2spec ${s.meta.extractor}`);
  lines.push(``);
  lines.push(`- 源文件: \`${s.meta.src}\``);
  lines.push(`- 生成: ${s.meta.generatedAt}`);
  lines.push(``);
  lines.push(`## 统计`);
  lines.push(``);
  lines.push(`| 维度 | 数量 |`);
  lines.push(`|---|---|`);
  lines.push(`| Phases | ${s.phases.length} |`);
  lines.push(`| 语义函数 | ${s.functions.length} |`);
  lines.push(`| Resource | ${s.resources.length} |`);
  lines.push(`| Pattern 总数 | ${allPats.length} |`);
  lines.push(`| GFM 缺口 | ${s.gfmGaps.length} |`);
  lines.push(``);
  lines.push(`### Rule 命中分布`);
  lines.push(``);
  lines.push(`| Rule | 命中 |`);
  lines.push(`|---|---|`);
  for (const r of Object.keys(ruleHits).sort()) lines.push(`| ${r} | ${ruleHits[r]} |`);
  lines.push(``);

  lines.push(`## Resources`);
  lines.push(``);
  if (s.resources.length === 0) lines.push(`_(无)_`);
  else {
    lines.push(`| ID | 类型 | UI | 首次出现 |`);
    lines.push(`|---|---|---|---|`);
    for (const r of s.resources) lines.push(`| ${r.id} | ${r.kind} | ${r.ui} | ${r.firstUsedRule} |`);
  }
  lines.push(``);

  lines.push(`## Phases`);
  lines.push(``);
  for (const p of s.phases) {
    lines.push(`### Phase ${p.id ?? p.index}`);
    if (p.tip) lines.push(`- 提示: "${p.tip}" (${p.tipDurationMs}ms)`);
    if (p.durRaw) lines.push(`- 时长: \`${p.durRaw}\``);
    if (p.triggers && p.triggers.length) lines.push(`- Triggers (本 phase 内): ${p.triggers.map(t => `\`${t.dsl}\``).join(', ')}`);
    if (p.derivedTriggers && p.derivedTriggers.length) lines.push(`- 出口 (来自函数): ${p.derivedTriggers.map(t => `\`${t.dsl}\` (in \`${t.viaFunction}\`:${t.viaLine})`).join(', ')}`);
    if (p.patterns && p.patterns.length) lines.push(`- Patterns: ${p.patterns.length}`);
    lines.push(``);
  }

  lines.push(`## 语义函数 → Unity Method 草稿`);
  lines.push(``);
  for (const f of s.functions) {
    if (!f.unityMethod) continue;
    lines.push(`### ${f.name}() — line ${f.lineStart}`);
    lines.push(`- Patterns: ${(f.patterns || []).length}`);
    lines.push('```csharp');
    lines.push(f.unityMethod);
    lines.push('```');
    lines.push(``);
  }

  lines.push(`## GFM 缺口(需新增 API)`);
  lines.push(``);
  if (s.gfmGaps.length === 0) lines.push(`_(无)_`);
  else {
    lines.push(`| Key | 建议 API |`);
    lines.push(`|---|---|`);
    for (const g of s.gfmGaps) lines.push(`| ${g.key} | \`${g.suggestedApi}\` |`);
  }
  lines.push(``);

  lines.push(`## Notes`);
  lines.push(``);
  for (const n of s.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

run();
