# Generic SLG Action / Capability Modules v1

## Scope

This note defines a v1 registry direction for **generic SLG playable verbs/capabilities**.
Module IDs must stay **content-agnostic**:

- Good: `collect_from_source`, `recruit_unit`, `occupy_target`
- Bad: `collect_gold`, `deliver_milk`, `build_barracks_gold`

Content belongs in params:

- `resourceKind`
- `unitArchetype`
- `sourceEntity`
- `targetEntity`
- `areaId`
- `rewardResource`

## Current repo snapshot

### Already in registry

Current runtime registry already covers the first assembly layer:

- movement / input: `player_input_joystick`, `player_input_tap`, `move_to_target`, `proximity_trigger`, `click_trigger`, `drag_trigger`, `hold_trigger`
- economy / build: `cost_gate`, `inventory_wallet`, `build_progress`, `upgrade_progress`, `collect_on_near`, `deliver_to_target`
- combat / spawn: `spawn_once`, `spawn_interval`, `target_acquire`, `projectile_emit`, `cooldown`, `damageable`, `apply_damage`, `on_death_drop`
- orchestration / presentation: `activate_targets`, `phase_gate_timer`, `guide_ui`, `floating_text_feedback`, `score_feedback`, `camera_*`, `highlight_target`, `visual_variant_swap`

Relevant files:

- [runtime-modules.v1.json](/opt/blueprint-editor/adapters/schema/assembly-registry-v1/runtime-modules.v1.json)
- [storyboard-atoms.v1.json](/opt/blueprint-editor/adapters/schema/assembly-registry-v1/storyboard-atoms.v1.json)
- [atom-module-mapping.v1.json](/opt/blueprint-editor/adapters/schema/assembly-registry-v1/atom-module-mapping.v1.json)

### Existing gap

The parser and registry still miss several generic SLG verbs that are already present in the storyboard verb vocabulary:

- `recruit`
- `deploy`
- `merge`
- `assign`
- `expand`
- `rally`
- `scout`
- `trade`

Those verbs already exist in [interaction-verbs.json](/opt/blueprint-editor/worker/interaction-verbs.json), but are not wired into [assembly-plan-pipeline.cjs](/opt/blueprint-editor/adapters/assembly-plan-pipeline.cjs).

### Residual content coupling to remove

- [deliver-sell.cjs](/opt/blueprint-editor/adapters/templates/interactions/deliver-sell.cjs) still assumes `gold` / `coins`
- [cost-gated-click.cjs](/opt/blueprint-editor/adapters/templates/interactions/cost-gated-click.cjs) still assumes `gold`
- `deliver_to_target` currently mixes **transport**, **consume**, and **reward payout** into one module
- `collect_on_near` still partially conflates **world item entity** and **abstract resource kind**

## Naming rules

Use one flat runtime namespace with these rules:

- `verb_object` for active capabilities: `recruit_unit`, `occupy_target`
- `noun_system` only for durable state owners/support systems: `inventory_wallet`, `damageable`
- interaction mode goes in params, not module id:
  - use `inputMode`, `collectMode`, `movementMode`
  - do not create `collect_drag`, `collect_tap`, `collect_joystick`
- content never appears in module id:
  - use `resourceKind=gold`
  - do not use `collect_gold`

## Parameter model rules

Prefer these shared param shapes:

- actor / source / target:
  - `actorEntity`
  - `sourceEntity`
  - `targetEntity`
- abstract payload:
  - `resourceKind`
  - `unitArchetype`
  - `areaId`
  - `itemKind`
- quantitative:
  - `amount`
  - `count`
  - `duration`
  - `radius`
  - `speed`
  - `capacity`
- economy:
  - `cost`: array of `{ resourceKind, amount }`
  - `reward`: array of `{ resourceKind, amount }`
- unlock / result:
  - `unlockTargets`
  - `resultState`
  - `resultLevel`

## Recommended module changes

- Keep `collect_on_near` as a backward-compatible alias, but make canonical name `collect_from_source`
- Split `deliver_to_target` into:
  - `deposit_to_target`
  - `convert_resource`
- Keep `move_to_target`, `build_progress`, `upgrade_progress`, `target_acquire`, `apply_damage`
- Treat `spawn_once` / `spawn_interval` as low-level support modules, not top-level player verbs

## Why these missing verbs matter

External SLG/4X loop references are consistent:

- Clash-style mid-core loop is repeatedly described as **resource collection + building/training + battling**
  - Source: GameDeveloper, *Mid-Core Success Part 1: Core Loops*
  - https://www.gamedeveloper.com/design/mid-core-success-part-1-core-loops
- 4X/SLG success drivers include **management + exploration**, and common feature sets include **building, training troops, attacking PvE/PvP enemies, gathering resources**
  - Source: GameRefinery, *What drives success in 4X Strategy/SLG games? Part 1*
  - https://www.gamerefinery.com/what-drives-success-in-4x-strategy-slg-games-part-1/
- Top War specifically highlights **territory expansion**, **world-map gather/steal**, and **merge-based unit training/upgrading**
  - Source: GameRefinery, *Top War: Battle Game - a Quick Glimpse on the 4X Strategy Hit*
  - https://www.gamerefinery.com/top-war-battle-game-a-quick-glimpse-on-the-4x-strategy-hit/

These directly justify adding `recruit_unit`, `deploy_unit`, `merge_units`, `expand_territory`, `occupy_target`, `scout_area`, and `convert_resource`.

## Flat registry candidate list

Sorted by priority. `Status` means current assembly registry status.

