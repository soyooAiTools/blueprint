#!/usr/bin/env node
'use strict';

var PROFILES = {
  'gmp-v14': {
    id: 'gmp-v14',
    status: 'legacy-frozen',
    default: true,
    targetFramework: 'GMP/GFM programmer delivery legacy',
    summary: 'Current programmer-delivery cleaner path. Keep stable; do not add new UnityComponent v1 framework evolution here.',
    outputMode: 'legacy-cleaner',
    promptState: 'current-default',
    forbiddenEvolution: [
      'Do not claim native UnityComponent v1 compliance.',
      'Do not continue mixing new UnityComponent contract changes into this large cleaner path.'
    ]
  },
  'unitycomponent-v1': {
    id: 'unitycomponent-v1',
    status: 'internal-profile',
    default: false,
    targetFramework: 'UnityComponent(3) / SLGFrameWork',
    frameworkContract: 'unitycomponent-contract-v1',
    namespace: '',
    scriptRoot: 'Assets/SLGFrameWork/Scripts',
    gameEntryPrefab: 'Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab',
    outputMode: 'spec-first-emitter',
    promptState: 'interim-not-default',
    sourceBoundary: {
      mutatesStoryboard2Html: false,
      mutatesSourceIrSchema: false,
      mutatesPlayableSceneIrSchema: false,
      mutatesWebglRuntime: false
    },
    layers: {
      base: ['BaseComponent', 'Entity', 'GameEntry'],
      component: ['MoveComponent', 'PickUpComponent', 'StackComponent', 'ObjectPoolComponent', 'HpComponent'],
      entity: ['Player', 'BackPoint', 'BaseResource', 'Bullet', 'project generated Entity subclasses'],
      manager: ['EntityManager', 'EventManager', 'CameraManager', 'ResourceManager', 'BuildManager', 'BlueprintPlayableManager'],
      prefab: ['GameEntry.prefab']
    },
    asmdefs: [],
    requiredManifests: [
      'UnityDeliverySpec',
      'FrameworkTemplateManifest',
      'SceneRefs',
      'PoolArchetypes',
      'UIRefs',
      'AssetBindings'
    ],
    forbiddenIdentifiers: [
      'GMP_',
      'GFM_',
      'MonoSingleton',
      'mSpawnEntities'
    ],
    componentLifecycle: ['OnAwake', 'OnEnable', 'OnStart', 'OnUpdate', 'OnDisable', 'OnDestroy'],
    entityLifecycle: ['OnAwake', 'OnOpen', 'OnStart', 'OnUpdate', 'OnClose', 'OnDelete'],
    cutoverGate: {
      internalSmokeCorpus: 5,
      promptCutoverCorpus: 10,
      requiresDeliverySpecSourceParity: true,
      requiresUnityOutputSpecConsistency: true,
      requiresUnityComponentHardgate: true
    }
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listProfiles() {
  return Object.keys(PROFILES).sort().map(function(id) {
    return clone(PROFILES[id]);
  });
}

function getProfile(id) {
  var profile = PROFILES[String(id || 'gmp-v14')];
  return profile ? clone(profile) : null;
}

function resolveProfile(id) {
  var requested = String(id || process.env.BLUEPRINT_UNITY_DELIVERY_PROFILE || 'gmp-v14').trim();
  var profile = getProfile(requested);
  if (!profile) {
    throw new Error('Unknown Unity delivery profile: ' + requested);
  }
  return profile;
}

function isUnityComponentV1(id) {
  return resolveProfile(id).id === 'unitycomponent-v1';
}

if (require.main === module) {
  var id = process.argv[2] || '';
  var out = id ? resolveProfile(id) : listProfiles();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

module.exports = {
  PROFILES: clone(PROFILES),
  listProfiles: listProfiles,
  getProfile: getProfile,
  resolveProfile: resolveProfile,
  isUnityComponentV1: isUnityComponentV1
};
