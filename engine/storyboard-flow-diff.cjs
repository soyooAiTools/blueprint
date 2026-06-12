'use strict';

var fs = require('fs');
var path = require('path');

var {
  buildSourceSceneIrFromStoryboardFlow,
  loadStoryboardFlow,
  preflightStoryboardFlow,
} = require('./storyboard-flow-source-ir.cjs');
var {
  extractSourceSceneIrFromHtml,
  normalizeSourceSceneIr,
} = require('./source-scene-ir.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function unique(values) {
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

function gateSignature(gate) {
  if (!isObject(gate)) return '';
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    return gate.kind + '(' + safeArray(gate.gates).map(gateSignature).join('&') + ')';
  }
  return [
    gate.kind || '',
    gate.resource || '',
    gate.entity || gate.target || gate.ctaId || '',
    gate.threshold != null ? gate.threshold : '',
    gate.state != null ? gate.state : '',
    gate.radius != null ? gate.radius : '',
  ].join(':');
}

function stepTarget(step) {
  return step && (step.target || step.from || step.to || step.entity || step.ctaId) || '';
}

function stepSignature(step) {
  if (!isObject(step)) return '';
  return [
    step.kind || '',
    step.resource || '',
    stepTarget(step),
    step.amount != null ? step.amount : '',
    step.level != null ? step.level : '',
    step.state != null ? step.state : '',
  ].join(':');
}

function phaseSummary(phase) {
  phase = isObject(phase) ? phase : {};
  var steps = safeArray(phase.steps);
  var resources = unique(steps.map(function(step) { return step && step.resource || ''; }));
  var firstTarget = '';
  for (var i = 0; i < steps.length; i += 1) {
    firstTarget = stepTarget(steps[i]);
    if (firstTarget) break;
  }
  return {
    id: phase.id || '',
    title: phase.title || '',
    guideText: phase.guideText || '',
    goalText: phase.goalText || '',
    primaryTarget: firstTarget || safeArray(phase.targetSequence)[0] || '',
    resources: resources,
    showEntities: unique(phase.showEntities),
    gate: gateSignature(phase.gate),
    steps: steps.map(stepSignature).filter(Boolean),
  };
}

function sourceSummary(sourceIr) {
  var ir = normalizeSourceSceneIr(sourceIr, {});
  return {
    projectName: ir.project && ir.project.name || '',
    phaseCount: safeArray(ir.phases).length,
    entityCount: safeArray(ir.entities).length,
    resourceCount: safeArray(ir.resources).length,
    resources: safeArray(ir.resources).map(function(resource) {
      return { id: resource.id, label: resource.label, carrierEntity: resource.carrierEntity || null };
    }),
    phases: safeArray(ir.phases).map(phaseSummary),
    semanticHash: ir.semanticHash || null,
  };
}

function addDiff(diffs, severity, code, message, extra) {
  diffs.push(Object.assign({
    severity: severity,
    code: code,
    message: message,
  }, extra || {}));
}

function sameArray(a, b) {
  return JSON.stringify(safeArray(a)) === JSON.stringify(safeArray(b));
}

function comparePhase(flowPhase, htmlPhase, index, diffs) {
  var ref = {
    phaseIndex: index,
    flowPhaseId: flowPhase && flowPhase.id || null,
    htmlPhaseId: htmlPhase && htmlPhase.id || null,
  };
  if (!flowPhase) {
    addDiff(diffs, 'blocker', 'flow_phase_missing', 'Flow SourceIR is missing a phase present in storyboard2html.', ref);
    return;
  }
  if (!htmlPhase) {
    addDiff(diffs, 'blocker', 'storyboard2html_phase_missing', 'Storyboard2html SourceIR is missing a phase present in Flow.', ref);
    return;
  }
  if (flowPhase.guideText !== htmlPhase.guideText) {
    addDiff(diffs, 'warn', 'phase_guide_text_diff', 'Phase guideText differs.', Object.assign({}, ref, {
      flow: flowPhase.guideText,
      storyboard2html: htmlPhase.guideText,
    }));
  }
  if (flowPhase.primaryTarget !== htmlPhase.primaryTarget) {
    addDiff(diffs, 'warn', 'phase_primary_target_diff', 'Primary target differs.', Object.assign({}, ref, {
      flow: flowPhase.primaryTarget,
      storyboard2html: htmlPhase.primaryTarget,
    }));
  }
  if (!sameArray(flowPhase.resources, htmlPhase.resources)) {
    addDiff(diffs, 'warn', 'phase_resources_diff', 'Phase resource set differs.', Object.assign({}, ref, {
      flow: flowPhase.resources,
      storyboard2html: htmlPhase.resources,
    }));
  }
  if (flowPhase.gate !== htmlPhase.gate) {
    addDiff(diffs, 'warn', 'phase_gate_diff', 'Phase completion gate differs.', Object.assign({}, ref, {
      flow: flowPhase.gate,
      storyboard2html: htmlPhase.gate,
    }));
  }
  if (!sameArray(flowPhase.steps, htmlPhase.steps)) {
    addDiff(diffs, 'warn', 'phase_steps_diff', 'Phase step sequence differs.', Object.assign({}, ref, {
      flow: flowPhase.steps,
      storyboard2html: htmlPhase.steps,
    }));
  }
}

