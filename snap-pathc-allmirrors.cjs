const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const r = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    if (!m) return { err: 'no mirrors map' };
    const all = [];
    m.forEach((rec, inst) => {
      try {
        const ent = inst.handle && inst.handle.entity;
        const el = ent && ent.element;
        const out = { text: rec.lastText.slice(0, 30), display: rec.dom.style.display, left: rec.dom.style.left, top: rec.dom.style.top };
        if (ent) {
          out.entName = ent.name;
          out.entEnabled = ent.enabled;
          // Parent chain enabled states
          let p = ent, chain = [];
          for (let i = 0; i < 8 && p; i++) { chain.push(p.name + ':' + p.enabled); p = p.parent; }
          out.chain = chain.join(' > ');
        }
        if (el) {
          out.elEnabled = el.enabled;
          out.elScreen = !!el.screen;
          if (el.screen) {
            out.screenSpace = !!(el.screen.screen && el.screen.screen.screenSpace);
            out.refRes = el.screen.screen && el.screen.screen.referenceResolution ? [el.screen.screen.referenceResolution.x, el.screen.screen.referenceResolution.y] : null;
          }
        }
        all.push(out);
      } catch(e) { all.push({ err: String(e).slice(0,80) }); }
    });
    return { count: m.size, items: all };
  });
  console.log('total', r.count);
  // Print all items as terse table
  for (const it of r.items) {
    console.log(JSON.stringify(it));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
