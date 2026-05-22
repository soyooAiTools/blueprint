'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var contractMod = require('../engine/storyboard2html-contract.cjs');
var promptBuilder = require('../engine/storyboard2html-prompt.cjs');

var blueprint = {
  projectName: 'FarmStoryboard',
  storyboard: {
    frames: [
      { title: 'Collect corn', interaction: 'collect:Corn:1', ui: 'Collect corn', camera: 'follow player' },
      { title: 'Build stand', interaction: 'near:Stand', ui: 'Build the farm stand' },
      { title: 'Sell crops', interaction: 'click:CtaButton', ui: 'Sell crops to customer' },
    ],
  },
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'Corn', label: 'Corn', template: 'Collectible' },
    { name: 'Customer', label: 'Customer', template: 'NpcQueue' },
    { name: 'CtaButton', label: 'CtaButton', template: 'CtaButton' },
  ],
  resources: [
    { name: 'Corn', entity: 'Corn' },
    { name: 'Gold', entity: null },
  ],
  specs: [
    {
      phaseId: 'phase1',
      phaseName: 'Collect corn',
      playerInstruction: 'Collect corn near the field',
      requiredInteractions: ['collect:Corn:1'],
      entitiesRequired: [{ name: 'Corn', resource: 'Corn' }],
      plannedModuleIds: ['collect_on_near', 'guide_ui', 'inventory_wallet', 'visual_binding'],
      trigger: { type: 'compound', operator: 'and', triggers: [{ type: 'timer', seconds: 0.6 }, { type: 'resource_collected', resource: 'Corn', amount: 1 }] },
      duration: { min: 8, max: 10 },
    },
    {
      phaseId: 'phase2',
      phaseName: 'Build stand',
      playerInstruction: 'Build the farm stand',
      requiredInteractions: ['near:Stand'],
      entitiesRequired: [{ name: 'Stand' }],
      plannedModuleIds: ['guide_ui', 'spawn_once', 'visual_binding'],
      trigger: { type: 'compound', operator: 'and', triggers: [{ type: 'timer', seconds: 0.8 }, { type: 'near_entity', entity: 'Stand', range: 2 }] },
    },
    {
      phaseId: 'phase3',
      phaseName: 'Sell crops',
      playerInstruction: 'Sell crops to customer',
      requiredInteractions: ['click:CtaButton'],
      entitiesRequired: [{ name: 'CtaButton' }],
      plannedModuleIds: ['guide_ui', 'cta_finish'],
      trigger: { type: 'click_entity', entity: 'CtaButton' },
    },
  ],
};

var bundle = contractMod.buildStoryboard2HtmlInput(blueprint, {
  htmlPath: '/tmp/generated.html',
  outDir: '/tmp/storyboard2html-prompt-test',
  steps: 12,
});

var built = promptBuilder.buildStoryboard2HtmlPrompt(bundle);

assert.ok(built.systemPrompt && typeof built.systemPrompt === 'string');
assert.ok(built.userPrompt && typeof built.userPrompt === 'string');
assert.ok(built.systemPrompt.length > 1500, 'system prompt seems too short: ' + built.systemPrompt.length);
assert.ok(built.userPrompt.length > 200, 'user prompt seems too short: ' + built.userPrompt.length);
assert.strictEqual(built.metadata.phases, 3);
assert.strictEqual(built.metadata.themeHint, 'farming');
assert.strictEqual(built.metadata.projectName, 'FarmStoryboard');

// L1 system prompt clauses
assert.ok(built.systemPrompt.indexOf('PHASES') >= 0, 'system prompt should mention PHASES');
assert.ok(built.systemPrompt.indexOf('setTip') >= 0);
assert.ok(built.systemPrompt.indexOf('enterPhase') >= 0);
assert.ok(built.systemPrompt.indexOf('completePhase') >= 0);
assert.ok(built.systemPrompt.indexOf('phase{n}') >= 0 || built.systemPrompt.indexOf('phase1') >= 0);

// L2 runtime contract clauses
assert.ok(built.systemPrompt.indexOf('window.__gameState') >= 0);
assert.ok(built.systemPrompt.indexOf('phaseRealTimer') >= 0);
assert.ok(built.systemPrompt.indexOf('entity_states') >= 0);
assert.ok(built.systemPrompt.indexOf('wall-clock') >= 0);

