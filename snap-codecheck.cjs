const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  // Monkey-patch frame to log Pass 3 outcome
  const r = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    // Run Pass 3 manually now
    const groups = {};
    let dedupHides = 0;
    let visibleBefore = 0;
    m.forEach(rec => {
      if (rec.dom.style.display !== 'none' && rec.lastText) visibleBefore++;
    });
    m.forEach(rec => {
      if (rec.dom.style.display === 'none') return;
      if (!rec.lastText) return;
      const l = parseFloat(rec.dom.style.left) || 0;
      const t = parseFloat(rec.dom.style.top) || 0;
      const normText = rec.lastText.replace(/\d+/g, '#');
      const key = normText + '@' + Math.floor(l / 80) + ',' + Math.floor(t / 80);
      const prev = groups[key];
      if (!prev) { groups[key] = rec; return; }
      if (rec.lastUpdate >= prev.lastUpdate) {
        prev.dom.style.display = 'none'; dedupHides++;
        groups[key] = rec;
      } else {
        rec.dom.style.display = 'none'; dedupHides++;
      }
    });
    let visibleAfter = 0;
    m.forEach(rec => {
      if (rec.dom.style.display !== 'none' && rec.lastText) visibleAfter++;
    });
    return { visibleBefore, visibleAfter, dedupHides };
  });
  console.log(JSON.stringify(r, null, 2));
  // Wait one more frame and re-check
  await page.waitForTimeout(100);
  const r2 = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    let v = 0;
    m.forEach(rec => { if (rec.dom.style.display !== 'none' && rec.lastText) v++; });
    return { visibleAfterFrame: v };
  });
  console.log(JSON.stringify(r2, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
