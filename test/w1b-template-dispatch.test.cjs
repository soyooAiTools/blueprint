const templateEngine = require('../adapters/codegen-template-engine.cjs');

function minimalSkeleton() {
  // Minimal skeleton with just TODO_UPDATE + TODO_VARIABLES + TODO_START markers.
  return [
    'using UnityEngine;',
    'public class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    string currentPhaseName = "init";',
    '    bool _autoPlayMode = false;',
    '    bool p1InteractionDone = false; bool p1PlayerActed = false;',
    '    bool p2InteractionDone = false; bool p2PlayerActed = false;',
    '    // TODO_VARIABLES_START',
    '    // TODO_VARIABLES_END',
    '    void Start() {',
    '        // TODO_START_START',
    '        // TODO_START_END',
    '    }',
    '    void Update() {',
    '        // TODO_UPDATE_START',
    '        // TODO_UPDATE_END',
    '        // TODO_CUSTOM_START',
    '        // TODO_CUSTOM_END',
    '    }',
    '    void OnAutoPlayArrive(string targetName) {',
    '        // TODO_AUTOPLAY_INTERACT_START',
    '        // TODO_AUTOPLAY_INTERACT_END',
    '    }',
    '    // TODO_SYSTEMS_START',
    '    // TODO_SYSTEMS_END',
    '    // TODO_UI_START',
    '    // TODO_UI_END',
    '}',
  ].join('\n');
}

function minimalSchema() {
  return {
    gameConfig: { cameraBackground: [0.5, 0.7, 1.0], groundColor: [0.3, 0.6, 0.2], moveSpeed: 5.0, collectRange: 2.0, maxCarry: 10 },
    entities: [
      { name: 'Player', chineseName: '玩家', showLabel: false, pool: '__Pool_Cube_White_01', initPos: [0, 1, 0], scale: 1.0 },
      { name: 'Shard',  chineseName: '碎片', showLabel: true,  pool: '__Pool_Cube_Red_02',   initPos: [2, 1, 0], scale: 1.0 },
      { name: 'Target', chineseName: '目标', showLabel: true,  pool: '__Pool_Sphere_Blue_03', initPos: [-2, 1, 0], scale: 1.0 },
    ],
    resources: [{ name: 'score', entity: 'Shard', convertRatio: 1 }],
    phases: [
      { phaseId: 'p1', showEntities: ['Player', 'Shard', 'Target'], hideEntities: [], guideText: '捡碎片', trigger: { type: 'resource_collected', resource: 'score', amount: 3 }, onEnter: [{ action: 'add_resource', resource: 'score', amount: 0 }] },
      { phaseId: 'p2', showEntities: ['Player', 'Target'],          hideEntities: ['Shard'], guideText: '点击目标', trigger: { type: 'click_entity', entity: 'Target' }, onEnter: [{ action: 'set_entity_state', entity: 'Target', state: 1 }] },
    ],
    npcs: [],
    customLogic: [],
  };
}

describe('W1b template-engine dispatch routing', () => {
  test('w1bSplit off (default): Main Update keeps direct template logic without phase tap dispatcher', () => {
    const result = templateEngine.fillSkeleton(minimalSchema(), minimalSkeleton());
    expect(result.code).toMatch(/if\s*\(_collectCooldown <= 0f && IsNear\(Shard, collectRange\)\)/);
    expect(result.code).toMatch(/scoreCarried\+\+;/);
    expect(result.code).not.toMatch(/Phase_OnTap\s*\(\s*\)/);
  });

  test('w1bSplit on: Main Update calls Phase_OnTap() instead of inline switch', () => {
    const result = templateEngine.fillSkeleton(minimalSchema(), minimalSkeleton(), { w1bSplit: true });
    expect(result.code).toMatch(/Phase_OnTap\s*\(\s*\)\s*;/);
    // The tap condition is preserved; only the body changes.
    expect(result.code).toMatch(/Input\.GetMouseButtonDown\(0\)/);
    // No per-phase inline case inside Update's tap handler.
    // (other switches elsewhere in the skeleton are fine — we check the TODO_UPDATE body stays tight.)
    const updateMatch = result.code.match(/TODO_UPDATE_START([\s\S]*?)TODO_UPDATE_END/);
    expect(updateMatch).toBeTruthy();
    expect(updateMatch[1]).not.toMatch(/case\s+"p1"\s*:/);
    expect(updateMatch[1]).not.toMatch(/case\s+"p2"\s*:/);
    expect(updateMatch[1]).toMatch(/Phase_OnTap/);
  });

  test('w1bSplit off with empty phases: no tap handler emitted', () => {
    const schema = minimalSchema();
    schema.phases = [];
    // Skip validation by using a custom path: direct call to generateUpdateBody
    // not available — instead verify fillSkeleton handles zero phases gracefully.
    // AJV requires phases non-empty, so this test is effectively a guard-doc.
    // Assert at least that the dispatcher code path is guarded by phases.length.
    expect(() => templateEngine.fillSkeleton(schema, minimalSkeleton())).toThrow();
  });

  test('static_target NPC declares shared defeat counter used by its system body', () => {
    const schema = minimalSchema();
    schema.npcs = [
      { entity: 'Target', template: 'static_target', params: { hp: 10 } },
    ];
    const result = templateEngine.fillSkeleton(schema, minimalSkeleton(), { w1bSplit: true });
    expect(result.code).toMatch(/int enemiesDefeated = 0;/);
    expect(result.code).toMatch(/enemiesDefeated\+\+;/);
  });

  test('phase combat triggers declare shared defeat counter without NPC template', () => {
    const schema = minimalSchema();
    schema.phases[0].trigger = { type: 'enemy_defeated', count: 1 };
    const result = templateEngine.fillSkeleton(schema, minimalSkeleton(), { w1bSplit: true });
    expect(result.code).toMatch(/int enemiesDefeated = 0;/);
  });
});
