const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const r = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    if (!m) return { err: 'no map' };
    // Manually run dedup logic and report
    const groups = {};
    const trace = [];
    let i = 0;
    m.forEach(rec => {
      if (rec.dom.style.display === 'none') return;
      if (!rec.lastText) return;
      const l = parseFloat(rec.dom.style.left) || 0;
      const t = parseFloat(rec.dom.style.top) || 0;
      const key = rec.lastText + '@' + Math.floor(l / 80) + ',' + Math.floor(t / 80);
      const prev = groups[key];
      const action = !prev ? 'first' : (rec.lastUpdate >= prev.lastUpdate ? 'replace' : 'older');
      if (rec.lastText.indexOf('Phase 5') === 0 || rec.lastText === '废弃回收太空站') {
        trace.push({ i: i++, text: rec.lastText.slice(0, 20), key, l, t, lastUpdate: rec.lastUpdate, action });
      }
      if (!prev) groups[key] = rec;
      else if (rec.lastUpdate >= prev.lastUpdate) groups[key] = rec;
    });
    return { trace };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
