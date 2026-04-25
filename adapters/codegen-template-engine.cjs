/**
 * Template Engine — fills skeleton TODO markers with schema-derived C# code.
 *
 * Input:  schema (validated JSON), skeleton (string from skeleton-generator)
 * Output: { code: string, todoCount: number, templateCoverage: number }
 */

var { validateGameSchema, validateSemantics } = require('./schema/validate-schema.cjs');
var { generatePlacement, getColorOverrides } = require('./templates/placement.cjs');
var { generatePhaseInit } = require('./templates/phase-init.cjs');
var { generateResourceInit, generateFormInit } = require('./templates/economy.cjs');
var { generateAutoPlay } = require('./templates/autoplay-mirror.cjs');
var { generateCustomTodos } = require('./templates/custom-todo.cjs');
var { generateResourceUpdate, generateResourceVariables } = require('./templates/resource-flow.cjs');
var { generateUpgradeVariables, generateUpgradeUpdate } = require('./templates/upgrade-logic.cjs');
var { generateCollectUpdate } = require('./templates/interactions/collect-interaction.cjs');
var { generateDeliverUpdate } = require('./templates/interactions/deliver-sell.cjs');
var { generateCostClickUpdate } = require('./templates/interactions/cost-gated-click.cjs');
var { generateInventoryFeedback } = require('./templates/interactions/inventory-feedback.cjs');
var { generateFormSwitchUpdate } = require('./templates/interactions/form-auto-switch.cjs');
var { generateScoreDisplay } = require('./templates/interactions/score-display.cjs');
var { generateCTAHandler } = require('./templates/interactions/cta-handler.cjs');
var { generateMultiSourceCollect, generateMultiSourceVariables } = require('./templates/interactions/multi-source-collect.cjs');

// NPC behavior template registry
var NPC_TEMPLATES = {
  patrol: require('./templates/npc-behaviors/patrol.cjs'),
  chase_attack: require('./templates/npc-behaviors/chase-attack.cjs'),
  static_target: require('./templates/npc-behaviors/static-target.cjs'),
  ranged_shooter: require('./templates/npc-behaviors/ranged-shooter.cjs'),
  spawner: require('./templates/npc-behaviors/spawner.cjs'),
  wander: require('./templates/npc-behaviors/wander.cjs'),
  evade: require('./templates/npc-behaviors/evade.cjs'),
  defend: require('./templates/npc-behaviors/defend.cjs'),
  circle: require('./templates/npc-behaviors/circle.cjs'),
  group_attack: require('./templates/npc-behaviors/group-attack.cjs'),
  flee_on_hit: require('./templates/npc-behaviors/flee-on-hit.cjs'),
  boss_multiphase: require('./templates/npc-behaviors/boss-multiphase.cjs'),
};

