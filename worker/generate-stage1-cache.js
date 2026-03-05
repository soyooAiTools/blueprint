/**
 * One-time script: Start Unity Editor, wait for Bridge, run jake build to generate stage1 cache.
 * Usage: node generate-stage1-cache.js
 */
const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const UNITY_EXE = 'C:\\Program Files\\Unity\\Hub\\Editor\\2021.3.33f1\\Editor\\Unity.exe';
const PROJECT_DIR = 'D:\\work\\test-luna\\Client';
const PIPELINE_DIR = 'D:\\Luna\\pipeline';
const BRIDGE_URL = 'http://localhost:18801/status';

// Check if Unity exe exists, try alternative paths
function findUnity() {
  const candidates = [
    UNITY_EXE,
    'C:\\Program Files\\Unity\\Hub\\Editor\\2021.3.45f1\\Editor\\Unity.exe',
    'C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.33f1\\Editor\\Unity.exe',
  ];
  // Also search for any Unity.exe in Hub
  try {
    const hubDir = 'C:\\Program Files\\Unity\\Hub\\Editor';
    if (fs.existsSync(hubDir)) {
      const versions = fs.readdirSync(hubDir);
      for (const v of versions) {
        candidates.push(path.join(hubDir, v, 'Editor', 'Unity.exe'));
      }
    }
  } catch (e) {}
  
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function checkBridge() {
  return new Promise((resolve) => {
    const req = http.get(BRIDGE_URL, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForBridge(maxWaitMs = 300000) {
  const start = Date.now();
  console.log('[cache] Waiting for Unity Bridge on port 18801...');
  while (Date.now() - start < maxWaitMs) {
    const status = await checkBridge();
    if (status) {
      console.log('[cache] Bridge ready: ' + status);
      return true;
    }
    await new Promise(r => setTimeout(r, 5000));
    process.stdout.write('.');
  }
  console.log('\n[cache] Bridge not ready after ' + (maxWaitMs/1000) + 's');
  return false;
}

async function main() {
  // 1. Find Unity
  const unityExe = findUnity();
  if (!unityExe) {
    // List what's in Program Files\Unity
    console.log('[cache] Unity.exe not found. Checking installed versions...');
    try {
      const out = execSync('dir "C:\\Program Files\\Unity" /s /b 2>&1', { encoding: 'utf-8', timeout: 10000 });
      console.log(out.substring(0, 2000));
    } catch (e) {
      console.log('[cache] Cannot list Unity dir: ' + e.message);
    }
    process.exit(1);
  }
  console.log('[cache] Using Unity: ' + unityExe);

  // 2. Check if Unity is already running
  const bridgeStatus = await checkBridge();
  if (bridgeStatus) {
    console.log('[cache] Unity Bridge already running, skipping Unity launch');
  } else {
    // Start Unity in background (not batchmode - need Luna plugin with Bridge)
    console.log('[cache] Starting Unity Editor with project: ' + PROJECT_DIR);
    const unity = spawn(unityExe, ['-projectPath', PROJECT_DIR], {
      detached: true,
      stdio: 'ignore'
    });
    unity.unref();
    console.log('[cache] Unity PID: ' + unity.pid);
  }

  // 3. Wait for Bridge
  const ready = await waitForBridge(300000); // 5 min
  if (!ready) {
    console.log('[cache] FAILED: Unity Bridge did not start. Check Unity Editor manually.');
    process.exit(1);
  }

  // 4. Run jake project:build
  console.log('[cache] Running jake project:build to generate stage1 cache...');
  const env = { ...process.env, PROJECT_PATH: PROJECT_DIR };
  const jake = spawn('node', [
    '--max-old-space-size=8192',
    'jake.js', '-f', 'Jakefile.js', 'project:build'
  ], {
    cwd: PIPELINE_DIR,
    env,
    stdio: 'inherit'
  });

  jake.on('exit', (code) => {
    console.log('[cache] Jake build exited with code: ' + code);
    
    // Check stage1
    const stage1Dir = path.join(PROJECT_DIR, 'LunaTemp', 'stage1');
    try {
      const files = fs.readdirSync(stage1Dir);
      console.log('[cache] stage1 files: ' + files.length);
      if (files.length > 0) {
        console.log('[cache] SUCCESS! stage1 cache generated.');
      } else {
        console.log('[cache] WARNING: stage1 still empty');
      }
    } catch (e) {
      console.log('[cache] Cannot read stage1: ' + e.message);
    }
    process.exit(code || 0);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
