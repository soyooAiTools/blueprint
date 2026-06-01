const fs = require('fs');
const path = require('path');
const { verifyFiles, requireTargetResolves } = require('../engine/auto-fix.cjs');

// Derive the repo root from this test file's location so the test is portable
// across checkouts/worktrees and matches auto-fix.cjs's own REPO_ROOT
// (path.join(__dirname,'..') from engine/). Hard-coding /opt/blueprint-editor
// made verifyFiles (which resolves relative paths against its own REPO_ROOT)
// look in the wrong tree when run from anywhere else, silently returning [].
const REPO_ROOT = path.join(__dirname, '..');
const TMP = 'server-data/__autofix_verify_test';

function write(rel, src) {
  const abs = path.join(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, src);
  return rel;
}
function cleanup() {
  try { fs.rmSync(path.join(REPO_ROOT, TMP), { recursive: true, force: true }); } catch (e) {}
}

describe('auto-fix verifyFiles pre-apply guard', () => {
  describe('requireTargetResolves', () => {
    test('builtin / bare specifier is assumed present', () => {
      expect(requireTargetResolves(path.join(REPO_ROOT, 'engine'), 'http')).toBe(true);
      expect(requireTargetResolves(path.join(REPO_ROOT, 'engine'), 'playwright')).toBe(true);
    });
    test('existing relative module resolves', () => {
      expect(requireTargetResolves(path.join(REPO_ROOT, 'engine'), './metrics.cjs')).toBe(true);
      expect(requireTargetResolves(path.join(REPO_ROOT, 'engine', 'stages'), './lib/field-diff.cjs')).toBe(true);
    });
    test('missing relative module does NOT resolve', () => {
      expect(requireTargetResolves(path.join(REPO_ROOT, 'engine'), './does-not-exist-xyz.cjs')).toBe(false);
    });
  });

  describe('verifyFiles', () => {
    test('clean module (valid requires) passes', () => {
      const f = write(TMP + '/ok.cjs', 'var m = require("../../engine/metrics.cjs"); var http = require("http"); module.exports = {};\n');
      expect(verifyFiles([f])).toEqual([]);
      cleanup();
    });

    test('require() of a missing module is caught (the auto-f4084a58 class)', () => {
      const f = write(TMP + '/badreq.cjs', 'var x = require("./missing-module-xyz.cjs"); module.exports = {};\n');
      const errs = verifyFiles([f]);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('does not resolve');
      cleanup();
    });

    test('syntax error is caught', () => {
      const f = write(TMP + '/syn.cjs', 'var x = = ;\n');
      const errs = verifyFiles([f]);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('syntax');
      cleanup();
    });

    test('non-js files are ignored', () => {
      const f = write(TMP + '/data.json', '{"a":1}\n');
      expect(verifyFiles([f])).toEqual([]);
      cleanup();
    });
  });
});
