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
  this.apiKey = config.apiKey || process.env.OPENAI_API_KEY;
  this.baseUrl = config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.anthropic.com';
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

  var body = JSON.stringify({
    model: model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  return new Promise(function(resolve, reject) {
    var url = new URL(self.baseUrl + '/v1/messages');
    var opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': self.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      },
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
          if (parsed.error) return reject(new Error('API: ' + (parsed.error.message || JSON.stringify(parsed.error))));
          var text = '';
          if (parsed.content) {
            for (var i = 0; i < parsed.content.length; i++) {
              if (parsed.content[i].type === 'text') text += parsed.content[i].text;
            }
          }
          resolve({ text: text, usage: parsed.usage, model: parsed.model, provider: 'claude' });
        } catch(e) { reject(new Error('Parse error: ' + data.slice(0, 500))); }
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

  var apiBody = JSON.stringify({
    model: model,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64," + imageBase64 } },
      { type: "text", text: textPrompt },
    ]}],
    max_tokens: maxTokens,
  });

  return new Promise(function(resolve, reject) {
    var parsedUrl = new (require("url").URL)(baseUrl + "/chat/completions");
    var mod = parsedUrl.protocol === "http:" ? http : https;
    var req = mod.request({
      hostname: parsedUrl.hostname, port: parsedUrl.port || 443, path: parsedUrl.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "Content-Length": Buffer.byteLength(apiBody) },
      timeout: timeoutMs,
    }, function(res) {
      var chunks = [];
      res.on("data", function(c) { chunks.push(c); });
      res.on("end", function() {
        try {
          var resp = JSON.parse(Buffer.concat(chunks).toString());
          var text = (resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content) || "";
          resolve({ text: text, provider: "claude-vision", model: model });
        } catch(e) { reject(new Error("Vision parse error: " + e.message)); }
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
 * @returns {Promise<{doubao: object, claude: object}>}
 */
function healthCheck() {
  var results = {};
  var checks = [];

  // Doubao
  if (process.env.DOUBAO_API_KEY) {
    var doubao = new DoubaoProvider({});
    var t1 = Date.now();
    checks.push(
      doubao.generate("ping", { maxTokens: 5, timeoutMs: 10000 })
        .then(function() { results.doubao = { status: "ok", latencyMs: Date.now() - t1 }; })
        .catch(function(e) { results.doubao = { status: "error", latencyMs: Date.now() - t1, error: e.message }; })
    );
  }

  // Claude
  if (process.env.OPENAI_API_KEY) {
    var claude = new ClaudeProvider({});
    var t3 = Date.now();
    checks.push(
      claude.generate("ping", { maxTokens: 5, timeoutMs: 10000 })
        .then(function() { results.claude = { status: "ok", latencyMs: Date.now() - t3 }; })
        .catch(function(e) { results.claude = { status: "error", latencyMs: Date.now() - t3, error: e.message }; })
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
