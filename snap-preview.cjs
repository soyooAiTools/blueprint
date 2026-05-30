const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const projects = [
  { id: 'proj_1777128165822_6acnqx', title: '太空捡垃圾分镜' },
  { id: 'proj_1777128052656_jv3sij', title: '制作子弹' },
  { id: 'proj_1777127917888_9d6223', title: '守护家园' },
  { id: 'proj_1777127900919_8a6j7u', title: '回收子弹' },
  { id: 'proj_1777127909317_ksgqw6', title: '子弹模具' },
  { id: 'proj_1777127928281_k4462r', title: '卖水' },
  { id: 'proj_1777127892659_m0txpu', title: '太空卖氧气' },
  { id: 'proj_1777127867373_p8uyz1', title: '救人泡澡' },
];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });

  for (const p of projects) {
    const url = `https://playcools.top/webgl/${p.id}/index.html`;
    console.log(`[snap] ${p.id} ${p.title} -> ${url}`);
    const page = await ctx.newPage();
    page.on('console', msg => {
      const t = msg.text();
      if (t.includes('__PHASE__') || t.includes('error') || t.includes('Error') || t.includes('GameFlow')) {
        console.log(`  [console:${p.id}] ${t.slice(0, 200)}`);
      }
    });
    page.on('pageerror', e => console.log(`  [pageerror:${p.id}] ${String(e).slice(0, 200)}`));
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (e) {
      console.log(`  [goto-fail:${p.id}] ${e.message.slice(0, 120)}`);
    }
    // wait for WebGL to render
    await page.waitForTimeout(15000);
    const out = path.join('/tmp/preview-shots', `${p.id}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  [saved] ${out}`);
    // try to read __gameState
    try {
      const gs = await page.evaluate(() => {
        const w = window;
        const candidates = ['__gameState', 'gameState', '__GAME_STATE__'];
        for (const k of candidates) if (w[k]) return { key: k, val: w[k] };
        return null;
      });
      if (gs) console.log(`  [gameState:${p.id}] ${JSON.stringify(gs).slice(0, 300)}`);
    } catch {}
    await page.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
