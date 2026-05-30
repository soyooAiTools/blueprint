// Test FontFace creation outside any Luna context
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', m => console.log('[c]', m.text().slice(0,200)));
  page.on('pageerror', e => console.log('[e]', String(e).slice(0,200)));
  // Serve a tiny static page
  const html = `<!doctype html><html><body><script>
    (async ()=>{
      try {
        const r = await fetch('http://127.0.0.1:9876/wqy.ttc');
        console.log('fetch ok:', r.ok, 'status:', r.status);
        const buf = await r.arrayBuffer();
        console.log('buf len:', buf.byteLength);
        const ff = new FontFace('TF', buf);
        const loaded = await ff.load();
        console.log('LOADED OK:', loaded.family, loaded.status);
        document.fonts.add(loaded);
        console.log('check:', document.fonts.check('16px TF'));
      } catch(e) { console.log('ERR:', String(e).slice(0,200)); }
    })();
  </script></body></html>`;
  await page.goto('http://127.0.0.1:9876/');
  await page.setContent(html);
  await page.waitForTimeout(8000);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
