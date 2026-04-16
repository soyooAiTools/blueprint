# Schema-Driven Codegen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic AI C# generation with JSON schema + template engine, so AI outputs ~100 lines JSON instead of ~1500 lines C#, and a deterministic template engine produces 80% of the code.

**Architecture:** Three-layer system — (1) Claude Sonnet generates a JSON game schema from specs, (2) a template engine fills skeleton TODO markers with schema-derived C# code, (3) optionally Claude Code fills remaining custom TODO blocks. The existing skeleton-generator.cjs stays unchanged except for adding a TODO_CUSTOM marker pair.

**Tech Stack:** Node.js (CommonJS `var require()`), JSON Schema validation (ajv), C# code generation via string concatenation, Claude Code CLI (`--print` mode) for custom logic fill.

**Spec:** `/opt/blueprint-editor/docs/superpowers/specs/2026-04-16-schema-driven-codegen-design.md`

**Review:** Each task must be reviewed using Codex (GPT-5.4) via `codex --review` or the codex-plugin-cc before commit.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `adapters/schema/game-schema.json` | CREATE | JSON Schema definition for validation |
| `adapters/templates/trigger-codegen.cjs` | CREATE | Trigger type → C# condition expression |
| `adapters/templates/placement.cjs` | CREATE | Entity PlaceObj/HideObj/SetScale calls |
| `adapters/templates/phase-init.cjs` | CREATE | Per-phase show/hide/guide/onEnter/onComplete |
| `adapters/templates/economy.cjs` | CREATE | _resources[] init + flow calls |
| `adapters/templates/autoplay-mirror.cjs` | CREATE | Auto-generate OnAutoPlayArrive from phases |
| `adapters/templates/custom-todo.cjs` | CREATE | customLogic[] → TODO comment blocks |
| `adapters/templates/npc-behaviors/patrol.cjs` | CREATE | Patrol NPC state machine |
| `adapters/templates/npc-behaviors/chase-attack.cjs` | CREATE | Chase + attack NPC |
| `adapters/templates/npc-behaviors/static-target.cjs` | CREATE | Stationary target |
| `adapters/templates/npc-behaviors/ranged-shooter.cjs` | CREATE | Ranged shooter + projectiles |
| `adapters/templates/npc-behaviors/spawner.cjs` | CREATE | Periodic enemy spawner |
| `adapters/codegen-template-engine.cjs` | CREATE | Main engine: schema → fill skeleton TODOs |
| `engine/stages/codegen-schema.cjs` | CREATE | Schema codegen pipeline (Step 1→2→3) |
| `engine/stages/codegen-legacy.cjs` | RENAME | Current codegen.cjs, zero changes |
| `engine/stages/codegen.cjs` | MODIFY | Router: schema vs legacy |
| `adapters/skeleton-generator.cjs` | MODIFY | Add TODO_CUSTOM_START/END markers |
| `engine/metrics.cjs` | MODIFY | Add schema-specific fields |
| `fixtures/schema-codegen/valid-idle-game.json` | CREATE | Valid 3-phase test fixture |
| `fixtures/schema-codegen/invalid-no-phases.json` | CREATE | Empty phases — must fail structural validation |
| `fixtures/schema-codegen/invalid-npc-ref.json` | CREATE | NPC references non-existent entity — must fail semantic |
| `fixtures/schema-codegen/invalid-dup-entity.json` | CREATE | Duplicate entity names — must fail semantic |
| `fixtures/schema-codegen/e2e-idle-game.json` | CREATE | Full E2E test: 5 phases, NPC, economy, custom |

---

### Task 1: JSON Schema Definition + Validation

**Files:**
- Create: `adapters/schema/game-schema.json`
- Create: `adapters/schema/validate-schema.cjs`
- Create: `fixtures/schema-codegen/valid-idle-game.json`
- Create: `fixtures/schema-codegen/invalid-no-phases.json`

- [ ] **Step 1: Install ajv**

```bash
cd /opt/blueprint-editor && npm install ajv --save
```

Expected: `ajv` added to package.json dependencies.

- [ ] **Step 2: Write game-schema.json**

Create `/opt/blueprint-editor/adapters/schema/game-schema.json` — the full JSON Schema (draft-07) covering all 7 top-level fields: `gameConfig`, `entities`, `resources`, `forms`, `phases`, `npcs`, `customLogic`.

Key constraints to encode:
- `phases`: minItems 1
- `phases[0].showEntities`: minItems 3
- `phases[-1].trigger`: must contain `click_entity` (validated in code, not schema)
- `entities[].pool`: pattern `^__Pool_[A-Z][a-z]+_[A-Z][a-z]+_\\d{2}$`
- `entities[].scale`: minimum 0.3
- `resources[].convertRatio`: type integer, minimum 0
- `npcs[].template`: enum `["patrol","chase_attack","static_target","ranged_shooter","spawner"]`
- `trigger.type`: enum of 8 types
- `trigger.timer` requires it appear inside `compound` only (validated in code)

- [ ] **Step 3: Write validate-schema.cjs**

Create `/opt/blueprint-editor/adapters/schema/validate-schema.cjs`:

```javascript
var Ajv = require('ajv');
var fs = require('fs');
var path = require('path');

var schemaPath = path.join(__dirname, 'game-schema.json');
var schemaDef = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
var ajv = new Ajv({ allErrors: true });
var validate = ajv.compile(schemaDef);

/**
 * @param {object} schema - The game schema object to validate
 * @returns {string[]} Array of error messages, empty if valid
 */
function validateGameSchema(schema) {
  var valid = validate(schema);
  if (valid) return [];
  return validate.errors.map(function(e) {
    return e.instancePath + ' ' + e.message;
  });
}

/**
 * Semantic validations beyond JSON Schema structural checks.
 * @param {object} schema
 * @returns {string[]}
 */
function validateSemantics(schema) {
  var errors = [];
  // Last phase must have click_entity trigger
  var lastPhase = schema.phases[schema.phases.length - 1];
  if (!hasClickEntityTrigger(lastPhase.trigger)) {
    errors.push('Last phase trigger must include click_entity (CTA button)');
  }
  // timer cannot be standalone trigger
  for (var i = 0; i < schema.phases.length; i++) {
    if (schema.phases[i].trigger.type === 'timer') {
      errors.push('Phase ' + schema.phases[i].phaseId + ': timer trigger must be inside compound');
    }
  }
  // NPC entity references must exist
  var entityNames = {};
  for (var j = 0; j < schema.entities.length; j++) {
    entityNames[schema.entities[j].name] = true;
  }
  for (var k = 0; k < (schema.npcs || []).length; k++) {
    if (!entityNames[schema.npcs[k].entity]) {
      errors.push('NPC references non-existent entity: ' + schema.npcs[k].entity);
    }
  }
  // No duplicate entity names
  var seen = {};
  for (var m = 0; m < schema.entities.length; m++) {
    if (seen[schema.entities[m].name]) {
      errors.push('Duplicate entity name: ' + schema.entities[m].name);
    }
    seen[schema.entities[m].name] = true;
  }
  return errors;
}

function hasClickEntityTrigger(trigger) {
  if (!trigger) return false;
  if (trigger.type === 'click_entity') return true;
  if (trigger.type === 'compound' && trigger.triggers) {
    return trigger.triggers.some(hasClickEntityTrigger);
  }
  return false;
}

module.exports = { validateGameSchema: validateGameSchema, validateSemantics: validateSemantics };
```

