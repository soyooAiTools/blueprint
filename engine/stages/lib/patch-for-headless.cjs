'use strict';
// 2026-06-01: adapter created to complete a concurrent auto-fix (auto-f4084a58) that
// wired patchForHeadless into engine/stages/fidelity-source-diff.cjs serveSingleFile but
// require()'d this (then non-existent) module path and used the return value as a string.
//
// The canonical headless patcher lives in worker/worker-cua-verify.js (also used by
// engine/stages/visual-check.cjs via worker-cua-verify). It rewrites `new Event("x")`
// (and similar) to `document.createEvent(...)` so Luna/PlayCanvas WebGL builds don't throw
// in headless Chromium before any rendering — the cause of black-canvas captures and the
// ~100% pixel divergence the fidelity gate kept reporting.
//
// The canonical fn returns { content, fixes }; this adapter returns just the patched
// STRING to match the auto-fix's `patchForHeadless(html)` → string usage, and tolerates a
// missing filename arg + any failure (returns the source unchanged).

var canonical = null;
try {
  canonical = require('../../../worker/worker-cua-verify.js').patchForHeadless;
} catch (e) {
  console.warn('[patch-for-headless] WARN: could not load canonical patchForHeadless from worker-cua-verify.js — HTML will be served unpatched, expect black-canvas / pixel-divergence failures:', e && e.message || e);
  canonical = null;
}

module.exports = function patchForHeadless(source, filename) {
  if (typeof source !== 'string') return source;
  if (typeof canonical !== 'function') {
    console.warn('[patch-for-headless] WARN: canonical patchForHeadless is not a function (canonical=%s) — returning source unpatched. This will cause new Event() TypeError in headless Chromium and a black canvas.', typeof canonical);
    return source;
  }
  try {
    var result = canonical(source, filename || 'index.html');
    if (result && typeof result === 'object' && typeof result.content === 'string') return result.content;
    if (typeof result === 'string') return result;
    console.warn('[patch-for-headless] WARN: canonical patchForHeadless returned unexpected type (%s) — returning source unpatched. This will cause new Event() TypeError in headless Chromium and a black canvas.', typeof result);
    return source;
  } catch (e) {
    console.warn('[patch-for-headless] WARN: canonical patchForHeadless threw an error — returning source unpatched. This will cause new Event() TypeError in headless Chromium and a black canvas:', e && e.message || e);
    return source;
  }
};