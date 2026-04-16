# Schema-Driven Codegen Design

> **Status:** Approved  
> **Date:** 2026-04-16  
> **Depends on:** complexity-control (completed)  
> **Goal:** Replace monolithic AI C# generation (1500 lines) with JSON schema + template engine, reducing codegen complexity and improving CUA pass rate.

---

## 1. Problem

Current codegen asks Claude Code to generate ~1500 lines of C# in a single 30-50KB prompt. Despite skeleton pre-generation, the AI must simultaneously handle:

- 160 pool object mappings
- N-phase state machine with interaction gates
- Dual-mode code (interactive + autoplay)
- Luna 13 WebGL restrictions
- Anti-solid-color numeric constraints
- NPC behavior state machines
- Resource economy logic

Result: codegen passes (90%) but downstream CUA only passes 11%. Code is syntactically valid but semantically broken.

## 2. Solution Overview

Split codegen into 3 steps:

```
Step 1: Claude Sonnet → JSON schema (~100 lines, ~30s)
Step 2: Template engine → 80% complete C# (pure computation, <1s)  
Step 3: Claude Code → fill remaining TODO (~20%, ~3min, only if customLogic exists)
```

### Key Insight

80%+ of generated code is data-driven (object placement, phase transitions, resource amounts, NPC parameters). Only ~20% requires free-form logic. By having AI output structured data instead of code, the template engine guarantees Luna compliance, correct skeleton structure, and dual-mode consistency.

## 3. JSON Schema Definition

### 3.1 Top-Level Structure

```json
{
  "gameConfig": { ... },
  "entities": [ ... ],
  "resources": [ ... ],
  "forms": [ ... ],
  "phases": [ ... ],
  "npcs": [ ... ],
  "customLogic": [ ... ]
}
```

### 3.2 gameConfig

```json
{
  "cameraBackground": [0.53, 0.81, 0.92],
  "groundColor": [0.75, 0.78, 0.82],
  "moveSpeed": 3.5,
  "collectRange": 1.5,
  "maxCarry": 5
}
```

- `cameraBackground`: RGB float array [0-1]. Must differ from groundColor by ≥ 0.3 in any channel.
- `groundColor`: RGB float array. Default neutral gray [0.75, 0.78, 0.82].
- `moveSpeed`, `collectRange`, `maxCarry`: Gameplay tuning values injected into skeleton kit.

### 3.3 entities

```json
[
  {
    "name": "Tree",
    "pool": "__Pool_Cylinder_Green_01",
    "initPos": [-3, 0.5, 0],
    "scale": 1.2,
    "showInPhase": "phase_1",
    "terminalState": 2
  }
]
```

- `name`: Must match spec entity name exactly.
- `pool`: Must be a valid `__Pool_{Shape}_{Color}_{NN}` identifier.
- `initPos`: [x, y, z]. Objects outside ±6, ±4 range will be off-screen.
- `scale`: Minimum 0.3 enforced by template.
- `showInPhase`: Phase where entity first becomes visible. `"start"` = visible from game init.
- `terminalState`: 0 = no state tracking, 1 = binary (active/done), 2 = three-state (waiting/building/built).

### 3.4 resources

```json
[
  { "id": "wood", "display": "木材", "convertFrom": null, "convertRatio": 0 },
  { "id": "gold", "display": "金币", "convertFrom": "wood", "convertRatio": 3 }
]
```

- Empty array `[]` if no economy system.
- `convertFrom`: upstream resource ID, or `null` if primary (collected directly).
- `convertRatio`: how many upstream units = 1 of this resource.
- Feeds directly into skeleton's Economy Kit `_resources[]` array.

### 3.5 forms

```json
[
  {
    "formId": "player",
    "pool": "__Pool_Capsule_Blue_01",
    "moveSpeed": 3.5,
    "collectRange": 1.5,
    "collectPower": 1,
    "carryCapacity": 5,
    "scale": 1.0
  }
]
```