- [ ] **Step 4: Write test fixtures**

Create `/opt/blueprint-editor/fixtures/schema-codegen/valid-idle-game.json`:
A complete valid schema with 3 phases, 4 entities, 1 resource, no NPC, no customLogic — the simplest passing case.

Create `/opt/blueprint-editor/fixtures/schema-codegen/invalid-no-phases.json`:
A schema with `phases: []` — must fail validation.

- [ ] **Step 5: Write additional test fixtures**

Create `/opt/blueprint-editor/fixtures/schema-codegen/invalid-npc-ref.json`:
A schema with an NPC that references a non-existent entity (e.g., `"entity": "Ghost"` but no entity named "Ghost" exists). Must fail semantic validation.

Create `/opt/blueprint-editor/fixtures/schema-codegen/invalid-dup-entity.json`:
A schema with two entities sharing the same name (e.g., two entries with `"name": "Tree"`). Must fail semantic validation.

- [ ] **Step 6: Run validation tests**

```bash
cd /opt/blueprint-editor && node -e "
var v = require('./adapters/schema/validate-schema.cjs');
var valid = require('./fixtures/schema-codegen/valid-idle-game.json');
var invalid = require('./fixtures/schema-codegen/invalid-no-phases.json');
var e1 = v.validateGameSchema(valid);
console.log('Valid schema errors:', e1.length === 0 ? 'PASS' : 'FAIL — ' + e1.join('; '));
var e2 = v.validateGameSchema(invalid);
console.log('Invalid schema caught:', e2.length > 0 ? 'PASS' : 'FAIL — should have errors');
var e3 = v.validateSemantics(valid);
console.log('Semantics valid:', e3.length === 0 ? 'PASS' : 'FAIL — ' + e3.join('; '));

// NPC entity ref validation
var badNpc = require('./fixtures/schema-codegen/invalid-npc-ref.json');
var e4 = v.validateSemantics(badNpc);
console.log('NPC bad ref caught:', e4.some(function(e){return e.indexOf('non-existent entity')>=0}) ? 'PASS' : 'FAIL');

// Duplicate entity validation
var dupEnt = require('./fixtures/schema-codegen/invalid-dup-entity.json');
var e5 = v.validateSemantics(dupEnt);
console.log('Dup entity caught:', e5.some(function(e){return e.indexOf('Duplicate entity')>=0}) ? 'PASS' : 'FAIL');
"
```

Expected: All PASS.

- [ ] **Step 6: Codex review + commit**

```bash
cd /opt/blueprint-editor
# Run Codex review on new files
codex --review adapters/schema/game-schema.json adapters/schema/validate-schema.cjs
# Fix any issues flagged, then commit
git add adapters/schema/ fixtures/schema-codegen/ package.json package-lock.json
git commit -m "feat: add JSON game schema definition and validator (ajv)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Trigger Codegen Module

**Files:**
- Create: `adapters/templates/trigger-codegen.cjs`

- [ ] **Step 1: Create directories**

```bash
mkdir -p /opt/blueprint-editor/adapters/templates/npc-behaviors
```

- [ ] **Step 2: Write trigger-codegen.cjs**

Create `/opt/blueprint-editor/adapters/templates/trigger-codegen.cjs`:

```javascript
/**
 * Converts a trigger definition from game schema → C# condition expression.
 * Used by phase-init.cjs to fill skeleton CheckEventRules conditions,
 * and by autoplay-mirror.cjs to generate simulation equivalents.
 */

function toLowerCamel(name) {
  if (!name || name.length === 0) return name;
  return name[0].toLowerCase() + name.slice(1);
}

function triggerToCondition(trigger, allEntities) {
  if (!trigger || !trigger.type) return 'true /* MISSING TRIGGER */';
  switch (trigger.type) {
    case 'resource_collected':
      return 'GetResource("' + trigger.resource + '") >= ' + trigger.amount;
    case 'entity_state_reached':
      return toLowerCamel(trigger.entity) + 'State >= ' + trigger.state;
    case 'near_entity':
      return 'IsNear(' + toLowerCamel(trigger.entity) + ', ' + trigger.range + 'f)';
    case 'click_entity':
      return toLowerCamel(trigger.entity) + 'Done == true';
    case 'all_built':
      return allBuiltCondition(allEntities);
    case 'enemy_defeated':
      return 'enemiesDefeated >= ' + trigger.count;
    case 'timer':
      return 'phaseTimer >= ' + trigger.seconds + 'f';
    case 'compound':
      var op = trigger.operator === 'or' ? ' || ' : ' && ';
      var parts = (trigger.triggers || []).map(function(t) {
        return '(' + triggerToCondition(t, allEntities) + ')';
      });
      return parts.join(op);
    default:
      return 'true /* UNKNOWN TRIGGER: ' + trigger.type + ' */';
  }
}

function allBuiltCondition(entities) {
  var tracked = (entities || []).filter(function(e) { return e.terminalState === 2; });
  if (tracked.length === 0) return 'true';
  return tracked.map(function(e) {
    return toLowerCamel(e.name) + 'State >= 2';
  }).join(' && ');
}

