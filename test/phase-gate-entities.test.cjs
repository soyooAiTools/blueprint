// 2026-04-21: verify phaseGateEntities() (skeleton-generator) filters phase-exit
// gate to entities that a known interaction template will actually move. Prior
// behaviour included decoration-only entities too, which made EntityAdvanced(X)
// structurally unreachable (s6ae56 / nqw7z3 root cause).

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function firstRealCondition(code) {
  // Skeleton emits `realCondition: ... && ...` inside buildRealCondition comments +
  // also embeds the condition in `if (prevPhaseCompleted && (<cond>))`. Simplest
  // check: look for the first `EntityAdvanced(` or `true /* time-only` or `false /*`.
  const m = code.match(/(EntityAdvanced\([^)]+\)(?:\s*&&\s*EntityAdvanced\([^)]+\))*|true \/\* time-only[^*]+\*\/|false \/\* AI:[^*]+\*\/)/);
  return m ? m[1] : null;
}

function gateEntities(code) {
  const names = new Set();
  const re = /EntityAdvanced\(\s*([A-Za-z_]\w*)\s*,\s*_snap_\1Pos\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return Array.from(names);
}

describe('phaseGateEntities filter', () => {
  test('moving-verb interaction target is preferred over decoration-only entity', () => {
    const specs = [
      {
        phaseId: 'intro',
        entitiesRequired: [{ name: 'player' }],
        requiredInteractions: ['wait:2'],
        triggerNext: { condition: 'true' },
        duration: { min: 2, max: 3 },
      },
      {
        phaseId: 'collectIceOre',
        // Decoration is in entitiesRequired but NOT a collect target.
        entitiesRequired: [{ name: 'IceOre' }, { name: 'BackgroundRock' }],
        requiredInteractions: ['collect:IceOre'],
        triggerNext: { condition: 'iceCount >= 3' },
        duration: { min: 10, max: 20 },
      },
    ];
    const skeleton = generateSkeleton(specs, {
      entityPoolMap: { player: '__Pool_Player', IceOre: '__Pool_IceOre', BackgroundRock: '__Pool_Rock' },
      entities: [{ name: 'player' }, { name: 'IceOre' }, { name: 'BackgroundRock' }],
    });
    const code = typeof skeleton === 'string' ? skeleton : skeleton.main;
    const gates = gateEntities(code);
    expect(gates).toContain('IceOre');
    expect(gates).not.toContain('BackgroundRock');
  });

  test('wait/defend-only interactions with NO entities fall through to time-only beat', () => {
    const specs = [
      {
        phaseId: 'intro',
        entitiesRequired: [],
        requiredInteractions: ['wait:3'],
        triggerNext: { condition: 'true' },
        duration: { min: 3, max: 5 },
      },
      {
        phaseId: 'hold',
        entitiesRequired: [],
        requiredInteractions: ['wait:5'],
        triggerNext: { condition: 'true' },
        duration: { min: 5, max: 5 },
      },
    ];
    const skeleton = generateSkeleton(specs, {
      entityPoolMap: {},
      entities: [],
    });
    const code = typeof skeleton === 'string' ? skeleton : skeleton.main;
    expect(code).toMatch(/time-only beat/);
    expect(code).toMatch(/DetectRealTime <= 0f \|\| GFM_AutoPlay\.Instance\.IsActive/);
  });

  test('click:entity keeps clickable target in gate', () => {
    const specs = [
      {
        phaseId: 'intro',
        entitiesRequired: [{ name: 'player' }],
        requiredInteractions: ['wait:1'],
        triggerNext: { condition: 'true' },
        duration: { min: 1, max: 2 },
      },
      {
        phaseId: 'buyForge',
        entitiesRequired: [{ name: 'ForgeWorkshop' }],
        requiredInteractions: ['click:ForgeWorkshop'],
        triggerNext: { condition: 'forgeOwned' },
        duration: { min: 5, max: 10 },
      },
    ];
    const skeleton = generateSkeleton(specs, {
      entityPoolMap: { player: '__Pool_Player', ForgeWorkshop: '__Pool_Forge' },
      entities: [{ name: 'player' }, { name: 'ForgeWorkshop' }],
    });
    const code = typeof skeleton === 'string' ? skeleton : skeleton.main;
    expect(gateEntities(code)).toContain('ForgeWorkshop');
  });

  test('non-moving defend-only interactions no longer populate EntityAdvanced gate', () => {
    const specs = [
      {
        phaseId: 'intro',
        entitiesRequired: [{ name: 'player' }],
        requiredInteractions: ['wait:1'],
        triggerNext: { condition: 'true' },
        duration: { min: 1, max: 2 },
      },
      {
        phaseId: 'defendBase',
        entitiesRequired: [{ name: 'Tower' }],
        // defend is NOT in MOVING_VERBS. The generator must avoid inventing an
        // unreachable EntityAdvanced(Tower) gate from entitiesRequired alone.
        requiredInteractions: ['defend:Tower'],
        triggerNext: { condition: 'waveCleared' },
        duration: { min: 15, max: 30 },
      },
    ];
    const skeleton = generateSkeleton(specs, {
      entityPoolMap: { player: '__Pool_Player', Tower: '__Pool_Tower' },
      entities: [{ name: 'player' }, { name: 'Tower' }],
    });
    const code = typeof skeleton === 'string' ? skeleton : skeleton.main;
    expect(gateEntities(code)).not.toContain('Tower');
    expect(code).toMatch(/time-only beat/);
    expect(code).toMatch(/DetectRealTime <= 0f \|\| GFM_AutoPlay\.Instance\.IsActive/);
  });

  test('multiple moving-verb targets: all appear in gate', () => {
    const specs = [
      {
        phaseId: 'intro',
        entitiesRequired: [{ name: 'player' }],
        requiredInteractions: ['wait:1'],
        triggerNext: { condition: 'true' },
        duration: { min: 1, max: 2 },
      },
      {
        phaseId: 'gatherAll',
        entitiesRequired: [{ name: 'OreA' }, { name: 'OreB' }],
        requiredInteractions: ['collect:OreA', 'collect:OreB'],
        triggerNext: { condition: 'bothGathered' },
        duration: { min: 10, max: 20 },
      },
    ];
    const skeleton = generateSkeleton(specs, {
      entityPoolMap: { player: '__Pool_Player', OreA: '__Pool_OreA', OreB: '__Pool_OreB' },
      entities: [{ name: 'player' }, { name: 'OreA' }, { name: 'OreB' }],
    });
    const code = typeof skeleton === 'string' ? skeleton : skeleton.main;
    const gates = gateEntities(code);
    expect(gates).toContain('OreA');
    expect(gates).toContain('OreB');
  });
});
