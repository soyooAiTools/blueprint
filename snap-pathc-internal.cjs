const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', m => { const t=m.text(); if (/font|overlay|cam|warn|err/i.test(t)) console.log('[c]', t.slice(0,250)); });
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const r = await page.evaluate(() => {
    const out = {};
    // Check what __bp_text_overlay element looks like
    const ov = document.getElementById('__bp_text_overlay');
    out.overlayExists = !!ov;
    out.overlayChildren = ov ? ov.children.length : 0;
    // Sample first 5 children inline display
    const samples = [];
    if (ov) {
      for (let i = 0; i < Math.min(8, ov.children.length); i++) {
        const c = ov.children[i];
        samples.push({ display: c.style.display, left: c.style.left, top: c.style.top, text: (c.textContent||'').slice(0,30) });
      }
    }
    out.children = samples;
    // Re-walk mirrors and tally display states
    const m = window.__bpTextMirrors;
    if (m) {
      let displayed = 0, none = 0, empty = 0;
      m.forEach((rec, inst) => {
        if (rec.dom.style.display === 'none') none++;
        else if (rec.dom.style.display === '') empty++;
        else displayed++;
      });
      out.tally = { displayed, none, empty };
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  // Take screenshot
  await page.screenshot({ path: '/tmp/preview-shots/pathc-internal.png', fullPage: false });
  console.log('saved /tmp/preview-shots/pathc-internal.png');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
