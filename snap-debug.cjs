const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const allLogs = [];
  page.on('console', msg => { allLogs.push('[' + msg.type() + '] ' + msg.text().slice(0,300)); });
  page.on('pageerror', e => allLogs.push('[err] ' + String(e).slice(0,300)));
  try {
    await page.goto('https://playcools.top/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'load', timeout: 60000 });
  } catch (e) { console.log('goto-warn:', e.message.slice(0,200)); }
  await page.waitForTimeout(20000);
  // Count [font] / [AI] Polyfills / luna:starting handler proof
  const aiPolyfillsCount = allLogs.filter(l => /\[AI\] Polyfills installed/.test(l)).length;
  const fontLogs = allLogs.filter(l => /\[font\]|DefaultFont|defaultfont/i.test(l));
  const starting = await page.evaluate(() => {
    const out = { fontsCheck: false, fontFamilies: [] };
    try { out.fontsCheck = document.fonts.check('16px DefaultFont'); } catch(e) { out.fontsCheckErr = String(e); }
    try { document.fonts.forEach(f => out.fontFamilies.push(f.family + ':' + f.status)); } catch(e) {}
    return out;
  });
  console.log('AI Polyfills installed log count:', aiPolyfillsCount);
  console.log('document.fonts.check("16px DefaultFont"):', starting.fontsCheck);
  console.log('document.fonts families:', starting.fontFamilies);
  console.log('--- font/DefaultFont logs ---');
  for (const l of fontLogs.slice(-30)) console.log(l);
  console.log('--- last 10 of all logs ---');
  for (const l of allLogs.slice(-10)) console.log(l);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