function fillSkeleton(schema, skeleton, opts) {
  opts = opts || {};
  // Validate
  var structErrors = validateGameSchema(schema);
  var semErrors = validateSemantics(schema);
  var allErrors = structErrors.concat(semErrors);
  if (allErrors.length > 0) {
    throw new Error('Schema validation: ' + allErrors.join('; '));
  }

  var todoMap = {};

  // TODO_VARIABLES: game config + NPC vars + playerHP if needed
  // Pass skeleton to skip vars already declared by skeleton kit (idle game etc.)
  todoMap['TODO_VARIABLES'] = generateVariables(schema, skeleton);

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

  // TODO_UPDATE: NPC update calls + resource collection detection.
  // W1b: when 5-partial split is on, tap dispatch delegates to Phase_OnTap()
  // defined in GameFlowManagerMain.Flow.cs (companion partial).
  todoMap['TODO_UPDATE'] = generateUpdateBody(schema, opts);

  // TODO_AUTOPLAY_INTERACT: mirror of interactive triggers
  todoMap['TODO_AUTOPLAY_INTERACT'] = generateAutoPlay(schema);

  // TODO_SYSTEMS: NPC full method bodies
  todoMap['TODO_SYSTEMS'] = generateSystems(schema);

  // TODO_UI: (minimal — scoreText already handled by economy kit)
  todoMap['TODO_UI'] = '';

  // TODO_CUSTOM: interaction templates + remaining customLogic TODO comments
  todoMap['TODO_CUSTOM'] = [
    generateCollectUpdate(schema),
    generateMultiSourceCollect(schema),
    generateInventoryFeedback(schema),
    generateDeliverUpdate(schema),
    generateCostClickUpdate(schema),
    generateFormSwitchUpdate(schema),
    generateScoreDisplay(schema),
    generateCTAHandler(schema),
    generateCustomTodos(schema),
  ].filter(Boolean).join('\n\n');

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

function generateVariables(schema, skeleton) {
  var lines = [];
  // Game config vars — skip if skeleton already declares them (idle game kit)
  var gc = schema.gameConfig || {};
  var skeletonHas = function(varName) {
    return skeleton && (skeleton.indexOf('float ' + varName) !== -1 || skeleton.indexOf('int ' + varName) !== -1 || skeleton.indexOf(varName + ' { get') !== -1);
  };
  if (gc.moveSpeed && !skeletonHas('moveSpeed')) lines.push('    float moveSpeed = ' + gc.moveSpeed + 'f; // player movement speed from schema gameConfig');
  if (gc.collectRange && !skeletonHas('collectRange')) lines.push('    float collectRange = ' + gc.collectRange + 'f; // proximity radius for collect/deliver checks');
  if (gc.maxCarry && !skeletonHas('maxCarry')) lines.push('    int maxCarry = ' + gc.maxCarry + '; // maximum carried resource count');
  // NPC variables
  var hasPlayerHP = false;
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) {
      lines.push(annotateNpcVariableBlock(tmpl.generateVariables(npcs[i]), npcs[i]));
    } else if (npcs[i].template) {
      console.error('[template-engine] WARNING: NPC template "' + npcs[i].template + '" not registered, skipping NPC "' + (npcs[i].entity || npcs[i].name || 'unknown') + '"');
    }
    if (npcs[i].params && npcs[i].params.attackDamage) hasPlayerHP = true;
  }
  if (hasPlayerHP) lines.push('    int playerHP = 10; // player health used by NPC combat templates');
  if (npcs.some(function(n) { return n.template === 'chase_attack' || n.template === 'ranged_shooter'; })) {
    lines.push('    int enemiesDefeated = 0; // combat progress counter used by phase evidence');
  }
  // Resource flow variables
  var resourceVars = generateResourceVariables(schema);
  if (resourceVars) lines.push(resourceVars);
  // Upgrade/form tracking variables
  var upgradeVars = generateUpgradeVariables(schema);
  if (upgradeVars) lines.push(upgradeVars);
  // Multi-source extra entity variables
  var multiSrcVars = generateMultiSourceVariables(schema);
  if (multiSrcVars) lines.push(multiSrcVars);
  return lines.join('\n');
}

