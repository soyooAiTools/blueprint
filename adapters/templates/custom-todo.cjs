/**
 * Converts customLogic[] entries → TODO comment blocks for Claude Code to fill.
 */

function generateCustomTodos(schema) {
  var custom = schema.customLogic || [];
  if (custom.length === 0) return '';
  var lines = [];
  for (var i = 0; i < custom.length; i++) {
    lines.push('        // TODO_CUSTOM_' + (i + 1) + ': ' + custom[i]);
  }
  return lines.join('\n');
}

module.exports = { generateCustomTodos: generateCustomTodos };
