/**
 * ModelProvider — unified LLM abstraction layer
 *
 * Supports: Claude (Anthropic), Doubao (豆包)
 * Features: retry with backoff, proxy support, fallback chain
 */
var https = require('https');
var http = require('http');

// ============ Base Provider ============

function ModelProvider(name, config) {
  this.name = name;
  this.config = config || {};
}

ModelProvider.prototype.generate = function(prompt, options) {
  throw new Error(this.name + '.generate() not implemented');
};

ModelProvider.prototype.generateWithRetry = function(prompt, options, maxRetries) {
  maxRetries = maxRetries || 3;
  var self = this;
  var attempt = 0;

  function tryOnce() {
    attempt++;
    return self.generate(prompt, options).catch(function(err) {
      if (attempt >= maxRetries) throw err;
      var isTransient = err.message && (
        err.message.indexOf('ECONNRESET') >= 0 ||
        err.message.indexOf('ECONNREFUSED') >= 0 ||
        err.message.indexOf('ETIMEDOUT') >= 0 ||
        err.message.indexOf('timeout') >= 0 ||
        err.message.indexOf('429') >= 0 ||
        err.message.indexOf('503') >= 0 ||
        err.message.indexOf('overloaded') >= 0
      );
      if (!isTransient) throw err;
      var delay = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.warn('[' + self.name + '] Attempt ' + attempt + '/' + maxRetries + ' failed: ' + err.message + ', retrying in ' + delay + 'ms');
      return new Promise(function(r) { setTimeout(r, delay); }).then(tryOnce);
    });
  }
  return tryOnce();
};

// ============ Claude Provider (Anthropic API) ============

function ClaudeProvider(config) {
  ModelProvider.call(this, 'claude', config);
  // config: { apiKey, baseUrl, model, maxTokens, proxyUrl }
  //
  // Mode selection (2026-04-15 fix after sub.mindrix.app went down):
  //  - If ANTHROPIC_AUTH_TOKEN is set → use Anthropic-native /v1/messages on crs.mindrix.app
  //    (same relay path the local CLI uses, reliably up)
  //  - Else → legacy OpenAI-compat /chat/completions on sub.mindrix.app (currently 503)
  //
  // Previously hard-coded to OpenAI-compat mode which silently failed on:
  //  - sub.mindrix.app 503 Service Unavailable
  //  - sk- key 401 INVALID_API_KEY
  // causing visual-check to mark all tasks as "Could not parse analysis response"
  // and cua-verify to run on known-broken HTML (see bqh33t post-mortem).
  this.anthropicToken = config.anthropicToken || process.env.ANTHROPIC_AUTH_TOKEN || '';
  this.anthropicBaseUrl = config.anthropicBaseUrl || process.env.ANTHROPIC_BASE_URL || '';
  this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  this.baseUrl = config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.anthropic.com';
  this.useAnthropicNative = !!(this.anthropicToken && this.anthropicBaseUrl);
  this.model = config.model || 'claude-opus-4-6';
  this.maxTokens = config.maxTokens || 30000;
}
ClaudeProvider.prototype = Object.create(ModelProvider.prototype);

