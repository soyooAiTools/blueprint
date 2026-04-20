/**
 * Doubao (豆包) Seed 2.0 Pro Adapter
 * 
 * Drop-in replacement for @google/genai GoogleGenAI.
 * Exposes the same ai.models.generateContent() interface,
 * internally calls Doubao OpenAI-compatible API.
 * 
 * Usage (替换 GoogleGenAI):
 *   const { GoogleGenAI } = require('./doubao-adapter.cjs');
 *   const ai = new GoogleGenAI({ apiKey: 'xxx' });
 *   const result = await ai.models.generateContent({ model, contents, config });
 *   console.log(result.text);
 */

const https = require('https');
const http = require('http');

const DOUBAO_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seed-2-0-pro-260215';

// Model mapping: legacy model names → Doubao equivalents (kept for backward compatibility)
const MODEL_MAP = {
  'gemini-2.5-flash': DEFAULT_MODEL,
  'gemini-2.5-pro': DEFAULT_MODEL,
  'gemini-3.1-pro-preview': DEFAULT_MODEL,
  'gemini-3.1-pro': DEFAULT_MODEL,
  'gemini-pro': DEFAULT_MODEL,
  'gemini-pro-vision': DEFAULT_MODEL,  // seed-2.0-pro supports vision
};

function mapModel(modelName) {
  return MODEL_MAP[modelName] || DEFAULT_MODEL;
}

class GoogleGenAI {
  constructor(opts) {
    this.apiKey = opts.apiKey || '';
    // httpOptions.baseUrl is ignored — we always use Doubao endpoint
    this.models = new Models(this.apiKey);
  }
}

class Models {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * generateContent — compatible with @google/genai interface
   * 
   * @param {object} params
   * @param {string} params.model - Model name (auto-mapped to Doubao equivalent)
   * @param {Array} params.contents - [{role, parts: [{text}, {inlineData: {mimeType, data}}]}]
   * @param {object} [params.config] - {temperature, maxOutputTokens, systemInstruction, thinkingConfig}
   * @returns {object} { text: string, candidates: [...] }
   */
  async generateContent(params) {
    const model = mapModel(params.model || DEFAULT_MODEL);
    const contents = params.contents || [];
    const config = params.config || {};

    // Convert GoogleGenAI format → OpenAI format
    const messages = [];

    // System instruction
    if (config.systemInstruction) {
      const sysText = typeof config.systemInstruction === 'string'
        ? config.systemInstruction
        : (config.systemInstruction.text || JSON.stringify(config.systemInstruction));
      messages.push({ role: 'system', content: sysText });
    }

    // Convert contents
    for (const c of contents) {
      const role = c.role === 'model' ? 'assistant' : 'user';
      const parts = c.parts || [];
      
      // Check if there are any image parts
      const hasImages = parts.some(p => p.inlineData || p.fileData);
      
      if (hasImages) {
        // Multi-modal message
        const contentParts = [];
        for (const part of parts) {
          if (part.text) {
            contentParts.push({ type: 'text', text: part.text });
          } else if (part.inlineData) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
              }
            });
          } else if (part.fileData) {
            // fileData (uploaded file) — not directly supported, skip with warning
            console.warn('[Doubao Adapter] fileData not supported, skipping');
          }
        }
        messages.push({ role, content: contentParts });
      } else {
        // Text-only message
        const text = parts.map(p => p.text || '').join('\n');
        messages.push({ role, content: text });
      }
    }

    // Build request
    const payload = {
      model,
      messages,
      temperature: config.temperature !== undefined ? config.temperature : 0.3,
      max_tokens: config.maxOutputTokens || 8192,
    };
    // D1: OpenAI-compatible seed for deterministic sampling.
    // Opt-in — caller must pass a positive integer. Forwards as-is; backend
    // decides honor policy (doubao doc: same seed + same params ⇒ same output).
    if (config.seed !== undefined && Number.isFinite(config.seed)) {
      payload.seed = Math.floor(config.seed);
    }

    // Call Doubao API
    const responseText = await this._callAPI(payload);

    // Return in GoogleGenAI-compatible format
    return {
      text: responseText,
      candidates: [{
        content: { parts: [{ text: responseText }] },
        finishReason: 'STOP',
      }],
    };
  }

  _callAPI(payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const urlObj = new URL(DOUBAO_BASE + '/chat/completions');

      const options = {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 120000,
      };

      // Clear proxy for direct connection
      const prevHttps = process.env.HTTPS_PROXY;
      const prevHttp = process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          // Restore proxy
          if (prevHttps) process.env.HTTPS_PROXY = prevHttps;
          if (prevHttp) process.env.HTTP_PROXY = prevHttp;

          try {
            const json = JSON.parse(body);
            if (json.error) {
              const errMsg = json.error.message || JSON.stringify(json.error);
              const errCode = json.error.code || json.error.type || '';
              const combined = errCode + ' ' + errMsg;
              // Definitive model failures (quota / auth / balance) — prefix with
              // MODEL_FATAL: so engine/error-classifier.cjs routes them to
              // cancel-task instead of retry. Doubao-specific codes covered:
              // InvalidParameter.QuotaExceeded / InsufficientBalance /
              // AccessDenied / InvalidAccessKeyId.NotFound / AuthenticationFailed
              const isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|invalid.?access.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(combined);
              const prefix = isModelFatal ? 'MODEL_FATAL: Doubao API error: ' : 'Doubao API error: ';
              reject(new Error(prefix + errMsg));
              return;
            }
            const text = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : '';
            resolve(text);
          } catch (e) {
            reject(new Error('Doubao response parse error: ' + e.message + ' body=' + body.substring(0, 200)));
          }
        });
      });

      req.on('error', (e) => {
        if (prevHttps) process.env.HTTPS_PROXY = prevHttps;
        if (prevHttp) process.env.HTTP_PROXY = prevHttp;
        reject(new Error('Doubao request error: ' + e.message));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Doubao API timeout (120s)'));
      });

      req.write(data);
      req.end();
    });
  }
}

module.exports = { GoogleGenAI };
