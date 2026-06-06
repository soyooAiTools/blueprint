'use strict';
// Wave 2 (2026-05-31): single declarative orchestration of the deterministic
// pre-repair pipeline that previously lived as ~350 lines of mirrored if-blocks
// inside engine/stages/review.cjs `repairKnownStructuralDamage`.
//
// The pipeline runs 3 passes: (A) main file, (B) each partial file, (C) cross-file
// + post re-runs. Passes A and B applied the SAME single-file pre-repairs in the
// SAME order — that 34-if-block mirror is the duplication this lib removes (one
// SHARED_BUNDLE array applied to main and to each partial).
//
// Behavior is byte-identical to the prior inline version — validated by the
// fixes-array equivalence gate (test/static-rule-prerepair-equivalence.test.cjs).
//
// Migration tactic (Step 2): the 25 pre-repair fns themselves still live in
// review.cjs and are injected via the `fns` param — this decouples orchestration
// extraction (here) from function-body motion (deferred). See
// docs/incidents/deterministic-prerepair-lib-2026-05-31.md.
//
// ORDER IS LOAD-BEARING (§6.3 of the incident doc): e.g. rewriteCameraMainToMainCam
// MUST precede stripExcessCameraBackgroundAssignments; normalizePhaseGateConditional
// MUST precede renameDuplicatePhaseGateMoveVars. Do not reorder SHARED_BUNDLE.

// [fnName, fixTag, wantsBlueprintArg] — the single-file pre-repairs applied
// identically to mainCode (Pass A) and to each partial (Pass B).
var SHARED_BUNDLE = [
  ['collapseLegacyCheckEventRulesStub',           'LegacyCheckEventRulesStub',     false],
  ['repairUpdateGameStateBridge',                 'UpdateGameState',               false],
  ['normalizeRuntimePhaseContract',               'RuntimePhaseContract',          true ],
  ['ensureAssemblySlotRunnerCalls',               'AssemblySlotRunnerTick',        false],
  ['stripInitMaterialFromScene',                  'InitMaterialFromScene',         false],
  ['stripEarlyShowCTA',                           'EarlyShowCTA',                  false],
  ['normalizeFinishGameTerminalFlow',             'FinishGameFlow',                false],
  ['rewriteHotPathVectorAllocations',             'HotVectorAlloc',                false],
  ['guardFloatingTextTransformPosition',          'FloatingTextNullGuard',         false],
  ['guardPlayerTransformDistanceReads',           'PlayerTransformDistanceGuard',  false],
  ['sanitizeNonAsciiResourceApiKeys',             'NonAsciiKey',                   false],
  ['stripExcessCameraBackgroundAssignments',      'CameraBackgroundOverride',      false],
  ['repairMainCamSelfAssignment',                 'CameraMainSelfAssign',          false],
  ['rewriteCameraMainToMainCam',                  'CameraMainRewrite',             false],
  ['normalizeSetScaleCalls',                      'SetScaleNormalize',             false],
  ['repairPhaseGateRuntimeMoves',                 'PhaseGateRuntimeMove',          false],
  ['normalizePhaseGateConditionalDeclarations',   'PhaseGateConditionalNormalize', false],
  ['renameDuplicatePhaseGateMoveVars',            'PhaseGateMoveVarRename',        false],
  ['stripInteractionFlagShortcutsFromPhaseGates', 'PhaseGateShortcutStrip',        true ],
  ['rewriteLongIfChainsAsSwitches',               'LongIfChainSwitch',             false],
];

