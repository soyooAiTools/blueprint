'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var stage = require('../engine/stages/source-html-bind.cjs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-html-bind-'));
var htmlPath = path.join(tmp, 'source.html');
fs.writeFileSync(htmlPath, '<!doctype html><html></html>');
var sha = stage._internals.sha256OfFile(htmlPath);

assert.strictEqual(stage._internals.isStoryboard2HtmlFlow({
  task: { adapter: 'storyboard2html' },
}), true);
assert.strictEqual(stage._internals.isStoryboard2HtmlFlow({
  blueprint: { schemaSource: 'demo2spec' },
}), true);
assert.strictEqual(stage._internals.isHardMode({
  task: { sourcePipeline: 'storyboard2html' },
}), true);
assert.strictEqual(stage._internals.isHardMode({ task: { sourcePipeline: 'legacy' } }), false);

assert.throws(function() {
  stage.assertBefore({
    task: { adapter: 'storyboard2html' },
    blueprint: {},
    addLog: function() {},
  });
}, /storyboard2html\/demo2spec flow/);

assert.throws(function() {
  stage.assertBefore({
    task: { adapter: 'storyboard2html' },
    blueprint: { sourceHtmlPath: htmlPath },
    addLog: function() {},
  });
}, /requires declared sha256/);

var ctx = {
  task: { adapter: 'storyboard2html' },
  blueprint: { sourceHtmlPath: htmlPath, sourceHtmlSha256: sha },
  addLog: function() {},
};
stage.assertBefore(ctx);
assert.strictEqual(ctx.sourceHtmlPath, htmlPath);
assert.strictEqual(ctx.sourceHtmlSha256, sha);

console.log('source-html-bind hardgate tests passed');
