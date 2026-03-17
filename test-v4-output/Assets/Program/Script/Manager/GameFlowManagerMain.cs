using UnityEngine;
using UnityEngine.UI;

public class GameFlowManagerMain : MonoBehaviour
{
    // ============================
    // ENTITY INDEX CONSTANTS
    // ============================
    const int E_GROUND = 0;
    const int E_PLAYER = 1;
    const int E_BASE = 2;
    const int E_WOODFENCE_L = 3;
    const int E_WOODFENCE_R = 4;
    const int E_PINETREE_L = 5;
    const int E_PINETREE_R = 6;
    const int E_GENERATOR = 7;
    const int E_CONVEYOR = 8;
    const int E_CROSSBOW_L = 9;
    const int E_CROSSBOW_R = 10;
    const int E_ENEMY_SPAWNER = 11;
    const int E_WOODLOG_SPAWNER = 12;
    const int E_WOODHOUSE = 13;
    const int E_WORKER_SPAWNER = 14;
    const int E_TURRET = 15;
    const int E_BOSS = 16;
    const int E_CASTLEWALL = 17;
    const int E_HEALTHBAR = 18;

    // Pool starts
    const int ARROW_START = 19;
    const int ARROW_COUNT = 20;
    const int ENEMY_START = 39;
    const int ENEMY_COUNT = 10;
    const int GOLD_START = 49;
    const int GOLD_COUNT = 15;
    const int WOODLOG_START = 64;
    const int WOODLOG_COUNT = 6;
    const int WORKER_START = 70;
    const int WORKER_COUNT = 4;

    const int MAX_ENTITIES = 80;

    // ============================
    // PARALLEL ARRAYS
    // ============================
    GameObject[] eGo = new GameObject[MAX_ENTITIES];
    bool[] eActive = new bool[MAX_ENTITIES];
    int[] eState = new int[MAX_ENTITIES];
    float[] eTimer = new float[MAX_ENTITIES];
    float[] eHP = new float[MAX_ENTITIES];

    // Arrow extra data
    Vector3[] arrowTarget = new Vector3[ARROW_COUNT];
    int[] arrowDmg = new int[ARROW_COUNT];

    // Worker extra data
    int[] workerCarrying = new int[WORKER_COUNT]; // -1 = nothing, else woodlog idx
    int[] workerState2 = new int[WORKER_COUNT]; // 0=goToLog, 1=goToBase, 2=idle

    // ============================
    // GAME STATE
    // ============================
    int gold = 1;
    int wood = 0;
    int currentPhase = 0;
    int enemyKillCount = 0;
    int totalEnemyKillCount = 0;
    float moveSpeed = 5f;
    float autoPlayTimer = 0f;
    bool autoPlay = false;
    Vector3 autoTarget = Vector3.zero;
    bool gameEnded = false;
    int baseLevel = 1;
    float baseMaxHP = 50f;
    float enemySpawnInterval = 3f;

    // UI
    GameObject goldText;
    GameObject woodText;
    GameObject phaseText;
    GameObject hpBarBg;
    GameObject hpBarFill;
    GameObject buildProgressBar;
    GameObject ctaPanel;
    GameObject guideText;

    // Conveyor blueprint visual
    bool conveyorBlueprint = true;

    // Camera
    Camera mainCam;

    Vector3 camTargetPos;
    float camTargetSize = 8f;

    // Click detection
    bool wasMouseDown = false;

    void Start()
    {
        // Scene cleanup
        GameObject[] roots = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();
        for (int i = 0; i < roots.Length; i++)
        {
            string n = roots[i].name;
            if (n != "Main Camera" && n != "Directional Light" && n != "EventSystem" && n != "GameManager" && n != "__MaterialSource")
            {
                Destroy(roots[i]);
            }
        }

        GFM_Create.ResetPool();
        GFM_Create.InitMaterialFromScene();

        // Camera setup
        mainCam = Camera.main;
        if (mainCam != null)
        {
            mainCam.orthographic = true;
            mainCam.orthographicSize = 8f;
            mainCam.transform.rotation = Quaternion.Euler(45, 0, 0);
            mainCam.backgroundColor = new Color(0.5f, 0.8f, 1f);
        }

        GFM_Tools.EnsureMaterial();

        // Initialize all entity arrays
        for (int i = 0; i < MAX_ENTITIES; i++)
        {
            eActive[i] = false;
            eState[i] = 0;
            eTimer[i] = 0f;
            eHP[i] = 0f;
        }

        for (int i = 0; i < WORKER_COUNT; i++)
        {
            workerCarrying[i] = -1;
            workerState2[i] = 2;
        }

        // Create all entity GameObjects
        CreateAllEntities();

        // Create UI
        CreateUI();

        // Start Phase 1
        AdvancePhase(1);
    }

