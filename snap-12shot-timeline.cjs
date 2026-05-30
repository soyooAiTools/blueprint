// Walk the 12 autoplay phases and grab a screenshot + visible-text snapshot
// at each phase boundary. Output:
//   /tmp/preview-12shot/shot-NN.png  (0..11)
//   /tmp/preview-12shot/timeline.json (per-shot labels + overlay)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const outDir = '/tmp/preview-12shot';
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });

  // Wait for engine boot + first phase
  await page.waitForFunction(() => window.__gameState && window.__gameState.completedPhases !== undefined,
    { timeout: 60000 }).catch(() => {});

  const PHASE_NAMES = [
    'initialCollectSpaceGarbage',
    'deliverFragmentsForGold',
    'buildForgeWorkshop',
    'upgradeTripleDrill',
    'tripleDrillCollectGarbage',
    'upgradeGarbageCrusher',
    'garbageCrusherCollectGarbage',
    'upgradeHydraulicCart',
    'hydraulicCartWork',
    'unlockNewCabins',
    'showCTACompleteStation',
  ];

  // Snap helper: read currentPhase + visible text mirrors
  async function snap(idx, label) {
    const data = await page.evaluate(() => {
      const out = { currentPhase: null, completed: [], labels: [], overlay: [] };
      try {
        if (window.__gameState) {
          out.currentPhase = window.__gameState.currentPhase;
          out.completed = (window.__gameState.completedPhases || []).slice();
          out.gold = (window.__gameState.variables || {}).Gold;
          out.metalFragment = (window.__gameState.variables || {}).MetalFragment;
        }
        const seen = new Set();
        window.__bpTextMirrors && window.__bpTextMirrors.forEach((rec) => {
          if (rec.dom.style.display === 'none') return;
          if (!rec.lastText) return;
          if (seen.has(rec.lastText)) return;
          seen.add(rec.lastText);
          (rec.isScreenOverlay ? out.overlay : out.labels).push(rec.lastText);
        });
      } catch (e) { out.err = e.message; }
      return out;
    });
    const png = path.join(outDir, 'shot-' + String(idx).padStart(2, '0') + '.png');
    await page.screenshot({ path: png });
    console.log('shot ' + idx + ' [' + label + ']  phase=' + data.currentPhase + '  gold=' + data.gold + '  frag=' + data.metalFragment);
    console.log('   labels:', JSON.stringify(data.labels));
    console.log('   overlay:', JSON.stringify(data.overlay));
    return Object.assign({ idx, label }, data);
  }

  // t=0: initial state
  const timeline = [];
  await page.waitForTimeout(8000); // let phase 0 settle (autoPlay activation has 6s real-time delay)
  timeline.push(await snap(0, PHASE_NAMES[0]));

  // For each subsequent phase, wait until completed list grows, then snap
  for (let i = 1; i < PHASE_NAMES.length; i++) {
    const targetCount = i; // we want completedPhases.length >= i (i.e. previous phase done)
    const ok = await page.waitForFunction(
      (n) => (window.__gameState && (window.__gameState.completedPhases || []).length >= n),
      targetCount, { timeout: 30000 }
    ).then(() => true).catch(() => false);
    await page.waitForTimeout(2000); // settle frame after phase advance
    timeline.push(await snap(i, PHASE_NAMES[i]));
    if (!ok) { console.log('  (timeout waiting for phase ' + i + ' — snapped anyway)'); }
  }

  fs.writeFileSync(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  console.log('saved ' + outDir);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
