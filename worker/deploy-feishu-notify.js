// Deploy feishu-notify.js + updated worker-client.js to Worker ECS via main ECS SSH relay
const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const MAIN_ECS = { host: '120.55.70.226', username: 'root', password: 'Soyoo2026!Ecs' };
const WORKER_DIR = 'D:\\worker-repo\\worker\\';

// Files to upload
const files = [
  { local: path.join(__dirname, 'feishu-notify.js'), remote: WORKER_DIR + 'feishu-notify.js' },
  { local: path.join(__dirname, 'worker-client.js'), remote: WORKER_DIR + 'worker-client.js' },
];

async function run() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject)
      .connect({ ...MAIN_ECS, readyTimeout: 15000 });
  });
  console.log('Connected to main ECS');

  // Upload each file via SCP through main ECS
  for (const f of files) {
    const content = fs.readFileSync(f.local);
    const b64 = content.toString('base64');
    const remotePath = f.remote.replace(/\\/g, '\\\\');
    // Write base64 to temp file on main ECS, then SCP to worker
    const cmd = `export PATH=/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin; echo '${b64}' | base64 -d > /tmp/_deploy_tmp && scp -i /root/.ssh/worker_key -o StrictHostKeyChecking=no /tmp/_deploy_tmp 'Administrator@42.121.160.107:${f.remote}' && echo "UPLOADED ${path.basename(f.local)}"`;
    await new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        stream.on('data', d => out += d.toString());
        stream.stderr.on('data', d => out += d.toString());
        stream.on('close', () => { console.log(out.trim()); resolve(); });
      });
    });
  }

  // Syntax check + PM2 restart on worker
  const restartCmd = `export PATH=/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin; ssh -i /root/.ssh/worker_key -o StrictHostKeyChecking=no Administrator@42.121.160.107 "node -c D:\\worker-repo\\worker\\feishu-notify.js && node -c D:\\worker-repo\\worker\\worker-client.js && cd D:\\worker-repo\\worker && npx pm2 restart worker-unity && echo RESTARTED"`;
  await new Promise((resolve) => {
    conn.exec(restartCmd, (err, stream) => {
      if (err) { console.error(err); return resolve(); }
      let out = '';
      stream.on('data', d => out += d.toString());
      stream.stderr.on('data', d => out += d.toString());
      stream.on('close', () => { console.log(out.trim()); resolve(); });
    });
  });

  conn.end();
  console.log('Deploy complete!');
}

run().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
