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
    // Show ALL mirrors with phase 5 text — display, lastUpdate, position
    const phase5 = [];
    m.forEach(rec => {
      if (rec.lastText && rec.lastText.indexOf('Phase 5') === 0) {
        const l = parseFloat(rec.dom.style.left) || 0;
        const t = parseFloat(rec.dom.style.top) || 0;
        const norm = rec.lastText.replace(/\d+/g, '#');
        phase5.push({
          display: rec.dom.style.display,
          lastUpdate: rec.lastUpdate,
          left: rec.dom.style.left,
          top: rec.dom.style.top,
          fullText: rec.lastText,
          normKey: norm + '@' + Math.floor(l/80) + ',' + Math.floor(t/80)
        });
      }
    });
    return { phase5Count: phase5.length, phase5 };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
