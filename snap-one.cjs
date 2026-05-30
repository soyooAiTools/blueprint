const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 1334 } });
  const page = await ctx.newPage();
  const interestingLogs = [];
  page.on('console', msg => {
    const t = msg.text();
    if (/font|Font|DefaultFont|VisualGuide|MarkPlayer|HighlightTarget|guide|Warning|warn|error|FAIL/i.test(t)) {
      interestingLogs.push(t.slice(0, 240));
    }
  });
  page.on('pageerror', e => interestingLogs.push('[err] ' + String(e).slice(0,240)));
  try {
    await page.goto('https://playcools.top/webgl/proj_1777128165822_6acnqx/index.html', { waitUntil: 'load', timeout: 60000 });
  } catch (e) {
    console.log('goto-warn:', e.message.slice(0, 120));
  }
  await page.waitForTimeout(25000);
  await page.screenshot({ path: '/tmp/preview-shots/proj_1777128165822_6acnqx-after-l1.png', fullPage: false, timeout: 60000 });
  console.log('saved /tmp/preview-shots/proj_1777128165822_6acnqx-after-l1.png');
  console.log('--- logs ---');
  for (const l of interestingLogs.slice(-40)) console.log(l);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
