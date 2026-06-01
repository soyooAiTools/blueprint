const { chromium } = require('playwright');
const id = 'proj_1777128165822_6acnqx';
const url = `https://playcools.top/webgl/${id}/index.html`;
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const lines = [];
  page.on('console', m => {
    const t = m.text();
    if (/__PHASE__|__PHASE_STUCK__|GFM_AutoPlay|AutoPlay|error|Error/i.test(t)) {
      lines.push(`[${m.type()}] ${t.slice(0,300)}`);
    }
  });
  page.on('pageerror', e => lines.push('PE: '+String(e).slice(0,300)));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e=>lines.push('goto:'+e.message.slice(0,120)));

  // Inject autoplay flag and observer ready exactly like CUA does
  await page.evaluate(() => {
    setTimeout(() => {
      try {
        const app = window.app || (window.pc && window.pc.app);
        if (!app) { console.log('NO_APP'); return; }
        // Standard CUA injection
        const e = new pc.Entity('__AUTOPLAY_ON__');
        app.root.addChild(e);
        console.log('INJECTED:__AUTOPLAY_ON__');
        setTimeout(() => {
          const e2 = new pc.Entity('__CUA_OBSERVER_READY__');
          app.root.addChild(e2);
          console.log('INJECTED:__CUA_OBSERVER_READY__');
        }, 1500);
      } catch (err) { console.log('INJ_ERR:' + err.message); }
    }, 1500);
  }).catch(()=>{});

  const samples = [];
  for (const t of [5, 10, 15, 20, 25, 30, 40, 50, 60]) {
    await page.waitForTimeout(t === 5 ? 5000 : (t - samples.length === 1 ? 0 : 5000));
    const gs = await page.evaluate(() => {
      const s = window.__gameState;
      if (!s) return null;
      const es = s.entityStates || {};
      const v = s.variables || {};
      return {
        cur: s.currentPhase,
        completed: s.completedPhases,
        gameTimer: v.gameTimer,
        autoPlayMode: v.autoPlayMode,
        autoPlaySteps: v.autoPlaySteps,
        autoPlayStepsThisPhase: v.autoPlayStepsThisPhase,
        SG: es.SpaceGarbage ? { state: es.SpaceGarbage.stateCode, pos: es.SpaceGarbage.position, vis: es.SpaceGarbage.visible } : null,
        MF: es.MetalFragment ? { state: es.MetalFragment.stateCode, pos: es.MetalFragment.position, vis: es.MetalFragment.visible } : null,
        PL: es.player ? { pos: es.player.position, vis: es.player.visible } : null,
        FW: es.ForgeWorkshop ? { pos: es.ForgeWorkshop.position, vis: es.ForgeWorkshop.visible } : null,
      };
    }).catch(()=>null);
    samples.push({ t, gs });
  }
  for (const s of samples) console.log(`T${s.t}s:`, JSON.stringify(s.gs));
  console.log('---LOGS---');
  for (const l of lines.slice(-40)) console.log(' ', l);
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
