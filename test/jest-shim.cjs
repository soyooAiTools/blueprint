'use strict';

// Minimal jest-style BDD shim. Implements the synchronous subset used by
// test/*.test.cjs: describe / test / it / expect with the matchers we use
// today (toBe, toEqual, toBeNull, toBeDefined, toBeUndefined, toBeTruthy,
// toBeFalsy, toBeGreaterThan, toBeGreaterThanOrEqual, toBeLessThan,
// toContain, toHaveLength, toHaveProperty, toMatch) plus `.not`.
//
// Tests do not use beforeEach/afterEach/async/rejects today; the runner
// will throw a clear error if any test file starts to need them so we
// can extend the shim deliberately.

const suiteStack = [];
const collected = [];

function pushSuite(name) { suiteStack.push(name); }
function popSuite() { suiteStack.pop(); }
function suitePath() { return suiteStack.slice(); }

function describe(name, fn) {
  pushSuite(name);
  try { fn(); } finally { popSuite(); }
}

function test(name, fn) {
  collected.push({ suite: suitePath(), name, fn });
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a); const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof RegExp) return v.toString();
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function makeExpect(actual, negated) {
  function check(pass, msg) {
    const ok = negated ? !pass : pass;
    if (!ok) {
      throw new Error('expect' + (negated ? '.not' : '') + ' ' + msg);
    }
  }
  return {
    get not() { return makeExpect(actual, !negated); },
    toBe(expected) { check(Object.is(actual, expected), 'toBe ' + fmt(expected) + ' / actual ' + fmt(actual)); },
    toEqual(expected) { check(deepEqual(actual, expected), 'toEqual ' + fmt(expected) + ' / actual ' + fmt(actual)); },
    toBeNull() { check(actual === null, 'toBeNull / actual ' + fmt(actual)); },
    toBeDefined() { check(actual !== undefined, 'toBeDefined'); },
    toBeUndefined() { check(actual === undefined, 'toBeUndefined / actual ' + fmt(actual)); },
    toBeTruthy() { check(!!actual, 'toBeTruthy / actual ' + fmt(actual)); },
    toBeFalsy() { check(!actual, 'toBeFalsy / actual ' + fmt(actual)); },
    toBeGreaterThan(n) { check(actual > n, 'toBeGreaterThan ' + n + ' / actual ' + actual); },
    toBeGreaterThanOrEqual(n) { check(actual >= n, 'toBeGreaterThanOrEqual ' + n + ' / actual ' + actual); },
    toBeLessThan(n) { check(actual < n, 'toBeLessThan ' + n + ' / actual ' + actual); },
    toBeLessThanOrEqual(n) { check(actual <= n, 'toBeLessThanOrEqual ' + n + ' / actual ' + actual); },
    toContain(item) {
      const ok = (typeof actual === 'string' && typeof item === 'string')
        ? actual.indexOf(item) >= 0
        : Array.isArray(actual) ? actual.some(x => deepEqual(x, item)) : false;
      check(ok, 'toContain ' + fmt(item) + ' / actual ' + fmt(actual));
    },
    toHaveLength(n) { check(actual && actual.length === n, 'toHaveLength ' + n + ' / actual length ' + (actual && actual.length)); },
    toHaveProperty(key, value) {
      const parts = String(key).split('.');
      let cur = actual; let ok = true;
      for (const p of parts) { if (cur != null && p in cur) cur = cur[p]; else { ok = false; break; } }
      if (ok && arguments.length > 1) ok = deepEqual(cur, value);
      check(ok, 'toHaveProperty ' + fmt(key) + (arguments.length > 1 ? '=' + fmt(value) : ''));
    },
    toMatch(re) {
      const ok = (re instanceof RegExp) ? re.test(String(actual)) : String(actual).indexOf(String(re)) >= 0;
      check(ok, 'toMatch ' + fmt(re) + ' / actual ' + fmt(actual));
    },
    toThrow(matcher) {
      if (typeof actual !== 'function') {
        throw new Error('expect(...).toThrow requires a function, got ' + typeof actual);
      }
      let thrown = null;
      try { actual(); } catch (e) { thrown = e; }
      let pass;
      if (!thrown) pass = false;
      else if (matcher === undefined) pass = true;
      else if (matcher instanceof RegExp) pass = matcher.test(String(thrown.message || thrown));
      else if (typeof matcher === 'string') pass = String(thrown.message || thrown).indexOf(matcher) >= 0;
      else if (typeof matcher === 'function') pass = thrown instanceof matcher;
      else pass = false;
      check(pass, 'toThrow ' + fmt(matcher) + ' / actual ' + (thrown ? fmt(thrown.message) : 'no throw'));
    },
  };
}

function expect(actual) { return makeExpect(actual, false); }

function unsupported(name) {
  return function () { throw new Error('jest shim: ' + name + ' is not supported yet — extend test/jest-shim.cjs'); };
}

function install() {
  global.describe = describe;
  global.test = test;
  global.it = test;
  global.expect = expect;
  global.beforeEach = unsupported('beforeEach');
  global.afterEach = unsupported('afterEach');
  global.beforeAll = unsupported('beforeAll');
  global.afterAll = unsupported('afterAll');
}

function reset() { collected.length = 0; suiteStack.length = 0; }

function runCollected() {
  const out = { pass: 0, fail: 0, failures: [] };
  for (const t of collected) {
    try {
      t.fn();
      out.pass++;
    } catch (e) {
      out.fail++;
      out.failures.push({ suite: t.suite, name: t.name, message: (e && e.message) || String(e), stack: (e && e.stack) || '' });
    }
  }
  return out;
}

module.exports = { install, reset, runCollected };
