/**
 * Lesson Extractor — auto-extract rules from pipeline failures
 *
 * Called at pipeline failure. Analyzes the failure context and appends
 * a structured rule to pending-rules.json for future codegen/review injection.
 *
 * Only extracts CODE-class failures (not INFRA/GATE) since those contain
 * actionable code-level lessons.
 */

var fs = require('fs');
var path = require('path');

var RULES_FILE = path.join(__dirname, '..', 'worker', 'pending-rules.json');
var MAX_RULES = 500;

// Dedup: don't add rules with near-identical descriptions
var SIMILARITY_THRESHOLD = 0.7;

function tokenize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function jaccardSimilarity(a, b) {
  var setA = new Set(tokenize(a));
  var setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  var intersection = 0;
  for (var token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function readRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch(e) {
    return [];
  }
}

function writeRules(rules) {
  // FIFO trim
  while (rules.length > MAX_RULES) rules.shift();
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf8');
  } catch(e) {
    console.error('[lesson-extractor] Write failed:', e.message);
  }
}

/**
 * Extract a lesson from a pipeline failure.
 *
 * @param {object} ctx — PipelineContext after failure
 * @returns {object|null} — the appended rule, or null if skipped
 */
function extractLesson(ctx) {
  // Only extract from CODE failures (actionable code-level lessons)
  var classification = ctx._failClassification || '';
  if (classification === 'INFRA') return null; // infra issues aren't code lessons

  var stage = ctx._failedAtStage;
  var reason = ctx._failReason;
  if (!stage || !reason) return null;

  // Map stage to a rule category + severity
  // critical = code will definitely break; warning = likely break; info = best practice
  var ruleCategory = 'General';
  var severity = 'info';
  if (stage === 'review' || stage === 'compile') {
    ruleCategory = 'Code Quality';
    severity = 'critical';
  } else if (stage === 'visual-check') {
    ruleCategory = 'Visual / Rendering';
    severity = 'warning';
  } else if (stage === 'runtime-contract' || stage === 'cua-verify') {
    ruleCategory = 'Interaction / Gameplay';
    severity = 'warning';
  } else if (stage === 'spec-validate') {
    ruleCategory = 'Spec Structure';
    severity = 'critical';
  }

  // Build description from failure reason
  var description = reason.substring(0, 500);

  // Build fix suggestion from actual failure context
  var fix = '';

  // Extract specific fix info from feedbackHistory (most recent CUA/visual diagnosis)
  var feedbackHistory = (ctx.blueprint && ctx.blueprint.feedbackHistory) || [];
  var lastDiagnosis = '';
  for (var fi = feedbackHistory.length - 1; fi >= 0; fi--) {
    var fb = feedbackHistory[fi];
    var fbText = (fb.data && fb.data.text) || fb.text || '';
    if (fbText && (fbText.indexOf('DIAGNOSIS') >= 0 || fbText.indexOf('ACTION REQUIRED') >= 0)) {
      lastDiagnosis = fbText.substring(0, 400);
      break;
    }
  }

  if (stage === 'review') {
    var reviewResult = ctx.stageResults && ctx.stageResults.review;
    if (reviewResult && reviewResult.issues && Array.isArray(reviewResult.issues)) {
      fix = reviewResult.issues.slice(0, 3).map(function(i) {
        return (i.description || i.message || String(i)).substring(0, 150);
      }).join('; ');
    }
  } else if (stage === 'compile') {
    // Extract actual compiler error from reason
    var errorMatch = reason.match(/error\s+CS\d+[^\n]*/i);
    fix = errorMatch ? errorMatch[0].substring(0, 300) : 'Fix compilation error: ' + reason.substring(0, 200);
  } else if (stage === 'visual-check' || stage === 'runtime-contract' || stage === 'cua-verify') {
    // Use last diagnosis from fix-loop feedback if available
    if (lastDiagnosis) {
      var actionMatch = lastDiagnosis.match(/ACTION REQUIRED:\s*([^\n]+)/);
      fix = actionMatch ? actionMatch[1].substring(0, 300) : lastDiagnosis.substring(0, 300);
    } else {
      fix = reason.substring(0, 300);
    }
  }

  if (!fix) fix = reason.substring(0, 300);

  // Dedup check: don't add near-duplicate rules
  var existingRules = readRules();
  for (var i = 0; i < existingRules.length; i++) {
    if (jaccardSimilarity(existingRules[i].description || '', description) > SIMILARITY_THRESHOLD) {
      // Update timestamp of existing similar rule instead of adding duplicate
      existingRules[i].lastSeenAt = new Date().toISOString();
      existingRules[i].hitCount = (existingRules[i].hitCount || 1) + 1;
      writeRules(existingRules);
      return null;
    }
  }

  var rule = {
    description: description,
    rule: ruleCategory,
    fix: fix,
    severity: severity,
    line: stage + ' stage failure',
    taskId: ctx.taskId || null,
    timestamp: new Date().toISOString(),
    autoExtracted: true,
    failClassification: classification,
    stage: stage,
  };

  existingRules.push(rule);
  writeRules(existingRules);
  console.log('[lesson-extractor] New rule extracted from ' + stage + ' failure: ' + description.substring(0, 80));
  return rule;
}

module.exports = { extractLesson: extractLesson };
