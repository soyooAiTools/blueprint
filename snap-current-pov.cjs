const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('__PHASE__') || t.includes('GFM_') || t.includes('error')) {
      console.error('[browser]', t);
    }
  });
  await page.goto('file:///opt/blueprint-editor/server-data/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(15000);
  const fs = require('fs');
  if (!fs.existsSync('/tmp/preview-shots/current')) fs.mkdirSync('/tmp/preview-shots/current', { recursive: true });

  const shots = [];
  for (let i = 0; i < 10; i++) {
    const p = `/tmp/preview-shots/current/t${String(i).padStart(2, '0')}.png`;
    await page.screenshot({ path: p, fullPage: false, timeout: 30000 });
    const state = await page.evaluate(() => {
      const m = window.__bpTextMirrors;
      if (!m) return { err: 'no mirror' };
      const labels = [];
      const overlay = [];
      m.forEach(rec => {
        if (!rec.dom || rec.dom.style.display === 'none' || !rec.lastText) return;
        if (rec.isScreenOverlay) overlay.push(rec.lastText);
        else labels.push(rec.lastText);
      });
      let gameState = null;
      try { gameState = window.__gameState ? JSON.parse(JSON.stringify(window.__gameState)) : null; } catch (e) {}
      return {
        labels: Array.from(new Set(labels)),
        overlay: Array.from(new Set(overlay)),
        phase: gameState && gameState.currentPhase,
        completed: gameState && gameState.completedPhases,
        guideText: gameState && gameState.guideText,
        score: gameState && gameState.score,
      };
    });
    shots.push({ t: i, ...state });
    await page.waitForTimeout(7000);
  }
  console.log(JSON.stringify(shots, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