module.exports = { triggerToCondition: triggerToCondition, toLowerCamel: toLowerCamel };
```

- [ ] **Step 3: Run inline test**

```bash
cd /opt/blueprint-editor && node -e "
var tc = require('./adapters/templates/trigger-codegen.cjs');
console.log(tc.triggerToCondition({type:'resource_collected',resource:'wood',amount:3}));
console.log(tc.triggerToCondition({type:'click_entity',entity:'ForgeWorkshop'}));
console.log(tc.triggerToCondition({type:'compound',operator:'and',triggers:[
  {type:'near_entity',entity:'Tree',range:2},
  {type:'resource_collected',resource:'wood',amount:5}
]}));
console.log(tc.triggerToCondition({type:'all_built'}, [{name:'House',terminalState:2},{name:'Barn',terminalState:2}]));
"
```

Expected output:
```
GetResource("wood") >= 3
forgeWorkshopDone == true
(IsNear(tree, 2f)) && (GetResource("wood") >= 5)
houseState >= 2 && barnState >= 2
```

- [ ] **Step 4: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/templates/trigger-codegen.cjs
git add adapters/templates/trigger-codegen.cjs
git commit -m "feat: add trigger-codegen template (trigger → C# condition)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Placement + Phase Init + Economy + Custom TODO Templates

**Files:**
- Create: `adapters/templates/placement.cjs`
- Create: `adapters/templates/phase-init.cjs`
- Create: `adapters/templates/economy.cjs`
- Create: `adapters/templates/custom-todo.cjs`

- [ ] **Step 1: Write placement.cjs**

Create `/opt/blueprint-editor/adapters/templates/placement.cjs`:

Generates C# code for `TODO_START` section — entity Find + initial positioning.

```javascript
/**
 * Generates entity initialization code for Start() method.
 * Input: schema.entities[], schema.gameConfig
 * Output: C# lines for TODO_START section
 */
var { toLowerCamel } = require('./trigger-codegen.cjs');

function generatePlacement(schema) {
  var lines = [];
  var entities = schema.entities || [];
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var varName = toLowerCamel(e.name);
    // Find pool object
    lines.push('        ' + varName + ' = GameObject.Find("' + e.pool + '");');
    // Initial position — hide off-screen if not shown at start
    if (e.showInPhase === 'start') {
      lines.push('        PlaceObj(' + varName + ', ' + e.initPos[0] + 'f, ' + e.initPos[1] + 'f, ' + e.initPos[2] + 'f);');
      if (e.scale && e.scale !== 1.0) {
        lines.push('        SetScale(' + varName + ', ' + e.scale + 'f);');
      }
    } else {
      lines.push('        HideObj(' + varName + ');');
    }
  }
  // NOTE: Camera background and ground color handled via in-place regex
  // replacement in replaceAllTodos() colorOverrides — NOT generated here.
  // This avoids duplicate assignments (skeleton already has hardcoded Color lines).
  return lines.join('\n');
}

/**
 * Returns color overrides for in-place regex replacement by replaceAllTodos().
 */
function getColorOverrides(schema) {
  var overrides = {};
  var bg = schema.gameConfig.cameraBackground;
  if (bg) {
    overrides.cameraBackground = 'new Color(' + bg[0] + 'f, ' + bg[1] + 'f, ' + bg[2] + 'f)';
  }
  var gc = schema.gameConfig.groundColor;
  if (gc) {
    overrides.groundColor = 'new Color(' + gc[0] + 'f, ' + gc[1] + 'f, ' + gc[2] + 'f)';
  }
  return overrides;
}

module.exports = { generatePlacement: generatePlacement, getColorOverrides: getColorOverrides };
```

- [ ] **Step 2: Write phase-init.cjs**

Create `/opt/blueprint-editor/adapters/templates/phase-init.cjs`:

Generates code for each `TODO_PHASE_N_INIT` section — show/hide entities, guide text, onEnter actions.

```javascript
var { toLowerCamel } = require('./trigger-codegen.cjs');