- Empty array `[]` if no form switching.
- First form = default player form.
- Feeds into skeleton's Form-Switch Kit `_forms[]` array.

### 3.6 phases

```json
[
  {
    "phaseId": "phase_1",
    "guideText": "拖动人物去砍树",
    "showEntities": ["Tree", "Sawmill"],
    "hideEntities": [],
    "trigger": {
      "type": "resource_collected",
      "resource": "wood",
      "amount": 3
    },
    "onEnter": [],
    "onComplete": [
      { "action": "set_entity_state", "entity": "Tree", "state": 1 }
    ]
  }
]
```

#### Trigger Types (Enumerated)

| Type | Params | Condition Generated |
|------|--------|---------------------|
| `resource_collected` | `resource`, `amount` | `GetResource("wood") >= 3` |
| `entity_state_reached` | `entity`, `state` | `treeState >= 2` |
| `near_entity` | `entity`, `range` | `IsNear(tree, 2f)` |
| `click_entity` | `entity` | `{entity}Done == true` (sets interaction flag) |
| `all_built` | — | All entities with terminalState=2 have state==2 |
| `enemy_defeated` | `count` | `enemiesDefeated >= count` |
| `timer` | `seconds` | `phaseTimer >= seconds` (MUST combine with another trigger via `compound`) |
| `compound` | `triggers[]`, `operator` | AND/OR of sub-triggers |

#### onEnter / onComplete Actions

| Action | Params | Code Generated |
|--------|--------|----------------|
| `set_entity_state` | `entity`, `state` | `{entity}State = {state};` |
| `add_resource` | `resource`, `amount` | `AddResource("{resource}", {amount});` |
| `switch_form` | `formIndex` | `SwitchForm({formIndex});` |
| `show_floating_text` | `text`, `color` | `ShowFloatingText(player.transform.position, "{text}", Color.{color});` |
| `set_guide` | `text` | `guideText.text = "{text}";` |
| `spawn_enemies` | `entity`, `count` | Triggers spawner NPC template |

### 3.7 npcs

```json
[
  {
    "entity": "Guard",
    "template": "chase_attack",
    "params": {
      "patrolRadius": 3,
      "detectRange": 5,
      "attackRange": 1.5,
      "attackDamage": 1,
      "attackInterval": 1.5,
      "moveSpeed": 2,
      "hp": 3
    }
  }
]
```

#### NPC Templates (5 types)

| Template | Params | Behavior |
|----------|--------|----------|
| `patrol` | `patrolRadius`, `moveSpeed` | Move between random points within radius. No combat. |
| `chase_attack` | `detectRange`, `attackRange`, `attackDamage`, `attackInterval`, `moveSpeed`, `hp` | Idle → detect player → chase → attack in range → die at hp=0 |
| `static_target` | `hp`, `interactionVerb` | Stationary. Player clicks/attacks to advance state. |
| `ranged_shooter` | `detectRange`, `fireRange`, `projectileSpeed`, `damage`, `fireInterval`, `hp` | Detect → fire projectile → player dodges. Uses GFM_Pool for projectiles. |
| `spawner` | `spawnEntity`, `spawnInterval`, `maxAlive`, `spawnRadius` | Periodically spawns entities up to maxAlive count. |

### 3.8 customLogic

```json
[
  "当玩家建造完 Forge 后，所有 Tree 变成金色（移到黄色 pool 对象位置）",
  "Boss 出现时屏幕震动效果（Camera 抖动 0.5 秒）"
]
```

- Natural language descriptions of logic that templates cannot cover.
- Each entry becomes a `// TODO_CUSTOM: ...` comment in generated code.
- If array is empty, Step 3 (Claude Code) is skipped entirely.

## 4. Template Engine Architecture

### 4.1 File Structure

