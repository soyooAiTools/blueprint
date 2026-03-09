// PM2 配置 — 环境变量全部走 .env 文件，这里只管进程
module.exports = {
  apps: [{
    name: 'worker-unity',
    script: 'C:\\worker\\worker-client.js',
    cwd: 'C:\\worker',
    instances: 1,
    exec_mode: 'fork',
    // 不再在此配 env，全部由 dotenv + .env 管理
  }, {
    name: 'cua-service',
    script: 'C:\\worker\\cua-service.js',
    cwd: 'C:\\worker',
    instances: 1,
    exec_mode: 'fork',
  }]
};
