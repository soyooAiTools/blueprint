#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  preflightSourceSceneIrHtml,
} = require('../../engine/source-scene-ir.cjs');
const {
  buildSourceIrArtifacts,
} = require('../source-ir/index.js');

const skillRoot = __dirname;

function usage() {
  console.error([
    'Usage: node index.js <demo.html> <outdir> [--theme name] [--blueprint-smoke] [--verify]',
    '  [--verify-runner direct|production] [--steps N] [--visual-diff]',
    '  [--visual-phases phase8|6-8|phase6,phase8]',
    '',
    'Legacy bridge note: new storyboard2html builds should call scripts/source-ir-build.cjs.',
    'This wrapper is retained for older callers, but it is SourceIR-only and never runs legacy JS inference.',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { html: null, outDir: null, theme: null, blueprintSmoke: false, verify: false, verifyRunner: null, steps: 30, visualDiff: false, visualPhases: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--theme') {
      opts.theme = argv[++i] || null;
    } else if (arg === '--blueprint-smoke') {
      opts.blueprintSmoke = true;
    } else if (arg === '--verify') {
      opts.verify = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--verify-runner') {
      opts.verifyRunner = argv[++i] || null;
      opts.verify = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || opts.steps;
    } else if (arg === '--visual-diff') {
      opts.visualDiff = true;
      opts.blueprintSmoke = true;
    } else if (arg === '--visual-phases' || arg === '--visual-diff-phases') {
      opts.visualPhases = argv[++i] || null;
      if (!opts.visualPhases || /^--/.test(opts.visualPhases)) usage();
      opts.visualDiff = true;
      opts.blueprintSmoke = true;
    } else if (!opts.html) {
      opts.html = arg;
    } else if (!opts.outDir) {
      opts.outDir = arg;
    } else {
      usage();
    }
  }
  if (!opts.html || !opts.outDir) usage();
  return opts;
}

function runNode(script, args, cwd) {
  const result = spawnSync(process.execPath, [script].concat(args), {
    cwd: cwd || skillRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    env: Object.assign({}, process.env),
  });
  if (result.status !== 0) {
    throw new Error(path.basename(script) + ' failed with exit ' + result.status);
  }
}

function hasEmbeddedSourceIr(html) {
  return /(?:window|globalThis)\.__BP_SOURCE_IR__\s*=/.test(String(html || '')) ||
    /\b(?:const|let|var)\s+__BP_SOURCE_IR__\s*=/.test(String(html || ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function runSourceIrCompiler(htmlPath, outDir, opts) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!hasEmbeddedSourceIr(html)) {
    writeJson(path.join(outDir, 'semantic-source.json'), {
      semanticSource: 'source-scene-ir-required',
      legacyJsInferenceUsed: false,
      sourceIrPresent: false,
      sourceIrPreflightPassed: false,
      failure: 'window.__BP_SOURCE_IR__ missing; legacy JS inference fallback is disabled',
    });
    throw new Error('SourceSceneIR required: window.__BP_SOURCE_IR__ missing; legacy JS inference fallback is disabled.');
  }
  const report = preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: htmlPath,
  });
  writeJson(path.join(outDir, 'source-ir-report.json'), report);
  if (!report.passed) {
    throw new Error('SourceSceneIR preflight failed: ' + (report.violations || []).slice(0, 6).map(violation => violation.code || violation.message || JSON.stringify(violation)).join('; '));
  }
  const artifacts = buildSourceIrArtifacts(htmlPath, outDir, {
    projectName: path.basename(outDir),
    noBlueprint: true,
  });
  const sourceSceneIrHash = artifacts.sourceIr && artifacts.sourceIr.semanticHash || report.summary && report.summary.sourceSceneIrHash || null;
  const playableSceneIrHash = artifacts.playableSceneIr && artifacts.playableSceneIr.semanticHash || null;
  const sourceVisualIrHash = artifacts.sourceVisualIr && artifacts.sourceVisualIr.semanticHash || null;
  writeJson(path.join(outDir, 'semantic-source.json'), {
    semanticSource: 'source-scene-ir',
    legacyJsInferenceUsed: false,
    sourceIrPresent: true,
    sourceIrPreflightPassed: true,
    sourceSceneIrHash,
    playableSceneIrHash,
    sourceVisualIrHash,
  });
  return {
    usedSourceIr: true,
    sourceSceneIrHash,
    playableSceneIrHash,
    sourceVisualIrHash,
  };
}

