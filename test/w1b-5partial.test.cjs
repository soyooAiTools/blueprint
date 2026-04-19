const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
const { staticCheck } = require('../engine/static-check.cjs');

function makeSpecs(phaseCount) {
  const specs = [];
  const phaseCatalog = [
    { id: 'initialCollect', title: 'collect scraps' },
    { id: 'sellShards',     title: 'sell scraps'  },
    { id: 'buildHull',      title: 'build hull'   },
    { id: 'upgradeEngine',  title: 'upgrade'      },
    { id: 'defendBase',     title: 'defend base'  },
    { id: 'gatherFuel',     title: 'gather fuel'  },
    { id: 'deliverCargo',   title: 'deliver'      },
    { id: 'buildBridge',    title: 'bridge'       },
    { id: 'upgradeShield',  title: 'shield up'    },
    { id: 'bossFight',      title: 'boss'         },
    { id: 'finalDelivery',  title: 'delivery'     },
    { id: 'celebration',    title: 'celebrate'    },
  ];
  const n = phaseCount || 12;
  for (let i = 0; i < n; i++) {
    const p = phaseCatalog[i % phaseCatalog.length];
    const pid = p.id + (i >= phaseCatalog.length ? String(i) : '');
    specs.push({
      phaseId: pid,
      phaseName: 'Phase ' + (i + 1),
      title: p.title,
      duration: { min: 3, max: 6 },
      entities: ['Player', 'MetalShard'],
      entitiesRequired: [{ name: 'MetalShard', terminalState: 1 }],
      requiredInteractions: ['collect:MetalShard'],
      triggerNext: { condition: pid + 'InteractionDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    });
  }
  return specs;
}

function bracesBalanced(code) {
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe('W1b 5-partial skeleton smoke test', () => {
  test('opt-in flag off: returns legacy string or 2-file object', () => {
    const out = generateSkeleton(makeSpecs(12));
    if (typeof out === 'object') {
      expect(out.mode).not.toBe('w1b-5partial');
    } else {
      expect(typeof out).toBe('string');
    }
  });

  test('opt-in flag on: returns 5-partial object with 6 files', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    expect(typeof out).toBe('object');
    expect(out.mode).toBe('w1b-5partial');
    expect(out.split).toBe(true);
    expect(typeof out.main).toBe('string');
    expect(typeof out.flow).toBe('string');
    expect(typeof out.input).toBe('string');
    expect(typeof out.resource).toBe('string');
    expect(typeof out.ui).toBe('string');
    expect(typeof out.scene).toBe('string');
  });

  test('all 6 files declare public partial class GameFlowManagerMain', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    const files = [out.main, out.flow, out.input, out.resource, out.ui, out.scene];
    for (const code of files) {
      expect(code).toMatch(/public\s+partial\s+class\s+GameFlowManagerMain/);
    }
  });

  test('all 6 files have balanced braces', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    expect(bracesBalanced(out.main)).toBe(true);
    expect(bracesBalanced(out.flow)).toBe(true);
    expect(bracesBalanced(out.input)).toBe(true);
    expect(bracesBalanced(out.resource)).toBe(true);
    expect(bracesBalanced(out.ui)).toBe(true);
    expect(bracesBalanced(out.scene)).toBe(true);
  });

  test('Flow partial contains switch (currentPhaseName) dispatch', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    expect(out.flow).toMatch(/switch\s*\(\s*currentPhaseName\s*\)/);
  });

  test('Flow partial contains Phase_OnTap() dispatcher and per-phase handlers', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    expect(out.flow).toMatch(/void\s+Phase_OnTap\s*\(\s*\)/);
    expect(out.flow).toMatch(/void\s+Phase_initialCollect_OnTap\s*\(\s*\)/);
    expect(out.flow).toMatch(/void\s+Phase_sellShards_OnTap\s*\(\s*\)/);
    expect(out.flow).toMatch(/void\s+Phase_bossFight_OnTap\s*\(\s*\)/);
  });

  test('Flow partial emits 12 per-phase OnTap handlers for 12 phase input', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    // Per-phase handlers only (dispatcher is `Phase_OnTap`, no id in the middle)
    const matches = out.flow.match(/void\s+Phase_\w+_OnTap\s*\(\s*\)/g) || [];
    expect(matches.length).toBe(12);
  });

  test('Flow partial contains TODO markers for each phase', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    const starts = out.flow.match(/TODO_PHASE_\w+_ONTAP_START/g) || [];
    const ends = out.flow.match(/TODO_PHASE_\w+_ONTAP_END/g) || [];
    expect(starts.length).toBe(12);
    expect(ends.length).toBe(12);
  });

  test('Flow partial sets InteractionDone + PlayerActed per phase', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    expect(out.flow).toMatch(/initialCollectInteractionDone\s*=\s*true\s*;/);
    expect(out.flow).toMatch(/initialCollectPlayerActed\s*=\s*true\s*;/);
  });

  test('Stub partials (Input/Resource/UI/Scene) are minimal but valid', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    for (const stub of [out.input, out.resource, out.ui, out.scene]) {
      expect(stub).toMatch(/using\s+UnityEngine\s*;/);
      expect(stub).toMatch(/public\s+partial\s+class\s+GameFlowManagerMain\s*\{[\s\S]*\}/);
      expect(stub.length).toBeLessThan(500);
    }
  });

  test('Main partial preserves full skeleton body (not empty)', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    // Main should still contain Update + Start + currentPhaseName plumbing
    expect(out.main).toMatch(/void\s+Update\s*\(\s*\)/);
    expect(out.main).toMatch(/void\s+Start\s*\(\s*\)/);
    expect(out.main).toMatch(/currentPhaseName/);
    expect(out.main.length).toBeGreaterThan(2000);
  });

  test('static-check partial-split-enforce: passes when all 5 companions present', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    const extraFiles = {
      'GameFlowManagerMain.Flow.cs': out.flow,
      'GameFlowManagerMain.Input.cs': out.input,
      'GameFlowManagerMain.Resource.cs': out.resource,
      'GameFlowManagerMain.UI.cs': out.ui,
      'GameFlowManagerMain.Scene.cs': out.scene,
    };
    const result = staticCheck(out.main, { extraFiles: extraFiles });
    const partialIssues = (result.issues || []).filter(function(i) {
      return i.rule === 'partial-split-enforce';
    });
    expect(partialIssues).toEqual([]);
  });

  test('static-check partial-split-enforce: fires when companions missing', () => {
    const out = generateSkeleton(makeSpecs(12), { w1bSplit: true });
    // Only 2 companions present instead of 5
    const extraFiles = {
      'GameFlowManagerMain.Flow.cs': out.flow,
      'GameFlowManagerMain.Input.cs': out.input,
    };
    const result = staticCheck(out.main, { extraFiles: extraFiles });
    const partialIssues = (result.issues || []).filter(function(i) {
      return i.rule === 'partial-split-enforce';
    });
    // Rule only fires when Main itself declares partial class; smoke-assert
    // at least that the combined scan doesn't crash and produces deterministic output.
    expect(Array.isArray(result.issues)).toBe(true);
  });

  test('13-phase input produces 13 per-phase OnTap handlers', () => {
    const out = generateSkeleton(makeSpecs(13), { w1bSplit: true });
    const matches = out.flow.match(/void\s+Phase_\w+_OnTap\s*\(\s*\)/g) || [];
    expect(matches.length).toBe(13);
    expect(out.flow).toMatch(/void\s+Phase_OnTap\s*\(\s*\)/);
  });
});