// L3 evidence envelope clauses
assert.ok(built.systemPrompt.indexOf('phaseEvidence') >= 0);
assert.ok(built.systemPrompt.indexOf('schemaVersion') >= 0 && built.systemPrompt.indexOf('1.0.0') >= 0);
assert.ok(built.systemPrompt.indexOf('sourcePlatform') >= 0);
assert.ok(built.systemPrompt.indexOf('"html"') >= 0);
assert.ok(built.systemPrompt.indexOf('guide_text_visible') >= 0);
assert.ok(built.systemPrompt.indexOf('phase_advanced') >= 0);
assert.ok(built.systemPrompt.indexOf('resource_incremented') >= 0);

// Module templates
['guide_ui', 'inventory_wallet', 'collect_on_near', 'phase_gate_timer', 'visual_binding', 'spawn_once', 'cta_finish'].forEach(function(moduleId) {
  assert.ok(built.systemPrompt.indexOf(moduleId) >= 0, 'system prompt missing module template: ' + moduleId);
});

// Output format clauses
assert.ok(built.systemPrompt.indexOf('<!doctype html>') >= 0);
assert.ok(built.systemPrompt.indexOf('</html>') >= 0);
assert.ok(built.systemPrompt.indexOf('CtaButton') >= 0);

// Forbid rules
assert.ok(built.systemPrompt.indexOf('禁止') >= 0);

// User prompt content checks
assert.ok(built.userPrompt.indexOf('FarmStoryboard') >= 0);
assert.ok(built.userPrompt.indexOf('themeHint: farming') >= 0);
assert.ok(built.userPrompt.indexOf('phase1') >= 0);
assert.ok(built.userPrompt.indexOf('phase2') >= 0);
assert.ok(built.userPrompt.indexOf('phase3') >= 0);
assert.ok(built.userPrompt.indexOf('collect:Corn:1') >= 0);
assert.ok(built.userPrompt.indexOf('click:CtaButton') >= 0);
assert.ok(built.userPrompt.indexOf('Collect corn near the field') >= 0);
assert.ok(built.userPrompt.indexOf('Frame 1') >= 0);
assert.ok(built.userPrompt.indexOf('triggeredPresentFullRate') >= 0);

// Bundle validation
assert.strictEqual(promptBuilder.validateBundle(bundle), true);
assert.throws(function() { promptBuilder.validateBundle({ kind: 'wrong' }); });
assert.throws(function() { promptBuilder.validateBundle({ specs: [] }); });
assert.throws(function() { promptBuilder.buildStoryboard2HtmlPrompt({ specs: [] }); });

// CLI prompt dumper
var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard2html-prompt-test-'));
var bundlePath = path.join(tempDir, 'bundle.json');
var outPath = path.join(tempDir, 'prompt.txt');
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
var promptCliResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-prompt.cjs'),
  bundlePath,
  '--out',
  outPath,
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(promptCliResult.status, 0, promptCliResult.stderr || promptCliResult.stdout);
var dumped = fs.readFileSync(outPath, 'utf8');
assert.ok(dumped.indexOf('=== SYSTEM PROMPT ===') >= 0);
assert.ok(dumped.indexOf('=== USER PROMPT ===') >= 0);
assert.ok(dumped.indexOf('FarmStoryboard') >= 0);

// Generate CLI dry-run from raw blueprint (also exercises buildStoryboard2HtmlInput path)
var blueprintPath = path.join(tempDir, 'blueprint.json');
fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2));
var generateDry = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-generate.cjs'),
  blueprintPath,
  path.join(tempDir, 'generated.html'),
  '--dry-run',
  '--theme',
  'farming',
  '--steps',
  '12',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(generateDry.status, 0, generateDry.stderr || generateDry.stdout);
assert.ok(generateDry.stdout.indexOf('dry-run plan:') >= 0);
assert.ok(generateDry.stdout.indexOf('phases:       3') >= 0);
assert.ok(generateDry.stdout.indexOf('themeHint:    farming') >= 0);

// Generate CLI --prompt-only mode (no LLM call) from an already-built input bundle
var promptOnlyPath = path.join(tempDir, 'generate-prompt-only.txt');
var generatePromptOnly = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-generate.cjs'),
  bundlePath,
  path.join(tempDir, 'unused.html'),
  '--prompt-only',
  promptOnlyPath,
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(generatePromptOnly.status, 0, generatePromptOnly.stderr || generatePromptOnly.stdout);
var promptOnly = fs.readFileSync(promptOnlyPath, 'utf8');
assert.ok(promptOnly.indexOf('=== SYSTEM ===') >= 0);
assert.ok(promptOnly.indexOf('=== USER ===') >= 0);
assert.ok(promptOnly.indexOf('FarmStoryboard') >= 0);

console.log('storyboard2html prompt tests passed');
