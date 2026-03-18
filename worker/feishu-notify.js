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
// actionRequired: true = 需要人工操作, false = 仅通知(系统自动处理)
const EVENT_META = {
  task_started:      { plan: '→ AI 正在根据蓝图生成代码，预计 3-5 分钟', actionRequired: false },
  coding_done:       { plan: '→ 编译代码中，通过后进入预览检查', actionRequired: false },
  build_done:        { plan: '→ 构建完成，准备进入 CUA 自动验证', actionRequired: false },
  preview_check:     { plan: '→ 预览正常，CUA 将自动操控验证分镜覆盖度', actionRequired: false },
  compile_error:     { plan: '→ AI 自动修复编译错误中（最多 10 轮）', actionRequired: false },
  cua_pass:          { plan: '→ 上传产物后等待人工审核', actionRequired: false },
  cua_round:         { plan: '→ AI 根据 CUA 反馈自动修复重试中', actionRequired: false },
  cua_fail:          { plan: '→ AI 增量修复后自动重试', actionRequired: false },
  task_retry:        { plan: '→ 自动重试中，连续失败 3 次将终止', actionRequired: false },
  retry:             { plan: '→ 瞬态错误，自动重试', actionRequired: false },
  task_failed:       { plan: '→ 本轮失败，自动进入下一轮重试', actionRequired: false },
  task_failed_final: { plan: '→ 已耗尽所有重试。常见原因：编译死循环、CUA 无法覆盖分镜、环境异常', actionRequired: true },
  timeout:           { plan: '→ 任务执行超时。可能是编译卡住或 CUA 循环过多', actionRequired: true },
  stuck:             { plan: '→ Worker 可能卡住，建议 SSH 检查进程状态', actionRequired: true },
  done:              { plan: '→ 可以在 playcools.top 查看结果并审核', actionRequired: true }
};

async function send(taskId, event, message, extra) {
  try {
    const token = await getTenantToken();
    const icon = EVENT_ICONS[event] || '📋';
    const proj = (extra && extra.projectName) || taskId;
    const color = EVENT_COLORS[event] || 'blue';

    const meta = EVENT_META[event] || { plan: '继续执行', actionRequired: false };
    // If debugBy is set (e.g. "小白"), override actionRequired to show agent is handling it
    const debugBy = extra && extra.debugBy;
    const actionTag = debugBy
      ? `\n\n🤖 **${debugBy}正在处理**，无需操作`
      : meta.actionRequired
        ? '\n\n🔔 **需要你操作**'
        : '\n\n💤 仅通知，系统自动处理中';

    const card = {
      msg_type: 'interactive',
      receive_id: NICK_OPEN_ID,
      content: JSON.stringify({
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: `${icon} ${proj}${debugBy ? ` 🤖 ${debugBy}处理中` : meta.actionRequired ? ' ⚠️ 需要你' : ''}` },
          template: color
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**事件**: ${event}\n**消息**: ${message}\n**方案**: ${meta.plan}${actionTag}\n**任务ID**: ${taskId}`
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
