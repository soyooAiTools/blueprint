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
    const cams = [];
    function walk(n, d) {
      if (d > 5 || !n) return;
      if (n.camera) cams.push(n);
      for (const c of (n.children || [])) walk(c, d + 1);
    }
    walk(pcApp.root, 0);
    out.allCams = cams.map(e => {
      const c = e.camera;
      return {
        name: e.name,
        enabled: e.enabled,
        camEnabled: c.enabled,
        priority: c.priority,
        projection: c.projection,
        ortho: c.orthoHeight,
        fov: c.fov,
        nearClip: c.nearClip,
        farClip: c.farClip,
        worldPos: e.getPosition() ? [e.getPosition().x, e.getPosition().y, e.getPosition().z] : null,
        worldRot: e.getEulerAngles ? [e.getEulerAngles().x, e.getEulerAngles().y, e.getEulerAngles().z] : null,
        cullingMask: c.cullingMask,
      };
    });
    // Project a sample world position with each camera
    const v = new window.pc.Vec3(-4.5, 3.6, 0.96);
    out.allProj = cams.map(e => {
      try { const sp = e.camera.worldToScreen(v); return { name: e.name, sp: sp ? [sp.x, sp.y, sp.z] : null }; }
      catch(err) { return { name: e.name, err: String(err).slice(0,80) }; }
    });
    // Project Player position too — find the Player entity
    let player = null;
    function findE(n, d, name) { if (d > 6 || !n) return null; if (n.name === name) return n; for (const c of (n.children || [])) { const f = findE(c, d+1, name); if (f) return f; } return null; }
    player = findE(pcApp.root, 0, 'Player');
    if (player) {
      const pp = player.getPosition();
      out.playerWorld = [pp.x, pp.y, pp.z];
      out.allPlayerProj = cams.map(e => {
        try { const sp = e.camera.worldToScreen(pp); return { name: e.name, sp: sp ? [sp.x, sp.y, sp.z] : null }; }
        catch(err) { return { name: e.name, err: String(err).slice(0,80) }; }
      });
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
