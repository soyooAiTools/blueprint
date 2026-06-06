#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const skillRoot = __dirname;

function usage() {
  console.error('Usage: node index.js <demo.html> <outdir> [--theme name] [--blueprint-smoke] [--verify] [--verify-runner direct|production] [--steps N] [--visual-diff]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { html: null, outDir: null, theme: null, blueprintSmoke: false, verify: false, verifyRunner: null, steps: 30, visualDiff: false };
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

function main() {
  const opts = parseArgs(process.argv);
  const htmlPath = path.resolve(opts.html);
  const outDir = path.resolve(opts.outDir);
  if (!fs.existsSync(htmlPath)) throw new Error('HTML not found: ' + htmlPath);
  fs.mkdirSync(outDir, { recursive: true });

  const specPath = path.join(outDir, 'spec.json');
  const gameSchemaPath = path.join(outDir, 'gameschema.json');

  runNode(path.join(skillRoot, 'extract.js'), [htmlPath, outDir], skillRoot);

  const convertArgs = [specPath, gameSchemaPath];
  if (opts.theme) convertArgs.push('--theme', opts.theme);
  runNode(path.join(skillRoot, 'convert-to-gameschema.js'), convertArgs, skillRoot);

  if (opts.blueprintSmoke) {
    const smokeOut = path.join(outDir, 'blueprint-smoke');
    const smokeArgs = [outDir, smokeOut];
    if (opts.verify) smokeArgs.push('--verify', '--steps', String(opts.steps));
    if (opts.verifyRunner) smokeArgs.push('--verify-runner', opts.verifyRunner);
    runNode(path.join(skillRoot, 'run-blueprint-smoke.js'), smokeArgs, skillRoot);
    if (opts.visualDiff) {
      runNode(path.join(skillRoot, '..', '..', 'scripts', 'storyboard-webgl-visual-diff.cjs'), [
        '--source', htmlPath,
        '--webgl', smokeOut,
        '--out', path.join(outDir, 'storyboard-webgl-visual-diff'),
      ], path.join(skillRoot, '..', '..'));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    outDir,
    spec: specPath,
    gameSchema: gameSchemaPath,
    snapshotSchema: path.join(outDir, 'snapshot-schema.json'),
    htmlPhaseSlices: path.join(outDir, 'html-phase-slices.json'),
    assetManifest: path.join(outDir, 'asset-manifest.json'),
    playableSceneIr: path.join(outDir, 'playable-scene-ir.json'),
    blueprintProofBundle: opts.blueprintSmoke ? path.join(outDir, 'blueprint-smoke', 'blueprint-proof-bundle.json') : null,
    blueprintProofDiff: opts.blueprintSmoke ? path.join(outDir, 'blueprint-smoke', 'blueprint-proof-diff.json') : null,
    storyboardWebglVisualDiff: opts.visualDiff ? path.join(outDir, 'storyboard-webgl-visual-diff', 'report.json') : null,
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
