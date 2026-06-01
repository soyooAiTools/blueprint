// Probe how to actually reach a working camera
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (/cam|app|projection|err/i.test(t)) console.log('[c]', t.slice(0,300)); });
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const r = await page.evaluate(() => {
    const out = {};
    const pcApp = (window.pc && window.pc.Application && window.pc.Application.getApplication) ? window.pc.Application.getApplication() : null;
    out.pcAppOk = !!pcApp;
    out.pcAppRootOk = !!(pcApp && pcApp.root);
    out.winAppEqualsPcApp = (window.app === pcApp);
    out.winAppType = typeof window.app;
    try {
      out.winAppHasRoot = !!(window.app && window.app.root);
    } catch(e) { out.winAppErr = String(e).slice(0,100); }
    if (pcApp && pcApp.root) {
      try {
        const cams = pcApp.root.findComponents('camera');
        out.camsCount = cams.length;
        out.camsEnabled = cams.map(c => ({ enabled: c.enabled, hasW2S: typeof c.worldToScreen, name: c.entity && c.entity.name }));
        if (cams[0]) {
          const c = cams[0];
          // Try projecting an arbitrary world position
          try {
            const v = new window.pc.Vec3(0, 1, 0);
            const sp = c.worldToScreen(v);
            out.proj_origin = sp ? [sp.x, sp.y, sp.z] : null;
          } catch(e) { out.proj_err = String(e).slice(0,150); }
        }
      } catch(e) { out.findErr = String(e).slice(0,150); }
    }
    // Inspect a sample mirror's entity world pos
    const m = window.__bpTextMirrors;
    if (m) {
      m.forEach((rec, inst) => {
        if (out.sample) return;
        try {
          const ent = inst.handle && inst.handle.entity;
          if (!ent || !rec.lastText) return;
          const wp = ent.getPosition();
          const lp = ent.getLocalPosition();
          let parentChain = [];
          let p = ent;
          for (let i = 0; i < 8 && p; i++) { parentChain.push({ name: p.name, enabled: p.enabled }); p = p.parent; }
          out.sample = {
            text: rec.lastText.slice(0,30),
            entityName: ent.name,
            world: wp ? [wp.x, wp.y, wp.z] : null,
            local: lp ? [lp.x, lp.y, lp.z] : null,
            parentChain
          };
          if (pcApp && pcApp.root) {
            const cams = pcApp.root.findComponents('camera');
            if (cams[0] && wp) {
              try {
                const sp = cams[0].worldToScreen(wp);
                out.sampleProj = sp ? [sp.x, sp.y, sp.z] : null;
              } catch(e) { out.sampleProjErr = String(e).slice(0,120); }
            }
          }
        } catch(e) {}
      });
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