function generatePhaseInit(phase, schema) {
  var lines = [];
  // Show entities for this phase
  var show = phase.showEntities || [];
  for (var i = 0; i < show.length; i++) {
    var ent = findEntity(schema, show[i]);
    if (ent) {
      var v = toLowerCamel(ent.name);
      lines.push('                PlaceObj(' + v + ', ' + ent.initPos[0] + 'f, ' + ent.initPos[1] + 'f, ' + ent.initPos[2] + 'f);');
      if (ent.scale && ent.scale !== 1.0) {
        lines.push('                SetScale(' + v + ', ' + ent.scale + 'f);');
      }
    }
  }
  // Hide entities
  var hide = phase.hideEntities || [];
  for (var j = 0; j < hide.length; j++) {
    lines.push('                HideObj(' + toLowerCamel(hide[j]) + ');');
  }
  // Guide text
  if (phase.guideText) {
    lines.push('                guideText.text = "' + phase.guideText.replace(/"/g, '\\"') + '";');
  }
  // onEnter actions
  var actions = phase.onEnter || [];
  for (var k = 0; k < actions.length; k++) {
    lines.push('                ' + actionToCode(actions[k]));
  }
  return lines.join('\n');
}

function actionToCode(action) {
  switch (action.action) {
    case 'set_entity_state':
      return toLowerCamel(action.entity) + 'State = ' + action.state + ';';
    case 'add_resource':
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case 'switch_form':
      return 'SwitchForm(' + action.formIndex + ');';
    case 'show_floating_text':
      return 'ShowFloatingText(player.transform.position, "' + action.text + '", Color.' + (action.color || 'yellow') + ');';
    case 'set_guide':
      return 'guideText.text = "' + (action.text || '').replace(/"/g, '\\"') + '";';
    case 'spawn_enemies':
      return 'Spawn' + action.entity + '(' + action.count + ');';
    default:
      return '// TODO: Unknown action ' + action.action;
  }
}

function findEntity(schema, name) {
  return (schema.entities || []).filter(function(e) { return e.name === name; })[0] || null;
}

module.exports = { generatePhaseInit: generatePhaseInit, actionToCode: actionToCode };
```

- [ ] **Step 3: Write economy.cjs**

Create `/opt/blueprint-editor/adapters/templates/economy.cjs`:

Generates `_resources[]` initialization for TODO_START, and resource flow logic for TODO_UPDATE.

```javascript
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
```

- [ ] **Step 4: Write custom-todo.cjs**

Create `/opt/blueprint-editor/adapters/templates/custom-todo.cjs`:

```javascript
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
```

- [ ] **Step 5: Run inline tests for all 4 templates**

```bash
cd /opt/blueprint-editor && node -e "
var p = require('./adapters/templates/placement.cjs');
var schema = require('./fixtures/schema-codegen/valid-idle-game.json');
var code = p.generatePlacement(schema);
console.log('Placement lines:', code.split('\n').length);
console.log('Has PlaceObj:', code.indexOf('PlaceObj') >= 0);
console.log('Has Find:', code.indexOf('GameObject.Find') >= 0);

var pi = require('./adapters/templates/phase-init.cjs');
var phCode = pi.generatePhaseInit(schema.phases[0], schema);
console.log('PhaseInit lines:', phCode.split('\n').length);
console.log('Has guideText:', phCode.indexOf('guideText') >= 0);

var ec = require('./adapters/templates/economy.cjs');
var resCode = ec.generateResourceInit(schema);
console.log('Economy has ResourceDef:', resCode.indexOf('ResourceDef') >= 0);

var ct = require('./adapters/templates/custom-todo.cjs');
var todoCode = ct.generateCustomTodos({customLogic:['Test custom logic']});
console.log('Custom TODO:', todoCode.indexOf('TODO_CUSTOM_1') >= 0);
console.log('Empty custom:', ct.generateCustomTodos({customLogic:[]}) === '');
"
```

Expected: All checks print `true` or positive line counts.

- [ ] **Step 6: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/templates/placement.cjs adapters/templates/phase-init.cjs adapters/templates/economy.cjs adapters/templates/custom-todo.cjs
git add adapters/templates/placement.cjs adapters/templates/phase-init.cjs adapters/templates/economy.cjs adapters/templates/custom-todo.cjs
git commit -m "feat: add placement, phase-init, economy, custom-todo templates

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: AutoPlay Mirror Template

**Files:**
- Create: `adapters/templates/autoplay-mirror.cjs`

- [ ] **Step 1: Write autoplay-mirror.cjs**

Create `/opt/blueprint-editor/adapters/templates/autoplay-mirror.cjs`:

For each phase, generates the equivalent autoplay simulation code that mirrors the interactive trigger. This is the key to dual-mode consistency.

```javascript
/**
 * Auto-generates OnAutoPlayArrive() body from phases + triggers.
 * Each phase's interactive trigger gets an autoplay equivalent that
 * directly sets state/resources instead of requiring player input.
 */
var { toLowerCamel } = require('./trigger-codegen.cjs');

function generateAutoPlay(schema) {
  var lines = [];
  var phases = schema.phases || [];

  lines.push('        // Auto-play interaction simulation');
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema);
    if (!mirror) continue;
    // OnAutoPlayArrive context: simulate interaction for this phase
    lines.push('        if (currentPhaseName == "' + phase.phaseId + '") {');
    var mirrorLines = mirror.split('\n');
    for (var j = 0; j < mirrorLines.length; j++) {
      lines.push('            ' + mirrorLines[j]);
    }
    // Set interaction done flags
    lines.push('            ' + phase.phaseId + 'InteractionDone = true;');
    lines.push('            ' + phase.phaseId + 'PlayerActed = true;');
    // onComplete actions
    var actions = phase.onComplete || [];
    for (var k = 0; k < actions.length; k++) {
      lines.push('            ' + actionToMirror(actions[k]));
    }
    lines.push('        }');
  }
  return lines.join('\n');
}

function triggerToMirror(trigger, schema) {
  if (!trigger) return null;
  switch (trigger.type) {
    case 'resource_collected':
      return 'AddResource("' + trigger.resource + '", ' + trigger.amount + ');';
    case 'entity_state_reached':
      return toLowerCamel(trigger.entity) + 'State = ' + trigger.state + ';';
    case 'near_entity':
      return toLowerCamel(trigger.entity) + '.transform.position = player.transform.position;';
    case 'click_entity':
      return toLowerCamel(trigger.entity) + 'Done = true;\n' +
             toLowerCamel(trigger.entity) + 'State++;';
    case 'enemy_defeated':
      return 'enemiesDefeated = ' + trigger.count + ';\n' +
             'HideObj(' + toLowerCamel(trigger.entity || 'enemy') + ');';
    case 'all_built':
      var tracked = (schema.entities || []).filter(function(e) { return e.terminalState === 2; });
      return tracked.map(function(e) { return toLowerCamel(e.name) + 'State = 2;'; }).join('\n');
    case 'compound':
      var parts = (trigger.triggers || []).map(function(t) { return triggerToMirror(t, schema); }).filter(Boolean);
      return parts.join('\n');
    case 'timer':
      return null; // Skeleton safety net handles timeout
    default:
      return null;
  }
}

function actionToMirror(action) {
  switch (action.action) {
    case 'set_entity_state':
      return toLowerCamel(action.entity) + 'State = ' + action.state + ';';
    case 'add_resource':
      return 'AddResource("' + action.resource + '", ' + action.amount + ');';
    case 'switch_form':
      return 'SwitchForm(' + action.formIndex + ');';
    case 'spawn_enemies':
      return 'Spawn' + action.entity + '(' + action.count + ');';
    default:
      return '// autoplay: ' + action.action;
  }
}

module.exports = { generateAutoPlay: generateAutoPlay };
```

- [ ] **Step 2: Run test**

```bash
cd /opt/blueprint-editor && node -e "
var ap = require('./adapters/templates/autoplay-mirror.cjs');
var schema = require('./fixtures/schema-codegen/valid-idle-game.json');
var code = ap.generateAutoPlay(schema);
console.log('AutoPlay lines:', code.split('\n').length);
console.log('Has InteractionDone:', code.indexOf('InteractionDone') >= 0);
console.log('Has PlayerActed:', code.indexOf('PlayerActed') >= 0);
console.log(code);
"
```

Expected: Each phase gets a mirror block with InteractionDone + PlayerActed flags set.

- [ ] **Step 3: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/templates/autoplay-mirror.cjs
git add adapters/templates/autoplay-mirror.cjs
git commit -m "feat: add autoplay-mirror template (dual-mode consistency)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: NPC Behavior Templates (5 types)

**Files:**
- Create: `adapters/templates/npc-behaviors/patrol.cjs`
- Create: `adapters/templates/npc-behaviors/chase-attack.cjs`
- Create: `adapters/templates/npc-behaviors/static-target.cjs`
- Create: `adapters/templates/npc-behaviors/ranged-shooter.cjs`
- Create: `adapters/templates/npc-behaviors/spawner.cjs`

- [ ] **Step 1: Write all 5 NPC templates**

Each NPC template exports `{ generateVariables(npc), generateUpdate(npc), generateSystem(npc) }`:

- `generateVariables(npc)` → C# variable declarations (hp, timer, state)
- `generateUpdate(npc)` → One-liner call for Update() section: `Update{Entity}(dt);`
- `generateSystem(npc)` → Full method body for Systems section

**patrol.cjs** — Random walk within radius. Variables: `{entity}PatrolTarget`, `{entity}PatrolTimer`. No HP.

**chase-attack.cjs** — Idle→detect→chase→attack→death. Variables: `{entity}HP`, `{entity}State` (0=idle,1=chase,2=dead), `{entity}AttackTimer`. Uses `Vector3.Distance` for detection.

**static-target.cjs** — Player clicks/attacks to damage. Variables: `{entity}HP`. `{entity}Done` flag used as gate. Simplest template.

**ranged-shooter.cjs** — Detect→fire projectile. Uses `GFM_Pool.Get()` for projectiles. Variables: `{entity}HP`, `{entity}FireTimer`, `{entity}State`. Projectile moves in Update toward player.

**spawner.cjs** — Periodic spawn. Variables: `{entity}SpawnTimer`, `{entity}AliveCount`. Creates entities at random positions within `spawnRadius`.

Each file follows the same interface pattern. Example for chase-attack.cjs:

```javascript
var { toLowerCamel } = require('../trigger-codegen.cjs');

function generateVariables(npc) {
  var v = toLowerCamel(npc.entity);
  var lines = [];
  lines.push('    int ' + v + 'HP = ' + npc.params.hp + ';');
  lines.push('    int ' + v + 'State = 0; // 0=idle, 1=chase, 2=dead');
  lines.push('    float ' + v + 'AttackTimer = 0f;');
  return lines.join('\n');
}

function generateUpdate(npc) {
  var v = toLowerCamel(npc.entity);
  return '        Update' + npc.entity + '(Time.deltaTime);';
}

function generateSystem(npc) {
  var v = toLowerCamel(npc.entity);
  var p = npc.params;
  var lines = [];
  lines.push('    void Update' + npc.entity + '(float dt) {');
  lines.push('        if (' + v + 'State == 2) return;');
  lines.push('        if (' + v + ' == null) return;');
  lines.push('        float dist = Vector3.Distance(' + v + '.transform.position, player.transform.position);');
  lines.push('        if (dist < ' + p.detectRange + 'f) {');
  lines.push('            ' + v + 'State = 1;');
  lines.push('            Vector3 dir = (player.transform.position - ' + v + '.transform.position).normalized;');
  lines.push('            ' + v + '.transform.position += dir * ' + p.moveSpeed + 'f * dt;');
  lines.push('            if (dist < ' + p.attackRange + 'f) {');
  lines.push('                ' + v + 'AttackTimer -= dt;');
  lines.push('                if (' + v + 'AttackTimer <= 0f) {');
  lines.push('                    playerHP -= ' + p.attackDamage + ';');
  lines.push('                    ' + v + 'AttackTimer = ' + p.attackInterval + 'f;');
  lines.push('                }');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (' + v + 'HP <= 0) {');
  lines.push('            ' + v + 'State = 2;');
  lines.push('            HideObj(' + v + ');');
  lines.push('            enemiesDefeated++;');
  lines.push('        }');
  lines.push('    }');
  return lines.join('\n');
}

module.exports = { generateVariables: generateVariables, generateUpdate: generateUpdate, generateSystem: generateSystem };
```

Implement all 5 following this pattern.

- [ ] **Step 2: Run tests for each template**

```bash
cd /opt/blueprint-editor && node -e "
var ca = require('./adapters/templates/npc-behaviors/chase-attack.cjs');
var npc = {entity:'Guard',template:'chase_attack',params:{detectRange:5,attackRange:1.5,attackDamage:1,attackInterval:1.5,moveSpeed:2,hp:3}};
console.log('--- Variables ---');
console.log(ca.generateVariables(npc));
console.log('--- Update call ---');
console.log(ca.generateUpdate(npc));
console.log('--- System method ---');
console.log(ca.generateSystem(npc));
console.log('Has UpdateGuard:', ca.generateSystem(npc).indexOf('UpdateGuard') >= 0);
"
```

Repeat for all 5 templates with appropriate test data.

- [ ] **Step 3: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/templates/npc-behaviors/
git add adapters/templates/npc-behaviors/
git commit -m "feat: add 5 NPC behavior templates (patrol, chase, static, ranged, spawner)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: Template Engine (Main Orchestrator)

**Files:**
- Create: `adapters/codegen-template-engine.cjs`

- [ ] **Step 1: Write codegen-template-engine.cjs**

Create `/opt/blueprint-editor/adapters/codegen-template-engine.cjs`:

This is the main engine that takes a validated JSON schema + raw skeleton string, and fills all TODO markers by calling the individual templates.

```javascript
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
  return {
    code: result.code,
    todoCount: result.remainingTodos,
    templateCoverage: result.filledLines / result.totalLines,
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
    if (tmpl) lines.push(tmpl.generateVariables(npcs[i]));
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

  var keys = Object.keys(todoMap);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var startMarker = '// ' + key + '_START';
    var endMarker = '// ' + key + '_END';
    var startIdx = code.indexOf(startMarker);
    var endIdx = code.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      // Marker not found in skeleton — skip silently
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

  return { code: code, remainingTodos: remainingTodos, filledLines: filledLines, totalLines: totalLines };
}

module.exports = { fillSkeleton: fillSkeleton, replaceAllTodos: replaceAllTodos };
```

- [ ] **Step 2: Integration test with skeleton**

```bash
cd /opt/blueprint-editor && node -e "
var engine = require('./adapters/codegen-template-engine.cjs');
var skelGen = require('./adapters/skeleton-generator.cjs');
var schema = require('./fixtures/schema-codegen/valid-idle-game.json');
// Generate skeleton from schema phases (convert to spec format)
var specs = schema.phases.map(function(p,i) { return {phaseId:p.phaseId, requiredInteractions:[], entitiesRequired:[]}; });
var skeleton = skelGen.generateSkeleton(specs, {});
var skeletonStr = typeof skeleton === 'string' ? skeleton : skeleton.main;
var result = engine.fillSkeleton(schema, skeletonStr);
console.log('Code length:', result.code.length);
console.log('Code lines:', result.code.split('\n').length);
console.log('Remaining TODOs:', result.todoCount);
console.log('Template coverage:', result.templateCoverage.toFixed(2));
console.log('Has PlaceObj:', result.code.indexOf('PlaceObj') >= 0);
console.log('Has guideText:', result.code.indexOf('guideText') >= 0);
"
```

Expected: Code generated with reasonable line count, PlaceObj and guideText present.

- [ ] **Step 3: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/codegen-template-engine.cjs
git add adapters/codegen-template-engine.cjs
git commit -m "feat: add template engine orchestrator (schema → fill skeleton TODOs)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: Skeleton TODO_CUSTOM Markers

**Files:**
- Modify: `adapters/skeleton-generator.cjs` (~line 665)

- [ ] **Step 1: Read exact insertion point**

```bash
cd /opt/blueprint-editor && node -e "
var fs = require('fs');
var code = fs.readFileSync('adapters/skeleton-generator.cjs', 'utf8');
var lines = code.split('\n');
for (var i = 660; i < 670; i++) {
  console.log((i+1) + ': ' + lines[i]);
}
"
```

Confirm `TODO_UPDATE_END` is near line 665.

- [ ] **Step 2: Add TODO_CUSTOM markers after TODO_UPDATE_END**

In `adapters/skeleton-generator.cjs`, find the line:
```javascript
lines.push('        // TODO_UPDATE_END');
```

Add immediately after it:
```javascript
lines.push('        // TODO_CUSTOM_START');
lines.push('        // TODO_CUSTOM_END');
```

- [ ] **Step 3: Verify skeleton still generates valid output**

```bash
cd /opt/blueprint-editor && node -e "
var gen = require('./adapters/skeleton-generator.cjs');
var specs = [{phaseId:'p1',requiredInteractions:['click:cta'],entitiesRequired:[]}];
var result = gen.generateSkeleton(specs, {});
var code = typeof result === 'string' ? result : result.main;
console.log('Has TODO_CUSTOM_START:', code.indexOf('TODO_CUSTOM_START') >= 0);
console.log('Has TODO_CUSTOM_END:', code.indexOf('TODO_CUSTOM_END') >= 0);
console.log('Line count:', code.split('\n').length);
"
```

Expected: Both markers present, line count similar to before +2.

- [ ] **Step 4: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review adapters/skeleton-generator.cjs
git add adapters/skeleton-generator.cjs
git commit -m "feat: add TODO_CUSTOM markers to skeleton for custom logic injection

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: codegen-schema.cjs (Pipeline Stage)

**Files:**
- Create: `engine/stages/codegen-schema.cjs`

- [ ] **Step 1: Write codegen-schema.cjs**

Create `/opt/blueprint-editor/engine/stages/codegen-schema.cjs`:

This is the new codegen pipeline that orchestrates Step 1 (Sonnet → JSON) → Step 2 (template fill) → Step 3 (optional Claude Code).

```javascript
/**
 * Schema-driven codegen stage.
 * Step 1: Claude Sonnet → JSON game schema
 * Step 2: Template engine → fill skeleton TODOs (80%)
 * Step 3: Claude Code → fill customLogic TODOs (20%, optional)
 */

var fs = require('fs');
var path = require('path');
var { generateSkeleton } = require('../../adapters/skeleton-generator.cjs');
var { resolveEntities } = require('../../adapters/entity-resolver.cjs');
var templateEngine = require('../../adapters/codegen-template-engine.cjs');
var schemaValidator = require('../../adapters/schema/validate-schema.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,

  execute: function(ctx) {
    ctx.addLog('codegen-schema', 'Starting schema-driven codegen...');

    // Step 1: Generate JSON schema via Sonnet
    return generateSchemaFromSpecs(ctx)
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;
        ctx.addLog('codegen-schema', 'Schema generated: ' + schema.phases.length + ' phases, ' +
          schema.entities.length + ' entities, ' + (schema.npcs || []).length + ' NPCs');

        // Step 2: Template fill
        var startMs = Date.now();
        var resolved = resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities);
        var skeletonResult = generateSkeleton(ctx.blueprint.specs, {
          entityPoolMap: resolved.entityPoolMap,
        });
        var skeletonStr = typeof skeletonResult === 'string' ? skeletonResult : skeletonResult.main;

        var fillResult = templateEngine.fillSkeleton(schema, skeletonStr);
        ctx.csCode = fillResult.code;
        ctx.blueprint.templateCoverage = fillResult.templateCoverage;
        ctx.blueprint.todoSectionsRemaining = fillResult.todoCount;
        ctx.blueprint.templateFillMs = Date.now() - startMs;

        ctx.addLog('codegen-schema', 'Template fill done: coverage=' +
          fillResult.templateCoverage.toFixed(2) + ', remaining TODOs=' + fillResult.todoCount +
          ', took ' + ctx.blueprint.templateFillMs + 'ms');

        // Handle split mode
        if (typeof skeletonResult === 'object' && skeletonResult.systems) {
          ctx.extraFiles = ctx.extraFiles || {};
          ctx.extraFiles['GameFlowManagerMain.Systems.cs'] = skeletonResult.systems;
        }

        // Step 3: Custom logic fill (only if needed)
        if (schema.customLogic && schema.customLogic.length > 0) {
          ctx.addLog('codegen-schema', 'Custom logic detected (' + schema.customLogic.length +
            ' items), invoking Claude Code...');
          return fillCustomLogic(ctx, schema);
        }

        ctx.addLog('codegen-schema', 'No custom logic — skipping Claude Code entirely');
      });
  }
};

