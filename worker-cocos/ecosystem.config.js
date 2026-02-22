module.exports = {
  apps: [{
    name: 'worker-cocos-client',
    script: './worker-client.js',
    cwd: 'D:\\worker-cocos\\',
    env: { WORKER_ID: 'workerA-cocos' },
    max_restarts: 10,
    restart_delay: 5000
  }]
};
