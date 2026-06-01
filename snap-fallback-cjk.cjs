// Test if Chrome with system fonts can render Chinese via plain "sans-serif"
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 750, height: 200 } });
  const page = await ctx.newPage();
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#222">
    <div style="color:white;font:32px sans-serif;padding:20px">默认 sans-serif: 拖动角色移动收集太空垃圾</div>
    <div style="color:yellow;font:32px 'Noto Sans SC',sans-serif;padding:20px">Noto Sans SC: 完成升级粉碎机</div>
  </body></html>`;
  await page.setContent(html);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: '/tmp/fallback-cjk-test.png', fullPage: true });
  console.log('saved /tmp/fallback-cjk-test.png');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
