/**
 * Lifecycle — graceful shutdown handler
 *
 * Extracted from server.cjs. Call initGracefulShutdown(deps) once after server startup.
 */

/**
 * @param {object} deps
 * @param {http.Server} deps.server
 * @param {TaskQueue}   deps.taskQueue
 * @param {object}      deps.activeGenerations — { count: number }
 */
function initGracefulShutdown(deps) {
  var server = deps.server;
  var taskQueue = deps.taskQueue;
  var activeGenerations = deps.activeGenerations;

  function gracefulShutdown(signal) {
    if (activeGenerations.count > 0) {
      console.log('[server] ' + signal + ' received, waiting for ' + activeGenerations.count + ' active generation(s)...');
      var waitCount = 0;
      var waitTimer = setInterval(function() {
        waitCount++;
        if (activeGenerations.count <= 0 || waitCount > 60) {
          clearInterval(waitTimer);
          if (activeGenerations.count > 0) console.log('[server] Force shutdown after 60s');
          else console.log('[server] All generations finished, shutting down');
          process.exit(0);
        }
      }, 1000);
      return;
    }
    console.log('[server] ' + signal + ' received, closing...');
    try { taskQueue.close(); } catch(e) {}
    server.close(function() { console.log('[server] Closed.'); process.exit(0); });
    setTimeout(function() { process.exit(1); }, 3000);
  }

  process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
}

module.exports = { initGracefulShutdown: initGracefulShutdown };
