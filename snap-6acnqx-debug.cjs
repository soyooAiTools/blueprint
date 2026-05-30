const { chromium } = require('playwright');

const id = 'proj_1777128165822_6acnqx';
const url = `https://playcools.top/webgl/${id}/index.html`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();

  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text().slice(0, 240)}`));
  page.on('pageerror', e => logs.push(`PE: ${String(e).slice(0, 240)}`));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(20000);

  // Probe GFM internals via Bridge.NET globals
  const probe = await page.evaluate(() => {
    const w = window;
    const r = { gs: null, hasBridge: !!w.Bridge, gfmKeys: [], errors: [] };
    try {
      r.gs = w.__gameState ? JSON.parse(JSON.stringify(w.__gameState)) : null;
    } catch (e) { r.errors.push('gs:' + e.message); }
    try {
      // Try to find GFM_AutoPlay
      const gfmKeys = Object.keys(w).filter(k => /GFM|GameFlow|AutoPlay/i.test(k));
      r.gfmKeys = gfmKeys.slice(0, 30);
      // Try Bridge.NET resolution
      if (w.Bridge && w.GFM_AutoPlay) {
        const ap = w.GFM_AutoPlay;
        r.autoplay = {
          hasInstance: !!ap.Instance,
        };
        if (ap.Instance) {
          try {
            r.autoplay.warmupReady = ap.Instance.WarmupReady;
            r.autoplay.isActive = ap.Instance.IsActive;
            r.autoplay.checked = ap.Instance.Checked;
            r.autoplay.steps = ap.Instance.Steps;
            r.autoplay.detectRealTime = ap.Instance.DetectRealTime;
          } catch(e) { r.errors.push('ap-probe:' + e.message); }
        }
      }
    } catch (e) { r.errors.push('probe:' + e.message); }
    return r;
  });
  console.log('PROBE:', JSON.stringify(probe).slice(0, 2000));
  console.log('LOGS:');
  logs.slice(-40).forEach(l => console.log(' ', l));

  await page.screenshot({ path: '/tmp/preview-shots/proj_1777128165822_6acnqx-debug.png' });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