function generateSchemaFromSpecs(ctx) {
  var maxRetries = 2;
  var attempt = 0;

  function tryGenerate() {
    attempt++;
    ctx.addLog('codegen-schema', 'Schema generation attempt ' + attempt + '/' + (maxRetries + 1));

    // Build prompt for Sonnet
    var prompt = buildSchemaPrompt(ctx);

    // Call LLM (Sonnet via Claude Code CLI text mode)
    var runClaudeCodeText = require('../../worker/claude-code-coder.js').runClaudeCodeText;
    return runClaudeCodeText({
      prompt: prompt,
      model: 'sonnet',
      taskId: ctx.taskId,
      log: function(msg) { ctx.addLog('codegen-schema', msg); },
    }).then(function(response) {
      // Track token usage for metrics
      if (response.usage) {
        ctx.blueprint.schemaTokensIn = (ctx.blueprint.schemaTokensIn || 0) + (response.usage.input_tokens || 0);
        ctx.blueprint.schemaTokensOut = (ctx.blueprint.schemaTokensOut || 0) + (response.usage.output_tokens || 0);
      }

      // Extract JSON from response
      var text = response.text || response || '';
      var jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Schema generation returned no JSON object');
      }
      var schema;
      try { schema = JSON.parse(jsonMatch[0]); } catch(e) {
        throw new Error('Invalid JSON from schema generation: ' + e.message);
      }

      // Validate
      var structErrors = schemaValidator.validateGameSchema(schema);
      var semErrors = schemaValidator.validateSemantics(schema);
      var allErrors = structErrors.concat(semErrors);
      if (allErrors.length > 0) {
        throw new Error('Schema validation failed: ' + allErrors.join('; '));
      }

      return schema;
    }).catch(function(err) {
      if (attempt <= maxRetries) {
        ctx.addLog('codegen-schema', 'Retry (' + attempt + '): ' + err.message);
        return tryGenerate();
      }
      throw err;
    });
  }

  return tryGenerate();
}

