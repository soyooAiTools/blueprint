// Probe what font/resource APIs actually exist at runtime in the deployed build.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const allLogs = [];
  page.on('console', msg => allLogs.push('[' + msg.type() + '] ' + msg.text().slice(0,300)));
  page.on('pageerror', e => allLogs.push('[err] ' + String(e).slice(0,300)));
  try {
    await page.goto('https://playcools.top/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'load', timeout: 60000 });
  } catch (e) { console.log('goto-warn:', e.message.slice(0,200)); }
  await page.waitForTimeout(20000);

  const probe = await page.evaluate(() => {
    const out = {};
    try { out.hasUE = !!window.UnityEngine; } catch(e) {}
    try { out.hasUERes = !!(window.UnityEngine && UnityEngine.Resources); } catch(e) {}
    try { out.UEResKeys = window.UnityEngine && UnityEngine.Resources ? Object.keys(UnityEngine.Resources).slice(0,30) : null; } catch(e) {}
    try { out.hasFont = typeof Font !== 'undefined'; } catch(e) {}
    try { out.UEFontKeys = window.UnityEngine && UnityEngine.Font ? Object.keys(UnityEngine.Font).slice(0,30) : null; } catch(e) {}
    try { out.hasPCFont = !!(window.pc && pc.Font); } catch(e) {}
    try { out.pcFontKeys = window.pc && pc.Font ? Object.keys(pc.Font.prototype || {}).slice(0,30) : null; } catch(e) {}
    // Try invoking Resources.Load("DefaultFont") and see what it returns
    try {
      const r = UnityEngine.Resources.Load('DefaultFont');
      out.loadResult = r === null ? 'null' : (typeof r === 'object' ? Object.prototype.toString.call(r) + ':' + JSON.stringify(Object.keys(r).slice(0,10)) : typeof r);
    } catch(e) { out.loadErr = String(e).slice(0,200); }
    try {
      const r1 = UnityEngine.Resources.Load$1('DefaultFont');
      out.load1Result = r1 === null ? 'null' : (typeof r1 === 'object' ? Object.prototype.toString.call(r1) : typeof r1);
    } catch(e) { out.load1Err = String(e).slice(0,200); }
    // Look at canvas/text components in scene
    try {
      const app = window.app || (window.pc && pc.app);
      if (app && app.root) {
        const all = app.root.findComponents('element');
        out.elementCount = all.length;
        out.textElements = all.filter(e => e.type === 'text').map(e => ({
          name: e.entity.name,
          text: (e.text || '').slice(0,40),
          font: e.font ? (e.font.intensity !== undefined ? 'pc.Font' : Object.prototype.toString.call(e.font)) : 'null',
          fontAsset: e.fontAsset || null,
          enabled: e.enabled
        })).slice(0,10);
      }
    } catch(e) { out.sceneErr = String(e).slice(0,200); }
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));
  console.log('--- last 15 logs ---');
  for (const l of allLogs.slice(-15)) console.log(l);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
