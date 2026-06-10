#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var https = require('https');
var sharp = require('sharp');
var OpenAI = require('openai');

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function usage() {
  console.error('Usage: STORYBOARD_PHASE_PROMPT_FILE=<prompt> STORYBOARD_PHASE_OUTPUT=<out.png> node scripts/storyboard-openai-image-provider.cjs');
  console.error('Optional env: OPENAI_API_KEY, OPENAI_BASE_URL, STORYBOARD_IMAGE_MODEL, STORYBOARD_IMAGE_SIZE, STORYBOARD_IMAGE_QUALITY, STORYBOARD_OPENAI_DRY_RUN=1');
  process.exit(2);
}

function fetchUrl(url) {
  return new Promise(function(resolve, reject) {
    https.get(url, function(res) {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('image url returned HTTP ' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
    }).on('error', reject);
  });
}

async function dryRunImage(prompt, outputPath) {
  var title = stringValue(process.env.STORYBOARD_PHASE_TITLE || process.env.STORYBOARD_PHASE_ID || 'phase');
  var safeTitle = title.replace(/[<>&"]/g, '');
  var safePrompt = prompt.slice(0, 260).replace(/[<>&"]/g, '');
  var svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">',
    '<rect width="1536" height="1024" fill="#edf3f8"/>',
    '<rect x="80" y="80" width="1376" height="864" fill="#ffffff" stroke="#73859c" stroke-width="8"/>',
    '<text x="130" y="190" font-size="72" font-weight="800" fill="#1f2937">' + safeTitle + '</text>',
    '<text x="130" y="290" font-size="34" fill="#334155">' + safePrompt + '</text>',
    '<text x="130" y="900" font-size="28" fill="#64748b">OpenAI image provider dry run</text>',
    '</svg>',
  ].join('\n');
  await sharp(Buffer.from(svg)).png().toFile(outputPath);
}

async function main() {
  var promptFile = stringValue(process.env.STORYBOARD_PHASE_PROMPT_FILE);
  var outputPath = stringValue(process.env.STORYBOARD_PHASE_OUTPUT);
  if (!promptFile || !outputPath) usage();
  var prompt = fs.readFileSync(promptFile, 'utf8');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (envFlag('STORYBOARD_OPENAI_DRY_RUN')) {
    await dryRunImage(prompt, outputPath);
    console.log(JSON.stringify({
      success: true,
      mode: 'dry_run',
      output: outputPath,
      model: 'dry-run',
    }));
    return;
  }

  var apiKey = stringValue(process.env.OPENAI_API_KEY);
  if (!apiKey) throw new Error('OPENAI_API_KEY is required unless STORYBOARD_OPENAI_DRY_RUN=1');
  var model = stringValue(process.env.STORYBOARD_IMAGE_MODEL) || 'gpt-image-1';
  var size = stringValue(process.env.STORYBOARD_IMAGE_SIZE) || '1536x1024';
  var quality = stringValue(process.env.STORYBOARD_IMAGE_QUALITY) || 'medium';
  var outputFormat = stringValue(process.env.STORYBOARD_IMAGE_OUTPUT_FORMAT) || 'png';
  var clientOptions = { apiKey: apiKey, timeout: Number(process.env.STORYBOARD_IMAGE_TIMEOUT_MS || 240000) };
  if (process.env.OPENAI_BASE_URL) clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  var client = new OpenAI(clientOptions);

  var previousImage = stringValue(process.env.STORYBOARD_PREVIOUS_IMAGE);
  var usePrevious = envFlag('STORYBOARD_IMAGE_USE_PREVIOUS') && previousImage && fs.existsSync(previousImage);
  var request = {
    model: model,
    prompt: prompt.slice(0, 32000),
    size: size,
    quality: quality,
    output_format: outputFormat,
    n: 1,
  };
  var response = usePrevious
    ? await client.images.edit(Object.assign({}, request, { image: fs.createReadStream(previousImage) }))
    : await client.images.generate(request);
  var first = response && response.data && response.data[0] || {};
  var bytes;
  if (first.b64_json) {
    bytes = Buffer.from(first.b64_json, 'base64');
  } else if (first.url) {
    bytes = await fetchUrl(first.url);
  } else {
    throw new Error('image provider response did not include b64_json or url');
  }
  fs.writeFileSync(outputPath, bytes);
  console.log(JSON.stringify({
    success: true,
    mode: usePrevious ? 'edit' : 'generate',
    output: outputPath,
    model: model,
    size: size,
    quality: quality,
    bytes: bytes.length,
  }));
}

if (require.main === module) {
  main().catch(function(err) {
    console.error(err && err.message || err);
    process.exit(1);
  });
}
