// Probe: are any visible world-label mirrors within 30px of each other?
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(50000);
  const result = await page.evaluate(() => {
    const recs = [];
    window.__bpTextMirrors.forEach((rec) => {
      if (rec.dom.style.display === 'none') return;
      if (!rec.lastText) return;
      recs.push({
        text: rec.lastText,
        l: parseFloat(rec.dom.style.left) || 0,
        t: parseFloat(rec.dom.style.top) || 0,
        ws: !!rec.isScreenOverlay ? 'OVL' : 'WS',
      });
    });
    const overlaps = [];
    for (let i = 0; i < recs.length; i++) {
      for (let j = i + 1; j < recs.length; j++) {
        const a = recs[i], b = recs[j];
        if (a.ws !== b.ws) continue;
        const d = Math.hypot(a.l - b.l, a.t - b.t);
        if (d < 30) overlaps.push({ a: a.text.slice(0,20), b: b.text.slice(0,20), d: d.toFixed(0), zone: a.ws });
      }
    }
    return { total: recs.length, recs, overlaps };
  });
  console.log('total visible:', result.total);
  console.log('overlaps:', JSON.stringify(result.overlaps, null, 2));
  result.recs.forEach(r => console.log(`  [${r.ws}] (${r.l.toFixed(0)},${r.t.toFixed(0)})\t${r.text.slice(0,30)}`));
  await page.screenshot({ path: '/tmp/snap-after-singleton.png' });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
