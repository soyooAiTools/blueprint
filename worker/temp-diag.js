// Run directly on Worker: node temp-diag-worker.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const buildDir = 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop';

if (!fs.existsSync(buildDir)) {
  console.log('ERROR: buildDir not found');
  process.exit(1);
}

function patchContent(content, filename) {
  let p = content;
  p = p.replace(/new Event\(([^)]+)\)/g, (m, args) =>
    '(function(){var _e=document.createEvent("Event");_e.initEvent(' + args + ',true,true);return _e;})()');
  if (filename && filename.includes('UnityEngine')) {
    p = p.replace(/return this\.(\w+)\$\.enabled&&this\.(\w+)\$\.(\w+)\$/g,
      (m, a, b, d) => 'return (this.' + a + '$?this.' + a + '$.enabled:false)&&(this.' + b + '$?this.' + b + '$.' + d + '$:false)');
  }
  return p;
}

const server = http.createServer((req, res) => {
  let fp = path.join(buildDir, req.url === '/' ? 'iframe.html' : req.url).split('?')[0];
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(fp).toLowerCase();
  const mime = {'.html':'text/html','.js':'application/javascript','.json':'application/json','.png':'image/png'}[ext] || 'application/octet-stream';
  if (ext === '.html' || ext === '.js') {
    res.writeHead(200, {'Content-Type': mime});
    res.end(patchContent(fs.readFileSync(fp, 'utf8'), path.basename(fp)));
    return;
  }
  res.writeHead(200, {'Content-Type': mime});
  fs.createReadStream(fp).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(18899, '127.0.0.1', r));
  console.log('Server on 18899');
  
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  
  const errors = [];
  page.on('pageerror', err => errors.push(err.message.substring(0, 300)));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('[console] ' + msg.text().substring(0, 300)); });
  
  await page.addInitScript(function() {
    window.__lunaEvents = [];
    var orig = window.dispatchEvent.bind(window);
    window.dispatchEvent = function(evt) {
      if (evt && evt.type && (evt.type.indexOf('luna') >= 0 || evt.type === 'bridge:ready' || evt.type === 'playground:started')) {
        window.__lunaEvents.push({ t: Date.now(), e: evt.type });
      }
      return orig(evt);
    };
  });
  
  await page.goto('http://127.0.0.1:18899/iframe.html', { waitUntil: 'load', timeout: 30000 });
  console.log('Loaded, waiting 10s...');
  await page.waitForTimeout(10000);
  
  const d = await page.evaluate(function() {
    var r = {};
    r.events = window.__lunaEvents || [];
    r.bridge = typeof Bridge;
    r.lunaUnity = typeof LunaUnity;
    r.unityEngine = typeof UnityEngine;
    r.windowApp = typeof window.app;
    r.appType = window.app ? window.app.constructor.name : 'none';
    r.pc = typeof pc;
    r.env = typeof window.$environment !== 'undefined' ? Object.keys(window.$environment).join(',') : 'undefined';
    r.scenes = (window.$environment && window.$environment.scenes) || [];
    r.canvas = !!document.querySelector('canvas');
    try { r.webgl = !!document.querySelector('canvas').getContext('webgl2'); } catch(e) { r.webgl = false; }
    r.scripts = document.querySelectorAll('script').length;
    try {
      if (typeof UnityEngine !== 'undefined' && UnityEngine.Object) {
        var rr = UnityEngine.Object.FindObjectsOfType$1(UnityEngine.Renderer);
        r.renderers = rr ? rr.length : 0;
        if (rr && rr.length > 0) { r.sample = []; for (var i=0;i<Math.min(10,rr.length);i++) r.sample.push(rr[i].gameObject.name); }
      } else { r.renderers = 'N/A'; }
    } catch(e) { r.renderers = 'err:' + e.message; }
    try { r.gfm = typeof GameFlowManagerMain !== 'undefined'; } catch(e) { r.gfm = false; }
    r.gameState = window.__gameState || null;
    return r;
  });
  
  console.log('\n=== DIAGNOSTIC ===');
  console.log(JSON.stringify(d, null, 2));
  console.log('Errors:', JSON.stringify(errors.slice(0, 20)));
  console.log('=== END ===');
  
  await browser.close();
  server.close();
  process.exit(0);
})();
