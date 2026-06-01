// Probe what fetch returns for different URL forms
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', msg => { /* silent */ });
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(15000);

  const probe = await page.evaluate(async () => {
    const out = {};
    const tries = ['./resources/DefaultFont.ttf', 'resources/DefaultFont.ttf', '/resources/DefaultFont.ttf'];
    for (const u of tries) {
      try {
        const r = await fetch(u);
        const ab = await r.arrayBuffer();
        out[u] = { ok: r.ok, status: r.status, len: ab.byteLength, first4: Array.from(new Uint8Array(ab).slice(0,4)) };
      } catch(e) { out[u] = { err: String(e).slice(0,150) }; }
    }
    // Try direct FontFace from one of them
    try {
      const r = await fetch('./resources/DefaultFont.ttf');
      const buf = await r.arrayBuffer();
      const ff = new FontFace('TestFont', buf);
      const loaded = await ff.load();
      out.loadOk = true;
    } catch(e) {
      out.loadErr = String(e).slice(0,200);
    }
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
