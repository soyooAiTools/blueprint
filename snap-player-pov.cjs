// Take a series of screenshots over ~60s to evaluate game flow comprehensibility
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  // Wait for engine to start
  await page.waitForTimeout(20000);
  const fs = require('fs');
  if (!fs.existsSync('/tmp/preview-shots/player')) fs.mkdirSync('/tmp/preview-shots/player', { recursive: true });

  const shots = [];
  // Take 12 snapshots over 90s, recording the visible Phase + counter at each moment
  for (let i = 0; i < 12; i++) {
    const path = `/tmp/preview-shots/player/t${String(i).padStart(2, '0')}.png`;
    await page.screenshot({ path, fullPage: false, timeout: 30000 });
    const state = await page.evaluate(() => {
      const m = window.__bpTextMirrors;
      if (!m) return { err: 'no map' };
      const labels = [];
      const overlayPrompts = [];
      m.forEach(rec => {
        if (rec.dom.style.display === 'none' || !rec.lastText) return;
        if (rec.isScreenOverlay) overlayPrompts.push(rec.lastText);
        else labels.push(rec.lastText);
      });
      return { labels: Array.from(new Set(labels)), overlayPrompts };
    });
    shots.push({ t: i, path, state });
    await page.waitForTimeout(7000);
  }
  console.log(JSON.stringify(shots.map(s => ({ t: s.t, labels: s.state.labels, overlay: s.state.overlayPrompts })), null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
