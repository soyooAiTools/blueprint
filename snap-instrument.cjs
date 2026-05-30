const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => { const t=m.text(); if (t.indexOf('[dedup]') === 0) logs.push(t); });
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);
  // Inject a one-shot frame replacement that logs
  await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    // Manually run Pass 3 with logging 1 time
    const groups = {};
    let i = 0;
    m.forEach(rec => {
      if (rec.dom.style.display === 'none') { return; }
      if (!rec.lastText) return;
      const l = parseFloat(rec.dom.style.left) || 0;
      const t = parseFloat(rec.dom.style.top) || 0;
      const normText = rec.lastText.replace(/\d+/g, '#');
      const key = normText + '@' + Math.floor(l / 80) + ',' + Math.floor(t / 80);
      const prev = groups[key];
      if (!prev) {
        if (rec.lastText.indexOf('Phase 5') === 0) console.log('[dedup] iter', i++, 'first', rec.dom.style.display, rec.lastUpdate);
        groups[key] = rec;
      } else {
        if (rec.lastText.indexOf('Phase 5') === 0) console.log('[dedup] iter', i++, 'dup', rec.dom.style.display, rec.lastUpdate, 'prev', prev.lastUpdate);
        if (rec.lastUpdate >= prev.lastUpdate) {
          prev.dom.style.display = 'none';
          groups[key] = rec;
        } else {
          rec.dom.style.display = 'none';
        }
      }
    });
  });
  await page.waitForTimeout(50);
  console.log('LOGS:', logs);
  // Now check post-state, then check after 200ms
  let state1 = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    const out = [];
    m.forEach(rec => { if (rec.lastText && rec.lastText.indexOf('Phase 5') === 0) out.push({ d: rec.dom.style.display, lu: rec.lastUpdate, l: rec.dom.style.left }); });
    return out;
  });
  console.log('AFTER MANUAL DEDUP:', JSON.stringify(state1));
  await page.waitForTimeout(500);
  let state2 = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    const out = [];
    m.forEach(rec => { if (rec.lastText && rec.lastText.indexOf('Phase 5') === 0) out.push({ d: rec.dom.style.display, lu: rec.lastUpdate, l: rec.dom.style.left }); });
    return out;
  });
  console.log('AFTER 500MS:', JSON.stringify(state2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