```
adapters/
  codegen-template-engine.cjs       # Main engine: schema → code snippets → inject into skeleton
  templates/
    placement.cjs                   # Entity PlaceObj/HideObj/SetScale calls
    phase-init.cjs                  # Per-phase show/hide/guide/onEnter/onComplete
    trigger-codegen.cjs             # Trigger type → C# condition expression
    npc-behaviors/
      patrol.cjs
      chase-attack.cjs
      static-target.cjs
      ranged-shooter.cjs
      spawner.cjs
    economy.cjs                     # _resources[] initialization + flow calls
    autoplay-mirror.cjs             # Auto-generate OnAutoPlayArrive from phases + triggers
    custom-todo.cjs                 # customLogic[] → TODO comment blocks
  schema/
    game-schema.json                # JSON Schema for validation
```

### 4.2 Engine Interface

```javascript
// adapters/codegen-template-engine.cjs

/**
 * @param {object} schema - Validated JSON schema from Step 1
 * @param {string} skeleton - Raw skeleton code from skeleton-generator.cjs
 * @returns {{ code: string, todoCount: number, templateCoverage: number }}
 */
function fillSkeleton(schema, skeleton) {
  var errors = validateSchema(schema);
  if (errors.length > 0) throw new Error('Schema validation: ' + errors.join('; '));

  var todoMap = {};
  todoMap['TODO_VARIABLES'] = generateVariables(schema);
  todoMap['TODO_START'] = generateStart(schema);
  
  for (var i = 0; i < schema.phases.length; i++) {
    var phase = schema.phases[i];
    todoMap['TODO_PHASE_' + (i + 1) + '_INIT'] = generatePhaseInit(phase, schema);
  }
  
  todoMap['TODO_UPDATE'] = generateUpdate(schema);
  todoMap['TODO_AUTOPLAY_INTERACT'] = generateAutoPlay(schema);
  todoMap['TODO_SYSTEMS'] = generateSystems(schema);
  todoMap['TODO_UI'] = generateUI(schema);

  var result = replaceAllTodos(skeleton, todoMap);
  return {
    code: result.code,
    todoCount: result.remainingTodos,
    templateCoverage: result.filledLines / result.totalLines,
  };
}
```

### 4.3 Template Rules

1. **Templates only write inside TODO markers** — never modify [SKELETON] code.
2. **Templates use only skeleton-provided APIs** — PlaceObj, HideObj, SetScale, AddResource, TrySpend, SwitchForm, IsNear, etc.
3. **Templates enforce Luna restrictions** — no SetColor, no SetActive, no Destroy, no generics.
4. **Templates auto-generate AutoPlay mirror** — every interactive trigger gets an equivalent autoplay simulation in OnAutoPlayArrive.
5. **NPC templates generate both the method body AND the Update() call** — Update section gets `Update{Entity}(dt);`, Systems section gets the full method.

### 4.4 Trigger → C# Codegen

```javascript
// templates/trigger-codegen.cjs

function triggerToCondition(trigger) {
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
      return allBuiltCondition(entities);
    case 'enemy_defeated':
      return 'enemiesDefeated >= ' + trigger.count;
    case 'timer':
      return 'phaseTimer >= ' + trigger.seconds + 'f';
    case 'compound':
      var op = trigger.operator === 'or' ? ' || ' : ' && ';
      return trigger.triggers.map(triggerToCondition).join(op);
  }
}
```

This replaces the skeleton's placeholder conditions with real, schema-derived expressions.

### 4.5 AutoPlay Mirror Generation

For each phase trigger, autoplay-mirror.cjs generates the equivalent simulation:

| Trigger Type | Interactive Mode | AutoPlay Mirror |
|---|---|---|
| `resource_collected` | Player walks + TryCollect | `AddResource(id, amount)` directly |
| `near_entity` | Player walks to target | Set entity position = player position |
| `click_entity` | Player clicks entity | `{entity}Done = true; {entity}State++` |
| `enemy_defeated` | Player fights enemies | `enemiesDefeated = count; HideObj(enemy)` |

This ensures dual-mode consistency without AI having to manually write both paths.

## 5. Pipeline Integration

### 5.1 codegen Stage Refactor