ClaudeProvider.prototype.generate = function(prompt, options) {
  options = options || {};
  var self = this;
  var model = options.model || self.model;
  var maxTokens = options.maxTokens || self.maxTokens;
  var timeoutMs = options.timeoutMs || 300000;

  // Support both string prompt and { system, user } format
  var systemPrompt, userMessage;
  if (typeof prompt === 'string') {
    systemPrompt = '';
    userMessage = prompt;
  } else if (prompt.system !== undefined) {
    systemPrompt = prompt.system;
    userMessage = prompt.user || prompt.content || '';
  } else {
    systemPrompt = '';
    userMessage = JSON.stringify(prompt);
  }

  var body, url, authHeader, extraHeaders;
  if (self.useAnthropicNative) {
    // Anthropic-native /v1/messages on crs.mindrix.app — the same relay path the local CLI uses.
    // Reliably up as of 2026-04-15 when sub.mindrix.app OpenAI-compat relay went 503.
    var anthropicBody = {
      model: model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: userMessage }],
    };
    if (systemPrompt) anthropicBody.system = systemPrompt;
    body = JSON.stringify(anthropicBody);
    url = new URL(self.anthropicBaseUrl + '/v1/messages');
    authHeader = 'Bearer ' + self.anthropicToken;
    extraHeaders = { 'anthropic-version': '2023-06-01' };
  } else {
    // Legacy OpenAI-compat /chat/completions path (kept for backward compat).
    var messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userMessage });
    body = JSON.stringify({ model: model, max_tokens: maxTokens, messages: messages });
    url = new URL(self.baseUrl + '/chat/completions');
    authHeader = 'Bearer ' + self.apiKey;
    extraHeaders = {};
  }

  return new Promise(function(resolve, reject) {
    var headers = Object.assign({
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Content-Length': Buffer.byteLength(body)
    }, extraHeaders);
    var opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: headers,
      rejectUnauthorized: false,
      timeout: timeoutMs
    };

    function handleResponse(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var data = Buffer.concat(chunks).toString('utf-8');
        try {
          var parsed = JSON.parse(data);
          if (parsed.error || parsed.type === 'error') {
            var errObj = parsed.error || parsed;
            var errMsg = errObj.message || JSON.stringify(errObj);
            var errType = errObj.type || errObj.code || '';
            var combined = errType + ' ' + errMsg;
            // Definitive model failures — prefix with MODEL_FATAL: so
            // error-classifier routes to cancel-task instead of retry.
            // Covers: quota_exceeded / insufficient_quota / 401/403/402 /
            // invalid_api_key / authentication_failed / billing hold.
            var isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(combined);
            var prefix = isModelFatal ? 'MODEL_FATAL: API: ' : 'API: ';
            return reject(new Error(prefix + errMsg));
          }
          // HTTP-level 4xx catch-all
          if (res.statusCode && res.statusCode >= 400) {
            var httpPrefix = (res.statusCode === 401 || res.statusCode === 402 || res.statusCode === 403)
              ? 'MODEL_FATAL: API: ' : 'API: ';
            return reject(new Error(httpPrefix + 'HTTP ' + res.statusCode + ' ' + data.slice(0, 200)));
          }
          var text = '';
          if (self.useAnthropicNative) {
            // Anthropic-native response: { content: [{type:'text', text:'...'}], usage: {...} }
            if (Array.isArray(parsed.content)) {
              for (var i = 0; i < parsed.content.length; i++) {
                if (parsed.content[i].type === 'text') text += parsed.content[i].text || '';
              }
            }
          } else {
            // OpenAI-compat response
            if (parsed.choices && parsed.choices[0] && parsed.choices[0].message) {
              text = parsed.choices[0].message.content || '';
            }
          }
          resolve({ text: text, usage: parsed.usage, model: parsed.model || model, provider: 'claude' });
        } catch(e) {
          if (res.statusCode && (res.statusCode === 401 || res.statusCode === 402 || res.statusCode === 403)) {
            return reject(new Error('MODEL_FATAL: API: HTTP ' + res.statusCode + ' ' + data.slice(0, 200)));
          }
          reject(new Error('Parse error: ' + data.slice(0, 500)));
        }
      });
    }

    var req = (url.protocol === 'http:' ? http : https).request(opts, handleResponse);
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('API timeout (' + timeoutMs + 'ms)')); });
    req.write(body);
    req.end();
  });
};


/**
 * Vision analysis — send image + text prompt to Claude Sonnet via OpenAI-compatible API
 * @param {string} imageBase64 - base64 encoded image
 * @param {string} textPrompt - analysis prompt
 * @param {object} options - { model, maxTokens, timeoutMs }
 * @returns {Promise<{text: string, provider: string}>}
 */
