// uimanager-unified-create.test.cjs
// 反馈 01 #1 架构图:UI 创建走 UIManager 统一接口,而不是让外部直接 new GameObject。
// PR-18b 在 GFM_UIManager 上加了 CreateLabel/CreateButton/CreateProgressBar 三个
// thin wrappers,内部用自己的 Canvas 即可,调用方不再需要传 canvas 引用。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'GFM_UIManager.cs'), 'utf-8');

// 三个统一创建 API:Label / Button / ProgressBar。
assert.match(src, /public\s+Text\s+CreateLabel\s*\(\s*string\s+text/, 'CreateLabel(string,Vector2,int) must exist');
assert.match(
  src,
  /public\s+Button\s+CreateButton\s*\(\s*string\s+text\s*,\s*Vector2\s+anchoredPos\s*,\s*Vector2\s+size\s*,\s*UnityEngine\.Events\.UnityAction\s+onClick\s*\)/,
  'CreateButton(text,pos,size,onClick) must exist'
);
assert.match(
  src,
  /public\s+Slider\s+CreateProgressBar\s*\(\s*Vector2\s+anchoredPos\s*,\s*Vector2\s+size\s*,\s*Color\s+fillColor\s*\)/,
  'CreateProgressBar(pos,size,color) must exist'
);

// 这三个方法都必须先 EnsureInit 拿 _canvas,不能让外部传 canvas。
const labelStart = src.indexOf('public Text CreateLabel');
const labelEnd = src.indexOf('}', labelStart);
const labelBody = src.slice(labelStart, labelEnd);
assert.match(labelBody, /EnsureInit\(\)/, 'CreateLabel must EnsureInit before using _canvas');
assert.match(labelBody, /GFM_UI\.CreateText\(_canvas/, 'CreateLabel must delegate to GFM_UI.CreateText with _canvas');

const buttonStart = src.indexOf('public Button CreateButton');
const buttonEnd = src.indexOf('}', buttonStart);
const buttonBody = src.slice(buttonStart, buttonEnd);
assert.match(buttonBody, /EnsureInit\(\)/, 'CreateButton must EnsureInit');
assert.match(buttonBody, /GFM_UI\.CreateButton\(_canvas/, 'CreateButton must delegate to GFM_UI with _canvas');

const progressStart = src.indexOf('public Slider CreateProgressBar');
const progressEnd = src.indexOf('}', progressStart);
const progressBody = src.slice(progressStart, progressEnd);
assert.match(progressBody, /EnsureInit\(\)/, 'CreateProgressBar must EnsureInit');
assert.match(progressBody, /GFM_UI\.CreateProgressBar\(_canvas/, 'CreateProgressBar must delegate to GFM_UI with _canvas');

console.log('uimanager unified create tests passed');
