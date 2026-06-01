// Probe: do world-label DOM mirrors track moving entities each frame?
// Take 2 samples 1.5s apart while game is autoplay-stepping; report whether
// each Label_* mirror's DOM left/top changed when its parent entity moved.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(45000); // let game progress past initial phase

  async function snap() {
    return await page.evaluate(() => {
      const out = [];
      try {
        const mirrors = window.__bpTextMirrors;
        if (!mirrors) return [{ err: 'no mirrors map' }];
        mirrors.forEach((rec, inst) => {
          if (rec.dom.style.display === 'none') return;
          if (rec.isScreenOverlay) return; // only world-space
          if (!rec.lastText) return;
          // Try to find the C# Text component's transform position
          let wp = null, parentName = null;
          try {
            const handle = inst.handle, entity = handle && handle.entity;
            if (entity) {
              wp = entity.getPosition();
              const par = entity.parent;
              parentName = par && par.name;
            }
          } catch (e) {}
          out.push({
            text: rec.lastText,
            domLeft: parseFloat(rec.dom.style.left) || 0,
            domTop: parseFloat(rec.dom.style.top) || 0,
            wpX: wp ? wp.x.toFixed(3) : null,
            wpY: wp ? wp.y.toFixed(3) : null,
            wpZ: wp ? wp.z.toFixed(3) : null,
            parentName,
          });
        });
      } catch (e) { out.push({ err: e.message }); }
      return out;
    });
  }

  const a = await snap();
  await page.waitForTimeout(1500);
  const b = await snap();

  const byText = {};
  a.forEach(x => byText[x.text] = { a: x });
  b.forEach(x => { byText[x.text] = byText[x.text] || {}; byText[x.text].b = x; });

  console.log('Label\tdomΔ\twpΔ\tparent');
  Object.keys(byText).forEach(t => {
    const r = byText[t]; if (!r.a || !r.b) return;
    const dx = r.b.domLeft - r.a.domLeft;
    const dy = r.b.domTop - r.a.domTop;
    const wpdx = (parseFloat(r.b.wpX) || 0) - (parseFloat(r.a.wpX) || 0);
    const wpdz = (parseFloat(r.b.wpZ) || 0) - (parseFloat(r.a.wpZ) || 0);
    console.log(`${t.slice(0,25).padEnd(25)}\tdom=${dx.toFixed(0)},${dy.toFixed(0)}\twp=${wpdx.toFixed(2)},${wpdz.toFixed(2)}\t${r.a.parentName||''}`);
  });

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