function npcVariableComment(varName, entityName, templateName) {
  var lower = String(varName || '').toLowerCase();
  var owner = entityName || 'NPC';
  if (/maxhp$/.test(lower)) return 'maximum hit points for ' + owner + ' combat thresholds';
  if (/lasthp$/.test(lower)) return 'previous hit-point snapshot used to detect damage on ' + owner;
  if (/hp$/.test(lower) && lower.indexOf('grouphp') < 0) return 'current hit points for ' + owner + ' combat behavior';
  if (/state$/.test(lower) && lower.indexOf('groupstate') < 0) return 'state machine value for ' + owner + ' ' + (templateName || 'npc') + ' behavior';
  if (/attacktimer$/.test(lower)) return 'cooldown timer before ' + owner + ' can apply melee damage again';
  if (/firetimer$/.test(lower)) return 'cooldown timer before ' + owner + ' can fire another projectile';
  if (/spawntimer$/.test(lower)) return 'countdown before the next spawn attempt for ' + owner;
  if (/alivecount$/.test(lower)) return 'number of spawned units currently tracked for ' + owner;
  if (/patroltimer$/.test(lower)) return 'countdown before choosing the next patrol target for ' + owner;
  if (/patroltarget$/.test(lower)) return 'current patrol destination used by ' + owner;
  if (/wandertimer$/.test(lower)) return 'countdown before changing wander direction for ' + owner;
  if (/wanderdir$/.test(lower)) return 'current randomized wander direction for ' + owner;
  if (/startpos$/.test(lower)) return 'starting position anchor for ' + owner + ' roaming bounds';
  if (/circleangle$/.test(lower)) return 'orbit angle accumulator for ' + owner + ' circular movement';
  if (/centerpos$/.test(lower)) return 'center position anchor for ' + owner + ' circular movement';
  if (/done$/.test(lower)) return 'completion flag indicating ' + owner + ' no longer needs per-frame processing';
  if (/bossphase$/.test(lower)) return 'current boss behavior phase selected from health percentage';
  if (/fleetimer$/.test(lower)) return 'remaining flee duration after ' + owner + ' takes damage';
  if (/grouphp$/.test(lower)) return 'hit-point array for each ' + owner + ' group member';
  if (/groupstate$/.test(lower)) return 'state array for each ' + owner + ' group member';
  if (/grouptimer$/.test(lower)) return 'attack cooldown array for each ' + owner + ' group member';
  if (/groupobj$/.test(lower)) return 'pooled GameObject references for ' + owner + ' group members';
  if (/groupalive$/.test(lower)) return 'alive member count used to complete ' + owner + ' group behavior';
  return 'generated ' + (templateName || 'npc') + ' state for ' + owner;
}

function annotateNpcVariableBlock(block, npc) {
  var entityName = (npc && (npc.entity || npc.name)) || 'NPC';
  var templateName = (npc && npc.template) || 'npc';
  return String(block || '').split('\n').map(function(line) {
    if (!line.trim() || line.indexOf('//') >= 0) return line;
    var m = line.match(/\b(?:bool|int|float|string|GameObject|Vector3|int\[\]|float\[\]|GameObject\[\])\s+(\w+)/);
    if (!m) return line;
    return line + ' // ' + npcVariableComment(m[1], entityName, templateName);
  }).join('\n');
}

function generateUpdateBody(schema, opts) {
  opts = opts || {};
  var lines = [];

  // Interactive-mode handling is phase/template-specific.
  // Do NOT inject generic InteractionDone/PlayerActed shortcuts here — those
  // no longer satisfy phase gates and only teach the model the wrong pattern.
  var phases = schema.phases || [];
  if (phases.length > 0) {
    if (opts.w1bSplit) {
      // W1b: delegate per-phase body to Phase_OnTap() in Flow partial.
      // Keeps Main's Update() 1 line; each phase's branch lives in its own method.
      lines.push('        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {');
      lines.push('            Phase_OnTap(); // dispatch to Phase_<id>_OnTap() in GameFlowManagerMain.Flow.cs');
      lines.push('        }');
      lines.push('');
    }
  }

  // NPC update calls
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) lines.push(tmpl.generateUpdate(npcs[i]));
  }

  // Resource flow: collect/deliver/build loops
  var resourceUpdate = generateResourceUpdate(schema);
  if (resourceUpdate) {
    lines.push('');
    lines.push(resourceUpdate);
  }

  // Upgrade/form tracking
  var upgradeUpdate = generateUpgradeUpdate(schema);
  if (upgradeUpdate) {
    lines.push('');
    lines.push(upgradeUpdate);
  }

  return lines.join('\n');
}

function generateSystems(schema) {
  var lines = [];
  var npcs = schema.npcs || [];
  for (var i = 0; i < npcs.length; i++) {
    var tmpl = NPC_TEMPLATES[npcs[i].template];
    if (tmpl) {
      lines.push('    // Update the ' + (npcs[i].entity || 'NPC') + ' ' + (npcs[i].template || 'npc') + ' behavior in a named subsystem.');
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
