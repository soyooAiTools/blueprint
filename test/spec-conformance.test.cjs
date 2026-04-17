const { checkConformance } = require('../engine/spec-conformance.cjs');

describe('spec-conformance', () => {
  test('empty specs passes', () => {
    const result = checkConformance('some code', { specs: [] });
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('missing phase completion is critical', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { }
}`;
    const blueprint = {
      specs: [{ phaseId: 'CollectCoins', requiredInteractions: [], entitiesRequired: [] }],
    };
    const result = checkConformance(code, blueprint);
    expect(result.passed).toBe(false);
    expect(result.criticalCount).toBeGreaterThanOrEqual(1);
    const hit = result.issues.find(i => i.phase === 'CollectCoins' && i.severity === 'critical');
    expect(hit).toBeDefined();
  });

  test('exact phase match passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void CompletePhase() { AddCompletedPhase("CollectCoins"); }
}`;
    const blueprint = {
      specs: [{ phaseId: 'CollectCoins', requiredInteractions: [], entitiesRequired: [] }],
    };
    const result = checkConformance(code, blueprint);
    const critical = result.issues.find(i => i.phase === 'CollectCoins' && i.severity === 'critical');
    expect(critical).toBeUndefined();
  });

  test('fuzzy phase match (normalized) passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() { AddCompletedPhase("collect_coins"); }
}`;
    const blueprint = {
      specs: [{ phaseId: 'CollectCoins', requiredInteractions: [], entitiesRequired: [] }],
    };
    const result = checkConformance(code, blueprint);
    const critical = result.issues.find(i => i.phase === 'CollectCoins' && i.severity === 'critical');
    expect(critical).toBeUndefined();
  });

  test('missing interaction handler is warning', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() { AddCompletedPhase("TapTarget"); }
}`;
    const blueprint = {
      specs: [{ phaseId: 'TapTarget', requiredInteractions: ['click_target'], entitiesRequired: [] }],
    };
    const result = checkConformance(code, blueprint);
    const warn = result.issues.find(i => i.severity === 'warning' && i.message.includes('click'));
    expect(warn).toBeDefined();
  });

  test('click handler present passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() { AddCompletedPhase("TapTarget"); }
  void OnPointerClick() { }
}`;
    const blueprint = {
      specs: [{ phaseId: 'TapTarget', requiredInteractions: ['click_target'], entitiesRequired: [] }],
    };
    const result = checkConformance(code, blueprint);
    const warn = result.issues.find(i => i.severity === 'warning' && i.message.includes('click'));
    expect(warn).toBeUndefined();
  });

  test('missing entity pool reference is warning', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() { AddCompletedPhase("Phase1"); }
}`;
    const blueprint = {
      specs: [{
        phaseId: 'Phase1',
        requiredInteractions: [],
        entitiesRequired: [{ name: 'Hero' }],
      }],
      entityPoolMap: { Hero: '__Pool_Hero' },
    };
    const result = checkConformance(code, blueprint);
    const warn = result.issues.find(i => i.message.includes('__Pool_Hero'));
    expect(warn).toBeDefined();
  });

  test('entity pool reference present passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { var hero = GameObject.Find("__Pool_Hero"); }
  void Update() { AddCompletedPhase("Phase1"); }
}`;
    const blueprint = {
      specs: [{
        phaseId: 'Phase1',
        requiredInteractions: [],
        entitiesRequired: [{ name: 'Hero' }],
      }],
      entityPoolMap: { Hero: '__Pool_Hero' },
    };
    const result = checkConformance(code, blueprint);
    const warn = result.issues.find(i => i.message.includes('__Pool_Hero'));
    expect(warn).toBeUndefined();
  });

  test('trigger condition missing tokens is warning', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() { AddCompletedPhase("Phase1"); }
}`;
    const blueprint = {
      specs: [{
        phaseId: 'Phase1',
        requiredInteractions: [],
        entitiesRequired: [],
        triggerNext: { condition: 'collectedGems >= targetCount' },
      }],
    };
    const result = checkConformance(code, blueprint);
    const warn = result.issues.find(i => i.message.includes('missing'));
    expect(warn).toBeDefined();
  });

  test('multiple phases checked', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    AddCompletedPhase("Phase1");
  }
}`;
    const blueprint = {
      specs: [
        { phaseId: 'Phase1', requiredInteractions: [], entitiesRequired: [] },
        { phaseId: 'Phase2', requiredInteractions: [], entitiesRequired: [] },
        { phaseId: 'Phase3', requiredInteractions: [], entitiesRequired: [] },
      ],
    };
    const result = checkConformance(code, blueprint);
    const missing = result.issues.filter(i => i.severity === 'critical');
    expect(missing.length).toBe(2);
  });
});
