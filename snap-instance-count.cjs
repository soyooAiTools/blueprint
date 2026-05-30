// Count GameFlowManagerMain instances and trace where extras come from.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (/instance|GameFlowManagerMain|Start\(\)/i.test(t)) console.log('PG:', t);
  });
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(60000);
  const r = await page.evaluate(() => {
    const out = { instances: 0, gameObjects: [], canvases: 0, texts: 0 };
    try {
      const scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
      const roots = scene.getRootGameObjects();
      for (const ro of roots) {
        out.gameObjects.push(ro.name);
        try {
          const c = ro.GetComponent(GameFlowManagerMain);
          if (c && c.guideText !== undefined) out.instances++;
        } catch(e) {}
        try {
          const cv = ro.GetComponent(UnityEngine.Canvas);
          if (cv) out.canvases++;
        } catch(e) {}
      }
      // Count Text components in the entire scene
      try {
        if (window.__bpTextMirrors) out.texts = window.__bpTextMirrors.size;
      } catch(e) {}
    } catch(e) { out.err = e.message; }
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
