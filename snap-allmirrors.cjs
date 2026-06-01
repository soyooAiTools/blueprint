// Dump every mirror entry (including hidden) so we can find the duplicate-text source.
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
    let i = 0;
    m.forEach((rec, inst) => {
      i++;
      let entityName = 'unknown';
      let parentName = 'unknown';
      let canvasType = '?';
      try {
        const e = inst && inst.handle && inst.handle.entity;
        if (e) {
          entityName = e.name || 'noname';
          parentName = (e.parent && e.parent.name) || 'noparent';
          const screen = e.screen || (typeof e._findScreen === 'function' ? e._findScreen() : null);
          if (screen && screen.screen) {
            if (screen.screen._screenType === 'screen') canvasType = 'overlay';
            else canvasType = 'world';
          }
        }
      } catch(e) {}
      out.push({
        idx: i,
        text: (rec.lastText || '').slice(0, 50),
        display: rec.dom.style.display === 'none' ? 'HIDDEN' : 'visible',
        left: rec.dom.style.left,
        top: rec.dom.style.top,
        scrn: rec.isScreenOverlay,
        canvasType,
        entity: entityName,
        parent: parentName,
        lastUpdate: rec.lastUpdate
      });
    });
    return { count: m.size, items: out };
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
