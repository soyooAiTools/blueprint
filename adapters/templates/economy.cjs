/**
 * Economy template — generates ResourceDef[] init and flow calls.
 */

function generateResourceInit(schema) {
  var resources = schema.resources || [];
  if (resources.length === 0) return '';
  var lines = [];
  lines.push('        _resources = new ResourceDef[] {');
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    var comma = (i < resources.length - 1) ? ',' : '';
    lines.push('            new ResourceDef { resourceId="' + r.id + '", displayName="' + r.display + '", convertFrom="' + (r.convertFrom || '') + '", convertRatio=' + (r.convertRatio || 0) + ' }' + comma);
  }
  lines.push('        };');
  // Initialize inventory
  for (var j = 0; j < resources.length; j++) {
    lines.push('        _inventory["' + resources[j].id + '"] = 0;');
  }
  return lines.join('\n');
}

function generateFormInit(schema) {
  var forms = schema.forms || [];
  if (forms.length === 0) return '';
  var lines = [];
  lines.push('        _forms = new FormDef[] {');
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    var comma = (i < forms.length - 1) ? ',' : '';
    lines.push('            new FormDef { formId="' + f.formId + '", poolObjectName="' + f.pool + '", moveSpeed=' + f.moveSpeed + 'f, collectRange=' + f.collectRange + 'f, collectPower=' + f.collectPower + 'f, carryCapacity=' + f.carryCapacity + ', scale=' + f.scale + 'f }' + comma);
  }
  lines.push('        };');
  return lines.join('\n');
}

module.exports = { generateResourceInit: generateResourceInit, generateFormInit: generateFormInit };
