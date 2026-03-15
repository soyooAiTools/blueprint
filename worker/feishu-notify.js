// feishu-notify.js — Send Feishu DM to Nick via App Bot API
// Usage: require('./feishu-notify.js').send(taskId, event, message, extra)

const https = require('https');

const APP_ID = process.env.FEISHU_APP_ID || 'cli_a921d57203789cb3';
const APP_SECRET = process.env.FEISHU_APP_SECRET || 'PE41pQTmRcV6krYt2frcDbaRvJe7HWeK';
const NICK_OPEN_ID = process.env.FEISHU_NICK_OPEN_ID || 'ou_e7cf275f3a87e9f36d17bcf4ea042bb0';

let _token = null;
let _tokenExpiry = 0;

function httpsPost(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 10000
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { resolve({ code: -1, msg: 'parse error' }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function getTenantToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await httpsPost('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: APP_ID, app_secret: APP_SECRET
  });
  if (res.tenant_access_token) {
    _token = res.tenant_access_token;
    _tokenExpiry = Date.now() + (res.expire - 300) * 1000; // refresh 5 min early
    return _token;
  }
  throw new Error('Failed to get tenant token: ' + JSON.stringify(res));
}

const EVENT_ICONS = {
  task_started: '🚀', task_failed: '❌', task_failed_final: '💀',
  task_retry: '🔄', timeout: '⏰', cua_round: '🔍',
  cua_pass: '✅', build_done: '🔨', coding_done: '📝',
  preview_check: '🖥️', retry: '🔄', done: '🎉',
  stuck: '🚨', compile_error: '🔴', cua_fail: '⚠️'
};

const EVENT_COLORS = {
  task_failed: 'red', task_failed_final: 'red', timeout: 'red',
  compile_error: 'red', stuck: 'red',
  done: 'green', cua_pass: 'green',
  task_started: 'blue', coding_done: 'blue', build_done: 'blue',
  preview_check: 'green',
  cua_round: 'yellow', cua_fail: 'yellow', task_retry: 'yellow', retry: 'yellow'
};

// 每类事件的处理方案说明
const EVENT_PLANS = {
  task_started: '→ AI 将根据蓝图分镜生成代码，预计 3-5 分钟',
  coding_done: '→ 接下来编译代码，通过后进入预览检查',
  build_done: '→ 构建完成，准备进入 CUA 自动验证',
  preview_check: '→ 预览正常，CUA(GPT-5.4) 将自动操控游戏验证分镜覆盖度',
  compile_error: '→ AI 将自动尝试修复编译错误（最多 10 轮），如果反复失败会重新生成代码',
  cua_pass: '→ 任务即将完成！上传产物后等待人工审核',
  cua_round: '→ AI 将根据 CUA 反馈重新编码修复，然后重新构建+验证',
  cua_fail: '→ 同上，AI 增量修复后重试',
  task_retry: '→ 自动重试中，如果连续失败 3 次将终止并通知',
  retry: '→ 瞬态错误，自动重试',
  task_failed: '→ 本轮失败，进入下一轮重试',
  task_failed_final: '→ ⚠️ 已耗尽所有重试次数。需要人工介入排查根因。常见原因：编译死循环、CUA 无法覆盖分镜、环境异常',
  timeout: '→ 任务执行超时。可能是编译卡住或 CUA 循环过多。建议检查 Worker 日志',
  stuck: '→ Worker 可能卡住，建议 SSH 检查进程状态',
  done: '→ 🎉 可以在 playcools.top 查看结果并审核'
};

async function send(taskId, event, message, extra) {
  try {
    const token = await getTenantToken();
    const icon = EVENT_ICONS[event] || '📋';
    const proj = (extra && extra.projectName) || taskId;
    const color = EVENT_COLORS[event] || 'blue';

    const card = {
      msg_type: 'interactive',
      receive_id: NICK_OPEN_ID,
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `${icon} ${proj}` },
          template: color
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**事件**: ${event}\n**消息**: ${message}\n**方案**: ${EVENT_PLANS[event] || '继续执行'}\n**任务ID**: ${taskId}`
            }
          }
        ]
      })
    };

    const res = await httpsPost('open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=open_id', card, {
      'Authorization': 'Bearer ' + token
    });

    if (res.code !== 0) {
      console.error('[feishu-notify] Send failed:', res.code, res.msg);
    }
    return res;
  } catch(e) {
    console.error('[feishu-notify] Error:', e.message);
  }
}

module.exports = { send };