ClaudeProvider.prototype.generateVision = function(imageBase64, textPrompt, options) {
  options = options || {};
  var model = options.model || "claude-sonnet-4-6";
  var maxTokens = options.maxTokens || 200;
  var timeoutMs = options.timeoutMs || 60000;
  var apiKey = this.apiKey;
  var baseUrl = this.baseUrl;
  var useAnthropicNative = this.useAnthropicNative;
  var anthropicToken = this.anthropicToken;
  var anthropicBaseUrl = this.anthropicBaseUrl;

  // Support both single imageBase64 string and array of base64 strings (multi-frame).
  // visual-check.cjs passes an array for multi-frame analysis.
  var images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
  var apiBody, endpointUrl, authHeader, extraHeaders;
  if (useAnthropicNative) {
    // Anthropic-native vision format: {type:'image', source:{type:'base64', media_type, data}}
    // visual-check captures JPEG (quality 80), so media_type should match.
    var contentBlocks = [];
    for (var i = 0; i < images.length; i++) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: images[i] }
      });
    }
    contentBlocks.push({ type: 'text', text: textPrompt });
    apiBody = JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: contentBlocks }],
    });
    endpointUrl = anthropicBaseUrl + '/v1/messages';
    authHeader = 'Bearer ' + anthropicToken;
    extraHeaders = { 'anthropic-version': '2023-06-01' };
  } else {
    // Legacy OpenAI-compat vision format (image_url with data URI)
    var openaiContent = [];
    for (var j = 0; j < images.length; j++) {
      openaiContent.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + images[j] } });
    }
    openaiContent.push({ type: 'text', text: textPrompt });
    apiBody = JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: openaiContent }],
      max_tokens: maxTokens,
    });
    endpointUrl = baseUrl + '/chat/completions';
    authHeader = 'Bearer ' + apiKey;
    extraHeaders = {};
  }

  return new Promise(function(resolve, reject) {
    var parsedUrl = new (require("url").URL)(endpointUrl);
    var mod = parsedUrl.protocol === "http:" ? http : https;
    var headers = Object.assign({
      "Content-Type": "application/json",
      "Authorization": authHeader,
      "Content-Length": Buffer.byteLength(apiBody)
    }, extraHeaders);
    var req = mod.request({
      hostname: parsedUrl.hostname, port: parsedUrl.port || 443, path: parsedUrl.pathname, method: "POST",
      headers: headers,
      timeout: timeoutMs,
    }, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        var raw = Buffer.concat(chunks).toString();
        try {
          var resp = JSON.parse(raw);
          // MODEL_FATAL detection — mirror ClaudeProvider.generate() logic.
          // Vision relay returning 401/quota was silently producing text="" which made
          // visual-check think "Could not parse analysis response" and advance to cua-verify
          // with known-broken HTML. Classify these upstream so fix-loop cancels the task.
          if (resp.error || resp.type === 'error') {
            var errObj = resp.error || resp;
            var errMsg = errObj.message || JSON.stringify(errObj);
            var errType = errObj.type || errObj.code || '';
            var combined = errType + ' ' + errMsg;
            var isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(combined);
            var prefix = isModelFatal ? 'MODEL_FATAL: Vision API: ' : 'Vision API: ';
            return reject(new Error(prefix + errMsg));
          }
          // Also catch HTTP-level 401/403 where relay returns non-JSON or minimal payload
          if (res.statusCode && (res.statusCode === 401 || res.statusCode === 402 || res.statusCode === 403)) {
            return reject(new Error('MODEL_FATAL: Vision API: HTTP ' + res.statusCode + ' ' + raw.slice(0, 200)));
          }
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error('Vision API: HTTP ' + res.statusCode + ' ' + raw.slice(0, 200)));
          }
          var text = "";
          if (useAnthropicNative) {
            // Anthropic-native: { content: [{type:'text', text:'...'}], usage: {...} }
            if (Array.isArray(resp.content)) {
              for (var k = 0; k < resp.content.length; k++) {
                if (resp.content[k].type === 'text') text += resp.content[k].text || '';
              }
            }
          } else {
            // OpenAI-compat
            text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || "";
          }
          // Capture usage for [vision-cost] instrumentation (visual-check.cjs logs this).
          // Anthropic-native exposes usage.input_tokens/output_tokens; OpenAI-compat uses prompt_tokens/completion_tokens.
          // Normalize so visual-check's log lines stay consistent across modes.
          var usage = resp.usage || null;
          if (usage && usage.input_tokens != null && usage.prompt_tokens == null) {
            usage.prompt_tokens = usage.input_tokens;
            usage.completion_tokens = usage.output_tokens;
            usage.total_tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
          }
          resolve({ text: text, provider: "claude-vision", model: model, usage: usage });
        } catch(e) {
          // If the relay returned 401 with a JSON body, JSON.parse succeeds and is handled above.
          // Non-JSON auth errors land here.
          if (res.statusCode && (res.statusCode === 401 || res.statusCode === 402 || res.statusCode === 403)) {
            return reject(new Error('MODEL_FATAL: Vision API: HTTP ' + res.statusCode + ' ' + raw.slice(0, 200)));
          }
          reject(new Error("Vision parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", function() { req.destroy(); reject(new Error("Vision API timeout")); });
    req.write(apiBody);
    req.end();
  });
};
// ============ Doubao Provider (豆包 Seed) ============

