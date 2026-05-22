'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'storyboard2html-html-contract.v1.json');
var DEFAULT_DEMO2SPEC_SKILL_ROOT = '/root/.claude/skills/demo2spec';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadContract(explicitPath) {
  var contractPath = explicitPath || process.env.STORYBOARD2HTML_CONTRACT_FILE || DEFAULT_CONTRACT_PATH;
  return readJson(contractPath);
}

function validateContract(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('storyboard2html contract must be an object');
  }
  if (doc.schemaVersion !== '1.0.0') {
    throw new Error('unsupported storyboard2html contract schemaVersion: ' + doc.schemaVersion);
  }
  if (doc.kind !== 'blueprint.storyboard2html.htmlContract') {
    throw new Error('invalid storyboard2html contract kind: ' + doc.kind);
  }
  if (!doc.htmlStaticEntry || !Array.isArray(doc.htmlStaticEntry.requiredGlobals)) {
    throw new Error('storyboard2html contract missing htmlStaticEntry.requiredGlobals');
  }
  if (!doc.runtimeStateContract || doc.runtimeStateContract.globalName !== 'window.__gameState') {
    throw new Error('storyboard2html contract missing runtimeStateContract.globalName');
  }
  if (!doc.phaseEvidenceEnvelope || !doc.phaseEvidenceEnvelope.requiredModuleMeta) {
    throw new Error('storyboard2html contract missing phaseEvidenceEnvelope.requiredModuleMeta');
  }
  if (doc.phaseEvidenceEnvelope.requiredModuleMeta['_meta.schemaVersion'] !== '1.0.0') {
    throw new Error('storyboard2html contract must require _meta.schemaVersion=1.0.0');
  }
  if (doc.phaseEvidenceEnvelope.requiredModuleMeta['_meta.sourcePlatform'] !== 'html') {
    throw new Error('storyboard2html contract must require _meta.sourcePlatform=html');
  }
  return true;
}

function normalizeFrame(frame, index) {
  frame = frame || {};
  return {
    index: index,
    id: frame.id || frame.frameId || frame.shotId || ('frame' + (index + 1)),
    title: frame.title || frame.name || '',
    interaction: frame.interaction || frame.action || '',
    ui: frame.ui || frame.guide || frame.caption || '',
    camera: frame.camera || null,
    duration: frame.duration || frame.durationSec || null,
    image: frame.image || frame.imageUrl || frame.asset || null,
    note: frame.note || frame.description || '',
  };
}

function normalizeSpec(spec, index) {
  spec = spec || {};
  return {
    index: index,
    phaseId: spec.phaseId || ('phase' + (index + 1)),
    phaseName: spec.phaseName || spec.name || spec.title || spec.phaseId || ('phase' + (index + 1)),
    requiredInteractions: safeArray(spec.requiredInteractions),
    entitiesRequired: safeArray(spec.entitiesRequired),
    playerInstruction: spec.playerInstruction || spec.guideText || '',
    autoModeHint: spec.autoModeHint || '',
    guideText: spec.guideText || spec.playerInstruction || spec.autoModeHint || '',
    goal: spec.goal || null,
    plannedModuleIds: safeArray(spec.plannedModuleIds || spec.plannedModules),
    trigger: spec.trigger || null,
    triggerNext: spec.triggerNext || null,
    duration: spec.duration || null,
  };
}

function normalizeEntity(entity) {
  entity = entity || {};
  return {
    name: entity.name || '',
    label: entity.label || entity.chineseName || entity.name || '',
    template: entity.template || '',
    visual: entity.visual || null,
    behavior: entity.behavior || null,
  };
}

function collectResources(bp) {
  if (Array.isArray(bp.resources)) return clone(bp.resources);
  if (bp.gameSchema && Array.isArray(bp.gameSchema.resources)) return clone(bp.gameSchema.resources);
  return [];
}

function resolveStoryboardFrames(bp) {
  if (bp.storyboard && Array.isArray(bp.storyboard.frames) && bp.storyboard.frames.length > 0) {
    return bp.storyboard.frames;
  }
  if (Array.isArray(bp.storyboardFrames) && bp.storyboardFrames.length > 0) {
    return bp.storyboardFrames;
  }
  return [];
}

