'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'storyboard2html-html-contract.v1.json');
var DEFAULT_DEMO2SPEC_SKILL_ROOT = '/root/.claude/skills/demo2spec';
var VERIFY_RUNNERS = { direct: true, production: true };

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeVerifyRunner(value) {
  var runner = String(value || process.env.STORYBOARD2HTML_VERIFY_RUNNER || 'production').trim() || 'production';
  if (!VERIFY_RUNNERS[runner]) {
    throw new Error('Unknown storyboard2html verify runner "' + runner + '" (expected direct|production)');
  }
  return runner;
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

function cleanEntityName(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  return text.split(':')[0].trim();
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function firstPhaseTarget(phase, conditionTarget) {
  if (conditionTarget) return conditionTarget;
  var candidates = safeArray(phase && phase.activate).map(cleanEntityName).filter(Boolean);
  for (var i = 0; i < candidates.length; i += 1) {
    if (!/^(Player|GuideText|HUD|Camera)$/i.test(candidates[i])) return candidates[i];
  }
  return candidates[0] || 'CtaButton';
}

function normalizeResourceName(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parsePhaseCondition(phase, index, phaseCount) {
  var condition = String(phase && (phase.endCondition || phase.triggerNext || phase.trigger || '') || '').trim();
  var isFinal = index === phaseCount - 1;
  var target = '';
  var requiredInteractions = [];
  var trigger = null;
  var moduleHints = [];
  var match;

  if (isFinal && (/CTAButton\.clicked/i.test(condition) || /\bCTAButton\b/i.test(safeArray(phase && phase.activate).join(',')) || /^none$/i.test(condition))) {
    target = 'CTAButton';
    requiredInteractions.push('click:CTAButton');
    trigger = { type: 'click_entity', entity: 'CTAButton' };
    moduleHints.push('click_trigger', 'player_input_tap', 'cta_finish');
  } else if ((match = condition.match(/global:([A-Za-z0-9_]+)\s*>=\s*(\d+)/i))) {
    var resource = normalizeResourceName(match[1]);
    var amount = Number(match[2]) || 1;
    target = firstPhaseTarget(phase, '');
    requiredInteractions.push('collect:' + resource + ':' + amount);
    trigger = { type: 'resource_collected', resource: resource, amount: amount };
    moduleHints.push('collect_on_near', 'inventory_wallet');
  } else if ((match = condition.match(/entity:([A-Za-z0-9_]+)\.state\s*==\s*([A-Za-z0-9_]+)/i))) {
    target = match[1];
    requiredInteractions.push((/built/i.test(match[2]) ? 'build:' : 'near:') + target);
    trigger = { type: 'entity_state_reached', entity: target, state: /built|active|upgraded/i.test(match[2]) ? 2 : 1 };
    moduleHints.push(/built/i.test(match[2]) ? 'build_progress' : 'activate_targets');
  } else if ((match = condition.match(/entity:([A-Za-z0-9_]+)\.level\s*==\s*(\d+)/i))) {
    target = match[1];
    requiredInteractions.push('upgrade:' + target + ':' + match[2]);
    trigger = { type: 'entity_state_reached', entity: target, state: Number(match[2]) || 1 };
    moduleHints.push('upgrade_progress', 'cost_gate');
  } else if ((match = condition.match(/entity:([A-Za-z0-9_]+)\.hp\s*<=\s*(\d+)/i))) {
    target = match[1];
    requiredInteractions.push('attack:' + target);
    trigger = { type: 'entity_state_reached', entity: target, state: 0 };
    moduleHints.push('target_acquire', 'damageable', 'apply_damage');
  } else if ((match = condition.match(/count:([A-Za-z0-9_]+)\.state\s*==\s*dead\s*>=\s*(\d+)/i))) {
    target = firstPhaseTarget(phase, match[1]);
    requiredInteractions.push('defeat:' + match[1] + ':' + match[2]);
    trigger = { type: 'entity_state_reached', entity: match[1], state: 0 };
    moduleHints.push('target_acquire', 'damageable', 'apply_damage', 'on_death_drop');
  } else if ((match = condition.match(/event:([A-Za-z0-9_-]+)/i))) {
    target = firstPhaseTarget(phase, '');
    requiredInteractions.push('near:' + target);
    trigger = { type: 'near_entity', entity: target, range: 2 };
    moduleHints.push('phase_gate_timer');
  } else {
    target = firstPhaseTarget(phase, isFinal ? 'CTAButton' : '');
    requiredInteractions.push((isFinal && target === 'CTAButton') ? 'click:CTAButton' : 'near:' + target);
    trigger = (isFinal && target === 'CTAButton') ? { type: 'click_entity', entity: 'CTAButton' } : { type: 'near_entity', entity: target, range: 2 };
    if (isFinal && target === 'CTAButton') moduleHints.push('click_trigger', 'player_input_tap', 'cta_finish');
  }

  if (!isFinal && trigger && trigger.type === 'click_entity') {
    trigger = { type: 'near_entity', entity: target || firstPhaseTarget(phase, ''), range: 2 };
  }
  return {
    target: target || firstPhaseTarget(phase, ''),
    requiredInteractions: requiredInteractions,
    trigger: trigger,
    moduleHints: moduleHints,
  };
}

function deriveSpecsFromPhases(bp) {
  var phases = safeArray(bp && bp.phases);
  return phases.map(function(phase, index) {
    phase = phase || {};
    var parsed = parsePhaseCondition(phase, index, phases.length);
    var isFinal = index === phases.length - 1;
    var activateEntities = safeArray(phase.activate).map(cleanEntityName).filter(Boolean);
    if (parsed.target) activateEntities.push(parsed.target);
    var planned = ['guide_ui', 'visual_binding', 'player_input_joystick', 'move_to_target', 'proximity_trigger']
      .concat(parsed.moduleHints);
    if (isFinal && planned.indexOf('cta_finish') < 0) planned.push('cta_finish');
    return {
      phaseId: 'phase' + (index + 1),
      phaseName: phase.name || phase.title || ('phase' + (index + 1)),
      requiredInteractions: uniqueStrings(parsed.requiredInteractions),
      entitiesRequired: uniqueStrings(activateEntities).map(function(name) { return { name: name }; }),
      playerInstruction: phase.guide || phase.guideText || phase.name || '',
      autoModeHint: phase.guide || phase.guideText || '',
      guideText: phase.guide || phase.guideText || '',
      plannedModuleIds: uniqueStrings(planned),
      trigger: parsed.trigger,
      duration: { min: 10, max: 15 },
    };
  });
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
  var resources = [];
  safeArray(bp.phases).forEach(function(phase) {
    var match = String(phase && phase.endCondition || '').match(/global:([A-Za-z0-9_]+)\s*>=/i);
    if (match) resources.push({ name: normalizeResourceName(match[1]), entity: null });
  });
  if (resources.length) return uniqueStrings(resources.map(function(resource) { return resource.name; })).map(function(name) {
    return { name: name, entity: null };
  });
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
  var verifyRunner = normalizeVerifyRunner(options.verifyRunner);
  var themeHint = options.themeHint || '<themeHint>';
  var outDir = options.outDir || '<outdir>';
  var htmlPath = options.htmlPath || '<generated.html>';
  var smokeOutDir = path.join(outDir, 'blueprint-smoke');
  var snapshotSchemaPath = path.join(outDir, 'snapshot-schema.json');
  var playableSceneIrPath = path.join(outDir, 'playable-scene-ir.json');
  var preflightReportPath = path.join(outDir, 'storyboard2html-preflight.json');
  var verifyReportPath = path.join(smokeOutDir, 'unity-verify-report.json');
  var verifySummaryPath = path.join(smokeOutDir, 'unity-verify-summary.json');
  var flowManifestPath = path.join(outDir, 'playable-flow-manifest.json');
  var args = [
    process.execPath,
    path.join(skillRoot, 'index.js'),
    htmlPath,
    outDir,
    '--theme',
    themeHint,
    '--blueprint-smoke',
    '--verify',
    '--verify-runner',
    verifyRunner,
    '--steps',
    String(steps),
  ];
  var hardgateCommand = [
    process.execPath,
    path.join(__dirname, '..', 'scripts', 'storyboard2html-hardgate.cjs'),
    '--snapshot',
    snapshotSchemaPath,
    '--report',
    verifyReportPath,
    '--summary',
    verifySummaryPath,
    '--html',
    htmlPath,
  ];
  return {
    demo2specSkillRoot: skillRoot,
    verifyRunner: verifyRunner,
    command: args,
    hardgateCommand: hardgateCommand,
    artifacts: {
      snapshotSchema: snapshotSchemaPath,
      playableSceneIr: playableSceneIrPath,
      preflightReport: preflightReportPath,
      verifyReport: verifyReportPath,
      verifySummary: verifySummaryPath,
      flowManifest: flowManifestPath,
    },
    hardGates: [
      'snapshot-schema validates',
      'verify summary runner === production',
      'runtimeContractSummary.contractPassed === true',
      'manual joystick probe required and passed when multi-phase',
      'manual joystick flow probe required and completed when multi-phase',
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
  if (specs.length === 0 && safeArray(bp.phases).length > 0) {
    specs = deriveSpecsFromPhases(bp);
  }
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
  normalizeVerifyRunner: normalizeVerifyRunner,
  buildAcceptancePlan: buildAcceptancePlan,
  buildStoryboard2HtmlInput: buildStoryboard2HtmlInput,
  _internals: {
    inferThemeHint: inferThemeHint,
    normalizeFrame: normalizeFrame,
    normalizeSpec: normalizeSpec,
  },
};
