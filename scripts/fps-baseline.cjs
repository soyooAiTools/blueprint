#!/usr/bin/env node
/**
 * FPS Baseline Harness — 采集 Luna WebGL 产物的 FPS
 * Usage: node scripts/fps-baseline.cjs <projectId> <label>
 *   label: 'before' / 'after' / 任意字符串
 * Output: server-data/perf-baseline/<projectId>-<label>.json
 *
 * Notes:
 *   - puppeteer-core 安装在系统全局 /usr/lib/node_modules; 本地 node_modules 无,
 *     故通过 require.resolve + 显式路径方式加载, 不新增 package.json 依赖.
 *   - 不依赖 glob 包 (blueprint-editor 未装), 改用 fs.readdirSync 递归搜索 chrome.
 *   - WebGL 产物入口文件名为 index.html (不是 iframe.html — 后者是 stage4 中间态).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- puppeteer-core: 优先本地, 回落到全局 /usr/lib/node_modules ---
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (_) {
  const globalPath = '/usr/lib/node_modules/puppeteer-core';
  if (!fs.existsSync(globalPath)) {
    throw new Error('puppeteer-core not found locally or at ' + globalPath);
  }
  puppeteer = require(globalPath);
}

const PROJECT_ID = process.argv[2];
const LABEL = process.argv[3] || 'before';
const DURATION_MS = 10000;
const OUT_DIR = '/opt/blueprint-editor/server-data/perf-baseline';

if (!PROJECT_ID) {
  console.error('Usage: node scripts/fps-baseline.cjs <projectId> <label>');
  process.exit(1);
}

// 递归查找 ~/.cache/puppeteer/chrome/*/chrome-linux*/chrome, 不依赖 glob
function findChrome() {
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (!fs.existsSync(base)) throw new Error('chromium cache not found at ' + base);
  const versions = fs.readdirSync(base);
  for (const ver of versions) {
    const verDir = path.join(base, ver);
    let inner;
    try { inner = fs.readdirSync(verDir); } catch (_) { continue; }
    for (const sub of inner) {
      if (!sub.startsWith('chrome-linux')) continue;
      const candidate = path.join(verDir, sub, 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('chromium binary not found under ' + base);
}

function findWebglIndex() {
  const webglDir = '/opt/blueprint-editor/server-data/webgl/' + PROJECT_ID;
  if (!fs.existsSync(webglDir)) throw new Error('webgl output missing: ' + webglDir);
  // 现网 Luna 产物入口是 index.html (见 worker/screenshot-review.cjs 第17行).
  const candidate = path.join(webglDir, 'index.html');
  if (!fs.existsSync(candidate)) throw new Error('index.html missing under ' + webglDir);
  return candidate;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = findWebglIndex();
  const chromePath = findChrome();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 1280 });
  await page.goto('file://' + html, { waitUntil: 'networkidle2', timeout: 60000 });
  // 等 Unity 启动完成
  await new Promise(r => setTimeout(r, 3000));

  // rAF 采样 FPS
  const samples = await page.evaluate(async (durMs) => {
    return new Promise((resolve) => {
      const times = [];
      let last = performance.now();
      const start = last;
      function tick() {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (now - start < durMs) requestAnimationFrame(tick);
        else resolve(times);
      }
      requestAnimationFrame(tick);
    });
  }, DURATION_MS);

  await browser.close();

  const frames = samples.length;
  const totalMs = samples.reduce((a, b) => a + b, 0);
  const avgFps = frames / (totalMs / 1000);
  const p1 = samples.slice().sort((a, b) => a - b);
  const p50ms = p1[Math.floor(p1.length * 0.5)];
  const p95ms = p1[Math.floor(p1.length * 0.95)];
  const p99ms = p1[Math.floor(p1.length * 0.99)];

  const report = {
    projectId: PROJECT_ID,
    label: LABEL,
    timestamp: new Date().toISOString(),
    durationMs: DURATION_MS,
    frames,
    avgFps: Number(avgFps.toFixed(2)),
    frameMs: {
      p50: Number(p50ms.toFixed(2)),
      p95: Number(p95ms.toFixed(2)),
      p99: Number(p99ms.toFixed(2)),
    },
    samplesPreview: samples.slice(0, 20),
    chromePath,
    entryHtml: html,
  };

  const outPath = path.join(OUT_DIR, PROJECT_ID + '-' + LABEL + '.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('FPS baseline written:', outPath);
  console.log('  avgFps=' + report.avgFps + '  p95=' + report.frameMs.p95 + 'ms  p99=' + report.frameMs.p99 + 'ms');
})().catch(e => { console.error(e); process.exit(1); });