function buildSchemaPrompt(ctx) {
  // Load prompt template if exists, otherwise build inline
  var specs = JSON.stringify(ctx.blueprint.specs, null, 2);
  var entities = JSON.stringify(ctx.blueprint.entities || [], null, 2);

  var lines = [];
  lines.push('你是试玩广告游戏配置生成器。根据分镜 specs 输出 JSON 配置。');
  lines.push('');
  lines.push('## NPC 行为模板');
  lines.push('- patrol: patrolRadius(float), moveSpeed(float)');
  lines.push('- chase_attack: detectRange, attackRange, attackDamage, attackInterval, moveSpeed, hp');
  lines.push('- static_target: hp, interactionVerb');
  lines.push('- ranged_shooter: detectRange, fireRange, projectileSpeed, damage, fireInterval, hp');
  lines.push('- spawner: spawnEntity, spawnInterval, maxAlive, spawnRadius');
  lines.push('');
  lines.push('## Trigger 类型');
  lines.push('- resource_collected: {resource, amount}');
  lines.push('- entity_state_reached: {entity, state}');
  lines.push('- near_entity: {entity, range}');
  lines.push('- click_entity: {entity}');
  lines.push('- all_built: {}');
  lines.push('- enemy_defeated: {count}');
  lines.push('- timer: {seconds} — 必须与其他 trigger 组合(compound)');
  lines.push('- compound: {triggers[], operator: "and"|"or"}');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. entities 中每个 name 必须在 specs 的 entitiesRequired 中存在');
  lines.push('2. phase 数量必须与 specs 数量一致');
  lines.push('3. 第一个 phase 的 showEntities >= 3 个');
  lines.push('4. 最后一个 phase 的 trigger 必须包含 click_entity');
  lines.push('5. customLogic 只写模板无法覆盖的逻辑，越少越好');
  lines.push('6. timer 不能单独做 trigger');
  lines.push('7. pool 格式: __Pool_{Shape}_{Color}_{NN}');
  lines.push('8. entities[].initPos: [x,y,z], x范围±6, z范围±4, y>0');
  lines.push('9. entities[].scale >= 0.3');
  lines.push('');
  lines.push('## 分镜 Specs');
  lines.push(specs);
  lines.push('');
  lines.push('## 实体列表');
  lines.push(entities);
  lines.push('');
  lines.push('只输出 JSON 对象，不要 markdown 包裹，不要解释。');
  return lines.join('\n');
}

