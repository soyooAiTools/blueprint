var triggerHelpers = require('./trigger-codegen.cjs');
var toLowerCamel = triggerHelpers.toLowerCamel;
var hasEntityRef = triggerHelpers.hasEntityRef;

function generateResourceVariables(schema) {
  var resources = schema.resources || [];
  var lines = [];
  var i;

  for (i = 0; i < resources.length; i++) {
    lines.push('int ' + resources[i].name + 'Carried = 0;');
  }

  return indentLines(lines, 4);
}

function generateResourceUpdate(schema) {
  var resources = schema.resources || [];
  var phases = schema.phases || [];
  var lines = [];
  var i;
  var j;

  for (i = 0; i < resources.length; i++) {
    lines = lines.concat(buildCollectBlock(resources[i]));
    if (i < resources.length - 1 || phases.length > 0) {
      lines.push('');
    }
  }

  for (j = 0; j < phases.length; j++) {
    lines = lines.concat(buildPhaseBlocks(phases[j], resources));
  }

  return indentLines(trimTrailingBlankLines(lines), 8);
}

function buildCollectBlock(resource) {
  if (!resource || !resource.name || !hasEntityRef(resource.entity)) return [];
  var resourceName = resource.name;
  var sourceEntity = toLowerCamel(resource.entity);
  var scoreVar = '_score_' + resourceName;

  return [
    'if (_collectCooldown <= 0f && IsNear(' + sourceEntity + ', collectRange)) {',
    '    if (' + resourceName + 'Carried < maxCarry) {',
    '        ' + resourceName + 'Carried++;',
    '        _collectCooldown = collectCooldownInterval;',
    '        string ' + scoreVar + ' = "' + escapeString(resourceName) + ': " + ' + resourceName + 'Carried + "/" + maxCarry;',
    '        if (_lastScoreText != ' + scoreVar + ') { scoreText.text = ' + scoreVar + '; _lastScoreText = ' + scoreVar + '; }',
    '    }',
    '}'
  ];
}

function buildPhaseBlocks(phase, resources) {
  var trigger = phase && phase.trigger;
  if (!trigger) return [];
  if (trigger.type !== 'entity_state_reached') return [];
  if (!hasEntityRef(trigger.entity)) return [];

  var relatedResources = findRelatedResources(trigger.entity, resources);
  var targetEntity = toLowerCamel(trigger.entity);
  var deliverResources = [];
  var i;
  for (i = 0; i < relatedResources.length; i++) {
    if (relatedResources[i].convertRatio > 0) {
      deliverResources.push(relatedResources[i]);
    }
  }
  if (deliverResources.length === 0) return [];

  // Merged IsNear block: single proximity check, multiple resource deliveries inside.
  var lines = ['if (IsNear(' + targetEntity + ', 2f)) {'];
  for (i = 0; i < deliverResources.length; i++) {
    lines = lines.concat(buildDeliverBody(trigger, deliverResources[i], targetEntity));
  }
  lines.push('}');
  lines.push('');
  return lines;
}

function buildDeliverBody(trigger, resource, targetEntity) {
  var resourceName = resource.name;
  var requiredAmount = trigger.amount || resource.convertRatio;

  return [
    '    if (' + resourceName + 'Carried > 0) {',
    '        AddResource("' + escapeString(resourceName) + '", ' + resourceName + 'Carried);',
    '        ' + resourceName + 'Carried = 0;',
    '        if (GetResource("' + escapeString(resourceName) + '") >= ' + requiredAmount + ') {',
    '            ' + targetEntity + 'State++;',
    '        }',
    '    }',
  ];
}

function findRelatedResources(targetEntity, resources) {
  if (!hasEntityRef(targetEntity)) return [];
  var directMatches = [];
  var positiveRatio = [];
  var i;

  for (i = 0; i < resources.length; i++) {
    if (!resources[i] || !hasEntityRef(resources[i].entity)) continue;
    if (resources[i].convertRatio > 0) {
      positiveRatio.push(resources[i]);
    }
    if (resources[i].entity === targetEntity) {
      directMatches.push(resources[i]);
    }
  }

  if (directMatches.length > 0) return directMatches;
  return positiveRatio;
}

function trimTrailingBlankLines(lines) {
  var result = lines.slice();
  while (result.length > 0 && result[result.length - 1] === '') {
    result.pop();
  }
  return result;
}

function indentLines(lines, spaces) {
  var indent = repeatSpace(spaces);
  var output = [];
  var i;

  for (i = 0; i < lines.length; i++) {
    output.push(lines[i] ? indent + lines[i] : '');
  }

  return output.join('\n');
}

function repeatSpace(count) {
  var out = '';
  var i;
  for (i = 0; i < count; i++) {
    out += ' ';
  }
  return out;
}

function escapeString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

module.exports = {
  generateResourceUpdate: generateResourceUpdate,
  generateResourceVariables: generateResourceVariables
};
