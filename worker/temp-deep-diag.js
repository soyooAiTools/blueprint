// Simplified deep diagnosis — no hooks, just check state after load
const http = require('http');
const fs = require('fs');
const path = require('path');
const buildDir = 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop';

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
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  
  const errors = [];
  page.on('pageerror', err => errors.push(err.message.substring(0, 500)));
  
  await page.goto('http://127.0.0.1:18899/iframe.html', { waitUntil: 'load', timeout: 30000 });
  console.log('Loaded, waiting 15s...');
  await page.waitForTimeout(15000);
  
  const d = await page.evaluate(function() {
    var r = {};
    r.bridge = typeof Bridge;
    r.bridgeNull = (typeof Bridge !== 'undefined' && Bridge === null) ? true : false;
    r.bridgeReady = (typeof Bridge !== 'undefined' && Bridge !== null) ? typeof Bridge.ready : 'N/A';
    r.pc = typeof pc;
    r.pcTextGen = typeof pc !== 'undefined' && pc.TextGenerator ? 'exists' : 'missing';
    r.pcApp = typeof pc !== 'undefined' && pc.Application ? 'exists' : 'missing';
    r.luna = typeof Luna;
    r.lunaNull = (typeof Luna !== 'undefined' && Luna === null) ? true : false;
    try { r.lunaUnityKeys = typeof Luna !== 'undefined' && Luna !== null && Luna.Unity ? Object.getOwnPropertyNames(Luna.Unity).slice(0, 5) : 'N/A'; } catch(e) { r.lunaUnityKeys = 'err:' + e.message; }
    r.lunaUnity = typeof LunaUnity;
    r.unityEngine = typeof UnityEngine;
    r.ueNull = (typeof UnityEngine !== 'undefined' && UnityEngine === null) ? true : false;
    r.ueCamera = (typeof UnityEngine !== 'undefined' && UnityEngine !== null && UnityEngine.Camera) ? 'exists' : 'missing';
    r.ueObject = (typeof UnityEngine !== 'undefined' && UnityEngine !== null && UnityEngine.Object) ? 'exists' : 'missing';
    r.windowApp = typeof window.app;
    r.canvas = !!document.querySelector('canvas');
    try { r.webgl = !!document.querySelector('canvas').getContext('webgl2'); } catch(e) { r.webgl = false; }
    
    r.startGameExists = typeof window.startGame === 'function';
    // Don't call startGame here, just check state
    
    // Check Bridge assembly registry
    if (typeof Bridge !== 'undefined' && Bridge !== null && Bridge.assemblies) {
      r.bridgeAssemblies = Object.keys(Bridge.assemblies);
    } else if (typeof Bridge !== 'undefined' && Bridge !== null) {
      try { r.bridgeProps = Object.keys(Bridge).filter(function(k) { return k.length < 30; }).slice(0, 20); } catch(e) {}
    }
    
    return r;
  });
  
  // Wait a bit more for startGame promise
  await page.waitForTimeout(3000);
  const appAfter = await page.evaluate(function() {
    return { app: typeof window.app, appObj: window.app ? 'exists' : 'null' };
  });
  
  console.log('\n=== DEEP DIAGNOSTIC (new order) ===');
  console.log(JSON.stringify(d, null, 2));
  console.log('After wait:', JSON.stringify(appAfter));
  console.log('Errors (' + errors.length + '):', JSON.stringify(errors.slice(0, 15)));
  console.log('=== END ===');
  
  await browser.close();
  server.close();
  process.exit(0);
})();
