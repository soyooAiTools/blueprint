/**
 * Mechanics Resolver — Generate structured gameplay mechanics from interaction verbs
 *
 * Converts abstract verbs (collect:wood:3) into concrete implementation specs:
 * - method (proximity_trigger, click, drag, auto_timer)
 * - C# code hints for the AI
 * - visual feedback patterns
 *
 * This eliminates the ambiguity that causes AI to guess wrong implementation patterns.
 */

// Verb → implementation mechanics mapping
var VERB_MECHANICS = {
  // Basic interactions
  move_to: {
    method: 'proximity_trigger',
    radius: 2.0,
    codeHint: 'Vector3.Distance(player.transform.position, TARGET.transform.position) < RADIUS',
    visualFeedback: 'none',
    description: 'Player moves near target, triggers when within radius',
  },
  click: {
    method: 'raycast_click',
    radius: 0,
    codeHint: 'if (Input.GetMouseButtonDown(0)) { Ray ray = mainCam.ScreenPointToRay(Input.mousePosition); RaycastHit hit; if (Physics.Raycast(ray, out hit) && hit.collider.gameObject == TARGET) { /* clicked */ } }',
    visualFeedback: 'scale_bounce',
    description: 'Player clicks/taps on the target object',
  },
  drag: {
    method: 'drag_drop',
    radius: 0,
    codeHint: 'Track Input.GetMouseButton states: down=start drag, held=move with finger, up=check drop zone',
    visualFeedback: 'follow_finger',
    description: 'Player drags object from source to destination',
  },
  hold: {
    method: 'hold_timer',
    radius: 0,
    codeHint: 'if (Input.GetMouseButton(0)) holdTimer += dt; else holdTimer = 0f; if (holdTimer >= DURATION) { /* held */ }',
    visualFeedback: 'progress_bar',
    description: 'Player holds finger on target for N seconds',
  },

  // Economy verbs
  collect: {
    method: 'proximity_auto',
    radius: 1.5,
    codeHint: 'if (Vector3.Distance(player.transform.position, SOURCE.transform.position) < 1.5f && carrying < carryMax) { carrying++; HideObj(SOURCE); /* show stack on player */ }',
    visualFeedback: 'float_up_text',
    description: 'Player walks near resource, auto-collects on proximity',
    idleKit: 'TryCollect(source, resourceType, maxCarry, radius)',
  },
  deliver: {
    method: 'proximity_auto',
    radius: 1.5,
    codeHint: 'if (Vector3.Distance(player.transform.position, TARGET.transform.position) < 1.5f && carrying > 0) { carrying--; TARGETState++; /* animate delivery */ }',
    visualFeedback: 'deposit_animation',
    description: 'Player walks near building, auto-delivers carried items',
    idleKit: 'TryDeliver(target, resourceType, radius)',
  },
  spend: {
    method: 'proximity_trigger',
    radius: 2.0,
    codeHint: 'if (gold >= COST && Vector3.Distance(player.transform.position, TARGET.transform.position) < 2f) { gold -= COST; /* trigger purchase */ }',
    visualFeedback: 'float_up_text',
    description: 'Spend resources when near a purchase point',
  },

  // Building verbs
  build: {
    method: 'spend_and_wait',
    radius: 2.0,
    codeHint: 'if (gold >= buildCost && Vector3.Distance(player.transform.position, TARGET.transform.position) < 2f) { gold -= buildCost; TARGETState = 1; /* start build timer */ } if (TARGETState == 1) { buildTimer += dt; if (buildTimer >= buildTime) TARGETState = 2; }',
    visualFeedback: 'scale_grow',
    description: 'Spend resources + wait for build timer to complete',
  },
  upgrade: {
    method: 'spend_and_instant',
    radius: 2.0,
    codeHint: 'if (gold >= upgradeCost && Vector3.Distance(player.transform.position, TARGET.transform.position) < 2f) { gold -= upgradeCost; TARGETState++; SetScale(TARGET, 1.5f * TARGETState, 1.5f * TARGETState, 1.5f * TARGETState); }',
    visualFeedback: 'scale_grow',
    description: 'Spend resources to instantly level up',
  },
  unlock: {
    method: 'spend_and_instant',
    radius: 2.0,
    codeHint: 'if (gold >= unlockCost) { gold -= unlockCost; PlaceObj(TARGET, targetX, 0.5f, targetZ); TARGETState = 2; }',
    visualFeedback: 'appear_animation',
    description: 'Spend resources to reveal hidden content',
  },

  // Combat verbs
  defeat: {
    method: 'attack_hp',
    radius: 3.0,
    codeHint: 'if (Vector3.Distance(player.transform.position, ENEMY.transform.position) < attackRange) { enemyHP -= damage * dt; if (enemyHP <= 0) { HideObj(ENEMY); ENEMYState = 2; } }',
    visualFeedback: 'hp_bar',
    description: 'Attack enemy until HP reaches 0',
  },
  defeat_count: {
    method: 'kill_counter',
    radius: 3.0,
    codeHint: 'int killCount = 0; /* in attack logic: */ killCount++; if (killCount >= TARGET_COUNT) { /* wave complete */ }',
    visualFeedback: 'counter_text',
    description: 'Defeat N enemies total',
  },
  defend: {
    method: 'survive_timer',
    radius: 0,
    codeHint: 'defendTimer += dt; if (baseHP > 0 && defendTimer >= DURATION) { /* defense successful */ }',
    visualFeedback: 'timer_bar',
    description: 'Survive for N seconds without base being destroyed',
  },
  attack: {
    method: 'click_attack',
    radius: 0,
    codeHint: 'if (Input.GetMouseButtonDown(0)) { /* fire projectile or trigger attack animation */ }',
    visualFeedback: 'attack_animation',
    description: 'Player clicks to attack',
  },

  // State verbs
  wait: {
    method: 'auto_timer',
    radius: 0,
    codeHint: 'waitTimer += dt; if (waitTimer >= DURATION) { /* auto-advance */ }',
    visualFeedback: 'none',
    description: 'Wait for N seconds (auto-advance)',
  },
  reach: {
    method: 'proximity_trigger',
    radius: 1.5,
    codeHint: 'Vector3.Distance(player.transform.position, TARGET.transform.position) < 1.5f',
    visualFeedback: 'none',
    description: 'Player reaches target position',
  },

  // SLG verbs
  recruit: {
    method: 'spend_and_spawn',
    radius: 2.0,
    codeHint: 'if (gold >= recruitCost) { gold -= recruitCost; PlaceObj(UNIT, spawnX, 0.5f, spawnZ); unitCount++; }',
    visualFeedback: 'appear_animation',
    description: 'Spend resources to spawn units',
  },
  deploy: {
    method: 'drag_drop',
    radius: 0,
    codeHint: 'Drag unit from barracks to deployment position on the map',
    visualFeedback: 'ghost_preview',
    description: 'Drag unit to position',
  },
  merge: {
    method: 'drag_overlap',
    radius: 0,
    codeHint: 'Drag unit onto same-type unit to merge/upgrade',
    visualFeedback: 'merge_animation',
    description: 'Drag two units together to merge',
  },
};

