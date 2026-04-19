const { staticCheck, getBlockingIssues, RULES } = require('../engine/static-check.cjs');

describe('static-check', () => {
  test('RULES array has 59+ entries', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(59);
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

  test('AUTO_PLAY_PHASE_DURATION >= 10 passes (skeleton uses 12)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  float AUTO_PLAY_PHASE_DURATION = 12;
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'autoplay-duration-tamper');
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
});