```javascript
// engine/stages/codegen.cjs (modified)

var codegenSchema = require('./codegen-schema.cjs');
var codegenLegacy = require('./codegen-legacy.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,
  execute: function(ctx) {
    var useSchema = ctx.blueprint.useSchemaCodegen !== false;
    if (useSchema) {
      return codegenSchema.execute(ctx);
    }
    return codegenLegacy.execute(ctx);
  }
};
```

- Default: schema mode enabled.
- Per-project override: `useSchemaCodegen: false` falls back to legacy.
- Legacy path = current codegen.cjs renamed to codegen-legacy.cjs (zero changes).

### 5.2 codegen-schema.cjs Internal Flow

```javascript
// engine/stages/codegen-schema.cjs

module.exports = {
  execute: function(ctx) {
    // Step 1: Schema Generation (Sonnet)
    return generateSchema(ctx)           // retry 2x on JSON validation failure
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;

        // Step 2: Template Fill
        var skeleton = generateSkeleton(ctx.blueprint.specs, ctx.blueprint);
        var result = templateEngine.fillSkeleton(schema, skeleton);
        ctx.csCode = result.code;
        ctx.blueprint.templateCoverage = result.templateCoverage;
        ctx.blueprint.todoSectionsRemaining = result.todoCount;

        // Step 3: Custom Logic (only if needed)
        if (schema.customLogic && schema.customLogic.length > 0) {
          return fillCustomLogic(ctx);   // Claude Code, fix-loop max 3 rounds
        }
        // No custom logic → done, skip Claude Code entirely
      });
  }
};
```

### 5.3 Step 1 Prompt (Sonnet)

```markdown
你是试玩广告游戏配置生成器。根据分镜 specs 输出 JSON 配置。

## JSON Schema
{game-schema.json 内容}

## 可用 Pool 对象
{完整 __Pool_* 列表，按 Shape/Color 分组}

## NPC 行为模板
- patrol: patrolRadius(float), moveSpeed(float)
- chase_attack: detectRange, attackRange, attackDamage, attackInterval, moveSpeed, hp
- static_target: hp, interactionVerb
- ranged_shooter: detectRange, fireRange, projectileSpeed, damage, fireInterval, hp
- spawner: spawnEntity, spawnInterval, maxAlive, spawnRadius

## Trigger 类型
- resource_collected: {resource: string, amount: int}
- entity_state_reached: {entity: string, state: int}
- near_entity: {entity: string, range: float}
- click_entity: {entity: string}
- all_built: {}
- enemy_defeated: {count: int}
- timer: {seconds: float} — 必须与其他 trigger 组合使用
- compound: {triggers: [], operator: "and"|"or"}

## 规则
1. entities 中每个 name 必须在 specs.entitiesRequired 中存在
2. phase 数量必须与 specs 数量一致
3. 第一个 phase 必须 showEntities ≥ 3 个（防黑屏）
4. 最后一个 phase 的 trigger 必须包含 click_entity（CTA 按钮）
5. customLogic 只写模板无法覆盖的特殊需求，越少越好
6. 禁止 timer 单独作为 trigger（必须 compound 组合）

## 分镜 Specs
{JSON}

## 实体列表  
{JSON}

只输出 JSON。
```

Estimated: **5-8K tokens input, ~800-1500 tokens output.**

### 5.4 Step 3 Prompt (Claude Code, only when customLogic exists)

```markdown
以下 C# 代码已由模板引擎生成 80%。你只需要实现标记为 TODO_CUSTOM 的区域。

## 规则
1. 只修改 TODO_CUSTOM_START 和 TODO_CUSTOM_END 之间的代码
2. 不要修改 [SKELETON] 标记的代码
3. 不要修改模板已生成的代码
4. 可以在 TODO_VARIABLES 区域添加需要的变量

## 需要实现的自定义逻辑
{customLogic[] 列表}

## 当前代码 Outline
{buildCodeOutline(code)}

## 相关代码块
{extractRelevantBlocks(code, customLogic)}
```

