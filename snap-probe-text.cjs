// Probe UnityEngine.UI.Text prototype + an actual Text instance from running scene
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', msg => { /* silent */ });
  try {
    await page.goto('https://playcools.top/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'load', timeout: 60000 });
  } catch (e) { console.log('goto-warn:', e.message.slice(0,200)); }
  await page.waitForTimeout(20000);

  const probe = await page.evaluate(() => {
    const out = {};
    try {
      const T = window.UnityEngine && UnityEngine.UI && UnityEngine.UI.Text;
      out.hasTextClass = !!T;
      if (T) {
        out.textProtoKeys = Object.getOwnPropertyNames(T.prototype || {}).slice(0, 60);
        // find descriptors for "text" property
        const desc = Object.getOwnPropertyDescriptor(T.prototype, 'text');
        out.textDesc = desc ? { hasGet: !!desc.get, hasSet: !!desc.set, value: desc.value !== undefined } : 'none';
      }
      // Also peek at one live instance via app.root.findComponents('element')
      const app = window.app || (window.pc && pc.app);
      if (app && app.root) {
        const els = app.root.findComponents('element');
        const textEls = els.filter(e => e.type === 'text');
        out.textElCount = textEls.length;
        if (textEls[0]) {
          const e = textEls[0];
          out.firstTextEl = {
            entityName: e.entity.name,
            text: (e.text || '').slice(0, 60),
            screenSpace: !!(e.screen && e.screen.screen && e.screen.screen.screenSpace),
            anchor: e.anchor && [e.anchor.x, e.anchor.y, e.anchor.z, e.anchor.w],
            pivot: e.pivot && [e.pivot.x, e.pivot.y],
            calculatedWidth: e.calculatedWidth,
            calculatedHeight: e.calculatedHeight,
            fontSize: e.fontSize
          };
        }
      }
      // Detect how Bridge.NET wraps Text — find parent of text setter
      if (T && T.prototype) {
        const proto = T.prototype;
        // In Bridge.NET, properties often exist as get_text/set_text methods
        const methodNames = Object.getOwnPropertyNames(proto).filter(n => /text/i.test(n));
        out.textRelatedMethods = methodNames.slice(0, 20);
      }
    } catch(e) { out.err = String(e).slice(0,200); }
    return out;
  });
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
