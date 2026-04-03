/**
 * ServerContext — shared business state extracted from server.cjs
 * Houses: wakeOpenClaw, parseStats, activeGenerations
 */
var fs = require('fs');
var config = require('./config.cjs');

// ============ OpenClaw Wake Signal ============

function wakeOpenClaw(text) {
  try {
    fs.writeFileSync(config.WAKE_SIGNAL_FILE, JSON.stringify({
      text: text,
      timestamp: new Date().toISOString()
    }), 'utf-8');
    console.log('[wake] Signal file written: ' + config.WAKE_SIGNAL_FILE);
  } catch(e) {
    console.warn('[wake] Signal write failed: ' + e.message);
  }
}

// ============ Parse Stats ============

var parseStats = { total: 0, success: 0, failed: 0, totalTimeMs: 0, history: [] };
try {
  if (fs.existsSync(config.PARSE_STATS_FILE)) {
    parseStats = JSON.parse(fs.readFileSync(config.PARSE_STATS_FILE, 'utf-8'));
    if (!parseStats.history) parseStats.history = [];
  }
} catch(e) { /* use defaults */ }

function recordParseStat(success, timeMs, entities, phases, error) {
  parseStats.total++;
  if (success) parseStats.success++;
  else parseStats.failed++;
  if (timeMs) parseStats.totalTimeMs += timeMs;
  parseStats.history.push({
    success: success, timeMs: timeMs, entities: entities, phases: phases,
    error: error || null, at: new Date().toISOString()
  });
  if (parseStats.history.length > 100) parseStats.history = parseStats.history.slice(-100);
  try { fs.writeFileSync(config.PARSE_STATS_FILE, JSON.stringify(parseStats, null, 2)); } catch(e) {}
}

// ============ Active Generations Counter ============

var activeGenerations = { count: 0 };

module.exports = {
  wakeOpenClaw: wakeOpenClaw,
  parseStats: parseStats,
  recordParseStat: recordParseStat,
  activeGenerations: activeGenerations,
};
