// Source: engine/stages/spec-validate.cjs
/**
 * Stage: spec-validate — Validate blueprint specs before codegen
 *
 * Ensures specs have 100% chapter coverage, non-empty triggers,
 * valid entity references, known interaction verbs, and sane durations.
 *
 * Reads: ctx.blueprint.specs, ctx.blueprint.entities, ctx.blueprint.storyboard
 * Writes: ctx.blueprint.specs (auto-fixed durations)
 */

var fs = require('fs');
var path = require('path');
var shotDurationPolicy = require('../../lib/shot-duration-policy.cjs');

// Load interaction verb whitelist
var KNOWN_VERBS = {};
var VERB_VALIDATION_ENABLED = false;
try {
  var verbsFile = path.join(__dirname, '..', '..', 'worker', 'interaction-verbs.json');
  var verbsData = JSON.parse(fs.readFileSync(verbsFile, 'utf8'));
  var categories = verbsData.verbs || {};
  for (var cat in categories) {
    for (var verb in categories[cat]) {
      KNOWN_VERBS[verb] = categories[cat][verb];
    }
  }
  VERB_VALIDATION_ENABLED = Object.keys(KNOWN_VERBS).length > 0;
} catch(e) {
  console.warn('[spec-validate] interaction-verbs.json not loaded: ' + e.message + ' — verb validation DISABLED');
}