function countDiffs(diffs) {
  return diffs.reduce(function(out, diff) {
    out[diff.severity] = Number(out[diff.severity] || 0) + 1;
    return out;
  }, {});
}

function compareSourceSceneIr(flowSourceIr, storyboardSourceIr, options) {
  options = options || {};
  var flow = sourceSummary(flowSourceIr);
  var storyboard = sourceSummary(storyboardSourceIr);
  var diffs = [];
  if (flow.phaseCount !== storyboard.phaseCount) {
    addDiff(diffs, 'blocker', 'phase_count_diff', 'Runtime phase count differs.', {
      flow: flow.phaseCount,
      storyboard2html: storyboard.phaseCount,
    });
  }
  if (!sameArray(flow.resources.map(function(r) { return r.id; }), storyboard.resources.map(function(r) { return r.id; }))) {
    addDiff(diffs, 'warn', 'resource_catalog_diff', 'Resource catalog ids differ.', {
      flow: flow.resources,
      storyboard2html: storyboard.resources,
    });
  }
  var max = Math.max(flow.phaseCount, storyboard.phaseCount);
  for (var i = 0; i < max; i += 1) {
    comparePhase(flow.phases[i], storyboard.phases[i], i, diffs);
  }
  var counts = countDiffs(diffs);
  return {
    schemaVersion: 'storyboard-flow-diff-report.v1',
    kind: 'blueprint.storyboardFlowDiffReport',
    generatedAt: options.generatedAt || new Date().toISOString(),
    mode: options.mode || 'flow-vs-storyboard2html',
    passed: !(counts.blocker > 0),
    diffCounts: {
      blocker: counts.blocker || 0,
      warn: counts.warn || 0,
      info: counts.info || 0,
    },
    flowSummary: flow,
    storyboard2htmlSummary: storyboard,
    diffs: diffs,
  };
}

function buildStoryboardFlowDiffReport(flow, sourceHtmlPath, options) {
  options = options || {};
  var sourcePath = path.resolve(sourceHtmlPath);
  var html = fs.readFileSync(sourcePath, 'utf8');
  var storyboardSourceIr = extractSourceSceneIrFromHtml(html, sourcePath, {
    requireSourceIrRenderer: true,
  });
  var authoring = preflightStoryboardFlow(flow, {
    generatedAt: options.generatedAt,
  });
  var flowSourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
    sourceHtmlPath: options.flowSourceHtmlPath || null,
    generatedAt: options.generatedAt,
  });
  var report = compareSourceSceneIr(flowSourceIr, storyboardSourceIr, {
    generatedAt: options.generatedAt,
  });
  report.input = {
    flowPath: options.flowPath || null,
    sourceHtmlPath: sourcePath,
  };
  report.authoringPreflight = {
    passed: authoring.passed,
    issueCounts: authoring.issueCounts,
    resourceSnapshots: authoring.resourceSnapshots,
  };
  if (authoring.passed !== true) {
    report.passed = false;
    report.diffCounts.blocker += 1;
    report.diffs.unshift({
      severity: 'blocker',
      code: 'flow_authoring_preflight_failed',
      message: 'Flow authoring preflight must pass before diff can be trusted.',
      issueCounts: authoring.issueCounts,
    });
  }
  return report;
}

function buildStoryboardFlowDiffReportFromFiles(flowPath, sourceHtmlPath, options) {
  options = options || {};
  var flow = loadStoryboardFlow(flowPath);
  return buildStoryboardFlowDiffReport(flow, sourceHtmlPath, Object.assign({}, options, {
    flowPath: path.resolve(flowPath),
  }));
}

function writeDiffReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  var reportPath = path.join(outDir, 'storyboard-flow-diff-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return reportPath;
}

module.exports = {
  phaseSummary: phaseSummary,
  sourceSummary: sourceSummary,
  compareSourceSceneIr: compareSourceSceneIr,
  buildStoryboardFlowDiffReport: buildStoryboardFlowDiffReport,
  buildStoryboardFlowDiffReportFromFiles: buildStoryboardFlowDiffReportFromFiles,
  writeDiffReport: writeDiffReport,
};
