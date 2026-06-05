const { staticCheck, staticCheckProject, getBlockingIssues, RULES } = require('../engine/static-check.cjs');

describe('static-check', () => {
  test('RULES array has 62+ entries', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(62);
  });

  test('clean code passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    var obj = GameObject.Find("__Pool_Hero");
    obj.transform.position = new Vector3(0, 1, 0);
  }
}`;
    const result = staticCheck(code);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  // --- Blocking rules ---

  test('SetActive detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { gameObject.SetActive(false); }
}`;
    const result = staticCheck(code);
    expect(result.passed).toBe(false);
    const hit = result.issues.find(i => i.rule === 'setactive');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('Destroy detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { Destroy(gameObject); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'destroy-call');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('Instantiate detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { var x = Instantiate(prefab); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'instantiate');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('AddComponent detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { gameObject.AddComponent<Rigidbody>(); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'add-component');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('GFM_Create.Obj detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { GFM_Create.Obj("cube", 1, 1, 1); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'create-obj');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('renderer.material.color detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { GetComponent<Renderer>().material.color = Color.red; }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'renderer-material-color');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('new Material detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { var m = new Material(Shader.Find("Standard")); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'new-material');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('CreatePrimitive detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { GameObject.CreatePrimitive(PrimitiveType.Cube); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'create-primitive');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  // --- Non-blocking rules ---

  test('StartCoroutine detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { StartCoroutine(DoStuff()); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'coroutine');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(false);
  });

  test('System.Linq detected', () => {
    const code = `using UnityEngine;
using System.Linq;
public class Main : MonoBehaviour { }`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'linq');
    expect(hit).toBeDefined();
  });

  test('List<T> detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  List<int> items = new List<int>();
}`;
    const issues = staticCheck(code).issues.filter(i => i.rule === 'list-generic' || i.rule === 'new-list');
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  test('missing using UnityEngine detected', () => {
    const code = `public class Main : MonoBehaviour { }`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'missing-using');
    expect(hit).toBeDefined();
  });

  test('partial-method-duplicate does not misread IsNear call continuations as declarations', () => {
    const mainCode = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  bool IsNear(GameObject target, float range) { return true; }
}`;
    const inputCode = `using UnityEngine;
public partial class GameFlowManagerMain {
  void HandleTap() {
    if (RocketDebris != null
        && IsNear(RocketDebris, 2f))
    {
      RocketDebrisState = 1;
    }
  }
}`;
    const result = staticCheck(mainCode, {
      filename: 'GameFlowManagerMain.cs',
      extraFiles: {
        'GameFlowManagerMain.Input.cs': inputCode,
      },
    });
    const hit = result.issues.find(i => i.rule === 'partial-method-duplicate');
    expect(hit).toBeUndefined();
  });

  test('require-member-doc fires (non-blocking) for uncommented GameFlowManagerMain members', () => {
    // 2026-05-03: 规则降级为 blocking=false（纯风格，曾导致 30%+ 首轮被强制重写）。
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  int missingComment = 0;
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.cs' }).issues.find(i => i.rule === 'require-member-doc');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(false);
  });

  test('complex branch comments fire (non-blocking) when missing near a condition', () => {
    // 2026-05-03: branch/multiline-condition 注释规则降级为 blocking=false。
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  int score = 0; // current score used by the gate
  bool ready = true; // secondary gameplay readiness gate
  // Evaluate the score gate for this phase.
  void CheckScoreGate() {
    score += 0;
    if (score >= 100 && ready) {
      score++;
    }
  }
}`;
    const issues = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues;
    const branchHit = issues.find(i => i.rule === 'require-branch-comment');
    const condHit = issues.find(i => i.rule === 'multiline-condition-comment-required');
    expect(branchHit).toBeDefined();
    expect(branchHit.blocking).toBe(false);
    expect(condHit).toBeDefined();
    expect(condHit.blocking).toBe(false);
  });

  test('switch and case comments fire (non-blocking) when missing in GameFlowManagerMain partials', () => {
    // 注意：`switch (currentPhaseName)` 是规则的豁免分支（phase dispatch 共识），所以
    // fixture 必须用其他 switch 变量才能触发 switch-case-comment-required 规则。
    // 2026-05-03: 规则降级为 blocking=false。
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  int handlerKind = 0;
  void RouteByKind() {
    switch (handlerKind) {
      case 1: break;
      case 2: break;
    }
  }
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues.find(i => i.rule === 'switch-case-comment-required');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(false);
  });

  test('staticCheckProject scans companion partials for forbidden event dispatch', () => {
    const mainCode = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
}`;
    const flowCode = `using UnityEngine;
public partial class GameFlowManagerMain {
  // Bad helper intentionally uses the forbidden event helper.
  void BadEventDispatch() {
    GFM_Event.FireNow(1001, this, "payload");
  }
}`;
    const result = staticCheckProject(mainCode, {
      filename: 'GameFlowManagerMain.cs',
      extraFiles: {
        'GameFlowManagerMain.Flow.cs': flowCode,
      },
    });
    const hit = result.issues.find(i => i.file === 'GameFlowManagerMain.Flow.cs' && i.rule === 'no-unityevent-in-flow');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('canonical entity binding forbids direct pool lookup in GameFlowManagerMain', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  string[] _entityBindingIds = new string[] { "Hero" };
  void Start() {
    Hero = GameObject.Find("__Pool_Hero");
  }
  GameObject Hero; // bound entity
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.cs' }).issues.find(i => i.rule === 'canonical-entity-find-forbidden');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('autoplay fallback is forbidden in tap handlers', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain {
  void Phase_upgrade_OnTap() {
    if (ShouldRunAutoPlayFallback()) { }
  }
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues.find(i => i.rule === 'autoplay-fallback-in-ontap');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('resource api calls require canonical resource ids when helper exists', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain {
  void Foo() {
    AddResource("Gold", 1);
    AddResource(GFM_ResourceIds.Gold, 1);
  }
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.Resource.cs' }).issues.find(i => i.rule === 'raw-resource-string-call');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('updategamestate-skeleton-preserve accepts helper-based bridge structure', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  string BuildEntityStatesJson() { return "{}"; }
  string BuildVariablesJson() { return "{}"; }
  string BuildUiStateJson() { return "{}"; }
  string BuildCameraStateJson() { return "{}"; }
  string BuildOffscreenEntitiesJson() { return "[]"; }
  void UpdateGameState() {
    string completedJson = "[]";
    string json = "{"
      + "\\"currentPhase\\":\\"phase1\\","
      + "\\"completedPhases\\":" + completedJson + ","
      + "\\"entityStates\\":" + BuildEntityStatesJson() + ","
      + "\\"variables\\":" + BuildVariablesJson() + ","
      + "\\"uiState\\":" + BuildUiStateJson() + ","
      + "\\"cameraState\\":" + BuildCameraStateJson() + ","
      + "\\"offscreenEntities\\":" + BuildOffscreenEntitiesJson() + ","
      + "\\"phaseTimestamps\\":{}"
      + "}";
    gameObject.name = "GFM|" + json;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'updategamestate-skeleton-preserve');
    expect(hit).toBeUndefined();
  });

  test('direct camera motion is forbidden outside initialization', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  Camera mainCam;
  void EnterPhase() {
    mainCam.orthographicSize = 6f;
    mainCam.transform.eulerAngles = new Vector3(50f, 5f, 0f);
    mainCam.transform.LookAt(Vector3.zero);
  }
}`;
    const hits = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues.filter(i => i.rule === 'direct-camera-motion-forbidden');
    expect(hits.length).toBe(3);
    expect(hits.every(i => i.blocking)).toBe(true);
  });

  test('direct camera setup is allowed in Start', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  Camera mainCam;
  void Start() {
    mainCam.orthographicSize = 8f;
    mainCam.transform.position = new Vector3(0, 12f, -8f);
  }
}`;
    const hit = staticCheck(code, { filename: 'GameFlowManagerMain.cs' }).issues.find(i => i.rule === 'direct-camera-motion-forbidden');
    expect(hit).toBeUndefined();
  });

  test('updategamestate-skeleton-preserve blocks missing helper bridge keys', () => {
    const code = `using UnityEngine;
public partial class GameFlowManagerMain : MonoBehaviour {
  void UpdateGameState() {
    string json = "{"
      + "\\"currentPhase\\":\\"phase1\\","
      + "\\"completedPhases\\":[]"
      + "}";
    gameObject.name = json;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'updategamestate-skeleton-preserve');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  // --- v6 rules ---

  test('invalid identifier (digit start) detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  bool 5Done = false;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'invalid-identifier');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('JS undefined literal detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { var x = undefined; }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'js-undefined-literal');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  // --- v7 Luna docs rules ---

  test('SByte detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  SByte val = 0;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'sbyte-type');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('NavMesh detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  NavMeshAgent agent;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'navmesh-usage');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('JS class name conflict detected as blocking', () => {
    const code = `using UnityEngine;
public class Number : MonoBehaviour { }`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'js-class-name-conflict');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('new Input System detected as blocking', () => {
    const code = `using UnityEngine;
using UnityEngine.InputSystem;
public class Main : MonoBehaviour { }`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'new-input-system');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('System.Math detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { var x = System.Math.Abs(-1); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'system-math-lib');
    expect(hit).toBeDefined();
  });

  test('destructor syntax detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  ~Main() { }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'destructor-syntax');
    expect(hit).toBeDefined();
  });

  // --- buildCodeMask: skip matches inside strings/comments ---

  test('SetActive inside string literal is ignored', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { Debug.Log("SetActive(true) is bad"); }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'setactive');
    expect(hit).toBeUndefined();
  });

  test('Destroy inside block comment is ignored', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  /* Destroy(gameObject); */
  void Start() { }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'destroy-call');
    expect(hit).toBeUndefined();
  });

  test('Instantiate inside line comment is ignored', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  // Instantiate(prefab);
  void Start() { }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'instantiate');
    expect(hit).toBeUndefined();
  });

  // --- getBlockingIssues ---

  test('getBlockingIssues filters non-blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    StartCoroutine(DoStuff());
    Destroy(gameObject);
  }
}`;
    const blocking = getBlockingIssues(code);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    expect(blocking.every(i => i.blocking)).toBe(true);
    expect(blocking.find(i => i.rule === 'destroy-call')).toBeDefined();
    expect(blocking.find(i => i.rule === 'coroutine')).toBeUndefined();
  });

  // --- Custom rule: CreateCanvas only flags second+ occurrence ---

  test('single CreateCanvas is allowed', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() { GFM_UI.CreateCanvas(); }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'create-canvas');
    expect(hit).toBeUndefined();
  });

  test('double CreateCanvas is flagged', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    GFM_UI.CreateCanvas();
    GFM_UI.CreateCanvas();
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'create-canvas');
    expect(hit).toBeDefined();
  });

  // --- AutoPlay rules ---

  test('AUTO_PLAY_PHASE_DURATION < 10 detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  float AUTO_PLAY_PHASE_DURATION = 5;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-duration-tamper');
    expect(hit).toBeDefined();
  });

  test('AUTO_PLAY_PHASE_DURATION > 15 detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  float AUTO_PLAY_PHASE_DURATION = 20f;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-duration-tamper');
    expect(hit).toBeDefined();
  });

  test('AUTO_PLAY_PHASE_DURATION within 10-15 passes (skeleton uses 12)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  float AUTO_PLAY_PHASE_DURATION = 12f;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-duration-tamper');
    expect(hit).toBeUndefined();
  });

  test('unified autoPlay phase gate outside 10-15 is detected', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  bool _autoPlayMode;
  float phaseTimer;
  bool ruleTriggered;
  void CheckEventRules() {
    if (!ruleTriggered && phaseTimer >= (_autoPlayMode ? 8f : 3f)) {}
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-phase-too-fast');
    expect(hit).toBeDefined();
  });

  test('unified autoPlay phase gate at 12s passes', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  bool _autoPlayMode;
  float phaseTimer;
  bool ruleTriggered;
  void CheckEventRules() {
    if (!ruleTriggered && phaseTimer >= (_autoPlayMode ? 12f : 3f)) {}
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-phase-too-fast');
    expect(hit).toBeUndefined();
  });

  test('realtime PhaseDwellReady autoPlay gate passes gate-presence check', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  bool _autoPlayMode;
  float phaseTimer;
  float phaseRealTimer;
  bool ruleTriggered;
  void CheckEventRules() {
    if (!ruleTriggered && PhaseDwellReady(10f)) {}
  }
  bool PhaseDwellReady(float specMinSeconds) {
    float requiredSeconds = _autoPlayMode ? 12f : specMinSeconds;
    return _autoPlayMode ? phaseRealTimer >= requiredSeconds : phaseTimer >= requiredSeconds;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-gate-removed');
    expect(hit).toBeUndefined();
  });

  // --- v8: Performance hot-path rules (Batch 3) ---

  test('new Vector3 in Update() detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    transform.position = new Vector3(1, 2, 3);
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
    expect(hit.line).toBe(4);
  });

  test('new Vector3 in Start() is allowed (not a hot path)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    transform.position = new Vector3(1, 2, 3);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3(0,0,0) in Update is allowed (zero vector)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    var zero = new Vector3(0,0,0);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3 in string literal inside Update is ignored', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    Debug.Log("example: new Vector3(1,2,3)");
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3 in MovePlayer detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void MovePlayer() {
    player.transform.position = new Vector3(1, 0, 2);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('source target ring mirrored x is blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject _sourceTargetRing;
  void UpdateSourceGuidance(GameObject target) {
    Vector3 tp = target.transform.position;
    _sourceTargetRing.transform.position = new Vector3(-tp.x, 0.10f, tp.z);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'source-target-ring-mirrored-x');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('phase-index-only source guidance target is blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject IceBlock;
  GameObject BottledWater;
  GameObject CTAButton;
  GameObject SourceTargetForPhase(int phaseIndex) {
    if (phaseIndex == 1) return BottledWater;
    if (phaseIndex == 2) return IceBlock;
    if (phaseIndex == 3) return CTAButton;
    return IceBlock;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'source-guidance-phase-index-only-target');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });

  test('stateful source guidance target resolver is allowed', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject IceBlock;
  GameObject BottledWater;
  GameObject SourceTargetForInitialGuidance() {
    if (IceBlockCarried > 0 || GetResource("IceBlock") >= 3) return BottledWater;
    return IceBlock;
  }
  GameObject SourceTargetForPhase(int phaseIndex) {
    if (phaseIndex == 1) return SourceTargetForInitialGuidance();
    return SourceTargetForInitialGuidance();
  }
  int IceBlockCarried;
  int GetResource(string id) { return 0; }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'source-guidance-phase-index-only-target');
    expect(hit).toBeUndefined();
  });

  test('3+ chained if (X == "...") without else detected as warn', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    if (phase == "p2") { }
    if (phase == "p3") { }
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBeFalsy();
  });

  test('2 chained if on same var does NOT trigger (threshold is 3)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    if (phase == "p2") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });

  test('3 chained if but on different vars does NOT trigger', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (a == "p1") { }
    if (b == "p2") { }
    if (c == "p3") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });

  test('else if chain does NOT trigger', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    else if (phase == "p2") { }
    else if (phase == "p3") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });

  test('string concat with .text= in Update detected as warn', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  int score;
  void Update() {
    scoreText.text = "Score: " + score;
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBeFalsy();
  });

  test('.text= literal only (no concat) in Update is allowed', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  void Update() {
    scoreText.text = "Hello";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeUndefined();
  });

  test('.text= concat in Start is allowed (not a hot path)', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  void Start() {
    scoreText.text = "Score: " + 0;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeUndefined();
  });

  // --- 2026-04-21 phase-entity-init-only (phase-scoped movement check) ---

  test('phase-entity-init-only: X only moved in TODO_PHASE_INIT → blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject iceOre;
  Vector3 _snap_iceOrePos;
  void Update() {
    // TODO_PHASE_1_INIT_START
    PlaceObj(iceOre, 2f, 0.5f, 0f);
    _snap_iceOrePos = iceOre.transform.position;
    // TODO_PHASE_1_INIT_END
    if (EntityAdvanced(iceOre, _snap_iceOrePos)) {
      // phase advances
    }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'phase-entity-init-only');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
    expect(hit.text).toContain('iceOre');
  });

  test('phase-entity-init-only: PlaceObj outside init block → pass', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject iceOre;
  Vector3 _snap_iceOrePos;
  void Update() {
    // TODO_PHASE_1_INIT_START
    _snap_iceOrePos = iceOre.transform.position;
    // TODO_PHASE_1_INIT_END
    if (IsNear(iceOre, 2f)) {
      PlaceObj(iceOre, 4f, 0.5f, 0f);
    }
    if (EntityAdvanced(iceOre, _snap_iceOrePos)) { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'phase-entity-init-only');
    expect(hit).toBeUndefined();
  });

  test('phase-entity-init-only: HideObj outside init block → pass', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject iceOre;
  bool iceOreDone;
  Vector3 _snap_iceOrePos;
  void Update() {
    // TODO_PHASE_1_INIT_START
    _snap_iceOrePos = iceOre.transform.position;
    // TODO_PHASE_1_INIT_END
    if (IsNear(iceOre, 2f)) {
      iceOreDone = true;
      HideObj(iceOre);
    }
    if (EntityAdvanced(iceOre, _snap_iceOrePos)) { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'phase-entity-init-only');
    expect(hit).toBeUndefined();
  });

  test('phase-entity-init-only: player whitelist (MovePlayer defined) → pass', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject player;
  Vector3 _snap_playerPos;
  void Update() {
    // TODO_PHASE_1_INIT_START
    _snap_playerPos = player.transform.position;
    // TODO_PHASE_1_INIT_END
    MovePlayer();
    if (EntityAdvanced(player, _snap_playerPos)) { }
  }
  void MovePlayer() {
    player.transform.position = player.transform.position + Vector3.forward * 0.1f;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'phase-entity-init-only');
    expect(hit).toBeUndefined();
  });

  test('phase-entity-init-only: direct transform.position= outside init → pass', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject forge;
  Vector3 _snap_forgePos;
  void Update() {
    // TODO_PHASE_2_INIT_START
    _snap_forgePos = forge.transform.position;
    // TODO_PHASE_2_INIT_END
    if (IsNear(forge, 2f) && Input.GetMouseButtonDown(0)) {
      forge.transform.position = new Vector3(forge.transform.position.x, forge.transform.position.y + 2f, forge.transform.position.z);
    }
    if (EntityAdvanced(forge, _snap_forgePos)) { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'phase-entity-init-only');
    expect(hit).toBeUndefined();
  });

  test('setscale-wrong-params ignores valid SetScale with nested parentheses in args', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  GameObject ConveyorBelt;
  float gameTimer;
  void Tick(float next) {
    SetScale(ConveyorBelt, next, 0.25f + Mathf.Abs(Mathf.Sin(gameTimer * 8f)) * 0.15f, next);
  }
  void SetScale(GameObject obj, float x, float y, float z) {}
  void SetScale(GameObject obj, float uniform) {}
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'setscale-wrong-params');
    expect(hit).toBeUndefined();
  });

  // --- v10: 反馈 01 (2026-04-26) ---

  test('unnamed-gameobject 命中 .name = "Cube" 字面量', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    var go = GameObject.Find("__Pool_Cube_01");
    go.name = "Cube";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'unnamed-gameobject');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(false);
  });

  test('unnamed-gameobject 命中 "Cylinder (Clone)"', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    var go = GameObject.Find("__Pool_Cylinder_02");
    go.name = "Cylinder (Clone)";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'unnamed-gameobject');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(false);
  });

  test('unnamed-gameobject 不命中领域命名', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    var go = GameObject.Find("__Pool_Cube_01");
    go.name = "我方基地";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'unnamed-gameobject');
    expect(hit).toBeUndefined();
  });

  test('unnamed-gameobject 忽略注释中的字面量', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  // 错误示例: go.name = "Cube";
  void Start() {
    var go = GameObject.Find("__Pool_Cube_01");
    go.name = "兵营";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'unnamed-gameobject');
    expect(hit).toBeUndefined();
  });
});
