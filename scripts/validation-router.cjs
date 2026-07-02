#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

function usage() {
  return [
    'Usage: node scripts/validation-router.cjs [--files a,b] [--from-git] [--checkpoint-build-dir dir --checkpoint-phase phaseId] [--strict-cua-build-dir dir]',
    '',
    'Builds a risk-based validation plan. It does not execute the plan.',
  ].join('\n');
}

function splitFiles(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map(function(file) { return normalizeFile(file); })
    .filter(Boolean);
}

function normalizeFile(file) {
  return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function unique(values) {
  const seen = {};
  const out = [];
  values.forEach(function(value) {
    const key = String(value || '');
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(value);
  });
  return out;
}

function parseArgs(argv) {
  const args = (argv || process.argv).slice(2);
  const parsed = {
    files: [],
    fromGit: false,
    checkpointBuildDir: '',
    checkpointPhase: '',
    checkpointMaxPhases: 1,
    strictCuaBuildDir: '',
    strictCuaOut: '',
    strictCuaTaskId: '',
    pretty: true,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--files') {
      parsed.files = parsed.files.concat(splitFiles(args[++i]));
    } else if (arg === '--file') {
      parsed.files = parsed.files.concat(splitFiles(args[++i]));
    } else if (arg === '--from-git') {
      parsed.fromGit = true;
    } else if (arg === '--checkpoint-build-dir') {
      parsed.checkpointBuildDir = String(args[++i] || '').trim();
    } else if (arg === '--checkpoint-phase') {
      parsed.checkpointPhase = String(args[++i] || '').trim();
    } else if (arg === '--checkpoint-max-phases') {
      parsed.checkpointMaxPhases = Math.max(1, Math.floor(Number(args[++i] || 1) || 1));
    } else if (arg === '--strict-cua-build-dir') {
      parsed.strictCuaBuildDir = String(args[++i] || '').trim();
    } else if (arg === '--strict-cua-out') {
      parsed.strictCuaOut = String(args[++i] || '').trim();
    } else if (arg === '--strict-cua-task-id') {
      parsed.strictCuaTaskId = String(args[++i] || '').trim();
    } else if (arg === '--compact') {
      parsed.pretty = false;
    } else {
      throw new Error('Unexpected argument: ' + arg);
    }
  }
  parsed.files = unique(parsed.files);
  return parsed;
}

