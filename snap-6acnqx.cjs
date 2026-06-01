const { chromium } = require('playwright');
const path = require('path');

const id = 'proj_1777128165822_6acnqx';
const url = `https://playcools.top/webgl/${id}/index.html?autoplay=1`;
const outDir = '/tmp/preview-shots';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();

  const phases = [];
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('__PHASE__') || t.includes('GameFlow') || /error/i.test(t)) {
      phases.push(t.slice(0, 200));
    }
  });
  page.on('pageerror', e => phases.push('PE: ' + String(e).slice(0, 200)));

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log('goto-fail:', e.message.slice(0, 200));
  }

  await page.waitForTimeout(8000);
  const samples = [
    { name: 'fresh-load', wait: 0 },
    { name: 't10s', wait: 10000 },
    { name: 't25s', wait: 15000 },
    { name: 't45s', wait: 20000 },
    { name: 't70s', wait: 25000 },
    { name: 't100s', wait: 30000 },
  ];
  for (const s of samples) {
    if (s.wait > 0) await page.waitForTimeout(s.wait);
    const out = path.join(outDir, `${id}-${s.name}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log('saved', out);
    try {
      const gs = await page.evaluate(() => {
        const w = window;
        const keys = ['__gameState', 'gameState', '__GAME_STATE__'];
        for (const k of keys) if (w[k]) return { k, v: w[k] };
        return null;
      });
      if (gs) console.log(`  [gs@${s.name}]`, JSON.stringify(gs).slice(0, 400));
    } catch {}
  }
  console.log('PHASES/ERRS:', phases.slice(-30));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