module.exports = {
  name: 'spec-validate',
  canRetry: true,
  canSkip: function(ctx) {
    // Skip if no specs (AI generates from storyboard narrative)
    return !ctx.blueprint.specs || ctx.blueprint.specs.length === 0;
  },
  execute: function(ctx) {
    ctx.addLog('spec-validate', 'Validating blueprint specs...');
    var specs = ctx.blueprint.specs;
    var errors = [];    // BLOCK — pipeline stops
    var warnings = [];  // WARN — logged but continues
    var autoFixes = []; // AUTO-FIX — corrected in place

    // --- 1. 100% chapter coverage ---
    var expectedChapters = getExpectedChapterCount(ctx.blueprint);
    if (expectedChapters > 0 && specs.length < expectedChapters) {
      errors.push('Spec coverage incomplete: got ' + specs.length + '/' + expectedChapters +
        ' chapters. Every chapter must have a spec.');
    }

    // --- 2. Per-spec validation ---
    var entityNames = new Set();
    var entityLowerToCanonical = {}; // lowercased name → canonical name, for case-insensitive fallback
    if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
      ctx.blueprint.entities.forEach(function(e) {
        // .trim() guards against LLM whitespace artifacts in entity names stored in the blueprint.
        // Applied to BOTH the Set entry and the canonical map value so that auto-corrected
        // spec refs never receive a whitespace-polluted name from a dirty blueprint entry.
        var eName = String(e.name).trim();
        entityNames.add(eName);
        entityLowerToCanonical[eName.toLowerCase()] = eName;
        if (e.poolName) {
          var ePoolName = String(e.poolName).trim();
          entityNames.add(ePoolName);
          entityLowerToCanonical[ePoolName.toLowerCase()] = ePoolName;
        }
      });
    }

    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      var label = 'Spec[' + i + '] ' + (spec.phaseId || 'unnamed');

      // --- BLOCK: empty trigger condition ---
      if (spec.triggerNext) {
        var cond = (spec.triggerNext.condition || '').trim();
        if (!cond || cond === 'true' || cond === 'false') {
          errors.push(label + ': triggerNext.condition is empty or trivial ("' + cond + '"). Must specify real C# condition.');
        }
      } else if (i < specs.length - 1) {
        // Non-final spec must have triggerNext
        errors.push(label + ': missing triggerNext (non-final phase must define transition condition)');
      }

      // --- BLOCK: entity references not in blueprint.entities ---
      // 2026-04-16 (xrbkl1): the LLM spec extractor sometimes camelCases names
      // (`forgeWorkshop` instead of `ForgeWorkshop`) even though the prompt says
      // verbatim-copy. Do a case-insensitive fallback and auto-correct the spec
      // in place — the mismatch is cosmetic, not semantic, and blocking it costs
      // 4+ re-extractions before a human manually syncs the project.
      if (spec.entitiesRequired && spec.entitiesRequired.length > 0 && entityNames.size > 0) {
        // Collect fully-hallucinated entries to strip after the forEach
        // (cannot splice during iteration).
        var entsToStrip = [];

        spec.entitiesRequired.forEach(function(ent) {
          // .trim() here catches LLM whitespace artifacts in spec entity refs
          var entNameTrimmed = String(ent.name).trim();
          if (entityNames.has(entNameTrimmed)) {
            // Silently correct any leading/trailing whitespace in the spec ref
            if (entNameTrimmed !== ent.name) {
              autoFixes.push(label + ': entity "' + ent.name + '" whitespace-trimmed to "' + entNameTrimmed + '"');
              ent.name = entNameTrimmed;
            }
            return;
          }
          // .trim().toLowerCase() on the lookup key to match the trimmed map keys built above
          var canonical = entityLowerToCanonical[entNameTrimmed.toLowerCase()];
          if (canonical) {
            autoFixes.push(label + ': entity "' + ent.name + '" case-normalized to "' + canonical + '"');
            ent.name = canonical;
            return;
          }
          // 2026-04-17 (auto-265daa80): LLM writes abbreviated names (e.g. "drill" vs "BasicDrill").
          // Substring fallback: if exactly one known entity contains the searched token as a
          // substring (unambiguous), auto-correct in place. Mirrors the case-normalization
          // auto-fix above — blocking an unambiguous abbreviation wastes 6 server retries.
          var token = entNameTrimmed.toLowerCase();
          var substringMatches = Array.from(entityNames).filter(function(n) {
            return String(n).toLowerCase().indexOf(token) >= 0;
          });
          if (substringMatches.length === 1) {
            autoFixes.push(label + ': entity "' + ent.name + '" substring-matched to "' + substringMatches[0] + '"');
            ent.name = substringMatches[0];
            return;
          } else if (substringMatches.length > 1) {
            // Multiple substring matches — disambiguate using phase context + edit distance.
            // Phase context: split phaseId into words, boost candidate sharing more words.
            // e.g. phaseId="upgradeTripleDrill", entity="drill" → prefer "TripleDrill" over "BasicDrill"
            var phaseWords = (spec.phaseId || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
            var contextBest = null, contextBestScore = -1;
            substringMatches.forEach(function(cand) {
              var candWords = cand.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/);
              var overlap = 0;
              candWords.forEach(function(cw) { if (phaseWords.indexOf(cw) >= 0) overlap++; });
              if (overlap > contextBestScore) { contextBestScore = overlap; contextBest = cand; }
            });
            if (contextBestScore >= 1) {
              autoFixes.push(label + ': entity "' + ent.name + '" phase-context matched among [' +
                substringMatches.join(', ') + '] → "' + contextBest + '"');
              ent.name = contextBest;
              return;
            }
            // Fallback: edit distance disambiguation
            var closest = _findClosestEntity(ent.name, substringMatches);
            if (closest) {
              var closestDist = _editDistance(entNameTrimmed.toLowerCase(), String(closest).toLowerCase());
              var isUnambiguous = substringMatches.every(function(cand) {
                return cand === closest ||
                  _editDistance(entNameTrimmed.toLowerCase(), String(cand).toLowerCase()) > closestDist;
              });
              if (isUnambiguous) {
                autoFixes.push(label + ': entity "' + ent.name + '" disambiguated among [' +
                  substringMatches.join(', ') + '] → "' + closest + '"');
                ent.name = closest;
                return;
              }
            }
            // Ambiguous multi-match — fall through to blocking error with full candidate list
            errors.push(label + ': entity "' + ent.name + '" is ambiguous — matches multiple blueprint entities: [' +
              substringMatches.join(', ') + ']. Use the exact entity name.');
            return;
          }
          // 5th tier: edit-distance auto-fix or strip-and-warn for hallucinated names.
          // Previously the suggestion was only used for display inside a blocking errors.push(),
          // which created a permanent dead-end when spec-extract was already completed
          // (canRetry:false + no recovery path). Now:
          //   • edit-distance match found  → apply as auto-fix (mirrors tiers 1–4)
          //   • no match at all            → strip entry + warning (unblocks pipeline)
          var suggestion = _findClosestEntity(ent.name, Array.from(entityNames));
          if (suggestion) {
            autoFixes.push(label + ': entity "' + ent.name + '" edit-distance corrected to "' + suggestion + '"');
            ent.name = suggestion;
            return;
          }
          // Fully hallucinated entity — strip it and warn rather than hard-blocking.
          // spec-extract is already in completedStages; a hard error here creates a
          // permanent dead-end requiring a full pipeline restart.
          warnings.push(label + ': entity "' + ent.name + '" not found in blueprint.entities and no close match found. ' +
            'Stripped from entitiesRequired to unblock pipeline. ' +
            'Known: ' + Array.from(entityNames).slice(0, 10).join(', '));
          entsToStrip.push(ent);
        });

        // Remove fully-hallucinated entries collected during the forEach above.
        if (entsToStrip.length > 0) {
          spec.entitiesRequired = spec.entitiesRequired.filter(function(e) {
            return entsToStrip.indexOf(e) < 0;
          });
        }
      }

      // Also case-normalize entity refs inside triggerNext.condition (e.g. "forgeWorkshop.state == 2")
      if (spec.triggerNext && spec.triggerNext.condition && Object.keys(entityLowerToCanonical).length > 0) {
        var origCond = spec.triggerNext.condition;
        var fixedCond = origCond;
        Object.keys(entityLowerToCanonical).forEach(function(lower) {
          var canonical = entityLowerToCanonical[lower];
          // Case-insensitive whole-word match for any variant of the entity name,
          // then replace with canonical form if it differs.
          var re = new RegExp('\\b' + _escapeRegex(lower) + '\\b', 'gi');
          fixedCond = fixedCond.replace(re, function(m) {
            return m === canonical ? m : canonical;
          });
        });
        if (fixedCond !== origCond) {
          autoFixes.push(label + ': triggerNext.condition entity names case-normalized ("' +
            origCond.substring(0, 60) + '" → "' + fixedCond.substring(0, 60) + '")');
          spec.triggerNext.condition = fixedCond;
        }
      }

      // --- WARN: unknown interaction verbs ---
      if (spec.requiredInteractions && spec.requiredInteractions.length > 0) {
        spec.requiredInteractions.forEach(function(interaction) {
          var verb = interaction.split(':')[0];
          if (VERB_VALIDATION_ENABLED && !KNOWN_VERBS[verb]) {
            errors.push(label + ': unknown interaction verb "' + verb + '" — will cause unpredictable AI code generation. Known: ' +
              Object.keys(KNOWN_VERBS).slice(0, 8).join(', ') + '...');
          }
        });
      }

      // --- WARN: playerMustAct=false but autoAllowed=false ---
      if (spec.playerMustAct === false && spec.autoAllowed === false) {
        warnings.push(label + ': playerMustAct=false but autoAllowed=false — contradictory');
      }

      // --- AUTO-FIX: review shot duration policy ---
      var durationPolicy = shotDurationPolicy.normalizeReviewShotDuration(spec.duration);
      if (durationPolicy.changed) {
        spec.duration = durationPolicy.duration;
        autoFixes.push(label + ': review shot duration normalized to ' +
          spec.duration.min + '-' + spec.duration.max + 's (' + durationPolicy.fixes.join('; ') + ')');
      } else if (!spec.duration) {
        spec.duration = durationPolicy.duration;
      }
    }


    // --- 3. Trigger condition references entities check ---
    for (var ti = 0; ti < specs.length; ti++) {
      var tSpec = specs[ti];
      var tLabel = 'Spec[' + ti + '] ' + (tSpec.phaseId || 'unnamed');
      if (tSpec.triggerNext && tSpec.triggerNext.condition) {
        var cond = tSpec.triggerNext.condition;
        var tEnts = tSpec.entitiesRequired || [];
        // If spec has entities, at least one entity name should appear in the condition
        // (as entityNameState pattern from skeleton generator)
        if (tEnts.length > 0) {
          var hasEntityRef = false;
          for (var te = 0; te < tEnts.length; te++) {
            var stateVar = tEnts[te].name + 'State';
            var rawName = tEnts[te].name;
            if (cond.indexOf(stateVar) >= 0 || cond.indexOf(rawName) >= 0) {
              hasEntityRef = true;
              break;
            }
          }
          if (!hasEntityRef) {
            warnings.push(tLabel + ': triggerNext.condition "' + cond.substring(0, 60) +
              '" does not reference any entity from entitiesRequired (' +
              tEnts.map(function(e) { return e.name; }).join(', ') +
              '). This may cause condition-entity mismatch in generated code.');
          }
        }
      }
    }

    // --- 4. Phase graph dead-end check ---
    // Verify all non-final specs have triggerNext that can lead to the next phase
    for (var gi = 0; gi < specs.length - 1; gi++) {
      var gSpec = specs[gi];
      var gLabel = 'Spec[' + gi + '] ' + (gSpec.phaseId || 'unnamed');
      if (!gSpec.triggerNext || !gSpec.triggerNext.condition) {
        errors.push(gLabel + ': no triggerNext.condition — phase graph has dead end at phase ' + (gi + 1) +
          '. Next phase (' + (specs[gi + 1].phaseId || 'unnamed') + ') will be unreachable.');
      }
      // Check for phases with playerMustAct=true but no interactions
      if (gSpec.playerMustAct && (!gSpec.requiredInteractions || gSpec.requiredInteractions.length === 0)) {
        warnings.push(gLabel + ': playerMustAct=true but no requiredInteractions defined — ' +
          'AI won\'t know what player action is needed. Consider adding interaction verbs.');
      }
    }

    // --- 5. Entity terminal state consistency ---
    // Check that entities referenced across multiple specs have consistent terminal states
    var entityTerminalStates = {};
    for (var eti = 0; eti < specs.length; eti++) {
      var etEnts = specs[eti].entitiesRequired || [];
      for (var etj = 0; etj < etEnts.length; etj++) {
        var eName = etEnts[etj].name;
        var eState = etEnts[etj].terminalState;
        if (entityTerminalStates[eName] === undefined) {
          entityTerminalStates[eName] = { maxState: eState, phases: [specs[eti].phaseId] };
        } else {
          entityTerminalStates[eName].phases.push(specs[eti].phaseId);
          if (eState > entityTerminalStates[eName].maxState) {
            entityTerminalStates[eName].maxState = eState;
          }
        }
      }
    }
    // Log multi-phase entities for visibility
    var multiPhaseEntities = Object.keys(entityTerminalStates).filter(function(k) {
      return entityTerminalStates[k].phases.length > 1;
    });
    if (multiPhaseEntities.length > 0) {
      ctx.addLog('spec-validate', 'Multi-phase entities: ' + multiPhaseEntities.map(function(k) {
        return k + '(state 0→' + entityTerminalStates[k].maxState + ' across ' + entityTerminalStates[k].phases.join(',') + ')';
      }).join('; '));
    }

    // --- 6. Circular reference detection ---
    // Check if any triggerNext.condition references a previous phase (backwards jump)
    var phaseIdSet = {};
    for (var ci = 0; ci < specs.length; ci++) {
      phaseIdSet[specs[ci].phaseId] = ci;
    }
    for (var cri = 0; cri < specs.length; cri++) {
      var crSpec = specs[cri];
      var crLabel = 'Spec[' + cri + '] ' + (crSpec.phaseId || 'unnamed');
      if (crSpec.triggerNext && crSpec.triggerNext.condition) {
        var crCond = crSpec.triggerNext.condition;
        // Check if condition text references any earlier phase ID (potential loop)
        for (var crj = 0; crj <= cri; crj++) {
          var earlierPhaseId = specs[crj].phaseId;
          if (earlierPhaseId && crCond.indexOf(earlierPhaseId) >= 0 && crj !== cri) {
            errors.push(crLabel + ': triggerNext.condition references earlier phase "' + earlierPhaseId +
              '" (Spec[' + crj + ']) — creates circular dependency. Phase graph must be acyclic (linear forward progression).');
          }
        }
      }
      // Also check if any spec's nextPhase points backwards (explicit graph cycle)
      if (crSpec.nextPhase && phaseIdSet[crSpec.nextPhase] !== undefined) {
        var nextIdx = phaseIdSet[crSpec.nextPhase];
        if (nextIdx <= cri) {
          errors.push(crLabel + ': nextPhase "' + crSpec.nextPhase + '" points to Spec[' + nextIdx +
            '] which is at or before current position — circular reference detected.');
        }
      }
    }

    // --- 7. Unreachable phase detection ---
    // First phase is always reachable. Subsequent phases are reachable if the previous phase has a valid triggerNext.
    for (var uri = 1; uri < specs.length; uri++) {
      var prevSpec = specs[uri - 1];
      var urLabel = 'Spec[' + uri + '] ' + (specs[uri].phaseId || 'unnamed');
      if (!prevSpec.triggerNext || !(prevSpec.triggerNext.condition || '').trim()) {
        warnings.push(urLabel + ': potentially unreachable — previous phase "' +
          (prevSpec.phaseId || 'unnamed') + '" has no triggerNext.condition to transition here.');
      }
    }

    // --- 8. Luna platform feasibility lint ---
    // Catch specs that describe features Luna cannot implement BEFORE wasting codegen cycles
    var LUNA_UNSUPPORTED_FEATURES = [
      { pattern: /tilemap|tile.?map|瓦片/i, name: 'TileMap' },
      { pattern: /terrain|地形系统/i, name: 'Terrain' },
      { pattern: /particle.?system|粒子系统|粒子特效/i, name: 'ParticleSystem' },
      { pattern: /navmesh|nav.?agent|寻路/i, name: 'NavMesh/NavAgent' },
      { pattern: /animator.?controller|动画状态机|animation.?state/i, name: 'AnimatorController' },
      { pattern: /physics.?2d|2d.?physics|rigidbody2d/i, name: 'Physics2D' },
      { pattern: /multi.?scene|场景切换|load.?scene/i, name: 'Multi-Scene' },
      { pattern: /shader.?graph|visual.?shader/i, name: 'ShaderGraph' },
      { pattern: /text.?mesh.?pro|tmp_|textmeshpro/i, name: 'TextMeshPro' },
      { pattern: /character.?controller/i, name: 'CharacterController' },
      { pattern: /audio.?mixer|混音器/i, name: 'AudioMixer' },
      { pattern: /cloth|布料/i, name: 'Cloth simulation' },
      { pattern: /cinemachine/i, name: 'Cinemachine' },
    ];

    for (var fi = 0; fi < specs.length; fi++) {
      var fSpec = specs[fi];
      var fLabel = 'Spec[' + fi + '] ' + (fSpec.phaseId || 'unnamed');
      // Check all text fields in the spec for unsupported feature references
      var specText = [
        fSpec.phaseName || '',
        (fSpec.triggerNext && fSpec.triggerNext.description) || '',
        (fSpec.entitiesRequired || []).map(function(e) { return (e.name || '') + ' ' + (e.description || ''); }).join(' '),
        (fSpec.requiredInteractions || []).join(' '),
      ].join(' ');

      for (var uf = 0; uf < LUNA_UNSUPPORTED_FEATURES.length; uf++) {
        if (LUNA_UNSUPPORTED_FEATURES[uf].pattern.test(specText)) {
          warnings.push(fLabel + ': references Luna-unsupported feature "' +
            LUNA_UNSUPPORTED_FEATURES[uf].name + '". AI codegen will likely produce non-functional code for this. ' +
            'Consider simplifying to pool-object-based mechanics.');
        }
      }
    }

    // --- 9. Phase count budget check ---
    // With partial class splitting (>10 phases → auto-split), code budget is ~2400 lines total.
    // AI generates ~100 lines/phase → 25 phases ≈ 2500 lines (near limit).
    if (specs.length > 25) {
      warnings.push('Spec has ' + specs.length + ' phases (>25). Code budget may be exceeded even with partial class splitting — ' +
        'AI generates ~100 lines per phase, >2500 lines risks Opus token exhaustion across both files. ' +
        'Consider merging simple phases to reduce code budget.');
    } else if (specs.length > 10) {
      // Info: will trigger auto-split, not a problem
      warnings.push('[info] Spec has ' + specs.length + ' phases (>10). Skeleton will auto-split into main + systems files (partial class). ' +
        'Total code budget: ~2400 lines across two files.');
    }

    // --- 10. Total duration sanity ---
    var totalMinDuration = 0;
    var totalMaxDuration = 0;
    for (var di = 0; di < specs.length; di++) {
      if (specs[di].duration) {
        totalMinDuration += specs[di].duration.min || 0;
        totalMaxDuration += specs[di].duration.max || 0;
      }
    }
    if (totalMaxDuration > 300) {
      warnings.push('Total max duration is ' + totalMaxDuration + 's (>300s). ' +
        'Review-paced shots should stay inside the CUA timeout budget. ' +
        'Consider reducing phase count or merging simple phases.');
    }
    if (totalMinDuration < specs.length * shotDurationPolicy.REVIEW_SHOT_MIN_SECONDS) {
      warnings.push('Total min duration is only ' + totalMinDuration + 's for ' + specs.length + ' phases. ' +
        'Review shot duration normalization may have been bypassed.');
    }

    // --- 11. Inventory-counter ↔ collect-interaction cross-check ---
    // 2026-05-03 root-cause fix: phase 0 endCondition `Player.CollectedMetalFragmentCount >= 20`
    // 但 requiredInteractions 里没 `collect:MetalFragment`,LLM 自由发挥,把整段 spec 描述当
    // collect 的 item 名字喂下去,assembly-plan 把中文写进 AddResource(Normalize("..."), 1) 让中文成为
    // 资源 key。下游观察到 MetalFragmentCount 永远 0,但 CUA 12s timer gate 还是会推进
    // phase,所以错误悄无声息。这里对 endCondition 做静态扫描,缺失对应 collect/deliver
    // interaction 时直接 ERROR,强制 spec 作者(或 spec-extract LLM)补齐。
    var INVENTORY_PATTERNS = [
      { re: /Player\.Collected(\w+?)Count\b/g, verb: 'collect' },
      { re: /Player\.(\w+?)Amount\b/g, verb: 'collect|deliver' },
      { re: /Player\.inventory\.(\w+)\b/g, verb: 'collect' }
    ];
    for (var ii = 0; ii < specs.length; ii++) {
      var iSpec = specs[ii];
      var iLabel = 'Spec[' + ii + '] ' + (iSpec.phaseId || 'unnamed');
      var iCond = (iSpec.triggerNext && iSpec.triggerNext.condition) || '';
      if (!iCond) continue;
      var requiredResources = [];
      INVENTORY_PATTERNS.forEach(function(pat) {
        pat.re.lastIndex = 0;
        var match;
        while ((match = pat.re.exec(iCond)) !== null) {
          // 跳过通用计数 (Gold/Score 这些 always-on counter, 不需 phase 内 collect)
          var resName = match[1];
          if (/^(Gold|Score|Money|Cash|Coin|Currency|Time)$/i.test(resName)) continue;
          requiredResources.push({ name: resName, verb: pat.verb });
        }
      });
      if (requiredResources.length === 0) continue;
      // 该 phase OR 之前任意 phase 必须有 collect/deliver 该资源
      var hasMatchingInteraction = false;
      for (var hi = 0; hi <= ii && !hasMatchingInteraction; hi++) {
        var hSpec = specs[hi];
        var hInts = hSpec.requiredInteractions || [];
        for (var ji = 0; ji < hInts.length; ji++) {
          var rawInt = String(hInts[ji] || '');
          var verb = rawInt.split(':')[0];
          var arg = rawInt.split(':')[1] || '';
          for (var ri = 0; ri < requiredResources.length; ri++) {
            var req = requiredResources[ri];
            if (req.verb.indexOf(verb) >= 0 && new RegExp('\\b' + req.name + '\\b', 'i').test(arg)) {
              hasMatchingInteraction = true;
              break;
            }
          }
          if (hasMatchingInteraction) break;
        }
      }
      if (!hasMatchingInteraction) {
        var resList = requiredResources.map(function(r) { return r.name + '(' + r.verb + ')'; }).join(', ');
        errors.push(iLabel + ': triggerNext.condition references inventory counter [' + resList + '] ' +
          'but no matching collect/deliver interaction in this or earlier phases. ' +
          'AI will guess the resource name (often leaking phase description as a Chinese resource key) ' +
          'and the counter will never increment. Add `requiredInteractions: ["collect:' +
          requiredResources[0].name + '"]` to this or an earlier phase.');
      }
    }

    // --- Log results ---
    if (autoFixes.length > 0) {
      autoFixes.forEach(function(f) { ctx.addLog('spec-validate', 'AUTO-FIX: ' + f); });
    }
    if (warnings.length > 0) {
      warnings.forEach(function(w) { ctx.addLog('spec-validate', 'WARN: ' + w); });
    }

    // --- BLOCK on errors ---
    if (errors.length > 0) {
      errors.forEach(function(e) { ctx.addLog('spec-validate', 'ERROR: ' + e); });
      // Invalidate the spec-extract checkpoint so the next worker retry re-runs
      // spec-extract from scratch. Without this, spec-extract remains in
      // completedStages and the worker loops forever against the same bad specs.
      // The specsAreReusable guard in spec-extract.cjs will detect the staleness
      // and trigger a fresh LLM extraction on the next pass.
      if (ctx.completedStages && Array.isArray(ctx.completedStages)) {
        var seIdx = ctx.completedStages.indexOf('spec-extract');
        if (seIdx >= 0) {
          ctx.completedStages.splice(seIdx, 1);
          ctx.addLog('spec-validate', 'Invalidated spec-extract checkpoint to force re-extraction on retry.');
        }
      }
      // Aggregate: collapse same-class errors so metrics fingerprint stays stable.
      // 2026-04-19: previously 7 entity mismatches became 7 unique fingerprints,
      // splitting topFailReasons and defeating auto-fix cooldown dedup.
      var aggregated = _aggregateSpecErrors(errors);
      throw new Error('Spec validation failed: ' + errors.length + ' error(s):\n' + aggregated.join('\n'));
    }

    ctx.addLog('spec-validate', 'Passed (' + specs.length + ' specs, ' +
      warnings.length + ' warning(s), ' + autoFixes.length + ' auto-fix(es))');

    return Promise.resolve({
      valid: true,
      specsCount: specs.length,
      warnings: warnings,
      autoFixes: autoFixes,
    });
  },
};

