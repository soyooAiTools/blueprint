/**
 * Watchdog — stale task recovery + periodic health checks
 *
 * Extracted from server.cjs to keep the harness thin.
 * Call initWatchdog(deps) once after server startup.
 */

var STALE_INTERVAL_MS = 60000;
var WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Start both the stale-recovery timer and the watchdog timer.
 *
 * @param {object} deps
 * @param {TaskQueue} deps.taskQueue
 * @param {Function} deps.readProject
 * @param {Function} deps.writeProject
 * @param {object}   deps.projectSM — state machine with forceTransition()
 * @param {Function} deps.runWatchdogCycle — from dashboard handlers
 */
function initWatchdog(deps) {
  var taskQueue = deps.taskQueue;
  var readProject = deps.readProject;
  var writeProject = deps.writeProject;
  var projectSM = deps.projectSM;
  var runWatchdogCycle = deps.runWatchdogCycle;

  // --- Stale Task Recovery (every 60s) ---
  setInterval(function() {
    try {
      var result = taskQueue.reclaimStale(900, 1200);
      if (result.count > 0) {
        console.log('[Stale Recovery] Reclaimed ' + result.count + ' stale task(s)');
        result.fixes.forEach(function(f) { console.log('[Stale Recovery]   ' + f); });
        result.fixes.forEach(function(f) {
          var taskIdMatch = f.match(/\] (\S+) ->/);
          if (taskIdMatch) {
            var staleProject = readProject(taskIdMatch[1]);
            if (staleProject && staleProject.status === 'processing') {
              projectSM.forceTransition(staleProject, 'submitted', 'stale-recovery');
              staleProject.statusMessage = '[watchdog] Task reclaimed, retrying';
              writeProject(staleProject);
            }
          }
        });
      }
    } catch (e) { console.warn('[Stale Recovery] Error: ' + e.message); }
  }, STALE_INTERVAL_MS);

  // --- Task Watchdog v2 (every 2min) ---
  var watchdogRuns = 0;
  setInterval(function() {
    watchdogRuns++;
    var result = runWatchdogCycle('auto-' + watchdogRuns);
    if (result.issues.length > 0) {
      console.log('[Watchdog] Run #' + watchdogRuns + ': ' + result.issues.length + ' issue(s), ' + result.fixes.length + ' fix(es)');
      result.issues.forEach(function(i) { console.log('[Watchdog]   ' + i); });
      result.fixes.forEach(function(f) { console.log('[Watchdog]   ' + f); });
    }
    if (result.issues.length === 0 && watchdogRuns % 15 === 0) {
      console.log('[Watchdog] Run #' + watchdogRuns + ' — all clear');
    }
  }, WATCHDOG_INTERVAL_MS);

  console.log('[Watchdog] v2 (SQLite) initialized — interval ' + (WATCHDOG_INTERVAL_MS / 1000) + 's');
}

module.exports = { initWatchdog: initWatchdog };
