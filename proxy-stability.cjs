// Test proxy stability for long-running Gemini requests
const { GoogleGenAI } = require('@google/genai');
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const PROXY = 'http://127.0.0.1:7890';
const KEY = 'AIzaSyByfE-DiqRtnURZKnNKi9qTQfVMMxbDaLc'; // Use key 2

// Check Mihomo status first
const http = require('http');

async function checkMihomo() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9090/proxies', { timeout: 3000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const global = j.proxies?.GLOBAL;
          console.log('[Mihomo] Status: OK, current node:', global?.now || 'unknown');
          console.log('[Mihomo] All groups:', Object.keys(j.proxies || {}).filter(k => j.proxies[k].type === 'Selector').join(', '));
        } catch(e) {
          console.log('[Mihomo] Response parse error');
        }
        resolve(true);
      });
    });
    req.on('error', e => { console.log('[Mihomo] NOT reachable:', e.message); resolve(false); });
    req.on('timeout', () => { console.log('[Mihomo] Timeout'); req.destroy(); resolve(false); });
  });
}

async function main() {
  await checkMihomo();

  // Create dispatcher with longer timeouts
  const dispatcher = new ProxyAgent({ 
    uri: PROXY,
    requestTls: { timeout: 120000 },
    connect: { timeout: 30000 },
    bodyTimeout: 120000,
    headersTimeout: 120000,
  });
  setGlobalDispatcher(dispatcher);

  const ai = new GoogleGenAI({ apiKey: KEY });

  // Upload the PDF
  const pdfPath = '/opt/blueprint-editor/server-data/uploads/1774320818704_storyboard.pdf';
  const fs = require('fs');
  if (!fs.existsSync(pdfPath)) {
    // Try the other one
    const alt = '/opt/blueprint-editor/server-data/uploads/1774319870985_storyboard.pdf';
    if (!fs.existsSync(alt)) { console.log('No PDF found'); return; }
  }
  const actualPdf = fs.existsSync(pdfPath) ? pdfPath : '/opt/blueprint-editor/server-data/uploads/1774319870985_storyboard.pdf';
  
  console.log('\n[Test] Uploading PDF...');
  const t0 = Date.now();
  const uploaded = await ai.files.upload({ file: actualPdf, config: { mimeType: 'application/pdf' } });
  console.log('[Test] Upload OK in', Date.now() - t0, 'ms, uri:', uploaded.uri);

  // Now do the actual long generateContent call — the one that's failing
  console.log('\n[Test] Calling generateContent with PDF (this should take 30-50s)...');
  const t1 = Date.now();
  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: [{ role: 'user', parts: [
        { fileData: { fileUri: uploaded.uri, mimeType: 'application/pdf' } },
        { text: '请解析这份 PDF 文档的内容，根据其中的策划文案/需求设计试玩广告分镜板。' }
      ] }],
      config: { 
        temperature: 0.3,
        maxOutputTokens: 65536,
        thinkingConfig: { thinkingBudget: 1024 },
        systemInstruction: '你是分镜专家。输出JSON。',
      },
    });
    console.log('[Test] ✅ OK in', Date.now() - t1, 'ms');
    console.log('[Test] Response length:', result.text?.length);
    console.log('[Test] First 200 chars:', result.text?.substring(0, 200));
  } catch(e) {
    console.log('[Test] ❌ FAILED in', Date.now() - t1, 'ms');
    console.log('[Test] Error:', e.message?.substring(0, 300));
    console.log('[Test] Error code:', e.code);
    console.log('[Test] Error cause:', e.cause?.message?.substring(0, 200));
  }
}

main().catch(e => console.error('Fatal:', e.message));
