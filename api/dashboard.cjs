/**
 * Dashboard API handlers
 * Extracted from server.cjs — dashboard stats, workers, tasks, watchdog
 */
var fs = require('fs');
var path = require('path');
var { projectSM } = require('../lib/state-machine.cjs');
var patchRunArchive = require('../engine/archive-patch-run.cjs');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';

// API health cache — healthCheck() pings Doubao (5-6s) + Claude (0.4s) for
// every request. Front-end calls this on dashboard load, blocking first render
// ~6s. Cache results with background refresh so the endpoint returns instantly.
var apiHealthCache = { data: null, ts: 0, inflight: null };
var API_HEALTH_TTL_MS = 60 * 1000;

module.exports.init = function(ctx) {
  var taskQueue = ctx.taskQueue;
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var parseStats = ctx.parseStats;
  var modelProvider = ctx.modelProvider;

  var PROJECTS_DIR = config.PROJECTS_DIR;

  function buildFamilyCatalog() {
    return {
      'infra.schema_backend': {
        owner: 'infrastructure',
        remedy: 'fallback / retry budget / backend health',
        knowledgeRefs: [
          'generated/recipes/fix-recipes.mirror.json',
          'generated/rules/promoted-rules.mirror.json',
        ],
      },
      'codegen.marker_coverage': {
        owner: 'codegen',
        remedy: 'skeleton/template fill guard',
        knowledgeRefs: [
          'rules/pipeline/template-marker-coverage.json',
          'recipes/pipeline/fix-template-marker-coverage.json',
          'incidents/2026-04-22-template-marker-regression.md',
        ],
      },
      'schema.invalid_trigger_shape': {
        owner: 'schema',
        remedy: 'deterministic normalizer + validator repair',
        knowledgeRefs: [
          'generated/recipes/fix-recipes.mirror.json',
          'generated/signals/pending-fixes.snapshot.json',
        ],
      },
      'method_check.partial_visibility': {
        owner: 'method-check',
        remedy: 'scan main + extraFiles, ignore comment ghosts',
        knowledgeRefs: [
          'generated/signals/pending-fixes.snapshot.json',
          'generated/signals/pending-rules.snapshot.json',
        ],
      },
      'review.nonconverging_structural': {
        owner: 'review/static-check',
        remedy: 'promote deterministic guards, stop free-form fix-loop',
        knowledgeRefs: [
          'regressions/aborted-same-code-error-repeated-n-rounds-fix-loop-not-converging-review-blocked/meta.json',
          'generated/signals/pending-fixes.snapshot.json',
        ],
      },
      'review.main_file_reintroduced_phase_logic': {
        owner: 'static-check',
        remedy: 'block structural rollback to main file',
        knowledgeRefs: [
          'generated/signals/pending-rules.snapshot.json',
          'generated/rules/promoted-rules.mirror.json',
        ],
      },
      'review.forbidden_init_material_from_scene': {
        owner: 'static-check',
        remedy: 'block obsolete Luna material init',
        knowledgeRefs: [
          'generated/luna/luna-anomaly-rules.snapshot.js',
          'generated/signals/pending-rules.snapshot.json',
        ],
      },
      'review.phase_condition_false_literal': {
        owner: 'static-check',
        remedy: 'reject dead phase gates before review',
        knowledgeRefs: [
          'generated/signals/pending-rules.snapshot.json',
        ],
      },
      'cua.observe_protocol': {
        owner: 'runtime/cua',
        remedy: 'observer-ready handshake + early fatal classification',
        knowledgeRefs: [
          'generated/recipes/fix-recipes.mirror.json',
          'generated/regressions/runtime-regressions.mirror.json',
        ],
      },
      'monitor.stuck_or_timeout': {
        owner: 'watchdog',
        remedy: 'stuck detection + manual recovery escalation',
        knowledgeRefs: [
          'generated/regressions/runtime-regressions.mirror.json',
          'generated/signals/pending-fixes.snapshot.json',
        ],
      },
      'complexity_gate.bad_simplify_json': {
        owner: 'complexity-gate',
        remedy: 'balanced JSON extraction + repair',
        knowledgeRefs: [
          'generated/signals/pending-fixes.snapshot.json',
        ],
      },
      'cua.silent_pass': {
        owner: 'cua/metrics',
        remedy: 'silent-pass block + event-centered verification',
        knowledgeRefs: [
          'generated/regressions/runtime-regressions.mirror.json',
        ],
      },
      'infra.model_fatal': {
        owner: 'infrastructure',
        remedy: 'provider failover / auth / quota guard',
        knowledgeRefs: [
          'generated/recipes/fix-recipes.mirror.json',
        ],
      },
      'review.other': {
        owner: 'review',
        remedy: 'promote recurring criticals to deterministic rules',
        knowledgeRefs: [],
      },
      'cua.other': {
        owner: 'cua',
        remedy: 'tighten early-exit and runtime instrumentation',
        knowledgeRefs: [],
      },
      'generation.other': {
        owner: 'codegen',
        remedy: 'improve schema/codegen determinism',
        knowledgeRefs: [],
      },
      'unknown': {
        owner: 'triage',
        remedy: 'new family — needs classification',
        knowledgeRefs: [],
      },
    };
  }

  function enrichFamiliesWithPlaybook(families) {
    var catalog = buildFamilyCatalog();
    return (families || []).map(function(item) {
      var meta = catalog[item.family] || catalog.unknown;
      var refs = (meta.knowledgeRefs || []).map(function(rel) {
        var abs = path.join(LEARNING_ROOT, rel);
        return { path: rel, exists: fs.existsSync(abs) };
      });
      return Object.assign({}, item, {
        owner: meta.owner,
        remedy: meta.remedy,
        knowledgeCoverage: refs.filter(function(r) { return r.exists; }).length + '/' + refs.length,
        knowledgeRefs: refs,
      });
    });
  }

  function readFamilyDraftIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'failure-families', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readGovernanceDraftIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'governance-tasks', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readImplementationPlanIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'implementation-plans', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readPatchTaskIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'patch-tasks', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readPatchRunIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'patch-runs', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readPatchFeedbackIndex() {
    try {
      var file = path.join(LEARNING_ROOT, 'drafts', 'patch-feedback', 'index.json');
      if (!fs.existsSync(file)) return { items: [] };
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch(e) {
      return { items: [] };
    }
  }

  function readGovernanceDraftBodies(index) {
    var out = {};
    (index && index.items || []).forEach(function(item) {
      try {
        var file = path.join(LEARNING_ROOT, item.file || '');
        if (fs.existsSync(file)) out[item.id] = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch(e) {}
    });
    return out;
  }

  function readDraftBodies(index) {
    var out = {};
    (index && index.items || []).forEach(function(item) {
      try {
        var file = path.join(LEARNING_ROOT, item.file || '');
        if (fs.existsSync(file)) out[item.id] = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch(e) {}
    });
    return out;
  }

  // Refresh apiHealthCache in the background — never awaited from the request
  // path, so the endpoint always returns the last known snapshot instantly.
  function refreshApiHealth() {
    if (apiHealthCache.inflight) return apiHealthCache.inflight;
    apiHealthCache.inflight = Promise.resolve()
      .then(function() { return modelProvider.healthCheck(); })
      .then(function(mpResults) {
        apiHealthCache.data = mpResults || {};
        apiHealthCache.ts = Date.now();
      })
      .catch(function(e) {
        // Keep stale data; just record the error so the dashboard can show it.
        if (!apiHealthCache.data) apiHealthCache.data = {};
        apiHealthCache.data.healthCheckError = e && e.message ? e.message : String(e);
        apiHealthCache.ts = Date.now();
      })
      .then(function() { apiHealthCache.inflight = null; });
    return apiHealthCache.inflight;
  }
  // Prime the cache on init + schedule periodic refresh so the dashboard never
  // sees a cold cache after the server has been running > 30s.
  refreshApiHealth();
  setInterval(refreshApiHealth, 30 * 1000);

  // ─── Core watchdog cycle (shared by interval + manual trigger) ───
  function runWatchdogCycle(trigger) {
    var now = Date.now();
    var issues = [];
    var fixes = [];

    try {
      // Phase 1: SQLite task recovery (orphaned/stale tasks)
      var reclaimResult = taskQueue.reclaimStale(300, 180);
      issues = issues.concat(reclaimResult.issues);
      fixes = fixes.concat(reclaimResult.fixes);

      // Phase 2: Project ↔ Task desync — mapping from task status to the project
      // status that should reflect it. Only sync if the current project status
      // isn't already in the "compatible" set (e.g. a task in 'processing' may
      // legitimately correspond to project 'processing' or 'building').
      // Previously this only covered 3 cases and left cancelled/permanent_fail
      // projects stuck on stale 'processing' — visible as "dashboard didn't sync".
      var DESYNC_GRACE_MS = 60 * 1000;
      // Query all non-cancelled tasks AND a batch of cancelled ones so we can
      // propagate cancellation to project files too.
      var allTasks = taskQueue.listForDashboard(50);
      var cancelledTasks = taskQueue.list('cancelled') || [];
      cancelledTasks.forEach(function(t) {
        allTasks.push({
          taskId: t.id,
          status: t.status,
          updatedAt: t.updated_at,
        });
      });

      // Task → project status mapping. `target` is what the project should
      // become; `compatible` lists project states that are considered already
      // in-sync and should NOT be touched.
      var TASK_TO_PROJECT = {
        pending:     { target: 'submitted', compatible: ['submitted', 'pending', 'assigned'] },
        assigned:    { target: 'processing', compatible: ['assigned', 'processing', 'building', 'developing'] },
        processing:  { target: 'processing', compatible: ['processing', 'building', 'developing', 'preview_ready'] },
        building:    { target: 'building',   compatible: ['building', 'processing', 'preview_ready'] },
        preview_ready:{ target: 'preview_ready', compatible: ['preview_ready', 'reviewing', 'approved', 'committed'] },
        fix_needed:  { target: 'processing', compatible: ['processing', 'building', 'preview_ready'] },
        failed:      { target: 'failed',     compatible: ['failed'] },
        done:        { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        cua_passed:  { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        completed:   { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        cancelled:   { target: 'cancelled',  compatible: ['cancelled', 'committed'] },
      };

      allTasks.forEach(function(t) {
        var proj = readProject(t.taskId);
        if (!proj) return;
        var age = t.updatedAt ? now - new Date(t.updatedAt + 'Z').getTime() : 0;
        // Cancelled tasks should sync immediately (no grace period — manual
        // cancellations need to propagate to the UI within one watchdog cycle).
        if (t.status !== 'cancelled' && age < DESYNC_GRACE_MS) return;

        var mapping = TASK_TO_PROJECT[t.status];
        if (!mapping) return;
        if (mapping.compatible.indexOf(proj.status) >= 0) return;

        issues.push('[F14-desync] Project ' + t.taskId + ' "' + proj.status + '" but task "' + t.status + '"');
        projectSM.forceTransition(proj, mapping.target, 'watchdog');
        proj.statusMessage = '[watchdog] Synced: task was ' + t.status;
        writeProject(proj);
        fixes.push('[fix] Project ' + t.taskId + ' → ' + mapping.target + ' (task=' + t.status + ')');
      });

      // Phase 3: Kill zombie child processes
      try {
        var execSync = require('child_process').execSync;
        var psOut = execSync("ps -eo pid,etimes,args 2>/dev/null | grep -E 'claude.*--print.*--max-budget|codex.*exec' | grep -v grep || true",
          { encoding: 'utf-8', timeout: 5000 });
        psOut.trim().split('\n').filter(Boolean).forEach(function(line) {
          var parts = line.trim().split(/\s+/);
          var pid = parseInt(parts[0]);
          var elapsedSec = parseInt(parts[1]);
          if (isNaN(pid) || isNaN(elapsedSec)) return;
          if (elapsedSec > 900) {
            issues.push('[F10-zombie] PID ' + pid + ' running ' + Math.round(elapsedSec/60) + 'min');
            try {
              process.kill(pid, 'SIGTERM');
              fixes.push('[fix] SIGTERM → PID ' + pid);
            } catch(e) {}
          }
        });
      } catch(e) {}

      // Phase 4: Infrastructure checks
      try {
        var execSync3 = require('child_process').execSync;
        var buildUrl = process.env.LINUX_BUILD_URL || 'http://127.0.0.1:18860';
        var buildCheck = execSync3('curl -s --max-time 3 ' + buildUrl + '/health 2>/dev/null || echo "FAIL"',
          { encoding: 'utf-8', timeout: 5000 }).trim();
        if (buildCheck === 'FAIL' || !buildCheck.includes('ok')) {
          issues.push('[F12-build] Build service (' + buildUrl + ') is unreachable');
          // NOTE: build service is run externally (supervisor/systemd), not pm2.
          // Do not attempt pm2 restart — it does not exist as a pm2 process.
        }
      } catch(e) {}

      // Phase 5: PM2 crash-loop detection
      // Use unstable_restarts (pm2 increments this only when a child exits
      // within min_uptime). restart_time is the lifetime counter — it accrues
      // across weeks of legitimate manual starts/stops/deploys and does NOT
      // indicate a crash loop. Using restart_time caused worker-1 to be stopped
      // on every restart once its lifetime count passed 20 (2026-04-20 bug).
      try {
        var execSync4 = require('child_process').execSync;
        var pm2Json = execSync4('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
        var pm2Data = JSON.parse(pm2Json);
        pm2Data.forEach(function(p) {
          if (p.name.indexOf('linux-worker') !== 0) return;
          var env = p.pm2_env || {};
          if (env.status !== 'online') return;
          var unstable = env.unstable_restarts || 0;
          var uptimeMs = Date.now() - (env.pm_uptime || Date.now());
          // Crash-loop = many unstable restarts AND still starting up
          if (unstable > 5 && uptimeMs < 300000) {
            issues.push('[F9-crash-loop] ' + p.name + ' unstable_restarts=' + unstable + ' within 5min');
            try {
              execSync4('pm2 stop ' + p.name + ' 2>/dev/null', { timeout: 5000 });
              fixes.push('[fix] Stopped crash-looping ' + p.name);
            } catch(e) {}
          }
        });
      } catch(e) {}

      // Phase 6: Regression watcher (L3)
      // Scan latest 100 metrics records. For each failure fingerprint we
      // compute, ask bindKnowledge if it has a resolvedBy/resolvedAt. If a
      // record's timestamp is AFTER the resolvedAt (i.e. "fixed 2 days ago but
      // happened again today"), flag it as a regression.
      //
      // Regressions are persisted to server-data/regressions.json (upsert
      // by fingerprint) and optionally pushed to 飞书 via the existing
      // feishu-notify.js bot. Throttled: we only fire a 飞书 alert once per
      // 30 minutes per fingerprint to avoid paging spam.
      try {
        var metricsModule = require('../engine/metrics.cjs');
        var fpModule = require('../engine/failure-fingerprint.cjs');
        var records = metricsModule.loadRecords(100);
        var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
        var existing = [];
        var regLoadOk = true;
        try {
          if (fs.existsSync(regFile)) {
            var regParsed = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
            if (regParsed != null && !Array.isArray(regParsed)) {
              throw new Error('expected array, got ' + typeof regParsed);
            }
            existing = regParsed || [];
          }
        } catch(e) {
          regLoadOk = false;
          issues.push('[error] ' + regFile + ' 损坏 (' + e.message + '),写入已跳过以保留现场。建议: cp "' + regFile + '" "' + regFile + '.corrupt.' + Date.now() + '" 再人工排查');
        }
        var byFp = {};
        existing.forEach(function(r) { byFp[r.fingerprint] = r; });

        var failedRecords = records.filter(function(r) { return !r.success && r.failReason; });
        var fpToRecords = {};
        failedRecords.forEach(function(fr) {
          var fp = metricsModule.normalizeFingerprint(fr.failReason);
          if (!fpToRecords[fp]) fpToRecords[fp] = [];
          fpToRecords[fp].push(fr);
        });

        var NOTIFY_THROTTLE_MS = 30 * 60 * 1000;
        var changed = false;

        Object.keys(fpToRecords).forEach(function(fp) {
          var frs = fpToRecords[fp];
          var kb;
          try { kb = fpModule.bindKnowledge(fp); } catch(e) { return; }
          if (!kb.resolvedBy || !kb.resolvedAt) return;
          var resolvedAtMs = new Date(kb.resolvedAt).getTime();
          if (!resolvedAtMs) return;
          // Find records that occurred strictly AFTER resolvedAt
          var postFix = frs.filter(function(r) {
            return r.timestamp && new Date(r.timestamp).getTime() > resolvedAtMs;
          });
          if (postFix.length === 0) return;

          var latestTs = postFix.reduce(function(acc, r) {
            return !acc || r.timestamp > acc ? r.timestamp : acc;
          }, null);

          var prev = byFp[fp];
          var reg = {
            fingerprint: fp,
            sampleReason: frs[0].failReason.slice(0, 200),
            resolvedBy: kb.resolvedBy,
            resolvedAt: kb.resolvedAt,
            regressedAt: latestTs,
            count: postFix.length,
            firstRegressedAt: prev ? prev.firstRegressedAt || latestTs : latestTs,
            notifiedAt: prev ? prev.notifiedAt : null,
          };
          byFp[fp] = reg;
          changed = true;

          issues.push('[F20-regression] ' + fp.slice(0, 60) + ' (resolved ' + kb.resolvedBy.slice(0,7) + ', ' + postFix.length + ' new hits)');
          fixes.push('[info] Logged regression → server-data/regressions.json');

          // Feishu notification removed 2026-04-17
        });

        if (changed && regLoadOk) {
          try {
            fs.mkdirSync(path.dirname(regFile), { recursive: true });
            fs.writeFileSync(regFile, JSON.stringify(Object.keys(byFp).map(function(k) { return byFp[k]; }), null, 2));
          } catch(e) {}
        }
      } catch(e) {
        issues.push('[error] Regression watcher failed: ' + e.message);
      }

      // Phase 6b: Silent-pass detection — scan successful pipelines for semantic false-passes
      // success:true + zero actions / uniform timing / phase order violations = CUA didn't really verify
      try {
        var spFile = path.join(__dirname, '..', 'server-data', 'silent-passes.json');
        var existingSP = [];
        var spLoadOk = true;
        try {
          if (fs.existsSync(spFile)) {
            var spParsed = JSON.parse(fs.readFileSync(spFile, 'utf-8'));
            if (spParsed != null && !Array.isArray(spParsed)) {
              throw new Error('expected array, got ' + typeof spParsed);
            }
            existingSP = spParsed || [];
          }
        } catch(e) {
          spLoadOk = false;
          issues.push('[error] ' + spFile + ' 损坏 (' + e.message + '),写入已跳过以保留现场。建议: cp "' + spFile + '" "' + spFile + '.corrupt.' + Date.now() + '" 再人工排查');
        }
        var spByTask = {};
        existingSP.forEach(function(sp) { spByTask[sp.taskId] = sp; });

        var successWithSP = records.filter(function(r) { return r.success && r.cuaSilentPass; });
        var newSPCount = 0;
        successWithSP.forEach(function(r) {
          if (spByTask[r.taskId]) return; // already recorded
          spByTask[r.taskId] = {
            taskId: r.taskId,
            timestamp: r.timestamp,
            signals: r.cuaSilentPassSignals || [],
            totalActions: r.cuaTotalActions,
            detectedAt: new Date().toISOString(),
          };
          newSPCount++;
          issues.push('[F21-silent-pass] ' + r.taskId + ': ' + (r.cuaSilentPassSignals || []).join(', '));
        });

        if (newSPCount > 0 && spLoadOk) {
          try {
            fs.writeFileSync(spFile, JSON.stringify(Object.keys(spByTask).map(function(k) { return spByTask[k]; }), null, 2));
          } catch(e) {}
          // Feishu alert removed 2026-04-17
          fixes.push('[info] Recorded ' + newSPCount + ' new silent-pass(es) → server-data/silent-passes.json');
        }
      } catch(e) {
        issues.push('[error] Silent-pass watcher failed: ' + e.message);
      }

      // Phase 7: Auto-fix cycle (L5 generate recipe + L6 apply + L7 learn)
      // Async — fire-and-forget so watchdog doesn't block on sub-agent spawns.
      // Results logged to console + server-data/auto-fix-state.json.
      try {
        var metricsForFix = require('../engine/metrics.cjs');
        var autoFixEngine = require('../engine/auto-fix.cjs');
        var fixSummary = metricsForFix.getMetricsSummary(50);
        if (fixSummary.topFailReasons && fixSummary.topFailReasons.length > 0) {
          // Run async — don't await, don't block watchdog return
          autoFixEngine.runAutoFixCycle(fixSummary.topFailReasons).then(function(result) {
            if (result.attempted > 0) {
              console.log('[watchdog][Phase7] Auto-fix: attempted=' + result.attempted +
                ' applied=' + result.applied + ' generated=' + result.generated +
                ' skipped=' + result.skipped);
              (result.details || []).forEach(function(d) { console.log('[watchdog][Phase7] ' + d); });
            }
          }).catch(function(e) {
            console.error('[watchdog][Phase7] Auto-fix error: ' + e.message);
          });
          fixes.push('[info] Phase 7 auto-fix cycle dispatched (' + fixSummary.topFailReasons.length + ' fingerprints)');
        }
      } catch(e) {
        issues.push('[error] Phase 7 auto-fix init failed: ' + e.message);
      }

      // Phase 8: Autonomous learning scans (cheap, synchronous)
      // - scanPendingFixes: escalations from auto-fix state + unmatched fingerprints
      // - computeRecipeStats: aggregate recipe success/revert counts
      // - scanPendingRules: rate-limited (6h), mines Codex warnings for new rules
      try {
        var learning = require('../engine/learning.cjs');
        var exportLearning = require('../engine/export-learning.cjs');
        var promoteDrafts = require('../engine/promote-learning-drafts.cjs');
        var pf = learning.scanPendingFixes(fixSummary && fixSummary.topFailReasons);
        var rs = learning.computeRecipeStats();
        var pr = learning.scanPendingRules(); // internally rate-limited
        exportLearning.exportAll();
        promoteDrafts.promoteDrafts();
        fixes.push('[info] Phase 8 learning: pending-fixes=' + pf.count +
          ' recipe-stats=' + rs.count +
          (pr.skipped ? ' pending-rules=skipped(rate-limit)' : ' pending-rules=' + pr.count) +
          ' export=ok drafts=ok');
      } catch(e) {
        issues.push('[error] Phase 8 learning failed: ' + e.message);
      }

    } catch (e) {
      issues.push('[error] Watchdog cycle error: ' + e.message);
    }

    return { trigger: trigger, timestamp: new Date().toISOString(), issues: issues, fixes: fixes, healthy: issues.length === 0, issueCount: issues.length, fixCount: fixes.length };
  }

  return {
    getDashboard: function(req, res, body, params) {
      var stats = taskQueue.stats();
      sendJSON(res, stats);
    },

    getWorkers: function(req, res, body, params) {
      var rawWorkers = taskQueue.getWorkers();
      var workers = rawWorkers.map(function(w) {
        var ct = w.current_task;
        var parsedTask = null;
        if (ct) {
          try { parsedTask = JSON.parse(ct); } catch(e) { parsedTask = ct; }
        }
        return {
          workerId: w.worker_id,
          status: w.status || 'unknown',
          currentTask: parsedTask ? (typeof parsedTask === 'string' ? parsedTask : parsedTask.taskId || parsedTask) : null,
          currentTaskName: parsedTask && parsedTask.projectName ? parsedTask.projectName : null,
          ip: w.ip || null,
          port: w.port || null,
          lastHeartbeat: w.last_seen ? new Date(w.last_seen + 'Z').getTime() : null,
          registeredAt: w.last_seen ? new Date(w.last_seen + 'Z').getTime() : null,
          uptime: w.uptime || 0,
        };
      });
      sendJSON(res, { workers: workers });
    },

    getTasks: function(req, res, body, params) {
      var u = new URL(req.url, 'http://localhost');
      var limit = parseInt(u.searchParams.get('limit')) || 30;
      var rawTasks = taskQueue.listForDashboard(limit);
      var tasks = rawTasks.map(function(t) {
        return {
          taskId: t.taskId,
          projectName: t.projectName || '-',
          status: t.status || 'pending',
          statusMessage: t.statusMessage || null,
          workerId: t.workerId || null,
          progress: 0,
          createdAt: t.createdAt ? new Date(t.createdAt + 'Z').getTime() : null,
          updatedAt: t.updatedAt ? new Date(t.updatedAt + 'Z').getTime() : null,
        };
      });
      sendJSON(res, { tasks: tasks });
    },

    getDashboardStats: function(req, res, body, params) {
      var now = Date.now();
      var onlineThreshold = 90000;

      // Get comprehensive stats from TaskQueue
      var dbStats = taskQueue.dashboardStats();

      // Project stats (still from filesystem)
      var projectStats = { total: 0, editing: 0, submitted: 0, preview_ready: 0, reviewing: 0, approved: 0, feedback: 0, committed: 0, failed: 0 };
      try {
        if (fs.existsSync(PROJECTS_DIR)) {
          fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
            try {
              var p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
              projectStats.total++;
              var s = p.status || 'editing';
              if (projectStats[s] !== undefined) projectStats[s]++;
              else projectStats[s] = 1;
            } catch(e) {}
          });
        }
      } catch(e) {}

      // Parse stats (unchanged)
      var avgTimeMs = parseStats.success > 0 ? Math.round(parseStats.totalTimeMs / parseStats.success) : 0;
      var last24h = parseStats.history.filter(function(h) { return h.timestamp > now - 86400000; });
      var last24hSuccess = last24h.filter(function(h) { return h.success; }).length;
      var last24hFailed = last24h.filter(function(h) { return !h.success; }).length;
      var successRate = parseStats.total > 0 ? Math.round(parseStats.success / parseStats.total * 100) : 0;

      // Quality gate stats from recent tasks
      var qualityStats = { reviewPassed: 0, reviewFailed: 0, quickTestPassed: 0, quickTestFailed: 0, cuaPassed: 0, cuaFailed: 0, totalCuaRounds: 0, cuaCount: 0 };
      (dbStats.recentTasks || []).forEach(function(t) {
        var meta = {};
        try { meta = JSON.parse(t.metadataJson || '{}'); } catch(e) {}
        if (meta.reviewResult === 'pass') qualityStats.reviewPassed++;
        else if (meta.reviewResult === 'fail') qualityStats.reviewFailed++;
        if (meta.quickTestResult === 'pass') qualityStats.quickTestPassed++;
        else if (meta.quickTestResult === 'fail') qualityStats.quickTestFailed++;
        if (meta.cuaResult === 'pass') qualityStats.cuaPassed++;
        else if (meta.cuaResult === 'fail') qualityStats.cuaFailed++;
        if (meta.cuaRetries > 0) { qualityStats.totalCuaRounds += meta.cuaRetries; qualityStats.cuaCount++; }
      });

      // Map worker list for backward compatibility
      var workerList = (dbStats.workers.list || []).map(function(w) {
        var lastHbMs = w.lastSeen ? new Date(w.lastSeen + 'Z').getTime() : null;
        var isOnline = lastHbMs && (now - lastHbMs) < onlineThreshold;
        var ct = w.currentTask;
        var parsedTask = null;
        if (ct) { try { parsedTask = JSON.parse(ct); } catch(e) { parsedTask = ct; } }
        return {
          workerId: w.workerId,
          status: isOnline ? (w.status || 'idle') : 'offline',
          currentTask: parsedTask ? (typeof parsedTask === 'string' ? parsedTask : parsedTask.taskId || null) : null,
          currentTaskName: parsedTask && parsedTask.projectName ? parsedTask.projectName : null,
          lastHeartbeat: lastHbMs,
          uptime: w.uptime || 0,
        };
      });

      // Map recent tasks for backward compat
      var recentTasks = (dbStats.recentTasks || []).slice(0, 10).map(function(t) {
        var meta = {};
        try { meta = JSON.parse(t.metadataJson || '{}'); } catch(e) {}
        var timeline = [];
        try { timeline = JSON.parse(t.timelineJson || '[]'); } catch(e) {}
        return {
          taskId: t.taskId,
          projectName: t.projectName || '-',
          status: t.status || 'pending',
          statusMessage: t.statusMessage || null,
          previewUrl: t.previewUrl || null,
          workerId: t.workerId || null,
          progress: 0,
          createdAt: t.createdAt ? new Date(t.createdAt + 'Z').getTime() : null,
          updatedAt: t.updatedAt ? new Date(t.updatedAt + 'Z').getTime() : null,
          timeline: timeline.slice(-20),
          reviewResult: meta.reviewResult || null,
          quickTestResult: meta.quickTestResult || null,
          cuaResult: meta.cuaResult || null,
          cuaRetries: meta.cuaRetries || 0,
        };
      });

      sendJSON(res, {
        workers: {
          total: dbStats.workers.total,
          online: dbStats.workers.online,
          offline: dbStats.workers.offline,
          list: workerList,
        },
        tasks: dbStats.tasks,
        recentTasks: recentTasks,
        projects: projectStats,
        quality: {
          reviewPassed: qualityStats.reviewPassed,
          reviewFailed: qualityStats.reviewFailed,
          quickTestPassed: qualityStats.quickTestPassed,
          quickTestFailed: qualityStats.quickTestFailed,
          cuaPassed: qualityStats.cuaPassed,
          cuaFailed: qualityStats.cuaFailed,
          avgCuaRounds: qualityStats.cuaCount > 0 ? Math.round(qualityStats.totalCuaRounds / qualityStats.cuaCount * 10) / 10 : 0,
        },
        parse: {
          total: parseStats.total,
          success: parseStats.success,
          failed: parseStats.failed,
          successRate: successRate,
          avgTimeMs: avgTimeMs,
          avgTimeSec: Math.round(avgTimeMs / 1000),
          last24h: { success: last24hSuccess, failed: last24hFailed },
          recentHistory: parseStats.history.slice(-10).reverse(),
        },
      });
    },

    getApiHealth: function(req, res, body, params) {
      // Serve from cache (populated by refreshApiHealth on init + 30s interval).
      // If the cache is stale, trigger a background refresh but still return the
      // stale data — never block the request. First load after server start may
      // get an empty snapshot; the periodic refresh backfills within ~6s.
      var results = {};
      if (apiHealthCache.data) Object.assign(results, apiHealthCache.data);
      var age = Date.now() - apiHealthCache.ts;
      if (age > API_HEALTH_TTL_MS) refreshApiHealth();
      results._cachedAt = apiHealthCache.ts || null;
      results._cacheAgeMs = apiHealthCache.ts ? age : null;
      results.server = { status: 'ok', uptimeMs: process.uptime() * 1000, uptimeHuman: Math.round(process.uptime() / 3600) + 'h' };
      sendJSON(res, results);
    },

    getWatchdogStatus: function(req, res, body, params) {
      try {
        var now = Date.now();
        var report = {
          timestamp: new Date().toISOString(),
          tasks: [], workers: [], issues: [], infrastructure: {},
          healthy: true
        };

        // ── Tasks from SQLite ──
        var allTasks = taskQueue.listForDashboard(50);
        allTasks.forEach(function(t) {
          var proj = readProject(t.taskId);
          var age = t.updatedAt ? Math.round((now - new Date(t.updatedAt + 'Z').getTime()) / 1000) : -1;
          var entry = {
            taskId: t.taskId,
            projectName: t.projectName || '?',
            taskStatus: t.status,
            projectStatus: proj ? proj.status : '?',
            assignedTo: t.workerId || null,
            failCount: t.failCount || 0,
            ageSeconds: age,
            statusMessage: (t.statusMessage || '').slice(0, 120),
            synced: true
          };
          // Check desync
          if (proj) {
            var taskS = t.status, projS = proj.status;
            var validCombos = {
              pending: ['submitted'], assigned: ['processing'], processing: ['processing', 'building'],
              building: ['processing', 'building'], failed: ['failed'],
              preview_ready: ['preview_ready', 'reviewing'],
              done: ['reviewing', 'committed', 'done'], cua_passed: ['reviewing']
            };
            var allowed = validCombos[taskS] || [];
            if (taskS !== projS && allowed.indexOf(projS) === -1) {
              entry.synced = false;
              entry.desyncDetail = 'task=' + taskS + ' project=' + projS;
            }
          }
          report.tasks.push(entry);
        });

        // ── Workers from SQLite ──
        var rawWorkers = taskQueue.getWorkers();
        rawWorkers.forEach(function(w) {
          var lastSeenMs = w.last_seen ? new Date(w.last_seen + 'Z').getTime() : 0;
          var ageS = Math.round((now - lastSeenMs) / 1000);
          report.workers.push({
            workerId: w.worker_id,
            heartbeatStatus: w.status,
            currentTask: w.current_task,
            alive: ageS < 180,
            lastSeenAgo: ageS + 's'
          });
        });

        // ── Infrastructure ──
        try {
          var execSync = require('child_process').execSync;
          var pm2Json = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
          var pm2Data = JSON.parse(pm2Json);
          var stoppedWorkers = pm2Data.filter(function(p) {
            return p.name.indexOf('linux-worker') === 0 && p.pm2_env && p.pm2_env.status === 'stopped';
          }).map(function(p) { return p.name; });
          report.infrastructure.stoppedWorkers = stoppedWorkers;
          report.infrastructure.totalWorkerProcesses = pm2Data.filter(function(p) { return p.name.indexOf('linux-worker') === 0; }).length;
          report.infrastructure.activeWorkerProcesses = pm2Data.filter(function(p) {
            return p.name.indexOf('linux-worker') === 0 && p.pm2_env && p.pm2_env.status === 'online';
          }).length;
        } catch(e) {
          report.infrastructure.pm2Error = e.message;
        }
        try {
          var execSync2 = require('child_process').execSync;
          var zombieOut = execSync2("ps -eo pid,etimes,args 2>/dev/null | grep -E 'claude.*--print.*--max-budget|codex.*exec' | grep -v grep || true", { encoding: 'utf-8', timeout: 5000 });
          var zombies = zombieOut.trim().split('\n').filter(Boolean).map(function(line) {
            var p = line.trim().split(/\s+/);
            return { pid: parseInt(p[0]), runningSec: parseInt(p[1]), cmd: p.slice(2).join(' ').slice(0, 80) };
          });
          report.infrastructure.childProcesses = zombies;
        } catch(e) {}

        // ── Diagnose Issues ──
        report.tasks.forEach(function(t) {
          if (!t.synced) report.issues.push({ type: 'desync', taskId: t.taskId, detail: t.desyncDetail });
        });
        if (report.infrastructure.childProcesses) {
          report.infrastructure.childProcesses.forEach(function(z) {
            if (z.runningSec > 900) report.issues.push({ type: 'zombie-process', pid: z.pid, detail: 'running ' + Math.round(z.runningSec/60) + 'min' });
          });
        }

        report.healthy = report.issues.length === 0;
        sendJSON(res, report);
      } catch (e) {
        sendJSON(res, { error: 'Watchdog status failed: ' + e.message }, 500);
      }
    },

    runWatchdog: function(req, res, body, params) {
      try {
        console.log('[Watchdog] Manual run triggered via API');
        var result = runWatchdogCycle('manual');
        sendJSON(res, result);
      } catch (e) {
        sendJSON(res, { error: 'Watchdog run failed: ' + e.message }, 500);
      }
    },

    getPipelineMetrics: function(req, res, body, params) {
      try {
        var u = new URL(req.url, 'http://localhost');
        var lastN = parseInt(u.searchParams.get('last')) || 50;
        var { getMetricsSummary } = require('../engine/metrics.cjs');
        var { bindKnowledge } = require('../engine/failure-fingerprint.cjs');
        var summary = getMetricsSummary(lastN);

        // L2: decorate each top fingerprint with memory/git/recipe binding.
        // Swallow errors per-fingerprint so a git failure doesn't 500 the whole
        // dashboard — we still want the raw metrics to render.
        if (summary.topFailReasons) {
          summary.topFailReasons.forEach(function(fp) {
            try { fp.knowledge = bindKnowledge(fp.fingerprint); }
            catch(e) { fp.knowledge = { error: e.message }; }
          });
        }
        summary.failureFamilyPlaybook = enrichFamiliesWithPlaybook(summary.failureFamilies).slice(0, 8);
        var familyDraftIndex = readFamilyDraftIndex();
        var familyDraftFiles = {};
        (familyDraftIndex.items || []).forEach(function(item) {
          var family = item.family || '';
          if (family) familyDraftFiles[family] = item.file;
        });
        summary.failureFamilyDraftCoverage = (summary.failureFamilyPlaybook || []).map(function(item) {
          return {
            family: item.family,
            draftFile: familyDraftFiles[item.family] || null,
            hasDraft: !!familyDraftFiles[item.family],
          };
        });
        var governanceDraftIndex = readGovernanceDraftIndex();
        var governanceDraftBodies = readGovernanceDraftBodies(governanceDraftIndex);
        summary.governanceDrafts = (governanceDraftIndex.items || []).slice(0, 8).map(function(item) {
          var body = governanceDraftBodies[item.id] || {};
          return Object.assign({}, item, {
            action: body.action || null,
            suggestedTargets: body.suggestedTargets || [],
          });
        });
        summary.implementationPlans = (readImplementationPlanIndex().items || []).slice(0, 8);
        var patchTaskIndex = readPatchTaskIndex();
        var patchTaskBodies = readDraftBodies(patchTaskIndex);
        summary.patchTasks = (patchTaskIndex.items || []).slice(0, 8).map(function(item) {
          var body = patchTaskBodies[item.id] || {};
          return Object.assign({}, item, {
            executionMode: body.executionMode || null,
            primaryTarget: body.primaryTarget || null,
            validationCommands: body.validationCommands || [],
          });
        });
        var patchRunIndex = readPatchRunIndex();
        var patchRunBodies = readDraftBodies(patchRunIndex);
        summary.patchRuns = (patchRunIndex.items || []).slice(0, 8).map(function(item) {
          var body = patchRunBodies[item.id] || {};
          return Object.assign({}, item, {
            primaryTarget: body.primaryTarget || null,
            blockingReason: body.blockingReason || null,
            validationCommands: body.validationCommands || [],
            lastExecution: body.lastExecution || null,
          });
        });
        summary.patchRunHistory = patchRunArchive.readPatchRunIndex(12);
        summary.patchRunSummary = patchRunArchive.getPatchRunSummary(200);
        var patchFeedbackIndex = readPatchFeedbackIndex();
        var patchFeedbackBodies = readDraftBodies(patchFeedbackIndex);
        summary.patchFeedback = (patchFeedbackIndex.items || []).slice(0, 12).map(function(item) {
          var body = patchFeedbackBodies[item.id] || {};
          return Object.assign({}, item, {
            recommendation: body.recommendation || null,
            totalRuns: body.totalRuns || 0,
            resultCounts: body.resultCounts || {},
          });
        });
        summary.patchApprovalQueue = (summary.patchFeedback || []).filter(function(item) {
          return item.queue === 'approval';
        }).slice(0, 8);
        summary.patchEscalations = (summary.patchFeedback || []).filter(function(item) {
          return item.queue === 'escalation';
        }).slice(0, 8);
        var wasteByFamily = {};
        (summary.wasteByFamily || []).forEach(function(item) {
          wasteByFamily[item.family] = parseFloat(item.minutes || '0') || 0;
        });
        var playbookByFamily = {};
        (summary.failureFamilyPlaybook || []).forEach(function(item) {
          playbookByFamily[item.family] = item;
        });
        summary.failureFamilyPriorities = (summary.failureFamilies || []).map(function(item) {
          var family = item.family;
          var playbook = playbookByFamily[family] || null;
          var knowledgeCoverage = playbook ? String(playbook.knowledgeCoverage || '0/0') : '0/0';
          var knowledgeCovered = playbook ? parseInt(knowledgeCoverage.split('/')[0], 10) > 0 : false;
          var hasDraft = !!familyDraftFiles[family];
          var wasteMinutes = wasteByFamily[family] || 0;
          var count = item.count || 0;
          var priority = 'P2';
          var reason = '已有知识覆盖，继续观察';
          if (count >= 3 && wasteMinutes >= 10 && !knowledgeCovered && !hasDraft) {
            priority = 'P0';
            reason = '高频 + 高浪费 + 无知识覆盖';
          } else if (count >= 2 && !knowledgeCovered && hasDraft) {
            priority = 'P1';
            reason = '高频且已有 draft，优先转 curated';
          } else if (count >= 2 && knowledgeCovered && wasteMinutes >= 10) {
            priority = 'P1';
            reason = '已知问题但仍高浪费，优先加强拦截';
          } else if (!knowledgeCovered && !hasDraft) {
            priority = 'P1';
            reason = '已有重复迹象但知识链未覆盖';
          }
          return {
            family: family,
            priority: priority,
            reason: reason,
            count: count,
            pct: item.pct,
            wasteMinutes: wasteMinutes.toFixed(1),
            owner: playbook ? playbook.owner : 'triage',
            remedy: playbook ? playbook.remedy : '分类并补充治理方案',
            knowledgeCoverage: knowledgeCoverage,
            hasDraft: hasDraft,
            draftFile: familyDraftFiles[family] || null,
          };
        }).sort(function(a, b) {
          var order = { P0: 0, P1: 1, P2: 2 };
          if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
          if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
          return (parseFloat(b.wasteMinutes || '0') || 0) - (parseFloat(a.wasteMinutes || '0') || 0);
        }).slice(0, 8);

        // Also load recent failure history from projects
        var projectFailures = [];
        try {
          if (fs.existsSync(PROJECTS_DIR)) {
            fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
              try {
                var p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
                if (p.lastFailure) {
                  projectFailures.push({
                    projectId: p.id,
                    projectName: p.name,
                    status: p.status,
                    lastFailure: p.lastFailure,
                    failureCount: p.failureHistory ? p.failureHistory.length : 0,
                  });
                }
              } catch(e) {}
            });
          }
        } catch(e) {}

        // L3: read regressions.json so the dashboard surfaces active regressions
        // next to the metrics. Written by runWatchdogCycle's regression phase.
        var regressions = [];
        try {
          var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
          if (fs.existsSync(regFile)) {
            var regs = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
            // Only surface regressions from the last 7 days — older ones clutter
            // the dashboard and probably mean the detection rule is too loose
            var weekAgo = Date.now() - 7 * 86400 * 1000;
            regressions = (regs || []).filter(function(r) {
              return r.regressedAt && new Date(r.regressedAt).getTime() > weekAgo;
            });
          }
        } catch(e) {}

        // Load pending commits for dashboard button state
        var pendingCommits = {};
        try {
          var afState = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server-data', 'auto-fix-state.json'), 'utf-8'));
          pendingCommits = afState.pendingCommits || {};
        } catch(e) {}

        // Phase 6b output: semantic silent-pass records from the last 7 days.
        // Mirror the regression 7-day window so the UI stays consistent.
        var silentPasses = [];
        try {
          var spFile = path.join(__dirname, '..', 'server-data', 'silent-passes.json');
          if (fs.existsSync(spFile)) {
            var sps = JSON.parse(fs.readFileSync(spFile, 'utf-8')) || [];
            var weekAgoSP = Date.now() - 7 * 86400 * 1000;
            silentPasses = sps.filter(function(s) {
              var ts = s.detectedAt || s.timestamp;
              return ts && new Date(ts).getTime() > weekAgoSP;
            });
          }
        } catch(e) {}

        var nightMonitor = {
          enabled: false,
          removed: true,
          removedAt: '2026-04-23',
          note: 'night-monitor has been removed; use watchdog/task logs for recovery triage.',
        };

        // Expand failureHistory for projects that have failed — surface the last
        // 5 entries so the dashboard can render a timeline without a second round-trip.
        var projectFailureHistory = {};
        try {
          if (fs.existsSync(PROJECTS_DIR)) {
            projectFailures.forEach(function(pf) {
              try {
                var pj = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, pf.projectId + '.json'), 'utf-8'));
                var hist = (pj.failureHistory || []).slice(-5).reverse();
                if (hist.length > 0) projectFailureHistory[pf.projectId] = hist;
              } catch(e) {}
            });
          }
        } catch(e) {}

        sendJSON(res, {
          pipeline: summary,
          projectFailures: projectFailures,
          projectFailureHistory: projectFailureHistory,
          regressions: regressions,
          silentPasses: silentPasses,
          pendingCommits: pendingCommits,
          nightMonitor: nightMonitor,
        });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    getRegressions: function(req, res, body, params) {
      try {
        var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
        var data = [];
        if (fs.existsSync(regFile)) {
          data = JSON.parse(fs.readFileSync(regFile, 'utf-8')) || [];
        }
        sendJSON(res, { regressions: data, count: data.length });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    runAutoFix: function(req, res, body, params) {
      try {
        var recipeId = params.fingerprintId;
        var stateFile = path.join(__dirname, '..', 'server-data', 'auto-fix-state.json');

        // Write loading state BEFORE spawning sub-agent (survives page refresh)
        try {
          var st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (!st.pendingCommits) st.pendingCommits = {};
          st.pendingCommits[recipeId] = { state: 'loading', at: Date.now() };
          fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
        } catch(e) {}

        var autoFix = require('../engine/auto-fix.cjs');
        autoFix.applyRecipe(recipeId)
          .then(function(result) {
            // Update state to done or error
            try {
              var st2 = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              if (!st2.pendingCommits) st2.pendingCommits = {};
              if (result.ok) {
                st2.pendingCommits[recipeId] = { state: 'done', filesChanged: result.filesChanged, diagnosis: result.diagnosis, at: Date.now() };
              } else {
                st2.pendingCommits[recipeId] = { state: 'error', error: result.error || 'unknown', at: Date.now() };
              }
              fs.writeFileSync(stateFile, JSON.stringify(st2, null, 2));
            } catch(e) {}
            sendJSON(res, result);
          })
          .catch(function(e) {
            try {
              var st3 = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
              if (!st3.pendingCommits) st3.pendingCommits = {};
              st3.pendingCommits[recipeId] = { state: 'error', error: e.message, at: Date.now() };
              fs.writeFileSync(stateFile, JSON.stringify(st3, null, 2));
            } catch(e2) {}
            sendJSON(res, { error: e.message }, 500);
          });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * POST /api/auto-fix-commit
     * Body: { recipeId, filesChanged, diagnosis }
     * Commits the already-applied auto-fix patch with a standardized message.
     */
    commitAutoFix: function(req, res, body) {
      try {
        var data = typeof body === 'string' ? JSON.parse(body) : (body || {});
        var recipeId = data.recipeId;
        var filesChanged = data.filesChanged || [];
        var diagnosis = data.diagnosis || '';
        if (!recipeId) return sendJSON(res, { error: 'missing recipeId' }, 400);
        if (!filesChanged.length) return sendJSON(res, { error: 'no files to commit' }, 400);

        var REPO = path.join(__dirname, '..');
        var { execSync } = require('child_process');

        // Stage only the specific files
        for (var i = 0; i < filesChanged.length; i++) {
          execSync('git add ' + JSON.stringify(filesChanged[i]), { cwd: REPO, timeout: 5000 });
        }

        // Build commit message
        var msg = 'auto-fix(' + recipeId + '): ' + diagnosis.slice(0, 80) + '\n\n'
          + 'Files: ' + filesChanged.join(', ') + '\n'
          + 'Applied via dashboard auto-fix button.\n\n'
          + 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>';

        execSync('git commit -m ' + JSON.stringify(msg), { cwd: REPO, timeout: 10000, encoding: 'utf-8' });
        var hash = execSync('git rev-parse --short HEAD', { cwd: REPO, encoding: 'utf-8' }).trim();

        // Clear from pendingCommits
        try {
          var stateFile = path.join(REPO, 'server-data', 'auto-fix-state.json');
          var state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (state.pendingCommits && state.pendingCommits[recipeId]) {
            delete state.pendingCommits[recipeId];
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
          }
        } catch(e) {}

        console.log('[auto-fix-commit] Committed ' + recipeId + ' → ' + hash);
        sendJSON(res, { ok: true, commitHash: hash, recipeId: recipeId });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * POST /api/dashboard/reset-stats
     * Body (optional): { parse?:bool, tasks?:bool, metrics?:bool, archive?:bool }
     * Defaults: all true except tasks (requires explicit opt-in — destructive).
     *
     * Clears in-memory + on-disk "historical" counters without restarting the server.
     * Safe because: parseStats is mutated by reference (shared with server.cjs);
     * cancelled tasks are deleted directly via SQL; metrics file is renamed, not deleted.
     *
     * IMPORTANT: we NEVER delete the currently-running task. It's detected by status
     * filter (status NOT IN ('cancelled','completed','failed')) — anything mid-pipeline
     * is preserved.
     */
    resetStats: function(req, res, body, params) {
      var opts = {};
      if (body) {
        try { opts = JSON.parse(body) || {}; } catch(e) { opts = {}; }
      }
      if (opts.parse === undefined) opts.parse = true;
      if (opts.metrics === undefined) opts.metrics = true;
      if (opts.archive === undefined) opts.archive = true;
      // tasks is OPT-IN (explicit) because deleting DB rows is more destructive
      if (opts.tasks === undefined) opts.tasks = false;

      var report = {};

      // 1. parseStats — mutate in place so both memory & disk update
      if (opts.parse) {
        try {
          parseStats.total = 0;
          parseStats.success = 0;
          parseStats.failed = 0;
          parseStats.totalTimeMs = 0;
          parseStats.history.length = 0;
          fs.writeFileSync(config.PARSE_STATS_FILE, JSON.stringify(parseStats, null, 2));
          report.parse = 'reset (in-memory + disk)';
        } catch(e) {
          report.parse = 'error: ' + e.message;
        }
      }

      // 2. Cancelled task rows — opt-in only
      if (opts.tasks) {
        try {
          var db = taskQueue.db;
          // Keep anything that could still be running (processing/pending/etc.)
          var terminal = ['cancelled', 'completed', 'failed'];
          var placeholders = terminal.map(function() { return '?'; }).join(',');
          var histStmt = db.prepare(
            'DELETE FROM task_history WHERE task_id IN (SELECT id FROM tasks WHERE status IN (' + placeholders + '))'
          );
          var taskStmt = db.prepare(
            'DELETE FROM tasks WHERE status IN (' + placeholders + ')'
          );
          var deletedHistory = histStmt.run.apply(histStmt, terminal).changes;
          var deletedTasks = taskStmt.run.apply(taskStmt, terminal).changes;
          report.tasks = 'deleted ' + deletedTasks + ' tasks, ' + deletedHistory + ' history rows';
        } catch(e) {
          report.tasks = 'error: ' + e.message;
        }
      }

      // 3. pipeline-metrics.jsonl → archive (rename, never delete)
      if (opts.metrics) {
        try {
          var metricsFile = path.join(__dirname, '..', 'server-data', 'metrics', 'pipeline-metrics.jsonl');
          var metricsMod = require('../engine/metrics.cjs');
          metricsMod.writeBaselineMeta({
            startedAt: new Date().toISOString(),
            reason: 'dashboard-reset-stats',
          });
          if (fs.existsSync(metricsFile)) {
            var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            fs.renameSync(metricsFile, metricsFile + '.bak.' + stamp);
            report.metrics = 'archived to pipeline-metrics.jsonl.bak.' + stamp;
          } else {
            report.metrics = 'no file to archive';
          }
          report.baseline = 'reset at ' + new Date().toISOString();
          // Also clear regressions.json since stale resolvedBy links confuse L3
          var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
          if (fs.existsSync(regFile)) {
            fs.writeFileSync(regFile, '[]');
            report.regressions = 'reset to []';
          }
        } catch(e) {
          report.metrics = 'error: ' + e.message;
        }
      }

      sendJSON(res, { ok: true, report: report, note: 'tasks deletion is opt-in via body {"tasks":true}' });
    },

    /**
     * GET /api/dashboard/task-log/:taskId
     * Returns { taskId, pipeline[], silentPass[], modelFatal[], autoFix[] }.
     * Auto-fix entries come from the global index filtered by fingerprint →
     * taskId correlation kept in the pipeline stream (fallback: return empty
     * list — UI shows "no attempts for this task").
     */
    getTaskLogArchive: function(req, res, body, params) {
      try {
        var archiveWriter = require('../engine/archive-writer.cjs');
        var taskId = params.taskId;
        if (!taskId) return sendJSON(res, { error: 'missing taskId' }, 400);
        var u = new URL(req.url, 'http://localhost');
        var limit = parseInt(u.searchParams.get('limit')) || 500;
        var data = archiveWriter.readTaskArchive(taskId, limit);

        // Correlate auto-fix attempts to this task by scanning pipeline events
        // for auto-fix-applied markers AND by fingerprint overlap. Cheap O(index),
        // bounded by limit.
        var pipelineFps = {};
        (data.pipeline || []).forEach(function(p) {
          if (p && p.fingerprint) pipelineFps[p.fingerprint] = true;
        });
        var autoFixIndex = archiveWriter.readAutoFixIndex(500);
        var relatedFixes = autoFixIndex.filter(function(af) {
          return af && af.fingerprint && pipelineFps[af.fingerprint];
        });
        data.autoFix = relatedFixes;
        sendJSON(res, data);
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * GET /api/dashboard/auto-fix-archive
     *   ?recipeId=&hash= → return single attempt JSON
     *   (no params)      → return index (latest 100)
     */
    getAutoFixArchive: function(req, res, body, params) {
      try {
        var archiveWriter = require('../engine/archive-writer.cjs');
        var u = new URL(req.url, 'http://localhost');
        var recipeId = u.searchParams.get('recipeId');
        var hash = u.searchParams.get('hash');
        var limit = parseInt(u.searchParams.get('limit')) || 100;
        if (recipeId && hash) {
          var attempt = archiveWriter.readAutoFixAttempt(recipeId, hash);
          if (!attempt) return sendJSON(res, { error: 'attempt not found' }, 404);
          return sendJSON(res, attempt);
        }
        sendJSON(res, { attempts: archiveWriter.readAutoFixIndex(limit) });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * GET /api/dashboard/model-fatal-index?limit=100
     */
    getModelFatalIndex: function(req, res, body, params) {
      try {
        var archiveWriter = require('../engine/archive-writer.cjs');
        var u = new URL(req.url, 'http://localhost');
        var limit = parseInt(u.searchParams.get('limit')) || 100;
        sendJSON(res, { entries: archiveWriter.readModelFatalIndex(limit) });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * GET /api/learning
     * Unified accessor for pending-fixes + pending-rules + recipe-stats.
     */
    getLearning: function(req, res, body, params) {
      try {
        var learning = require('../engine/learning.cjs');
        sendJSON(res, learning.getLearningSummary());
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * POST /api/learning/scan-rules
     * Force-run scanPendingRules bypass the 6h rate limit (manual trigger).
     */
    runScanRules: function(req, res, body, params) {
      try {
        var learning = require('../engine/learning.cjs');
        var result = learning.scanPendingRules({ force: true });
        sendJSON(res, result);
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * POST /api/learning/promote-rule  { id, notes? }
     * Marks a pending-rule as promoted so humans remember it was approved.
     * Does NOT auto-merge into static-check.cjs (that's intentionally manual —
     * rule regex needs human review per project-p0p1_batch_20260421 memory).
     * The rule body is copied into server-data/promoted-rules.json for
     * inclusion in the next static-check.cjs patch commit.
     */
    promoteRule: function(req, res, body, params) {
      try {
        var data = typeof body === 'string' ? (body ? JSON.parse(body) : {}) : (body || {});
        var id = data.id;
        var notes = data.notes || '';
        if (!id) return sendJSON(res, { error: 'id required' }, 400);
        var learning = require('../engine/learning.cjs');
        var summary = learning.getLearningSummary();
        var rule = (summary.pendingRules.items || []).filter(function(r) { return r.id === id; })[0];
        if (!rule) return sendJSON(res, { error: 'rule not found' }, 404);
        var promotedFile = path.join(__dirname, '..', 'server-data', 'promoted-rules.json');
        var existing = [];
        try { existing = JSON.parse(fs.readFileSync(promotedFile, 'utf-8')); } catch(e) {}
        existing.push({
          id: id,
          promotedAt: new Date().toISOString(),
          notes: notes,
          rule: rule,
        });
        fs.writeFileSync(promotedFile, JSON.stringify(existing, null, 2));
        sendJSON(res, { ok: true, id: id, totalPromoted: existing.length });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    // Expose for server.cjs interval usage
    runWatchdogCycle: runWatchdogCycle,
  };
};