function fillCustomLogic(ctx, schema) {
  var { createFixLoop } = require('../fix-loop.cjs');
  var { runClaudeCodeText } = require('../../worker/claude-code-coder.js');

  ctx.blueprint.customLogicRounds = 0;

  var loop = createFixLoop({
    name: 'codegen-custom',
    maxRounds: 3,
    attempt: function(loopCtx, round) {
      ctx.blueprint.customLogicRounds = round;
      var prompt = buildCustomLogicPrompt(ctx, schema);
      return runClaudeCodeText({
        prompt: prompt,
        model: 'sonnet',
        taskId: ctx.taskId,
        log: function(msg) { ctx.addLog('codegen-schema', '[custom R' + round + '] ' + msg); },
      }).then(function(response) {
        var text = response.text || response || '';
        // Extract code from response and apply to csCode
        var codeMatch = text.match(/```(?:csharp|cs)?\n([\s\S]*?)```/);
        if (codeMatch) {
          // Replace TODO_CUSTOM section in csCode
          var startM = '// TODO_CUSTOM_START';
          var endM = '// TODO_CUSTOM_END';
          var si = ctx.csCode.indexOf(startM);
          var ei = ctx.csCode.indexOf(endM);
          if (si !== -1 && ei !== -1) {
            ctx.csCode = ctx.csCode.substring(0, si + startM.length) + '\n' +
              codeMatch[1] + '\n        ' + ctx.csCode.substring(ei);
          }
        }

        // Track token usage
        ctx.blueprint.customLogicTokensIn = (response.usage && response.usage.input_tokens) || 0;

        return { done: true };
      });
    }
  });

  return loop.run(ctx);
}

function buildCustomLogicPrompt(ctx, schema) {
  var lines = [];
  lines.push('以下 C# 代码已由模板引擎生成 80%。你只需要实现 TODO_CUSTOM 标记的区域。');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. 只修改 TODO_CUSTOM_START 和 TODO_CUSTOM_END 之间的代码');
  lines.push('2. 不要修改 [SKELETON] 标记的代码');
  lines.push('3. 不要修改模板已生成的代码');
  lines.push('4. 可用 API: PlaceObj, HideObj, SetScale, AddResource, TrySpend, IsNear 等');
  lines.push('');
  lines.push('## 需要实现的自定义逻辑');
  for (var i = 0; i < schema.customLogic.length; i++) {
    lines.push((i + 1) + '. ' + schema.customLogic[i]);
  }
  return lines.join('\n');
}
```

- [ ] **Step 2: Verify module loads**

```bash
cd /opt/blueprint-editor && node -e "
var cs = require('./engine/stages/codegen-schema.cjs');
console.log('Name:', cs.name);
console.log('Has execute:', typeof cs.execute === 'function');
"
```

Expected: `Name: codegen`, `Has execute: true`.

- [ ] **Step 3: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review engine/stages/codegen-schema.cjs
git add engine/stages/codegen-schema.cjs
git commit -m "feat: add schema-driven codegen stage (Step 1→2→3 pipeline)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: Codegen Router + Legacy Rename

**Files:**
- Rename: `engine/stages/codegen.cjs` → `engine/stages/codegen-legacy.cjs`
- Modify: `engine/stages/codegen.cjs` (new router)

- [ ] **Step 1: Rename current codegen to legacy**

```bash
cd /opt/blueprint-editor && git mv engine/stages/codegen.cjs engine/stages/codegen-legacy.cjs
```

- [ ] **Step 2: Write new codegen.cjs router**

Overwrite `/opt/blueprint-editor/engine/stages/codegen.cjs`:

```javascript
/**
 * Codegen stage router — dispatches to schema or legacy codegen.
 * Default: schema mode. Set ctx.blueprint.useSchemaCodegen = false for legacy.
 */

