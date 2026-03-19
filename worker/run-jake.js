const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectDir = 'D:\\work\\test-luna';
const jakePath = 'D:\\Luna\\pipeline\\jake.js';
const jakefilePath = 'D:\\Luna\\pipeline\\Jakefile.js';
const logFile = path.join(__dirname, 'jake-output.log');

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
}

fs.writeFileSync(logFile, '');
log('Starting jake...');

try {
  const out = execSync(
    `node "${jakePath}" -f "${jakefilePath}" develop --trace`,
    { cwd: projectDir, timeout: 600000, stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 }
  );
  log('Jake stdout:\n' + out.toString().slice(-5000));
} catch (e) {
  log('Jake failed: ' + (e.message || '').slice(0, 2000));
  if (e.stdout) log('stdout tail:\n' + e.stdout.toString().slice(-3000));
  if (e.stderr) log('stderr tail:\n' + e.stderr.toString().slice(-3000));
}

const iframePath = path.join(projectDir, 'LunaTemp', 'stage4', 'develop', 'iframe.html');
if (fs.existsSync(iframePath)) {
  const cachePath = path.join(projectDir, 'LunaTemp', 'stage1', 'iframe-cache.html');
  fs.copyFileSync(iframePath, cachePath);
  log('iframe.html found (' + (fs.statSync(iframePath).size / 1024).toFixed(1) + 'KB), cached to stage1/iframe-cache.html');
} else {
  log('iframe.html NOT FOUND after jake');
}

log('Done.');
process.exit(0);
