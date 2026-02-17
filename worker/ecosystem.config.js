module.exports = {
  apps: [{
    name: 'worker-client',
    script: 'C:\\worker\\worker-client.js',
    cwd: 'C:\\worker',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      WORKER_ID: 'workerA',
      BASE_URL: 'https://playcools.top/blueprintEditor'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'C:\\worker\\logs\\error.log',
    out_file: 'C:\\worker\\logs\\out.log',
    merge_logs: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
  }]
};
