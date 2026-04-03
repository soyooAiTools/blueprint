module.exports = {
  apps: [{
    name: 'blueprint-editor',
    script: 'server.cjs',
    cwd: '/opt/blueprint-editor',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 3000,          // 重启间隔 3 秒（给端口释放时间）
    kill_timeout: 5000,           // 优雅关闭超时
    listen_timeout: 10000,        // 启动超时
    max_memory_restart: '500M',   // 内存超 500M 自动重启
    env: {
      NODE_ENV: 'production',
      PORT: 3901,
      GOOGLE_GEMINI_BASE_URL: 'https://sub.mindrix.app',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',  // loaded from .env
      GEMINI_MODEL: 'gemini-3.1-pro-preview',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',  // loaded from .env
      OPENAI_BASE_URL: 'https://sub.mindrix.app/v1',
      FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL || '',  // loaded from .env
    },
    // 日志配置
    error_file: '/root/.pm2/logs/blueprint-editor-error.log',
    out_file: '/root/.pm2/logs/blueprint-editor-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
