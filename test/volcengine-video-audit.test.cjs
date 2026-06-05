#!/usr/bin/env node

var assert = require('assert');
var audit = require('../worker/volcengine-video-audit.cjs');

(function testBuildResponsesRequest() {
  var req = audit.buildResponsesRequest('file-abc', {
    model: 'doubao-seed-2-0-pro-260215',
    context: '只检查虚拟摇杆移动。',
  });
  assert.strictEqual(req.model, 'doubao-seed-2-0-pro-260215');
  assert.strictEqual(req.input[0].content[0].type, 'input_video');
  assert.strictEqual(req.input[0].content[0].file_id, 'file-abc');
  assert.strictEqual(req.input[0].content[1].type, 'input_text');
  assert.ok(req.input[0].content[1].text.indexOf('label_opposite_direction') >= 0);
  assert.ok(req.input[0].content[1].text.indexOf('只检查虚拟摇杆移动') >= 0);
})();

(function testParseResponsesApiJson() {
  var parsed = audit.parseVideoAuditResponse({
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: '```json\n{"passed":true,"summary":"ok","issues":[]}\n```',
          },
        ],
      },
    ],
  });
  assert.strictEqual(parsed.passed, true);
  assert.strictEqual(parsed.summary, 'ok');
  assert.deepStrictEqual(parsed.issues, []);
})();

(function testMajorIssueOverridesPassed() {
  var parsed = audit.parseVideoAuditResponse(JSON.stringify({
    passed: true,
    summary: '模型误判为通过，但报告了 major 问题',
    issues: [
      {
        type: 'label_opposite_direction',
        severity: 'major',
        time_range: '00:00:02-00:00:04',
        entity: 'Player',
        evidence: '人物向上移动时 label 向下漂移',
        confidence: 0.91,
      },
    ],
  }));
  assert.strictEqual(parsed.rawPassed, true);
  assert.strictEqual(parsed.passed, false, 'major issue must force video audit failure');
  assert.strictEqual(parsed.issues[0].type, 'label_opposite_direction');
  assert.strictEqual(parsed.issues[0].confidence, 0.91);
})();

(function testUnknownIssueBecomesInconclusive() {
  var normalized = audit.normalizeAuditResult({
    passed: false,
    issues: [{ type: 'unknown_type', evidence: '看不清' }],
  });
  assert.strictEqual(normalized.passed, false);
  assert.strictEqual(normalized.issues[0].type, 'inconclusive');
  assert.strictEqual(normalized.issues[0].severity, 'major');
})();

(async function testPrepareMp4SkipsPreprocess() {
  var prepared = await audit.prepareVideoForUpload('/tmp/demo.mp4', {});
  assert.strictEqual(prepared.videoPath, '/tmp/demo.mp4');
  assert.strictEqual(prepared.cleanupPath, null);
  console.log('volcengine video audit tests passed');
})().catch(function(err) {
  console.error(err);
  process.exit(1);
});