function main() {
  const opts = parseArgs(process.argv);
  const htmlPath = path.resolve(opts.html);
  const outDir = path.resolve(opts.outDir);
  if (!fs.existsSync(htmlPath)) throw new Error('HTML not found: ' + htmlPath);
  fs.mkdirSync(outDir, { recursive: true });

  const specPath = path.join(outDir, 'spec.json');
  const gameSchemaPath = path.join(outDir, 'gameschema.json');

  const sourceIrResult = runSourceIrCompiler(htmlPath, outDir, opts);

  if (opts.blueprintSmoke) {
    const smokeOut = path.join(outDir, 'blueprint-smoke');
    const smokeArgs = [outDir, smokeOut];
    if (opts.verify) smokeArgs.push('--verify', '--steps', String(opts.steps));
    if (opts.verifyRunner) smokeArgs.push('--verify-runner', opts.verifyRunner);
    runNode(path.join(skillRoot, 'run-blueprint-smoke.js'), smokeArgs, skillRoot);
    if (opts.visualDiff) {
      const visualDiffArgs = [
        '--source', htmlPath,
        '--webgl', smokeOut,
        '--out', path.join(outDir, 'storyboard-webgl-visual-diff'),
      ];
      if (opts.visualPhases) visualDiffArgs.push('--phases', opts.visualPhases);
      runNode(path.join(skillRoot, '..', '..', 'scripts', 'storyboard-webgl-visual-diff.cjs'), visualDiffArgs, path.join(skillRoot, '..', '..'));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    outDir,
    semanticSource: 'source-scene-ir',
    legacyJsInferenceUsed: false,
    sourceSceneIrHash: sourceIrResult.sourceSceneIrHash,
    playableSceneIrHash: sourceIrResult.playableSceneIrHash,
    sourceVisualIrHash: sourceIrResult.sourceVisualIrHash,
    spec: specPath,
    gameSchema: gameSchemaPath,
    snapshotSchema: path.join(outDir, 'snapshot-schema.json'),
    htmlPhaseSlices: path.join(outDir, 'html-phase-slices.json'),
    assetManifest: path.join(outDir, 'asset-manifest.json'),
    sourceVisualIr: path.join(outDir, 'source-visual-ir.json'),
    visualRuntimeContract: path.join(outDir, 'visual-runtime-contract.json'),
    playableSceneIr: path.join(outDir, 'playable-scene-ir.json'),
    blueprintProofBundle: opts.blueprintSmoke ? path.join(outDir, 'blueprint-smoke', 'blueprint-proof-bundle.json') : null,
    blueprintProofDiff: opts.blueprintSmoke ? path.join(outDir, 'blueprint-smoke', 'blueprint-proof-diff.json') : null,
    storyboardWebglVisualDiff: opts.visualDiff ? path.join(outDir, 'storyboard-webgl-visual-diff', 'report.json') : null,
    storyboardWebglVisualDiffPhases: opts.visualDiff ? opts.visualPhases : null,
    unityAssetPlan: path.join(outDir, 'unity-asset-plan.json'),
    unityEditorBaker: path.join(outDir, 'Demo2SpecVisualAssetBaker.cs'),
    sourceAssetFetcher: path.join(skillRoot, 'fetch-source-assets.js'),
    blueprintSmoke: opts.blueprintSmoke ? path.join(outDir, 'blueprint-smoke') : null,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
