// Trigger direct luna build with existing C# sources
const fs = require('fs');
const path = require('path');
const http = require('http');

const srcDir = '/opt/blueprint-editor/server-data/project-sources/proj_1777128165822_6acnqx';
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.cs'));
const main = files.find(f => f === 'GameFlowManagerMain.cs');
if (!main) { console.error('GameFlowManagerMain.cs not found'); process.exit(1); }

const csCode = fs.readFileSync(path.join(srcDir, main), 'utf8');
const extraFiles = {};
for (const f of files) {
  if (f === main) continue;
  extraFiles[f] = fs.readFileSync(path.join(srcDir, f), 'utf8');
}

const body = JSON.stringify({ csCode, className: 'GameFlowManagerMain', extraFiles, taskId: 'pathc-test' });
console.log('csCode:', csCode.length, 'chars; extraFiles:', Object.keys(extraFiles).length);

const req = http.request({
  hostname: '127.0.0.1', port: 18860, path: '/build', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  let chunks = [];
  res.on('data', d => chunks.push(d));
  res.on('end', () => {
    const buf = Buffer.concat(chunks);
    try {
      const j = JSON.parse(buf.toString());
      console.log('ok:', j.ok, 'buildTime:', j.buildTime, 'htmlSize:', j.htmlSize);
      if (j.ok && j.htmlBase64) {
        const html = Buffer.from(j.htmlBase64, 'base64').toString('utf8');
        const out = '/tmp/pathc-build.html';
        fs.writeFileSync(out, html);
        console.log('wrote', out, 'len:', html.length);
        // Quick check: does the polyfill string exist in the output?
        console.log('has DOM overlay polyfill:', html.indexOf('DOM text overlay') >= 0);
      } else {
        console.log('error:', (j.error || '').slice(0, 500));
      }
    } catch(e) {
      console.log('parse err:', e.message, 'raw:', buf.toString().slice(0, 300));
    }
  });
});
req.on('error', e => console.error('req err:', e.message));
req.write(body);
req.end();
