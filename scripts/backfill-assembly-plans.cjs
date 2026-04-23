#!/usr/bin/env node
var fs = require('fs');
var path = require('path');

var { ensureProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');

var argv = process.argv.slice(2);
var dryRun = argv.indexOf('--dry-run') >= 0;
var force = argv.indexOf('--force') >= 0;
var projectsDir = process.env.PROJECTS_DIR || path.join(__dirname, '..', 'server-data', 'projects');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stable(value) {
  return JSON.stringify(value);
}

function summarizeProject(project) {
  var plans = project && project.plans || {};
  return {
    atoms: plans.storyboardAtomPlan && plans.storyboardAtomPlan.items ? plans.storyboardAtomPlan.items.length : 0,
    modules: plans.assemblyPlan && plans.assemblyPlan.moduleInstances ? plans.assemblyPlan.moduleInstances.length : 0,
    cuaSteps: plans.cuaPlan && plans.cuaPlan.steps ? plans.cuaPlan.steps.length : 0,
    unresolved: plans.assemblyPlan && plans.assemblyPlan.unresolved ? plans.assemblyPlan.unresolved.length : 0,
  };
}

if (!fs.existsSync(projectsDir)) {
  console.error('[backfill-assembly-plans] projects dir not found:', projectsDir);
  process.exit(1);
}

var files = fs.readdirSync(projectsDir).filter(function(name) { return /\.json$/i.test(name); }).sort();
var scanned = 0;
var updated = 0;
var skipped = 0;
var failed = 0;

files.forEach(function(name) {
  var filePath = path.join(projectsDir, name);
  scanned++;
  try {
    var project = readJson(filePath);
    var before = stable(project.plans || null);
    var hadPlans = !!project.plans;
    if (!hadPlans || force) {
      ensureProjectPlans(project);
    }
    var after = stable(project.plans || null);
    if (before === after && hadPlans && !force) {
      skipped++;
      return;
    }
    if (!dryRun) {
      project.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf8');
    }
    updated++;
    var summary = summarizeProject(project);
    console.log('[backfill-assembly-plans] ' + (dryRun ? 'would update' : 'updated') + ' ' + project.id + ' ' +
      '(atoms=' + summary.atoms + ', modules=' + summary.modules + ', cuaSteps=' + summary.cuaSteps + ', unresolved=' + summary.unresolved + ')');
  } catch (err) {
    failed++;
    console.error('[backfill-assembly-plans] failed for ' + name + ': ' + err.message);
  }
});

console.log('[backfill-assembly-plans] scanned=' + scanned + ' updated=' + updated + ' skipped=' + skipped + ' failed=' + failed + ' dryRun=' + dryRun);
if (failed > 0) process.exit(1);
