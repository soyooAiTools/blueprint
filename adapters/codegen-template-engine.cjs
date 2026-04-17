/**
 * Template Engine — fills skeleton TODO markers with schema-derived C# code.
 *
 * Input:  schema (validated JSON), skeleton (string from skeleton-generator)
 * Output: { code: string, todoCount: number, templateCoverage: number }
 */

var { validateGameSchema, validateSemantics } = require('./schema/validate-schema.cjs');
var { generatePlacement, getColorOverrides } = require('./templates/placement.cjs');
var { generatePhaseInit } = require('./templates/phase-init.cjs');
var { triggerToCondition } = require('./templates/trigger-codegen.cjs');
var { generateResourceInit, generateFormInit } = require('./templates/economy.cjs');
var { generateAutoPlay } = require('./templates/autoplay-mirror.cjs');
var { generateCustomTodos } = require('./templates/custom-todo.cjs');

// NPC behavior template registry
var NPC_TEMPLATES = {
  patrol: require('./templates/npc-behaviors/patrol.cjs'),
  chase_attack: require('./templates/npc-behaviors/chase-attack.cjs'),
  static_target: require('./templates/npc-behaviors/static-target.cjs'),
  ranged_shooter: require('./templates/npc-behaviors/ranged-shooter.cjs'),
  spawner: require('./templates/npc-behaviors/spawner.cjs'),
};

function fillSkeleton(schema, skeleton) {
  // Validate
  var structErrors = validateGameSchema(schema);
  var semErrors = validateSemantics(schema);
  var allErrors = structErrors.concat(semErrors);
  if (allErrors.length > 0) {
    throw new Error('Schema validation: ' + allErrors.join('; '));
  }

  var todoMap = {};

  // TODO_VARIABLES: game config + NPC vars + playerHP if needed
  todoMap['TODO_VARIABLES'] = generateVariables(schema);

  // TODO_START: placement + resource init + form init
  todoMap['TODO_START'] = [
    generatePlacement(schema),
    generateResourceInit(schema),
    generateFormInit(schema),
  ].filter(Boolean).join('\n');

  // TODO_PHASE_N_INIT: per-phase show/hide/guide
  for (var i = 0; i < schema.phases.length; i++) {
    todoMap['TODO_PHASE_' + (i + 1) + '_INIT'] = generatePhaseInit(schema.phases[i], schema);
  }

  // TODO_UPDATE: NPC update calls + resource collection detection
  todoMap['TODO_UPDATE'] = generateUpdateBody(schema);

  // TODO_AUTOPLAY_INTERACT: mirror of interactive triggers
  todoMap['TODO_AUTOPLAY_INTERACT'] = generateAutoPlay(schema);

  // TODO_SYSTEMS: NPC full method bodies
  todoMap['TODO_SYSTEMS'] = generateSystems(schema);

  // TODO_UI: (minimal — scoreText already handled by economy kit)
  todoMap['TODO_UI'] = '';

  // TODO_CUSTOM: customLogic entries as TODO comments
  todoMap['TODO_CUSTOM'] = generateCustomTodos(schema);

  var colorOverrides = getColorOverrides(schema);
  var result = replaceAllTodos(skeleton, todoMap, colorOverrides);
  if (result.missingMarkers && result.missingMarkers.length > 0) {
    console.error('[template-engine] WARNING: skeleton missing markers for: ' + result.missingMarkers.join(', '));
  }
  return {
    code: result.code,
    todoCount: result.remainingTodos,
    templateCoverage: result.filledLines / result.totalLines,
    missingMarkers: result.missingMarkers || [],
  };
}

