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
      BLUEPRINT_DISABLE_CLAUDE: '1',
      BLUEPRINT_TEXT_RUNNER: 'codex-exec',
      CODEX_CODE_BACKEND: 'codex-exec',
      CODEX_SCHEMA_PRIMARY_COOLDOWN_MS: 'off',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',  // loaded from .env
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'https://sub.mindrix.app/v1',  // loaded from .env (was hardcoded, caused silent override)
      // Claude runtime is disabled; keep proxy vars only for other outbound tools.
      // FEISHU_WEBHOOK_URL removed 2026-04-17 — feishu notifications disabled
      // Proxy — PM2 cluster mode drops inherited proxy vars from process.env.
      HTTPS_PROXY: process.env.HTTPS_PROXY || '',
      HTTP_PROXY: process.env.HTTP_PROXY || '',
      NO_PROXY: process.env.NO_PROXY || '',
    },
    // 日志配置
    error_file: '/root/.pm2/logs/blueprint-editor-error.log',
    out_file: '/root/.pm2/logs/blueprint-editor-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
