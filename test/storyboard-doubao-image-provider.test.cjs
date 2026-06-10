#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var sharp = require('sharp');

(async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-doubao-image-provider-'));
  var promptFile = path.join(dir, 'prompt.txt');
  var output = path.join(dir, 'phase01.png');
  fs.writeFileSync(promptFile, '生成一张试玩广告分镜图：玩家拾取太空垃圾换得美金。');
  var cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/storyboard-doubao-image-provider.cjs'),
  ], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      STORYBOARD_DOUBAO_DRY_RUN: '1',
      STORYBOARD_PHASE_PROMPT_FILE: promptFile,
      STORYBOARD_PHASE_OUTPUT: output,
      STORYBOARD_PHASE_TITLE: '拾取垃圾换得美金',
    }),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
  assert.ok(fs.existsSync(output));
  var meta = await sharp(output).metadata();
  assert.strictEqual(meta.width, 1536);
  assert.strictEqual(meta.height, 864);
  assert.ok(/dry_run/.test(cli.stdout));
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
