const { chromium } = require('playwright');
const id = 'proj_1777128165822_6acnqx';
const url = `https://playcools.top/webgl/${id}/index.html?v=${Date.now()}`;
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', m => {
    const t = m.text();
    if (/__PHASE__|GFM_AutoPlay|AutoPlay|error|Error/i.test(t)) {
      lines.push(`[${m.type()}] ${t.slice(0,300)}`);
    }
  });
  page.on('pageerror', e => lines.push('PE: '+String(e).slice(0,300)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e=>lines.push('goto:'+e.message.slice(0,120)));

  const verify = await page.evaluate(async () => {
    const r = await fetch(location.href, { cache: 'no-store' });
    const t = await r.text();
    return {
      oldDeliver: t.includes('deliverFragmentsForGold'),
      newDeliver: t.includes('deliverFragmentForGold'),
      oldTriple: t.includes('tripleDrillCollectGarbage'),
      newTriple: t.includes('highEfficiencyCollectWithTripleDrill'),
      htmlLen: t.length,
    };
  });
  console.log('VERIFY:', JSON.stringify(verify));

  await page.evaluate(() => {
    setTimeout(() => {
      try {
        const app = window.app || (window.pc && window.pc.app);
        if (!app) { console.log('NO_APP'); return; }
        const e = new pc.Entity('__AUTOPLAY_ON__');
        app.root.addChild(e);
        setTimeout(() => {
          const e2 = new pc.Entity('__CUA_OBSERVER_READY__');
          app.root.addChild(e2);
        }, 1500);
      } catch (err) { console.log('INJ_ERR:' + err.message); }
    }, 1500);
  }).catch(()=>{});

  for (const t of [10, 20, 30, 45, 60, 80]) {
    await page.waitForTimeout(t === 10 ? 10000 : 10000);
    const gs = await page.evaluate(() => {
      const s = window.__gameState;
      if (!s) return null;
      const v = s.variables || {};
      return {
        cur: s.currentPhase,
        completed: s.completedPhases,
        gameTimer: v.gameTimer,
        autoPlayMode: v.autoPlayMode,
        autoPlaySteps: v.autoPlaySteps,
      };
    }).catch(()=>null);
    console.log(`T${t}s:`, JSON.stringify(gs));
  }
  console.log('---LOGS---');
  for (const l of lines.slice(-50)) console.log(' ', l);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
