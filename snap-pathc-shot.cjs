// Take a screenshot of the rebuilt HTML with the new positioning
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', msg => logs.push('[' + msg.type() + '] ' + msg.text().slice(0, 200)));
  page.on('pageerror', e => logs.push('[err] ' + String(e).slice(0, 200)));
  await page.goto('file:///tmp/pathc-build.html', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(35000);

  const globals = await page.evaluate(() => {
    const out = {};
    out.hasWinApp = typeof window.app !== 'undefined';
    out.hasPc = typeof window.pc !== 'undefined';
    out.hasPcApp = !!(window.pc && window.pc.app);
    out.hasPcApplication = !!(window.pc && window.pc.Application && window.pc.Application.getApplication);
    if (window.pc && window.pc.Application && window.pc.Application.getApplication) {
      try { const a = window.pc.Application.getApplication(); out.pcGetApp = a ? 'ok' : 'null'; out.appHasRoot = !!(a && a.root); } catch(e) { out.pcGetAppErr = String(e).slice(0,100); }
    }
    // Find any property named 'app' on window
    out.windowAppKeys = Object.keys(window).filter(k => /^app/i.test(k) || /pc/i.test(k)).slice(0, 20);
    return out;
  });
  console.log('=== globals ===');
  console.log(JSON.stringify(globals, null, 2));

  const summary = await page.evaluate(() => {
    const m = window.__bpTextMirrors;
    if (!m) return { mirrors: 0 };
    let visible = 0;
    const visTexts = [];
    m.forEach(rec => {
      if (rec.dom.style.display !== 'none' && rec.lastText) {
        visible++;
        if (visTexts.length < 10) visTexts.push({ text: rec.lastText.slice(0, 30), left: rec.dom.style.left, top: rec.dom.style.top });
      }
    });
    return { mirrors: m.size, visible, visTexts };
  });
  console.log(JSON.stringify(summary, null, 2));

  await page.screenshot({ path: '/tmp/preview-shots/pathc-fullshot.png', fullPage: false, timeout: 60000 });
  console.log('saved /tmp/preview-shots/pathc-fullshot.png');

  console.log('--- log tail ---');
  for (const l of logs.filter(l => /font|overlay|err/i.test(l)).slice(-10)) console.log(l);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