/**
 * Escape regex metacharacters in a string so it can be used as a literal pattern.
 */
function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collapse same-class errors so fingerprinting stays stable.
 *
 * Strategy: extract a "class key" per error by stripping Spec[N] prefixes,
 * quoted entity names, and numerics — then group by key. Classes with
 * ≥3 occurrences are replaced by one aggregated line; the rest pass through
 * unchanged so unique issues still reach the user verbatim.
 */
function _aggregateSpecErrors(errors) {
  function classify(e) {
    return String(e)
      .replace(/^Spec\[\d+\]\s*[a-zA-Z_]\w*\s*:\s*/, 'Spec[N] <phase>: ')
      .replace(/"[^"]*"/g, '"<entity>"')
      .replace(/\b\d+\b/g, 'N')
      .replace(/\[[^\]]+\]/g, function(m) {
        // Collapse candidate lists "[a, b, c]" to "[...]"
        return m.indexOf(',') >= 0 ? '[...]' : m;
      })
      .slice(0, 120);
  }
  var byClass = {};
  for (var i = 0; i < errors.length; i++) {
    var key = classify(errors[i]);
    if (!byClass[key]) byClass[key] = { count: 0, first: errors[i], samples: [] };
    byClass[key].count++;
    if (byClass[key].samples.length < 3) byClass[key].samples.push(errors[i]);
  }
  var keys = Object.keys(byClass);
  // If no class has ≥3 hits, leave errors alone — aggregation would only obscure.
  var hasCluster = keys.some(function(k) { return byClass[k].count >= 3; });
  if (!hasCluster) return errors;

  var out = [];
  keys.forEach(function(k) {
    var slot = byClass[k];
    if (slot.count >= 3) {
      out.push(slot.first + ' (and ' + (slot.count - 1) + ' similar occurrences: ' +
        slot.samples.slice(1).map(function(s) {
          // Shorten each sample to just the distinguishing part after "Spec[N]"
          var m = String(s).match(/^Spec\[\d+\][^:]*:\s*(.*)$/);
          return m ? m[1].slice(0, 60) : s.slice(0, 60);
        }).join('; ') + ')');
    } else {
      slot.samples.forEach(function(s) { out.push(s); });
    }
  });
  return out;
}

