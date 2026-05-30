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
    const m = window.__bpTextMirrors;
    out.mirrorCount = m ? m.size : 0;
    // Manually run the inner loop logic for ALL mirrors and report breakdown
    const pcApp = window.pc.Application.getApplication();
    let cam = null;
    function walk(n, d) { if (d > 6 || !n) return; if (n.camera && n.enabled && n.camera.enabled) { if (!cam || (n.camera.priority || 0) > (cam.priority || 0)) cam = n.camera; } for (const c of (n.children || [])) walk(c, d + 1); }
    walk(pcApp.root, 0);
    out.camName = cam && cam.entity ? cam.entity.name : null;
    out.camPriority = cam ? cam.priority : null;
    let ok = 0, hidden = 0, behind = 0, off = 0, noEnt = 0, parents = 0;
    const samples = [];
    if (m && cam) {
      const canvasEl = document.querySelector('canvas');
      const rect = canvasEl.getBoundingClientRect();
      const sx = rect.width / canvasEl.width, sy = rect.height / canvasEl.height;
      m.forEach((rec, inst) => {
        try {
          const ent = inst.handle && inst.handle.entity;
          const el = ent && ent.element;
          if (!el || !rec.lastText) { noEnt++; return; }
          if (ent.enabled === false || el.enabled === false) { hidden++; return; }
          let p = ent, dis = false;
          while (p) { if (p.enabled === false) { dis = true; break; } p = p.parent; }
          if (dis) { parents++; return; }
          const wp = ent.getPosition();
          if (!wp) { noEnt++; return; }
          const sp = cam.worldToScreen(wp);
          if (!sp || sp.z < 0) { behind++; return; }
          const dx = sp.x * sx, dy = sp.y * sy;
          if (dx < -200 || dx > rect.width + 200 || dy < -200 || dy > rect.height + 200) {
            off++;
            if (samples.length < 5) samples.push({ kind: 'off', text: rec.lastText.slice(0,30), wp: [wp.x,wp.y,wp.z], sp: [sp.x,sp.y,sp.z], dom: [dx,dy] });
            return;
          }
          ok++;
          if (samples.length < 8) samples.push({ kind: 'ok', text: rec.lastText.slice(0,30), wp: [wp.x,wp.y,wp.z], dom: [Math.round(dx),Math.round(dy)] });
        } catch(e) {}
      });
    }
    out.breakdown = { ok, hidden, behind, off, noEnt, parents };
    out.samples = samples;
    out.canvas = (function(){ const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: r.width, ch: r.height }; })();
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