var codegenSchema = require('./codegen-schema.cjs');
var codegenLegacy = require('./codegen-legacy.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,
  execute: function(ctx) {
    var useSchema = ctx.blueprint.useSchemaCodegen !== false;
    ctx.addLog('codegen', 'Mode: ' + (useSchema ? 'schema' : 'legacy'));
    if (useSchema) {
      return codegenSchema.execute(ctx);
    }
    return codegenLegacy.execute(ctx);
  }
};
```

- [ ] **Step 3: Verify pipeline loads**

```bash
cd /opt/blueprint-editor && node -e "
var p = require('./engine/pipeline.cjs');
var stages = p.createLunaPipeline({}).stages.map(function(s){return s.name});
console.log('Stages:', stages);
console.log('Has codegen:', stages.indexOf('codegen') >= 0);
"
```

Expected: Pipeline loads with codegen in correct position.

- [ ] **Step 4: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review engine/stages/codegen.cjs engine/stages/codegen-legacy.cjs
git add engine/stages/codegen.cjs engine/stages/codegen-legacy.cjs
git commit -m "feat: add codegen router (schema default, legacy fallback)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: Metrics Schema Fields

**Files:**
- Modify: `engine/metrics.cjs`

- [ ] **Step 1: Read current metrics record building**

```bash
cd /opt/blueprint-editor && node -e "
var fs = require('fs');
var code = fs.readFileSync('engine/metrics.cjs', 'utf8');
var lines = code.split('\n');
for (var i = 0; i < 80; i++) {
  if (lines[i] && (lines[i].indexOf('record') >= 0 || lines[i].indexOf('appendFile') >= 0)) {
    console.log((i+1) + ': ' + lines[i].trim().substring(0, 120));
  }
}
"
```

- [ ] **Step 2: Add schema-specific fields**

In `engine/metrics.cjs`, find the record building block — after the CUA details section (around line 59, after `record.cuaReason = ...` and its closing brace at line 60), and BEFORE the `try { fs.appendFileSync(...) }` block at line 61. Insert:

```javascript
// Schema-driven codegen metrics (8 fields per spec Section 6.1)
if (ctx && ctx.blueprint) {
  if (ctx.blueprint.gameSchema) {
    record.codegenMode = 'schema';
    record.schemaTokensIn = ctx.blueprint.schemaTokensIn || 0;
    record.schemaTokensOut = ctx.blueprint.schemaTokensOut || 0;
    record.templateFillMs = ctx.blueprint.templateFillMs || 0;
    record.templateCoverage = ctx.blueprint.templateCoverage || 0;
    record.todoSectionsRemaining = ctx.blueprint.todoSectionsRemaining || 0;
    record.customLogicUsed = !!(ctx.blueprint.gameSchema.customLogic && ctx.blueprint.gameSchema.customLogic.length > 0);
    record.customLogicTokensIn = ctx.blueprint.customLogicTokensIn || 0;
    record.customLogicRounds = ctx.blueprint.customLogicRounds || 0;
  } else {
    record.codegenMode = 'legacy';
  }
}
```

- [ ] **Step 3: Verify metrics still writes**

```bash
cd /opt/blueprint-editor && node -e "
var m = require('./engine/metrics.cjs');
console.log('Metrics module loaded:', typeof m);
"
```

- [ ] **Step 4: Codex review + commit**

```bash
cd /opt/blueprint-editor
codex --review engine/metrics.cjs
git add engine/metrics.cjs
git commit -m "feat: add schema codegen metrics fields to pipeline JSONL

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: End-to-End Integration Test

**Files:**
- Create: `fixtures/schema-codegen/e2e-idle-game.json`

- [ ] **Step 1: Create comprehensive E2E test fixture**

Create `/opt/blueprint-editor/fixtures/schema-codegen/e2e-idle-game.json`:

A complete schema with 5 phases, 6 entities, 2 resources, 1 form switch, 1 NPC (chase_attack), and 1 customLogic entry. This exercises all template paths simultaneously.

- [ ] **Step 2: Run E2E test: schema → template → code**

```bash
cd /opt/blueprint-editor && node -e "
var engine = require('./adapters/codegen-template-engine.cjs');
var skelGen = require('./adapters/skeleton-generator.cjs');
var schema = require('./fixtures/schema-codegen/e2e-idle-game.json');

// Build specs from schema phases
var specs = schema.phases.map(function(p) {
  return {
    phaseId: p.phaseId,
    requiredInteractions: [],
    entitiesRequired: (p.showEntities || []).map(function(n) { return {name:n,terminalState:2}; }),
  };
});

var skeleton = skelGen.generateSkeleton(specs, {});
var skeletonStr = typeof skeleton === 'string' ? skeleton : skeleton.main;
var result = engine.fillSkeleton(schema, skeletonStr);

console.log('=== E2E Test Results ===');
console.log('Code lines:', result.code.split('\n').length);
console.log('Template coverage:', result.templateCoverage.toFixed(2));
console.log('Remaining TODOs:', result.todoCount);
console.log('Has NPC method:', result.code.indexOf('UpdateGuard') >= 0);
console.log('Has economy:', result.code.indexOf('ResourceDef') >= 0 || result.code.indexOf('_resources') >= 0);
console.log('Has autoplay:', result.code.indexOf('InteractionDone') >= 0);
console.log('Has custom TODO:', result.code.indexOf('TODO_CUSTOM') >= 0);
console.log('Has PlaceObj:', result.code.indexOf('PlaceObj') >= 0);

// Write to tmp for manual inspection
var fs = require('fs');
fs.writeFileSync('/tmp/e2e-test-output.cs', result.code);
console.log('Full output written to /tmp/e2e-test-output.cs');
"
```

Expected: All checks true, coverage > 0.5.

- [ ] **Step 3: Verify output compiles (syntax check)**

```bash
cd /opt/blueprint-editor && node -e "
var fs = require('fs');
var code = fs.readFileSync('/tmp/e2e-test-output.cs', 'utf8');
// Basic syntax checks
var hasClass = code.indexOf('class GameFlowManagerMain') >= 0;
var hasStart = code.indexOf('void Start()') >= 0;
var hasUpdate = code.indexOf('void Update()') >= 0;
var hasCheckEvent = code.indexOf('void CheckEventRules()') >= 0;
var balanced = (code.match(/\{/g) || []).length === (code.match(/\}/g) || []).length;
console.log('Has class:', hasClass);
console.log('Has Start:', hasStart);
console.log('Has Update:', hasUpdate);
console.log('Has CheckEventRules:', hasCheckEvent);
console.log('Braces balanced:', balanced);
"
```

Expected: All true.

- [ ] **Step 4: Commit test fixture**

```bash
cd /opt/blueprint-editor
git add fixtures/schema-codegen/
git commit -m "test: add E2E integration test fixture for schema-driven codegen

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Deferred to Phase 2

The following spec features are intentionally excluded from this plan and will be implemented after the schema-driven codegen is validated in production:

- **Template Learning Pipeline** (spec Section 6.3): Auto-extraction of customLogic patterns from CUA-passed projects → new template candidates. Requires sufficient production data to identify recurring patterns.
- **Dashboard Comparison View** (spec Section 6.2): Side-by-side metrics comparison (schema vs legacy) in the existing dashboard. Depends on having enough schema-mode runs to produce meaningful comparisons.
