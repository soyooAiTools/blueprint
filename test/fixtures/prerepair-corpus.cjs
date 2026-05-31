// Shared corpus for the runAllPreRepairs snapshot test (Wave 2).
// Inputs exercise: the 3 main-prefix fns, the shared bundle on main + partials,
// Pass C comment fns with the GameFlowManagerMain filter, and a no-op case.
// Used by test/static-rule-prerepair-equivalence.test.cjs and the snapshot generator.
module.exports = [
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
