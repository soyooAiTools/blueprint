const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const detector = require('../lib/ui-overlap-detector.cjs');

// ----- unit: rectsOverlap -----
{
  const a = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  const b = { minX: 5, maxX: 15, minY: 5, maxY: 15 };
  const c = { minX: 20, maxX: 30, minY: 0, maxY: 10 };
  const d = { minX: 10, maxX: 20, minY: 0, maxY: 10 }; // 仅边接触不算重叠
  assert.strictEqual(detector.rectsOverlap(a, b), true, 'a/b 应当重叠');
  assert.strictEqual(detector.rectsOverlap(a, c), false, 'a/c 完全分离');
  assert.strictEqual(detector.rectsOverlap(a, d), false, '边接触不算重叠');
}

// ----- unit: extractFromSource (CreateText 默认 size = 400 x fontSize*2) -----
{
  const src = 'guideText = GFM_UI.CreateText(uiCanvas, "hi", new Vector2(0, 100), 50);';
  const els = detector.extractFromSource(src, 'fake.cs');
  assert.strictEqual(els.length, 1, '应识别 1 个 CreateText');
  const el = els[0];
  assert.strictEqual(el.kind, 'Text');
  assert.strictEqual(el.label, 'hi');
  assert.deepStrictEqual(el.pos, { x: 0, y: 100 });
  assert.deepStrictEqual(el.size, { w: 400, h: 100 }, 'size 应为 (400, fontSize*2)');
  assert.deepStrictEqual(el.rect, { minX: -200, maxX: 200, minY: 50, maxY: 150 });
  assert.strictEqual(el.line, 1);
}

// ----- unit: extractFromSource (CreateButton + CreateProgressBar 显式 size) -----
{
  const src = [
    'GFM_UI.CreateButton(canvas, "Play", new Vector2(0, -200), new Vector2(300, 80), null);',
    'GFM_UI.CreateProgressBar(canvas, new Vector2(0, 400), new Vector2(500, 30), Color.green);',
  ].join('\n');
  const els = detector.extractFromSource(src, 'fake.cs');
  assert.strictEqual(els.length, 2);
  const btn = els.find(function (e) { return e.kind === 'Button'; });
  const bar = els.find(function (e) { return e.kind === 'ProgressBar'; });
  assert.ok(btn && bar, '应分别提取出 Button 与 ProgressBar');
  assert.deepStrictEqual(btn.size, { w: 300, h: 80 });
  assert.deepStrictEqual(bar.size, { w: 500, h: 30 });
  assert.strictEqual(bar.line, 2);
}

// ----- unit: 浮点字面量 / 带 f 后缀 -----
{
  const src = 'GFM_UI.CreateText(c, "x", new Vector2(-3.5f, .5), 24);';
  const els = detector.extractFromSource(src, 'fake.cs');
  assert.strictEqual(els.length, 1);
  assert.strictEqual(els[0].pos.x, -3.5);
  assert.strictEqual(els[0].pos.y, 0.5);
}

// ----- integration: 故意重叠 fixture (复刻反馈中真实的 k4462r 重叠) -----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-overlap-pos-'));
  fs.writeFileSync(path.join(root, 'GameFlowManagerMain.cs'), [
    'public class GameFlowManagerMain : MonoBehaviour {',
    '  void CreateUI() {',
    '    guideText    = GFM_UI.CreateText(uiCanvas, "",         new Vector2(0,   450), 52);',
    '    floatingText = GFM_UI.CreateText(uiCanvas, "",         new Vector2(0,   360), 44);',
    '    scoreText    = GFM_UI.CreateText(uiCanvas, "Score: 0", new Vector2(680, 480), 40);',
    '  }',
    '}',
    '',
  ].join('\n'));

  const report = detector.detectUiOverlap(root);
  assert.strictEqual(report.elements.length, 3);
  assert.strictEqual(report.overlaps.length, 1, 'guideText 与 floatingText 应被认定重叠');

  const ov = report.overlaps[0];
  const labels = [ov.a.label, ov.b.label].sort();
  assert.deepStrictEqual(labels, ['<empty>', '<empty>'], '空字符串内容应渲染为 <empty>');
  assert.ok(ov.area > 0, '重叠面积应为正');
  assert.strictEqual(ov.a.file, 'GameFlowManagerMain.cs');

  fs.rmSync(root, { recursive: true, force: true });
}

// ----- integration: 干净 fixture 不报警 -----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-overlap-clean-'));
  fs.writeFileSync(path.join(root, 'GameFlowManagerMain.cs'), [
    'public class GameFlowManagerMain : MonoBehaviour {',
    '  void CreateUI() {',
    '    title = GFM_UI.CreateText(uiCanvas, "Title",  new Vector2(0,  450), 40);',
    '    score = GFM_UI.CreateText(uiCanvas, "Score:", new Vector2(0, -450), 40);',
    '  }',
    '}',
    '',
  ].join('\n'));

  const report = detector.detectUiOverlap(root);
  assert.strictEqual(report.elements.length, 2);
  assert.strictEqual(report.overlaps.length, 0, '无重叠应返回空数组');

  fs.rmSync(root, { recursive: true, force: true });
}

// ----- integration: 空目录不抛错 -----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-overlap-empty-'));
  const report = detector.detectUiOverlap(root);
  assert.deepStrictEqual(report, { elements: [], overlaps: [] });
  fs.rmSync(root, { recursive: true, force: true });
}

// ----- integration: 跨文件重叠也能识别 -----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-overlap-multi-'));
  fs.writeFileSync(path.join(root, 'GameFlowManagerMain.cs'),
    'GFM_UI.CreateText(c, "A", new Vector2(0, 0), 20);');
  fs.writeFileSync(path.join(root, 'GameFlowUiBase.cs'),
    'GFM_UI.CreateText(c, "B", new Vector2(50, 10), 30);');
  const report = detector.detectUiOverlap(root);
  assert.strictEqual(report.overlaps.length, 1);
  const files = [report.overlaps[0].a.file, report.overlaps[0].b.file].sort();
  assert.deepStrictEqual(files, ['GameFlowManagerMain.cs', 'GameFlowUiBase.cs']);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ui overlap detector tests passed');
