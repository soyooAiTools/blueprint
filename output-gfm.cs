using UnityEngine;
using UnityEngine.UI;
using UnityEngine.Events;
using DG.Tweening;

public class GameFlowManagerMain : MonoBehaviour
{
    public static GameFlowManagerMain instance;

    // Camera
    private Camera _mainCam;

    // State machine
    private int _currentShot = 0;
    private int _shotState = 0;
    private float _shotTimer = 0f;
    private float _autoPlayTimer = 0f;
    private float _autoPlayDelay = 1.5f;

    // Player resources
    private int _playerGold = 1;
    private int _playerWood = 0;
    private float _playerSpeed = 5f;

    // Joystick
    private Vector2 _joystickDir = Vector2.zero;
    private bool _joystickActive = false;
    private Vector2 _joystickStart = Vector2.zero;
    private int _joystickFingerId = -1;

    // Core objects
    private GameObject _player;
    private GameObject _base;
    private GameObject _ground;
    private GameObject _conveyorBlueprint;
    private GameObject _conveyor;
    private GameObject _generator;
    private GameObject _fenceN, _fenceS, _fenceE, _fenceW;
    private GameObject _treeL1, _treeL2, _treeR1, _treeR2;
    private GameObject _crossbowL;
    private GameObject _crossbowR;
    private GameObject _woodenHouseL;
    private GameObject _woodenHouseR;
    private GameObject _guideArrow;
    private GameObject _currentTarget;

    // UI
    private Canvas _mainCanvas;
    private Text _resourceText;
    private Text _guideText;
    private Slider _progressBar;
    private GameObject _progressBarObj;

    // Enemies
    private GameObject[] _enemies;
    private int _enemyCount = 0;
    private int _maxEnemies = 12;
    private float _enemySpawnTimer = 0f;
    private int _enemiesSpawned = 0;
    private int _enemiesKilled = 0;
    private bool _enemiesActive = false;

    // Wood logs on conveyor
    private GameObject[] _woodLogs;
    private int _woodLogCount = 0;
    private int _maxWoodLogs = 6;
    private float _woodSpawnTimer = 0f;
    private bool _conveyorRunning = false;

    // Workers
    private GameObject _workerL;
    private GameObject _workerR;
    private int _workerLState = 0;
    private int _workerRState = 0;
    private float _workerLTimer = 0f;
    private float _workerRTimer = 0f;

    // Crossbow shooting
    private float _crossbowLTimer = 0f;
    private float _crossbowRTimer = 0f;
    private bool _crossbowLActive = false;
    private bool _crossbowRActive = false;
    private float _crossbowRange = 5f;
    private float _crossbowDamage = 1f;
    private float _crossbowAttackSpeed = 1f;

    // Arrows (projectiles)
    private GameObject[] _arrows;
    private int _arrowCount = 0;
    private int _maxArrows = 10;
    private Vector3[] _arrowTargets;
    private float[] _arrowTimers;

    // Boss
    private GameObject _boss;
    private float _bossHP = 50f;
    private float _bossMaxHP = 50f;
    private float _baseHP = 50f;
    private float _baseMaxHP = 50f;
    private Slider _bossHPBar;
    private Slider _baseHPBar;
    private float _bossAttackTimer = 0f;

    // Castle upgrade
    private GameObject _castle;
    private GameObject _stoneWallN, _stoneWallS, _stoneWallE, _stoneWallW;

    // Positions
    private Vector3 _basePos = new Vector3(0f, 0f, -2f);
    private Vector3 _playerStartPos = new Vector3(-2f, 0f, -4f);
    private Vector3 _conveyorPos = new Vector3(0f, 0f, 2f);
    private Vector3 _generatorPos = new Vector3(0f, 0f, 5f);
    private Vector3 _crossbowLPos = new Vector3(-5f, 0f, -3f);
    private Vector3 _crossbowRPos = new Vector3(5f, 0f, 3f);
    private Vector3 _houseLeftPos = new Vector3(-5f, 0f, 1f);
    private Vector3 _houseRightPos = new Vector3(5f, 0f, 1f);
    private Vector3 _enemySpawnA = new Vector3(-6f, 0f, 12f);
    private Vector3 _enemySpawnB = new Vector3(6f, 0f, 12f);
    private Vector3 _bossSpawnPos = new Vector3(4f, 0f, 14f);

    // Colors
    private Color _colGround = new Color(0.35f, 0.25f, 0.15f);
    private Color _colPlayer = new Color(0.2f, 0.4f, 0.9f);
    private Color _colBuilding = new Color(0.85f, 0.7f, 0.4f);
    private Color _colEnemy = new Color(0.85f, 0.15f, 0.15f);
    private Color _colTurret = new Color(0.5f, 0.5f, 0.55f);
    private Color _colWood = new Color(0.6f, 0.35f, 0.1f);
    private Color _colTree = new Color(0.1f, 0.55f, 0.1f);
    private Color _colTreeTrunk = new Color(0.45f, 0.25f, 0.1f);
    private Color _colWorker = new Color(0.9f, 0.6f, 0.2f);
    private Color _colGold = new Color(1f, 0.85f, 0f);
    private Color _colGray = new Color(0.4f, 0.4f, 0.4f);
    private Color _colCastle = new Color(0.7f, 0.7f, 0.75f);
    private Color _colConveyor = new Color(0.3f, 0.3f, 0.35f);

    // Carried wood visuals
    private GameObject[] _carriedWood;
    private int _carriedWoodCount = 0;
    private int _maxCarriedWood = 5;

    // Gold coins on ground
    private GameObject[] _goldCoins;
    private int _goldCoinCount = 0;
    private int _maxGoldCoins = 10;

    // Shot 6 sub-states
    private bool _shot6CrossbowBuilt = false;
    private bool _shot6HouseBuilt = false;
    private bool _shot6WorkerRecruited = false;

    // Shot 7
    private int _shot7EnemiesSpawned = 0;
    private int _shot7EnemiesKilled = 0;
    private float _shot7Timer = 0f;

    // Shot 8
    private bool _bossDefeated = false;

    // Joystick UI
    private GameObject _joystickBg;
    private GameObject _joystickKnob;
    private RectTransform _joystickBgRect;
    private RectTransform _joystickKnobRect;

    // Enemy HP tracking
    private float[] _enemyHP;

    // Second wave enemies
    private bool _secondRouteActive = false;

    // Progress bar canvas ref
    private Canvas _progressCanvas;

    void Awake()
    {
        instance = this;
    }

