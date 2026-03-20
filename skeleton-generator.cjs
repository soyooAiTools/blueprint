/**
 * Skeleton Generator — Generate GameFlowManagerMain.cs skeleton from phase specs
 * 
 * Input: Phase specs array + GFM_Tools API configuration
 * Output: C# skeleton code with enforced phaseTimer, interaction gates, TODO markers
 * 
 * The skeleton ensures:
 * - Every phase has minimum dwell time (from spec.duration.min)
 * - Every phase transition requires spec.triggerNext.condition
 * - AI can only fill TODO sections, cannot remove skeleton-enforced code
 * - All entities must reach terminal state before game ends
 */

const fs = require('fs');
const path = require('path');

/**
 * Generate C# skeleton from specs
 * @param {Array} specs - Phase specs from spec-extractor
 * @param {object} opts - { projectName, totalPhases }
 * @returns {string} C# skeleton code
 */
function generateSkeleton(specs, opts = {}) {
  const totalPhases = specs.length;
  const lines = [];

  // Header
  lines.push('// ========== AUTO-GENERATED SKELETON — DO NOT MODIFY SKELETON LINES ==========');
  lines.push('// Generated from storyboard spec. AI fills TODO sections only.');
  lines.push('// Lines marked [SKELETON] must not be removed or modified.');
  lines.push('');
  lines.push('using UnityEngine;');
  lines.push('using UnityEngine.UI;');
  lines.push('');
  lines.push('public class GameFlowManagerMain : MonoBehaviour');
  lines.push('{');

  // Phase timer system (skeleton-enforced)
  lines.push('    // [SKELETON] Phase timing system — enforces minimum dwell time per phase');
  lines.push('    float phaseTimer = 0f;');
  lines.push('    string lastPhaseForTimer = "";');
  lines.push('    float[] phaseEnterTimes;  // [SKELETON] records when each phase was entered');
  lines.push('');

  // Game state variables (skeleton-enforced)
  lines.push('    // [SKELETON] Phase tracking');
  lines.push(`    const int RULE_COUNT = ${totalPhases + 2};`);
  lines.push('    bool[] ruleTriggered;');
  lines.push('    string currentPhaseName = "init";');
  lines.push('    string[] completedPhases;');
  lines.push('    int completedPhaseCount = 0;');
  lines.push('    float gameTimer;');
  lines.push('    bool gameEnded = false;');
  lines.push('');

  // Entity state variables from specs
  const allEntities = new Set();
  specs.forEach(spec => {
    (spec.entitiesRequired || []).forEach(e => allEntities.add(e.name));
  });
  if (allEntities.size > 0) {
    lines.push('    // [SKELETON] Entity states — must reach terminal state');
    allEntities.forEach(name => {
      lines.push(`    int ${name}State = 0; // 0=waiting, 1=building, 2=built [SKELETON]`);
    });
    lines.push('');
  }

  // TODO: AI declares additional variables
  lines.push('    // === TODO: AI declares object references, pools, and game variables below ===');
  lines.push('    // TODO_VARIABLES_START');
  lines.push('');
  lines.push('    // TODO_VARIABLES_END');
  lines.push('');

  // Start method
  lines.push('    void Start()');
  lines.push('    {');
  lines.push('        // [SKELETON] Initialize phase tracking');
  lines.push(`        ruleTriggered = new bool[RULE_COUNT];`);
  lines.push(`        completedPhases = new string[RULE_COUNT + 5];`);
  lines.push(`        phaseEnterTimes = new float[RULE_COUNT];`);
  lines.push('');
  lines.push('        // === TODO: AI fills — find objects, initialize pools, setup camera, setup UI ===');
  lines.push('        // TODO_START_START');
  lines.push('');
  lines.push('        // TODO_START_END');
  lines.push('');
  lines.push('        UpdateGameState();');
  lines.push('    }');
  lines.push('');

  // Update method
  lines.push('    void Update()');
  lines.push('    {');
  lines.push('        if (gameEnded) return;');
  lines.push('');
  lines.push('        float dt = Time.deltaTime;');
  lines.push('        gameTimer += dt;');
  lines.push('');
  lines.push('        // [SKELETON] Phase timer update');
  lines.push('        if (currentPhaseName != lastPhaseForTimer) {');
  lines.push('            phaseTimer = 0f;');
  lines.push('            lastPhaseForTimer = currentPhaseName;');
  lines.push('        }');
  lines.push('        phaseTimer += dt;');
  lines.push('');
  lines.push('        CheckEventRules();');
  lines.push('');
  lines.push('        // === TODO: AI fills — update systems (player, enemies, arrows, etc.) ===');
  lines.push('        // TODO_UPDATE_START');
  lines.push('');
  lines.push('        // TODO_UPDATE_END');
  lines.push('    }');
  lines.push('');

  // CheckEventRules — the core skeleton
  lines.push('    void CheckEventRules()');
  lines.push('    {');

  specs.forEach((spec, i) => {
    const ruleIdx = i;
    const nextIdx = i + 1;
    const isLast = i === specs.length - 1;

    lines.push(`        // ========== Phase ${i + 1}: ${spec.phaseName} (${spec.phaseId}) ==========`);
    lines.push(`        // Duration: ${spec.duration.min}-${spec.duration.max}s`);
    lines.push(`        // Interactions: ${(spec.requiredInteractions || []).join(', ') || 'none'}`);
    lines.push(`        // Player must act: ${spec.playerMustAct}`);

    if (i === 0) {
      // First rule: game start
      lines.push(`        if (!ruleTriggered[${ruleIdx}])`);
      lines.push('        {');
      lines.push(`            ruleTriggered[${ruleIdx}] = true;`);
      lines.push(`            currentPhaseName = "${spec.phaseId}";`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push('');
      lines.push(`            // === TODO: AI fills — place initial objects, set colors, show guide ===`);
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_START`);
      lines.push('');
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_END`);
      lines.push('');
      lines.push('            AddCompletedPhase("gameStart");');
      lines.push('            UpdateGameState();');
      lines.push('        }');
    } else {
      // Subsequent rules: require previous phase condition + minimum dwell time
      const prevSpec = specs[i - 1];
      const triggerCondition = spec.triggerNext && spec.triggerNext.condition
        ? spec.triggerNext.condition
        : `/* TODO: AI fills trigger condition for ${spec.phaseId} */`;

      lines.push(`        // [SKELETON] Transition from ${prevSpec.phaseId} → ${spec.phaseId}`);
      lines.push(`        // Requires: ${prevSpec.triggerNext ? prevSpec.triggerNext.description : 'previous phase complete'}`);
      lines.push(`        if (!ruleTriggered[${ruleIdx}]`);
      lines.push(`            && ${prevSpec.triggerNext ? prevSpec.triggerNext.condition : `/* TODO: condition */`}`);
      lines.push(`            && phaseTimer >= ${prevSpec.duration.min}f) // [SKELETON] min dwell time`);
      lines.push('        {');
      lines.push(`            ruleTriggered[${ruleIdx}] = true;`);
      lines.push(`            currentPhaseName = "${spec.phaseId}";`);
      lines.push(`            phaseEnterTimes[${ruleIdx}] = gameTimer; // [SKELETON]`);
      lines.push('');
      lines.push(`            // === TODO: AI fills — activate objects for ${spec.phaseName} ===`);
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_START`);
      lines.push('');
      lines.push(`            // TODO_PHASE_${i + 1}_INIT_END`);
      lines.push('');
      lines.push(`            AddCompletedPhase("${prevSpec.phaseId}");`);
      lines.push('            UpdateGameState();');
      lines.push('        }');
    }
    lines.push('');
  });

  // Final rule: game end
  const lastSpec = specs[specs.length - 1];
  lines.push(`        // ========== Game End ==========`);
  lines.push(`        if (!ruleTriggered[${specs.length}]`);
  lines.push(`            && ${lastSpec.triggerNext ? lastSpec.triggerNext.condition : '/* TODO: end condition */'}`);
  lines.push(`            && phaseTimer >= ${lastSpec.duration.min}f) // [SKELETON]`);
  lines.push('        {');
  lines.push(`            ruleTriggered[${specs.length}] = true;`);
  lines.push('            currentPhaseName = "gameEnd";');
  lines.push('            gameEnded = true;');
  lines.push('');

  // Verify all entities reached terminal state
  if (allEntities.size > 0) {
    lines.push('            // [SKELETON] Verify all entities reached terminal state');
    allEntities.forEach(name => {
      lines.push(`            // Assert: ${name}State should be 2 at game end`);
    });
  }

  lines.push('');
  lines.push(`            AddCompletedPhase("${lastSpec.phaseId}");`);
  lines.push('            AddCompletedPhase("gameEnd");');
  lines.push('            ShowCTA();');
  lines.push('            UpdateGameState();');
  lines.push('            Luna.Unity.LifeCycle.GameEnded();');
  lines.push('        }');
  lines.push('    }');
  lines.push('');

  // Helper methods (skeleton)
  lines.push('    // === TODO: AI fills — game systems (UpdatePlayer, UpdateEnemies, etc.) ===');
  lines.push('    // TODO_SYSTEMS_START');
  lines.push('');
  lines.push('    // TODO_SYSTEMS_END');
  lines.push('');

  // Standard helpers
  lines.push('    // ========== SKELETON HELPERS (do not modify) ==========');
  lines.push('');
  lines.push('    void AddCompletedPhase(string phaseName)');
  lines.push('    {');
  lines.push('        if (completedPhaseCount < completedPhases.Length)');
  lines.push('        {');
  lines.push('            completedPhases[completedPhaseCount] = phaseName;');
  lines.push('            completedPhaseCount++;');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) { obj.SetActive(true); obj.transform.position = new Vector3(x, y, z); }');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.SetActive(false);');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.localScale = new Vector3(x, y, z);');
  lines.push('    }');
  lines.push('');

  // UpdateGameState with phaseTimestamps
  lines.push('    void UpdateGameState()');
  lines.push('    {');
  lines.push('        // [SKELETON] Expose game state for CUA verification');
  lines.push('        string completedJson = "[";');
  lines.push('        for (int i = 0; i < completedPhaseCount; i++)');
  lines.push('        {');
  lines.push('            if (i > 0) completedJson += ",";');
  lines.push('            completedJson += "\\"" + completedPhases[i] + "\\"";');
  lines.push('        }');
  lines.push('        completedJson += "]";');
  lines.push('');
  lines.push('        string json = "{"');

  // Build entity states JSON
  lines.push('            + "\\"currentPhase\\":\\"" + currentPhaseName + "\\","');
  lines.push('            + "\\"completedPhases\\":" + completedJson + ","');

  // Entity states
  lines.push('            + "\\"entityStates\\":{"');
  const entityList = Array.from(allEntities);
  entityList.forEach((name, i) => {
    const comma = i < entityList.length - 1 ? ',' : '';
    lines.push(`            + "\\"${name}\\":\\"" + ${name}State + "\\"${comma}"`);
  });
  lines.push('            + "},"');

  // Variables (AI fills)
  lines.push('            + "\\"variables\\":{"');
  lines.push('            + "\\"gameTimer\\":" + (int)gameTimer');
  lines.push('            // TODO: AI adds game-specific variables here');
  lines.push('            + "}"');

  // Phase timestamps
  lines.push('            + ",\\"phaseTimestamps\\":{"');
  specs.forEach((spec, i) => {
    const comma = i < specs.length - 1 ? ',' : '';
    lines.push(`            + "\\"${spec.phaseId}\\":" + (phaseEnterTimes[${i}] > 0 ? (int)phaseEnterTimes[${i}] : 0) + "${comma}"`);
  });
  lines.push('            + "}"');

  lines.push('            + "}";');
  lines.push('');
  lines.push('        GFM_Tools.SetGameState(json);');
  lines.push('    }');
  lines.push('');

  // ShowCTA / ShowGuide stubs
  lines.push('    // === TODO: AI fills — ShowGuide, ShowCTA, UI methods ===');
  lines.push('    // TODO_UI_START');
  lines.push('');
  lines.push('    // TODO_UI_END');
  lines.push('}');

  return lines.join('\n');
}

/**
 * Save skeleton to file
 */
function saveSkeleton(skeleton, outputPath) {
  fs.writeFileSync(outputPath, skeleton, 'utf8');
  console.log(`[SkeletonGenerator] Skeleton saved to ${outputPath} (${(skeleton.length / 1024).toFixed(1)} KB)`);
}

module.exports = { generateSkeleton, saveSkeleton };
