const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', msg => {
    const t = msg.text();
    if (/font|Font|DefaultFont|Text|Canvas|Label|guide|Warning|warn|error/i.test(t)) {
      logs.push('[console] ' + t.slice(0, 240));
    }
  });
  page.on('pageerror', e => logs.push('[pageerror] ' + String(e).slice(0, 240)));

  await page.goto('https://playcools.top/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(15000);

  const probe = await page.evaluate(() => {
    try {
      // Luna 全局
      const w = window;
      const luna = w.LunaRuntime || w.Luna || w.unity || null;
      // 列出全部 GameObject 名字（含 Text_*/Label_*/Canvas）
      const names = [];
      const scn = w.GameObject && w.GameObject.FindObjectsOfType ? w.GameObject : (w._scene || null);
      // 用 Luna 内部 lookup
      const all = (w.Luna && w.Luna.scene && w.Luna.scene._all) || [];
      // 退而求其次：扫 window 上含 Text_/Label_/guide 的对象
      const findInScene = () => {
        const out = [];
        try {
          const scenes = (w.UnityEngine && w.UnityEngine.SceneManagement && w.UnityEngine.SceneManagement.SceneManager &&
            w.UnityEngine.SceneManagement.SceneManager.GetActiveScene && w.UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects()) || [];
          const walk = (go, depth) => {
            if (!go || depth > 6) return;
            const n = go.name || (go._name) || '';
            if (n) out.push(' '.repeat(depth*2) + n);
            const t = go.transform || go._transform;
            if (t && t.childCount) {
              for (let i = 0; i < t.childCount; i++) walk(t.GetChild(i).gameObject, depth+1);
            }
          };
          for (const r of scenes) walk(r, 0);
        } catch (e) { out.push('walk-err: ' + e.message); }
        return out;
      };
      const walked = findInScene();

      // 找全局 GFM 实例并读 guideText 状态
      const inst = w.GameFlowManagerMain || w.gameFlowManager || null;
      const guideInfo = (() => {
        try {
          if (!inst) return 'no-instance';
          const gt = inst.guideText;
          if (!gt) return 'guideText-null';
          return {
            text: gt.text,
            font: gt.font ? (gt.font.name || 'unnamed') : 'NULL',
            fontSize: gt.fontSize,
            color: gt.color
          };
        } catch (e) { return 'err: ' + e.message; }
      })();

      return {
        hasLuna: !!luna,
        gameObjectCount: walked.length,
        sampleGOs: walked.slice(0, 50),
        guideInfo,
        gameState: w.__gameState ? { phase: w.__gameState.currentPhase, completed: w.__gameState.completedPhases } : null,
      };
    } catch (e) { return { err: e.message }; }
  });

  console.log('=== probe ===');
  console.log(JSON.stringify(probe, null, 2));
  console.log('\n=== console logs ===');
  for (const l of logs.slice(-40)) console.log(l);

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