    void Start()
    {
        // Clean scene
        foreach (var root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects())
        {
            if (root.name == "Main Camera" || root.name == "Directional Light" ||
                root.name == "EventSystem" || root.name == "GameManager" ||
                root.name.StartsWith("__")) continue;
            Destroy(root);
        }

        // Init GFM
        GFM_Create.InitMaterialFromScene();
        GFM_Create.ResetPool();

        // Camera setup
        _mainCam = Camera.main;
        if (_mainCam == null)
        {
            var camObj = GameObject.Find("Main Camera");
            if (camObj != null) _mainCam = camObj.GetComponent<Camera>();
        }
        if (_mainCam != null)
        {
            _mainCam.backgroundColor = new Color(0.6f, 0.8f, 1f);
            _mainCam.orthographic = true;
            _mainCam.orthographicSize = 10f;
            _mainCam.transform.position = new Vector3(0f, 15f, -8f);
            _mainCam.transform.rotation = Quaternion.Euler(55f, 0f, 0f);
        }

        // Init arrays
        _enemies = new GameObject[_maxEnemies];
        _enemyHP = new float[_maxEnemies];
        _woodLogs = new GameObject[_maxWoodLogs];
        _arrows = new GameObject[_maxArrows];
        _arrowTargets = new Vector3[_maxArrows];
        _arrowTimers = new float[_maxArrows];
        _carriedWood = new GameObject[_maxCarriedWood];
        _goldCoins = new GameObject[_maxGoldCoins];

        // Create ground
        _ground = GFM_Create.Ground(30f, 30f);
        GFM_Create.SetColor(_ground, _colGround);

        // Create base building
        _base = GFM_Create.Obj(PrimitiveType.Cube, _basePos + new Vector3(0f, 1f, 0f), new Vector3(3f, 2f, 3f), "Base");
        GFM_Create.SetColor(_base, _colBuilding);
        AddLabel(_base, "Base");

        // Create player
        _player = GFM_Create.Obj(PrimitiveType.Cube, _playerStartPos + new Vector3(0f, 0.75f, 0f), new Vector3(0.8f, 1.5f, 0.8f), "Player");
        GFM_Create.SetColor(_player, _colPlayer);
        AddLabel(_player, "Player");

        // Create fences
        _fenceN = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, 0.3f, 4f), new Vector3(12f, 0.6f, 0.3f), "FenceN");
        GFM_Create.SetColor(_fenceN, _colWood);
        _fenceS = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, 0.3f, -6f), new Vector3(12f, 0.6f, 0.3f), "FenceS");
        GFM_Create.SetColor(_fenceS, _colWood);
        _fenceE = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(6f, 0.3f, -1f), new Vector3(0.3f, 0.6f, 10f), "FenceE");
        GFM_Create.SetColor(_fenceE, _colWood);
        _fenceW = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(-6f, 0.3f, -1f), new Vector3(0.3f, 0.6f, 10f), "FenceW");
        GFM_Create.SetColor(_fenceW, _colWood);

        // Create trees
        _treeL1 = CreateTree(new Vector3(-8f, 0f, 2f), "TreeL1");
        _treeL2 = CreateTree(new Vector3(-9f, 0f, -1f), "TreeL2");
        _treeR1 = CreateTree(new Vector3(8f, 0f, 2f), "TreeR1");
        _treeR2 = CreateTree(new Vector3(9f, 0f, -1f), "TreeR2");

        // Generator
        _generator = GFM_Create.Obj(PrimitiveType.Cube, _generatorPos + new Vector3(0f, 1f, 0f), new Vector3(2f, 2f, 2f), "Generator");
        GFM_Create.SetColor(_generator, _colGray);
        AddLabel(_generator, "Generator");

        // Conveyor blueprint (gray, unlockable)
        _conveyorBlueprint = GFM_Create.Obj(PrimitiveType.Cube, _conveyorPos + new Vector3(0f, 0.2f, 0f), new Vector3(4f, 0.4f, 1f), "ConveyorBlue");
        GFM_Create.SetColor(_conveyorBlueprint, _colGray);
        AddLabel(_conveyorBlueprint, "Conveyor");

        // Conveyor (hidden initially)
        _conveyor = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(4f, 0.4f, 1f), "Conveyor");
        GFM_Create.SetColor(_conveyor, _colConveyor);

        // Crossbow Left (gray, inactive)
        _crossbowL = GFM_Create.Obj(PrimitiveType.Cube, _crossbowLPos + new Vector3(0f, 0.75f, 0f), new Vector3(1.2f, 1.5f, 1.2f), "CrossbowL");
        GFM_Create.SetColor(_crossbowL, _colGray);
        AddLabel(_crossbowL, "Crossbow");

        // Crossbow Right (hidden initially)
        _crossbowR = GFM_Create.Obj(PrimitiveType.Cube, _crossbowRPos + new Vector3(0f, 0.75f, 0f), new Vector3(1.2f, 1.5f, 1.2f), "CrossbowR");
        GFM_Create.SetColor(_crossbowR, _colGray);
        _crossbowR.transform.position = new Vector3(_crossbowRPos.x, -9999f, _crossbowRPos.z);

        // Wooden house left (gray, unbuilt)
        _woodenHouseL = GFM_Create.Obj(PrimitiveType.Cube, _houseLeftPos + new Vector3(0f, 1f, 0f), new Vector3(2.5f, 2f, 2.5f), "HouseL");
        GFM_Create.SetColor(_woodenHouseL, _colGray);
        _woodenHouseL.transform.position = new Vector3(_houseLeftPos.x, -9999f, _houseLeftPos.z);

        // Wooden house right (hidden)
        _woodenHouseR = GFM_Create.Obj(PrimitiveType.Cube, _houseRightPos + new Vector3(0f, 1f, 0f), new Vector3(2.5f, 2f, 2.5f), "HouseR");
        GFM_Create.SetColor(_woodenHouseR, _colGray);
        _woodenHouseR.transform.position = new Vector3(_houseRightPos.x, -9999f, _houseRightPos.z);

        // Guide arrow
        _guideArrow = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.6f, 1.2f, 0.6f), "GuideArrow");
        GFM_Create.SetColor(_guideArrow, _colGold);

        // Workers (hidden)
        _workerL = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.7f, 1.3f, 0.7f), "WorkerL");
        GFM_Create.SetColor(_workerL, _colWorker);
        _workerR = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.7f, 1.3f, 0.7f), "WorkerR");
        GFM_Create.SetColor(_workerR, _colWorker);

        // Boss (hidden)
        _boss = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(2.5f, 3f, 2.5f), "Boss");
        GFM_Create.SetColor(_boss, _colEnemy);

        // Castle (hidden)
        _castle = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(4f, 3f, 4f), "Castle");
        GFM_Create.SetColor(_castle, _colCastle);

        // Stone walls (hidden)
        _stoneWallN = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(14f, 1.2f, 0.5f), "StoneN");
        GFM_Create.SetColor(_stoneWallN, _colCastle);
        _stoneWallS = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(14f, 1.2f, 0.5f), "StoneS");
        GFM_Create.SetColor(_stoneWallS, _colCastle);
        _stoneWallE = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.5f, 1.2f, 12f), "StoneE");
        GFM_Create.SetColor(_stoneWallE, _colCastle);
        _stoneWallW = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.5f, 1.2f, 12f), "StoneW");
        GFM_Create.SetColor(_stoneWallW, _colCastle);

        // Pre-create carried wood visuals
        for (int i = 0; i < _maxCarriedWood; i++)
        {
            _carriedWood[i] = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.3f, 0.3f, 0.6f), "CWood" + i);
            GFM_Create.SetColor(_carriedWood[i], _colWood);
        }

        // Pre-create gold coins
        for (int i = 0; i < _maxGoldCoins; i++)
        {
            _goldCoins[i] = GFM_Create.Obj(PrimitiveType.Sphere, new Vector3(0f, -9999f, 0f), new Vector3(0.4f, 0.4f, 0.4f), "Gold" + i);
            GFM_Create.SetColor(_goldCoins[i], _colGold);
        }

        // Pre-create enemies
        for (int i = 0; i < _maxEnemies; i++)
        {
            _enemies[i] = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.8f, 1.4f, 0.8f), "Enemy" + i);
            GFM_Create.SetColor(_enemies[i], _colEnemy);
            _enemyHP[i] = 0f;
        }

        // Pre-create arrows
        for (int i = 0; i < _maxArrows; i++)
        {
            _arrows[i] = GFM_Create.Obj(PrimitiveType.Cube, new Vector3(0f, -9999f, 0f), new Vector3(0.1f, 0.1f, 0.8f), "Arrow" + i);
            GFM_Create.SetColor(_arrows[i], new Color(0.9f, 0.85f, 0.6f));
            _arrowTimers[i] = -1f;
        }

        // Wood logs for conveyor
        for (int i = 0; i < _maxWoodLogs; i++)
        {
            _woodLogs[i] = GFM_Create.Obj(PrimitiveType.Cylinder, new Vector3(0f, -9999f, 0f), new Vector3(0.3f, 0.15f, 0.3f), "WLog" + i);
            GFM_Create.SetColor(_woodLogs[i], _colWood);
        }

        // Create UI canvas
        _mainCanvas = GFM_UI.CreateCanvas(1080, 1920);

        // Resource text
        _resourceText = GFM_UI.CreateText(_mainCanvas, "Gold: 1  Wood: 0", new Vector2(350, 900), 28);
        _resourceText.alignment = TextAnchor.UpperRight;

        // Guide text
        _guideText = GFM_UI.CreateText(_mainCanvas, "", new Vector2(0, 750), 32);

        // Progress bar
        _progressBar = GFM_UI.CreateProgressBar(_mainCanvas, new Vector2(0, -300), new Vector2(300, 30), _colGold);
        _progressBarObj = _progressBar.gameObject;
        _progressBarObj.SetActive(false);

        // Joystick
        CreateJoystickUI();

        // Luna mute
        Luna.Unity.LifeCycle.OnMute += OnMute;
        Luna.Unity.LifeCycle.OnUnmute += OnUnmute;

        // Start shot 1
        _currentShot = 1;
        _shotState = 0;
        _shotTimer = 0f;

        shot_1();
    }

    void OnMute()
    {
        AudioListener.volume = 0;
    }

    void OnUnmute()
    {
        AudioListener.volume = 1;
    }

    private GameObject CreateTree(Vector3 pos, string label)
    {
        var trunk = GFM_Create.Obj(PrimitiveType.Cylinder, pos + new Vector3(0f, 1.5f, 0f), new Vector3(0.4f, 1.5f, 0.4f), label + "T");
        GFM_Create.SetColor(trunk, _colTreeTrunk);
        var crown = GFM_Create.Obj(PrimitiveType.Sphere, pos + new Vector3(0f, 3.5f, 0f), new Vector3(2f, 2f, 2f), label + "C");
        GFM_Create.SetColor(crown, _colTree);
        return trunk;
    }

    private void CreateJoystickUI()
    {
        _joystickBg = new GameObject("JoyBg");
        _joystickBg.transform.SetParent(_mainCanvas.transform, false);
        var bgImg = _joystickBg.AddComponent<Image>();
        bgImg.color = new Color(1f, 1f, 1f, 0.3f);
        _joystickBgRect = _joystickBg.GetComponent<RectTransform>();
        _joystickBgRect.sizeDelta = new Vector2(200, 200);
        _joystickBgRect.anchorMin = new Vector2(0, 0);
        _joystickBgRect.anchorMax = new Vector2(0, 0);
        _joystickBgRect.pivot = new Vector2(0.5f, 0.5f);
        _joystickBgRect.anchoredPosition = new Vector2(200, 250);
        _joystickBg.SetActive(false);

        _joystickKnob = new GameObject("JoyKnob");
        _joystickKnob.transform.SetParent(_joystickBg.transform, false);
        var knobImg = _joystickKnob.AddComponent<Image>();
        knobImg.color = new Color(1f, 1f, 1f, 0.6f);
        _joystickKnobRect = _joystickKnob.GetComponent<RectTransform>();
        _joystickKnobRect.sizeDelta = new Vector2(80, 80);
        _joystickKnobRect.anchoredPosition = Vector2.zero;
    }

    private void AddLabel(GameObject target, string text)
    {
        GFM_UI.AddWorldLabel(target, text, 1.8f);
    }

    private void UpdateResourceText()
    {
        if (_resourceText != null)
        {
            _resourceText.text = "Gold: " + _playerGold + "  Wood: " + _playerWood;
        }
    }

    private void ShowGuideArrow(Vector3 targetPos)
    {
        if (_guideArrow != null)
        {
            _guideArrow.transform.position = targetPos + new Vector3(0f, 3f, 0f);
            _guideArrow.transform.DOKill();
            _guideArrow.transform.DOLocalMoveY(targetPos.y + 3.5f, 0.5f).SetLoops(-1, LoopType.Yoyo);
        }
    }

    private void HideGuideArrow()
    {
        if (_guideArrow != null)
        {
            _guideArrow.transform.DOKill();
            _guideArrow.transform.position = new Vector3(0f, -9999f, 0f);
        }
    }

    private void ShowProgressBar(float duration)
    {
        if (_progressBar != null)
        {
            _progressBarObj.SetActive(true);
            _progressBar.value = 0f;
            DOTween.To(
                delegate() { return _progressBar.value; },
                delegate(float x) { _progressBar.value = x; },
                1f, duration
            ).OnComplete(delegate() { _progressBarObj.SetActive(false); });
        }
    }

    private void MoveTowards(GameObject obj, Vector3 target, float speed)
    {
        Vector3 dir = target - obj.transform.position;
        dir.y = 0;
        if (dir.magnitude > 0.2f)
        {
            obj.transform.position += dir.normalized * speed * Time.deltaTime;
            obj.transform.forward = dir.normalized;
        }
    }

    private Vector3 PlayerGroundPos()
    {
        Vector3 p = _player.transform.position;
        p.y = 0f;
        return p;
    }

    private void UpdateCarriedWood()
    {
        int showCount = Mathf.Min(_playerWood, _maxCarriedWood);
        for (int i = 0; i < _maxCarriedWood; i++)
        {
            if (i < showCount)
            {
                Vector3 backOff = -_player.transform.forward * 0.6f;
                _carriedWood[i].transform.position = _player.transform.position + backOff + new Vector3(0f, 0.5f + i * 0.35f, 0f);
            }
            else
            {
                _carriedWood[i].transform.position = new Vector3(0f, -9999f, 0f);
            }
        }
    }

    private void HideAllCarriedWood()
    {
        for (int i = 0; i < _maxCarriedWood; i++)
        {
            _carriedWood[i].transform.position = new Vector3(0f, -9999f, 0f);
        }
    }

    private void SpawnGoldCoin(Vector3 pos)
    {
        for (int i = 0; i < _maxGoldCoins; i++)
        {
            if (_goldCoins[i].transform.position.y < -9000f)
            {
                _goldCoins[i].transform.position = pos + new Vector3(0f, 0.3f, 0f);
                _goldCoins[i].transform.DOKill();
                _goldCoins[i].transform.DOJump(pos + new Vector3(Random.Range(-1f, 1f), 0f, Random.Range(-1f, 1f)), 1f, 1, 0.5f);
                return;
            }
        }
    }

    private void CollectNearbyGold()
    {
        Vector3 pp = PlayerGroundPos();
        for (int i = 0; i < _maxGoldCoins; i++)
        {
            if (_goldCoins[i].transform.position.y > -9000f)
            {
                Vector3 gp = _goldCoins[i].transform.position;
                gp.y = 0f;
                if (Vector3.Distance(pp, gp) < 1.5f)
                {
                    _goldCoins[i].transform.DOKill();
                    _goldCoins[i].transform.position = new Vector3(0f, -9999f, 0f);
                    _playerGold++;
                    UpdateResourceText();
                }
            }
        }
    }

    private void CollectNearbyWood()
    {
        Vector3 pp = PlayerGroundPos();
        for (int i = 0; i < _maxWoodLogs; i++)
        {
            if (_woodLogs[i].transform.position.y > -9000f)
            {
                Vector3 wp = _woodLogs[i].transform.position;
                wp.y = 0f;
                if (Vector3.Distance(pp, wp) < 1.5f)
                {
                    _woodLogs[i].transform.position = new Vector3(0f, -9999f, 0f);
                    _playerWood += 2;
                    UpdateResourceText();
                }
            }
        }
    }

    private void SpawnWoodOnConveyor()
    {
        for (int i = 0; i < _maxWoodLogs; i++)
        {
            if (_woodLogs[i].transform.position.y < -9000f)
            {
                _woodLogs[i].transform.position = _conveyorPos + new Vector3(-2f, 0.4f, 0f);
                return;
            }
        }
    }

    private void UpdateConveyor()
    {
        if (!_conveyorRunning) return;
        _woodSpawnTimer += Time.deltaTime;
        if (_woodSpawnTimer >= 1f)
        {
            _woodSpawnTimer = 0f;
            SpawnWoodOnConveyor();
        }
        // Move logs along conveyor
        for (int i = 0; i < _maxWoodLogs; i++)
        {
            if (_woodLogs[i].transform.position.y > -9000f)
            {
                Vector3 p = _woodLogs[i].transform.position;
                p.x += 1f * Time.deltaTime;
                if (p.x > _conveyorPos.x + 2.5f)
                {
                    p.x = _conveyorPos.x + 2.5f; // pile at end
                }
                _woodLogs[i].transform.position = p;
            }
        }
    }

    private int FindClosestEnemy(Vector3 from, float range)
    {
        int closest = -1;
        float closestDist = range;
        for (int i = 0; i < _maxEnemies; i++)
        {
            if (_enemyHP[i] > 0f && _enemies[i].transform.position.y > -9000f)
            {
                float d = Vector3.Distance(from, _enemies[i].transform.position);
                if (d < closestDist)
                {
                    closestDist = d;
                    closest = i;
                }
            }
        }
        return closest;
    }

    private void FireArrow(Vector3 from, Vector3 to)
    {
        for (int i = 0; i < _maxArrows; i++)
        {
            if (_arrowTimers[i] < 0f)
            {
                _arrows[i].transform.position = from + new Vector3(0f, 1.5f, 0f);
                _arrowTargets[i] = to + new Vector3(0f, 0.7f, 0f);
                _arrowTimers[i] = 0f;
                Vector3 dir = _arrowTargets[i] - _arrows[i].transform.position;
                if (dir.magnitude > 0.1f) _arrows[i].transform.forward = dir.normalized;
                return;
            }
        }
    }

    private void UpdateArrows()
    {
        for (int i = 0; i < _maxArrows; i++)
        {
            if (_arrowTimers[i] >= 0f)
            {
                _arrowTimers[i] += Time.deltaTime;
                Vector3 dir = _arrowTargets[i] - _arrows[i].transform.position;
                if (dir.magnitude < 0.5f || _arrowTimers[i] > 1f)
                {
                    _arrows[i].transform.position = new Vector3(0f, -9999f, 0f);
                    _arrowTimers[i] = -1f;
                    // Damage enemy near target
                    for (int e = 0; e < _maxEnemies; e++)
                    {
                        if (_enemyHP[e] > 0f)
                        {
                            float d = Vector3.Distance(_arrowTargets[i], _enemies[e].transform.position);
                            if (d < 1.5f)
                            {
                                _enemyHP[e] -= _crossbowDamage;
                                if (_enemyHP[e] <= 0f)
                                {
                                    SpawnGoldCoin(_enemies[e].transform.position);
                                    _enemies[e].transform.position = new Vector3(0f, -9999f, 0f);
                                    _enemiesKilled++;
                                    _shot7EnemiesKilled++;
                                }
                                break;
                            }
                        }
                    }
                }
                else
                {
                    _arrows[i].transform.position += dir.normalized * 15f * Time.deltaTime;
                }
            }
        }
    }

    private void UpdateCrossbows()
    {
        if (_crossbowLActive)
        {
            _crossbowLTimer += Time.deltaTime;
            if (_crossbowLTimer >= 1f / _crossbowAttackSpeed)
            {
                _crossbowLTimer = 0f;
                int e = FindClosestEnemy(_crossbowLPos, _crossbowRange);
                if (e >= 0) FireArrow(_crossbowLPos, _enemies[e].transform.position);
            }
        }
        if (_crossbowRActive)
        {
            _crossbowRTimer += Time.deltaTime;
            if (_crossbowRTimer >= 1f / _crossbowAttackSpeed)
            {
                _crossbowRTimer = 0f;
                int e = FindClosestEnemy(_crossbowRPos, _crossbowRange);
                if (e >= 0) FireArrow(_crossbowRPos, _enemies[e].transform.position);
            }
        }
    }

    private void SpawnEnemy(Vector3 from)
    {
        for (int i = 0; i < _maxEnemies; i++)
        {
            if (_enemyHP[i] <= 0f && _enemies[i].transform.position.y < -9000f)
            {
                _enemies[i].transform.position = from + new Vector3(0f, 0.7f, 0f);
                _enemyHP[i] = 1f;
                _enemiesSpawned++;
                _shot7EnemiesSpawned++;
                return;
            }
        }
    }

    private void UpdateEnemyMovement()
    {
        for (int i = 0; i < _maxEnemies; i++)
        {
            if (_enemyHP[i] > 0f && _enemies[i].transform.position.y > -9000f)
            {
                MoveTowards(_enemies[i], _basePos + new Vector3(0f, 0.7f, 0f), _playerSpeed * 0.5f);
            }
        }
    }

    private void UpdateBoss()
    {
        if (_boss.transform.position.y < -9000f) return;
        if (_bossHP <= 0f) return;

        MoveTowards(_boss, _basePos + new Vector3(0f, 1.5f, 0f), _playerSpeed * 0.3f);

        // Boss attacks base
        _bossAttackTimer += Time.deltaTime;
        if (_bossAttackTimer >= 2f)
        {
            _bossAttackTimer = 0f;
            float dist = Vector3.Distance(_boss.transform.position, _basePos);
            if (dist < 5f)
            {
                _baseHP -= 5f;
                if (_baseHP < 0f) _baseHP = 0f;
                if (_baseHPBar != null) _baseHPBar.value = _baseHP / _baseMaxHP;
                // Flash base red
                GFM_Create.SetColor(_base, _colEnemy);
                DOTween.Sequence()
                    .AppendInterval(0.2f)
                    .AppendCallback(delegate() { GFM_Create.SetColor(_base, _colBuilding); });
            }
        }

        // All crossbows attack boss
        if (_crossbowLActive)
        {
            _crossbowLTimer += Time.deltaTime;
            if (_crossbowLTimer >= 0.3f)
            {
                _crossbowLTimer = 0f;
                FireArrow(_crossbowLPos, _boss.transform.position);
            }
        }
    }

    private void CheckBossArrowHit()
    {
        if (_boss.transform.position.y < -9000f) return;
        if (_bossHP <= 0f) return;
        for (int i = 0; i < _maxArrows; i++)
        {
            if (_arrowTimers[i] >= 0f)
            {
                float d = Vector3.Distance(_arrows[i].transform.position, _boss.transform.position);
                if (d < 2f)
                {
                    _bossHP -= _crossbowDamage;
                    _arrows[i].transform.position = new Vector3(0f, -9999f, 0f);
                    _arrowTimers[i] = -1f;
                    if (_bossHPBar != null) _bossHPBar.value = _bossHP / _bossMaxHP;
                }
            }
        }
    }

    // =========== JOYSTICK INPUT ===========
    private void HandleJoystickInput()
    {
        if (Input.GetMouseButtonDown(0))
        {
            Vector3 mousePos = Input.mousePosition;
            if (mousePos.x < Screen.width * 0.5f)
            {
                _joystickActive = true;
                _joystickStart = new Vector2(mousePos.x, mousePos.y);
                _joystickBg.SetActive(true);
                // Convert screen to canvas local
                Vector2 canvasPos;
                RectTransformUtility.ScreenPointToLocalPointInRectangle(
                    _mainCanvas.GetComponent<RectTransform>(), mousePos, _mainCanvas.worldCamera, out canvasPos);
                _joystickBgRect.anchoredPosition = canvasPos;
                _joystickKnobRect.anchoredPosition = Vector2.zero;
            }
        }

        if (Input.GetMouseButton(0) && _joystickActive)
        {
            Vector2 mousePos = new Vector2(Input.mousePosition.x, Input.mousePosition.y);
            Vector2 delta = mousePos - _joystickStart;
            float maxRadius = 100f;
            if (delta.magnitude > maxRadius) delta = delta.normalized * maxRadius;
            _joystickDir = delta / maxRadius;
            _joystickKnobRect.anchoredPosition = delta;
        }

        if (Input.GetMouseButtonUp(0))
        {
            _joystickActive = false;
            _joystickDir = Vector2.zero;
            _joystickBg.SetActive(false);
            _joystickKnobRect.anchoredPosition = Vector2.zero;
        }
    }

    private void MovePlayerByJoystick()
    {
        if (_player == null) return;
        if (_joystickDir.magnitude > 0.1f)
        {
            Vector3 camForward = _mainCam.transform.forward;
            camForward.y = 0;
            camForward.Normalize();
            Vector3 camRight = _mainCam.transform.right;
            camRight.y = 0;
            camRight.Normalize();

            Vector3 move = camRight * _joystickDir.x + camForward * _joystickDir.y;
            move.y = 0;
            move.Normalize();

            _player.transform.position += move * _playerSpeed * Time.deltaTime;
            _player.transform.forward = move;
        }
    }

    private void HandleAutoPlay()
    {
        if (_joystickDir.magnitude < 0.1f && _guideArrow != null && _player != null && _guideArrow.transform.position.y > -9000f)
        {
            _autoPlayTimer += Time.deltaTime;
            if (_autoPlayTimer > _autoPlayDelay)
            {
                Vector3 targetGround = _guideArrow.transform.position;
                targetGround.y = 0f;
                Vector3 dir = targetGround - PlayerGroundPos();
                dir.y = 0;
                if (dir.magnitude > 1f)
                {
                    _player.transform.position += dir.normalized * _playerSpeed * Time.deltaTime;
                    _player.transform.forward = dir.normalized;
                }
            }
        }
        else
        {
            _autoPlayTimer = 0f;
        }
    }

    // =========== UPDATE ===========
    void Update()
    {
        _shotTimer += Time.deltaTime;

        HandleJoystickInput();

        switch (_currentShot)
        {
            case 1: UpdateShot1(); break;
            case 2: UpdateShot2(); break;
            case 3: UpdateShot3(); break;
            case 4: UpdateShot4(); break;
            case 5: UpdateShot5(); break;
            case 6: UpdateShot6(); break;
            case 7: UpdateShot7(); break;
            case 8: UpdateShot8(); break;
            case 9: UpdateShot9(); break;
            case 10: UpdateShot10(); break;
        }

        UpdateArrows();

        if (_currentShot >= 2)
        {
            UpdateConveyor();
            CollectNearbyWood();
            CollectNearbyGold();
            UpdateCarriedWood();
        }

        HandleAutoPlay();
    }

    // =========== SHOT 1: Unlock Conveyor Belt ===========
    void shot_1()
    {
        _currentShot = 1;
        _shotState = 0;
        _shotTimer = 0f;
        _playerGold = 1;
        _playerWood = 0;
        UpdateResourceText();

        // Show guide
        _currentTarget = _conveyorBlueprint;
        ShowGuideArrow(_conveyorPos);
        _guideText.text = "Move to conveyor and build it!";
    }

    void UpdateShot1()
    {
        MovePlayerByJoystick();

        switch (_shotState)
        {
            case 0:
                // Wait for player to reach conveyor blueprint
                float dist = Vector3.Distance(PlayerGroundPos(), _conveyorPos);
                if (dist < 2f && _playerGold >= 1)
                {
                    _playerGold -= 1;
                    UpdateResourceText();
                    _shotState = 1;
                    _shotTimer = 0f;
                    // Show progress bar
                    ShowProgressBar(1.5f);
                    _guideText.text = "Building conveyor...";
                    HideGuideArrow();
                }
                break;
            case 1:
                // Building animation
                if (_shotTimer > 1.5f)
                {
                    // Replace blueprint with active conveyor
                    _conveyorBlueprint.transform.position = new Vector3(0f, -9999f, 0f);
                    _conveyor.transform.position = _conveyorPos + new Vector3(0f, 0.2f, 0f);
                    GFM_Create.SetColor(_conveyor, _colConveyor);
                    AddLabel(_conveyor, "Conveyor");
                    // Pop animation
                    _conveyor.transform.localScale = new Vector3(0.1f, 0.1f, 0.1f);
                    _conveyor.transform.DOScale(new Vector3(4f, 0.4f, 1f), 0.5f).SetEase(Ease.OutBack);
                    _guideText.text = "Conveyor built!";
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2:
                if (_shotTimer > 1f)
                {
                    // Transition to shot 2
                    _conveyorRunning = true;
                    shot_2();
                }
                break;
        }
    }

    // =========== SHOT 2: Activate Crossbow ===========
    void shot_2()
    {
        _currentShot = 2;
        _shotState = 0;
        _shotTimer = 0f;
        _enemiesSpawned = 0;
        _enemiesKilled = 0;
        _enemiesActive = true;

        _guideText.text = "Collect wood from conveyor, bring to crossbow!";
        ShowGuideArrow(_conveyorPos);
        _currentTarget = _conveyor;
    }

    void UpdateShot2()
    {
        MovePlayerByJoystick();
        UpdateEnemyMovement();

        switch (_shotState)
        {
            case 0:
                // Spawn enemies
                _enemySpawnTimer += Time.deltaTime;
                if (_enemySpawnTimer >= 1f && _enemiesSpawned < 3)
                {
                    _enemySpawnTimer = 0f;
                    Vector3 spawnPos = (_enemiesSpawned % 2 == 0) ? _enemySpawnA : _enemySpawnB;
                    SpawnEnemy(spawnPos);
                }

                // Guide player to collect wood then to crossbow
                if (_playerWood < 3)
                {
                    ShowGuideArrow(_conveyorPos + new Vector3(2f, 0f, 0f));
                    _guideText.text = "Collect wood from conveyor!";
                }
                else
                {
                    ShowGuideArrow(_crossbowLPos);
                    _guideText.text = "Bring wood to crossbow!";
                    _currentTarget = _crossbowL;
                }

                // Check if player reached crossbow with wood
                float distCB = Vector3.Distance(PlayerGroundPos(), _crossbowLPos);
                if (distCB < 2f && _playerWood >= 3)
                {
                    _playerWood = 0;
                    UpdateResourceText();
                    HideAllCarriedWood();
                    _shotState = 1;
                    _shotTimer = 0f;
                    GFM_Create.SetColor(_crossbowL, _colTurret);
                    _crossbowLActive = true;
                    _crossbowRange = 5f;
                    _crossbowDamage = 1f;
                    _crossbowAttackSpeed = 1f;
                    _guideText.text = "Crossbow activated!";
                    HideGuideArrow();
                    // Pop animation
                    _crossbowL.transform.DOPunchScale(new Vector3(0.3f, 0.3f, 0.3f), 0.5f, 5, 0.5f);
                }
                break;
            case 1:
                // Crossbow shooting enemies
                UpdateCrossbows();

                // Check enemies killed
                bool allDead = true;
                for (int i = 0; i < _maxEnemies; i++)
                {
                    if (_enemyHP[i] > 0f) { allDead = false; break; }
                }
                if (allDead && _enemiesSpawned >= 3)
                {
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                else if (_shotTimer > 6f)
                {
                    // Force advance
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2:
                if (_shotTimer > 1f)
                {
                    shot_3();
                }
                break;
        }
    }

    // =========== SHOT 3: Build Wooden House ===========
    void shot_3()
    {
        _currentShot = 3;
        _shotState = 0;
        _shotTimer = 0f;

        // Show house blueprint
        _woodenHouseL.transform.position = _houseLeftPos + new Vector3(0f, 1f, 0f);
        GFM_Create.SetColor(_woodenHouseL, _colGray);
        AddLabel(_woodenHouseL, "House");

        _guideText.text = "Collect 10 wood, bring to house blueprint!";
        ShowGuideArrow(_houseLeftPos);
        _currentTarget = _woodenHouseL;
    }

    void UpdateShot3()
    {
        MovePlayerByJoystick();
        UpdateCrossbows();
        UpdateEnemyMovement();

        // Continue spawning enemies
        if (_enemiesActive)
        {
            _enemySpawnTimer += Time.deltaTime;
            if (_enemySpawnTimer >= 3f && _enemiesSpawned < 6)
            {
                _enemySpawnTimer = 0f;
                SpawnEnemy(_enemySpawnA);
            }
        }

        switch (_shotState)
        {
            case 0:
                if (_playerWood < 10)
                {
                    ShowGuideArrow(_conveyorPos + new Vector3(2f, 0f, 0f));
                    _guideText.text = "Collect wood! (" + _playerWood + "/10)";
                    _currentTarget = _conveyor;
                }
                else
                {
                    ShowGuideArrow(_houseLeftPos);
                    _guideText.text = "Bring wood to house! (" + _playerWood + "/10)";
                    _currentTarget = _woodenHouseL;
                }

                float distH = Vector3.Distance(PlayerGroundPos(), _houseLeftPos);
                if (distH < 2f && _playerWood >= 10)
                {
                    _playerWood -= 10;
                    UpdateResourceText();
                    HideAllCarriedWood();
                    _shotState = 1;
                    _shotTimer = 0f;
                    ShowProgressBar(1.5f);
                    _guideText.text = "Building house...";
                    HideGuideArrow();
                }
                break;
            case 1:
                if (_shotTimer > 1.5f)
                {
                    GFM_Create.SetColor(_woodenHouseL, _colBuilding);
                    _woodenHouseL.transform.DOPunchScale(new Vector3(0.3f, 0.3f, 0.3f), 0.5f, 5, 0.5f);
                    _guideText.text = "House built!";
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2:
                if (_shotTimer > 1f)
                {
                    shot_4();
                }
                break;
        }
    }

    // =========== SHOT 4: Recruit Worker ===========
    void shot_4()
    {
        _currentShot = 4;
        _shotState = 0;
        _shotTimer = 0f;

        _guideText.text = "Collect 10 gold, recruit a worker at the house!";
        ShowGuideArrow(_houseLeftPos);
        _currentTarget = _woodenHouseL;
    }

    void UpdateShot4()
    {
        MovePlayerByJoystick();
        UpdateCrossbows();
        UpdateEnemyMovement();

        if (_enemiesActive)
        {
            _enemySpawnTimer += Time.deltaTime;
            if (_enemySpawnTimer >= 2f && _enemiesSpawned < 9)
            {
                _enemySpawnTimer = 0f;
                SpawnEnemy((_enemiesSpawned % 2 == 0) ? _enemySpawnA : _enemySpawnB);
            }
        }

        switch (_shotState)
        {
            case 0:
                if (_playerGold < 10)
                {
                    _guideText.text = "Collect gold! (" + _playerGold + "/10)";
                    // Guide to enemies or gold
                    int nearGold = -1;
                    float nearDist = 999f;
                    for (int i = 0; i < _maxGoldCoins; i++)
                    {
                        if (_goldCoins[i].transform.position.y > -9000f)
                        {
                            float d = Vector3.Distance(PlayerGroundPos(), _goldCoins[i].transform.position);
                            if (d < nearDist) { nearDist = d; nearGold = i; }
                        }
                    }
                    if (nearGold >= 0)
                    {
                        ShowGuideArrow(_goldCoins[nearGold].transform.position);
                        _currentTarget = _goldCoins[nearGold];
                    }
                    // Auto-give gold if stuck
                    if (_shotTimer > 8f)
                    {
                        _playerGold = 10;
                        UpdateResourceText();
                    }
                }
                else
                {
                    ShowGuideArrow(_houseLeftPos);
                    _guideText.text = "Go to house to recruit! (" + _playerGold + "/10)";
                    _currentTarget = _woodenHouseL;
                }

                float distR = Vector3.Distance(PlayerGroundPos(), _houseLeftPos);
                if (distR < 2f && _playerGold >= 10)
                {
                    _playerGold -= 10;
                    UpdateResourceText();
                    _shotState = 1;
                    _shotTimer = 0f;
                    _guideText.text = "Recruiting worker...";
                    HideGuideArrow();
                }
                break;
            case 1:
                if (_shotTimer > 1f)
                {
                    // Spawn worker
                    _workerL.transform.position = _houseLeftPos + new Vector3(0f, 0.65f, -1f);
                    AddLabel(_workerL, "Worker");
                    _workerL.transform.localScale = new Vector3(0.1f, 0.1f, 0.1f);
                    _workerL.transform.DOScale(new Vector3(0.7f, 1.3f, 0.7f), 0.5f).SetEase(Ease.OutBack);
                    _guideText.text = "Worker recruited!";
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2:
                if (_shotTimer > 1.5f)
                {
                    shot_5();
                }
                break;
        }
    }

    // =========== SHOT 5: Worker Auto-Carry ===========
    void shot_5()
    {
        _currentShot = 5;
        _shotState = 0;
        _shotTimer = 0f;
        _workerLState = 0;
        _workerLTimer = 0f;

        _guideText.text = "Watch the worker carry wood automatically!";
        HideGuideArrow();
    }

    void UpdateShot5()
    {
        UpdateCrossbows();
        UpdateEnemyMovement();

        if (_enemiesActive)
        {
            _enemySpawnTimer += Time.deltaTime;
            if (_enemySpawnTimer >= 3f)
            {
                _enemySpawnTimer = 0f;
                SpawnEnemy(_enemySpawnA);
                _enemiesSpawned++;
            }
        }

        // Worker L auto behavior
        UpdateWorkerL();

        switch (_shotState)
        {
            case 0:
                if (_workerLState >= 4 || _shotTimer > 8f)
                {
                    _shotState = 1;
                    _shotTimer = 0f;
                    _guideText.text = "Production automated!";
                }
                break;
            case 1:
                if (_shotTimer > 2f)
                {
                    shot_6();
                }
                break;
        }
    }

    private void UpdateWorkerL()
    {
        if (_workerL.transform.position.y < -9000f) return;
        _workerLTimer += Time.deltaTime;

        switch (_workerLState)
        {
            case 0: // Go to conveyor
                MoveTowards(_workerL, _conveyorPos + new Vector3(2f, 0.65f, 0f), _playerSpeed * 0.8f);
                if (Vector3.Distance(_workerL.transform.position, _conveyorPos + new Vector3(2f, 0.65f, 0f)) < 1f)
                {
                    _workerLState = 1;
                    _workerLTimer = 0f;
                }
                break;
            case 1: // Collect (wait a moment)
                if (_workerLTimer > 0.8f)
                {
                    _workerLState = 2;
                    _workerLTimer = 0f;
                }
                break;
            case 2: // Go to crossbow L
                MoveTowards(_workerL, _crossbowLPos + new Vector3(0f, 0.65f, 0f), _playerSpeed * 0.8f);
                if (Vector3.Distance(_workerL.transform.position, _crossbowLPos + new Vector3(0f, 0.65f, 0f)) < 1f)
                {
                    _workerLState = 3;
                    _workerLTimer = 0f;
                }
                break;
            case 3: // Deliver
                if (_workerLTimer > 0.5f)
                {
                    _workerLState = 4;
                    _workerLTimer = 0f;
                }
                break;
            case 4: // Loop back
                _workerLState = 0;
                break;
        }
    }

    private void UpdateWorkerR()
    {
        if (_workerR.transform.position.y < -9000f) return;
        _workerRTimer += Time.deltaTime;

        switch (_workerRState)
        {
            case 0:
                MoveTowards(_workerR, _conveyorPos + new Vector3(2f, 0.65f, 0f), _playerSpeed * 0.8f);
                if (Vector3.Distance(_workerR.transform.position, _conveyorPos + new Vector3(2f, 0.65f, 0f)) < 1f)
                {
                    _workerRState = 1;
                    _workerRTimer = 0f;
                }
                break;
            case 1:
                if (_workerRTimer > 0.8f)
                {
                    _workerRState = 2;
                    _workerRTimer = 0f;
                }
                break;
            case 2:
                MoveTowards(_workerR, _crossbowRPos + new Vector3(0f, 0.65f, 0f), _playerSpeed * 0.8f);
                if (Vector3.Distance(_workerR.transform.position, _crossbowRPos + new Vector3(0f, 0.65f, 0f)) < 1f)
                {
                    _workerRState = 3;
                    _workerRTimer = 0f;
                }
                break;
            case 3:
                if (_workerRTimer > 0.5f)
                {
                    _workerRState = 4;
                    _workerRTimer = 0f;
                }
                break;
            case 4:
                _workerRState = 0;
                break;
        }
    }

    // =========== SHOT 6: Build Right Crossbow + House + Worker ===========
    void shot_6()
    {
        _currentShot = 6;
        _shotState = 0;
        _shotTimer = 0f;
        _shot6CrossbowBuilt = false;
        _shot6HouseBuilt = false;
        _shot6WorkerRecruited = false;

        // Show right crossbow (gray)
        _crossbowR.transform.position = _crossbowRPos + new Vector3(0f, 0.75f, 0f);
        GFM_Create.SetColor(_crossbowR, _colGray);
        AddLabel(_crossbowR, "Crossbow R");

        _guideText.text = "Collect 100 wood, build right crossbow!";
        ShowGuideArrow(_crossbowRPos);
        _currentTarget = _crossbowR;

        // Give player some wood to start
        _playerWood = 50;
        UpdateResourceText();
    }

    void UpdateShot6()
    {
        MovePlayerByJoystick();
        UpdateCrossbows();
        UpdateEnemyMovement();
        UpdateWorkerL();

        if (_enemiesActive)
        {
            _enemySpawnTimer += Time.deltaTime;
            if (_enemySpawnTimer >= 2f)
            {
                _enemySpawnTimer = 0f;
                SpawnEnemy((_enemiesSpawned % 2 == 0) ? _enemySpawnA : _enemySpawnB);
            }
        }

        switch (_shotState)
        {
            case 0: // Build right crossbow
                if (_playerWood < 100)
                {
                    ShowGuideArrow(_conveyorPos + new Vector3(2f, 0f, 0f));
                    _guideText.text = "Collect wood! (" + _playerWood + "/100)";
                    _currentTarget = _conveyor;
                    // Auto-grant if taking too long
                    if (_shotTimer > 10f)
                    {
                        _playerWood = 100;
                        UpdateResourceText();
                    }
                }
                else
                {
                    ShowGuideArrow(_crossbowRPos);
                    _guideText.text = "Build crossbow! (" + _playerWood + "/100 wood)";
                    _currentTarget = _crossbowR;
                }

                float distCR = Vector3.Distance(PlayerGroundPos(), _crossbowRPos);
                if (distCR < 2f && _playerWood >= 100)
                {
                    _playerWood -= 100;
                    UpdateResourceText();
                    HideAllCarriedWood();
                    _shotState = 1;
                    _shotTimer = 0f;
                    ShowProgressBar(1.5f);
                    _guideText.text = "Building crossbow...";
                    HideGuideArrow();
                }
                break;
            case 1:
                if (_shotTimer > 1.5f)
                {
                    GFM_Create.SetColor(_crossbowR, _colTurret);
                    _crossbowR.transform.DOPunchScale(new Vector3(0.3f, 0.3f, 0.3f), 0.5f, 5, 0.5f);
                    _crossbowRActive = true;
                    _shot6CrossbowBuilt = true;
                    _guideText.text = "Right crossbow built!";
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2: // Show right house blueprint
                // Show house R
                _woodenHouseR.transform.position = _houseRightPos + new Vector3(0f, 1f, 0f);
                GFM_Create.SetColor(_woodenHouseR, _colGray);
                AddLabel(_woodenHouseR, "House R");

                _guideText.text = "Collect 10 wood, build right house!";
                ShowGuideArrow(_houseRightPos);
                _currentTarget = _woodenHouseR;
                _shotState = 3;
                _shotTimer = 0f;
                break;
            case 3: // Build right house
                if (_playerWood < 10)
                {
                    ShowGuideArrow(_conveyorPos + new Vector3(2f, 0f, 0f));
                    _guideText.text = "Collect wood! (" + _playerWood + "/10)";
                    _currentTarget = _conveyor;
                    if (_shotTimer > 8f)
                    {
                        _playerWood = 10;
                        UpdateResourceText();
                    }
                }
                else
                {
                    ShowGuideArrow(_houseRightPos);
                    _guideText.text = "Build house! (" + _playerWood + "/10 wood)";
                    _currentTarget = _woodenHouseR;
                }

                float distHR = Vector3.Distance(PlayerGroundPos(), _houseRightPos);
                if (distHR < 2f && _playerWood >= 10)
                {
                    _playerWood -= 10;
                    UpdateResourceText();
                    HideAllCarriedWood();
                    _shotState = 4;
                    _shotTimer = 0f;
                    ShowProgressBar(1.5f);
                    _guideText.text = "Building house...";
                    HideGuideArrow();
                }
                break;
            case 4:
                if (_shotTimer > 1.5f)
                {
                    GFM_Create.SetColor(_woodenHouseR, _colBuilding);
                    _woodenHouseR.transform.DOPunchScale(new Vector3(0.3f, 0.3f, 0.3f), 0.5f, 5, 0.5f);
                    _shot6HouseBuilt = true;
                    _guideText.text = "Right house built! Recruit a worker!";
                    _shotState = 5;
                    _shotTimer = 0f;
                    _playerGold = 10; // ensure enough
                    UpdateResourceText();
                }
                break;
            case 5: // Recruit worker R
                ShowGuideArrow(_houseRightPos);
                _guideText.text = "Go to house to recruit! (" + _playerGold + "/10 gold)";
                _currentTarget = _woodenHouseR;

                float distWR = Vector3.Distance(PlayerGroundPos(), _houseRightPos);
                if (distWR < 2f && _playerGold >= 10)
                {
                    _playerGold -= 10;
                    UpdateResourceText();
                    _shotState = 6;
                    _shotTimer = 0f;
                    _guideText.text = "Recruiting...";
                    HideGuideArrow();
                }
                // Auto if stuck
                if (_shotTimer > 8f)
                {
                    _playerGold = 10;
                    UpdateResourceText();
                }
                break;
            case 6:
                if (_shotTimer > 1f)
                {
                    _workerR.transform.position = _houseRightPos + new Vector3(0f, 0.65f, -1f);
                    AddLabel(_workerR, "Worker R");
                    _workerR.transform.localScale = new Vector3(0.1f, 0.1f, 0.1f);
                    _workerR.transform.DOScale(new Vector3(0.7f, 1.3f, 0.7f), 0.5f).SetEase(Ease.OutBack);
                    _workerRState = 0;
                    _shot6WorkerRecruited = true;
                    _secondRouteActive = true;
                    _guideText.text = "Worker recruited! Defense expanded!";
                    _shotState = 7;
                    _shotTimer = 0f;
                }
                break;
            case 7:
                if (_shotTimer > 2f)
                {
                    shot_7();
                }
                break;
        }
    }

    // =========== SHOT 7: Multi-line Defense ===========
    void shot_7()
    {
        _currentShot = 7;
        _shotState = 0;
        _shotTimer = 0f;
        _shot7EnemiesSpawned = 0;
        _shot7EnemiesKilled = 0;
        _shot7Timer = 0f;
        _crossbowDamage = 2f;
        _crossbowAttackSpeed = 2f;
        _crossbowRange = 6f;

        _guideText.text = "Dual crossbows defend against waves!";
        HideGuideArrow();
    }

    void UpdateShot7()
    {
        UpdateCrossbows();
        UpdateEnemyMovement();
        UpdateWorkerL();
        UpdateWorkerR();
        _shot7Timer += Time.deltaTime;

        // Spawn waves
        _enemySpawnTimer += Time.deltaTime;
        if (_enemySpawnTimer >= 0.8f && _shot7EnemiesSpawned < 8)
        {
            _enemySpawnTimer = 0f;
            Vector3 sp = (_shot7EnemiesSpawned % 2 == 0) ? _enemySpawnA : _enemySpawnB;
            SpawnEnemy(sp);
        }

        switch (_shotState)
        {
            case 0:
                // Show battle for 5 seconds
                if (_shot7Timer > 5f)
                {
                    _shotState = 1;
                    _shotTimer = 0f;
                    _guideText.text = "Defense holding strong!";
                }
                break;
            case 1:
                if (_shotTimer > 2f)
                {
                    shot_8();
                }
                break;
        }
    }

    // =========== SHOT 8: Boss Fight ===========
    void shot_8()
    {
        _currentShot = 8;
        _shotState = 0;
        _shotTimer = 0f;
        _bossHP = 50f;
        _bossMaxHP = 50f;
        _baseHP = 50f;
        _bossDefeated = false;
        _bossAttackTimer = 0f;
        _crossbowDamage = 3f;

        // Spawn boss
        _boss.transform.position = _bossSpawnPos + new Vector3(0f, 1.5f, 0f);
        AddLabel(_boss, "BOSS");

        // Boss HP bar
        _bossHPBar = GFM_UI.CreateProgressBar(_mainCanvas, new Vector2(0, 850), new Vector2(400, 25), _colEnemy);
        _bossHPBar.value = 1f;

        // Base HP bar
        _baseHPBar = GFM_UI.CreateProgressBar(_mainCanvas, new Vector2(0, -450), new Vector2(300, 20), _colBuilding);
        _baseHPBar.value = 1f;

        _guideText.text = "BOSS APPROACHING! Defend the base!";
        HideGuideArrow();

        // Kill remaining regular enemies
        for (int i = 0; i < _maxEnemies; i++)
        {
            if (_enemyHP[i] > 0f)
            {
                _enemyHP[i] = 0f;
                _enemies[i].transform.position = new Vector3(0f, -9999f, 0f);
            }
        }
    }

    void UpdateShot8()
    {
        UpdateWorkerL();
        UpdateWorkerR();

        if (_bossHP > 0f)
        {
            // Boss approaches
            MoveTowards(_boss, _basePos + new Vector3(0f, 1.5f, 0f), _playerSpeed * 0.3f);

            // Boss attacks base
            _bossAttackTimer += Time.deltaTime;
            float bossDist = Vector3.Distance(_boss.transform.position, _basePos + new Vector3(0f, 1.5f, 0f));
            if (_bossAttackTimer >= 2f && bossDist < 5f)
            {
                _bossAttackTimer = 0f;
                _baseHP -= 5f;
                if (_baseHP < 0f) _baseHP = 0f;
                if (_baseHPBar != null) _baseHPBar.value = _baseHP / _baseMaxHP;
                GFM_Create.SetColor(_base, _colEnemy);
                DOTween.Sequence()
                    .AppendInterval(0.2f)
                    .AppendCallback(delegate() { GFM_Create.SetColor(_base, _colBuilding); });
            }

            // Both crossbows fire at boss
            _crossbowLTimer += Time.deltaTime;
            if (_crossbowLTimer >= 0.3f && _crossbowLActive)
            {
                _crossbowLTimer = 0f;
                FireArrow(_crossbowLPos, _boss.transform.position);
            }
            _crossbowRTimer += Time.deltaTime;
            if (_crossbowRTimer >= 0.3f && _crossbowRActive)
            {
                _crossbowRTimer = 0f;
                FireArrow(_crossbowRPos, _boss.transform.position);
            }

            // Check arrow hits on boss
            for (int i = 0; i < _maxArrows; i++)
            {
                if (_arrowTimers[i] >= 0f && _arrows[i].transform.position.y > -9000f)
                {
                    float d = Vector3.Distance(_arrows[i].transform.position, _boss.transform.position);
                    if (d < 2.5f)
                    {
                        _bossHP -= _crossbowDamage;
                        _arrows[i].transform.position = new Vector3(0f, -9999f, 0f);
                        _arrowTimers[i] = -1f;
                        if (_bossHPBar != null) _bossHPBar.value = Mathf.Max(0f, _bossHP / _bossMaxHP);
                        // Flash boss
                        GFM_Create.SetColor(_boss, Color.white);
                        DOTween.Sequence()
                            .AppendInterval(0.1f)
                            .AppendCallback(delegate() { GFM_Create.SetColor(_boss, _colEnemy); });
                    }
                }
            }

            if (_bossHP <= 0f)
            {
                _bossDefeated = true;
                // Boss death animation
                _boss.transform.DOScale(new Vector3(0.1f, 0.1f, 0.1f), 1f).SetEase(Ease.InBack);
                _boss.transform.DOMove(new Vector3(_boss.transform.position.x, -2f, _boss.transform.position.z), 1f);
                _guideText.text = "BOSS DEFEATED!";
                _shotState = 1;
                _shotTimer = 0f;

                // Destroy HP bars
                if (_bossHPBar != null) _bossHPBar.gameObject.SetActive(false);
                if (_baseHPBar != null) _baseHPBar.gameObject.SetActive(false);
            }
        }

        switch (_shotState)
        {
            case 0:
                // Waiting for boss defeat — auto-accelerate if taking too long
                if (_shotTimer > 12f && _bossHP > 0f)
                {
                    _bossHP = 0f;
                    _bossDefeated = true;
                    _boss.transform.position = new Vector3(0f, -9999f, 0f);
                    _guideText.text = "BOSS DEFEATED!";
                    _shotState = 1;
                    _shotTimer = 0f;
                    if (_bossHPBar != null) _bossHPBar.gameObject.SetActive(false);
                    if (_baseHPBar != null) _baseHPBar.gameObject.SetActive(false);
                }
                break;
            case 1:
                if (_shotTimer > 2f)
                {
                    _boss.transform.position = new Vector3(0f, -9999f, 0f);
                    shot_9();
                }
                break;
        }
    }

    // =========== SHOT 9: Upgrade Base ===========
    void shot_9()
    {
        _currentShot = 9;
        _shotState = 0;
        _shotTimer = 0f;

        _playerGold = 200;
        UpdateResourceText();

        _guideText.text = "Move to base and upgrade! (200 gold)";
        ShowGuideArrow(_basePos);
        _currentTarget = _base;
    }

    void UpdateShot9()
    {
        MovePlayerByJoystick();

        switch (_shotState)
        {
            case 0:
                ShowGuideArrow(_basePos);
                _guideText.text = "Move to base to upgrade! (" + _playerGold + "/200 gold)";

                float dist = Vector3.Distance(PlayerGroundPos(), _basePos);
                if (dist < 2.5f && _playerGold >= 200)
                {
                    _playerGold -= 200;
                    UpdateResourceText();
                    _shotState = 1;
                    _shotTimer = 0f;
                    ShowProgressBar(2f);
                    _guideText.text = "Upgrading base...";
                    HideGuideArrow();
                }
                // Auto-grant if stuck
                if (_shotTimer > 8f && _playerGold < 200)
                {
                    _playerGold = 200;
                    UpdateResourceText();
                }
                break;
            case 1:
                if (_shotTimer > 2f)
                {
                    _guideText.text = "Base upgraded!";
                    _shotState = 2;
                    _shotTimer = 0f;
                }
                break;
            case 2:
                if (_shotTimer > 1f)
                {
                    shot_10();
                }
                break;
        }
    }

    // =========== SHOT 10: Castle Upgrade + CTA ===========
    void shot_10()
    {
        _currentShot = 10;
        _shotState = 0;
        _shotTimer = 0f;

        _guideText.text = "Base evolving into Castle!";
        HideGuideArrow();

        // Hide old base
        _base.transform.position = new Vector3(0f, -9999f, 0f);
        // Show castle
        _castle.transform.position = _basePos + new Vector3(0f, 1.5f, 0f);
        _castle.transform.localScale = new Vector3(0.1f, 0.1f, 0.1f);
        _castle.transform.DOScale(new Vector3(4f, 3f, 4f), 1.5f).SetEase(Ease.OutBack);
        AddLabel(_castle, "CASTLE");

        // Replace wood fences with stone walls
        _fenceN.transform.position = new Vector3(0f, -9999f, 0f);
        _fenceS.transform.position = new Vector3(0f, -9999f, 0f);
        _fenceE.transform.position = new Vector3(0f, -9999f, 0f);
        _fenceW.transform.position = new Vector3(0f, -9999f, 0f);

        _stoneWallN.transform.position = new Vector3(0f, 0.6f, 5f);
        _stoneWallS.transform.position = new Vector3(0f, 0.6f, -7f);
        _stoneWallE.transform.position = new Vector3(7f, 0.6f, -1f);
        _stoneWallW.transform.position = new Vector3(-7f, 0.6f, -1f);

        // Increase FOV
        if (_mainCam != null)
        {
            float currentSize = _mainCam.orthographicSize;
            DOTween.To(
                delegate() { return _mainCam.orthographicSize; },
                delegate(float x) { _mainCam.orthographicSize = x; },
                currentSize + 3f, 2f
            );
        }
    }

    void UpdateShot10()
    {
        switch (_shotState)
        {
            case 0:
                if (_shotTimer > 2f)
                {
                    _guideText.text = "Your kingdom is complete!";
                    _shotState = 1;
                    _shotTimer = 0f;
                }
                break;
            case 1:
                if (_shotTimer > 2f)
                {
                    _shotState = 2;
                    _shotTimer = 0f;
                    // Game ended
                    Luna.Unity.LifeCycle.GameEnded();

                    // CTA button
                    GFM_UI.CreateButton(_mainCanvas, "DOWNLOAD NOW!", new Vector2(0, -100), new Vector2(400, 100),
                        delegate()
                        {
                            Luna.Unity.Playable.InstallFullGame();
                        });
                    _guideText.text = "Download the full game!";
                }
                break;
            case 2:
                // Waiting for CTA click
                break;
        }
    }
}
