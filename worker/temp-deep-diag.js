// Deep diagnosis: trace Bridge.NET assembly registration and startGame execution
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
  page.on('pageerror', err => errors.push({ t: Date.now(), msg: err.message.substring(0, 500), stack: (err.stack || '').substring(0, 300) }));
  
  // Trace console logs for Bridge registration
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Bridge') || text.includes('Luna') || text.includes('assembly') || 
        text.includes('DIAG') || text.includes('error') || text.includes('Error') ||
        msg.type() === 'error') {
      logs.push({ type: msg.type(), text: text.substring(0, 300) });
    }
  });

  // Inject diagnostic hooks BEFORE page loads
  await page.addInitScript(function() {
    // Hook Bridge.assembly to trace registrations
    var origDefine = null;
    var origAssembly = null;
    var assemblies = [];
    var defines = [];
    
    Object.defineProperty(window, 'Bridge', {
      configurable: true,
      set: function(val) {
        delete window.Bridge;
        window.Bridge = val;
        // Hook Bridge.assembly
        if (val && val.assembly) {
          origAssembly = val.assembly;
          val.assembly = function(name) {
            assemblies.push(name);
            console.log('[DIAG] Bridge.assembly: ' + name);
            return origAssembly.apply(this, arguments);
          };
        }
        // Hook Bridge.define  
        if (val && val.define) {
          origDefine = val.define;
          var defineCount = 0;
          val.define = function(name) {
            defineCount++;
            if (defineCount <= 20 || name.indexOf('Luna.') === 0 || name.indexOf('UnityEngine.') === 0) {
              defines.push(name);
            }
            return origDefine.apply(this, arguments);
          };
        }
      },
      get: function() { return undefined; }
    });
    
    window.__diagAssemblies = assemblies;
    window.__diagDefines = defines;
    
    // Hook startGame
    var origStart = null;
    window.addEventListener('DOMContentLoaded', function() {
      if (window.startGame) {
        origStart = window.startGame;
        window.startGame = function() {
          console.log('[DIAG] startGame called');
          try {
            var result = origStart.apply(this, arguments);
            console.log('[DIAG] startGame returned: ' + typeof result);
            if (result && result.then) {
              result.then(function() { console.log('[DIAG] startGame promise resolved'); })
                    .catch(function(e) { console.log('[DIAG] startGame promise rejected: ' + e); });
            }
            return result;
          } catch(e) {
            console.log('[DIAG] startGame threw: ' + e.message);
            throw e;
          }
        };
      } else {
        console.log('[DIAG] startGame NOT defined at DOMContentLoaded');
      }
    });
  });
  
  await page.goto('http://127.0.0.1:18899/iframe.html', { waitUntil: 'load', timeout: 30000 });
  console.log('Loaded, waiting 15s...');
  await page.waitForTimeout(15000);
  
  const d = await page.evaluate(function() {
    var r = {};
    r.assemblies = window.__diagAssemblies || [];
    r.defines = (window.__diagDefines || []).slice(0, 30);
    r.totalDefines = (window.__diagDefines || []).length;
    r.bridge = typeof Bridge;
    r.bridgeAssembly = typeof Bridge !== 'undefined' && typeof Bridge.assembly;
    r.bridgeReady = typeof Bridge !== 'undefined' && typeof Bridge.ready;
    r.pc = typeof pc;
    r.pcApp = typeof pc !== 'undefined' && pc.Application ? 'exists' : 'missing';
    r.pcTextGen = typeof pc !== 'undefined' && pc.TextGenerator ? 'exists' : 'missing';
    r.luna = typeof Luna;
    r.lunaUnity = typeof LunaUnity;
    r.unityEngine = typeof UnityEngine;
    r.windowApp = typeof window.app;
    r.canvas = !!document.querySelector('canvas');
    
    // Check if Bridge has assemblies registry
    if (typeof Bridge !== 'undefined') {
      r.bridgeKeys = Object.keys(Bridge).filter(k => k.includes('assembl') || k.includes('init') || k === '$').slice(0, 10);
    }
    
    // Try to manually call startGame
    if (!window.app && typeof window.startGame === 'function') {
      try {
        r.manualStartAttempt = 'trying...';
        window.startGame();
        r.manualStartAttempt = 'called, app=' + (typeof window.app);
      } catch(e) {
        r.manualStartAttempt = 'error: ' + e.message;
      }
    }
    
    return r;
  });
  
  console.log('\n=== DEEP DIAGNOSTIC ===');
  console.log(JSON.stringify(d, null, 2));
  console.log('\nConsole logs:', JSON.stringify(logs.slice(0, 20), null, 2));
  console.log('\nPage errors:', JSON.stringify(errors.slice(0, 15), null, 2));
  console.log('=== END ===');
  
  await browser.close();
  server.close();
  process.exit(0);
})();