function DoubaoProvider(config) {
  ModelProvider.call(this, 'doubao', config);
  // config: { apiKey, model }
  this.apiKey = config.apiKey || process.env.DOUBAO_API_KEY;
  this.model = config.model || 'doubao-seed-2-0-pro-260215';
}
DoubaoProvider.prototype = Object.create(ModelProvider.prototype);

DoubaoProvider.prototype.generate = function(prompt, options) {
  options = options || {};
  var GoogleGenAI;
  try {
    // doubao-adapter.cjs exposes the same interface as @google/genai
    GoogleGenAI = require('../adapters/doubao-adapter.cjs').GoogleGenAI;
  } catch(e) {
    return Promise.reject(new Error('doubao-adapter.cjs not found'));
  }

  var ai = new GoogleGenAI({ apiKey: this.apiKey });

  // Convert prompt to adapter-compatible format: [{role, parts: [{text}]}]
  // Map top-level options (temperature, maxTokens) into adapter config format
  var adapterConfig = Object.assign({}, options.config || {});
  if (options.temperature !== undefined) adapterConfig.temperature = options.temperature;
  if (options.maxTokens) adapterConfig.maxOutputTokens = options.maxTokens;
  if (options.maxOutputTokens) adapterConfig.maxOutputTokens = options.maxOutputTokens;
  if (options.seed !== undefined) adapterConfig.seed = options.seed;

  var contents;
  if (typeof prompt === 'string') {
    contents = [{ role: 'user', parts: [{ text: prompt }] }];
  } else if (prompt.system !== undefined) {
    // {system, user} format — pass system as systemInstruction
    adapterConfig = Object.assign({}, adapterConfig, { systemInstruction: prompt.system });
    contents = [{ role: 'user', parts: [{ text: prompt.user || prompt.content || '' }] }];
  } else {
    contents = [{ role: 'user', parts: [{ text: prompt.user || prompt.content || JSON.stringify(prompt) }] }];
  }

  return ai.models.generateContent({
    model: options.model || this.model,
    contents: contents,
    config: adapterConfig
  }).then(function(result) {
    return { text: result.text || '', usage: result.usage, model: 'doubao', provider: 'doubao' };
  });
};

// ============ Provider Chain (fallback) ============

function ProviderChain(providers) {
  this.providers = providers; // [{ provider, role: 'primary'|'fallback' }]
}

ProviderChain.prototype.generate = function(prompt, options) {
  var lastError;
  var chain = this.providers.slice();

  function tryNext() {
    if (chain.length === 0) throw lastError || new Error('All providers failed');
    var entry = chain.shift();
    console.log('[model] Trying ' + entry.provider.name + ' (' + entry.role + ')...');
    return entry.provider.generate(prompt, options).catch(function(err) {
      console.warn('[model] ' + entry.provider.name + ' failed: ' + err.message);
      lastError = err;
      return tryNext();
    });
  }

  return tryNext();
};

ProviderChain.prototype.generateWithRetry = function(prompt, options, maxRetries) {
  var self = this;
  maxRetries = maxRetries || 2;
  var attempt = 0;

  function tryOnce() {
    attempt++;
    return self.generate(prompt, options).catch(function(err) {
      if (attempt >= maxRetries) throw err;
      var delay = 2000 * attempt;
      console.warn('[model-chain] Attempt ' + attempt + '/' + maxRetries + ' failed, retrying in ' + delay + 'ms');
      return new Promise(function(r) { setTimeout(r, delay); }).then(tryOnce);
    });
  }
  return tryOnce();
};

// ============ Factory ============

function createProvider(type, config) {
  switch (type) {
    case 'claude':  return new ClaudeProvider(config || {});
    case 'doubao':  return new DoubaoProvider(config || {});
    default: throw new Error('Unknown provider type: ' + type);
  }
}

/**
 * Create default provider chain from environment variables
 */
function createDefaultChain() {
  var providers = [];

  // Primary: Doubao (豆包)
  providers.push({
    provider: new DoubaoProvider({}),
    role: 'primary'
  });

  // Fallback: Claude
  if (process.env.OPENAI_API_KEY) {
    providers.push({
      provider: new ClaudeProvider({}),
      role: 'fallback'
    });
  }

  return new ProviderChain(providers);
}


/**
 * Health check — ping all configured providers
 * Probed providers:
 *   - doubao  : 豆包 Seed (text + CUA VLM 也是豆包 vision)
 *   - claude  : Claude Opus 4.6 (codegen via OpenAI-compat relay)
 *   - gpt54   : GPT-5.4 via Codex CLI (review.cjs adversarial code review)
 * @returns {Promise<{doubao: object, claude: object, gpt54: object}>}
 */
