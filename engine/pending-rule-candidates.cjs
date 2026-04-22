#!/usr/bin/env node

var crypto = require('crypto');
var isSkeletonReviewFalsePositive = require('../worker/code-reviewer.js').isSkeletonReviewFalsePositive;

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

function normalizeRuleKey(item) {
  var rule = String(item && item.rule || 'unknown').toLowerCase();
  return rule.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
}

function severityRank(severity) {
  severity = String(severity || '').toLowerCase();
  if (severity === 'critical') return 4;
  if (severity === 'warning' || severity === 'warn') return 3;
  if (severity === 'medium') return 2;
  if (severity === 'low' || severity === 'info') return 1;
  return 0;
}

function summarizePendingRules(pendingRules, opts) {
  opts = opts || {};
  var minProjects = opts.minProjects == null ? 2 : opts.minProjects;
  var updatedAt = opts.updatedAt || new Date().toISOString();
  var groups = {};
  var list = Array.isArray(pendingRules) ? pendingRules : [];

  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || isSkeletonReviewFalsePositive(item)) continue;
    var key = normalizeRuleKey(item);
    if (!groups[key]) {
      groups[key] = {
        rule: item.rule || 'unknown',
        bestDesc: item.description || '',
        bestFix: item.fix || '',
        severity: item.severity || 'info',
        hitCount: 0,
        projects: {},
        sampleSnippets: []
      };
    }
    var group = groups[key];
    group.hitCount++;
    if ((item.description || '').length > (group.bestDesc || '').length) group.bestDesc = item.description || '';
    if ((item.fix || '').length > (group.bestFix || '').length) group.bestFix = item.fix || '';
    if (severityRank(item.severity) > severityRank(group.severity)) group.severity = item.severity || group.severity;
    if (item.taskId) group.projects[item.taskId] = true;
    if (item.description && group.sampleSnippets.length < 3) {
      group.sampleSnippets.push(String(item.description).slice(0, 220));
    }
  }

  var items = Object.keys(groups).map(function(key) {
    var group = groups[key];
    var sampleTaskIds = Object.keys(group.projects);
    var phrase = String(group.bestDesc || group.rule || key);
    return {
      id: 'pr-' + sha(key + '|' + phrase),
      phrase: phrase,
      hitCount: group.hitCount,
      uniqueTasks: sampleTaskIds.length,
      sampleTaskIds: sampleTaskIds.slice(0, 5),
      sampleSnippets: group.sampleSnippets,
      suggestedRule: {
        slug: 'pending-rule-' + slugify(group.rule || key) + '-' + sha(key),
        severity: group.severity || 'info',
        description: 'Auto-mined from ' + group.hitCount + ' reviewer warnings: ' + phrase.slice(0, 120),
        regexHint: phrase.slice(0, 180)
      },
      status: 'candidate'
    };
  }).filter(function(item) {
    return item.uniqueTasks >= minProjects;
  }).sort(function(a, b) {
    if (b.uniqueTasks !== a.uniqueTasks) return b.uniqueTasks - a.uniqueTasks;
    return b.hitCount - a.hitCount;
  });

  return {
    updatedAt: updatedAt,
    count: items.length,
    items: items
  };
}

module.exports = {
  summarizePendingRules: summarizePendingRules
};