    void CreateAllEntities()
    {
        // E_GROUND
        eGo[E_GROUND] = GFM_Create.Obj("Cube");
        eGo[E_GROUND].transform.localScale = new Vector3(40, 1, 40);
        eGo[E_GROUND].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_GROUND], new Color(0.35f, 0.25f, 0.15f));

        // E_PLAYER
        eGo[E_PLAYER] = GFM_Create.Obj("Cube");
        eGo[E_PLAYER].transform.localScale = new Vector3(1, 2, 1);
        eGo[E_PLAYER].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_PLAYER], new Color(0.2f, 0.4f, 0.9f));

        // E_BASE
        eGo[E_BASE] = GFM_Create.Obj("Cube");
        eGo[E_BASE].transform.localScale = new Vector3(3, 3, 3);
        eGo[E_BASE].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_BASE], new Color(0.85f, 0.7f, 0.4f));
        eHP[E_BASE] = 50f;

        // E_WOODFENCE_L
        eGo[E_WOODFENCE_L] = GFM_Create.Obj("Cube");
        eGo[E_WOODFENCE_L].transform.localScale = new Vector3(0.3f, 1.5f, 4);
        eGo[E_WOODFENCE_L].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_WOODFENCE_L], new Color(0.6f, 0.35f, 0.1f));

        // E_WOODFENCE_R
        eGo[E_WOODFENCE_R] = GFM_Create.Obj("Cube");
        eGo[E_WOODFENCE_R].transform.localScale = new Vector3(0.3f, 1.5f, 4);
        eGo[E_WOODFENCE_R].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_WOODFENCE_R], new Color(0.6f, 0.35f, 0.1f));

        // E_PINETREE_L
        eGo[E_PINETREE_L] = GFM_Create.Obj("Cylinder");
        eGo[E_PINETREE_L].transform.localScale = new Vector3(0.5f, 3, 0.5f);
        eGo[E_PINETREE_L].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_PINETREE_L], new Color(0.1f, 0.55f, 0.1f));

        // E_PINETREE_R
        eGo[E_PINETREE_R] = GFM_Create.Obj("Cylinder");
        eGo[E_PINETREE_R].transform.localScale = new Vector3(0.5f, 3, 0.5f);
        eGo[E_PINETREE_R].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_PINETREE_R], new Color(0.1f, 0.55f, 0.1f));

        // E_GENERATOR
        eGo[E_GENERATOR] = GFM_Create.Obj("Cube");
        eGo[E_GENERATOR].transform.localScale = new Vector3(2, 2, 2);
        eGo[E_GENERATOR].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_GENERATOR], new Color(0.5f, 0.5f, 0.55f));

        // E_CONVEYOR (blueprint)
        eGo[E_CONVEYOR] = GFM_Create.Obj("Cube");
        eGo[E_CONVEYOR].transform.localScale = new Vector3(4, 0.3f, 1);
        eGo[E_CONVEYOR].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_CONVEYOR], new Color(0.5f, 0.5f, 0.55f));

        // E_CROSSBOW_L
        eGo[E_CROSSBOW_L] = GFM_Create.Obj("Cube");
        eGo[E_CROSSBOW_L].transform.localScale = new Vector3(1, 1.5f, 1);
        eGo[E_CROSSBOW_L].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_CROSSBOW_L], new Color(0.5f, 0.5f, 0.55f));

        // E_CROSSBOW_R
        eGo[E_CROSSBOW_R] = GFM_Create.Obj("Cube");
        eGo[E_CROSSBOW_R].transform.localScale = new Vector3(1, 1.5f, 1);
        eGo[E_CROSSBOW_R].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_CROSSBOW_R], new Color(0.5f, 0.5f, 0.55f));

        // E_ENEMY_SPAWNER (invisible)
        eGo[E_ENEMY_SPAWNER] = GFM_Create.Obj("Cube");
        eGo[E_ENEMY_SPAWNER].transform.localScale = new Vector3(0.01f, 0.01f, 0.01f);
        eGo[E_ENEMY_SPAWNER].transform.position = new Vector3(0, -999, 0);

        // E_WOODLOG_SPAWNER (invisible)
        eGo[E_WOODLOG_SPAWNER] = GFM_Create.Obj("Cube");
        eGo[E_WOODLOG_SPAWNER].transform.localScale = new Vector3(0.01f, 0.01f, 0.01f);
        eGo[E_WOODLOG_SPAWNER].transform.position = new Vector3(0, -999, 0);

        // E_WOODHOUSE
        eGo[E_WOODHOUSE] = GFM_Create.Obj("Cube");
        eGo[E_WOODHOUSE].transform.localScale = new Vector3(3, 2.5f, 3);
        eGo[E_WOODHOUSE].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_WOODHOUSE], new Color(0.85f, 0.7f, 0.4f));

        // E_WORKER_SPAWNER (invisible)
        eGo[E_WORKER_SPAWNER] = GFM_Create.Obj("Cube");
        eGo[E_WORKER_SPAWNER].transform.localScale = new Vector3(0.01f, 0.01f, 0.01f);
        eGo[E_WORKER_SPAWNER].transform.position = new Vector3(0, -999, 0);

        // E_TURRET
        eGo[E_TURRET] = GFM_Create.Obj("Cube");
        eGo[E_TURRET].transform.localScale = new Vector3(1.5f, 2, 1.5f);
        eGo[E_TURRET].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_TURRET], new Color(0.5f, 0.5f, 0.55f));

        // E_BOSS
        eGo[E_BOSS] = GFM_Create.Obj("Cube");
        eGo[E_BOSS].transform.localScale = new Vector3(1.5f, 3, 1.5f);
        eGo[E_BOSS].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_BOSS], new Color(0.7f, 0.1f, 0.1f));

        // E_CASTLEWALL
        eGo[E_CASTLEWALL] = GFM_Create.Obj("Cube");
        eGo[E_CASTLEWALL].transform.localScale = new Vector3(5, 4, 0.5f);
        eGo[E_CASTLEWALL].transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(eGo[E_CASTLEWALL], new Color(0.7f, 0.7f, 0.75f));

        // Arrow pool
        for (int i = 0; i < ARROW_COUNT; i++)
        {
            int idx = ARROW_START + i;
            eGo[idx] = GFM_Create.Obj("Cylinder");
            eGo[idx].transform.localScale = new Vector3(0.05f, 0.5f, 0.05f);
            eGo[idx].transform.position = new Vector3(0, -999, 0);
            GFM_Create.SetColor(eGo[idx], new Color(0.6f, 0.35f, 0.1f));
        }

        // Enemy pool
        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            int idx = ENEMY_START + i;
            eGo[idx] = GFM_Create.Obj("Cube");
            eGo[idx].transform.localScale = new Vector3(0.8f, 1.6f, 0.8f);
            eGo[idx].transform.position = new Vector3(0, -999, 0);
            GFM_Create.SetColor(eGo[idx], new Color(0.85f, 0.15f, 0.15f));
        }

        // GoldCoin pool
        for (int i = 0; i < GOLD_COUNT; i++)
        {
            int idx = GOLD_START + i;
            eGo[idx] = GFM_Create.Obj("Sphere");
            eGo[idx].transform.localScale = new Vector3(0.3f, 0.3f, 0.3f);
            eGo[idx].transform.position = new Vector3(0, -999, 0);
            GFM_Create.SetColor(eGo[idx], new Color(1f, 0.85f, 0f));
        }

        // WoodLog pool
        for (int i = 0; i < WOODLOG_COUNT; i++)
        {
            int idx = WOODLOG_START + i;
            eGo[idx] = GFM_Create.Obj("Cylinder");
            eGo[idx].transform.localScale = new Vector3(0.3f, 0.8f, 0.3f);
            eGo[idx].transform.position = new Vector3(0, -999, 0);
            GFM_Create.SetColor(eGo[idx], new Color(0.6f, 0.35f, 0.1f));
        }

        // Worker pool
        for (int i = 0; i < WORKER_COUNT; i++)
        {
            int idx = WORKER_START + i;
            eGo[idx] = GFM_Create.Obj("Cube");
            eGo[idx].transform.localScale = new Vector3(0.8f, 1.5f, 0.8f);
            eGo[idx].transform.position = new Vector3(0, -999, 0);
            GFM_Create.SetColor(eGo[idx], new Color(0.9f, 0.6f, 0.2f));
        }
    }

    void CreateUI()
    {
        // Simple UI using 3D objects positioned in screen space
        // We'll use world-space cubes as HP bar
        hpBarBg = GFM_Create.Obj("Cube");
        hpBarBg.transform.localScale = new Vector3(4, 0.3f, 0.1f);
        hpBarBg.transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(hpBarBg, new Color(0.3f, 0.3f, 0.3f));

        hpBarFill = GFM_Create.Obj("Cube");
        hpBarFill.transform.localScale = new Vector3(4, 0.3f, 0.12f);
        hpBarFill.transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(hpBarFill, new Color(0.1f, 0.8f, 0.1f));

        buildProgressBar = GFM_Create.Obj("Cube");
        buildProgressBar.transform.localScale = new Vector3(0, 0.2f, 0.2f);
        buildProgressBar.transform.position = new Vector3(0, -999, 0);
        GFM_Create.SetColor(buildProgressBar, new Color(0.2f, 0.8f, 0.2f));
    }

    // ============================
    // PHASE MANAGEMENT
    // ============================
    void AdvancePhase(int next)
    {
        currentPhase = next;

        switch (next)
        {
            case 1: // Build Conveyor
                ActivateEntity(E_GROUND, new Vector3(0, -0.5f, 0));
                ActivateEntity(E_PLAYER, new Vector3(-2, 1, -4));
                ActivateEntity(E_BASE, new Vector3(0, 1.5f, -3));
                ActivateEntity(E_WOODFENCE_L, new Vector3(-4, 0.75f, 0));
                ActivateEntity(E_WOODFENCE_R, new Vector3(4, 0.75f, 0));
                ActivateEntity(E_PINETREE_L, new Vector3(-5, 1.5f, 3));
                ActivateEntity(E_PINETREE_R, new Vector3(5, 1.5f, 3));
                ActivateEntity(E_GENERATOR, new Vector3(-3, 1, 2));
                ActivateEntity(E_CONVEYOR, new Vector3(0, 0.15f, 2));
                eState[E_CONVEYOR] = 0;
                conveyorBlueprint = true;
                // HP bar above base
                UpdateHPBar();
                SetCameraTarget(new Vector3(0, 0, 2), 8f);
                autoTarget = new Vector3(0, 1, 2);
                break;

            case 2: // Crossbow defense
                enemyKillCount = 0;
                SetCameraTarget(new Vector3(0, 0, 0), 10f);
                autoTarget = eGo[E_CROSSBOW_L].transform.position;
                break;

            case 3: // Build WoodHouse
                ActivateEntity(E_WOODHOUSE, new Vector3(5, 1.25f, -2));
                eState[E_WOODHOUSE] = 0;
                SetCameraTarget(new Vector3(3, 0, -1), 10f);
                autoTarget = new Vector3(5, 1, -2);
                break;

            case 4: // Recruit workers
                SetCameraTarget(new Vector3(3, 0, 0), 10f);
                break;

            case 5: // Auto production
                SetCameraTarget(new Vector3(0, 0, 0), 12f);
                break;

            case 6: // Build Turret
                ActivateEntity(E_TURRET, new Vector3(0, 1, 7));
                eState[E_TURRET] = 0;
                SetCameraTarget(new Vector3(0, 0, 5), 10f);
                autoTarget = new Vector3(0, 1, 7);
                break;

            case 7: // Defend
                enemyKillCount = 0;
                enemySpawnInterval = 1.8f;
                SetCameraTarget(new Vector3(0, 0, 3), 12f);
                break;

            case 8: // Boss
                ActivateEntity(E_BOSS, new Vector3(0, 1.5f, 20));
                eHP[E_BOSS] = 20f;
                eState[E_BOSS] = 1;
                SetCameraTarget(new Vector3(0, 0, 5), 14f);
                break;

            case 9: // Upgrade castle
                // Pop up castle wall
                ActivateEntityPopUp(E_CASTLEWALL, new Vector3(0, 2, 8));
                SetCameraTarget(new Vector3(0, 0, 0), 10f);
                break;

            case 10: // End
                gameEnded = true;
                Luna.Unity.LifeCycle.GameEnded();
                Luna.Unity.Playable.InstallFullGame();
                break;
        }
    }

    void ActivateEntity(int idx, Vector3 pos)
    {
        eActive[idx] = true;
        eGo[idx].transform.position = pos;
        eState[idx] = 0;
        eTimer[idx] = 0f;
    }

    void ActivateEntityPopUp(int idx, Vector3 pos)
    {
        eActive[idx] = true;
        eGo[idx].transform.position = pos;
        eState[idx] = 0;
        eTimer[idx] = 0f;
        // Pop-up animation handled in update via eState tracking
        popUpEntity = idx;
        popUpTime = 0f;
        popUpTargetScale = eGo[idx].transform.localScale;
        eGo[idx].transform.localScale = new Vector3(0.01f, 0.01f, 0.01f);
    }

    int popUpEntity = -1;
    float popUpTime = 0f;
    Vector3 popUpTargetScale;

    void DeactivateEntity(int idx)
    {
        eActive[idx] = false;
        eGo[idx].transform.position = new Vector3(0, -999, 0);
    }

    void SetCameraTarget(Vector3 lookAt, float size)
    {
        camTargetPos = lookAt + new Vector3(0, size * 0.7f, -size * 0.7f);
        camTargetSize = size;
    }

    // ============================
    // UPDATE
    // ============================
    void Update()
    {
        if (gameEnded) return;

        float dt = Time.deltaTime;
        if (dt > 0.1f) dt = 0.1f; // clamp

        // PopUp animation
        if (popUpEntity >= 0)
        {
            popUpTime += dt * 3f;
            float t = popUpTime > 1f ? 1f : popUpTime;
            float s = t * t * (3f - 2f * t); // smoothstep
            eGo[popUpEntity].transform.localScale = popUpTargetScale * s;
            if (t >= 1f) popUpEntity = -1;
        }

        // Camera smooth
        if (mainCam != null)
        {
            mainCam.transform.position = Vector3.Lerp(mainCam.transform.position, camTargetPos, dt * 2f);
            mainCam.orthographicSize = Mathf.Lerp(mainCam.orthographicSize, camTargetSize, dt * 2f);
        }

        // Blueprint flicker for conveyor
        if (eActive[E_CONVEYOR] && conveyorBlueprint && eState[E_CONVEYOR] == 0)
        {
            float flicker = (Mathf.Sin(Time.time * 4f) + 1f) * 0.5f;
            float a = 0.3f + flicker * 0.3f;
            GFM_Create.SetColor(eGo[E_CONVEYOR], new Color(0.5f * a + 0.5f * (1 - a), 0.5f * a + 0.5f * (1 - a), 0.55f * a + 0.55f * (1 - a)));
        }

        // Blueprint flicker for woodhouse
        if (eActive[E_WOODHOUSE] && eState[E_WOODHOUSE] == 0)
        {
            float flicker = (Mathf.Sin(Time.time * 4f) + 1f) * 0.5f;
            float c = 0.5f + flicker * 0.3f;
            GFM_Create.SetColor(eGo[E_WOODHOUSE], new Color(0.85f * c, 0.7f * c, 0.4f * c));
        }

        // Blueprint flicker for turret
        if (eActive[E_TURRET] && eState[E_TURRET] == 0)
        {
            float flicker = (Mathf.Sin(Time.time * 4f) + 1f) * 0.5f;
            float c = 0.5f + flicker * 0.3f;
            GFM_Create.SetColor(eGo[E_TURRET], new Color(0.5f * c, 0.5f * c, 0.55f * c));
        }

        // Update entities
        UpdatePlayer(dt);
        UpdateConveyor(dt);
        UpdateCrossbowL(dt);
        UpdateCrossbowR(dt);
        UpdateEnemySpawner(dt);
        UpdateWoodLogSpawner(dt);
        UpdateWoodHouse(dt);
        UpdateWorkerSpawner(dt);
        UpdateTurret(dt);
        UpdateBoss(dt);
        UpdateArrows(dt);
        UpdateEnemies(dt);
        UpdateGoldCoins(dt);
        UpdateWoodLogs(dt);
        UpdateWorkers(dt);
        UpdateHPBar();
        UpdateBase(dt);

        CheckPhaseTransition();

        // Track mouse state
        wasMouseDown = Input.GetMouseButton(0);
    }

    // ============================
    // PLAYER
    // ============================
    void UpdatePlayer(float dt)
    {
        if (!eActive[E_PLAYER]) return;

        float h = GFM_Tools.SliderValue("joyX");
        float v = GFM_Tools.SliderValue("joyY");

        bool hasInput = (Mathf.Abs(h) > 0.05f || Mathf.Abs(v) > 0.05f);

        if (hasInput)
        {
            autoPlayTimer = 0f;
            autoPlay = false;
        }
        else
        {
            autoPlayTimer += dt;
            if (autoPlayTimer > 2f)
            {
                autoPlay = true;
            }
        }

        Vector3 move = Vector3.zero;
        if (hasInput)
        {
            move = new Vector3(h, 0, v).normalized * moveSpeed * dt;
        }
        else if (autoPlay)
        {
            // Auto-move toward target
            Vector3 toTarget = autoTarget - eGo[E_PLAYER].transform.position;
            toTarget.y = 0;
            if (toTarget.magnitude > 0.5f)
            {
                move = toTarget.normalized * moveSpeed * dt;
            }
        }

        if (move.sqrMagnitude > 0.0001f)
        {
            Vector3 newPos = eGo[E_PLAYER].transform.position + move;
            // Clamp to ground
            newPos.x = Mathf.Clamp(newPos.x, -18f, 18f);
            newPos.z = Mathf.Clamp(newPos.z, -18f, 18f);
            newPos.y = 1f;
            eGo[E_PLAYER].transform.position = newPos;

            // Face direction
            Vector3 fwd = move.normalized;
            if (fwd.sqrMagnitude > 0.001f)
                eGo[E_PLAYER].transform.forward = fwd;
        }
    }

    // ============================
    // CONVEYOR BELT (Buildable)
    // ============================
    void UpdateConveyor(float dt)
    {
        if (!eActive[E_CONVEYOR]) return;

        if (eState[E_CONVEYOR] == 0)
        {
            // Waiting for player proximity + gold
            float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[E_CONVEYOR].transform.position);
            if (dist < 2f && gold >= 1)
            {
                gold -= 1;
                eState[E_CONVEYOR] = 1;
                eTimer[E_CONVEYOR] = 0f;
                conveyorBlueprint = false;
                GFM_Create.SetColor(eGo[E_CONVEYOR], new Color(0.4f, 0.4f, 0.45f));
            }
        }
        else if (eState[E_CONVEYOR] == 1)
        {
            // Building
            eTimer[E_CONVEYOR] += dt;
            float progress = eTimer[E_CONVEYOR] / 1.5f;
            // Show progress bar above
            buildProgressBar.transform.position = eGo[E_CONVEYOR].transform.position + new Vector3(-1.5f + progress * 1.5f, 1f, 0);
            buildProgressBar.transform.localScale = new Vector3(3f * progress, 0.2f, 0.2f);

            if (progress >= 1f)
            {
                eState[E_CONVEYOR] = 2;
                GFM_Create.SetColor(eGo[E_CONVEYOR], new Color(0.5f, 0.5f, 0.55f));
                buildProgressBar.transform.position = new Vector3(0, -999, 0);
                OnConveyorBuilt();
            }
        }
    }

    void OnConveyorBuilt()
    {
        // Activate crossbows with popup
        ActivateEntityPopUp(E_CROSSBOW_L, new Vector3(3, 0.75f, 5));
        eState[E_CROSSBOW_L] = 1;
        eTimer[E_CROSSBOW_L] = 0f;

        // Need to queue second popup - simple approach, do it directly
        eActive[E_CROSSBOW_R] = true;
        eGo[E_CROSSBOW_R].transform.position = new Vector3(-3, 0.75f, 5);
        eState[E_CROSSBOW_R] = 1;
        eTimer[E_CROSSBOW_R] = 0f;

        // Activate enemy spawner
        eActive[E_ENEMY_SPAWNER] = true;
        eGo[E_ENEMY_SPAWNER].transform.position = new Vector3(0, 0, 15);
        eState[E_ENEMY_SPAWNER] = 1;
        eTimer[E_ENEMY_SPAWNER] = 0f;

        // Activate wood log spawner
        eActive[E_WOODLOG_SPAWNER] = true;
        eGo[E_WOODLOG_SPAWNER].transform.position = new Vector3(0, 0, 2);
        eState[E_WOODLOG_SPAWNER] = 1;
        eTimer[E_WOODLOG_SPAWNER] = 2f; // Start with some delay used up
    }

    // ============================
    // CROSSBOW L (Shooter - click to fire)
    // ============================
    void UpdateCrossbowL(float dt)
    {
        if (!eActive[E_CROSSBOW_L] || eState[E_CROSSBOW_L] == 0) return;

        eTimer[E_CROSSBOW_L] += dt;
        if (eTimer[E_CROSSBOW_L] >= 1.5f)
        {
            // Check if clicked or auto-fire in autoplay
            bool shouldFire = false;
            if (IsClicked(eGo[E_CROSSBOW_L]))
            {
                shouldFire = true;
            }
            else if (autoPlay && eTimer[E_CROSSBOW_L] >= 2.5f)
            {
                shouldFire = true;
            }

            if (shouldFire)
            {
                int target = FindNearestEnemy(eGo[E_CROSSBOW_L].transform.position, 10f);
                if (target >= 0)
                {
                    SpawnArrow(eGo[E_CROSSBOW_L].transform.position, eGo[target].transform.position, 1);
                    eTimer[E_CROSSBOW_L] = 0f;
                    // Look at target
                    Vector3 dir = eGo[target].transform.position - eGo[E_CROSSBOW_L].transform.position;
                    dir.y = 0;
                    if (dir.sqrMagnitude > 0.01f)
                        eGo[E_CROSSBOW_L].transform.forward = dir.normalized;
                }
            }
        }
    }

    // ============================
    // CROSSBOW R (Shooter - click to fire)
    // ============================
    void UpdateCrossbowR(float dt)
    {
        if (!eActive[E_CROSSBOW_R] || eState[E_CROSSBOW_R] == 0) return;

        eTimer[E_CROSSBOW_R] += dt;
        if (eTimer[E_CROSSBOW_R] >= 1.5f)
        {
            bool shouldFire = false;
            if (IsClicked(eGo[E_CROSSBOW_R]))
            {
                shouldFire = true;
            }
            else if (autoPlay && eTimer[E_CROSSBOW_R] >= 2.5f)
            {
                shouldFire = true;
            }

            if (shouldFire)
            {
                int target = FindNearestEnemy(eGo[E_CROSSBOW_R].transform.position, 10f);
                if (target >= 0)
                {
                    SpawnArrow(eGo[E_CROSSBOW_R].transform.position, eGo[target].transform.position, 1);
                    eTimer[E_CROSSBOW_R] = 0f;
                    Vector3 dir = eGo[target].transform.position - eGo[E_CROSSBOW_R].transform.position;
                    dir.y = 0;
                    if (dir.sqrMagnitude > 0.01f)
                        eGo[E_CROSSBOW_R].transform.forward = dir.normalized;
                }
            }
        }
    }

    // ============================
    // ENEMY SPAWNER
    // ============================
    void UpdateEnemySpawner(float dt)
    {
        if (!eActive[E_ENEMY_SPAWNER] || eState[E_ENEMY_SPAWNER] == 0) return;

        eTimer[E_ENEMY_SPAWNER] += dt;
        if (eTimer[E_ENEMY_SPAWNER] >= enemySpawnInterval)
        {
            int aliveCount = CountAliveEnemies();
            if (aliveCount < 5)
            {
                SpawnEnemy();
            }
            eTimer[E_ENEMY_SPAWNER] = 0f;
        }
    }

    void SpawnEnemy()
    {
        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            int idx = ENEMY_START + i;
            if (!eActive[idx])
            {
                eActive[idx] = true;
                // Spawn from a random position at top
                float rx = Random.Range(-6f, 6f);
                eGo[idx].transform.position = new Vector3(rx, 0.8f, 15f + Random.Range(0f, 3f));
                eHP[idx] = 3f;
                eState[idx] = 1;
                eTimer[idx] = 0f;
                return;
            }
        }
    }

    int CountAliveEnemies()
    {
        int count = 0;
        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            if (eActive[ENEMY_START + i]) count++;
        }
        return count;
    }

    // ============================
    // WOODLOG SPAWNER
    // ============================
    void UpdateWoodLogSpawner(float dt)
    {
        if (!eActive[E_WOODLOG_SPAWNER] || eState[E_WOODLOG_SPAWNER] == 0) return;

        eTimer[E_WOODLOG_SPAWNER] += dt;
        if (eTimer[E_WOODLOG_SPAWNER] >= 4f)
        {
            int aliveCount = CountAliveWoodLogs();
            if (aliveCount < 3)
            {
                SpawnWoodLog();
            }
            eTimer[E_WOODLOG_SPAWNER] = 0f;
        }
    }

    void SpawnWoodLog()
    {
        for (int i = 0; i < WOODLOG_COUNT; i++)
        {
            int idx = WOODLOG_START + i;
            if (!eActive[idx])
            {
                eActive[idx] = true;
                float rx = Random.Range(-1.5f, 1.5f);
                eGo[idx].transform.position = new Vector3(rx, 0.4f, 2f + Random.Range(-0.5f, 0.5f));
                eState[idx] = 0; // available for pickup
                eTimer[idx] = 0f;
                // Pop up
                eGo[idx].transform.localScale = new Vector3(0.01f, 0.01f, 0.01f);
                return;
            }
        }
    }

    int CountAliveWoodLogs()
    {
        int count = 0;
        for (int i = 0; i < WOODLOG_COUNT; i++)
        {
            if (eActive[WOODLOG_START + i]) count++;
        }
        return count;
    }

    // ============================
    // WOODHOUSE (Buildable)
    // ============================
    void UpdateWoodHouse(float dt)
    {
        if (!eActive[E_WOODHOUSE]) return;

        if (eState[E_WOODHOUSE] == 0)
        {
            // Condition: wood >= 3
            if (wood >= 3)
            {
                float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[E_WOODHOUSE].transform.position);
                if (dist < 3f || autoPlay)
                {
                    wood -= 3;
                    eState[E_WOODHOUSE] = 1;
                    eTimer[E_WOODHOUSE] = 0f;
                    GFM_Create.SetColor(eGo[E_WOODHOUSE], new Color(0.7f, 0.55f, 0.3f));
                }
            }
        }
        else if (eState[E_WOODHOUSE] == 1)
        {
            eTimer[E_WOODHOUSE] += dt;
            float progress = eTimer[E_WOODHOUSE] / 2f;

            buildProgressBar.transform.position = eGo[E_WOODHOUSE].transform.position + new Vector3(-1.5f + progress * 1.5f, 2f, 0);
            buildProgressBar.transform.localScale = new Vector3(3f * progress, 0.2f, 0.2f);

            if (progress >= 1f)
            {
                eState[E_WOODHOUSE] = 2;
                GFM_Create.SetColor(eGo[E_WOODHOUSE], new Color(0.85f, 0.7f, 0.4f));
                buildProgressBar.transform.position = new Vector3(0, -999, 0);
                OnWoodHouseBuilt();
            }
        }
    }

    void OnWoodHouseBuilt()
    {
        // Activate worker spawner
        eActive[E_WORKER_SPAWNER] = true;
        eGo[E_WORKER_SPAWNER].transform.position = new Vector3(5, 0, -2);
        eState[E_WORKER_SPAWNER] = 1;
        eTimer[E_WORKER_SPAWNER] = 4f; // Spawn first worker quickly
    }

    // ============================
    // WORKER SPAWNER
    // ============================
    void UpdateWorkerSpawner(float dt)
    {
        if (!eActive[E_WORKER_SPAWNER] || eState[E_WORKER_SPAWNER] == 0) return;

        eTimer[E_WORKER_SPAWNER] += dt;
        if (eTimer[E_WORKER_SPAWNER] >= 5f)
        {
            int aliveCount = CountAliveWorkers();
            if (aliveCount < 2)
            {
                SpawnWorker();
            }
            eTimer[E_WORKER_SPAWNER] = 0f;
        }
    }

    void SpawnWorker()
    {
        for (int i = 0; i < WORKER_COUNT; i++)
        {
            int idx = WORKER_START + i;
            if (!eActive[idx])
            {
                eActive[idx] = true;
                eGo[idx].transform.position = new Vector3(5, 0.75f, -2);
                eState[idx] = 1; // active
                eTimer[idx] = 0f;
                workerCarrying[i] = -1;
                workerState2[i] = 0; // go to log
                eGo[idx].transform.localScale = new Vector3(0.8f, 1.5f, 0.8f);
                return;
            }
        }
    }

    int CountAliveWorkers()
    {
        int count = 0;
        for (int i = 0; i < WORKER_COUNT; i++)
        {
            if (eActive[WORKER_START + i]) count++;
        }
        return count;
    }

    // ============================
    // TURRET (Buildable + Shooter)
    // ============================
    void UpdateTurret(float dt)
    {
        if (!eActive[E_TURRET]) return;

        if (eState[E_TURRET] == 0)
        {
            // Proximity + wood >= 5
            float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[E_TURRET].transform.position);
            if (dist < 2f && wood >= 5)
            {
                wood -= 5;
                eState[E_TURRET] = 1;
                eTimer[E_TURRET] = 0f;
                GFM_Create.SetColor(eGo[E_TURRET], new Color(0.4f, 0.4f, 0.45f));
            }
        }
        else if (eState[E_TURRET] == 1)
        {
            // Building
            eTimer[E_TURRET] += dt;
            float progress = eTimer[E_TURRET] / 2f;

            buildProgressBar.transform.position = eGo[E_TURRET].transform.position + new Vector3(-1f + progress * 1f, 1.5f, 0);
            buildProgressBar.transform.localScale = new Vector3(2f * progress, 0.2f, 0.2f);

            if (progress >= 1f)
            {
                eState[E_TURRET] = 2;
                GFM_Create.SetColor(eGo[E_TURRET], new Color(0.5f, 0.5f, 0.55f));
                buildProgressBar.transform.position = new Vector3(0, -999, 0);
            }
        }
        else if (eState[E_TURRET] == 2)
        {
            // Auto-shoot
            eTimer[E_TURRET] += dt;
            if (eTimer[E_TURRET] >= 2f)
            {
                int target = FindNearestEnemy(eGo[E_TURRET].transform.position, 12f);
                if (target < 0)
                {
                    // Also check boss
                    if (eActive[E_BOSS] && eHP[E_BOSS] > 0)
                    {
                        float bd = Vector3.Distance(eGo[E_TURRET].transform.position, eGo[E_BOSS].transform.position);
                        if (bd < 12f)
                        {
                            SpawnArrow(eGo[E_TURRET].transform.position, eGo[E_BOSS].transform.position, 3);
                            eTimer[E_TURRET] = 0f;
                            Vector3 dir = eGo[E_BOSS].transform.position - eGo[E_TURRET].transform.position;
                            dir.y = 0;
                            if (dir.sqrMagnitude > 0.01f)
                                eGo[E_TURRET].transform.forward = dir.normalized;
                        }
                    }
                }
                else
                {
                    SpawnArrow(eGo[E_TURRET].transform.position, eGo[target].transform.position, 3);
                    eTimer[E_TURRET] = 0f;
                    Vector3 dir = eGo[target].transform.position - eGo[E_TURRET].transform.position;
                    dir.y = 0;
                    if (dir.sqrMagnitude > 0.01f)
                        eGo[E_TURRET].transform.forward = dir.normalized;
                }
            }
        }
    }

    // ============================
    // BOSS (Mover + Damageable)
    // ============================
    void UpdateBoss(float dt)
    {
        if (!eActive[E_BOSS] || eState[E_BOSS] == 0) return;

        if (eHP[E_BOSS] <= 0)
        {
            OnBossDeath();
            return;
        }

        // Move toward base
        Vector3 basePos = eGo[E_BASE].transform.position;
        Vector3 dir = (basePos - eGo[E_BOSS].transform.position);
        dir.y = 0;
        if (dir.magnitude > 2f)
        {
            eGo[E_BOSS].transform.position += dir.normalized * 1.5f * dt;
            if (dir.sqrMagnitude > 0.01f)
                eGo[E_BOSS].transform.forward = dir.normalized;
        }
        else
        {
            // Attack base
            eTimer[E_BOSS] += dt;
            if (eTimer[E_BOSS] >= 1f)
            {
                eHP[E_BASE] -= 2f;
                eTimer[E_BOSS] = 0f;
            }
        }

        // Boss color flash when hit (visual feedback)
        // Handled via damage function
    }

    void OnBossDeath()
    {
        DeactivateEntity(E_BOSS);
        // Spawn lots of gold
        for (int i = 0; i < 5; i++)
        {
            SpawnGoldCoin(eGo[E_BOSS].transform.position + new Vector3(Random.Range(-1f, 1f), 0, Random.Range(-1f, 1f)));
        }
    }

    // ============================
    // BASE (Damageable)
    // ============================
    void UpdateBase(float dt)
    {
        if (!eActive[E_BASE]) return;

        // Phase 9: click to upgrade
        if (currentPhase == 9 && eState[E_BASE] == 0)
        {
            if (IsClicked(eGo[E_BASE]) || (autoPlay && autoPlayTimer > 3f))
            {
                eState[E_BASE] = 1;
                eTimer[E_BASE] = 0f;
            }
        }
        else if (eState[E_BASE] == 1)
        {
            eTimer[E_BASE] += dt;
            float t = eTimer[E_BASE] / 1f;
            float s = 1f + t * 0.5f;
            eGo[E_BASE].transform.localScale = new Vector3(3 * s, 3 * s, 3 * s);
            if (t >= 1f)
            {
                eState[E_BASE] = 2;
                baseLevel = 2;
                GFM_Create.SetColor(eGo[E_BASE], new Color(0.9f, 0.8f, 0.5f));
            }
        }

        if (eHP[E_BASE] <= 0)
        {
            eHP[E_BASE] = 0;
            // Game over - but for playable ad, just show CTA
            gameEnded = true;
            Luna.Unity.LifeCycle.GameEnded();
            Luna.Unity.Playable.InstallFullGame();
        }
    }

    // ============================
    // ARROWS (Projectile pool)
    // ============================
    void SpawnArrow(Vector3 from, Vector3 target, int damage)
    {
        for (int i = 0; i < ARROW_COUNT; i++)
        {
            int idx = ARROW_START + i;
            if (!eActive[idx])
            {
                eActive[idx] = true;
                eGo[idx].transform.position = from + new Vector3(0, 0.5f, 0);
                arrowTarget[i] = target;
                arrowDmg[i] = damage;
                eTimer[idx] = 0f;
                eState[idx] = 1;
                Vector3 dir = (target - from).normalized;
                if (dir.sqrMagnitude > 0.001f)
                {
                    eGo[idx].transform.forward = dir;
                    eGo[idx].transform.rotation = Quaternion.LookRotation(dir) * Quaternion.Euler(90, 0, 0);
                }
                return;
            }
        }
    }

    void UpdateArrows(float dt)
    {
        for (int i = 0; i < ARROW_COUNT; i++)
        {
            int idx = ARROW_START + i;
            if (!eActive[idx]) continue;

            eTimer[idx] += dt;
            if (eTimer[idx] > 3f)
            {
                DeactivateEntity(idx);
                continue;
            }

            Vector3 dir = (arrowTarget[i] - eGo[idx].transform.position);
            float dist = dir.magnitude;
            if (dist < 0.5f)
            {
                // Hit - damage nearest enemy at target
                DamageNearestEnemyAt(arrowTarget[i], arrowDmg[i]);
                DeactivateEntity(idx);
            }
            else
            {
                Vector3 move = dir.normalized * 12f * dt;
                eGo[idx].transform.position += move;
            }
        }
    }

    void DamageNearestEnemyAt(Vector3 pos, int damage)
    {
        float bestDist = 2f;
        int bestIdx = -1;

        // Check regular enemies
        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            int idx = ENEMY_START + i;
            if (!eActive[idx] || eHP[idx] <= 0) continue;
            float d = Vector3.Distance(pos, eGo[idx].transform.position);
            if (d < bestDist)
            {
                bestDist = d;
                bestIdx = idx;
            }
        }

        // Check boss
        if (eActive[E_BOSS] && eHP[E_BOSS] > 0)
        {
            float d = Vector3.Distance(pos, eGo[E_BOSS].transform.position);
            if (d < bestDist)
            {
                bestDist = d;
                bestIdx = E_BOSS;
            }
        }

        if (bestIdx >= 0)
        {
            eHP[bestIdx] -= damage;
            // Flash white briefly
            if (bestIdx == E_BOSS)
            {
                GFM_Create.SetColor(eGo[bestIdx], new Color(1f, 0.5f, 0.5f));
                // Will reset next frame via boss update - we use a simple approach
            }
            else
            {
                GFM_Create.SetColor(eGo[bestIdx], new Color(1f, 0.6f, 0.6f));
            }
        }
    }

    // ============================
    // ENEMIES
    // ============================
    void UpdateEnemies(float dt)
    {
        Vector3 basePos = eGo[E_BASE].transform.position;

        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            int idx = ENEMY_START + i;
            if (!eActive[idx]) continue;

            // Reset color gradually
            GFM_Create.SetColor(eGo[idx], new Color(0.85f, 0.15f, 0.15f));

            if (eHP[idx] <= 0)
            {
                OnEnemyDeath(idx);
                continue;
            }

            // Move toward base
            Vector3 dir = (basePos - eGo[idx].transform.position);
            dir.y = 0;
            if (dir.magnitude > 1.5f)
            {
                eGo[idx].transform.position += dir.normalized * 2f * dt;
                if (dir.sqrMagnitude > 0.01f)
                    eGo[idx].transform.forward = dir.normalized;
            }
            else
            {
                // Attack base
                eTimer[idx] += dt;
                if (eTimer[idx] >= 1f)
                {
                    eHP[E_BASE] -= 1f;
                    eTimer[idx] = 0f;
                }
            }
        }
    }

    void OnEnemyDeath(int idx)
    {
        Vector3 deathPos = eGo[idx].transform.position;
        DeactivateEntity(idx);
        enemyKillCount++;
        totalEnemyKillCount++;

        // Drop gold coin
        SpawnGoldCoin(deathPos);
    }

    // ============================
    // GOLD COINS (Collectible)
    // ============================
    void SpawnGoldCoin(Vector3 pos)
    {
        for (int i = 0; i < GOLD_COUNT; i++)
        {
            int idx = GOLD_START + i;
            if (!eActive[idx])
            {
                eActive[idx] = true;
                eGo[idx].transform.position = pos + new Vector3(0, 0.3f, 0);
                eState[idx] = 0;
                eTimer[idx] = 0f;
                eGo[idx].transform.localScale = new Vector3(0.3f, 0.3f, 0.3f);
                return;
            }
        }
    }

    void UpdateGoldCoins(float dt)
    {
        for (int i = 0; i < GOLD_COUNT; i++)
        {
            int idx = GOLD_START + i;
            if (!eActive[idx]) continue;

            // Bob animation
            eTimer[idx] += dt;
            Vector3 pos = eGo[idx].transform.position;
            pos.y = 0.3f + Mathf.Sin(eTimer[idx] * 3f) * 0.1f;
            eGo[idx].transform.position = pos;

            // Rotate
            eGo[idx].transform.Rotate(0, 180f * dt, 0);

            // Check player proximity
            float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
            if (dist < 1.5f)
            {
                gold += 1;
                DeactivateEntity(idx);
            }
        }
    }

    // ============================
    // WOOD LOGS (Draggable / Collectible by proximity for simplification)
    // ============================
    void UpdateWoodLogs(float dt)
    {
        for (int i = 0; i < WOODLOG_COUNT; i++)
        {
            int idx = WOODLOG_START + i;
            if (!eActive[idx]) continue;

            // Pop up animation
            Vector3 sc = eGo[idx].transform.localScale;
            if (sc.x < 0.29f)
            {
                float ns = Mathf.Min(sc.x + dt * 1.5f, 0.3f);
                eGo[idx].transform.localScale = new Vector3(ns, ns * 2.67f, ns);
            }

            if (eState[idx] == 0)
            {
                // Available for pickup by player proximity
                float dist = Vector3.Distance(eGo[E_PLAYER].transform.position, eGo[idx].transform.position);
                if (dist < 1.5f)
                {
                    // Player picks it up -> add wood
                    wood += 1;
                    DeactivateEntity(idx);
                }
            }
            // State 1 = being carried by worker (handled in worker update)
        }
    }

    // ============================
    // WORKERS (Mover)
    // ============================
    void UpdateWorkers(float dt)
    {
        for (int i = 0; i < WORKER_COUNT; i++)
        {
            int idx = WORKER_START + i;
            if (!eActive[idx]) continue;

            float workerSpeed = 3f;

            if (workerState2[i] == 0)
            {
                // Go to nearest wood log
                int logIdx = FindNearestWoodLog(eGo[idx].transform.position);
                if (logIdx >= 0)
                {
                    Vector3 dir = (eGo[logIdx].transform.position - eGo[idx].transform.position);
                    dir.y = 0;
                    if (dir.magnitude > 1f)
                    {
                        eGo[idx].transform.position += dir.normalized * workerSpeed * dt;
                        if (dir.sqrMagnitude > 0.01f)
                            eGo[idx].transform.forward = dir.normalized;
                    }
                    else
                    {
                        // Pick up
                        workerCarrying[i] = logIdx;
                        eState[logIdx] = 1; // being carried
                        workerState2[i] = 1; // go to base
                    }
                }
                else
                {
                    // Wait / idle - wander near conveyor
                    workerState2[i] = 2;
                    eTimer[idx] = 0f;
                }
            }
            else if (workerState2[i] == 1)
            {
                // Go to base
                Vector3 basePos = eGo[E_BASE].transform.position;
                Vector3 dir = (basePos - eGo[idx].transform.position);
                dir.y = 0;

                // Carry the log
                if (workerCarrying[i] >= 0 && eActive[workerCarrying[i]])
                {
                    eGo[workerCarrying[i]].transform.position = eGo[idx].transform.position + new Vector3(0, 1.2f, 0);
                }

                if (dir.magnitude > 2f)
                {
                    eGo[idx].transform.position += dir.normalized * workerSpeed * dt;
                    if (dir.sqrMagnitude > 0.01f)
                        eGo[idx].transform.forward = dir.normalized;
                }
                else
                {
                    // Deliver
                    wood += 1;
                    if (workerCarrying[i] >= 0)
                    {
                        DeactivateEntity(workerCarrying[i]);
                    }
                    workerCarrying[i] = -1;
                    workerState2[i] = 0; // go find next log
                }
            }
            else if (workerState2[i] == 2)
            {
                // Idle - wait for logs
                eTimer[idx] += dt;
                if (eTimer[idx] > 1f)
                {
                    workerState2[i] = 0;
                    eTimer[idx] = 0f;
                }
            }
        }
    }

    int FindNearestWoodLog(Vector3 pos)
    {
        float bestDist = 999f;
        int bestIdx = -1;
        for (int i = 0; i < WOODLOG_COUNT; i++)
        {
            int idx = WOODLOG_START + i;
            if (!eActive[idx] || eState[idx] != 0) continue;
            float d = Vector3.Distance(pos, eGo[idx].transform.position);
            if (d < bestDist)
            {
                bestDist = d;
                bestIdx = idx;
            }
        }
        return bestIdx;
    }

    // ============================
    // HP BAR
    // ============================
    void UpdateHPBar()
    {
        if (!eActive[E_BASE]) return;

        Vector3 barPos = eGo[E_BASE].transform.position + new Vector3(0, 3f, 0);
        hpBarBg.transform.position = barPos;

        float ratio = eHP[E_BASE] / baseMaxHP;
        if (ratio < 0) ratio = 0;
        float barWidth = 4f * ratio;
        hpBarFill.transform.localScale = new Vector3(barWidth, 0.3f, 0.12f);
        hpBarFill.transform.position = barPos + new Vector3(-(4f - barWidth) * 0.5f, 0, -0.05f);

        // Color: green to red
        if (ratio > 0.5f)
            GFM_Create.SetColor(hpBarFill, new Color(0.1f, 0.8f, 0.1f));
        else if (ratio > 0.25f)
            GFM_Create.SetColor(hpBarFill, new Color(0.8f, 0.8f, 0.1f));
        else
            GFM_Create.SetColor(hpBarFill, new Color(0.8f, 0.1f, 0.1f));
    }

    // ============================
    // PHASE TRANSITION
    // ============================
    void CheckPhaseTransition()
    {
        switch (currentPhase)
        {
            case 1:
                if (eState[E_CONVEYOR] == 2)
                {
                    AdvancePhase(2);
                }
                break;

            case 2:
                if (enemyKillCount >= 3)
                {
                    AdvancePhase(3);
                }
                break;

            case 3:
                if (eState[E_WOODHOUSE] == 2)
                {
                    AdvancePhase(4);
                }
                break;

            case 4:
                if (CountAliveWorkers() >= 1)
                {
                    AdvancePhase(5);
                }
                break;

            case 5:
                if (wood >= 5)
                {
                    AdvancePhase(6);
                }
                break;

            case 6:
                if (eState[E_TURRET] == 2)
                {
                    AdvancePhase(7);
                }
                break;

            case 7:
                if (totalEnemyKillCount >= 10)
                {
                    AdvancePhase(8);
                }
                break;

            case 8:
                if (eActive[E_BOSS] == false || eHP[E_BOSS] <= 0)
                {
                    if (eActive[E_BOSS] && eHP[E_BOSS] <= 0) OnBossDeath();
                    AdvancePhase(9);
                }
                break;

            case 9:
                if (baseLevel >= 2)
                {
                    AdvancePhase(10);
                }
                break;
        }
    }

    // ============================
    // UTILITY
    // ============================
    int FindNearestEnemy(Vector3 pos, float range)
    {
        float bestDist = range;
        int bestIdx = -1;
        for (int i = 0; i < ENEMY_COUNT; i++)
        {
            int idx = ENEMY_START + i;
            if (!eActive[idx] || eHP[idx] <= 0) continue;
            float d = Vector3.Distance(pos, eGo[idx].transform.position);
            if (d < bestDist)
            {
                bestDist = d;
                bestIdx = idx;
            }
        }
        return bestIdx;
    }

    bool IsClicked(GameObject go)
    {
        if (!Input.GetMouseButtonDown(0)) return false;
        if (mainCam == null) return false;

        Ray ray = mainCam.ScreenPointToRay(Input.mousePosition);
        // Simple bounds check
        Vector3 p = go.transform.position;
        Vector3 s = go.transform.localScale * 0.6f;

        // Raycast against AABB
        float tMin = 0f;
        float tMax = 100f;

        for (int axis = 0; axis < 3; axis++)
        {
            float origin = axis == 0 ? ray.origin.x : (axis == 1 ? ray.origin.y : ray.origin.z);
            float dir = axis == 0 ? ray.direction.x : (axis == 1 ? ray.direction.y : ray.direction.z);
            float minB = (axis == 0 ? p.x : (axis == 1 ? p.y : p.z)) - (axis == 0 ? s.x : (axis == 1 ? s.y : s.z));
            float maxB = (axis == 0 ? p.x : (axis == 1 ? p.y : p.z)) + (axis == 0 ? s.x : (axis == 1 ? s.y : s.z));

            if (Mathf.Abs(dir) < 0.0001f)
            {
                if (origin < minB || origin > maxB) return false;
            }
            else
            {
                float t1 = (minB - origin) / dir;
                float t2 = (maxB - origin) / dir;
                if (t1 > t2) { float tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tMin) tMin = t1;
                if (t2 < tMax) tMax = t2;
                if (tMin > tMax) return false;
            }
        }
        return true;
    }
}
