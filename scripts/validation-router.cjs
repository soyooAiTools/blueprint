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

  if (/^(lib\/programmer-delivery-|scripts\/programmer-delivery-aibridge-hydrate\.cjs|scripts\/export-unity-project\.sh|worker\/code-reviewer\.js|worker\/codex-code-coder\.js|engine\/stages\/review\.cjs|lib\/csharp-comment-localizer\.cjs)/.test(file)) {
    addTag(plan, 'programmer-delivery');
    addCommand(plan, command('unit:programmer-delivery-scene-bake-plan-and-temp-audit', ['node', 'test/programmer-delivery-scene-bake-plan-and-temp-audit.test.cjs'], 'Validate scene bake plan and temporary-code audit contracts.'));
    addCommand(plan, command('unit:programmer-delivery-aibridge-hydrate', ['node', 'test/programmer-delivery-aibridge-hydrate.test.cjs'], 'Validate AIBridge hydration and Editor bake command flow.'));
    addCommand(plan, command('unit:programmer-delivery-hardgate', ['node', 'test/programmer-delivery-hardgate.test.cjs'], 'Validate programmer delivery hardgate and report wiring.'));
    addCommand(plan, command('unit:unity-codegen-prompt-contract', ['node', 'test/unity-codegen-prompt-contract.test.cjs'], 'Validate prompt/review contract does not restore legacy Find/CreatePrimitive guidance.'));
  }

  if (/^scripts\/export-unity-project\.sh$/.test(file)) {
    addCommand(plan, command('unit:export-unity-project-bootstrap', ['node', 'test/export-unity-project-bootstrap.test.cjs'], 'Validate Unity export profile routing, bootstrap, and delivery handoff guards.'));
  }

  if (/^(worker\/prompt-v5-basetemplate\.js|worker\/prompt-v4\.js|worker\/luna-codex-code\.md|worker\/behavior-templates\.md|engine\/stages\/build-schema-prompt-v3\.cjs|docs\/unity-codegen-prompts-current\.md)$/.test(file)) {
    addTag(plan, 'programmer-delivery');
    addCommand(plan, command('unit:unity-codegen-prompt-contract', ['node', 'test/unity-codegen-prompt-contract.test.cjs'], 'Validate prompt/review contract and unity profile guard.'));
  }

  if (/^docs\/(?:specs|superpowers\/specs)\/.*\.md$/.test(file)) {
    addTag(plan, 'programmer-delivery-docs');
    addCommand(plan, command('unit:blueprint-skill-unitycomponent-profile-contract', ['node', 'test/blueprint-skill-unitycomponent-profile-contract.test.cjs'], 'Validate docs keep gmp-v14 and unitycomponent-v1 scopes separated.'));
  }

  if (/^(lib\/unitycomponent-|lib\/unity-delivery-spec-projector\.cjs|scripts\/export-unitycomponent-v1\.cjs|scripts\/export-unity-project\.sh|docs\/unitycomponent-contract-v1-remediation-plan\.md)/.test(file)) {
    addTag(plan, 'unitycomponent-v1');
    addTag(plan, 'programmer-delivery');
    addCommand(plan, command('unit:blueprint-skill-unitycomponent-profile-contract', ['node', 'test/blueprint-skill-unitycomponent-profile-contract.test.cjs'], 'Validate blueprint skill docs keep gmp-v14 and unitycomponent-v1 scopes separated.'));
    addCommand(plan, command('unit:unitycomponent-profile-registry', ['node', 'test/unitycomponent-profile-registry.test.cjs'], 'Validate gmp-v14 legacy freeze and unitycomponent-v1 profile contract.'));
    addCommand(plan, command('unit:unity-delivery-spec-projector', ['node', 'test/unity-delivery-spec-projector.test.cjs'], 'Validate UnityDeliverySpec projection and SourceIR semantic parity.'));
    addCommand(plan, command('unit:delivery-spec-source-parity', ['node', 'test/delivery-spec-source-parity.test.cjs'], 'Validate N=5 SourceIR to UnityDeliverySpec semantic parity.'));
    addCommand(plan, command('unit:unitycomponent-v1-hardgate', ['node', 'test/unitycomponent-v1-hardgate.test.cjs'], 'Validate UnityComponent v1 layer, namespace, manifest, runtime patch and drift gates.'));
    addCommand(plan, command('unit:unitycomponent-v1-emitter', ['node', 'test/unitycomponent-v1-emitter.test.cjs'], 'Validate UnityComponent v1 fresh export from SourceIR artifacts.'));
    addCommand(plan, command('unit:unitycomponent-v1-cold-export-corpus', ['node', 'test/unitycomponent-v1-cold-export-corpus.test.cjs'], 'Validate N=10 UnityComponent v1 cold exports from SourceIR artifacts.'));
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

  if (/^(scripts\/storyboard-flow-source-ir\.cjs|engine\/storyboard-flow-source-ir\.cjs)$/.test(file)) {
    addTag(plan, 'storyboard-flow');
    addTag(plan, 'source-ir');
    addCommand(plan, command('unit:storyboard-flow-source-ir', ['node', 'test/storyboard-flow-source-ir.test.cjs'], 'Validate human flowchart to SourceSceneIR conversion.'));
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
