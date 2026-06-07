#!/usr/bin/env node
'use strict';

var path = require('path');
var fs = require('fs');
var spawnSync = require('child_process').spawnSync;
var contract = require('../engine/storyboard2html-contract.cjs');
var hardgate = require('../engine/storyboard2html-hardgate.cjs');
var playableFlowManifest = require('../engine/playable-flow-manifest.cjs');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');

function usage() {
  console.error([
    'Usage: node scripts/storyboard2html-smoke.cjs <generated.html> <outdir> [--theme name] [--steps N]',
    '  [--verify-runner direct|production] [--dry-run] [--visual-diff]',
    '  [--visual-phases phase8|6-8|phase6,phase8] [--ir-only] [--legacy-demo2spec]',
    '  [--require-source-ir-renderer] [--allow-non-renderer-html] [--skill-root path]',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    html: null,
    outDir: null,
    themeHint: 'default',
    steps: 40,
    verifyRunner: null,
    skillRoot: null,
    dryRun: false,
    requireSourceIrRenderer: true,
    smokeMode: 'source-ir-only',
    legacyDemo2spec: false,
    visualDiff: false,
    visualPhases: null,
  };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--theme') {
      opts.themeHint = argv[++i] || opts.themeHint;
    } else if (arg === '--steps') {
      opts.steps = Number(argv[++i] || 0) || opts.steps;
    } else if (arg === '--verify-runner') {
      opts.verifyRunner = argv[++i] || opts.verifyRunner;
    } else if (arg === '--skill-root') {
      opts.skillRoot = argv[++i] || opts.skillRoot;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--require-source-ir-renderer' || arg === '--require-renderer') {
      opts.requireSourceIrRenderer = true;
    } else if (arg === '--allow-non-renderer-html') {
      opts.requireSourceIrRenderer = false;
    } else if (arg === '--ir-only' || arg === '--source-ir-only') {
      opts.smokeMode = 'source-ir-only';
      opts.legacyDemo2spec = false;
    } else if (arg === '--legacy-demo2spec') {
      opts.smokeMode = 'legacy-demo2spec';
      opts.legacyDemo2spec = true;
    } else if (arg === '--visual-diff') {
      opts.visualDiff = true;
    } else if (arg === '--visual-phases' || arg === '--visual-diff-phases') {
      opts.visualPhases = argv[++i] || null;
      if (!opts.visualPhases || /^--/.test(opts.visualPhases)) usage();
      opts.visualDiff = true;
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

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function runPreflight(plan, opts) {
  var reportPath = plan.artifacts.preflightReport;
  var result = hardgate.evaluateHtmlPreflightFile(path.resolve(opts.html));
  var report = {
    schemaVersion: 'blueprint-storyboard2html-preflight.v1',
    stage: 'storyboard2html-html-preflight',
    htmlPath: path.resolve(opts.html),
    passed: result.passed === true,
    errors: result.errors || [],
    details: {
      userInputListenerCount: result.userInputListenerCount,
      userInputEvents: result.userInputEvents,
      autoProgressPatternCount: result.autoProgressPatternCount,
      directCompletionPatternCount: result.directCompletionPatternCount,
      hasJoystickControl: result.hasJoystickControl,
      phaseCount: result.phaseCount,
      expectedPhaseCount: result.expectedPhaseCount,
      nonFinalClickEntityCount: result.nonFinalClickEntityCount,
      nonFinalMissingJoystickEvidenceCount: result.nonFinalMissingJoystickEvidenceCount,
      ctaUngatedHandlerCount: result.ctaUngatedHandlerCount,
      entityCount: result.entityCount,
    },
    generatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  playableFlowManifest.recordStoryboard2HtmlPreflight({
    manifestPath: process.env.PLAYABLE_FLOW_MANIFEST_PATH || plan.artifacts.flowManifest,
    outDir: path.resolve(opts.outDir),
    htmlPath: path.resolve(opts.html),
    preflightPath: reportPath,
    preflightResult: report,
  });
  if (!report.passed) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error('storyboard2html preflight failed before CUA: ' + report.errors.slice(0, 4).join('; '));
  }
  console.log('[storyboard2html-smoke] preflight PASS -> ' + reportPath);
  return report;
}

function runSourceSceneIrPreflight(plan, opts) {
  var reportPath = plan.artifacts.sourceSceneIrPreflightReport;
  var htmlPath = path.resolve(opts.html);
  var html = fs.readFileSync(htmlPath, 'utf8');
  var report = sourceSceneIr.preflightSourceSceneIrHtml(html, {
    sourceHtmlPath: htmlPath,
    requireSourceIrRenderer: opts.requireSourceIrRenderer,
  });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  playableFlowManifest.updateManifest({
    manifestPath: process.env.PLAYABLE_FLOW_MANIFEST_PATH || plan.artifacts.flowManifest,
    outDir: path.resolve(opts.outDir),
  }, {
    artifacts: {
      generatedHtml: playableFlowManifest.artifactFor(htmlPath),
      sourceSceneIrPreflightReport: playableFlowManifest.artifactFor(reportPath),
    },
    stages: {
      sourceSceneIrPreflight: {
        recordedAt: new Date().toISOString(),
        passed: report.passed === true,
        sourceSceneIrHash: report.summary && report.summary.sourceSceneIrHash || null,
        embeddedSourceIrPresent: !!(report.summary && report.summary.embeddedSourceIrPresent),
        legacyProjectionUsed: !!(report.summary && report.summary.legacyProjectionUsed),
        warnings: report.warnings || [],
        violations: report.violations || [],
      },
    },
    events: [{
      at: new Date().toISOString(),
      stage: 'source-scene-ir-preflight',
      passed: report.passed === true,
    }],
  });
  if (!report.passed) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error('source-scene-ir preflight failed before CUA: ' + report.violations.slice(0, 4).map(function(violation) {
      return violation.code || violation.message || JSON.stringify(violation);
    }).join('; '));
  }
  console.log('[storyboard2html-smoke] source-scene-ir preflight PASS -> ' + reportPath);
  return report;
}

function main() {
  var opts = parseArgs(process.argv);
  var plan = contract.buildAcceptancePlan({
    demo2specSkillRoot: opts.skillRoot || process.env.DEMO2SPEC_SKILL_ROOT,
    htmlPath: path.resolve(opts.html),
    outDir: path.resolve(opts.outDir),
    themeHint: opts.themeHint,
    steps: opts.steps,
    verifyRunner: opts.verifyRunner,
    requireSourceIrRenderer: opts.requireSourceIrRenderer,
    smokeMode: opts.smokeMode,
    legacyDemo2spec: opts.legacyDemo2spec,
    visualDiff: opts.visualDiff,
    visualPhases: opts.visualPhases,
  });
  if (opts.dryRun) {
    if (plan.sourceIrPreflightCommand) console.log(plan.sourceIrPreflightCommand.map(shellQuote).join(' '));
    console.log(plan.command.map(shellQuote).join(' '));
    if (plan.hardgateCommand) console.log(plan.hardgateCommand.map(shellQuote).join(' '));
    console.log('hardGates=' + plan.hardGates.join('; '));
    return;
  }
  var childEnv = Object.assign({}, process.env, {
    PLAYABLE_FLOW_MANIFEST_PATH: plan.artifacts.flowManifest,
  });
  if (process.env.STORYBOARD2HTML_SKIP_PREFLIGHT !== '1') {
    runSourceSceneIrPreflight(plan, opts);
    runPreflight(plan, opts);
  }
  var result = spawnSync(plan.command[0], plan.command.slice(1), {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'inherit',
    env: childEnv,
  });
  if (result.status !== 0) {
    throw new Error('storyboard2html smoke failed with exit ' + result.status);
  }
  if (plan.hardgateCommand) {
    var hardgate = spawnSync(plan.hardgateCommand[0], plan.hardgateCommand.slice(1), {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'inherit',
      env: childEnv,
    });
    if (hardgate.status !== 0) {
      throw new Error('storyboard2html hardgate failed with exit ' + hardgate.status);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