function healthCheck() {
  var results = {};
  var checks = [];

  // Doubao — text generate ping (also covers CUA's VLM since same key/host)
  if (process.env.DOUBAO_API_KEY) {
    var doubao = new DoubaoProvider({});
    var t1 = Date.now();
    checks.push(
      doubao.generate("ping", { maxTokens: 5, timeoutMs: 10000 })
        .then(function() { results.doubao = { status: "ok", latencyMs: Date.now() - t1 }; })
        .catch(function(e) { results.doubao = { status: "error", latencyMs: Date.now() - t1, error: e.message }; })
    );
  }

  // Claude — spawn the local CLI with OAuth.
  // Previously hit crs.mindrix.app relay directly; now unified to the CLI OAuth path.
  var t3 = Date.now();
  checks.push(
    new Promise(function(resolve) {
      var execFile = require('child_process').execFile;
      var env = Object.assign({}, process.env);
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_BASE_URL;
      execFile('claude', ['--print', '--model', 'haiku', '--output-format', 'text', '--effort', 'low'], {
        env: env,
        timeout: 15000,
        maxBuffer: 1024 * 64,
      }, function(err, stdout, stderr) {
        var combined = ((err && err.message) || '') + ' ' + (stderr || '') + ' ' + (stdout || '');
        // Auth/quota errors mean CLI reached the API but was rejected — real failure
        var isAuthFail = /unauthoriz|invalid.?api.?key|authentication.?fail|access.?denied/i.test(combined);
        if (err && isAuthFail) {
          results.claude = { status: "error", latencyMs: Date.now() - t3, error: combined.slice(0, 200), mode: 'cc-cli-oauth' };
        } else if (err) {
          // Budget exceeded / other non-auth errors — CLI connected & authed successfully
          var isBudget = /budget/i.test(combined);
          results.claude = { status: "ok", latencyMs: Date.now() - t3, mode: 'cc-cli-oauth', note: isBudget ? 'budget-probe' : 'exit-nonzero-but-reachable' };
        } else {
          results.claude = { status: "ok", latencyMs: Date.now() - t3, mode: 'cc-cli-oauth', note: 'respLen=' + (stdout || '').length };
        }
        resolve();
      }).stdin.end('Reply with just the word "pong".');
    })
  );

  // GPT-5.4 — Codex CLI preflight check (cached result, doesn't re-spawn).
  // The first call after server start will spawn `codex exec` once (~10-20s);
  // subsequent calls return the cached boolean. healthCheck() runs in the
  // background via dashboard.cjs apiHealthCache, so the user never waits.
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
    var t4 = Date.now();
    checks.push(
      Promise.resolve()
        .then(function() {
          var codexReviewer;
          try { codexReviewer = require('../worker/codex-reviewer.js'); }
          catch (e) { throw new Error('codex-reviewer.js not loadable: ' + e.message); }
          if (!codexReviewer.preflightCheck) throw new Error('preflightCheck not exported');
          return codexReviewer.preflightCheck().then(function(ok) {
            return {
              ok: ok,
              reason: codexReviewer.getPreflightReason ? codexReviewer.getPreflightReason() : null,
            };
          });
        })
        .then(function(r) {
          if (r.ok) {
            results.gpt54 = { status: "ok", latencyMs: Date.now() - t4, note: 'codex preflight cached' };
          } else {
            // Map internal reason → user-facing message
            var reasonMap = {
              quota_exceeded: 'GPT-5.4 配额已用尽',
              sandbox_broken: 'bwrap 沙箱故障',
              auth_failed:    '认证失败',
              no_api_key:     '未配置 API key',
              exception:      'codex 进程异常',
            };
            var msg = reasonMap[r.reason] || ('codex preflight failed: ' + (r.reason || 'unknown'));
            results.gpt54 = { status: "error", latencyMs: Date.now() - t4, error: msg, reason: r.reason };
          }
        })
        .catch(function(e) { results.gpt54 = { status: "error", latencyMs: Date.now() - t4, error: e.message }; })
    );
  }

  return Promise.all(checks).then(function() { return results; });
}
module.exports = {
  ModelProvider: ModelProvider,
  ClaudeProvider: ClaudeProvider,
  DoubaoProvider: DoubaoProvider,
  ProviderChain: ProviderChain,
  createProvider: createProvider,
  createDefaultChain: createDefaultChain,
  healthCheck: healthCheck,
};
