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

// snake_case MUST language (anti-regression: prompt must not allow camelCase-only writes)
assert.ok(built.systemPrompt.indexOf('snake_case') >= 0, 'system prompt should mention snake_case');
assert.ok(built.systemPrompt.indexOf('硬必填') >= 0, 'system prompt should mark snake_case keys as 硬必填');
assert.ok(built.systemPrompt.indexOf('镜像副本') >= 0, 'system prompt should restrict camelCase to 镜像副本');

// 36-module vocabulary present (anti-regression: prompt must not silently support fewer modules)
[
  'activate_targets', 'apply_damage', 'build_progress', 'camera_focus', 'camera_lift', 'camera_zoom',
  'click_trigger', 'collect_on_near', 'cooldown', 'cost_gate', 'cta_finish', 'damageable',
  'deliver_to_target', 'drag_trigger', 'floating_text_feedback', 'form_switch', 'guide_ui',
  'highlight_target', 'hold_trigger', 'inventory_wallet', 'move_to_target', 'on_death_drop',
  'phase_gate_timer', 'player_input_joystick', 'player_input_tap', 'pop_animation',
  'projectile_emit', 'proximity_trigger', 'score_feedback', 'spawn_interval', 'spawn_once',
  'target_acquire', 'upgrade_progress', 'visual_binding', 'visual_variant_swap', 'world_label',
].forEach(function(moduleId) {
  assert.ok(built.systemPrompt.indexOf(moduleId) >= 0, 'system prompt missing module from 36-vocab: ' + moduleId);
});

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

// Regression: plannedModuleIds must surface in userPrompt phase table
// (Jonny found that normalizeSpec previously dropped plannedModuleIds silently.)
assert.ok(built.userPrompt.indexOf('collect_on_near') >= 0, 'userPrompt should list phase1 module collect_on_near');
assert.ok(built.userPrompt.indexOf('guide_ui') >= 0, 'userPrompt should list guide_ui (phase1+phase2)');
assert.ok(built.userPrompt.indexOf('inventory_wallet') >= 0, 'userPrompt should list phase1 inventory_wallet');
assert.ok(built.userPrompt.indexOf('spawn_once') >= 0, 'userPrompt should list phase2 spawn_once');
assert.ok(built.userPrompt.indexOf('cta_finish') >= 0, 'userPrompt should list phase3 cta_finish');

// extractHtml — accepts well-formed output
var goodHtml = '<!doctype html>\n<html><head></head><body>x</body></html>';
assert.strictEqual(promptBuilder.extractHtml(goodHtml), goodHtml);

// extractHtml — strips leading preamble (LLM chatty prefix)
var preambled = 'Here is the HTML you requested:\n\n<!doctype html>\n<html><body>ok</body></html>\n\nLet me know if you need more.';
var extracted = promptBuilder.extractHtml(preambled);
assert.ok(extracted.indexOf('<!doctype html>') === 0, 'extractHtml should strip preamble: ' + extracted.slice(0, 30));
assert.ok(extracted.indexOf('</html>') === extracted.length - '</html>'.length, 'extractHtml should strip trailing chatter');

// extractHtml — strips ``` fences
var fenced = '```html\n<!doctype html>\n<html><body>ok</body></html>\n```';
var fencedOut = promptBuilder.extractHtml(fenced);
assert.ok(fencedOut.indexOf('<!doctype html>') === 0, 'extractHtml should strip code fence');
assert.ok(fencedOut.indexOf('```') < 0, 'extractHtml output should not contain fence');

// extractHtml — accepts bare <html ...> opening (no doctype)
var noDoctype = '<html lang="en"><body>x</body></html>';
assert.strictEqual(promptBuilder.extractHtml(noDoctype), noDoctype);

// extractHtml — refuses output with no html tags at all
assert.throws(function() { promptBuilder.extractHtml('I am sorry, I cannot generate HTML.'); }, function(err) {
  return err && err.code === 'STORYBOARD2HTML_OUTPUT_NOT_HTML';
}, 'extractHtml should throw STORYBOARD2HTML_OUTPUT_NOT_HTML on prose-only output');

// extractHtml — refuses truncated output missing </html>
assert.throws(function() { promptBuilder.extractHtml('<!doctype html>\n<html><body>truncated...'); }, function(err) {
  return err && err.code === 'STORYBOARD2HTML_OUTPUT_TRUNCATED';
}, 'extractHtml should throw STORYBOARD2HTML_OUTPUT_TRUNCATED when </html> missing');

// resolveModel / resolveTimeoutMs / resolveMinOutputLen — opts win over env, env wins over default
var prevModel = process.env.STORYBOARD2HTML_MODEL;
var prevTimeout = process.env.STORYBOARD2HTML_TIMEOUT_MS;
var prevMinLen = process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN;
try {
  delete process.env.STORYBOARD2HTML_MODEL;
  delete process.env.STORYBOARD2HTML_TIMEOUT_MS;
  delete process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN;
  assert.strictEqual(promptBuilder.resolveModel({}), promptBuilder.DEFAULT_MODEL);
  assert.strictEqual(promptBuilder.resolveTimeoutMs({}), promptBuilder.DEFAULT_TIMEOUT_MS);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({}), promptBuilder.DEFAULT_MIN_OUTPUT_LEN);

  process.env.STORYBOARD2HTML_MODEL = 'claude-opus-from-env';
  process.env.STORYBOARD2HTML_TIMEOUT_MS = '12345';
  process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN = '777';
  assert.strictEqual(promptBuilder.resolveModel({}), 'claude-opus-from-env');
  assert.strictEqual(promptBuilder.resolveTimeoutMs({}), 12345);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({}), 777);
  // opts override env
  assert.strictEqual(promptBuilder.resolveModel({ model: 'opt-wins' }), 'opt-wins');
  assert.strictEqual(promptBuilder.resolveTimeoutMs({ timeoutMs: 999 }), 999);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({ minOutputLen: 4242 }), 4242);
} finally {
  if (prevModel === undefined) delete process.env.STORYBOARD2HTML_MODEL; else process.env.STORYBOARD2HTML_MODEL = prevModel;
  if (prevTimeout === undefined) delete process.env.STORYBOARD2HTML_TIMEOUT_MS; else process.env.STORYBOARD2HTML_TIMEOUT_MS = prevTimeout;
  if (prevMinLen === undefined) delete process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN; else process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN = prevMinLen;
}

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
