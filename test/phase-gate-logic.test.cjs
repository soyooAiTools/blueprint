const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cleaner = require('../lib/programmer-delivery-cleaner.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-gate-logic-'));

try {
  const scripts = path.join(tmp, 'Assets', 'Scripts');
  const scenes = path.join(tmp, 'Assets', 'Scenes');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(scenes, { recursive: true });
  fs.writeFileSync(path.join(scenes, 'Game.unity'), [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!29 &1',
    'OcclusionCullingSettings:',
    '  m_ObjectHideFlags: 0',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'MonoSingleton.cs'), [
    'using UnityEngine;',
    'public abstract class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour {}',
  ].join('\n'));
  fs.writeFileSync(path.join(scripts, 'MainManager.cs'), [
    'using UnityEngine;',
    'public class MainManager : MonoSingleton<MainManager>',
    '{',
    '    string[] _entityBindingIds = new string[] { "_player", "_gold", "_base", "_ctaButton" };',
    '    public GameObject _player;',
    '    public GameObject _gold;',
    '    public GameObject _base;',
    '    public GameObject _ctaButton;',
    '    void SpawnGold(int count) { SpawnBoundEntity(_gold, ref _goldState, count); }',
    '    int _goldState;',
    '    void SpawnBoundEntity(GameObject entity, ref int state, int count) {}',
    '    void Phase_phase1_Init() { GMP_VisualGuide.HighlightTarget(_player); }',
    '    void Phase_phase2_Init() { GMP_VisualGuide.HighlightTarget(_base); }',
    '    void Phase_phase3_Init() { GMP_VisualGuide.HighlightTarget(_ctaButton); }',
    '    bool Phase_phase2_GateReady() { return EntityAdvanced(_gold, _snapGoldPos) && PhaseDwellReady(12f); }',
    '    bool Phase_phase3_GateReady() { return EntityAdvanced(_base, _snapBasePos) && PhaseDwellReady(12f); }',
    '    bool EndGame_GateReady() { return EntityAdvanced(_ctaButton, _snapCtaPos) && PhaseDwellReady(12f); }',
    '}',
  ].join('\n'));

  cleaner.cleanProgrammerDelivery(tmp, { project: { id: 'phase-gate', name: 'phase-gate' } });

  const coreModules = path.join(scripts, 'Core', 'Modules');
  const gameLevel = path.join(scripts, 'Game', 'Level');
  const phaseDir = path.join(scripts, 'Game', 'Phases');
  const phasePreset = fs.readFileSync(path.join(coreModules, 'GMP_PhasePreset.cs'), 'utf8');
  assert.match(phasePreset, /public class GMP_PhasePreset : ScriptableObject/);
  assert.match(phasePreset, /public GMP_PhaseGate mGate = new GMP_PhaseGate\(\)/);
  const phaseGate = fs.readFileSync(path.join(coreModules, 'GMP_PhaseGate.cs'), 'utf8');
  assert.match(phaseGate, /public class GMP_PhaseGate/);
  assert.match(phaseGate, /switch \(mKind\)/);
  assert.match(phaseGate, /case GMP_PhaseGateKind\.Timer/);
  assert.match(phaseGate, /case GMP_PhaseGateKind\.Resource/);
  assert.match(phaseGate, /case GMP_PhaseGateKind\.Entity/);
  assert.match(phaseGate, /case GMP_PhaseGateKind\.EntityCount/);
  assert.match(phaseGate, /GMP_EconomyManager\.instance\.GetResource\(mTarget\)/);
  assert.match(phaseGate, /GMP_EntityBindingManager\.instance\.GetState\(mTarget\)/);

  const phaseController = fs.readFileSync(path.join(coreModules, 'GMP_PhaseController.cs'), 'utf8');
  assert.match(phaseController, /bool IsDwellReady = mPhaseTimer >= required \|\| mPhaseRealTimer >= required/);
  assert.match(phaseController, /bool IsGateReady = preset\.mGate == null \|\| preset\.mGate\.IsReady/);
  assert.doesNotMatch(phaseController, /GMP_EventRuleEngine\.instance\.IsPhaseComplete/);

  const entityBinding = fs.readFileSync(path.join(gameLevel, 'GMP_EntityBindingManager.cs'), 'utf8');
  assert.match(entityBinding, /public int GetActiveCount\(string entityName\)/);

  const phase1 = fs.readFileSync(path.join(phaseDir, 'Phase1.asset'), 'utf8');
  const phase2 = fs.readFileSync(path.join(phaseDir, 'Phase2.asset'), 'utf8');
  const phase3 = fs.readFileSync(path.join(phaseDir, 'Phase3.asset'), 'utf8');
  assert.match(phase1, /mTargetEntity: "_gold"/);
  assert.match(phase1, /mKind: 3/);
  assert.match(phase1, /mTarget: "_gold"/);
  assert.match(phase1, /mThreshold: 2/);
  assert.match(phase1, /  - _gold/);
  assert.match(phase2, /mTarget: "_base"/);
  assert.match(phase3, /mTarget: "_ctaButton"/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('phase gate logic tests passed');
