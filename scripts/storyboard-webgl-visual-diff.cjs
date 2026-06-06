#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var sharp = require('sharp');
var playwright = require('playwright');

function usage() {
  console.error('Usage: node scripts/storyboard-webgl-visual-diff.cjs --source <storyboard.html> --webgl <webgl-dir|index.html> --out <dir> [--phases N] [--width 540] [--height 960] [--settle-ms 1000] [--mean-threshold 14] [--over50-threshold 6] [--no-fail]');
  process.exit(2);
}

function parseArgs(argv) {
  var opts = {
    source: null,
    webgl: null,
    out: null,
    phases: null,
    width: 540,
    height: 960,
    settleMs: 1000,
    meanThreshold: 14,
    over50Threshold: 6,
    fail: true,
  };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--source') opts.source = argv[++i] || null;
    else if (arg === '--webgl') opts.webgl = argv[++i] || null;
    else if (arg === '--out') opts.out = argv[++i] || null;
    else if (arg === '--phases') opts.phases = Number(argv[++i] || 0) || null;
    else if (arg === '--width') opts.width = Number(argv[++i] || 0) || opts.width;
    else if (arg === '--height') opts.height = Number(argv[++i] || 0) || opts.height;
    else if (arg === '--settle-ms') opts.settleMs = Number(argv[++i] || 0) || opts.settleMs;
    else if (arg === '--mean-threshold') opts.meanThreshold = Number(argv[++i] || 0);
    else if (arg === '--over50-threshold') opts.over50Threshold = Number(argv[++i] || 0);
    else if (arg === '--no-fail') opts.fail = false;
    else usage();
  }
  if (!opts.source || !opts.webgl || !opts.out) usage();
  return opts;
}

function encodeUrlPath(filePath) {
  return String(filePath || '').split(path.sep).map(encodeURIComponent).join('/');
}

function serveRoot(rootDir) {
  rootDir = path.resolve(rootDir);
  var server = http.createServer(function(req, res) {
    var urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (!urlPath || urlPath === '/') urlPath = '/index.html';
    var local = path.resolve(rootDir, urlPath.replace(/^\/+/, ''));
    if (local.indexOf(rootDir) !== 0) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    fs.stat(local, function(statErr, stat) {
      if (statErr) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      if (stat.isDirectory()) local = path.join(local, 'index.html');
      var ext = path.extname(local).toLowerCase();
      var type = ext === '.html' ? 'text/html; charset=utf-8'
        : ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.json' ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
      res.setHeader('content-type', type);
      fs.createReadStream(local).on('error', function() {
        res.statusCode = 500;
        res.end('read error');
      }).pipe(res);
    });
  });
  return new Promise(function(resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      var port = server.address().port;
      resolve({ server: server, root: rootDir, url: 'http://127.0.0.1:' + port });
    });
  });
}