function generateVariables(schema) {
  var lines = [];
  // Game config vars
  var gc = schema.gameConfig || {};
  if (gc.moveSpeed) lines.push('    float moveSpeed = ' + gc.moveSpeed + 'f;');
  if (gc.collectRange) lines.push('    float collectRange = ' + gc.collectRange + 'f;');
  if (gc.maxCarry) lines.push('    int maxCarry = ' + gc.maxCarry + ';');
  // NPC variables
  var hasPlayerHP = false;
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) {
      lines.push(tmpl.generateVariables(npcs[i]));
    } else if (npcs[i].template) {
      console.error('[template-engine] WARNING: NPC template "' + npcs[i].template + '" not registered, skipping NPC "' + (npcs[i].entity || npcs[i].name || 'unknown') + '"');
    }
    if (npcs[i].params && npcs[i].params.attackDamage) hasPlayerHP = true;
  }
  if (hasPlayerHP) lines.push('    int playerHP = 10;');
  if (npcs.some(function(n) { return n.template === 'chase_attack' || n.template === 'ranged_shooter'; })) {
    lines.push('    int enemiesDefeated = 0;');
  }
  return lines.join('\n');
}

function generateUpdateBody(schema) {
  var lines = [];

  // Interactive-mode flag handlers: set Done/Acted flags on player input
  // Mirrors OnAutoPlayArrive flag assignments so flags are set in BOTH paths.
  var phases = schema.phases || [];
  if (phases.length > 0) {
    lines.push('        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {');
    for (var pi = 0; pi < phases.length; pi++) {
      var pid = phases[pi].phaseId;
      lines.push('            if (currentPhaseName == "' + pid + '") { ' + pid + 'InteractionDone = true; ' + pid + 'PlayerActed = true; }');
    }
    lines.push('        }');
    lines.push('');
  }

  // NPC update calls
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) lines.push(tmpl.generateUpdate(npcs[i]));
  }
  return lines.join('\n');
}

function generateSystems(schema) {
  var lines = [];
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) {
      lines.push(tmpl.generateSystem(npcs[i]));
      lines.push('');
    }
  }
  return lines.join('\n');
}

/**
 * Replace all TODO_X_START...TODO_X_END blocks in skeleton with generated code.
 * @param {string} skeleton - Raw skeleton string
 * @param {object} todoMap - { TODO_KEY: 'generated code' }
 * @param {object} [colorOverrides] - In-place regex replacements for Color() lines
 *   e.g. { cameraBackground: 'new Color(0.2f, 0.3f, 0.5f)', groundColor: '...' }
 */
function replaceAllTodos(skeleton, todoMap, colorOverrides) {
  var code = skeleton;
  var totalLines = code.split('\n').length;
  var filledLines = 0;
  var remainingTodos = 0;
  var missingMarkers = [];

  var keys = Object.keys(todoMap);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var startMarker = '// ' + key + '_START';
    var endMarker = '// ' + key + '_END';
    var startIdx = code.indexOf(startMarker);
    var endIdx = code.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      if (/^TODO_PHASE_\d+_INIT$/.test(key) && (todoMap[key] || '').trim().length > 0) {
        missingMarkers.push(key);
      }
      continue;
    }

    var content = todoMap[key] || '';
    if (content.trim().length === 0) {
      remainingTodos++;
      continue;
    }

    // Replace content between markers (keep markers intact)
    var beforeStart = code.substring(0, startIdx + startMarker.length);
    var afterEnd = code.substring(endIdx);
    code = beforeStart + '\n' + content + '\n        ' + afterEnd;
    filledLines += content.split('\n').length;
  }

  // In-place color overrides (regex replacement on skeleton-hardcoded Color lines)
  if (colorOverrides) {
    if (colorOverrides.cameraBackground) {
      code = code.replace(
        /mainCam\.backgroundColor\s*=\s*new Color\([^)]+\)/,
        'mainCam.backgroundColor = ' + colorOverrides.cameraBackground
      );
    }
    if (colorOverrides.groundColor) {
      code = code.replace(
        /\.material\.color\s*=\s*new Color\([^)]+\)/,
        '.material.color = ' + colorOverrides.groundColor
      );
    }
  }

  return { code: code, remainingTodos: remainingTodos, filledLines: filledLines, totalLines: totalLines, missingMarkers: missingMarkers };
}

module.exports = { fillSkeleton: fillSkeleton, replaceAllTodos: replaceAllTodos };
