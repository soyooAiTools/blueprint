'use strict';

var moduleFixtures = [
  {
    name: 'spawn_interval / pass',
    module: 'spawn_interval',
    refs: { targetEntity: 'EnemyA' },
    observation: {
      phaseRealTimer: 1.2,
      phaseStartHints: { 'phaseEvidence.spawn_interval.spawnedEntities': 0 },
      phaseEvidence: {
        downstream_entity_visible: true,
        entity_state_changed: true,
        spawn_interval: {
          targetEntity: 'EnemyA',
          expectedCount: 1,
          spawnedEntities: [{ entityId: 'EnemyA', pos: { x: 0.75, y: 0.5, z: 0 }, t: 0.6 }],
          realtimeIntervalsSec: [],
        },
      },
      entity_states: { EnemyA: { position: { x: 0.75, y: 0.5, z: 0 }, state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'spawn_interval / fail flag_only_no_spawn',
    module: 'spawn_interval',
    refs: { targetEntity: 'EnemyA' },
    observation: {
      phaseRealTimer: 1.2,
      phaseStartHints: { 'phaseEvidence.spawn_interval.spawnedEntities': 0 },
      phaseEvidence: {
        downstream_entity_visible: true,
        entity_state_changed: true,
        spawn_interval: {
          targetEntity: 'EnemyA',
          expectedCount: 1,
          spawnedEntities: [],
          realtimeIntervalsSec: [],
        },
      },
      entity_states: {},
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'spawn_interval.flag_only_no_spawn',
    },
  },
  {
    name: 'damageable / pass',
    module: 'damageable',
    refs: { target: 'Rocket' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        target_hp_decreased_or_target_dead: true,
        damageable: {
          target: 'Rocket',
          before: { state: 0 },
          after: { state: 2 },
          deltaSourceModuleId: 'apply_damage',
        },
      },
      entity_states: { Rocket: { state: 2 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'damageable / fail silent_pass_state_drift',
    module: 'damageable',
    refs: { target: 'Rocket' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        target_hp_decreased_or_target_dead: true,
        damageable: {
          target: 'Rocket',
          before: { state: 1 },
          after: { state: 1 },
          deltaSourceModuleId: 'apply_damage',
        },
      },
      entity_states: { Rocket: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'damageable.flag_with_zero_state_delta',
    },
  },
  {
    name: 'upgrade_progress / pass',
    module: 'upgrade_progress',
    refs: { target: 'Tower' },
    observation: {
      phaseRealTimer: 1.5,
      phaseEvidence: {
        upgrade_level_changed: true,
        visual_variant_changed: true,
        entity_state_changed: true,
        upgrade_progress: {
          target: 'Tower',
          before: { state: 0, scale: { x: 1, y: 1, z: 1 }, visualHash: 0.10 },
          after: { state: 2, scale: { x: 1.08, y: 1.08, z: 1.08 }, visualHash: 0.30 },
          evidenceVotes: { stateAdvanced: true, scaleChanged: true, visualHashDelta: true },
        },
      },
      entity_states: { Tower: { state: 2 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'upgrade_progress / fail unmapped_entity_in_plan',
    module: 'upgrade_progress',
    refs: { target: 'Tower' },
    observation: {
      phaseRealTimer: 1.5,
      phaseEvidence: {
        upgrade_level_changed: true,
        visual_variant_changed: true,
        entity_state_changed: true,
        upgrade_progress: {
          target: 'Tower',
          before: { state: 0, scale: { x: 1, y: 1, z: 1 }, visualHash: 0.10 },
          after: { state: 2, scale: { x: 1.08, y: 1.08, z: 1.08 }, visualHash: 0.30 },
          evidenceVotes: { stateAdvanced: true, scaleChanged: true, visualHashDelta: true },
        },
      },
      entity_states: {},
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_atom_or_registry_mapping',
      ledgerSubtype: 'unmapped_entity_in_plan',
      attributionRuleId: 'upgrade_progress.target_not_in_entity_states',
    },
  },
  {
    name: 'spawn_once / pass',
    module: 'spawn_once',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        downstream_entity_visible: true,
        entity_state_changed: true,
        spawn_once: { target: 'EnemyA', position: { x: 1.2, y: 0.5, z: 0 }, placed: true },
      },
      entity_states: { EnemyA: { state: 0, position: { x: 1.2, y: 0.5, z: 0 } } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'spawn_once / fail flag_only_no_place',
    module: 'spawn_once',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        downstream_entity_visible: true,
        entity_state_changed: true,
        spawn_once: { target: 'EnemyA', position: null, placed: false },
      },
      entity_states: {},
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'spawn_once.flag_only_no_place',
    },
  },
  {
    name: 'cost_gate / pass',
    module: 'cost_gate',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        resource_decremented: true,
        cost_gate: {
          resource: 'coin',
          amount: 5,
          spent: true,
          before: { balance: 10 },
          after: { balance: 5 },
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'cost_gate / fail flag_with_zero_balance_delta',
    module: 'cost_gate',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        resource_decremented: true,
        cost_gate: {
          resource: 'coin',
          amount: 5,
          spent: true,
          before: { balance: 10 },
          after: { balance: 10 },
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'cost_gate.flag_with_zero_balance_delta',
    },
  },
  {
    name: 'build_progress / pass',
    module: 'build_progress',
    refs: { target: 'Kitchen' },
    observation: {
      phaseRealTimer: 1.2,
      phaseEvidence: {
        entity_state_equals_built: true,
        visual_variant_changed: true,
        entity_state_changed: true,
        build_progress: {
          target: 'Kitchen',
          before: { buildState: 0 },
          after: { buildState: 2 },
          buildTimer: 1.0,
        },
      },
      entity_states: { Kitchen: { state: 2 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'build_progress / fail flags_with_zero_state_delta',
    module: 'build_progress',
    refs: { target: 'Kitchen' },
    observation: {
      phaseRealTimer: 1.2,
      phaseEvidence: {
        entity_state_equals_built: true,
        visual_variant_changed: true,
        entity_state_changed: true,
        build_progress: {
          target: 'Kitchen',
          before: { buildState: 2 },
          after: { buildState: 2 },
          buildTimer: 1.0,
        },
      },
      entity_states: { Kitchen: { state: 2 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'build_progress.flags_with_zero_state_delta',
    },
  },
  {
    name: 'proximity_trigger / pass',
    module: 'proximity_trigger',
    refs: { target: 'NPC' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        distance_to_target_below_threshold: 0.3,
        proximity_trigger: {
          target: 'NPC',
          radius: 1.0,
          recordedDistance: 0.3,
        },
      },
      entity_states: { NPC: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'proximity_trigger / fail target_not_in_entity_states',
    module: 'proximity_trigger',
    refs: { target: 'NPC' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        distance_to_target_below_threshold: 0.3,
        proximity_trigger: {
          target: 'NPC',
          radius: 1.0,
          recordedDistance: 0.3,
        },
      },
      entity_states: {},
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_atom_or_registry_mapping',
      ledgerSubtype: 'unmapped_entity_in_plan',
      attributionRuleId: 'proximity_trigger.target_not_in_entity_states',
    },
  },
  {
    name: 'collect_on_near / pass',
    module: 'collect_on_near',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        resource_incremented: true,
        source_hidden_or_moved: true,
        collect_on_near: {
          resource: 'wood',
          count: 1,
          range: 1.0,
          before: { balance: 0 },
          after: { balance: 1 },
          sourceHidden: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'collect_on_near / fail source_not_hidden',
    module: 'collect_on_near',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        resource_incremented: true,
        source_hidden_or_moved: true,
        collect_on_near: {
          resource: 'wood',
          count: 1,
          range: 1.0,
          before: { balance: 0 },
          after: { balance: 1 },
          sourceHidden: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'collect_on_near.source_not_hidden',
    },
  },
  {
    name: 'deliver_to_target / pass',
    module: 'deliver_to_target',
    refs: { target: 'Customer' },
    observation: {
      phaseRealTimer: 0.6,
      phaseEvidence: {
        inventory_decremented: true,
        reward_incremented: true,
        deliver_to_target: {
          target: 'Customer',
          resource: 'meal',
          rewardResource: 'gold',
          before: { inventory: 1, reward: 0 },
          after: { inventory: 0, reward: 10 },
        },
      },
      entity_states: { Customer: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'deliver_to_target / fail inventory_decremented_no_reward',
    module: 'deliver_to_target',
    refs: { target: 'Customer' },
    observation: {
      phaseRealTimer: 0.6,
      phaseEvidence: {
        inventory_decremented: true,
        reward_incremented: true,
        deliver_to_target: {
          target: 'Customer',
          resource: 'meal',
          rewardResource: 'gold',
          before: { inventory: 1, reward: 0 },
          after: { inventory: 0, reward: 0 },
        },
      },
      entity_states: { Customer: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'deliver_to_target.inventory_decremented_no_reward',
    },
  },
  {
    name: 'inventory_wallet / pass (add inflow)',
    module: 'inventory_wallet',
    refs: { resource: 'gold' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        resource_incremented: true,
        score_text_changed: true,
        inventory_wallet: {
          resource: 'gold',
          operation: 'add',
          before: { balance: 0 },
          after: { balance: 5 },
          score_text_visible: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'inventory_wallet / fail flags_with_zero_state_delta',
    module: 'inventory_wallet',
    refs: { resource: 'gold' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        resource_incremented: true,
        inventory_wallet: {
          resource: 'gold',
          operation: 'add',
          before: { balance: 7 },
          after: { balance: 7 },
          score_text_visible: true,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'inventory_wallet.flags_with_zero_state_delta',
    },
  },
  {
    name: 'visual_binding / pass (show)',
    module: 'visual_binding',
    refs: { entity: 'CTAButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_visible: true,
        entity_position_changed: true,
        visual_binding: {
          entity: 'CTAButton',
          operation: 'show',
          before: { visible: false },
          after: { visible: true },
          position: { x: 0, y: 1.2, z: 0 },
          scale_applied: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'visual_binding / fail flag_with_no_visibility_change',
    module: 'visual_binding',
    refs: { entity: 'CTAButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_visible: true,
        visual_binding: {
          entity: 'CTAButton',
          operation: 'show',
          before: { visible: true },
          after: { visible: true },
          position: { x: 0, y: 1.2, z: 0 },
          scale_applied: true,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'visual_binding.flag_with_no_visibility_change',
    },
  },
  {
    name: 'on_death_drop / pass (loot dropped on death)',
    module: 'on_death_drop',
    refs: { source: 'EnemyA', loot: 'Gold' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        loot_visible: true,
        on_death_drop: {
          source: 'EnemyA',
          loot: 'Gold',
          position: { x: 1.0, y: 0.5, z: 0 },
          placed: true,
          source_dead: true,
        },
      },
      entity_states: { EnemyA: { state: 2 }, Gold: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'on_death_drop / fail placed_but_source_alive',
    module: 'on_death_drop',
    refs: { source: 'EnemyA', loot: 'Gold' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        loot_visible: true,
        on_death_drop: {
          source: 'EnemyA',
          loot: 'Gold',
          position: { x: 1.0, y: 0.5, z: 0 },
          placed: true,
          source_dead: false,
        },
      },
      entity_states: { EnemyA: { state: 1 }, Gold: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'on_death_drop.placed_but_source_alive',
    },
  },
  {
    name: 'apply_damage / pass (real damage request)',
    module: 'apply_damage',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        target_hp_decreased_or_target_dead: true,
        target_removed_or_hidden: true,
        apply_damage: {
          target: 'EnemyA',
          source: 'Hero',
          amount: 1,
          damageRequested: true,
          killed: true,
        },
      },
      entity_states: { EnemyA: { state: 2 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'apply_damage / fail flag_only_no_request',
    module: 'apply_damage',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        target_hp_decreased_or_target_dead: true,
        target_removed_or_hidden: true,
        apply_damage: {
          target: 'EnemyA',
          source: 'Hero',
          amount: 0,
          damageRequested: false,
          killed: false,
        },
      },
      entity_states: { EnemyA: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'apply_damage.flag_only_no_request',
    },
  },
  {
    name: 'drag_trigger / pass (source landed on target)',
    module: 'drag_trigger',
    refs: { source: 'Coin', target: 'Wallet' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        drag_path_completed: true,
        entity_position_changed: true,
        drag_trigger: {
          source: 'Coin',
          target: 'Wallet',
          from: { position: { x: 0, y: 0.5, z: 0 } },
          to: { position: { x: 2, y: 0.5, z: 0 } },
          completed: true,
          drop_radius: 0.8,
        },
      },
      entity_states: { Coin: { state: 1, position: { x: 2, y: 0.5, z: 0 } }, Wallet: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'drag_trigger / fail flag_with_no_completion',
    module: 'drag_trigger',
    refs: { source: 'Coin', target: 'Wallet' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        drag_path_completed: true,
        drag_trigger: {
          source: 'Coin',
          target: 'Wallet',
          from: { position: { x: 0, y: 0.5, z: 0 } },
          to: { position: { x: 0, y: 0.5, z: 0 } },
          completed: false,
          drop_radius: 0.8,
        },
      },
      entity_states: { Coin: { state: 0 }, Wallet: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'drag_trigger.flag_with_no_completion',
    },
  },
  {
    name: 'hold_trigger / pass (held long enough)',
    module: 'hold_trigger',
    refs: { target: 'ChargeButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        tap_registered: true,
        entity_state_changed: true,
        hold_trigger: {
          target: 'ChargeButton',
          duration_required: 0.4,
          duration_elapsed: 0.45,
          completed: true,
        },
      },
      entity_states: { ChargeButton: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'hold_trigger / fail tap_only_not_held',
    module: 'hold_trigger',
    refs: { target: 'ChargeButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        tap_registered: true,
        hold_trigger: {
          target: 'ChargeButton',
          duration_required: 0.4,
          duration_elapsed: 0.05,
          completed: false,
        },
      },
      entity_states: { ChargeButton: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'hold_trigger.tap_only_not_held',
    },
  },
  {
    name: 'floating_text_feedback / pass',
    module: 'floating_text_feedback',
    refs: { anchor: 'Player' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        floating_text_visible: true,
        floating_text_feedback: {
          anchor: 'Player',
          text: '+5',
          color: 'yellow',
          before: { visible: false },
          after: { visible: true },
          visual_changed: true,
        },
      },
      entity_states: { Player: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'floating_text_feedback / fail flag_with_no_visual_change',
    module: 'floating_text_feedback',
    refs: { anchor: 'Player' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        floating_text_visible: true,
        floating_text_feedback: {
          anchor: 'Player',
          text: '+5',
          color: 'yellow',
          before: { visible: true },
          after: { visible: true },
          visual_changed: false,
        },
      },
      entity_states: { Player: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'floating_text_feedback.flag_with_no_visual_change',
    },
  },
  {
    name: 'world_label / pass',
    module: 'world_label',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        guide_text_visible: true,
        world_label: {
          target: 'EnemyA',
          text: 'enemy',
          anchor_entity_present: true,
          before: { visible: false },
          after: { visible: true },
          visual_changed: true,
        },
      },
      entity_states: { EnemyA: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'world_label / fail flag_with_no_anchor',
    module: 'world_label',
    refs: { target: 'EnemyA' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        guide_text_visible: true,
        world_label: {
          target: 'EnemyA',
          text: 'enemy',
          anchor_entity_present: false,
          before: { visible: false },
          after: { visible: true },
          visual_changed: true,
        },
      },
      entity_states: {},
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'world_label.flag_with_no_anchor',
    },
  },
  {
    name: 'pop_animation / pass',
    module: 'pop_animation',
    refs: { target: 'Coin' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        visual_variant_changed: true,
        pop_animation: {
          target: 'Coin',
          intensity: 0.15,
          duration: 0.3,
          scale_delta: 0.12,
          visual_changed: true,
        },
      },
      entity_states: { Coin: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'pop_animation / fail flag_with_no_scale_delta',
    module: 'pop_animation',
    refs: { target: 'Coin' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        visual_variant_changed: true,
        pop_animation: {
          target: 'Coin',
          intensity: 0.15,
          duration: 0.3,
          scale_delta: 0,
          visual_changed: false,
        },
      },
      entity_states: { Coin: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'pop_animation.flag_with_no_scale_delta',
    },
  },
  {
    name: 'highlight_target / pass',
    module: 'highlight_target',
    refs: { target: 'TutorialButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        visual_variant_changed: true,
        guide_text_visible: true,
        highlight_target: {
          target: 'TutorialButton',
          style: 'pulse',
          overlay_active: true,
          scale_delta: 0.10,
          visual_changed: true,
        },
      },
      entity_states: { TutorialButton: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'highlight_target / fail flag_with_no_overlay',
    module: 'highlight_target',
    refs: { target: 'TutorialButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        visual_variant_changed: true,
        guide_text_visible: true,
        highlight_target: {
          target: 'TutorialButton',
          style: 'pulse',
          overlay_active: false,
          scale_delta: 0,
          visual_changed: false,
        },
      },
      entity_states: { TutorialButton: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'highlight_target.flag_with_no_overlay',
    },
  },
  {
    name: 'guide_ui / pass',
    module: 'guide_ui',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        guide_text_visible: true,
        guide_ui: {
          text: 'Tap to start',
          before: { text: '' },
          after: { text: 'Tap to start' },
          text_changed: true,
          visible: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'guide_ui / fail flag_with_no_text_change',
    module: 'guide_ui',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        guide_text_visible: true,
        guide_ui: {
          text: 'Tap to start',
          before: { text: 'Tap to start' },
          after: { text: 'Tap to start' },
          text_changed: false,
          visible: true,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_state_drift',
      attributionRuleId: 'guide_ui.flag_with_no_text_change',
    },
  },
  {
    name: 'camera_focus / pass',
    module: 'camera_focus',
    refs: { target: 'BossArena' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        camera_orientation_changed: true,
        camera_focus: {
          target: 'BossArena',
          before: { framing: { look_at: { x: 0, y: 0, z: 0 } } },
          after: { framing: { look_at: { x: 5, y: 0, z: 3 } } },
          position_delta: 5.83,
          framing_changed: true,
        },
      },
      entity_states: { BossArena: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'camera_focus / fail flag_with_no_framing_change',
    module: 'camera_focus',
    refs: { target: 'BossArena' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        camera_orientation_changed: true,
        camera_focus: {
          target: 'BossArena',
          before: { framing: { look_at: { x: 0, y: 0, z: 0 } } },
          after: { framing: { look_at: { x: 0, y: 0, z: 0 } } },
          position_delta: 0,
          framing_changed: false,
        },
      },
      entity_states: { BossArena: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'camera_focus.flag_with_no_framing_change',
    },
  },
  {
    name: 'camera_lift / pass',
    module: 'camera_lift',
    refs: {},
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        camera_height_changed_or_view_widened: true,
        camera_lift: {
          amount: 2.0,
          duration: 0.4,
          before: { height: 4.0 },
          after: { height: 6.0 },
          height_delta: 2.0,
          lift_applied: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'camera_lift / fail flag_with_zero_height_delta',
    module: 'camera_lift',
    refs: {},
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        camera_height_changed_or_view_widened: true,
        camera_lift: {
          amount: 2.0,
          duration: 0.4,
          before: { height: 4.0 },
          after: { height: 4.0 },
          height_delta: 0,
          lift_applied: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'camera_lift.flag_with_zero_height_delta',
    },
  },
  {
    name: 'camera_zoom / pass',
    module: 'camera_zoom',
    refs: {},
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        camera_zoom_changed: true,
        camera_zoom: {
          value: 1.5,
          duration: 0.4,
          before: { ortho_size: 5.0 },
          after: { ortho_size: 3.5 },
          zoom_delta: -1.5,
          zoom_applied: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'camera_zoom / fail flag_with_zero_zoom_delta',
    module: 'camera_zoom',
    refs: {},
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        camera_zoom_changed: true,
        camera_zoom: {
          value: 1.5,
          duration: 0.4,
          before: { ortho_size: 5.0 },
          after: { ortho_size: 5.0 },
          zoom_delta: 0,
          zoom_applied: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'camera_zoom.flag_with_zero_zoom_delta',
    },
  },
  {
    name: 'phase_gate_timer / pass (timer drives phase boundary)',
    module: 'phase_gate_timer',
    refs: {},
    observation: {
      phaseRealTimer: 3.1,
      phaseEvidence: {
        entity_state_changed: true,
        phase_gate_timer: {
          seconds_required: 3.0,
          seconds_elapsed: 3.1,
          before: { phase_index: 1 },
          after: { phase_index: 2 },
          timer_completed: true,
          phase_advanced_by_timer: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'phase_gate_timer / fail phase_advance_without_timer',
    module: 'phase_gate_timer',
    refs: {},
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_state_changed: true,
        phase_gate_timer: {
          seconds_required: 3.0,
          seconds_elapsed: 0.5,
          before: { phase_index: 1 },
          after: { phase_index: 2 },
          timer_completed: false,
          phase_advanced_by_timer: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'phase_gate_timer.phase_advance_without_timer',
    },
  },
  {
    name: 'activate_targets / pass (downstream visibility transition)',
    module: 'activate_targets',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        downstream_entity_visible: true,
        activate_targets: {
          targets: ['EnemyA', 'EnemyB'],
          before: { visible: false },
          after: { visible: true },
          placed: true,
          visibility_changed: true,
        },
      },
      entity_states: { EnemyA: { state: 0 }, EnemyB: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'activate_targets / fail flag_with_no_visibility_change',
    module: 'activate_targets',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        downstream_entity_visible: true,
        activate_targets: {
          targets: ['EnemyA'],
          before: { visible: true },
          after: { visible: true },
          placed: true,
          visibility_changed: false,
        },
      },
      entity_states: { EnemyA: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'activate_targets.flag_with_no_visibility_change',
    },
  },
  {
    name: 'score_feedback / pass (score delta and text both change)',
    module: 'score_feedback',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        score_text_changed: true,
        score_feedback: {
          resource: 'coin',
          label: 'Coins:',
          before: { score: 10 },
          after: { score: 15 },
          delta: 5,
          text_changed: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'score_feedback / fail flag_with_no_score_delta',
    module: 'score_feedback',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        score_text_changed: true,
        score_feedback: {
          resource: 'coin',
          label: 'Coins:',
          before: { score: 10 },
          after: { score: 10 },
          delta: 0,
          text_changed: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'score_feedback.flag_with_no_score_delta',
    },
  },
  {
    name: 'visual_variant_swap / pass (variantId transitions)',
    module: 'visual_variant_swap',
    refs: { entity: 'PlayerSkin' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        visual_variant_changed: true,
        visual_variant_swap: {
          entity: 'PlayerSkin',
          before: { variantId: 'red' },
          after: { variantId: 'blue' },
          variant_changed: true,
        },
      },
      entity_states: { PlayerSkin: { state: 0 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'visual_variant_swap / fail flag_with_no_variant_change',
    module: 'visual_variant_swap',
    refs: { entity: 'PlayerSkin' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        visual_variant_changed: true,
        visual_variant_swap: {
          entity: 'PlayerSkin',
          before: { variantId: 'red' },
          after: { variantId: 'red' },
          variant_changed: false,
        },
      },
      entity_states: { PlayerSkin: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'visual_variant_swap.flag_with_no_variant_change',
    },
  },
  {
    name: 'form_switch / pass (formId transitions)',
    module: 'form_switch',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        entity_state_changed: true,
        visual_variant_changed: true,
        form_switch: {
          formId: 'fox',
          before: { formId: 'human' },
          after: { formId: 'fox' },
          form_changed: true,
        },
      },
      entity_states: { Player: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'form_switch / fail flag_with_no_form_change',
    module: 'form_switch',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        entity_state_changed: true,
        visual_variant_changed: true,
        form_switch: {
          formId: 'fox',
          before: { formId: 'fox' },
          after: { formId: 'fox' },
          form_changed: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'form_switch.flag_with_no_form_change',
    },
  },
  {
    name: 'click_trigger / pass (target consumed)',
    module: 'click_trigger',
    refs: { target: 'UpgradeButton' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        tap_registered: true,
        click_trigger: {
          target: 'UpgradeButton',
          before: { clicked: false },
          after: { clicked: true },
          target_consumed: true,
        },
      },
      entity_states: { UpgradeButton: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'click_trigger / fail flag_with_no_target_consumed',
    module: 'click_trigger',
    refs: { target: 'UpgradeButton' },
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        tap_registered: true,
        click_trigger: {
          target: 'UpgradeButton',
          before: { clicked: false },
          after: { clicked: false },
          target_consumed: false,
        },
      },
      entity_states: { UpgradeButton: { state: 0 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'click_trigger.flag_with_no_target_consumed',
    },
  },
  {
    name: 'player_input_tap / pass (raw input registered)',
    module: 'player_input_tap',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        tap_registered: true,
        player_input_tap: {
          raycastLayer: 'Default',
          tap_count: 1,
          registered: true,
          tap_position: { x: 1.5, y: 0, z: 2.0 },
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'player_input_tap / fail flag_with_no_tap_event',
    module: 'player_input_tap',
    refs: {},
    observation: {
      phaseRealTimer: 0.3,
      phaseEvidence: {
        tap_registered: true,
        player_input_tap: {
          raycastLayer: 'Default',
          tap_count: 0,
          registered: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'player_input_tap.flag_with_no_tap_event',
    },
  },
  {
    name: 'move_to_target / pass (distance + arrival)',
    module: 'move_to_target',
    refs: { actor: 'Enemy', target: 'Base' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_position_changed: true,
        distance_to_target_below_threshold: true,
        move_to_target: {
          target: 'Base',
          before: { position: { x: 5.0, y: 0, z: 0 } },
          after: { position: { x: 1.4, y: 0, z: 0 } },
          distance_traveled: 3.6,
          arrived: true,
        },
      },
      entity_states: { Enemy: { position: { x: 1.4 } } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'move_to_target / fail flag_with_no_distance_traveled',
    module: 'move_to_target',
    refs: { actor: 'Enemy', target: 'Base' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_position_changed: true,
        move_to_target: {
          target: 'Base',
          before: { position: { x: 5.0, y: 0, z: 0 } },
          after: { position: { x: 5.0, y: 0, z: 0 } },
          distance_traveled: 0,
          arrived: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'move_to_target.flag_with_no_distance_traveled',
    },
  },
  {
    name: 'player_input_joystick / pass (axis registered)',
    module: 'player_input_joystick',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        player_position_changed: true,
        player_input_joystick: {
          axis: { x: 0.8, y: 0, z: 0.6 },
          magnitude: 1.0,
          registered: true,
          before: { position: { x: 0, y: 0, z: 0 } },
          after: { position: { x: 1.0, y: 0, z: 0.6 } },
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'player_input_joystick / fail flag_with_no_axis_input',
    module: 'player_input_joystick',
    refs: {},
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        player_position_changed: true,
        player_input_joystick: {
          axis: { x: 0, y: 0, z: 0 },
          magnitude: 0,
          registered: false,
          before: { position: { x: 0, y: 0, z: 0 } },
          after: { position: { x: 1.0, y: 0, z: 0 } },
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'player_input_joystick.flag_with_no_axis_input',
    },
  },
  {
    name: 'target_acquire / pass (candidate selected in range)',
    module: 'target_acquire',
    refs: { actor: 'Tower' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_state_changed: true,
        target_acquire: {
          candidate_targets: ['Enemy1', 'Enemy2'],
          selected_target: 'Enemy1',
          in_range: true,
          target_acquired: true,
        },
      },
      entity_states: { Tower: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'target_acquire / fail flag_with_no_target_selected',
    module: 'target_acquire',
    refs: { actor: 'Tower' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_state_changed: true,
        target_acquire: {
          candidate_targets: [],
          selected_target: null,
          in_range: false,
          target_acquired: false,
        },
      },
      entity_states: { Tower: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'target_acquire.flag_with_no_target_selected',
    },
  },
  {
    name: 'projectile_emit / pass (projectile spawned with velocity)',
    module: 'projectile_emit',
    refs: { actor: 'Tower', target: 'Enemy' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        projectile_visible: true,
        projectile_emit: {
          projectile: 'ArrowProjectile',
          source: 'Tower',
          direction: { x: 1, y: 0, z: 0 },
          velocity: 8.0,
          spawned: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'projectile_emit / fail flag_with_no_projectile_spawned',
    module: 'projectile_emit',
    refs: { actor: 'Tower', target: 'Enemy' },
    observation: {
      phaseRealTimer: 0.4,
      phaseEvidence: {
        projectile_visible: true,
        projectile_emit: {
          projectile: 'ArrowProjectile',
          source: 'Tower',
          direction: { x: 1, y: 0, z: 0 },
          velocity: 8.0,
          spawned: false,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'projectile_emit.flag_with_no_projectile_spawned',
    },
  },
  {
    name: 'cooldown / pass (timer ready transition)',
    module: 'cooldown',
    refs: { actor: 'Tower' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_state_changed: true,
        cooldown: {
          seconds: 2.0,
          before: { timer: 0.3 },
          after: { timer: 0 },
          timer_elapsed: 0.3,
          just_ready: true,
        },
      },
      entity_states: { Tower: { state: 1 } },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'cooldown / fail flag_with_no_timer_progress',
    module: 'cooldown',
    refs: { actor: 'Tower' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        entity_state_changed: true,
        cooldown: {
          seconds: 2.0,
          before: { timer: 1.0 },
          after: { timer: 1.0 },
          timer_elapsed: 0,
          just_ready: false,
        },
      },
      entity_states: { Tower: { state: 1 } },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'cooldown.flag_with_no_timer_progress',
    },
  },
  {
    name: 'cta_finish / pass (CTA shown on final phase)',
    module: 'cta_finish',
    refs: { target: 'CTAButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        downstream_entity_visible: true,
        cta_finish: {
          target: 'CTAButton',
          cta_visible: true,
          install_called_or_ready: true,
          final_phase: true,
        },
      },
    },
    expectedPass: true,
    expectedAttribution: null,
  },
  {
    name: 'cta_finish / fail flag_with_no_cta_shown',
    module: 'cta_finish',
    refs: { target: 'CTAButton' },
    observation: {
      phaseRealTimer: 0.5,
      phaseEvidence: {
        downstream_entity_visible: true,
        cta_finish: {
          target: 'CTAButton',
          cta_visible: false,
          install_called_or_ready: false,
          final_phase: true,
        },
      },
    },
    expectedPass: false,
    expectedAttribution: {
      ledgerGapType: 'missing_semantic_assertion',
      ledgerSubtype: 'silent_pass_flag_only',
      attributionRuleId: 'cta_finish.flag_with_no_cta_shown',
    },
  },
];

var subtypeFixtures = [
  {
    name: 'silent_pass_visual_only_no_signal / fires',
    subtype: 'silent_pass_visual_only_no_signal',
    refs: {},
    observation: {
      phaseRealTimer: 2.5,
      phaseEvidence: {},
      camera_state: { before: { visualHash: 0.10 }, after: { visualHash: 0.25 } },
    },
    expectedFires: true,
  },
  {
    name: 'unmapped_atom_in_spec / fires',
    subtype: 'unmapped_atom_in_spec',
    refs: { atomId: 'rotate_view' },
    observation: {
      spec: {
        requiredInteractions: {
          rotate_view: { description: 'player rotates camera', priority: 1 },
          fire_projectile: { description: 'tap to shoot', priority: 0 },
        },
      },
      plan: {
        modules: {
          spawn_interval: { sourceAtomIds: { fire_projectile: true } },
          damageable: { sourceAtomIds: { apply_damage: true } },
        },
      },
    },
    expectedFires: true,
  },
  {
    name: 'unmapped_phase_outcome / fires',
    subtype: 'unmapped_phase_outcome',
    refs: { stepId: 'step_5' },
    observation: {
      cuaPlan: { steps: { step_5: { expectedOutcome: 'defeated_boss' } } },
      spec: { requiredInteractions: { fire_projectile: { description: 'tap to shoot' } } },
      plan: { modules: { spawn_interval: { sourceAtomIds: { fire_projectile: true } } } },
    },
    expectedFires: true,
  },
  {
    name: 'silent_pass_visual_only_no_signal / no fire (flag present)',
    subtype: 'silent_pass_visual_only_no_signal',
    refs: {},
    observation: {
      phaseRealTimer: 2.5,
      phaseEvidence: { upgrade_level_changed: true },
      camera_state: { before: { visualHash: 0.10 }, after: { visualHash: 0.25 } },
    },
    expectedFires: false,
  },
  {
    name: 'unmapped_atom_in_spec / no fire (atom mapped)',
    subtype: 'unmapped_atom_in_spec',
    refs: { atomId: 'rotate_view' },
    observation: {
      spec: { requiredInteractions: { rotate_view: { description: 'player rotates camera', priority: 1 } } },
      plan: {
        modules: {
          camera_rotate: { sourceAtomIds: { rotate_view: true } },
          spawn_interval: { sourceAtomIds: { fire_projectile: true } },
        },
      },
    },
    expectedFires: false,
  },
  {
    name: 'unmapped_phase_outcome / no fire (outcome explained)',
    subtype: 'unmapped_phase_outcome',
    refs: { stepId: 'step_5' },
    observation: {
      cuaPlan: { steps: { step_5: { expectedOutcome: 'defeated_boss' } } },
      spec: { requiredInteractions: { fire_projectile: { description: 'tap to shoot', producesOutcome: 'defeated_boss' } } },
      plan: { modules: { spawn_interval: { sourceAtomIds: { fire_projectile: true } } } },
    },
    expectedFires: false,
  },
];

module.exports = {
  moduleFixtures: moduleFixtures,
  subtypeFixtures: subtypeFixtures,
};