/**
 * Resolve mechanics for a spec's required interactions
 * @param {Array} specs - Phase specs
 * @returns {Array} specs with mechanics field added to each
 */
function resolveMechanics(specs) {
  return specs.map(function(spec) {
    var resolved = JSON.parse(JSON.stringify(spec));
    var interactions = resolved.requiredInteractions || [];
    resolved.mechanics = [];

    for (var i = 0; i < interactions.length; i++) {
      var parts = interactions[i].split(':');
      var verb = parts[0];
      var target = parts[1] || '';
      var arg2 = parts[2] || '';

      var mechTemplate = VERB_MECHANICS[verb];
      if (!mechTemplate) {
        resolved.mechanics.push({
          verb: verb,
          target: target,
          method: 'unknown',
          codeHint: '/* AI: implement ' + interactions[i] + ' */',
          visualFeedback: 'none',
        });
        continue;
      }

      // Generate concrete code hint by replacing TARGET placeholder
      var concreteHint = mechTemplate.codeHint
        .replace(/TARGET/g, target || 'targetObj')
        .replace(/SOURCE/g, target || 'sourceObj')
        .replace(/ENEMY/g, target || 'enemy')
        .replace(/UNIT/g, target || 'unit')
        .replace(/RADIUS/g, String(mechTemplate.radius))
        .replace(/DURATION/g, arg2 || '3')
        .replace(/COST/g, arg2 || '10')
        .replace(/TARGET_COUNT/g, arg2 || '10');

      resolved.mechanics.push({
        verb: verb,
        target: target,
        arg: arg2,
        method: mechTemplate.method,
        radius: mechTemplate.radius,
        codeHint: concreteHint,
        visualFeedback: mechTemplate.visualFeedback,
        description: mechTemplate.description,
        idleKit: mechTemplate.idleKit || null,
      });
    }

    return resolved;
  });
}

/**
 * Generate mechanics documentation for injection into codegen prompt
 */
function buildMechanicsDoc(specs) {
  var lines = [];
  lines.push('\n=== GAMEPLAY MECHANICS (auto-resolved from interaction verbs) ===\n');

  for (var i = 0; i < specs.length; i++) {
    var spec = specs[i];
    if (!spec.mechanics || spec.mechanics.length === 0) continue;

    lines.push('Phase ' + (i + 1) + ' (' + spec.phaseId + ') mechanics:');
    for (var j = 0; j < spec.mechanics.length; j++) {
      var m = spec.mechanics[j];
      lines.push('  • ' + m.verb + ':' + m.target + (m.arg ? ':' + m.arg : ''));
      lines.push('    Method: ' + m.method + (m.radius > 0 ? ' (radius=' + m.radius + ')' : ''));
      lines.push('    Code: ' + m.codeHint);
      if (m.idleKit) {
        lines.push('    IdleKit shortcut: ' + m.idleKit);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { resolveMechanics: resolveMechanics, buildMechanicsDoc: buildMechanicsDoc };