/**
 * Find the closest known entity name for a typo'd reference.
 * Uses a cheap Levenshtein distance; returns null if no candidate is within threshold.
 */
function _findClosestEntity(name, candidates) {
  var target = String(name || '').trim().toLowerCase();
  var threshold = Math.max(2, Math.floor(target.length * 0.4));
  var best = null;
  var bestDist = threshold + 1;
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    var d = _editDistance(target, String(cand).toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  return best;
}

function _editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var prev = new Array(b.length + 1);
  var curr = new Array(b.length + 1);
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (var k = 1; k <= b.length; k++) {
      var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
      curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    for (var m = 0; m <= b.length; m++) prev[m] = curr[m];
  }
  return prev[b.length];
}

/**
 * Determine expected chapter count from storyboard frames.
 */
function getExpectedChapterCount(blueprint) {
  var frames = null;
  if (blueprint.storyboard && blueprint.storyboard.frames) {
    frames = blueprint.storyboard.frames;
  } else if (blueprint.shots) {
    frames = blueprint.shots;
  }
  if (!frames || frames.length === 0) return 0;

  // Count unique chapters
  var chapters = new Set();
  frames.forEach(function(f) {
    var ch = f.chapter || f.chapterId || f.chapterNumber;
    if (ch) chapters.add(ch);
  });

  // If no chapter markers, each frame is a chapter
  return chapters.size > 0 ? chapters.size : frames.length;
}
