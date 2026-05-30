const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(75000);
  const r = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    const out = [];
    m.forEach(rec => {
      if (rec.dom.style.display === 'none') return;
      if (!rec.lastText) return;
      out.push({ text: rec.lastText.slice(0, 60), left: rec.dom.style.left, top: rec.dom.style.top, scrn: rec.isScreenOverlay });
    });
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
