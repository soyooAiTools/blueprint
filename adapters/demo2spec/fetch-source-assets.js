#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { loadUnityAssetPlan, validateUnityAssetPlan } = require('./unity-asset-plan.js');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isImportAction(action) {
  return action && (action.action === 'import_external_model' || action.action === 'import_texture');
}

function targetPath(rootDir, relPath) {
  return path.resolve(rootDir, String(relPath || '').replace(/\\/g, '/'));
}

function dataUriPayload(uri) {
  const match = String(uri || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const body = decodeURIComponent(match[3] || '');
  return match[2] ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

function buildSourceFetchTasks(plan, rootDir, options) {
  validateUnityAssetPlan(plan);
  options = options || {};
  return safeArray(plan.actions).filter(isImportAction).map(action => {
    const fetchInfo = action.sourceFetch || {};
    const source = action.source || {};
    const target = targetPath(rootDir, fetchInfo.targetPath || action.sourceAssetPath);
    const license = fetchInfo.license || action.license || 'unknown';
    const sourceUrl = fetchInfo.url || null;
    const localSourcePath = fetchInfo.localSourcePath || null;
    let mode = 'missing';
    if (/^data:/i.test(source.url || '')) mode = 'data-uri';
    else if (localSourcePath && fs.existsSync(localSourcePath)) mode = 'copy-local';
    else if (/^https?:\/\//i.test(sourceUrl || '')) mode = 'download';
    return {
      actionId: action.actionId,
      assetId: action.assetId,
      action: action.action,
      mode,
      status: fetchInfo.status || action.status || null,
      sourceUrl,
      localSourcePath,
      targetPath: target,
      license,
      attribution: fetchInfo.attribution || action.attribution || null,
      blockedByLicense: license === 'unknown' && options.allowUnknownLicense !== true,
    };
  });
}

function download(url, dest, redirects) {
  redirects = redirects == null ? 3 : redirects;
  return new Promise((resolve, reject) => {
    const client = /^https:/i.test(url) ? https : http;
    const req = client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        download(nextUrl, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error('download failed ' + res.statusCode + ' for ' + url));
        return;
      }
      ensureParent(dest);
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function runSourceFetch(plan, rootDir, options) {
  options = options || {};
  const tasks = buildSourceFetchTasks(plan, rootDir, options);
  const results = [];
  for (const task of tasks) {
    if (task.blockedByLicense) {
      results.push(Object.assign({}, task, { result: 'skipped_unknown_license' }));
      continue;
    }
    if (options.dryRun) {
      results.push(Object.assign({}, task, { result: task.mode === 'missing' ? 'would_skip_missing_source' : 'would_' + task.mode.replace('-', '_') }));
      continue;
    }
    if (task.mode === 'copy-local') {
      ensureParent(task.targetPath);
      fs.copyFileSync(task.localSourcePath, task.targetPath);
      results.push(Object.assign({}, task, { result: 'copied' }));
      continue;
    }
    if (task.mode === 'data-uri') {
      const action = safeArray(plan.actions).find(item => item.actionId === task.actionId) || {};
      const payload = dataUriPayload(action.source && action.source.url);
      if (!payload) {
        results.push(Object.assign({}, task, { result: 'failed_data_uri_decode' }));
        continue;
      }
      ensureParent(task.targetPath);
      fs.writeFileSync(task.targetPath, payload);
      results.push(Object.assign({}, task, { result: 'decoded_data_uri' }));
      continue;
    }
    if (task.mode === 'download') {
      try {
        await download(task.sourceUrl, task.targetPath);
        results.push(Object.assign({}, task, { result: 'downloaded' }));
      } catch (error) {
        results.push(Object.assign({}, task, { result: 'failed_download', error: error.message }));
      }
      continue;
    }
    results.push(Object.assign({}, task, { result: 'skipped_missing_source' }));
  }
  const failed = results.filter(item => /^failed|^skipped|would_skip/.test(item.result));
  return {
    ok: failed.length === 0,
    dryRun: options.dryRun === true,
    summary: {
      taskCount: tasks.length,
      readyTaskCount: tasks.filter(task => task.mode !== 'missing' && !task.blockedByLicense).length,
      blockedByLicenseCount: tasks.filter(task => task.blockedByLicense).length,
      failedCount: failed.length,
    },
    tasks: results,
  };
}

function parseArgs(argv) {
  const opts = { planPath: null, rootDir: null, dryRun: false, allowUnknownLicense: false, reportPath: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-unknown-license') opts.allowUnknownLicense = true;
    else if (arg === '--report') opts.reportPath = argv[++i] || null;
    else if (!opts.planPath) opts.planPath = arg;
    else if (!opts.rootDir) opts.rootDir = arg;
    else throw new Error('Usage: node fetch-source-assets.js <unity-asset-plan.json> <unity-project-root> [--dry-run] [--allow-unknown-license] [--report path]');
  }
  if (!opts.planPath || !opts.rootDir) throw new Error('Usage: node fetch-source-assets.js <unity-asset-plan.json> <unity-project-root> [--dry-run] [--allow-unknown-license] [--report path]');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const plan = loadUnityAssetPlan(path.resolve(opts.planPath));
  const report = await runSourceFetch(plan, path.resolve(opts.rootDir), opts);
  const reportPath = opts.reportPath || path.join(path.dirname(path.resolve(opts.planPath)), 'source-asset-fetch-report.json');
  ensureParent(reportPath);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, reportPath, summary: report.summary }, null, 2));
  if (!report.ok && !opts.dryRun) process.exit(1);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  buildSourceFetchTasks,
  runSourceFetch,
};