function filesFromGit(repoRoot) {
  try {
    const stdout = execSync('git diff --name-only --diff-filter=ACMR HEAD', {
      cwd: repoRoot || path.resolve(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return unique(splitFiles(stdout));
  } catch(e) {
    return [];
  }
}

function addTag(plan, tag) {
  if (!tag) return;
  if (plan.riskTags.indexOf(tag) < 0) plan.riskTags.push(tag);
}

function addCommand(plan, command) {
  if (!command || !command.id) return;
  if (plan._commandIds[command.id]) return;
  plan._commandIds[command.id] = true;
  plan.commands.push(Object.assign({
    gate: 'iteration',
    required: true,
    ready: true,
  }, command));
}

function command(id, argv, purpose, gate) {
  return {
    id,
    command: argv,
    purpose,
    gate: gate || 'iteration',
    required: true,
    ready: true,
  };
}

function addUnitForTestFile(plan, file) {
  if (/^test\/.+\.test\.cjs$/.test(file)) {
    addCommand(plan, command(
      'unit:' + file,
      ['node', file],
      'Run the directly changed test file.'
    ));
  }
}

function routeFile(plan, file) {
  addUnitForTestFile(plan, file);

  if (/^(worker\/worker-playableagent\.js|worker\/worker-cua-verify\.js|scripts\/cua-checkpoint-probe\.cjs|scripts\/strict-cua-runner\.cjs)/.test(file)) {
    addTag(plan, 'cua-verifier');
    addCommand(plan, command('unit:playableagent-report-normalization', ['node', 'test/playableagent-report-normalization.test.cjs'], 'Validate CUA report normalization and telemetry.'));
    addCommand(plan, command('unit:playableagent-manual-joystick', ['node', 'test/playableagent-manual-joystick-probe.test.cjs'], 'Validate manual joystick and checkpoint flow contracts.'));
  }

  if (/^scripts\/cua-checkpoint-probe\.cjs$/.test(file)) {
    addTag(plan, 'checkpoint-cua');
    addCommand(plan, command('unit:cua-checkpoint-cli', ['node', 'test/cua-checkpoint-probe-cli.test.cjs'], 'Validate debug-only checkpoint CUA CLI parsing and sidecar loading.'));
  }

  if (/^scripts\/strict-cua-runner\.cjs$/.test(file)) {
    addTag(plan, 'strict-cua-cli');
    addCommand(plan, command('unit:strict-cua-runner-cli', ['node', 'test/strict-cua-runner-cli.test.cjs'], 'Validate strict CUA runner CLI parsing and report output behavior.'));
  }

  if (/^(scripts\/validation-router\.cjs)$/.test(file)) {
    addTag(plan, 'validation-router');
    addCommand(plan, command('unit:validation-router', ['node', 'test/validation-router.test.cjs'], 'Validate risk-based validation routing rules.'));
  }

  if (/^(adapters\/skeleton-generator\.cjs|adapters\/assembly-plan-pipeline\.cjs|adapters\/source-ir\/proof-bundle\.cjs|adapters\/source-ir\/blueprint-project\.js)/.test(file)) {
    addTag(plan, 'runtime-phase-gate');
    addTag(plan, 'proof-contract');
    addCommand(plan, command('unit:source-ir-proof-bundle', ['node', 'test/source-ir-proof-bundle.test.cjs'], 'Validate proof bundle and proof diff gates before browser CUA.'));
    addCommand(plan, command('unit:skeleton-phase-gate', ['node', 'test/skeleton-phase-gate-strictness.test.cjs'], 'Validate phase-local resource/carry gates and phase path strictness.'));
  }

  if (/^adapters\/assembly-plan-pipeline\.cjs$/.test(file)) {
    addTag(plan, 'assembly-plan');
    addCommand(plan, command('unit:assembly-plan-pipeline', ['node', 'test/assembly-plan-pipeline.test.cjs'], 'Validate assembly plan extraction and structured action preservation.'));
  }

  if (/^(adapters\/source-ir\/verify-facade\.cjs|adapters\/source-ir\/run-blueprint-smoke\.js)/.test(file)) {
    addTag(plan, 'source-ir-verify');
    addCommand(plan, command('unit:source-ir-verify-facade', ['node', 'test/source-ir-verify-facade.test.cjs'], 'Validate SourceIR production verify summary and artifact materialization.'));
  }

  if (/^(scripts\/storyboard2html-|engine\/storyboard2html-|engine\/fidelity-|engine\/storyboard2html-hardgate\.cjs|contracts\/storyboard2html)/.test(file)) {
    addTag(plan, 'storyboard2html');
    addTag(plan, 'html-fidelity');
    addCommand(plan, command('unit:storyboard2html-contract', ['node', 'test/storyboard2html-contract.test.cjs'], 'Validate storyboard2html HTML contract and hardgate command shape.'));
  }

  if (/^(engine\/stages\/build-schema-prompt-v3\.cjs|worker\/(prompt-v5-basetemplate\.js|prompt-v4\.js|luna-codex-code\.md|worker-coder\.js|codex-code-coder\.js|behavior-templates\.md)|test\/unity-codegen-prompt-contract\.test\.cjs)$/.test(file)) {
    addTag(plan, 'unity-codegen-prompt');
    addTag(plan, 'programmer-delivery-boundary');
    addCommand(plan, command('unit:unity-codegen-prompt-contract', ['node', 'test/unity-codegen-prompt-contract.test.cjs'], 'Validate Luna/WebGL prompt boundaries and stale Unity delivery constraints.'));
  }

  if (/^(lib\/unity-delivery-spec-projector\.cjs|lib\/unity-native-webgl-parity\.cjs|lib\/unitycomponent-profile-registry\.cjs|lib\/unitycomponent-v1-accepted-corpus\.cjs|lib\/unitycomponent-v1-emitter\.cjs|lib\/unitycomponent-v1-hardgate\.cjs|scripts\/export-unitycomponent-v1\.cjs|scripts\/unity-native-webgl-build\.cjs|scripts\/unity-native-webgl-parity\.cjs|scripts\/unitycomponent-v1-cutover-gates\.cjs|scripts\/unitycomponent-v1-unity-smoke\.cjs|docs\/unitycomponent-contract-v1-remediation-plan\.md|test\/(blueprint-skill-unitycomponent-profile-contract|delivery-spec-source-parity|unity-delivery-spec-projector|unity-native-webgl-build|unity-native-webgl-parity|unitycomponent-profile-registry|unitycomponent-v1-emitter|unitycomponent-v1-hardgate|unitycomponent-v1-synthetic-export-corpus|unitycomponent-v1-accepted-artifact-corpus|unitycomponent-v1-cutover-gates|unitycomponent-v1-unity-smoke)\.test\.cjs)$/.test(file)) {
    addTag(plan, 'unitycomponent-v1');
    addTag(plan, 'unity-native-webgl');
    addCommand(plan, command('unit:unitycomponent-profile-registry', ['node', 'test/unitycomponent-profile-registry.test.cjs'], 'Validate explicit Unity delivery profile split and defaults.'));
    addCommand(plan, command('unit:unity-delivery-spec-projector', ['node', 'test/unity-delivery-spec-projector.test.cjs'], 'Validate UnityDeliverySpec downstream projection.'));
    addCommand(plan, command('unit:delivery-spec-source-parity', ['node', 'test/delivery-spec-source-parity.test.cjs'], 'Validate UnityDeliverySpec does not drift from source artifacts.'));
    addCommand(plan, command('unit:unity-native-webgl-parity', ['node', 'test/unity-native-webgl-parity.test.cjs'], 'Validate SourceIR to Unity native WebGL runtime parity hardgate.'));
    addCommand(plan, command('unit:unity-native-webgl-build', ['node', 'test/unity-native-webgl-build.test.cjs'], 'Validate Unity Editor native WebGL build script and WebGL Build Support blocker reporting.'));
    addCommand(plan, command('unit:unitycomponent-v1-emitter', ['node', 'test/unitycomponent-v1-emitter.test.cjs'], 'Validate SLGFrameWork emitter output and prefab shape.'));
    addCommand(plan, command('unit:unitycomponent-v1-hardgate', ['node', 'test/unitycomponent-v1-hardgate.test.cjs'], 'Validate UnityComponent v1 profile hardgate failures.'));
    addCommand(plan, command('unit:unitycomponent-v1-synthetic-export-corpus', ['node', 'test/unitycomponent-v1-synthetic-export-corpus.test.cjs'], 'Validate synthetic/unit UnityComponent v1 export corpus coverage.'));
    addCommand(plan, command('unit:unitycomponent-v1-accepted-artifact-corpus', ['node', 'test/unitycomponent-v1-accepted-artifact-corpus.test.cjs'], 'Run accepted artifact corpus when repo/local accepted artifacts are available.'));
    addCommand(plan, command('unit:unitycomponent-v1-cutover-gates', ['node', 'test/unitycomponent-v1-cutover-gates.test.cjs'], 'Validate batch cutover gate reporting, scaffold-only mode, and required Unity failure behavior.'));
    addCommand(plan, command('unit:unitycomponent-v1-unity-smoke', ['node', 'test/unitycomponent-v1-unity-smoke.test.cjs'], 'Validate Unity smoke script skip/required behavior.'));
    addCommand(plan, command('unit:blueprint-skill-unitycomponent-profile-contract', ['node', 'test/blueprint-skill-unitycomponent-profile-contract.test.cjs'], 'Validate skill docs when BLUEPRINT_SKILL_ROOT or local skill docs are available.'));
  }

  if (/^scripts\/export-unity-project\.sh$/.test(file)) {
    addTag(plan, 'programmer-delivery');
    addTag(plan, 'unitycomponent-v1');
    addCommand(plan, command('unit:export-unity-project-bootstrap', ['node', 'test/export-unity-project-bootstrap.test.cjs'], 'Validate Unity export profile flag and bootstrap guardrails.'));
    addCommand(plan, command('unit:unitycomponent-profile-registry', ['node', 'test/unitycomponent-profile-registry.test.cjs'], 'Validate explicit Unity delivery profile split and defaults.'));
    addCommand(plan, command('unit:unity-native-webgl-parity', ['node', 'test/unity-native-webgl-parity.test.cjs'], 'Validate SourceIR to Unity native WebGL runtime parity hardgate.'));
    addCommand(plan, command('unit:unity-native-webgl-build', ['node', 'test/unity-native-webgl-build.test.cjs'], 'Validate Unity Editor native WebGL build script and WebGL Build Support blocker reporting.'));
    addCommand(plan, command('unit:unitycomponent-v1-emitter', ['node', 'test/unitycomponent-v1-emitter.test.cjs'], 'Validate SLGFrameWork emitter output and prefab shape.'));
    addCommand(plan, command('unit:unitycomponent-v1-hardgate', ['node', 'test/unitycomponent-v1-hardgate.test.cjs'], 'Validate UnityComponent v1 profile hardgate failures.'));
    addCommand(plan, command('unit:unitycomponent-v1-synthetic-export-corpus', ['node', 'test/unitycomponent-v1-synthetic-export-corpus.test.cjs'], 'Validate synthetic/unit UnityComponent v1 export corpus coverage.'));
    addCommand(plan, command('unit:unitycomponent-v1-cutover-gates', ['node', 'test/unitycomponent-v1-cutover-gates.test.cjs'], 'Validate batch cutover gate reporting, scaffold-only mode, and required Unity failure behavior.'));
    addCommand(plan, command('unit:unitycomponent-v1-unity-smoke', ['node', 'test/unitycomponent-v1-unity-smoke.test.cjs'], 'Validate Unity smoke script skip/required behavior.'));
  }

  if (/^(contracts\/cua-probe|engine\/stages\/runtime-contract\.cjs|engine\/playable-flow-manifest\.cjs)/.test(file)) {
    addTag(plan, 'runtime-contract');
    addCommand(plan, command('unit:runtime-contract-module-gate', ['node', 'test/runtime-contract-module-gate.test.cjs'], 'Validate runtime contract hardgate summary semantics.'));
    addCommand(plan, command('unit:playable-flow-manifest', ['node', 'test/playable-flow-manifest.test.cjs'], 'Validate playable flow manifest propagation.'));
  }
}

function addCheckpointGate(plan, opts) {
  const needsCheckpoint = plan.riskTags.some(function(tag) {
    return ['cua-verifier', 'checkpoint-cua', 'runtime-phase-gate', 'proof-contract'].indexOf(tag) >= 0;
  });
  if (!needsCheckpoint) return;
  if (opts.checkpointBuildDir && opts.checkpointPhase) {
    addCommand(plan, command(
      'checkpoint-cua:affected-phase',
      [
        'node',
        'scripts/cua-checkpoint-probe.cjs',
        opts.checkpointBuildDir,
        '--phase',
        opts.checkpointPhase,
        '--max-phases',
        String(opts.checkpointMaxPhases || 1),
      ],
      'Run a debug-only real joystick checkpoint for the affected phase before a full CUA rerun.'
    ));
    return;
  }
  addCommand(plan, {
    id: 'checkpoint-cua:affected-phase',
    command: ['node', 'scripts/cua-checkpoint-probe.cjs', '<webgl-build-dir>', '--phase', '<phaseId>', '--max-phases', '1'],
    purpose: 'Run a debug-only real joystick checkpoint for the affected phase before a full CUA rerun.',
    gate: 'iteration',
    required: true,
    ready: false,
    missingInputs: ['checkpointBuildDir', 'checkpointPhase'],
  });
}

function addFinalStrictCuaGate(plan, opts) {
  if (opts.strictCuaBuildDir) {
    const argv = ['node', 'scripts/strict-cua-runner.cjs', opts.strictCuaBuildDir];
    if (opts.strictCuaOut) argv.push('--out', opts.strictCuaOut);
    if (opts.strictCuaTaskId) argv.push('--task-id', opts.strictCuaTaskId);
    addCommand(plan, command(
      'final:strict-cua-one-project',
      argv,
      'Final hardgate: observe + real manual joystick full flow on one WebGL project.',
      'final'
    ));
    return;
  }
  addCommand(plan, {
    id: 'final:strict-cua-one-project',
    command: ['node', 'scripts/strict-cua-runner.cjs', '<webgl-build-dir>'],
    purpose: 'Final hardgate: observe + real manual joystick full flow on one WebGL project.',
    gate: 'final',
    required: true,
    ready: false,
    missingInputs: ['strictCuaBuildDir'],
  });
}

function buildValidationPlan(input) {
  const opts = Object.assign({
    files: [],
    checkpointBuildDir: '',
    checkpointPhase: '',
    checkpointMaxPhases: 1,
    strictCuaBuildDir: '',
    strictCuaOut: '',
    strictCuaTaskId: '',
  }, input || {});
  const files = unique((opts.files || []).map(normalizeFile).filter(Boolean));
  const plan = {
    schemaVersion: 'blueprint-validation-plan.v1',
    generatedAt: new Date().toISOString(),
    files,
    riskTags: [],
    commands: [],
    notes: [],
    _commandIds: {},
  };
  files.forEach(function(file) { routeFile(plan, file); });

  if (files.length === 0) {
    plan.notes.push('No changed files were supplied or discovered; run full tests if this is not intentional.');
    addCommand(plan, command('unit:run-all', ['node', 'test/run-all.cjs'], 'Fallback full test suite for unknown change surface.'));
  } else if (plan.commands.length === 0) {
    addTag(plan, 'unknown-risk');
    addCommand(plan, command('unit:run-all', ['node', 'test/run-all.cjs'], 'Unknown change surface; run full test suite.'));
  }

  addCheckpointGate(plan, opts);
  addFinalStrictCuaGate(plan, opts);

  plan.riskTags.sort();
  plan.commands = plan.commands.map(function(item) {
    return {
      id: item.id,
      gate: item.gate,
      required: item.required,
      ready: item.ready,
      command: item.command,
      purpose: item.purpose,
      missingInputs: item.missingInputs || undefined,
    };
  });
  delete plan._commandIds;
  return plan;
}

function main(argv) {
  const parsed = parseArgs(argv || process.argv);
  if (parsed.help) {
    console.log(usage());
    return { exitCode: 0, help: true };
  }
  let files = parsed.files;
  if (parsed.fromGit || files.length === 0) {
    files = unique(files.concat(filesFromGit(path.resolve(__dirname, '..'))));
  }
  const plan = buildValidationPlan(Object.assign({}, parsed, { files }));
  console.log(JSON.stringify(plan, null, parsed.pretty ? 2 : 0));
  return { exitCode: 0, plan };
}

if (require.main === module) {
  try {
    const result = main(process.argv);
    process.exitCode = result.exitCode || 0;
  } catch (err) {
    console.error('[validation-router] FAIL ' + (err && err.message || err));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  filesFromGit,
  buildValidationPlan,
  main,
};
