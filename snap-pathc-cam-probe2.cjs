// Find correct camera lookup API
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const r = await page.evaluate(() => {
    const out = {};
    const pcApp = window.pc.Application.getApplication();
    out.rootName = pcApp.root.name;
    const proto = Object.getPrototypeOf(pcApp.root);
    out.protoMethods = proto ? Object.getOwnPropertyNames(proto).filter(k => /find|child|component/i.test(k)).slice(0, 30) : [];
    // Walk children
    function walk(node, depth, list) {
      if (depth > 5) return;
      try {
        const cs = node.children || [];
        for (const c of cs) {
          if (c.camera) list.push({ name: c.name, hasW2S: typeof c.camera.worldToScreen, enabled: c.enabled, camEnabled: c.camera.enabled });
          walk(c, depth + 1, list);
        }
      } catch(e) {}
    }
    const cams = [];
    walk(pcApp.root, 0, cams);
    out.cams = cams;
    // Try projection with first usable camera
    if (cams.length) {
      // re-walk to get the actual camera component
      function findFirst(node, depth) {
        if (depth > 5 || !node) return null;
        if (node.camera && node.enabled && node.camera.enabled) return node.camera;
        const cs = node.children || [];
        for (const c of cs) {
          const f = findFirst(c, depth + 1);
          if (f) return f;
        }
        return null;
      }
      const cam = findFirst(pcApp.root, 0);
      if (cam) {
        out.projOriginPlus = (function(){ try { const v = new window.pc.Vec3(0,0,0); const sp = cam.worldToScreen(v); return sp ? [sp.x, sp.y, sp.z] : null; } catch(e){ return String(e).slice(0,150);} })();
        out.projTextEntity = (function(){ try { const v = new window.pc.Vec3(-4.5, 3.6, 0.96); const sp = cam.worldToScreen(v); return sp ? [sp.x, sp.y, sp.z] : null; } catch(e){ return String(e).slice(0,150);} })();
      }
    }
    // canvas dims
    out.canvas = (function(){ const c = document.querySelector('canvas'); if (!c) return null; return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }; })();
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
