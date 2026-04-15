/**
 * Port Guard — detect and kill processes occupying a given port before startup
 */

var fs = require('fs');

function killPortOccupier(port) {
  var pgPid = null;
  var pgCmds = [
    'ss -tlnp sport = :' + port + ' 2>/dev/null',
    'lsof -ti :' + port + ' 2>/dev/null',
    'fuser ' + port + '/tcp 2>/dev/null',
  ];
  for (var pgCmd of pgCmds) {
    try {
      var pgResult = require('child_process').execSync(pgCmd, { encoding: 'utf-8', timeout: 3000 }).trim();
      if (pgResult) {
        var pgPidMatch = pgResult.match(/pid=(\d+)/) || pgResult.match(/^(\d+)/m);
        if (pgPidMatch) { pgPid = parseInt(pgPidMatch[1]); break; }
      }
    } catch(e) {}
  }

  if (!pgPid) {
    try {
      var pgHex = port.toString(16).toUpperCase().padStart(4, '0');
      var pgTcp = fs.readFileSync('/proc/net/tcp', 'utf8');
      var pgLines = pgTcp.split('\n').filter(function(l) { return l.indexOf(':' + pgHex) !== -1 && l.indexOf('0A') !== -1; });
      if (pgLines.length > 0) {
        var pgInode = pgLines[0].trim().split(/\s+/)[9];
        var pgDirs = fs.readdirSync('/proc').filter(function(d) { return /^\d+$/.test(d); });
        for (var pgDir of pgDirs) {
          try {
            var pgFds = fs.readdirSync('/proc/' + pgDir + '/fd');
            for (var pgFd of pgFds) {
              try {
                var pgLink = fs.readlinkSync('/proc/' + pgDir + '/fd/' + pgFd);
                if (pgLink.indexOf('socket:[' + pgInode + ']') !== -1) { pgPid = parseInt(pgDir); break; }
              } catch(e) {}
            }
            if (pgPid) break;
          } catch(e) {}
        }
      }
    } catch(e) {}
  }

  if (pgPid && pgPid !== process.pid) {
    // NEVER kill the PM2 God Daemon. In cluster mode PM2 holds the LISTEN socket
    // for the worker's port, so port-guard sees its PID as the "occupier". SIGTERMing
    // it used to cascade-kill all apps (incident 2026-04-15). Detect by /proc/<pid>/comm.
    var pgCmdline = '';
    try { pgCmdline = fs.readFileSync('/proc/' + pgPid + '/comm', 'utf8').trim(); } catch(e) {}
    if (/^PM2\b/i.test(pgCmdline) || /God\s*Daemon/i.test(pgCmdline)) {
      console.log('[port-guard] Port ' + port + ' held by PM2 God Daemon (PID ' + pgPid + ') — refusing to kill');
      return;
    }
    console.log('[port-guard] Port ' + port + ' occupied by PID ' + pgPid + ' (' + pgCmdline + '), killing...');
    try { process.kill(pgPid, 'SIGTERM'); } catch(e) {}
    var pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    try { process.kill(pgPid, 'SIGKILL'); } catch(e) {}
    pgWait = Date.now(); while (Date.now() - pgWait < 1000) {}
    console.log('[port-guard] Cleaned up PID ' + pgPid);
  }
}

module.exports = { killPortOccupier: killPortOccupier };
