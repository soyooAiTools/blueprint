#!/usr/bin/env node
/**
 * deploy-to-worker.js
 * 
 * 一键部署到 Worker ECS：git pull + 语法检查 + PM2 restart
 * 
 * 用法：
 *   node scripts/deploy-to-worker.js
 * 
 * 前提：
 *   - 代码已 git push 到 GitHub
 *   - 主 ECS 有 SSH key 到 Worker ECS
 */

const { Client } = require('ssh2');

const MAIN_ECS = { host: '120.55.70.226', username: 'root', password: 'Soyoo2026!Ecs' };
const WORKER_CMD_PREFIX = 'ssh -i /root/.ssh/worker_key Administrator@42.121.160.107';

function run(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', d => stdout += d);
      stream.stderr.on('data', d => stderr += d);
      stream.on('close', code => resolve({ stdout, stderr, code }));
    });
  });
}

async function deploy() {
  const conn = new Client();
  
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(MAIN_ECS);
  });
  console.log('✓ Connected to main ECS');

  const pathSetup = 'export PATH=/usr/local/bin:/usr/bin:/bin:\"${' + 'PATH}\"';

  // Step 1: Git pull on Worker
  console.log('\n[1/3] Git pull on Worker...');
  const pull = await run(conn, `${pathSetup} && ${WORKER_CMD_PREFIX} "D: && cd D:\\worker-repo && git pull origin main 2>&1"`);
  console.log(pull.stdout.trim());
  if (pull.stdout.includes('error') || pull.stdout.includes('fatal')) {
    // Try with proxy disabled
    console.log('Retrying without proxy...');
    const pull2 = await run(conn, `${pathSetup} && ${WORKER_CMD_PREFIX} "D: && cd D:\\worker-repo && set https_proxy= && set http_proxy= && git pull origin main 2>&1"`);
    console.log(pull2.stdout.trim());
  }

  // Step 2: Syntax check
  console.log('\n[2/3] Syntax check...');
  const check = await run(conn, `${pathSetup} && ${WORKER_CMD_PREFIX} "node -c D:\\worker-repo\\worker\\worker-client.js && node -c D:\\worker-repo\\worker\\luna-agent.js && node -c D:\\worker-repo\\worker\\worker-coder.js && node -c D:\\worker-repo\\worker\\worker-preview-check.js && echo SYNTAX_ALL_OK"`);
  console.log(check.stdout.trim());
  
  if (!check.stdout.includes('SYNTAX_ALL_OK')) {
    console.error('❌ SYNTAX CHECK FAILED! Aborting.');
    conn.end();
    process.exit(1);
  }

  // Step 3: PM2 restart
  console.log('\n[3/3] PM2 restart...');
  const restart = await run(conn, `${pathSetup} && ${WORKER_CMD_PREFIX} "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\pm2.cmd restart worker-unity --update-env"`);
  console.log(restart.stdout.includes('online') ? '✓ Worker restarted' : restart.stdout.trim());

  conn.end();
  console.log('\n✅ Deploy complete!');
}

deploy().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
