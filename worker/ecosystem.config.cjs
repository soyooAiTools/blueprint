// PM2 配置 — 环境变量全部走 .env 文件（dotenv），这里只管进程
// 部署路径：D:\worker-repo\worker\
module.exports = {
  apps: [{
    name: 'worker-unity',
    script: 'D:/worker-repo/worker/worker-client.js',
    cwd: 'D:/worker-repo/worker',
    instances: 1,
    exec_mode: 'fork'
  }, {
    name: 'cua-service',
    script: 'D:/worker-repo/worker/cua-service.js',
    cwd: 'D:/worker-repo/worker',
    instances: 1,
    exec_mode: 'fork'
  }]
};
