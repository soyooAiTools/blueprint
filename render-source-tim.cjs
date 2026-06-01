const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  const url = 'file:///tmp/space-ranger-grill/space-ranger-3d.html';
  console.log('navigating', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // wait for Three.js init + first scene render
  await page.waitForTimeout(3500);
  // Hide loading overlay if it stayed
  await page.evaluate(() => { const l=document.getElementById('loading'); if(l) l.style.display='none'; });
  const dim = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  console.log('canvas dim', dim);
  const state = await page.evaluate(() => {
    try { return JSON.stringify(window.__gameState ? window.__gameState() : null).slice(0, 2000); }
    catch (e) { return 'err: ' + e.message; }
  });
  console.log('gameState head:', state);
  await page.screenshot({ path: '/tmp/space-ranger-source-frame1.png', fullPage: false });
  console.log('saved /tmp/space-ranger-source-frame1.png');
  await browser.close();
})();