| Priority | moduleId | Status | Purpose | Suggested params |
| --- | --- | --- | --- | --- |
| P0 | `move_to_target` | existing | Move actor/group to target | `actorEntity`, `targetEntity`, `speed`, `stopRange`, `movementMode` |
| P0 | `click_trigger` | existing | Tap-to-act trigger | `targetEntity`, `inputMode` |
| P0 | `proximity_trigger` | existing | Near-range trigger | `actorEntity`, `targetEntity`, `radius` |
| P0 | `cost_gate` | existing | Spend prerequisite resources | `cost[]`, `targetEntity` |
| P0 | `inventory_wallet` | existing | Own abstract resources/inventory | `resourceKinds`, `capacityByKind` |
| P0 | `collect_from_source` | missing, alias from `collect_on_near` | Collect from world source generically | `actorEntity`, `sourceEntity`, `resourceKind`, `amount`, `collectMode`, `range` |
| P0 | `deposit_to_target` | missing | Deposit carried resource into building / sink | `actorEntity`, `targetEntity`, `resourceKind`, `amountPolicy` |
| P0 | `convert_resource` | missing | Convert one resource/input into another output/reward | `targetEntity`, `input[]`, `output[]`, `duration` |
| P0 | `build_progress` | existing | Build locked/inactive entity into active entity | `targetEntity`, `buildTime`, `unlockTargets` |
| P0 | `upgrade_progress` | existing | Raise entity level / variant / capacity | `targetEntity`, `levels`, `cost[]`, `resultLevel` |
| P0 | `recruit_unit` | missing | Spend resources/time to produce controllable units/workers | `targetEntity`, `unitArchetype`, `count`, `cost[]`, `duration`, `spawnTarget` |
| P0 | `deploy_unit` | missing | Place/march a recruited unit to a target slot/area | `unitEntity`, `fromEntity`, `targetEntity`, `deployMode`, `dropRadius` |
| P0 | `assign_worker` | missing | Bind worker to job/building/resource node | `workerEntity`, `taskType`, `targetEntity`, `capacity`, `duration` |
| P0 | `target_acquire` | existing | Find valid attack/work target | `actorEntity`, `targetFilter`, `range`, `priority` |
| P0 | `apply_damage` | existing | Apply damage to target | `actorEntity`, `targetEntity`, `amount`, `damageType` |
| P1 | `damageable` | existing | Own HP/death state | `targetEntity`, `hp`, `maxHp`, `deathBehavior` |
| P1 | `occupy_target` | missing | Hold/capture a point/building/node over time | `actorEntity`, `targetEntity`, `occupyTime`, `radius`, `resultState`, `unlockTargets` |
| P1 | `expand_territory` | missing | Reveal/unlock a new base/world area | `areaId`, `unlockTargets`, `prerequisites`, `cameraPreset` |
| P1 | `scout_area` | missing | Reveal fog/points of interest/resources/enemies | `actorEntity`, `areaId`, `duration`, `revealTargets` |
| P1 | `merge_units` | missing | Merge same-type units into upgraded output | `sourceUnits`, `resultUnitArchetype`, `consumeCount`, `resultLevel` |
| P1 | `phase_gate_timer` | existing | Time-gate a wave/holdout/observe segment | `seconds` |
| P1 | `spawn_interval` | existing | Periodic enemy/unit/source spawning | `entityArchetype`, `interval`, `maxAlive`, `spawnTarget` |
| P1 | `rally_point` | missing | Gather units at a point before dispatch/attack | `targetEntity`, `waitSeconds`, `participantFilter`, `capacity` |
| P1 | `trade_convert` | missing | Exchange resource A for B at a market/converter | `targetEntity`, `input[]`, `output[]`, `rate` |
| P1 | `produce_over_time` | missing | Passive or assigned production over time | `targetEntity`, `resourceKind`, `rate`, `cap`, `requiresAssignment` |
| P1 | `projectile_emit` | existing | Emit projectiles or shots | `actorEntity`, `projectile`, `speed`, `damage`, `cooldown` |
| P2 | `repair_target` | missing | Restore damaged structure/object | `actorEntity`, `targetEntity`, `amount`, `cost[]`, `duration` |
| P2 | `heal_target` | missing | Restore HP/state of ally/unit | `actorEntity`, `targetEntity`, `amount`, `duration` |
| P2 | `pickup_reward` | missing | Claim chest/drop/task reward | `targetEntity`, `reward[]` |
| P2 | `guide_ui` | existing | Step guidance | `text`, `targetEntity` |
| P2 | `highlight_target` | existing | Target emphasis | `targetEntity`, `style` |
| P2 | `camera_focus` | existing | Focus camera on verb target | `targetEntity`, `duration` |
| P2 | `camera_lift` | existing | Pull camera up/back | `amount`, `duration` |
| P2 | `camera_zoom` | existing | Zoom camera for reveal/expansion | `value`, `duration` |

## Immediate implementation recommendation

The next registry pass should not try to add everything at once. The best v1 slice is:

1. Canonicalize `collect_from_source`
2. Split `deliver_to_target` into `deposit_to_target` + `convert_resource`
3. Add `recruit_unit`
4. Add `deploy_unit`
5. Add `assign_worker`
6. Add `occupy_target`
7. Add `expand_territory`
8. Add `scout_area`
9. Add `merge_units`
10. Add `trade_convert`

And wire these three places together in the same change:

- `interaction-verbs.json`
- `storyboard-atoms.v1.json` / `atom-module-mapping.v1.json`
- `assembly-plan-pipeline.cjs`

If those are not added together, the system will continue to have the current mismatch:

- verb exists in language layer
- atom does not exist
- module does not exist
- CUA cannot assert it
