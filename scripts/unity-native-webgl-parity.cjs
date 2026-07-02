#!/usr/bin/env node
'use strict';

var fs = require('fs');
var http = require('http');
var path = require('path');
var parity = require('../lib/unity-native-webgl-parity.cjs');

function parseArgs(argv) {
  var args = argv || process.argv.slice(2);
  var parsed = {
    sourceIr: '',
    runtimeSnapshot: '',
    runtimeSnapshotOut: '',
    webglDir: '',
    out: '',
    unityDeliverySpecSemanticHash: '',
    includeProjection: false,
    timeoutMs: 60000
  };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--source-ir') parsed.sourceIr = String(args[++i] || '');
    else if (arg === '--runtime-snapshot') parsed.runtimeSnapshot = String(args[++i] || '');
    else if (arg === '--runtime-snapshot-out') parsed.runtimeSnapshotOut = String(args[++i] || '');
    else if (arg === '--webgl-dir') parsed.webglDir = String(args[++i] || '');
    else if (arg === '--out') parsed.out = String(args[++i] || '');
    else if (arg === '--unity-delivery-spec-semantic-hash') parsed.unityDeliverySpecSemanticHash = String(args[++i] || '');
    else if (arg === '--include-projection') parsed.includeProjection = true;
    else if (arg === '--timeout-ms') parsed.timeoutMs = Math.max(1000, Number(args[++i] || 0) || 60000);
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!parsed.sourceIr || !parsed.out || (!parsed.runtimeSnapshot && !parsed.webglDir)) {
    throw new Error('Usage: node scripts/unity-native-webgl-parity.cjs --source-ir source-ir.json (--runtime-snapshot runtime-parity.json | --webgl-dir native-webgl-dir) --out UNITY_NATIVE_WEBGL_PARITY_REPORT.json [--runtime-snapshot-out runtime-snapshot.json] [--unity-delivery-spec-semantic-hash hash] [--timeout-ms N] [--include-projection]');
  }
  if (parsed.runtimeSnapshot && parsed.webglDir) throw new Error('Use either --runtime-snapshot or --webgl-dir, not both.');
  if (parsed.runtimeSnapshot && parsed.runtimeSnapshotOut) throw new Error('--runtime-snapshot-out is only valid with --webgl-dir.');
  return parsed;
}

function contentType(file) {
  if (/\.wasm\.(gz|br)$/i.test(file)) return 'application/wasm';
  if (/\.js\.(gz|br)$/i.test(file)) return 'application/javascript; charset=utf-8';
  if (/\.data\.(gz|br)$/i.test(file)) return 'application/octet-stream';
  if (/\.symbols\.json\.(gz|br)$/i.test(file)) return 'application/octet-stream';
  if (/\.html?$/i.test(file)) return 'text/html; charset=utf-8';
  if (/\.js$/i.test(file)) return 'application/javascript; charset=utf-8';
  if (/\.json$/i.test(file)) return 'application/json; charset=utf-8';
  if (/\.wasm$/i.test(file)) return 'application/wasm';
  if (/\.data$/i.test(file)) return 'application/octet-stream';
  if (/\.css$/i.test(file)) return 'text/css; charset=utf-8';
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  return 'application/octet-stream';
}

function contentEncoding(file) {
  if (/\.gz$/i.test(file)) return 'gzip';
  if (/\.br$/i.test(file)) return 'br';
  return '';
}

function startStaticServer(root) {
  root = path.resolve(root);
  var server = http.createServer(function(req, res) {
    var pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname || '/');
    if (pathname === '/') pathname = '/index.html';
    var rel = pathname.replace(/^\/+/, '');
    var file = path.resolve(root, rel);
    if (file !== root && file.indexOf(root + path.sep) !== 0) {
      res.statusCode = 403;
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', contentType(file));
    var encoding = contentEncoding(file);
    if (encoding) {
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
    }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(function(resolve, reject) {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', function() {
      var address = server.address();
      resolve({
        server: server,
        url: 'http://127.0.0.1:' + address.port + '/index.html'
      });
    });
  });
}

