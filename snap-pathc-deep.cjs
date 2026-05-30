// Walk through polyfill logic step-by-step on ONE specific mirror
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('framenavigated', f => console.log('NAV:', f.url().slice(0, 100)));
  page.on('pageerror', e => console.log('ERR:', String(e).slice(0, 200)));
  page.on('crash', () => console.log('CRASH'));
  try { await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 }); } catch(e) { console.log('goto:', e.message); }
  await page.waitForTimeout(40000);

  const r = await page.evaluate(() => {
    try {
    const m = window.__bpTextMirrors;
    const out = {};
    // Find "锻造间"
    let target = null;
    m.forEach((rec, inst) => { if (rec.lastText === '锻造间' && !target) target = { rec, inst }; });
    if (!target) return { err: 'no target' };
    const { rec, inst } = target;
    const ent = inst.handle.entity;
    const el = ent.element;
    out.entEnabled = ent.enabled;
    out.elEnabled = el.enabled;
    out.elScreen = el.screen;
    out.elScreenSpace = el.screen && el.screen.screen ? el.screen.screen.screenSpace : null;
    out.elScreenScreenObj = el.screen && el.screen.screen ? Object.keys(el.screen.screen) : null;
    out.elScreenObj = el.screen ? Object.keys(el.screen).slice(0, 30) : null;
    out.wp = (function(){ var p = ent.getPosition(); return p ? [p.x, p.y, p.z] : null; })();
    // Find AI camera
    const pcApp = window.pc.Application.getApplication();
    let aiCam = null, mainCam = null;
    function walk(n, d) {
      if (d > 6 || !n) return;
      if (n.camera) { if (n.name === 'AI_Camera') aiCam = n.camera; else if (n.name === 'Main Camera') mainCam = n.camera; }
      for (const c of (n.children || [])) walk(c, d + 1);
    }
    walk(pcApp.root, 0);
    out.aiCamFound = !!aiCam;
    out.mainCamFound = !!mainCam;
    out.aiCamPriority = aiCam ? aiCam.priority : null;
    out.mainCamPriority = mainCam ? mainCam.priority : null;
    if (aiCam && out.wp) {
      const v = new window.pc.Vec3(out.wp[0], out.wp[1], out.wp[2]);
      const sp = aiCam.worldToScreen(v);
      out.aiProj = sp ? [sp.x, sp.y, sp.z] : null;
    }
    if (mainCam && out.wp) {
      const v = new window.pc.Vec3(out.wp[0], out.wp[1], out.wp[2]);
      const sp = mainCam.worldToScreen(v);
      out.mainProj = sp ? [sp.x, sp.y, sp.z] : null;
    }
    out.domLeft = rec.dom.style.left;
    out.domTop = rec.dom.style.top;
    out.domDisplay = rec.dom.style.display;
    return out;
    } catch(e) { return { evalErr: String(e).slice(0, 200), stack: e.stack ? e.stack.slice(0, 500) : null }; }
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
