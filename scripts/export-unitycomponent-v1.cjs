#!/usr/bin/env node
'use strict';

var emitter = require('../lib/unitycomponent-v1-emitter.cjs');

function usage() {
  return 'Usage: node scripts/export-unitycomponent-v1.cjs <source-ir-artifacts-dir> <unity-out-dir>';
}

function main(argv) {
  var args = (argv || process.argv).slice(2);
  if (args.length !== 2) throw new Error(usage());
  var result = emitter.emitFromArtifacts(args[0], args[1]);
  process.stdout.write(JSON.stringify({
    ok: result.report.passed,
    profile: 'unitycomponent-v1',
    root: result.root,
    semanticHash: result.spec.semanticHash,
    validation: result.report.summary
  }, null, 2) + '\n');
  if (!result.report.passed) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  main: main
};