Estimated: **5-8K tokens input**, much smaller than legacy 30-50K.

## 6. Metrics & Dashboard

### 6.1 New Metrics Fields

Added to each `pipeline-metrics.jsonl` entry:

```json
{
  "codegenMode": "schema",
  "schemaTokensIn": 6200,
  "schemaTokensOut": 850,
  "templateFillMs": 45,
  "customLogicUsed": true,
  "customLogicTokensIn": 5100,
  "customLogicRounds": 1,
  "todoSectionsRemaining": 2,
  "templateCoverage": 0.83
}
```

### 6.2 Dashboard Comparison View

Schema vs Legacy side-by-side on Dashboard "Pipeline 指标" tab:

| Metric | Schema | Legacy | Delta |
|---|---|---|---|
| codegen 耗时 | sum(step1+2+3) | single call | |
| token 消耗 | schema + custom | full prompt | |
| CUA 通过率 | % | % | |
| templateCoverage | 0.0-1.0 | N/A | |

### 6.3 Template Learning Pipeline

```
CUA-passed project (schema mode)
  → extract customLogic entries
  → Jaccard similarity > 0.6 with existing entries → group
  → group count ≥ 3 projects → pending-templates.json candidate
  → human review → new templates/*.cjs
```

Reuses lesson-extractor.cjs Jaccard deduplication logic.

## 7. Progressive Evolution Strategy

### Phase 1 (Week 1-2): Hybrid Launch

- Schema path default ON.
- customLogic handles all template gaps.
- Collect templateCoverage data.
- Target: CUA pass rate ≥ legacy mode.

### Phase 2 (Week 3-4): Data-Driven Template Expansion

- Analyze customLogic high-frequency patterns.
- Convert top patterns to new templates.
- Target: templateCoverage 0.80 → 0.90.

### Phase 3 (Week 5+): Approach Full Schema

- When >70% of projects have empty customLogic.
- Step 3 becomes optional (default skip).
- Legacy path downgraded to emergency fallback.

## 8. What Does NOT Change

- `skeleton-generator.cjs` — still generates skeleton with TODO markers as before.
- `method-check.cjs` — still validates method completeness.
- `static-check.cjs` — still scans for forbidden API usage.
- `complexity-gate.cjs` — still scores and gates complexity.
- `review` / `compile` / `visual-check` / `cua-verify` / `upload` — all downstream stages untouched.
- `prompt-v5-basetemplate.js` — preserved for legacy path, not used by schema path.

## 9. File Inventory

| File | Action | Lines (est.) |
|------|--------|------|
| `engine/stages/codegen-schema.cjs` | CREATE | 200 |
| `engine/stages/codegen-legacy.cjs` | RENAME from current codegen.cjs | 303 (no change) |
| `engine/stages/codegen.cjs` | MODIFY (router) | 20 |
| `adapters/codegen-template-engine.cjs` | CREATE | 250 |
| `adapters/templates/placement.cjs` | CREATE | 60 |
| `adapters/templates/phase-init.cjs` | CREATE | 80 |
| `adapters/templates/trigger-codegen.cjs` | CREATE | 100 |
| `adapters/templates/economy.cjs` | CREATE | 70 |
| `adapters/templates/autoplay-mirror.cjs` | CREATE | 120 |
| `adapters/templates/custom-todo.cjs` | CREATE | 30 |
| `adapters/templates/npc-behaviors/patrol.cjs` | CREATE | 50 |
| `adapters/templates/npc-behaviors/chase-attack.cjs` | CREATE | 80 |
| `adapters/templates/npc-behaviors/static-target.cjs` | CREATE | 40 |
| `adapters/templates/npc-behaviors/ranged-shooter.cjs` | CREATE | 90 |
| `adapters/templates/npc-behaviors/spawner.cjs` | CREATE | 60 |
| `adapters/schema/game-schema.json` | CREATE | 200 |
| `engine/metrics.cjs` | MODIFY (add schema fields) | +30 |
| **Total new code** | | **~1,460** |
