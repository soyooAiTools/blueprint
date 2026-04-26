/**
 * Small helpers for the dashboard JSON watchers.
 *
 * Two responsibilities:
 *
 *  - loadArray(file): read a JSON array from disk. If the file is missing,
 *    return an empty array. If the file is corrupt or holds a non-array
 *    value, return ok=false plus a diagnostic — callers MUST refuse to
 *    write back when ok=false, otherwise the next watcher tick would
 *    overwrite the corrupt-but-recoverable file with []. This is the
 *    behavior PR-4 introduced.
 *
 *  - writeArrayAtomic(file, arr): write the array via tmp + rename so a
 *    crash mid-write cannot leave a truncated file on disk. This is the
 *    behavior PR-11 introduced (xhigh review follow-up).
 *
 * Both helpers are pure-ish (no module-level state) and synchronous, so
 * they can be tested in isolation without spinning up the dashboard.
 */
var fs = require('fs');
var path = require('path');

function loadArray(file) {
  try {
    if (!fs.existsSync(file)) return { ok: true, data: [] };
    var parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed != null && !Array.isArray(parsed)) {
      return {
        ok: false,
        data: [],
        error: 'expected array, got ' + typeof parsed,
      };
    }
    return { ok: true, data: parsed || [] };
  } catch (e) {
    return { ok: false, data: [], error: e.message };
  }
}

function buildCorruptDiagnostic(file, err) {
  return (
    '[error] ' +
    file +
    ' 损坏 (' +
    err +
    '),写入已跳过以保留现场。建议: cp "' +
    file +
    '" "' +
    file +
    '.corrupt.' +
    Date.now() +
    '" 再人工排查'
  );
}

function writeArrayAtomic(file, arr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = {
  loadArray: loadArray,
  buildCorruptDiagnostic: buildCorruptDiagnostic,
  writeArrayAtomic: writeArrayAtomic,
};
