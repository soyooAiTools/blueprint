// Minimal test: load just bridge.js and check Bridge object
const http = require('http');
const fs = require('fs');
const path = require('path');
const buildDir = 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop';
function patchContent(c) {
  return c.replace(/new Event\(([^)]+)\)/g, (m, args) =>
    '(function(){var _e=document.createEvent("Event");_e.initEvent(' + args + ',true,true);return _e;})()');
}
const server = http.createServer((req, res) => {
  let fp = path.join(buildDir, req.url === '/' ? 'test-bridge.html' : req.url).split('?')[0];
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(fp);
  res.writeHead(200, {'Content-Type': ext === '.js' ? 'application/javascript' : 'text/html'});
  res.end(ext === '.html' || ext === '.js' ? patchContent(fs.readFileSync(fp, 'utf8')) : fs.readFileSync(fp));
});

// Create minimal test HTML
const testHtml = `<!DOCTYPE html><html><body>
<script>window.TRACE=false;window.DEBUG=false;window.DEVELOP=true;window.TESTS=false;</script>
<script src="engine/unity/bin/bridge.js"></script>
<script>
document.title = JSON.stringify({
  bridgeType: typeof Bridge,
  bridgeNull: Bridge === null,
  bridgeKeys: typeof Bridge === 'object' && Bridge !== null ? Object.keys(Bridge).slice(0, 10) : 'N/A',
  bridgeAssembly: typeof Bridge === 'object' && Bridge !== null ? typeof Bridge.assembly : 'N/A',
  bridgeDefine: typeof Bridge === 'object' && Bridge !== null ? typeof Bridge.define : 'N/A'
});
</script>
</body></html>`;
fs.writeFileSync(path.join(buildDir, 'test-bridge.html'), testHtml);

(async () => {
  await new Promise(r => server.listen(18899, '127.0.0.1', r));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message.substring(0, 200)));
  await page.goto('http://127.0.0.1:18899/test-bridge.html', { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(2000);
  const title = await page.title();
  console.log('Bridge status:', title);
  console.log('Errors:', JSON.stringify(errors));
  await browser.close();
  server.close();
  process.exit(0);
})();
