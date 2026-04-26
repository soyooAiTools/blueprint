var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var store = require('../lib/json-array-store.cjs');

function withTmpDir(fn) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-array-store-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── loadArray ───────────────────────────────────────────────────────────

withTmpDir(function(dir) {
  // missing file → ok=true, data=[]
  var file = path.join(dir, 'missing.json');
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, []);
});

withTmpDir(function(dir) {
  // valid array → ok=true, data is the array
  var file = path.join(dir, 'arr.json');
  fs.writeFileSync(file, JSON.stringify([{ a: 1 }, { b: 2 }]));
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, [{ a: 1 }, { b: 2 }]);
});

withTmpDir(function(dir) {
  // null → treated as [] (matches old behavior: regParsed || [])
  var file = path.join(dir, 'null.json');
  fs.writeFileSync(file, 'null');
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.data, []);
});

withTmpDir(function(dir) {
  // object (non-array) → ok=false, default []
  var file = path.join(dir, 'obj.json');
  fs.writeFileSync(file, JSON.stringify({ wrong: 'shape' }));
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.data, []);
  assert.match(r.error, /expected array/);
});

withTmpDir(function(dir) {
  // truncated/garbage → ok=false, default []
  var file = path.join(dir, 'garbage.json');
  fs.writeFileSync(file, '[{"unterminated":');
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.data, []);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

withTmpDir(function(dir) {
  // empty file → ok=false (JSON.parse('') throws)
  var file = path.join(dir, 'empty.json');
  fs.writeFileSync(file, '');
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, false);
});

// ── buildCorruptDiagnostic ──────────────────────────────────────────────

(function() {
  var msg = store.buildCorruptDiagnostic('/tmp/foo.json', 'expected array, got object');
  assert.match(msg, /^\[error\]/);
  assert.match(msg, /\/tmp\/foo\.json/);
  assert.match(msg, /损坏/);
  assert.match(msg, /expected array, got object/);
  // mentions the .corrupt.<ts> rescue copy hint
  assert.match(msg, /\.corrupt\.\d+/);
})();

// ── writeArrayAtomic ────────────────────────────────────────────────────

withTmpDir(function(dir) {
  // happy path: writes the array, no .tmp left behind
  var file = path.join(dir, 'sub', 'arr.json');
  store.writeArrayAtomic(file, [1, 2, 3]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), [1, 2, 3]);
  assert.ok(!fs.existsSync(file + '.tmp'), '.tmp must be cleaned up by rename');
});

withTmpDir(function(dir) {
  // creates parent dir if missing
  var file = path.join(dir, 'a', 'b', 'c', 'arr.json');
  store.writeArrayAtomic(file, []);
  assert.ok(fs.existsSync(file));
});

withTmpDir(function(dir) {
  // overwrite-in-place leaves no torn state: a stale .tmp from a previous
  // crashed run gets replaced cleanly by the next successful write
  var file = path.join(dir, 'arr.json');
  fs.writeFileSync(file, JSON.stringify([{ old: true }]));
  fs.writeFileSync(file + '.tmp', 'stale-garbage-from-previous-crash');
  store.writeArrayAtomic(file, [{ fresh: true }]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), [{ fresh: true }]);
  assert.ok(!fs.existsSync(file + '.tmp'));
});

// ── writeJSONAtomic (object / non-array payloads) ───────────────────────

withTmpDir(function(dir) {
  // object payload — matches auto-fix-state.json shape
  var file = path.join(dir, 'state.json');
  store.writeJSONAtomic(file, { pendingCommits: { recipe1: { state: 'loading' } } });
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(file, 'utf-8')),
    { pendingCommits: { recipe1: { state: 'loading' } } }
  );
  assert.ok(!fs.existsSync(file + '.tmp'));
});

withTmpDir(function(dir) {
  // null and primitives serialize cleanly too
  var file = path.join(dir, 'val.json');
  store.writeJSONAtomic(file, null);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'null');
});

(function() {
  // backward-compat: writeArrayAtomic and writeJSONAtomic share an impl
  assert.strictEqual(store.writeArrayAtomic, store.writeJSONAtomic);
})();

// ── end-to-end: corrupt file is preserved across a write cycle ──────────

withTmpDir(function(dir) {
  var file = path.join(dir, 'corrupt.json');
  var corruptBytes = '[{"unterminated":';
  fs.writeFileSync(file, corruptBytes);
  var r = store.loadArray(file);
  assert.strictEqual(r.ok, false);
  // Caller must NOT writeArrayAtomic when ok=false. We simulate the contract:
  if (r.ok) {
    store.writeArrayAtomic(file, []); // unreachable
  }
  // Original bytes remain on disk so an operator can rescue the file.
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), corruptBytes);
});

console.log('json-array-store tests passed');