function phaseCountFromSource(sourcePath) {
  try {
    var html = fs.readFileSync(sourcePath, 'utf8');
    var m = html.match(/\bPHASES\s*=\s*\[([\s\S]*?)\]\s*;/);
    if (!m) return 1;
    var ids = m[1].match(/\bid\s*:\s*["']phase\d+["']/g) || [];
    return Math.max(1, ids.length || 1);
  } catch (error) {
    return 1;
  }
}

function resolveEntry(inputPath) {
  var abs = path.resolve(inputPath);
  var stat = fs.statSync(abs);
  if (stat.isDirectory()) return { root: abs, entry: 'index.html' };
  return { root: path.dirname(abs), entry: path.basename(abs) };
}

async function drivePage(page, url, phaseNumber, settleMs) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(300);
  await page.evaluate(function() {
    window.__CUA_OBSERVER_READY__ = true;
    window.__BLUEPRINT_VISUAL_DIFF_RUNNING__ = true;
  }).catch(function() {});
  await page.waitForFunction(function() {
    return typeof window.__driveToPhase === 'function'
      || typeof window.__driveToSourcePhase === 'function'
      || !!document.querySelector('canvas');
  }, { timeout: 30000 }).catch(function() {});
  var driver = await page.evaluate(async function(n) {
    window.__CUA_OBSERVER_READY__ = true;
    if (typeof window.__driveToPhase === 'function') {
      await window.__driveToPhase(n);
      return '__driveToPhase';
    }
    if (typeof window.__driveToSourcePhase === 'function') {
      await window.__driveToSourcePhase(n);
      return '__driveToSourcePhase';
    }
    return 'none';
  }, phaseNumber).catch(function(error) {
    return 'error:' + (error && error.message || String(error));
  });
  await page.waitForTimeout(settleMs);
  return driver;
}

async function readRgba(filePath) {
  return sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function diffImages(sourcePath, webglPath, diffPath) {
  var a = await readRgba(sourcePath);
  var b = await readRgba(webglPath);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    throw new Error('image size mismatch: ' + sourcePath + ' vs ' + webglPath);
  }
  var w = a.info.width;
  var h = a.info.height;
  var pixels = w * h;
  var diff = Buffer.alloc(pixels * 4);
  var total = 0;
  var over20 = 0;
  var over50 = 0;
  for (var i = 0; i < pixels; i++) {
    var off = i * 4;
    var dr = Math.abs(a.data[off] - b.data[off]);
    var dg = Math.abs(a.data[off + 1] - b.data[off + 1]);
    var db = Math.abs(a.data[off + 2] - b.data[off + 2]);
    var max = Math.max(dr, dg, db);
    total += (dr + dg + db) / 3;
    if (max > 20) over20++;
    if (max > 50) over50++;
    diff[off] = Math.min(255, dr * 3);
    diff[off + 1] = Math.min(255, dg * 3);
    diff[off + 2] = Math.min(255, db * 3);
    diff[off + 3] = 255;
  }
  await sharp(diff, { raw: { width: w, height: h, channels: 4 } }).png().toFile(diffPath);
  return {
    width: w,
    height: h,
    meanAbs: Number((total / pixels).toFixed(4)),
    over20Pct: Number((over20 / pixels * 100).toFixed(4)),
    over50Pct: Number((over50 / pixels * 100).toFixed(4)),
  };
}

async function main() {
  var opts = parseArgs(process.argv);
  var sourceEntry = resolveEntry(opts.source);
  var webglEntry = resolveEntry(opts.webgl);
  var sourceServer = await serveRoot(sourceEntry.root);
  var webglServer = await serveRoot(webglEntry.root);
  fs.mkdirSync(opts.out, { recursive: true });
  var phaseTotal = opts.phases || phaseCountFromSource(opts.source);
  var browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  var phases = [];
  try {
    for (var phase = 1; phase <= phaseTotal; phase++) {
      var sourcePage = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
      var webglPage = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 1 });
      var sourceUrl = sourceServer.url + '/' + encodeUrlPath(sourceEntry.entry);
      var webglUrl = webglServer.url + '/' + encodeUrlPath(webglEntry.entry) + '?sourceOverlay=1&sourceRuntime=1&observerReady=1&cuaObserverReady=1';
      var sourceDriver = await drivePage(sourcePage, sourceUrl, phase, opts.settleMs);
      var webglDriver = await drivePage(webglPage, webglUrl, phase, opts.settleMs);
      var prefix = 'phase' + phase;
      var sourceShot = path.join(opts.out, prefix + '-source.png');
      var webglShot = path.join(opts.out, prefix + '-webgl.png');
      var diffShot = path.join(opts.out, prefix + '-diff.png');
      await sourcePage.screenshot({ path: sourceShot, type: 'png' });
      await webglPage.screenshot({ path: webglShot, type: 'png' });
      var metrics = await diffImages(sourceShot, webglShot, diffShot);
      var passed = metrics.meanAbs <= opts.meanThreshold && metrics.over50Pct <= opts.over50Threshold;
      phases.push({
        phase: 'phase' + phase,
        passed: passed,
        sourceDriver: sourceDriver,
        webglDriver: webglDriver,
        sourceScreenshot: sourceShot,
        webglScreenshot: webglShot,
        diffScreenshot: diffShot,
        metrics: metrics,
      });
      await sourcePage.close();
      await webglPage.close();
    }
  } finally {
    await browser.close().catch(function() {});
    sourceServer.server.close();
    webglServer.server.close();
  }
  var report = {
    kind: 'blueprint.storyboardWebglVisualDiff',
    generatedAt: new Date().toISOString(),
    source: path.resolve(opts.source),
    webgl: path.resolve(opts.webgl),
    viewport: { width: opts.width, height: opts.height },
    thresholds: {
      meanAbs: opts.meanThreshold,
      over50Pct: opts.over50Threshold,
    },
    passed: phases.every(function(item) { return item.passed; }),
    phases: phases,
  };
  var reportPath = path.join(opts.out, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    passed: report.passed,
    report: reportPath,
    phases: phases.map(function(item) {
      return {
        phase: item.phase,
        passed: item.passed,
        meanAbs: item.metrics.meanAbs,
        over50Pct: item.metrics.over50Pct,
        sourceDriver: item.sourceDriver,
        webglDriver: item.webglDriver,
      };
    }),
  }, null, 2));
  if (!report.passed && opts.fail) process.exit(1);
}

main().catch(function(error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
