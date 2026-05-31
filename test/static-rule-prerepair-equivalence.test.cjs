/**
 * 2026-05-31 Wave 2 Step 2 — runAllPreRepairs equivalence gate.
 *
 * engine/lib/static-rule-prerepair.cjs `runAllPreRepairs` extracted the 3-pass
 * deterministic pre-repair orchestration out of review.cjs and deduplicated the
 * main/partial mirror via SHARED_BUNDLE. It MUST stay byte-identical to the inline
 * implementation (repairKnownStructuralDamageInline, selected via USE_PRE_REPAIR_LIB
 * =false). A silent divergence here costs a full fix-loop round per affected project
 * (review.cjs is the 2nd-most-fragile stage). This test runs a corpus through BOTH
 * paths and asserts identical { code, extraFiles, fixes }.
 */

var review = require('../engine/stages/review.cjs');
var lib = require('../engine/lib/static-rule-prerepair.cjs');

// Corpus exercises: 3 main-prefix fns, shared bundle (main + partials), Pass C
// comment fns with the GameFlowManagerMain filter, and a no-op case.
var CORPUS = [
  {
    name: 'cameraMain+playerField+camBg+hotVector',
    main: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain',
      '{',
      '    Camera mainCam;',
      '    void Start() { mainCam = Camera.main; Camera.main.backgroundColor = Color.black; Camera.main.backgroundColor = Color.white; }',
      '}',
    ].join('\n'),
    extras: {
      'GameFlowManagerMain.Input.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain',
        '{',
        '    GameObject player;',
        '    void MovePlayer() { player.transform.position = player.transform.position + new Vector3(1f, 0f, 0f); }',
        '}',
      ].join('\n'),
    },
    blueprint: {},
  },
  {
    name: 'playerAliasAcrossPartials+cjk+setscale',
    main: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain',
      '{',
      '    GameObject player;',
      '    void Start() { player = GFM_Player.Instance.Go; AddResource("金币", 5); SetScale(player, 1f, 1f, 1f); }',
      '}',
    ].join('\n'),
    extras: {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain',
        '{',
        '    void Move() { Player.transform.position = Vector3.zero; Player.name = "p"; GameObject.Find("敌人"); }',
        '}',
      ].join('\n'),
    },
    blueprint: {},
  },
  {
    name: 'missingFlags+comments+GameFlowManagerMainFilter',
    main: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain',
      '{',
      '    void Update() { WaterResourceDone = true; if (GoldUIDone) { } }',
      '}',
    ].join('\n'),
    extras: {
      'GameFlowManagerMain.State.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain',
        '{',
        '    GameObject WaterResource;',
        '    bool WaterResourceDone = false;',
        '    void Tick() { if (a == 1 && b == 2 && c == 3) { DoThing(); } }',
        '}',
      ].join('\n'),
      'OtherHelper.cs': 'using UnityEngine;\npublic class OtherHelper { void X() { } }',
    },
    blueprint: {},
  },
  { name: 'noop', main: 'using UnityEngine;\npublic partial class GameFlowManagerMain { void Update() { } }', extras: {}, blueprint: {} },
];

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function norm(r) { return JSON.stringify({ code: r.code, extraFiles: r.extraFiles, changed: r.changed, fixes: r.fixes }); }

describe('runAllPreRepairs equivalence (Wave 2 Step 2)', function() {
  it('lib exports runAllPreRepairs + a 17-entry SHARED_BUNDLE', function() {
    expect(typeof lib.runAllPreRepairs).toBe('function');
    expect(Array.isArray(lib.SHARED_BUNDLE)).toBe(true);
    expect(lib.SHARED_BUNDLE.length).toBe(17);
  });

  it('review.cjs still exports repairKnownStructuralDamage', function() {
    expect(typeof review.repairKnownStructuralDamage).toBe('function');
  });

  CORPUS.forEach(function(input) {
    it('lib path == inline path: ' + input.name, function() {
      process.env.USE_PRE_REPAIR_LIB = 'true';
      var libOut = norm(review.repairKnownStructuralDamage(input.main, clone(input.extras), input.blueprint));
      process.env.USE_PRE_REPAIR_LIB = 'false';
      var inlineOut = norm(review.repairKnownStructuralDamage(input.main, clone(input.extras), input.blueprint));
      delete process.env.USE_PRE_REPAIR_LIB;
      expect(libOut).toBe(inlineOut);
    });
  });

  it('default (flag unset) uses the lib path and produces a non-trivial fix log', function() {
    delete process.env.USE_PRE_REPAIR_LIB;
    var out = review.repairKnownStructuralDamage(CORPUS[0].main, clone(CORPUS[0].extras), CORPUS[0].blueprint);
    expect(out.changed).toBe(true);
    expect(out.fixes.length).toBeGreaterThan(0);
  });
});