async function extractRuntimeSnapshotFromWebgl(webglDir, timeoutMs) {
  var playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    throw new Error('playwright is required for --webgl-dir parity extraction: ' + err.message);
  }
  var hosted = await startStaticServer(webglDir);
  var browser = null;
  var diagnostics = { console: [], pageErrors: [] };
  try {
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    var page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', function(message) {
      diagnostics.console.push({ type: message.type(), text: message.text() });
      if (diagnostics.console.length > 50) diagnostics.console.shift();
    });
    page.on('pageerror', function(err) {
      diagnostics.pageErrors.push(String(err && err.stack || err));
      if (diagnostics.pageErrors.length > 20) diagnostics.pageErrors.shift();
    });
    await page.goto(hosted.url, { waitUntil: 'load', timeout: timeoutMs });
    try {
      await page.waitForFunction(function() {
        return !!window.__BLUEPRINT_UNITY_RUNTIME_PARITY__ || !!window.__BLUEPRINT_UNITY_RUNTIME_PARITY_PARSE_ERROR__;
      }, null, { timeout: timeoutMs });
    } catch (err) {
      try {
        diagnostics.pageState = await page.evaluate(function() {
          return {
            title: document.title,
            bodyText: (document.body && document.body.innerText || '').slice(0, 1000),
            hasCanvas: !!document.querySelector('canvas'),
            unityParityType: typeof window.__BLUEPRINT_UNITY_RUNTIME_PARITY__,
            unityParityRawType: typeof window.__BLUEPRINT_UNITY_RUNTIME_PARITY_RAW__,
            unityParseError: window.__BLUEPRINT_UNITY_RUNTIME_PARITY_PARSE_ERROR__ || '',
            keys: Object.keys(window).filter(function(key) {
              return /unity|blueprint/i.test(key);
            }).slice(0, 80)
          };
        });
      } catch (stateErr) {
        diagnostics.pageStateError = String(stateErr && stateErr.stack || stateErr);
      }
      throw new Error((err && err.message || String(err)) + '\nBrowser diagnostics: ' + JSON.stringify(diagnostics).slice(0, 8000));
    }
    var result = await page.evaluate(function() {
      return {
        snapshot: window.__BLUEPRINT_UNITY_RUNTIME_PARITY__ || null,
        parseError: window.__BLUEPRINT_UNITY_RUNTIME_PARITY_PARSE_ERROR__ || '',
        raw: window.__BLUEPRINT_UNITY_RUNTIME_PARITY_RAW__ || ''
      };
    });
    if (result.parseError) {
      var err = new Error('Unity runtime parity snapshot JSON parse failed: ' + result.parseError);
      err.raw = result.raw;
      throw err;
    }
    if (!result.snapshot) throw new Error('Unity runtime parity snapshot was not exposed on window.__BLUEPRINT_UNITY_RUNTIME_PARITY__');
    return {
      snapshot: result.snapshot,
      url: hosted.url
    };
  } finally {
    if (browser) await browser.close();
    await new Promise(function(resolve) { hosted.server.close(resolve); });
  }
}

async function run(opts) {
  var sourceIrPath = path.resolve(opts.sourceIr);
  var outPath = path.resolve(opts.out);
  var runtimeSnapshot = null;
  var snapshotPath = '';
  var runtimeUrl = '';
  if (opts.runtimeSnapshot) {
    snapshotPath = path.resolve(opts.runtimeSnapshot);
    runtimeSnapshot = parity.readJson(snapshotPath);
  } else {
    var extracted = await extractRuntimeSnapshotFromWebgl(path.resolve(opts.webglDir), opts.timeoutMs || 60000);
    runtimeSnapshot = extracted.snapshot;
    runtimeUrl = extracted.url;
    snapshotPath = path.resolve(opts.runtimeSnapshotOut || path.join(path.dirname(outPath), 'UNITY_NATIVE_WEBGL_RUNTIME_SNAPSHOT.json'));
    parity.writeJson(snapshotPath, runtimeSnapshot);
  }
  var report = parity.compareSourceToRuntime(parity.readJson(sourceIrPath), runtimeSnapshot, {
    unityDeliverySpecSemanticHash: opts.unityDeliverySpecSemanticHash,
    includeProjection: opts.includeProjection
  });
  report.sourceIrPath = sourceIrPath;
  report.runtimeSnapshotPath = snapshotPath;
  report.webglDir = opts.webglDir ? path.resolve(opts.webglDir) : '';
  report.runtimeUrl = runtimeUrl;
  report.outPath = outPath;
  parity.writeJson(outPath, report);
  return report;
}

async function main(argv) {
  var report = await run(parseArgs(argv || process.argv.slice(2)));
  process.stdout.write(JSON.stringify({
    ok: report.passed,
    status: report.status,
    diffCount: report.diffCount,
    out: report.outPath
  }, null, 2) + '\n');
  if (!report.passed) process.exit(1);
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs: parseArgs,
  extractRuntimeSnapshotFromWebgl: extractRuntimeSnapshotFromWebgl,
  run: run,
  main: main
};
