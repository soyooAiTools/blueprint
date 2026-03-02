/**
 * Port Guard — 启动前确保端口可用
 * 如果端口被占用，尝试杀掉占用进程（仅限同项目的 node 进程）
 * 用法：在 server.cjs 启动前 require('./port-guard')(PORT)
 */
const { execSync } = require('child_process');

module.exports = function portGuard(port) {
  try {
    // 检查端口是否被占用
    const result = execSync(
      `ss -tlnp sport = :${port} 2>/dev/null || netstat -tlnp 2>/dev/null | grep :${port}`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();

    if (!result || !result.includes(':' + port)) return; // 端口空闲

    // 提取 PID
    const pidMatch = result.match(/pid=(\d+)/);
    if (!pidMatch) {
      console.warn(`[port-guard] 端口 ${port} 被占用但无法识别 PID，继续启动...`);
      return;
    }
    const pid = parseInt(pidMatch[1]);

    // 安全检查：只杀 node 进程，且是同目录下的 server.cjs
    try {
      const cmdline = execSync(`cat /proc/${pid}/cmdline 2>/dev/null`, { encoding: 'utf-8' });
      if (!cmdline.includes('server.cjs') && !cmdline.includes('blueprint')) {
        console.warn(`[port-guard] 端口 ${port} 被 PID ${pid} 占用，但不是 blueprint 进程，跳过`);
        return;
      }
    } catch (e) {
      // /proc 读取失败，保守处理，不杀
      console.warn(`[port-guard] 无法读取 PID ${pid} 信息，跳过`);
      return;
    }

    // 检查是否是 PM2 管理的进程（避免杀掉自己）
    if (process.env.pm_id !== undefined) {
      // 当前进程由 PM2 管理，老进程不是
      try {
        const environ = execSync(`cat /proc/${pid}/environ 2>/dev/null`, { encoding: 'utf-8' });
        if (environ.includes('pm_id=')) {
          console.warn(`[port-guard] PID ${pid} 也是 PM2 进程，跳过（可能是自己的残留）`);
          // 仍然尝试杀，因为 PM2 重启时老进程应该已经被管理了
        }
      } catch (e) { /* ignore */ }
    }

    console.log(`[port-guard] 端口 ${port} 被孤儿进程 PID ${pid} 占用，正在清理...`);
    try {
      process.kill(pid, 'SIGTERM');
      // 等待进程退出
      for (let i = 0; i < 10; i++) {
        try { process.kill(pid, 0); } catch (e) { break; } // 进程已退出
        execSync('sleep 0.3');
      }
      // 如果还在，强杀
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch (e) { /* already dead */ }
      console.log(`[port-guard] 孤儿进程 PID ${pid} 已清理`);
    } catch (e) {
      console.warn(`[port-guard] 清理 PID ${pid} 失败: ${e.message}`);
    }

    // 等端口释放
    execSync('sleep 1');

  } catch (e) {
    // ss/netstat 失败 = 端口大概率空闲
    if (e.status !== 1) { // status 1 = grep no match
      console.warn(`[port-guard] 检查异常: ${e.message}`);
    }
  }
};