function inferThemeHint(bp, options) {
  options = options || {};
  if (options.themeHint) return options.themeHint;
  if (bp.themeHint) return bp.themeHint;
  if (bp.theme) return bp.theme;
  var gameType = String(bp.gameType || '').toLowerCase();
  if (gameType.indexOf('farm') >= 0) return 'farming';
  if (gameType.indexOf('tower') >= 0 || gameType.indexOf('td') >= 0) return 'tower-defense';
  var joined = JSON.stringify({
    entities: bp.entities || [],
    resources: collectResources(bp),
    specs: bp.specs || [],
  }).toLowerCase();
  if (/(corn|wood|farm|crop|harvest|farmer)/.test(joined)) return 'farming';
  if (/(tower|turret|alien|enemy|homehp|defense|projectile)/.test(joined)) return 'tower-defense';
  return 'default';
}

function buildAcceptancePlan(options) {
  options = options || {};
  var skillRoot = options.demo2specSkillRoot || process.env.DEMO2SPEC_SKILL_ROOT || DEFAULT_DEMO2SPEC_SKILL_ROOT;
  var steps = Number(options.steps || process.env.STORYBOARD2HTML_VERIFY_STEPS || 40) || 40;
  var themeHint = options.themeHint || '<themeHint>';
  var outDir = options.outDir || '<outdir>';
  var htmlPath = options.htmlPath || '<generated.html>';
  var args = [
    process.execPath,
    path.join(skillRoot, 'index.js'),
    htmlPath,
    outDir,
    '--theme',
    themeHint,
    '--blueprint-smoke',
    '--verify',
    '--steps',
    String(steps),
  ];
  return {
    demo2specSkillRoot: skillRoot,
    command: args,
    hardGates: [
      'snapshot-schema validates',
      'phaseEvidenceSummary.validation.passed === true',
      'phaseEvidenceSummary.aggregate.triggeredPresentFullRate === 1',
      'phaseEvidenceSummary.aggregate.triggeredAntiAutoplayHeldRate === 1',
      'phaseCoverage completed count equals expected phase count',
    ],
  };
}

function buildStoryboard2HtmlInput(blueprint, options) {
  options = options || {};
  var bp = blueprint && blueprint.blueprint ? blueprint.blueprint : (blueprint || {});
  var specs = safeArray(bp.specs);
  if (specs.length === 0) {
    throw new Error('storyboard2html input requires ctx.blueprint.specs from spec-extract');
  }
  var contract = options.contract || loadContract(options.contractPath);
  validateContract(contract);
  var themeHint = inferThemeHint(bp, options);
  var frames = resolveStoryboardFrames(bp);
  return {
    schemaVersion: '1.0.0',
    kind: 'blueprint.storyboard2html.input',
    projectName: bp.projectName || bp.name || options.projectName || 'storyboard2html',
    themeHint: themeHint,
    specs: specs.map(normalizeSpec),
    storyboardFrames: frames.map(normalizeFrame),
    entities: safeArray(bp.entities).map(normalizeEntity),
    resources: collectResources(bp),
    htmlContract: contract,
    acceptancePlan: buildAcceptancePlan({
      demo2specSkillRoot: options.demo2specSkillRoot,
      steps: options.steps,
      themeHint: themeHint,
      htmlPath: options.htmlPath,
      outDir: options.outDir,
    }),
  };
}

module.exports = {
  DEFAULT_CONTRACT_PATH: DEFAULT_CONTRACT_PATH,
  DEFAULT_DEMO2SPEC_SKILL_ROOT: DEFAULT_DEMO2SPEC_SKILL_ROOT,
  loadContract: loadContract,
  validateContract: validateContract,
  buildAcceptancePlan: buildAcceptancePlan,
  buildStoryboard2HtmlInput: buildStoryboard2HtmlInput,
  _internals: {
    inferThemeHint: inferThemeHint,
    normalizeFrame: normalizeFrame,
    normalizeSpec: normalizeSpec,
  },
};
