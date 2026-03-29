/**
 * Reference Fetcher — 获取竞品试玩广告 HTML 资源
 *
 * 支持两种输入:
 * 1. URL: 用 Playwright 抓取完整 HTML
 * 2. HTML 文件: 直接读取上传的文件
 *
 * 输出: { html, htmlPath, metadata }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'server-data', 'uploads');

/**
 * 检测 playable ad 使用的游戏框架
 */
function detectFramework(html) {
  if (/cc\.game|cc\.director|cc\.Canvas/i.test(html)) return 'cocos';
  if (/PIXI\.|new PIXI/i.test(html)) return 'pixi';
  if (/Phaser\.Game|new Phaser/i.test(html)) return 'phaser';
  if (/UnityLoader|unityInstance|createUnityInstance/i.test(html)) return 'unity';
  if (/Laya\.|laya\./i.test(html)) return 'laya';
  if (/THREE\.|new THREE/i.test(html)) return 'three';
  if (/playableSDK|mraid\.|MRAID/i.test(html)) return 'mraid';
  return 'unknown';
}

/**
 * 从 URL 抓取 HTML
 */
async function fetchFromURL(url, log, taskId) {
  log('[reference-fetcher] Fetching URL: ' + url, taskId);

  var chromium;
  try { chromium = require('playwright').chromium; } catch (e) {
    throw new Error('playwright not installed: ' + e.message);
  }

  var browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    var page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    // 等待游戏引擎初始化
    await page.waitForTimeout(3000);

    var html = await page.content();
    var title = await page.title();

    // 保存到本地
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    var htmlPath = path.join(UPLOAD_DIR, 'ref_' + Date.now() + '.html');
    fs.writeFileSync(htmlPath, html);

    log('[reference-fetcher] Fetched ' + html.length + ' chars from URL', taskId);

    return {
      html: html,
      htmlPath: htmlPath,
      metadata: {
        source: 'url',
        url: url,
        title: title,
        fileSize: Buffer.byteLength(html),
        hasCanvas: /<canvas/i.test(html),
        framework: detectFramework(html),
      }
    };
  } finally {
    await browser.close();
  }
}

/**
 * 处理上传的 HTML 文件
 */
function fetchFromFile(filePath, log, taskId) {
  log('[reference-fetcher] Reading HTML file: ' + filePath, taskId);

  if (!fs.existsSync(filePath)) {
    throw new Error('HTML file not found: ' + filePath);
  }

  var html = fs.readFileSync(filePath, 'utf-8');
  var filename = path.basename(filePath);

  log('[reference-fetcher] Read ' + html.length + ' chars from file: ' + filename, taskId);

  return {
    html: html,
    htmlPath: filePath,
    metadata: {
      source: 'file',
      filename: filename,
      fileSize: Buffer.byteLength(html),
      hasCanvas: /<canvas/i.test(html),
      framework: detectFramework(html),
    }
  };
}

/**
 * 主入口
 * @param {{ url?: string, htmlPath?: string }} input
 * @param {Function} log
 * @param {string} taskId
 * @returns {Promise<{ html, htmlPath, metadata }>}
 */
async function fetchReference(input, log, taskId) {
  if (input.url) {
    return fetchFromURL(input.url, log, taskId);
  }
  if (input.htmlPath) {
    return fetchFromFile(input.htmlPath, log, taskId);
  }
  throw new Error('Must provide url or htmlPath');
}

module.exports = { fetchReference, detectFramework };