// Mirrors review.cjs repairKnownStructuralDamage exactly. `fns` = the 25 injected
// pre-repair functions (see PREREPAIR_FNS in review.cjs). Returns the same shape:
// { code, extraFiles, changed, fixes }.
function runAllPreRepairs(mainCode, extraFiles, blueprint, fns) {
  var originalMainCode = mainCode;
  var originalExtraFiles = Object.assign({}, extraFiles || {});
  var changed = false;
  var fixes = [];

  // Apply the SHARED_BUNDLE to a single code string; log fixes under `tagPrefix:`.
  // Mutates closed-over `changed`/`fixes`; returns the (possibly updated) code.
  function applyShared(code, tagPrefix) {
    for (var i = 0; i < SHARED_BUNDLE.length; i++) {
      var fnName = SHARED_BUNDLE[i][0], tag = SHARED_BUNDLE[i][1], wantsBp = SHARED_BUNDLE[i][2];
      var res = wantsBp ? fns[fnName](code, blueprint) : fns[fnName](code);
      if (res.changed) {
        code = res.code;
        changed = true;
        fixes.push(tagPrefix + ':' + tag + ' x' + res.fixes);
      }
    }
    return code;
  }

  // ---- Pass A: main-only prefix fns (update mainCode AND extraFiles) ----
  var missingFlagFix = fns.declareMissingInteractionFlags(mainCode, extraFiles);
  if (missingFlagFix.changed) {
    mainCode = missingFlagFix.code; extraFiles = missingFlagFix.extraFiles;
    changed = true; fixes.push('main:MissingInteractionFlags x' + missingFlagFix.fixes);
  }
  var playerAliasFix = fns.repairPlayerAliasMemberAccess(mainCode, extraFiles);
  if (playerAliasFix.changed) {
    mainCode = playerAliasFix.code; extraFiles = playerAliasFix.extraFiles;
    changed = true; fixes.push('partials:PlayerAliasMemberAccess x' + playerAliasFix.fixes);
  }
  var playerAssignFix = fns.ensurePlayerFieldAssignment(mainCode, extraFiles);
  if (playerAssignFix.changed) {
    mainCode = playerAssignFix.code; extraFiles = playerAssignFix.extraFiles;
    changed = true; fixes.push('main:PlayerFieldAssignment x' + playerAssignFix.fixes);
  }
  var playerBridgeFix = fns.repairPlayerBridgePropertyFallback(mainCode, extraFiles);
  if (playerBridgeFix.changed) {
    mainCode = playerBridgeFix.code; extraFiles = playerBridgeFix.extraFiles;
    changed = true; fixes.push('main:PlayerBridgeFallback x' + playerBridgeFix.fixes);
  }
  // ---- Pass A: shared bundle on main ----
  mainCode = applyShared(mainCode, 'main');

  // ---- Pass B: shared bundle per partial ----
  var nextExtras = Object.assign({}, extraFiles || {});
  Object.keys(nextExtras).forEach(function(name) {
    nextExtras[name] = applyShared(nextExtras[name], name);
  });

  // ---- Pass C: cross-file + post re-runs (irregular; kept explicit) ----
  var crossPhaseGateFix = fns.repairPhaseGateRuntimeMovesAcrossPartials(mainCode, nextExtras);
  if (crossPhaseGateFix.changed) {
    mainCode = crossPhaseGateFix.code; nextExtras = crossPhaseGateFix.extraFiles;
    changed = true; fixes.push('partials:PhaseGateRuntimeMove x' + crossPhaseGateFix.fixes);
  }
  var postCrossPhaseContractFix = fns.normalizeRuntimePhaseContract(mainCode, blueprint);
  if (postCrossPhaseContractFix.changed) {
    mainCode = postCrossPhaseContractFix.code;
    changed = true; fixes.push('main:RuntimePhaseContractPost x' + postCrossPhaseContractFix.fixes);
  }
  var postCrossAssemblyTickFix = fns.ensureAssemblySlotRunnerCalls(mainCode);
  if (postCrossAssemblyTickFix.changed) {
    mainCode = postCrossAssemblyTickFix.code;
    changed = true; fixes.push('main:AssemblySlotRunnerTickPost x' + postCrossAssemblyTickFix.fixes);
  }
  var crossPartialAssemblyTickFix = fns.ensureAssemblySlotRunnerCallsAcrossPartials(mainCode, nextExtras);
  if (crossPartialAssemblyTickFix.changed) {
    mainCode = crossPartialAssemblyTickFix.code; // NOTE: original ignores .extraFiles here
    changed = true; fixes.push('main:AssemblySlotRunnerTickCross x' + crossPartialAssemblyTickFix.fixes);
  }
  var postCrossMainNormalize = fns.normalizePhaseGateConditionalDeclarations(mainCode);
  if (postCrossMainNormalize.changed) {
    mainCode = postCrossMainNormalize.code;
    changed = true; fixes.push('main:PhaseGateConditionalNormalizePost x' + postCrossMainNormalize.fixes);
  }
  var postCrossMainRename = fns.renameDuplicatePhaseGateMoveVars(mainCode);
  if (postCrossMainRename.changed) {
    mainCode = postCrossMainRename.code;
    changed = true; fixes.push('main:PhaseGateMoveVarRenamePost x' + postCrossMainRename.fixes);
  }
  Object.keys(nextExtras).forEach(function(name) {
    var normalizeRes = fns.normalizePhaseGateConditionalDeclarations(nextExtras[name]);
    if (normalizeRes.changed) {
      nextExtras[name] = normalizeRes.code;
      changed = true; fixes.push(name + ':PhaseGateConditionalNormalizePost x' + normalizeRes.fixes);
    }
    var renameRes = fns.renameDuplicatePhaseGateMoveVars(nextExtras[name]);
    if (renameRes.changed) {
      nextExtras[name] = renameRes.code;
      changed = true; fixes.push(name + ':PhaseGateMoveVarRenamePost x' + renameRes.fixes);
    }
  });
  var postCrossLongIfFix = fns.rewriteLongIfChainsAsSwitches(mainCode);
  if (postCrossLongIfFix.changed) {
    mainCode = postCrossLongIfFix.code;
    changed = true; fixes.push('main:LongIfChainSwitchPostPhaseGate x' + postCrossLongIfFix.fixes);
  }
  Object.keys(nextExtras).forEach(function(name) {
    var res = fns.rewriteLongIfChainsAsSwitches(nextExtras[name]);
    if (res.changed) {
      nextExtras[name] = res.code;
      changed = true; fixes.push(name + ':LongIfChainSwitchPostPhaseGate x' + res.fixes);
    }
  });
  var postTapResetFix = fns.removePostTapPhaseResetBlocks(mainCode);
  if (postTapResetFix.changed) {
    mainCode = postTapResetFix.code;
    changed = true; fixes.push('main:PostTapPhaseResetStrip x' + postTapResetFix.fixes);
  }
  var mainBranchCommentFix = fns.addMissingComplexBranchComments(mainCode);
  if (mainBranchCommentFix.changed) {
    mainCode = mainBranchCommentFix.code;
    changed = true; fixes.push('main:ComplexBranchComments x' + mainBranchCommentFix.fixes);
  }
  var mainMemberCommentFix = fns.addMissingSkeletonMemberComments(mainCode);
  if (mainMemberCommentFix.changed) {
    mainCode = mainMemberCommentFix.code;
    changed = true; fixes.push('main:SkeletonMemberComments x' + mainMemberCommentFix.fixes);
  }
  Object.keys(nextExtras).forEach(function(name) {
    if (!/^GameFlowManagerMain(?:\.|$)/.test(name)) return;
    var branchCommentRes = fns.addMissingComplexBranchComments(nextExtras[name]);
    if (branchCommentRes.changed) {
      nextExtras[name] = branchCommentRes.code;
      changed = true; fixes.push(name + ':ComplexBranchComments x' + branchCommentRes.fixes);
    }
    var memberCommentRes = fns.addMissingSkeletonMemberComments(nextExtras[name]);
    if (memberCommentRes.changed) {
      nextExtras[name] = memberCommentRes.code;
      changed = true; fixes.push(name + ':SkeletonMemberComments x' + memberCommentRes.fixes);
    }
  });
  var finalPlayerAliasFix = fns.repairPlayerAliasMemberAccess(mainCode, nextExtras);
  if (finalPlayerAliasFix.changed) {
    mainCode = finalPlayerAliasFix.code; nextExtras = finalPlayerAliasFix.extraFiles;
    changed = true; fixes.push('partials:PlayerAliasMemberAccessPost x' + finalPlayerAliasFix.fixes);
  }

  var actualChanged = mainCode !== originalMainCode;
  var originalNames = Object.keys(originalExtraFiles).sort();
  var nextNames = Object.keys(nextExtras || {}).sort();
  if (originalNames.length !== nextNames.length) actualChanged = true;
  for (var ni = 0; ni < nextNames.length && !actualChanged; ni++) {
    var name = nextNames[ni];
    if (name !== originalNames[ni] || (nextExtras[name] || '') !== (originalExtraFiles[name] || '')) actualChanged = true;
  }

  return { code: mainCode, extraFiles: nextExtras, changed: actualChanged, fixes: actualChanged ? fixes : [] };
}

module.exports = { runAllPreRepairs: runAllPreRepairs, SHARED_BUNDLE: SHARED_BUNDLE };
