/**
 * proxy-doctor.cjs — 代理健康检测与自动修复
 * 修复链: 检测 → 重启 Mihomo → 切节点组 → 直连 fallback
 */

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const notify = require('./notify.cjs');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 7890;
const MIHOMO_API = 'http://127.0.0.1:9090';
const GEMINI_TEST_URL = process.env.GOOGLE_GEMINI_BASE_URL || 'https://sub.mindrix.app';
const TIMEOUT = 3000;
const NODE_GROUPS = ['Gemini专线', '日本节点', '香港节点', '自动选择'];

// Internal state
let _bypassProxy = false;

function getProxyBypass() { return _bypassProxy; }

/**
 * Check if proxy can reach external LLM API
 */
function check() {
  return new Promise((resolve) => {
    const start = Date.now();
    const proxyReq = http.request({
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      method: 'CONNECT',
      path: 'generativelanguage.googleapis.com:443',
      timeout: TIMEOUT,
    });

    proxyReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ ok: false, error: 'CONNECT ' + res.statusCode });
      }

      const tlsSocket = require('tls').connect({
        host: 'generativelanguage.googleapis.com',
        socket: socket,
        servername: 'generativelanguage.googleapis.com',
      }, () => {
        const req = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: '/v1beta/models',
          method: 'HEAD',
          timeout: TIMEOUT,
          createConnection: () => tlsSocket,
        }, (r) => {
          const latency = Date.now() - start;
          tlsSocket.destroy();
          // 200 or 400 (missing key) both mean proxy works
          resolve({ ok: r.statusCode < 500, latencyMs: latency });
        });
        req.on('error', (e) => { tlsSocket.destroy(); resolve({ ok: false, error: e.message }); });
        req.on('timeout', () => { req.destroy(); tlsSocket.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.end();
      });
      tlsSocket.on('error', (e) => { socket.destroy(); resolve({ ok: false, error: 'tls: ' + e.message }); });
    });

    proxyReq.on('error', (e) => resolve({ ok: false, error: e.message }));
    proxyReq.on('timeout', () => { proxyReq.destroy(); resolve({ ok: false, error: 'proxy connect timeout' }); });
    proxyReq.end();
  });
}

/**
 * Simple check: just test if proxy port is open and responds
 */
function quickCheck() {
  return new Promise((resolve) => {
    const req = http.request({ hostname: PROXY_HOST, port: PROXY_PORT, path: 'http://www.gstatic.com/generate_204', method: 'GET', timeout: 2000 }, (res) => {
      resolve({ ok: res.statusCode === 204 || res.statusCode === 200 });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/**
 * Check if direct connection to external LLM works (no proxy)
 */
function checkDirect() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models',
      method: 'HEAD',
      timeout: TIMEOUT,
    }, (r) => {
      resolve({ ok: r.statusCode < 500 });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

/**
 * Step 1: Restart Mihomo
 */
async function restartMihomo() {
  try {
    // Find mihomo PID
    let pid;
    try {
      pid = execSync('pgrep -f "mihomo" 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 }).trim();
    } catch(e) {}

    if (pid) {
      try { execSync('kill ' + pid.split('\n')[0], { timeout: 5000 }); } catch(e) {}
      await new Promise(r => setTimeout(r, 2000));
    }

    // Restart
    try {
      execSync('nohup /usr/local/bin/mihomo -d /etc/mihomo > /dev/null 2>&1 &', { timeout: 5000 });
    } catch(e) {
      // Try alternative path
      execSync('nohup mihomo -d /etc/mihomo > /dev/null 2>&1 &', { timeout: 5000 });
    }

    await new Promise(r => setTimeout(r, 3000)); // Wait for startup
    const result = await check();
    return result;
  } catch(e) {
    return { ok: false, error: 'restart failed: ' + e.message };
  }
}

/**
 * Step 2: Switch node group via Mihomo API
 */
async function switchGroup(groupName) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ name: groupName });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9090,
      path: '/proxies/GLOBAL',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      resolve(res.statusCode === 204 || res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * Full repair chain
 */
async function repair() {
  // Step 0: Quick - trigger node switch first (fastest recovery)
  console.log('[proxy-doctor] Step 0: Triggering node switch...');
  const r0 = await triggerNodeSwitch();
  if (r0.ok) {
    await new Promise(r => setTimeout(r, 1000));
    const c0 = await check();
    if (c0.ok) {
      notify.alert('warning', '代理已恢复', '切换到节点: ' + (r0.fastest || '?') + ' (' + (r0.minDelay || '?') + 'ms)');
      return { ok: true, method: 'node-switch:' + r0.fastest };
    }
  }

  // Step 1: Restart Mihomo
  console.log('[proxy-doctor] Step 1: Restarting Mihomo...');
  notify.alert('warning', '代理不通，正在重启 Mihomo', '');
  const r1 = await restartMihomo();
  if (r1.ok) {
    notify.alert('warning', '代理已恢复', 'Mihomo 重启成功');
    return { ok: true, method: 'restart' };
  }

  // Step 2: Try switching node groups
  console.log('[proxy-doctor] Step 2: Switching node groups...');
  for (const group of NODE_GROUPS) {
    console.log('[proxy-doctor] Trying group:', group);
    const switched = await switchGroup(group);
    if (switched) {
      await new Promise(r => setTimeout(r, 2000));
      const r2 = await check();
      if (r2.ok) {
        notify.alert('warning', '已切换代理节点组: ' + group, 'latency: ' + (r2.latencyMs || '?') + 'ms');
        return { ok: true, method: 'switch:' + group };
      }
    }
  }

  // Step 3: Direct connection fallback
  console.log('[proxy-doctor] Step 3: Trying direct connection...');
  const r3 = await checkDirect();
  if (r3.ok) {
    _bypassProxy = true;
    notify.alert('warning', '代理不可用，已切换直连模式', '后续 LLM 调用将不走代理');
    return { ok: true, method: 'direct' };
  }

  // All failed
  notify.alert('critical', '代理完全不可用，需人工介入', '重启/切组/直连全部失败');
  return { ok: false, error: 'all repair methods failed' };
}

/**
 * Ensure proxy is available (check → repair if needed)
 */
async function ensure() {
  // If bypassing proxy, check direct still works
  if (_bypassProxy) {
    const d = await checkDirect();
    if (d.ok) return { ok: true, method: 'direct' };
    // Direct no longer works, try proxy again
    _bypassProxy = false;
  }

  const c = await check();
  if (c.ok) return { ok: true, latencyMs: c.latencyMs };

  // Proxy not working, attempt repair
  console.log('[proxy-doctor] Proxy check failed:', c.error);
  return await repair();
}



/**
 * Switch specific node within proxy group (Clash 'Gemini专线' — legacy name) via delay test
 * Triggers URLTest to pick fastest node automatically
 */
async function triggerNodeSwitch() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 9090,
      path: '/proxies/Gemini%E4%B8%93%E7%BA%BF/delay?timeout=3000&url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204',
      method: 'GET',
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const delays = JSON.parse(data);
          // Find fastest node
          let fastest = null, minDelay = Infinity;
          for (const [name, info] of Object.entries(delays)) {
            if (info.delay > 0 && info.delay < minDelay) {
              minDelay = info.delay;
              fastest = name;
            }
          }
          if (fastest) {
            console.log('[proxy-doctor] Fastest node: ' + fastest + ' (' + minDelay + 'ms)');
          }
          resolve({ ok: true, fastest, minDelay });
        } catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.end();
  });
}

module.exports = { triggerNodeSwitch, check, quickCheck, checkDirect, ensure, repair, getProxyBypass };
