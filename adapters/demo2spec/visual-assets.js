'use strict';

const fs = require('fs');
const path = require('path');

const VISUAL_ASSET_SCHEMA_VERSION = 'va.1.0.0';
const VISUAL_ASSET_KIND = 'demo2spec.visualAssetManifest';
const VISUAL_RUNTIME_CONTRACT_VERSION = 'vrc.1.0.0';
const VISUAL_RUNTIME_CONTRACT_KIND = 'demo2spec.visualRuntimeContract';
const ASSET_LICENSE_CONTRACT_VERSION = 'val.1.0.0';
const DEFAULT_ASSET_LICENSE = 'unknown';
const KNOWN_ASSET_LICENSES = new Set([
  'unknown',
  'CC0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'proprietary',
]);
const FALLBACK_RANK = {
  theme_pool_or_primitive: 100,
  primitive_approximation: 80,
  degraded_composite: 60,
};
const FIDELITY_RANK = {
  full_visual: 100,
  geometry_color_material: 80,
  geometry_color_only: 60,
};

const GEOMETRY_KIND = /^(Box|Cylinder|Sphere|Icosahedron|Octahedron|Dodecahedron|Cone|Plane|Ring|Torus|Tetrahedron|Buffer)Geometry$/;
const MATERIAL_KIND = /^Mesh(Lambert|Basic|Physical|Standard|Phong|Toon)Material$/;
const MODEL_LOADER_KIND = /^(GLTFLoader|OBJLoader|FBXLoader)$/;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return Array.from(new Set(safeArray(values).filter(Boolean)));
}

function findLine(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function sliceBalanced(text, startIdx, open, close) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function splitTopLevelArgs(text) {
  const args = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function sanitizeId(value, fallback) {
  const text = String(value || fallback || 'asset').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const base = text || 'asset';
  return /^[A-Za-z]/.test(base) ? base : ('asset_' + base);
}

function stableAssetId(name, suffix) {
  return 'asset_' + sanitizeId(name, suffix);
}

function assetLicenseFields() {
  return {
    license: DEFAULT_ASSET_LICENSE,
    attribution: null,
  };
}

function stripUrlQueryHash(value) {
  const text = String(value || '').trim();
  const idx = text.search(/[?#]/);
  return idx >= 0 ? text.slice(0, idx) : text;
}

function normalizeAssetUrl(value) {
  return stripUrlQueryHash(stripQuotes(value))
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function curlyDepthAt(text, targetIdx) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < targetIdx && i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

function parseQuotedStringAt(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let escaped = false;
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      value += c;
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === quote) return { value, end: i + 1 };
    value += c;
  }
  return null;
}

function readMetaField(body, key) {
  const re = new RegExp('\\b' + key + '\\s*:\\s*');
  const m = re.exec(String(body || ''));
  if (!m) return { present: false, value: undefined };
  let i = m.index + m[0].length;
  while (/\s/.test(body[i] || '')) i++;
  if (String(body).slice(i, i + 4) === 'null') return { present: true, value: null };
  const quoted = parseQuotedStringAt(String(body), i);
  if (quoted) return { present: true, value: quoted.value };
  const tail = String(body).slice(i).match(/^[^,}\n]+/);
  return { present: true, value: tail ? stripQuotes(tail[0].trim()) : null };
}

function normalizeLicenseValue(value) {
  const text = stripQuotes(value || '').trim();
  if (!text) return DEFAULT_ASSET_LICENSE;
  if (KNOWN_ASSET_LICENSES.has(text)) return text;
  if (/^CC-NC-[A-Z0-9.-]+$/.test(text)) return text;
  return DEFAULT_ASSET_LICENSE;
}

function normalizeNullableMetaString(value, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return maxLength && text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeAssetMetaEntry(key, body) {
  const licenseField = readMetaField(body, 'license');
  const attributionField = readMetaField(body, 'attribution');
  const sourceUrlField = readMetaField(body, 'sourceUrl');
  const violations = [];
  if (!licenseField.present) violations.push('missing_license');
  if (!attributionField.present) violations.push('missing_attribution');
  if (!sourceUrlField.present) violations.push('missing_sourceUrl');
  const license = normalizeLicenseValue(licenseField.value);
  const rawLicense = stripQuotes(licenseField.value || '').trim();
  if (licenseField.present && license === DEFAULT_ASSET_LICENSE && rawLicense && rawLicense !== DEFAULT_ASSET_LICENSE) {
    violations.push('invalid_license');
  }
  const attribution = normalizeNullableMetaString(attributionField.value, 200);
  if (attributionField.present && attributionField.value != null && !String(attributionField.value).trim()) violations.push('invalid_attribution_empty');
  if (attributionField.value != null && String(attributionField.value).trim().length > 200) violations.push('attribution_too_long');
  const sourceUrl = normalizeNullableMetaString(sourceUrlField.value, 2048);
  if (sourceUrlField.present && sourceUrlField.value != null && !String(sourceUrlField.value).trim()) violations.push('invalid_sourceUrl_empty');
  return {
    key,
    license,
    attribution,
    sourceUrl,
    violations,
    valid: violations.length === 0,
  };
}

function parseAssetMetaLiteral(literal) {
  const entries = {};
  const diagnostics = [];
  const text = String(literal || '').trim();
  let i = text[0] === '{' ? 1 : 0;
  const end = text[text.length - 1] === '}' ? text.length - 1 : text.length;
  while (i < end) {
    while (i < end && /[\s,]/.test(text[i])) i++;
    if (i >= end) break;
    let key;
    if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const parsed = parseQuotedStringAt(text, i);
      if (!parsed) break;
      key = parsed.value;
      i = parsed.end;
    } else {
      const m = text.slice(i).match(/^[^:\s]+/);
      if (!m) break;
      key = stripQuotes(m[0]);
      i += m[0].length;
    }
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] !== ':') {
      diagnostics.push({ code: 'asset_meta_key_without_value', key });
      break;
    }
    i++;
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] !== '{') {
      diagnostics.push({ code: 'asset_meta_entry_not_object', key });
      while (i < end && text[i] !== ',') i++;
      continue;
    }
    const body = sliceBalanced(text, i, '{', '}');
    if (!body) {
      diagnostics.push({ code: 'asset_meta_entry_unbalanced', key });
      break;
    }
    const entry = normalizeAssetMetaEntry(key, body);
    entries[key] = entry;
    entry.violations.forEach(code => diagnostics.push({ code, key }));
    i += body.length;
  }
  return { entries, diagnostics };
}

function buildAssetMetaIndex(entries) {
  const byExact = {};
  const byNormalized = {};
  Object.keys(entries || {}).forEach(key => {
    const entry = entries[key];
    [key, stripUrlQueryHash(key)].filter(Boolean).forEach(k => { byExact[k] = entry; });
    const normalized = normalizeAssetUrl(key);
    if (normalized) byNormalized[normalized] = entry;
  });
  return { byExact, byNormalized };
}

function extractAssetMetaMap(html) {
  const diagnostics = [];
  const entries = {};
  const re = /\b(?:window|globalThis)\.__assetMeta\s*=/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (curlyDepthAt(html, m.index) !== 0) {
      diagnostics.push({ code: 'asset_meta_not_top_level', line: findLine(html, m.index) });
      continue;
    }
    const objectStart = html.indexOf('{', re.lastIndex);
    if (objectStart < 0) {
      diagnostics.push({ code: 'asset_meta_missing_object', line: findLine(html, m.index) });
      continue;
    }
    const literal = sliceBalanced(html, objectStart, '{', '}');
    if (!literal) {
      diagnostics.push({ code: 'asset_meta_unbalanced_object', line: findLine(html, m.index) });
      continue;
    }
    const parsed = parseAssetMetaLiteral(literal);
    Object.assign(entries, parsed.entries);
    diagnostics.push(...parsed.diagnostics.map(item => Object.assign({ line: findLine(html, m.index) }, item)));
    re.lastIndex = objectStart + literal.length;
  }
  return {
    contractVersion: ASSET_LICENSE_CONTRACT_VERSION,
    carrier: 'window.__assetMeta',
    entries,
    diagnostics,
    index: buildAssetMetaIndex(entries),
  };
}

function lookupAssetMeta(assetMetaIndex, url) {
  const exact = stripQuotes(url);
  if (!assetMetaIndex) return null;
  return assetMetaIndex.byExact[exact]
    || assetMetaIndex.byExact[stripUrlQueryHash(exact)]
    || assetMetaIndex.byNormalized[normalizeAssetUrl(exact)]
    || null;
}

function resolveLocalSourcePath(cleanUrl, htmlSource) {
  if (!cleanUrl || /^data:/i.test(cleanUrl) || /^https?:\/\//i.test(cleanUrl)) return null;
  const stripped = stripUrlQueryHash(cleanUrl);
  if (!stripped) return null;
  if (path.isAbsolute(stripped)) return stripped;
  if (!htmlSource || /^https?:\/\//i.test(htmlSource)) return null;
  return path.resolve(path.dirname(htmlSource), stripped);
}

function buildSourceAssetFields(cleanUrl, metaEntry, options) {
  const validMeta = metaEntry && metaEntry.valid !== false;
  const sourceUrl = validMeta && metaEntry.sourceUrl
    ? metaEntry.sourceUrl
    : (/^https?:\/\//i.test(cleanUrl) ? cleanUrl : null);
  const localSourcePath = resolveLocalSourcePath(cleanUrl, options && options.source);
  const localSourceExists = !!localSourcePath && fs.existsSync(localSourcePath);
  const license = validMeta && metaEntry.license ? metaEntry.license : DEFAULT_ASSET_LICENSE;
  return {
    metadataStatus: metaEntry ? (validMeta ? 'matched' : 'invalid') : 'missing',
    metadataKey: metaEntry ? metaEntry.key : null,
    metadataViolations: metaEntry ? safeArray(metaEntry.violations) : [],
    sourceUrl,
    localSourcePath,
    localSourceExists,
    license,
    attribution: validMeta ? metaEntry.attribution : null,
    readyForFetch: !!sourceUrl && license !== DEFAULT_ASSET_LICENSE,
    readyForImport: localSourceExists,
  };
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readProp(body, key) {
  const re = new RegExp('\\b' + key + '\\s*:\\s*([^,}\\n]+)');
  const m = String(body || '').match(re);
  return m ? m[1].trim() : null;
}

function stripQuotes(value) {
  return String(value || '').trim().replace(/^['"`]|['"`]$/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeColor(value, fallbackValue) {
  if (value == null) return null;
  let text = stripQuotes(value).trim();
  if (!text) return null;
  if (/^(?:style\.color|c|col|styleColor)$/i.test(text) && fallbackValue != null) return normalizeColor(fallbackValue);
  if (/^0x[0-9a-f]+$/i.test(text)) return '#' + text.slice(2).padStart(6, '0').slice(-6).toUpperCase();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text.toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(text)) return '#' + text.toUpperCase();
  if (/^\d+$/.test(text)) {
    const hex = Number(text).toString(16).padStart(6, '0').slice(-6).toUpperCase();
    return '#' + hex;
  }
  return text;
}

function colorToRgb01(value) {
  const color = normalizeColor(value);
  if (!/^#[0-9A-F]{6}$/i.test(color || '')) return null;
  const r = parseInt(color.slice(1, 3), 16) / 255;
  const g = parseInt(color.slice(3, 5), 16) / 255;
  const b = parseInt(color.slice(5, 7), 16) / 255;
  return [Number(r.toFixed(4)), Number(g.toFixed(4)), Number(b.toFixed(4))];
}

function findObjectAssignmentLiteral(html, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b(?:const|let|var)\\s+' + esc + '\\s*=|\\b(?:window\\.)?' + esc + '\\s*=', 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const objectStart = html.indexOf('{', re.lastIndex);
    if (objectStart < 0) continue;
    const literal = sliceBalanced(html, objectStart, '{', '}');
    if (!literal) continue;
    return { literal, index: objectStart };
  }
  return null;
}

function findArrayAssignmentLiteral(html, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\b(?:const|let|var)\\s+' + esc + '\\s*=|\\b(?:window\\.)?' + esc + '\\s*=', 'g');
  let m;
  while ((m = re.exec(html)) !== null) {
    const arrayStart = html.indexOf('[', re.lastIndex);
    if (arrayStart < 0) continue;
    const literal = sliceBalanced(html, arrayStart, '[', ']');
    if (!literal) continue;
    return { literal, index: arrayStart };
  }
  return null;
}

function readHexColorProp(body, key) {
  const raw = readProp(body, key);
  const color = normalizeColor(raw);
  return /^#[0-9A-F]{6}$/i.test(color || '') ? color : null;
}

function readNumericProp(body, key) {
  const raw = readProp(body, key);
  if (raw == null) return null;
  const text = stripQuotes(raw).trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text.slice(2), 16);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function readVectorArray(value) {
  const text = String(value || '').trim();
  if (text[0] !== '[') return null;
  const body = text.slice(1, text.lastIndexOf(']'));
  const nums = splitTopLevelArgs(body).map(v => readNumericLiteral(v));
  return nums.length >= 3 && nums.slice(0, 3).every(n => Number.isFinite(n))
    ? nums.slice(0, 3)
    : null;
}

function readNumericLiteral(value) {
  if (value == null) return null;
  const text = stripQuotes(value).trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text.slice(2), 16);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function parseSceneLight(body, includePosition, includeDistance) {
  if (!body || String(body).trim() === 'null') return null;
  const entries = parseObjectLiteralEntries(body);
  const light = {
    color: readHexColorProp(body, 'color'),
    intensity: readNumericProp(body, 'intensity'),
  };
  if (includePosition) light.position = readVectorArray(entries.position || readProp(body, 'position'));
  if (includeDistance) light.distance = readNumericProp(body, 'distance');
  return light.color && Number.isFinite(light.intensity) ? light : null;
}

function hasGuidanceIdentifier(html, name) {
  return new RegExp('\\b' + escapeRegExp(name) + '\\b').test(String(html || ''));
}

function parseGuidanceTrailLineTarget(html) {
  const source = String(html || '');
  const callRe = /\btrailLine\s*\.\s*geometry\s*\.\s*setFromPoints\s*\(\s*\[([\s\S]{0,800}?)\]\s*\)/g;
  let match;
  while ((match = callRe.exec(source))) {
    const body = match[1] || '';
    const targets = [];
    let modelMatch;
    const modelRe = /\bmodels\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*position\b/g;
    while ((modelMatch = modelRe.exec(body))) targets.push(modelMatch[1]);
    const target = targets.reverse().find(name => !/player|hero|avatar|astronaut/i.test(name));
    if (target) return target;
  }
  return '';
}

function parseGuidanceVisualContract(html) {
  const source = String(html || '');
  const diagnostics = [];
  const trailLineTarget = parseGuidanceTrailLineTarget(source);
  const hasTargetRing = hasGuidanceIdentifier(source, 'targetRing')
    && /new\s+THREE\.TorusGeometry\s*\(/.test(source)
    && /0xffe45c/i.test(source);
  const hasTrailLine = hasGuidanceIdentifier(source, 'trailLine')
    && /new\s+THREE\.Line\s*\(/.test(source)
    && /0x8deaff/i.test(source);
  const hasLaserLine = hasGuidanceIdentifier(source, 'laserLine')
    && /new\s+THREE\.Line\s*\(/.test(source)
    && /0xff6858/i.test(source);
  const hasEntityTargetHint = /targetHint\.textContent[\s\S]{0,220}ENTITY_STYLE\s*\[[^\]]+\]\.label/.test(source);
  const hasStepToast = hasGuidanceIdentifier(source, 'toast')
    && /\bshowToast\s*\(/.test(source)
    && /\btoastUntil\b/.test(source);

  if (!hasTargetRing) diagnostics.push({ code: 'guidance_target_ring_missing' });
  if (!hasTrailLine) diagnostics.push({ code: 'guidance_trail_line_missing' });
  if (!hasLaserLine) diagnostics.push({ code: 'guidance_laser_line_missing' });
  if (!hasEntityTargetHint) diagnostics.push({ code: 'guidance_target_hint_entity_label_missing' });
  if (!hasStepToast) diagnostics.push({ code: 'guidance_step_toast_missing' });

  return {
    present: hasTargetRing || hasTrailLine || hasLaserLine || hasEntityTargetHint || hasStepToast,
    targetRing: hasTargetRing ? {
      geometry: { type: 'TorusGeometry', args: [1.5, 0.055, 8, 64] },
      material: { type: 'MeshBasicMaterial', color: '#FFE45C' },
      rotation: [1.5708, 0, 0],
      yOffset: 0.08,
      pulseAmplitude: 0.08,
      pulseFrequency: 180,
    } : null,
    trailLine: hasTrailLine ? {
      from: 'Player',
      to: trailLineTarget || 'SpaceShip',
      fromYOffset: 1.0,
      toYOffset: 1.0,
      material: { color: '#8DEAFF', opacity: 0.65 },
    } : null,
    laserLine: hasLaserLine ? {
      trigger: 'step.damage === true',
      fromYOffset: 1.1,
      toYOffset: 1.0,
      material: { color: '#FF6858' },
      decayRate: 1.6,
    } : null,
    targetHintLabelSource: hasEntityTargetHint ? 'entityLabel' : 'unknown',
    stepToast: hasStepToast ? {
      labelSource: 'step.label',
      durationMs: 1000,
      position: 'top',
    } : null,
    diagnostics,
  };
}

function parseSourceCameraVector(html, variable, method) {
  if (!variable || !method) return null;
  const direct = new RegExp('\\b' + escapeRegExp(variable) + '\\.' + escapeRegExp(method) + '\\s*\\(([^)]*)\\)', 'm').exec(String(html || ''));
  if (direct) {
    const values = numericList(splitTopLevelArgs(direct[1]), null);
    return values.length >= 3 ? values.slice(0, 3) : null;
  }
  if (method === 'lookAt') {
    const vector = new RegExp('\\b' + escapeRegExp(variable) + '\\.lookAt\\s*\\(\\s*new\\s+THREE\\.Vector3\\s*\\(([^)]*)\\)\\s*\\)', 'm').exec(String(html || ''));
    if (vector) {
      const values = numericList(splitTopLevelArgs(vector[1]), null);
      return values.length >= 3 ? values.slice(0, 3) : null;
    }
  }
  return null;
}

function parseSourceThreeCameraContract(html) {
  const text = String(html || '');
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.(PerspectiveCamera|OrthographicCamera)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(text))) {
    const variable = match[1];
    const type = match[2];
    const args = splitTopLevelArgs(match[3]);
    const position = parseSourceCameraVector(text, variable, 'position.set');
    const lookAt = parseSourceCameraVector(text, variable, 'lookAt');
    const contract = {
      present: true,
      source: 'source-html-three-camera',
      variable,
      type,
      line: findLine(text, match.index),
      position,
      lookAt,
      diagnostics: [],
    };
    if (type === 'PerspectiveCamera') {
      contract.fov = evaluateNumericExpression(args[0]);
      contract.near = evaluateNumericExpression(args[2]);
      contract.far = evaluateNumericExpression(args[3]);
      if (!Number.isFinite(contract.fov)) contract.diagnostics.push({ code: 'camera_fov_missing_or_dynamic' });
    } else {
      contract.left = evaluateNumericExpression(args[0]);
      contract.right = evaluateNumericExpression(args[1]);
      contract.top = evaluateNumericExpression(args[2]);
      contract.bottom = evaluateNumericExpression(args[3]);
      contract.near = evaluateNumericExpression(args[4]);
      contract.far = evaluateNumericExpression(args[5]);
    }
    if (!position) contract.diagnostics.push({ code: 'camera_position_missing_or_dynamic' });
    if (!lookAt) contract.diagnostics.push({ code: 'camera_lookat_missing_or_dynamic' });
    return contract;
  }
  return {
    present: false,
    source: 'source-html-three-camera',
    diagnostics: [{ code: 'camera_missing' }],
  };
}

function parsePlayerAxisExpression(expr, axis) {
  const text = String(expr || '').replace(/\s+/g, '');
  const re = new RegExp('player\\.position\\.' + escapeRegExp(axis) + '(?:\\*([^+\\-]+))?([+\\-].+)?$');
  const match = text.match(re);
  if (!match) return null;
  const factor = match[1] ? evaluateNumericExpression(match[1]) : 1;
  const offset = match[2] ? evaluateNumericExpression(match[2]) : 0;
  return {
    factor: Number.isFinite(factor) ? factor : 1,
    offset: Number.isFinite(offset) ? offset : 0,
  };
}

function parseDynamicCameraFollowContract(html) {
  const text = String(html || '');
  const out = {
    positionFactor: {},
    positionOffset: {},
    positionY: null,
    positionAbsolute: false,
    lookAtFactor: {},
    lookAtY: 0,
    smoothing: null,
  };
  const positionRe = /\bcamera\.position\.(x|z)\s*\+=\s*\(\s*player\.position\.\1\s*\*\s*([^)-]+?)\s*-\s*camera\.position\.\1\s*\+\s*SCENE_CONFIG\.camera\.position\s*\[\s*[02]\s*\]\s*\)\s*\*\s*(?:dt\s*\*\s*)?([^;\n]+)/g;
  let m;
  while ((m = positionRe.exec(text))) {
    const axis = m[1];
    const factor = evaluateNumericExpression(m[2]);
    const smoothing = evaluateNumericExpression(m[3]);
    if (Number.isFinite(factor)) out.positionFactor[axis] = factor;
    if (Number.isFinite(smoothing)) out.smoothing = smoothing;
  }
  const lerp = text.match(/\bcamera\.position\.lerp\s*\(\s*new\s+THREE\.Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+?)\s*\)\s*,\s*([^)]+)\)/);
  if (lerp) {
    const xExpr = parsePlayerAxisExpression(lerp[1], 'x');
    const y = evaluateNumericExpression(lerp[2]);
    const zExpr = parsePlayerAxisExpression(lerp[3], 'z');
    const smoothing = evaluateNumericExpression(lerp[4]);
    if (xExpr) {
      out.positionFactor.x = xExpr.factor;
      out.positionOffset.x = xExpr.offset;
    }
    if (Number.isFinite(y)) out.positionY = y;
    if (zExpr) {
      out.positionFactor.z = zExpr.factor;
      out.positionOffset.z = zExpr.offset;
    }
    if (Number.isFinite(smoothing)) out.smoothing = smoothing;
    out.positionAbsolute = true;
  }
  const lookAtRe = /\bcamera\.lookAt\s*\(([^)]*)\)/g;
  while ((m = lookAtRe.exec(text))) {
    if (m[1].indexOf('player.position') < 0) continue;
    const args = splitTopLevelArgs(m[1]);
    if (args.length < 3) continue;
    const xExpr = parsePlayerAxisExpression(args[0], 'x');
    const y = evaluateNumericExpression(args[1]);
    const zExpr = parsePlayerAxisExpression(args[2], 'z');
    if (xExpr) out.lookAtFactor.x = xExpr.factor;
    if (Number.isFinite(y)) out.lookAtY = y;
    if (zExpr) out.lookAtFactor.z = zExpr.factor;
    break;
  }
  return (Object.keys(out.positionFactor).length || Object.keys(out.lookAtFactor).length) ? out : null;
}

function parseSceneConfigCameraContract(body, html) {
  if (!body || String(body).trim() === 'null') return null;
  const entries = parseObjectLiteralEntries(body);
  const source = String(html || '');
  const dynamicPlayerLookAt = /\bcamera\.lookAt\s*\(\s*player\.position\.x\b/.test(source);
  const dynamicPlayerFollow = parseDynamicCameraFollowContract(source);
  const type = stripQuotes(entries.type || 'PerspectiveCamera');
  const contract = {
    present: true,
    source: 'SCENE_CONFIG.camera',
    type: type || 'PerspectiveCamera',
    position: readVectorArray(entries.position || readProp(body, 'position')),
    lookAt: dynamicPlayerLookAt ? [0, 0, 0] : readVectorArray(entries.lookAt || readProp(body, 'lookAt')),
    fov: readNumericProp(body, 'fov'),
    near: readNumericProp(body, 'near'),
    far: readNumericProp(body, 'far'),
    dynamicLookAtPlayer: dynamicPlayerLookAt,
    dynamicPlayerFollow,
    diagnostics: [],
  };
  if (!Number.isFinite(contract.fov)) contract.diagnostics.push({ code: 'camera_fov_missing_or_dynamic' });
  if (!contract.position) contract.diagnostics.push({ code: 'camera_position_missing_or_dynamic' });
  if (!contract.lookAt) contract.diagnostics.push({ code: 'camera_lookat_missing_or_dynamic' });
  return contract;
}

function parseGridHelperContract(html) {
  const text = String(html || '');
  const m = text.match(/new\s+THREE\.GridHelper\s*\(([^)]*)\)/);
  if (!m) {
    return {
      present: false,
      source: 'source-html-three-grid-helper',
      diagnostics: [{ code: 'grid_helper_missing' }],
    };
  }
  const args = splitTopLevelArgs(m[1]);
  return {
    present: true,
    source: 'source-html-three-grid-helper',
    line: findLine(text, m.index),
    size: evaluateNumericExpression(args[0]),
    divisions: evaluateNumericExpression(args[1]),
    colorCenterLine: normalizeColor(args[2]),
    colorGrid: normalizeColor(args[3]),
    diagnostics: [],
  };
}

function readLoopNumericSeries(value, loopVariable) {
  if (value == null) return null;
  const loopName = loopVariable || 'i';
  const normalized = String(value).replace(new RegExp('\\b' + escapeRegExp(loopName) + '\\b', 'g'), 'i');
  const base = evaluateNumericExpression(normalized, 0);
  if (!Number.isFinite(base)) return null;
  const next = evaluateNumericExpression(normalized, 1);
  const step = Number.isFinite(next) ? Number((next - base).toFixed(4)) : 0;
  return { base, step };
}

function parseSourceOrbitalRingStyle(html) {
  const text = String(html || '');
  const loopRe = /for\s*\(\s*(?:var|let|const)?\s*([A-Za-z_$][\w$]*)\s*=\s*0\s*;\s*\1\s*<\s*[^;]*\borbitalRings\b[^;]*;\s*\1\+\+\s*\)/g;
  let loop;
  while ((loop = loopRe.exec(text)) !== null) {
    const loopVariable = loop[1];
    const blockStart = text.indexOf('{', loopRe.lastIndex);
    if (blockStart < 0) continue;
    const block = sliceBalanced(text, blockStart, '{', '}');
    if (!block || !/new\s+THREE\.TorusGeometry\s*\(/.test(block)) continue;
    const geometryMatch = /new\s+THREE\.(TorusGeometry)\s*\(/.exec(block);
    const geometryCallStart = block.indexOf('(', geometryMatch.index);
    const geometryCall = sliceBalanced(block, geometryCallStart, '(', ')') || '()';
    const argSeries = splitTopLevelArgs(geometryCall.slice(1, -1)).map(arg => readLoopNumericSeries(arg, loopVariable));
    if (argSeries.length < 2 || argSeries.some(series => !series)) continue;
    let material = null;
    const materialMatch = /new\s+THREE\.([A-Za-z0-9_]+Material)\s*\(/.exec(block);
    if (materialMatch) {
      const materialCallStart = block.indexOf('(', materialMatch.index);
      const materialCall = sliceBalanced(block, materialCallStart, '(', ')') || '()';
      const materialArgs = splitTopLevelArgs(materialCall.slice(1, -1));
      const options = materialArgs.find(arg => /^\{/.test(arg)) || '{}';
      material = materialFromOptions(materialMatch[1], options, 'source-html-orbital-ring', {});
    }
    const rotation = [0, 0, 0];
    const rotX = block.match(/\.rotation\.x\s*=\s*([^;\n]+)/);
    const rotY = block.match(/\.rotation\.y\s*=\s*([^;\n]+)/);
    const rotZ = block.match(/\.rotation\.z\s*=\s*([^;\n]+)/);
    rotation[0] = rotX ? (evaluateNumericExpression(rotX[1]) || 0) : 0;
    rotation[1] = rotY ? (evaluateNumericExpression(rotY[1]) || 0) : 0;
    rotation[2] = rotZ ? (evaluateNumericExpression(rotZ[1]) || 0) : 0;
    const positionYMatch = block.match(/\.position\.y\s*=\s*([^;\n]+)/);
    const positionY = positionYMatch ? readLoopNumericSeries(positionYMatch[1], loopVariable) : null;
    return {
      source: 'source-html-orbital-ring-loop',
      line: findLine(text, loop.index),
      loopVariable,
      geometry: {
        type: 'TorusGeometry',
        argsBase: argSeries.map(series => series.base),
        argsStep: argSeries.map(series => series.step),
      },
      material: material ? {
        type: material.type,
        diffuseColor: material.diffuseColor,
        opacity: material.opacity,
        transparent: material.transparent,
      } : null,
      rotation,
      positionY,
    };
  }
  return null;
}

function parseSourceGroundPositionY(html) {
  const match = String(html || '').match(/\bground\.position\.y\s*=\s*([^;\n]+)/);
  if (!match) return null;
  return evaluateNumericExpression(match[1]);
}

function parseSceneConfig(html) {
  const found = findObjectAssignmentLiteral(html, 'SCENE_CONFIG');
  if (!found) {
    return {
      present: false,
      carrier: 'SCENE_CONFIG',
      camera: parseSourceThreeCameraContract(html),
      grid: parseGridHelperContract(html),
      diagnostics: [{ code: 'scene_config_missing' }],
    };
  }
  const entries = parseObjectLiteralEntries(found.literal);
  const fogBody = entries.fog && String(entries.fog).trim() !== 'null' ? entries.fog : null;
  const groundBody = entries.ground && String(entries.ground).trim() !== 'null' ? entries.ground : null;
  const decorBody = entries.decor && String(entries.decor).trim() !== 'null' ? entries.decor : null;
  const orbitalRingStyle = parseSourceOrbitalRingStyle(html);
  const contract = {
    present: true,
    carrier: 'SCENE_CONFIG',
    backgroundColor: readHexColorProp(found.literal, 'backgroundColor'),
    backgroundRgb01: colorToRgb01(readProp(found.literal, 'backgroundColor')),
    fog: fogBody ? {
      color: readHexColorProp(fogBody, 'color'),
      near: readNumericProp(fogBody, 'near'),
      far: readNumericProp(fogBody, 'far'),
    } : null,
    ambientLight: parseSceneLight(entries.ambientLight, false, false),
    directionalLight: parseSceneLight(entries.directionalLight, true, false),
    rimLight: parseSceneLight(entries.rimLight, true, true),
    ground: groundBody ? {
      kind: stripQuotes(readProp(groundBody, 'kind') || 'plane'),
      radius: readNumericProp(groundBody, 'radius'),
      width: readNumericProp(groundBody, 'width'),
      height: readNumericProp(groundBody, 'height'),
      positionY: parseSourceGroundPositionY(html),
      color: readHexColorProp(groundBody, 'color'),
      colorRgb01: colorToRgb01(readProp(groundBody, 'color')),
    } : null,
    decor: decorBody ? {
      stars: readNumericProp(decorBody, 'stars'),
      orbitalRings: readNumericProp(decorBody, 'orbitalRings'),
      orbitalRingStyle,
    } : null,
    guidance: parseGuidanceVisualContract(html),
    camera: parseSceneConfigCameraContract(entries.camera, html) || parseSourceThreeCameraContract(html),
    grid: parseGridHelperContract(html),
    diagnostics: [],
  };
  if (!contract.backgroundColor) contract.diagnostics.push({ code: 'scene_config_background_missing_or_invalid' });
  if (!contract.ambientLight) contract.diagnostics.push({ code: 'scene_config_ambient_missing_or_invalid' });
  if (!contract.directionalLight) contract.diagnostics.push({ code: 'scene_config_directional_missing_or_invalid' });
  if (contract.fog && (!contract.fog.color || !Number.isFinite(contract.fog.near) || !Number.isFinite(contract.fog.far))) {
    contract.diagnostics.push({ code: 'scene_config_fog_invalid' });
  }
  if (contract.ground && (!contract.ground.color || (!Number.isFinite(contract.ground.radius) && !Number.isFinite(contract.ground.width)))) {
    contract.diagnostics.push({ code: 'scene_config_ground_invalid' });
  }
  return contract;
}

function parseObjectLiteralEntries(literal) {
  const entries = {};
  const text = String(literal || '').trim();
  let i = text[0] === '{' ? 1 : 0;
  const end = text[text.length - 1] === '}' ? text.length - 1 : text.length;
  while (i < end) {
    while (i < end && /[\s,]/.test(text[i])) i++;
    if (i >= end) break;
    let key;
    if (text[i] === '"' || text[i] === "'" || text[i] === '`') {
      const parsed = parseQuotedStringAt(text, i);
      if (!parsed) break;
      key = parsed.value;
      i = parsed.end;
    } else {
      const m = text.slice(i).match(/^[A-Za-z_$][\w$-]*/);
      if (!m) break;
      key = stripQuotes(m[0]);
      i += m[0].length;
    }
    while (i < end && /\s/.test(text[i])) i++;
    if (text[i] !== ':') break;
    i++;
    while (i < end && /\s/.test(text[i])) i++;
    let value;
    if (text[i] === '{') {
      value = sliceBalanced(text, i, '{', '}');
      if (!value) break;
      i += value.length;
    } else if (text[i] === '[') {
      value = sliceBalanced(text, i, '[', ']');
      if (!value) break;
      i += value.length;
    } else {
      const start = i;
      let depth = 0;
      let quote = null;
      let escaped = false;
      while (i < end) {
        const c = text[i];
        if (quote) {
          if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === quote) quote = null;
          i++;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) break;
        i++;
      }
      value = text.slice(start, i).trim();
    }
    entries[key] = value;
  }
  return entries;
}

function splitTopLevelObjects(arrayLiteral) {
  const objects = [];
  const text = String(arrayLiteral || '').trim();
  let i = text[0] === '[' ? 1 : 0;
  const end = text[text.length - 1] === ']' ? text.length - 1 : text.length;
  while (i < end) {
    while (i < end && /[\s,]/.test(text[i])) i++;
    if (i >= end) break;
    if (text[i] !== '{') {
      i++;
      continue;
    }
    const objectLiteral = sliceBalanced(text, i, '{', '}');
    if (!objectLiteral) break;
    objects.push(objectLiteral);
    i += objectLiteral.length;
  }
  return objects;
}

function parsePhaseSteps(stepsLiteral) {
  if (!stepsLiteral || String(stepsLiteral).trim()[0] !== '[') return [];
  return splitTopLevelObjects(stepsLiteral).map((stepLiteral, index) => {
    const entries = parseObjectLiteralEntries(stepLiteral);
    const step = {
      index,
      target: stripQuotes(entries.target || ''),
      label: stripQuotes(entries.label || ''),
      gain: stripQuotes(entries.gain || ''),
      spend: stripQuotes(entries.spend || ''),
      setEntity: stripQuotes(entries.setEntity || ''),
      damage: readBool(entries.damage) === true,
    };
    const amount = readNumericLiteral(entries.amount);
    if (Number.isFinite(amount)) step.amount = amount;
    return step;
  }).filter(step => step.target || step.label);
}

function collectSetTargetCalls(source) {
  const targets = [];
  const seen = {};
  const re = /\bsetTarget\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(String(source || ''))) !== null) {
    const target = String(m[2] || '').trim();
    if (!target || seen[target]) continue;
    seen[target] = true;
    targets.push(target);
  }
  return targets;
}

function findFunctionBody(source, name) {
  const esc = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\bfunction\\s+' + esc + '\\s*\\([^)]*\\)\\s*\\{', 'g');
  const m = re.exec(String(source || ''));
  if (!m) return '';
  const open = String(source || '').indexOf('{', m.index);
  const body = open >= 0 ? sliceBalanced(String(source || ''), open, '{', '}') : null;
  return body || '';
}

function findPhaseIndexBodies(source, phaseIndex, phaseId) {
  const text = String(source || '');
  const bodies = [];
  const patterns = [
    new RegExp('\\b(?:if|else\\s+if)\\s*\\([^)]*\\bphaseIndex\\s*={2,3}\\s*' + Number(phaseIndex) + '\\b[^)]*\\)\\s*\\{', 'g'),
  ];
  if (phaseId) {
    const esc = String(phaseId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp('\\b(?:if|else\\s+if)\\s*\\([^)]*\\b(?:state\\.)?phase\\s*={2,3}\\s*[\'"`]' + esc + '[\'"`][^)]*\\)\\s*\\{', 'g'));
  }
  patterns.forEach(re => {
    let m;
    while ((m = re.exec(text)) !== null) {
      const open = text.indexOf('{', m.index);
      const body = open >= 0 ? sliceBalanced(text, open, '{', '}') : null;
      if (body) bodies.push(body);
    }
  });
  return bodies;
}

function extractRuntimeTargetSequence(html, phase, index) {
  const phaseId = phase && (phase.id || phase.phaseId) || ('phase' + (index + 1));
  const bodies = [];
  bodies.push(findFunctionBody(html, 'enterPhase' + (index + 1)));
  bodies.push.apply(bodies, findPhaseIndexBodies(html, index, phaseId));
  const targets = [];
  const seen = {};
  bodies.forEach(body => {
    collectSetTargetCalls(body).forEach(target => {
      if (seen[target]) return;
      seen[target] = true;
      targets.push(target);
    });
  });
  return targets;
}

function targetHaystack(entityStyles, target) {
  const style = entityStyles && entityStyles[target] || {};
  return [target, style.kind, style.label].filter(Boolean).join(' ');
}

function isLikelyCollectTarget(phase, target, entityStyles) {
  const style = entityStyles && entityStyles[target] || {};
  const haystack = targetHaystack(entityStyles, target);
  const namedText = [target, style.label].filter(Boolean).join(' ');
  const guide = String(phase && (phase.guideText || phase.goalText || phase.name) || '');
  if (/enemy|ship|rocket|boss|敌|战舰|火箭/i.test(namedText) && !/debris|scrap|残骸|金币|coin|gold/i.test(namedText)) return false;
  if (/collectible/i.test(String(style.kind || ''))) return true;
  if (/coin|gold|scrap|debris|resource|ore|crystal|ice|wood|金币|硬币|残骸|资源|矿|冰|木/i.test(haystack)) {
    return /collect|pick|gather|coin|gold|scrap|debris|resource|收集|拾取|捡|采集|金币|残骸|资源|回收/i.test(guide + ' ' + haystack);
  }
  return false;
}

function isLikelyDamageTarget(phase, target, entityStyles) {
  const haystack = targetHaystack(entityStyles, target);
  const guide = String(phase && (phase.guideText || phase.goalText || phase.name) || '');
  return /enemy|ship|rocket|boss|monster|alien|敌|战舰|火箭|怪|异形/i.test(haystack)
    && /attack|damage|defeat|kill|shoot|击败|击毁|攻击|射击|消灭/i.test(guide + ' ' + haystack);
}

function isLikelyStateTarget(phase, target, entityStyles) {
  const style = entityStyles && entityStyles[target] || {};
  const haystack = targetHaystack(entityStyles, target);
  const guide = String(phase && (phase.guideText || phase.goalText || phase.name) || '');
  if (/cta|button|download|install|下载/i.test(haystack)) return false;
  if (/recycler|recycle|回收机|回收站/i.test(haystack)) return false;
  if (isLikelyCollectTarget(phase, target, entityStyles) || isLikelyDamageTarget(phase, target, entityStyles)) return false;
  if (!/build|upgrade|activate|deploy|repair|建造|升级|激活|部署|修复|开启/i.test(guide)) return false;
  return /gate|tower|barracks|station|beacon|pad|base|大门|防御塔|兵营|基地|设备/i.test(haystack + ' ' + String(style.kind || ''));
}

function runtimeStepFromTarget(phase, target, entityStyles, index) {
  const step = {
    index,
    target,
    label: sourceEntityLabel(entityStyles, target),
  };
  if (isLikelyCollectTarget(phase, target, entityStyles)) {
    step.gain = resourceNameForCollectTarget(target, entityStyles);
    step.amount = 1;
  } else if (isLikelyDamageTarget(phase, target, entityStyles)) {
    step.damage = true;
  } else if (isLikelyStateTarget(phase, target, entityStyles)) {
    step.setEntity = target;
    step.state = 2;
  }
  return step;
}

function sameTargetSequence(steps, targets) {
  const a = safeArray(steps).map(step => step && step.target).filter(Boolean);
  const b = safeArray(targets).filter(Boolean);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function parsePhaseTrigger(triggerLiteral) {
  if (!triggerLiteral || String(triggerLiteral).trim()[0] !== '{') return null;
  const entries = parseObjectLiteralEntries(triggerLiteral);
  const trigger = {
    type: stripQuotes(entries.type || ''),
  };
  ['entity', 'target', 'resource'].forEach(key => {
    const value = stripQuotes(entries[key] || '');
    if (value) trigger[key] = value;
  });
  ['amount', 'state', 'distance', 'range'].forEach(key => {
    const value = readNumericLiteral(entries[key]);
    if (Number.isFinite(value)) trigger[key] = value;
  });
  if (entries.triggers && String(entries.triggers).trim()[0] === '[') {
    trigger.triggers = splitTopLevelObjects(entries.triggers)
      .map(parsePhaseTrigger)
      .filter(Boolean);
  }
  return trigger.type || trigger.entity || trigger.target || trigger.resource || safeArray(trigger.triggers).length
    ? trigger
    : null;
}

function parseStringArrayLiteral(arrayLiteral) {
  const text = String(arrayLiteral || '').trim();
  if (text[0] !== '[') return [];
  const inner = text.slice(1, text[text.length - 1] === ']' ? -1 : undefined);
  return splitTopLevelArgs(inner)
    .map(value => stripQuotes(value).trim())
    .filter(Boolean);
}

function sourceEntityLabel(entityStyles, entityName) {
  const style = entityStyles && entityStyles[entityName];
  return style && style.label || entityName || '';
}

function isLikelyPlayerEntity(name, style) {
  const haystack = [name, style && style.kind, style && style.label].filter(Boolean).join(' ');
  return /player|hero|character|avatar|astronaut|主角|玩家|角色/i.test(haystack);
}

function inferResourceCollectTarget(phase, trigger, entityStyles) {
  const names = safeArray(phase && phase.showEntities).filter(Boolean);
  const resource = String(trigger && trigger.resource || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const preferred = names.find(name => {
    const style = entityStyles && entityStyles[name] || {};
    const haystack = [name, style.kind, style.label].filter(Boolean).join(' ').toLowerCase();
    return !isLikelyPlayerEntity(name, style) && resource && haystack.replace(/[^a-z0-9]/g, '').indexOf(resource) >= 0;
  });
  if (preferred) return preferred;
  const collectable = names.find(name => {
    const style = entityStyles && entityStyles[name] || {};
    const haystack = [name, style.kind, style.label].filter(Boolean).join(' ');
    return !isLikelyPlayerEntity(name, style) && /collect|resource|cube|crystal|ore|wood|ice|coin|gold|scrap|debris|tree|mine|资源|方块|木|冰|矿|金币/i.test(haystack);
  });
  if (collectable) return collectable;
  return names.find(name => {
    const style = entityStyles && entityStyles[name] || {};
    const haystack = [name, style.kind].filter(Boolean).join(' ');
    return !isLikelyPlayerEntity(name, style) && !/base|spawner|enemy|cta|button|gate|home|基地|敌|下载/i.test(haystack);
  }) || '';
}

function phaseHasModule(phase, moduleId) {
  return safeArray(phase && phase.plannedModuleIds).indexOf(moduleId) >= 0;
}

function inferImplicitCollectTarget(phase, entityStyles) {
  const names = safeArray(phase && phase.showEntities).filter(Boolean);
  const guide = String(phase && (phase.guideText || phase.goalText || phase.name) || '');
  const guideMentionsCollect = /collect|pick|gather|coin|gold|scrap|debris|resource|收集|采集|拾取|金币|残骸|资源|回收/i.test(guide);
  if (!guideMentionsCollect && !phaseHasModule(phase, 'collect_on_near') && !phaseHasModule(phase, 'inventory_wallet')) return '';
  const candidates = names.map(name => {
    const style = entityStyles && entityStyles[name] || {};
    const haystack = [name, style.kind, style.label].filter(Boolean).join(' ');
    if (isLikelyPlayerEntity(name, style)) return { name, score: 0 };
    let score = 0;
    if (/collectible/i.test(String(style.kind || ''))) score += 120;
    if (/coin|gold|金币|硬币/i.test(haystack)) score += /coin|gold|金币|硬币/i.test(guide) ? 100 : 55;
    if (/scrap|debris|残骸|垃圾/i.test(haystack)) score += /scrap|debris|残骸|垃圾/i.test(guide) ? 95 : 45;
    if (/resource|ore|crystal|ice|wood|资源|矿|冰|木/i.test(haystack)) score += /resource|ore|crystal|ice|wood|资源|矿|冰|木/i.test(guide) ? 90 : 40;
    if (/enemy|spawner|base|gate|ship|tower|cta|button|敌|生成器|基地|大门|战舰|防御塔|下载/i.test(haystack)) score -= 70;
    return { name, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const preferred = candidates[0] && candidates[0].name;
  if (preferred) return preferred;
  return names.find(name => {
    const style = entityStyles && entityStyles[name] || {};
    const haystack = [name, style.kind, style.label].filter(Boolean).join(' ');
    return !isLikelyPlayerEntity(name, style) && /item|drop|loot|pickup|收集|掉落/i.test(haystack);
  }) || '';
}

function resourceNameForCollectTarget(target, entityStyles) {
  const style = entityStyles && entityStyles[target] || {};
  const haystack = [target, style.kind, style.label].filter(Boolean).join(' ');
  if (/gold|coin|金币|硬币/i.test(haystack)) return 'Gold';
  if (/scrap|debris|残骸|垃圾/i.test(haystack)) return 'Scrap';
  if (/ice|冰/i.test(haystack)) return 'Ice';
  if (/wood|木/i.test(haystack)) return 'Wood';
  return target || 'Resource';
}

function normalizeHarvestDamageSteps(phase, entityStyles, diagnostics) {
  const steps = safeArray(phase && phase.steps);
  if (!steps.length) return steps;
  const guide = String(phase && (phase.guideText || phase.goalText || phase.name) || '');
  return steps.map(step => {
    if (!step || !step.damage || isLikelyDamageTarget(phase, step.target, entityStyles)) return step;
    const haystack = targetHaystack(entityStyles, step.target);
    const harvestLike = /cut|mine|harvest|collect|crush|break|smash|drill|recycle|采集|切割|粉碎|击碎|打碎|开采|回收|收集|拾取|捡/i.test(guide + ' ' + haystack);
    const resourceLike = isLikelyCollectTarget(phase, step.target, entityStyles)
      || /garbage|trash|scrap|debris|ice|ore|crystal|wood|resource|垃圾|残骸|冰|矿|资源|木/i.test(haystack);
    if (!harvestLike && !resourceLike) return step;
    const normalized = Object.assign({}, step, { damage: false });
    const sameTargetCollect = steps.some(other => other && other !== step && other.target === step.target && other.gain);
    if (!normalized.gain && !sameTargetCollect && resourceLike) {
      normalized.gain = resourceNameForCollectTarget(step.target, entityStyles);
      if (!Number.isFinite(Number(normalized.amount))) normalized.amount = 1;
    }
    if (diagnostics) {
      diagnostics.push({
        code: 'harvest_damage_step_normalized',
        target: step.target,
        label: step.label || '',
      });
    }
    return normalized;
  });
}

function implicitCollectStep(phase, entityStyles) {
  const target = inferImplicitCollectTarget(phase, entityStyles);
  if (!target) return null;
  return {
    index: 0,
    target,
    label: sourceEntityLabel(entityStyles, target),
    gain: resourceNameForCollectTarget(target, entityStyles),
    amount: 1,
  };
}

function derivePhaseStepsFromTrigger(phase, trigger, entityStyles) {
  if (!trigger) return [];
  if (Array.isArray(trigger.triggers) && trigger.triggers.length) {
    const nested = trigger.triggers
      .map(item => derivePhaseStepsFromTrigger(phase, item, entityStyles))
      .find(steps => steps.length);
    if (nested) return nested;
  }
  let target = trigger.entity || trigger.target || '';
  if (!target && trigger.type === 'resource_collected') {
    target = inferResourceCollectTarget(phase, trigger, entityStyles);
  }
  if (!target) return [];
  const step = {
    index: 0,
    target,
    label: sourceEntityLabel(entityStyles, target),
  };
  if (trigger.type === 'resource_collected' && trigger.resource) {
    step.gain = trigger.resource;
    if (Number.isFinite(Number(trigger.amount))) step.amount = Number(trigger.amount);
  }
  if (trigger.type === 'entity_state_reached') {
    step.setEntity = target;
    if (Number.isFinite(Number(trigger.state))) step.state = Number(trigger.state);
  }
  const steps = [];
  const collect = implicitCollectStep(phase, entityStyles);
  if (collect && collect.target !== step.target) steps.push(collect);
  steps.push(Object.assign({}, step, { index: steps.length }));
  return steps.map((item, index) => Object.assign({}, item, { index }));
}

function buildPhaseHudText(phase, index, phaseCount, entityStyles) {
  const firstTargetStep = safeArray(phase && phase.steps).find(step => step && step.target);
  const targetEntity = firstTargetStep && firstTargetStep.target || '';
  const targetLabel = sourceEntityLabel(entityStyles, targetEntity);
  return {
    phase: 'Phase ' + (index + 1) + '/' + phaseCount,
    targethint: targetLabel ? '目标：' + targetLabel : '',
    tip: phase && phase.guideText || '',
    targetEntity,
    targetLabel,
  };
}

function sourceDomIdPresent(html, id) {
  const esc = escapeRegExp(id);
  const text = String(html || '');
  return new RegExp('\\bid\\s*=\\s*["\']' + esc + '["\']').test(text)
    || new RegExp('\\bgetElementById\\(\\s*["\']' + esc + '["\']\\s*\\)').test(text);
}

function firstSourceDomId(html, ids) {
  for (const id of ids || []) {
    if (sourceDomIdPresent(html, id)) return id;
  }
  return null;
}

function extractCssRuleBody(html, selector) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/gm;
  const wanted = String(selector || '').trim();
  let m;
  while ((m = re.exec(String(html || '')))) {
    const selectors = String(m[1] || '').replace(/<[^>]*>/g, ' ').split(',').map(s => s.trim());
    if (selectors.indexOf(wanted) < 0) continue;
    const body = String(m[2] || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
    if (body) rules.push(body);
  }
  return rules.length ? rules.join(';') : null;
}

function extractCssKeyframes(html) {
  const text = String(html || '');
  const out = [];
  const re = /@keyframes\s+([A-Za-z_$][\w$-]*)\s*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const blockStart = text.indexOf('{', match.index);
    if (blockStart < 0) continue;
    const block = sliceBalanced(text, blockStart, '{', '}');
    if (!block) continue;
    out.push('@keyframes ' + match[1] + block.replace(/\/\*[\s\S]*?\*\//g, ' '));
  }
  return out.length ? out.join('\n') : null;
}

function firstCssRuleBody(html, selectors) {
  for (const selector of selectors || []) {
    const body = extractCssRuleBody(html, selector);
    if (body) return body;
  }
  return null;
}

function extractInitialDomText(html, id) {
  const re = new RegExp('<([a-zA-Z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["\']' + escapeRegExp(id) + '["\'][^>]*>([\\s\\S]*?)<\\/\\1>', 'i');
  const m = String(html || '').match(re);
  if (!m) return null;
  const text = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function extractInitialClassText(html, className) {
  const re = new RegExp('<[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\b' + escapeRegExp(className) + '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/[^>]+>', 'i');
  const m = String(html || '').match(re);
  if (!m) return null;
  const text = m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function extractInitialDescendantText(html, containerId, tagName) {
  const childRe = new RegExp(
    '<[^>]*\\bid\\s*=\\s*["\']' + escapeRegExp(containerId) + '["\'][^>]*>[\\s\\S]*?<' +
      escapeRegExp(tagName) + '\\b[^>]*>([\\s\\S]*?)<\\/' + escapeRegExp(tagName) + '>',
    'i'
  );
  const child = String(html || '').match(childRe);
  if (!child) return null;
  const text = child[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function firstInitialDomText(html, ids) {
  for (const id of ids || []) {
    const text = extractInitialDomText(html, id);
    if (text) return text;
  }
  return null;
}

function extractPhaseBadgeText(html) {
  const phaseNow = extractInitialDomText(html, 'phaseNow');
  const phaseTotal = extractInitialDomText(html, 'phaseTotal');
  if (phaseNow && phaseTotal) return 'Phase ' + phaseNow + '/' + phaseTotal;
  return firstInitialDomText(html, ['phaseBadge', 'phaseBox', 'phaseText']);
}

function parseSourceDomHudContract(html) {
  const ctaOverlayIds = ['ctaOverlay', 'downloadOverlay', 'installOverlay', 'victory'];
  const ctaPanelIds = ['ctaPanel', 'ctaBox', 'downloadPanel', 'installPanel'];
  const ctaButtonIds = ['ctaDom', 'ctaButtonDom', 'ctaDomButton', 'installButton', 'downloadButton', 'ctaButton', 'CTAButton'];
  const ctaOverlaySelectors = ctaOverlayIds.map(id => '#' + id);
  const ctaPanelSelectors = ctaPanelIds.map(id => '#' + id);
  const ctaButtonSelectors = ctaButtonIds.map(id => '#' + id);
  const selectedCtaOverlayId = firstSourceDomId(html, ctaOverlayIds);
  const ids = {
    hud: firstSourceDomId(html, ['hud', 'topbar']),
    logo: sourceDomIdPresent(html, 'logo') ? 'logo' : null,
    meters: firstSourceDomId(html, ['meters', 'leftStats']),
    targetHint: sourceDomIdPresent(html, 'targetHint') ? 'targetHint' : null,
    scoreText: sourceDomIdPresent(html, 'scoreText') ? 'scoreText' : null,
    goalText: sourceDomIdPresent(html, 'goalText') ? 'goalText' : null,
    goldBox: firstSourceDomId(html, ['goldBox', 'scoreBox', 'coinBox', 'wallet', 'goldPanel']),
    goldIcon: sourceDomIdPresent(html, 'goldIcon') ? 'goldIcon' : null,
    goldCount: firstSourceDomId(html, ['goldCount', 'goldValue']),
    goldText: firstSourceDomId(html, ['goldText', 'goldValue']),
    oxygenText: sourceDomIdPresent(html, 'oxygenText') ? 'oxygenText' : null,
    iceText: sourceDomIdPresent(html, 'iceText') ? 'iceText' : null,
    matText: sourceDomIdPresent(html, 'matText') ? 'matText' : null,
    tip: sourceDomIdPresent(html, 'tip') ? 'tip' : null,
    phaseBadge: firstSourceDomId(html, ['phaseBadge', 'phaseBox', 'phaseText']),
    resources: sourceDomIdPresent(html, 'resources') ? 'resources' : null,
    progressWrap: sourceDomIdPresent(html, 'progressWrap') ? 'progressWrap' : null,
    progressBar: sourceDomIdPresent(html, 'progressBar') ? 'progressBar' : null,
    phaseLabel: sourceDomIdPresent(html, 'phaseLabel') ? 'phaseLabel' : null,
    workerPanel: sourceDomIdPresent(html, 'workerPanel') ? 'workerPanel' : null,
    upgradePanel: sourceDomIdPresent(html, 'upgradePanel') ? 'upgradePanel' : null,
    joystick: sourceDomIdPresent(html, 'joystick') ? 'joystick' : null,
    stickThumb: firstSourceDomId(html, ['stickThumb', 'joyThumb', 'stick']),
    toast: sourceDomIdPresent(html, 'toast') ? 'toast' : null,
    victory: selectedCtaOverlayId,
    ctaPanel: firstSourceDomId(html, ctaPanelIds),
    ctaDom: firstSourceDomId(html, ctaButtonIds),
  };
  const present = Object.keys(ids).some(key => !!ids[key]);
  const hudCss = [
    extractCssRuleBody(html, '.hud'),
    firstCssRuleBody(html, ['#hud', '#topbar']),
  ].filter(Boolean).join(';');
  const css = {
    hud: hudCss || null,
    logo: extractCssRuleBody(html, '#logo'),
    meters: firstCssRuleBody(html, ['#meters', '#leftStats']),
    targetHint: extractCssRuleBody(html, '#targetHint'),
    scoreText: extractCssRuleBody(html, '#scoreText'),
    goalText: extractCssRuleBody(html, '#goalText'),
    goldBox: firstCssRuleBody(html, ['#goldBox', '#scoreBox', '#coinBox', '#wallet', '#goldPanel']),
    goldIcon: extractCssRuleBody(html, '#goldIcon'),
    goldCount: firstCssRuleBody(html, ['#goldCount', '#goldValue']),
    goldText: firstCssRuleBody(html, ['#goldText', '#goldValue']),
    oxygenText: extractCssRuleBody(html, '#oxygenText'),
    iceText: extractCssRuleBody(html, '#iceText'),
    matText: extractCssRuleBody(html, '#matText'),
    tip: extractCssRuleBody(html, '#tip'),
    phaseBadge: firstCssRuleBody(html, ['#phaseBadge', '#phaseBox', '#phaseText']),
    resources: extractCssRuleBody(html, '#resources'),
    resourcePill: firstCssRuleBody(html, ['.res', '.pill']),
    progressWrap: extractCssRuleBody(html, '#progressWrap'),
    progressBar: extractCssRuleBody(html, '#progressBar'),
    phaseLabel: extractCssRuleBody(html, '#phaseLabel'),
    workerPanel: extractCssRuleBody(html, '#workerPanel'),
    upgradePanel: extractCssRuleBody(html, '#upgradePanel'),
    joystick: extractCssRuleBody(html, '#joystick'),
    stickThumb: firstCssRuleBody(html, ['#stickThumb', '#joyThumb', '#stick']),
    coinIcon: extractCssRuleBody(html, '.coinIcon'),
    toast: extractCssRuleBody(html, '#toast'),
    victory: firstCssRuleBody(html, ctaOverlaySelectors),
    victoryBox: selectedCtaOverlayId && selectedCtaOverlayId !== 'victory'
      ? firstCssRuleBody(html, ctaPanelSelectors.concat(['#victory', '#' + selectedCtaOverlayId + ' .ctaBox', '.ctaBox']))
      : null,
    victoryTitle: firstCssRuleBody(html, ['#victory h1', '#ctaOverlay h1', '.ctaTitle']),
    ctaSubtitle: firstCssRuleBody(html, ['#ctaOverlay small', '.ctaSubtitle', '.ctaSubTitle']),
    ctaDom: firstCssRuleBody(html, ctaButtonSelectors.concat(['#ctaOverlay button', '.ctaBtn'])),
    keyframes: extractCssKeyframes(html),
  };
  const initialText = {
    scoreText: extractInitialDomText(html, 'scoreText'),
    goalText: extractInitialDomText(html, 'goalText'),
    logo: extractInitialDomText(html, 'logo'),
    goldCount: firstInitialDomText(html, ['goldCount', 'goldValue']),
    goldText: firstInitialDomText(html, ['goldText', 'goldValue']),
    oxygenText: extractInitialDomText(html, 'oxygenText'),
    iceText: extractInitialDomText(html, 'iceText'),
    matText: extractInitialDomText(html, 'matText'),
    resources: extractInitialDomText(html, 'resources'),
    progressWrap: extractInitialDomText(html, 'progressWrap'),
    progressBar: extractInitialDomText(html, 'progressBar'),
    tip: extractInitialDomText(html, 'tip'),
    goldBox: firstInitialDomText(html, ['goldBox', 'scoreBox', 'coinBox', 'wallet', 'goldPanel']),
    phaseBadge: extractPhaseBadgeText(html),
    phaseLabel: extractInitialDomText(html, 'phaseLabel'),
    workerPanel: extractInitialDomText(html, 'workerPanel'),
    upgradePanel: extractInitialDomText(html, 'upgradePanel'),
    targetHint: extractInitialDomText(html, 'targetHint'),
    victory: (selectedCtaOverlayId ? extractInitialDescendantText(html, selectedCtaOverlayId, 'h1') : null)
      || extractInitialClassText(html, 'ctaTitle')
      || extractInitialDomText(html, 'victory')
      || extractInitialDescendantText(html, 'ctaOverlay', 'h1'),
    ctaPanel: firstInitialDomText(html, ctaPanelIds),
    ctaDom: firstInitialDomText(html, ctaButtonIds)
      || extractInitialClassText(html, 'ctaBtn')
      || extractInitialDescendantText(html, 'ctaOverlay', 'button'),
    ctaSubtitle: extractInitialDescendantText(html, 'ctaOverlay', 'small')
      || extractInitialClassText(html, 'ctaSubtitle')
      || extractInitialClassText(html, 'ctaSubTitle'),
  };
  const diagnostics = [];
  if (present && !ids.hud) diagnostics.push({ code: 'source_hud_container_missing' });
  if (present && !ids.targetHint) diagnostics.push({ code: 'source_target_hint_missing' });
  if (present && !css.hud) diagnostics.push({ code: 'source_hud_css_missing' });
  return {
    present,
    source: 'source-html-dom-hud',
    ids,
    css,
    initialText,
    diagnostics,
  };
}

function parseSourceUiOverlayContract(html, entityStyles) {
  const overlays = [];
  function add(id, role, details) {
    if (!id || overlays.some(item => item.id === id)) return;
    overlays.push(Object.assign({
      id,
      role,
      source: 'source-html-ui-overlay',
    }, details || {}));
  }
  if (entityStyles && entityStyles.CtaButton) {
    add('CtaButton', 'cta', {
      label: entityStyles.CtaButton.label || 'CtaButton',
      source: 'ENTITY_STYLE.CtaButton',
    });
  }
  if (/\bid\s*=\s*["']joystick["']/.test(html) || /getElementById\(\s*["']joystick["']\s*\)/.test(html)) {
    add('Canvas', 'ui-canvas', { source: 'html-dom-ui-layer' });
    add('JoystickBG', 'joystick-background', { domId: 'joystick' });
  }
  if (/\bid\s*=\s*["']joystick-knob["']/.test(html) || /getElementById\(\s*["']joystick-knob["']\s*\)/.test(html)) {
    add('JoystickHandle', 'joystick-handle', { domId: 'joystick-knob' });
  }
  return {
    present: overlays.length > 0,
    entities: overlays,
  };
}

function parseSourceWorldLabelContract(html) {
  const text = String(html || '');
  const spriteLabels = /\b(?:makeLabel|CanvasTexture|CSS2DObject|CSS3DObject|THREE\.Sprite|new\s+Sprite)\b/.test(text)
    && /\b(?:fillText|textContent|innerText)\b/.test(text)
    && /\b(?:label|world_label|labels)\b/i.test(text);
  const domLabels = /document\.createElement\s*\(\s*["']div["']\s*\)[\s\S]{0,260}\.className\s*=\s*["']label["']/.test(text)
    && /\blabels\s*\[[^\]]+\]\s*=/.test(text)
    && /\b(?:textContent|innerText)\s*=/.test(text);
  const present = spriteLabels || domLabels;
  return {
    present,
    source: present ? (domLabels ? 'source-html-dom-world-labels' : 'source-html-world-label-renderer') : 'not-rendered-in-source-html',
  };
}

function parseRuntimeVisibilityRules(html) {
  const rules = {
    always: [],
    minPhaseIndex: [],
    exactPhaseIndex: [],
    statefulSetEntities: false,
  };
  String(html || '').split(/\r?\n/).forEach(line => {
    const setVisibleVar = line.match(/\bsetVisible\s*\(\s*([A-Za-z_$][\w$]*)\s*,/);
    const visibleAssignVar = line.match(/\b(?:models|entities|groups)\s*\[\s*([A-Za-z_$][\w$]*)\s*\]\s*\.\s*visible\s*=/);
    const visibilityVar = setVisibleVar || visibleAssignVar;
    if (visibilityVar) {
      const varName = visibilityVar[1];
      const varNameRe = escapeRegExp(varName);
      const alwaysRe = new RegExp('\\b' + varNameRe + '\\s*={2,3}\\s*["\\\']([^"\\\']+)["\\\']', 'g');
      let alwaysMatch;
      while ((alwaysMatch = alwaysRe.exec(line))) {
        if (rules.always.indexOf(alwaysMatch[1]) < 0) rules.always.push(alwaysMatch[1]);
      }
      const arrayRe = new RegExp('\\[((?:(?:"[^"]+"|\\\'[^\\\']+\\\')\\s*,?\\s*)+)\\]\\s*\\.\\s*(?:indexOf|includes)\\s*\\(\\s*' + varNameRe + '\\s*\\)', 'g');
      let arrayMatch;
      while ((arrayMatch = arrayRe.exec(line))) {
        const literalRe = /["']([^"']+)["']/g;
        let literalMatch;
        while ((literalMatch = literalRe.exec(arrayMatch[1]))) {
          if (rules.always.indexOf(literalMatch[1]) < 0) rules.always.push(literalMatch[1]);
        }
      }
      if (new RegExp('entityState\\s*\\[\\s*' + varNameRe + '\\s*\\]\\.state\\s*>\\s*0').test(line)) {
        rules.statefulSetEntities = true;
      }
    }
    const m = line.match(/\bsetVisible\s*\(\s*["']([^"']+)["']\s*,\s*true\s*\)/);
    if (!m) return;
    const entity = m[1];
    const min = line.match(/\bif\s*\(\s*i\s*>=\s*(\d+)\s*\)/);
    if (min) {
      rules.minPhaseIndex.push({ entity, index: Number(min[1]) });
      return;
    }
    const exact = line.match(/\bif\s*\(\s*i\s*={2,3}\s*(\d+)\s*\)/);
    if (exact) {
      rules.exactPhaseIndex.push({ entity, index: Number(exact[1]) });
      return;
    }
    if (rules.always.indexOf(entity) < 0) rules.always.push(entity);
  });
  return rules;
}

function parseRuntimeResourceRules(html) {
  const rules = [];
  const text = String(html || '');
  const directRe = /if\s*\(\s*i\s*={2,3}\s*(\d+)[^)]*\)\s*resources\.([A-Za-z_$][\w$]*)\s*=\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = directRe.exec(text))) {
    rules.push({ index: Number(m[1]), resource: m[2], value: Number(m[3]) });
  }
  const maxRe = /if\s*\(\s*i\s*={2,3}\s*(\d+)[^)]*\)\s*resources\.([A-Za-z_$][\w$]*)\s*=\s*Math\.max\s*\(\s*resources\.\2\s*,\s*(\d+(?:\.\d+)?)\s*\)/g;
  while ((m = maxRe.exec(text))) {
    rules.push({ index: Number(m[1]), resource: m[2], value: Number(m[3]) });
  }
  return rules;
}

function runtimeResourcesForPhase(index, rules) {
  const out = {};
  safeArray(rules).forEach(rule => {
    if (!rule || Number(rule.index) !== index) return;
    const value = Number(rule.value);
    if (!rule.resource || !isFinite(value)) return;
    out[rule.resource] = Math.max(Number(out[rule.resource] || 0), value);
  });
  return out;
}

function runtimeVisibleEntitiesForPhase(phase, index, rules) {
  const out = [];
  function add(name) {
    if (name && out.indexOf(name) < 0) out.push(name);
  }
  safeArray(phase && phase.showEntities).forEach(add);
  safeArray(rules && rules.always).forEach(add);
  safeArray(rules && rules.minPhaseIndex).forEach(rule => {
    if (rule && index >= Number(rule.index)) add(rule.entity);
  });
  safeArray(rules && rules.exactPhaseIndex).forEach(rule => {
    if (rule && index === Number(rule.index)) add(rule.entity);
  });
  return out;
}

function applyStatefulVisibilityRules(phases, rules) {
  if (!(rules && rules.statefulSetEntities)) return phases;
  const visibleByState = [];
  function addStateful(name) {
    if (name && visibleByState.indexOf(name) < 0) visibleByState.push(name);
  }
  function addVisible(phase, name) {
    if (!phase || !name) return;
    phase.runtimeVisibleEntities = safeArray(phase.runtimeVisibleEntities);
    if (phase.runtimeVisibleEntities.indexOf(name) < 0) phase.runtimeVisibleEntities.push(name);
  }
  safeArray(phases).forEach(phase => {
    visibleByState.forEach(name => addVisible(phase, name));
    safeArray(phase && phase.steps).forEach(step => {
      if (step && step.setEntity) addStateful(step.setEntity);
    });
  });
  return phases;
}

function parseSourcePhaseContract(html, options) {
  options = options || {};
  const entityStyles = options.entityStyles || parseEntityStyleMap(html);
  const found = findArrayAssignmentLiteral(html, 'PHASES');
  if (!found) {
    return { present: false, carrier: 'PHASES', phases: [], diagnostics: [{ code: 'phases_missing' }] };
  }
  const phaseLiterals = splitTopLevelObjects(found.literal);
  const phaseCount = phaseLiterals.length;
  const visibilityRules = parseRuntimeVisibilityRules(html);
  const resourceRules = parseRuntimeResourceRules(html);
  const phases = phaseLiterals.map((phaseLiteral, index) => {
    const entries = parseObjectLiteralEntries(phaseLiteral);
    const trigger = parsePhaseTrigger(entries.trigger);
    const phase = {
      index,
      id: stripQuotes(entries.id || ('phase' + (index + 1))),
      name: stripQuotes(entries.name || ''),
      guideText: stripQuotes(entries.guideText || ''),
      goalText: stripQuotes(entries.goalText || ''),
      showEntities: parseStringArrayLiteral(entries.showEntities),
      plannedModuleIds: parseStringArrayLiteral(entries.plannedModuleIds),
      trigger,
      steps: parsePhaseSteps(entries.steps),
    };
    phase.diagnostics = [];
    if (phase.steps.length) {
      phase.steps = normalizeHarvestDamageSteps(phase, entityStyles, phase.diagnostics);
    }
    const runtimeTargetSequence = extractRuntimeTargetSequence(html, phase, index);
    phase.runtimeTargetSequence = runtimeTargetSequence;
    phase.stepSource = phase.steps.length ? 'PHASES.steps' : '';
    if (!phase.steps.length && runtimeTargetSequence.length) {
      phase.steps = runtimeTargetSequence.map((target, stepIndex) => runtimeStepFromTarget(phase, target, entityStyles, stepIndex));
      phase.stepSource = 'runtime_setTarget';
    }
    if (!phase.steps.length) {
      phase.steps = derivePhaseStepsFromTrigger(phase, trigger, entityStyles);
      phase.stepSource = phase.steps.length ? 'PHASES.trigger' : '';
    } else if (runtimeTargetSequence.length && !sameTargetSequence(phase.steps, runtimeTargetSequence)) {
      phase.diagnostics.push({
        code: 'phase_runtime_target_sequence_differs_from_contract_steps',
        runtimeTargetSequence,
        contractTargetSequence: phase.steps.map(step => step && step.target).filter(Boolean),
      });
    }
    phase.targetSequence = phase.steps.map(step => step && step.target).filter(Boolean);
    phase.runtimeVisibleEntities = runtimeVisibleEntitiesForPhase(phase, index, visibilityRules);
    phase.runtimeResources = runtimeResourcesForPhase(index, resourceRules);
    phase.hudText = buildPhaseHudText(phase, index, phaseCount, entityStyles);
    return phase;
  });
  applyStatefulVisibilityRules(phases, visibilityRules);
  return {
    present: true,
    carrier: 'PHASES',
    phaseCount: phases.length,
    phases,
    visibilityRules,
    resourceRules,
    diagnostics: phases.length ? [] : [{ code: 'phases_empty' }],
  };
}

function parseEntityStyleMap(html) {
  const styles = {};
  const styleLiteral = findObjectAssignmentLiteral(html, 'ENTITY_STYLE');
  const positionLiteral = findObjectAssignmentLiteral(html, 'ENTITY_POSITIONS');
  const styleEntries = styleLiteral ? parseObjectLiteralEntries(styleLiteral.literal) : {};
  const positionEntries = positionLiteral ? parseObjectLiteralEntries(positionLiteral.literal) : {};
  Object.keys(styleEntries).forEach(name => {
    const body = styleEntries[name];
    styles[name] = Object.assign(styles[name] || {}, {
      name,
      label: stripQuotes(readProp(body, 'label') || name),
      kind: stripQuotes(readProp(body, 'kind') || ''),
      color: normalizeColor(readProp(body, 'color')),
      styleSource: 'ENTITY_STYLE',
    });
  });
  Object.keys(positionEntries).forEach(name => {
    const body = positionEntries[name];
    styles[name] = Object.assign(styles[name] || { name }, {
      position: {
        x: readNumber(readProp(body, 'x')) || 0,
        y: readNumber(readProp(body, 'y')) || 0,
        z: readNumber(readProp(body, 'z')) || 0,
      },
      positionSource: 'ENTITY_POSITIONS',
    });
  });
  return styles;
}

function collectEntityNamesFromHtml(html) {
  const names = Object.keys(parseEntityStyleMap(html));
  const patterns = [
    /\bmodels\s*\[\s*['"`]([^'"`]+)['"`]\s*\]\s*=/g,
    /\bmodels\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bentity_states\s*\[\s*['"`]([^'"`]+)['"`]\s*\]\s*=/g,
    /\bentity_states\.([A-Za-z_$][\w$]*)\s*=/g,
  ];
  patterns.forEach(re => {
    let m;
    while ((m = re.exec(html)) !== null) names.push(m[1]);
  });
  return uniq(names);
}

function serializableEntityStyles(entityStyles) {
  const out = {};
  Object.keys(entityStyles || {}).sort().forEach(name => {
    const style = entityStyles[name] || {};
    out[name] = {
      label: style.label || name,
      kind: style.kind || null,
      color: style.color || null,
      position: style.position || null,
      styleSource: style.styleSource || null,
      positionSource: style.positionSource || null,
    };
  });
  return out;
}

function readBool(value) {
  if (value == null) return null;
  if (/true/i.test(value)) return true;
  if (/false/i.test(value)) return false;
  return null;
}

function readNumber(value) {
  if (value == null) return null;
  const n = Number(stripQuotes(value));
  return Number.isFinite(n) ? n : null;
}

function parseGeometryExpression(expr, geometryVars) {
  const text = String(expr || '').trim();
  const ctor = text.match(/new\s+THREE\.([A-Za-z0-9_]+Geometry)\s*\(/);
  if (ctor && GEOMETRY_KIND.test(ctor[1])) {
    const callStart = text.indexOf('(', ctor.index);
    const call = sliceBalanced(text, callStart, '(', ')') || '()';
    return {
      type: ctor[1],
      argsRaw: call.slice(1, -1).trim(),
      source: 'inline',
    };
  }
  const varName = text.match(/^[A-Za-z_$][\w$]*/);
  if (varName && geometryVars[varName[0]]) return Object.assign({}, geometryVars[varName[0]], { source: 'variable', variable: varName[0] });
  return { type: 'UnknownGeometry', argsRaw: text, source: 'unknown' };
}

function parseMaterialExpression(expr, materialVars, context) {
  const text = String(expr || '').trim();
  const materialContext = context || {};
  const aliases = materialContext.materialAliases || {};
  if (aliases[text]) return Object.assign({}, aliases[text], { source: 'entity_builder_alias', variable: text });
  const matCall = text.match(/^mat\s*\(([\s\S]*)\)$/);
  if (matCall) {
    const args = splitTopLevelArgs(matCall[1]);
    const rawColor = args[0] === 'style.color' ? materialContext.styleColor : args[0];
    return {
      type: 'MeshStandardMaterial',
      source: 'entity_builder_factory',
      diffuseColor: normalizeColor(rawColor, materialContext.styleColor),
      emissiveColor: normalizeColor(args[2]),
      opacity: readNumber(args[1]),
      transparent: readNumber(args[1]) == null ? undefined : readNumber(args[1]) < 1,
      roughness: 0.55,
      metalness: 0.1,
    };
  }
  const ctor = text.match(/new\s+THREE\.([A-Za-z0-9_]+Material)\s*\(/);
  if (ctor) {
    const callStart = text.indexOf('(', ctor.index);
    const call = sliceBalanced(text, callStart, '(', ')') || '()';
    const args = splitTopLevelArgs(call.slice(1, -1));
    const options = args.find(arg => /^\{/.test(arg)) || '{}';
    return materialFromOptions(ctor[1], options, 'inline', materialContext);
  }
  const varName = text.match(/^[A-Za-z_$][\w$]*/);
  if (varName && materialVars[varName[0]]) return Object.assign({}, materialVars[varName[0]], { source: 'variable', variable: varName[0] });
  return { type: 'UnknownMaterial', source: 'unknown' };
}

function makeStandardMaterial(color, source, roughness, metalness) {
  return {
    type: 'MeshStandardMaterial',
    source: source || 'entity_builder_factory',
    diffuseColor: normalizeColor(color),
    emissiveColor: null,
    opacity: null,
    roughness: roughness == null ? 0.55 : roughness,
    metalness: metalness == null ? 0.08 : metalness,
  };
}

function entityBuilderMaterialAliases(entityStyle) {
  const styleColor = entityStyle && entityStyle.color;
  return {
    base: makeStandardMaterial(styleColor, 'entity_builder_alias'),
    dark: makeStandardMaterial('0x15283b', 'entity_builder_alias'),
    accent: makeStandardMaterial('0xffe36a', 'entity_builder_alias', 0.45, 0.05),
  };
}

function materialFromOptions(type, optionsBody, source, context) {
  const body = String(optionsBody || '').replace(/^\{|\}$/g, '');
  const transparent = readBool(readProp(body, 'transparent'));
  const materialContext = context || {};
  return {
    type,
    source,
    diffuseColor: normalizeColor(readProp(body, 'color'), materialContext.styleColor),
    emissiveColor: normalizeColor(readProp(body, 'emissive')),
    opacity: readNumber(readProp(body, 'opacity')),
    transparent: transparent == null ? undefined : transparent,
    roughness: readNumber(readProp(body, 'roughness')),
    metalness: readNumber(readProp(body, 'metalness')),
    doubleSided: /DoubleSide/.test(body) ? true : undefined,
  };
}

function collectGeometryVars(html) {
  const out = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.([A-Za-z0-9_]+Geometry)\s*\(/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const callStart = html.indexOf('(', m.index);
    const call = sliceBalanced(html, callStart, '(', ')') || '()';
    out[m[1]] = { type: m[2], argsRaw: call.slice(1, -1).trim(), source: 'variable', variable: m[1] };
  }
  return out;
}

function collectMaterialVars(html) {
  const out = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.([A-Za-z0-9_]+Material)\s*\(/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const callStart = html.indexOf('(', m.index);
    const call = sliceBalanced(html, callStart, '(', ')') || '()';
    const args = splitTopLevelArgs(call.slice(1, -1));
    const options = args.find(arg => /^\{/.test(arg)) || '{}';
    out[m[1]] = materialFromOptions(m[2], options, 'variable');
    out[m[1]].variable = m[1];
  }
  return out;
}

function collectTransform(html, variable) {
  const esc = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = {};
  const setRe = new RegExp('\\b' + esc + '\\.(position|rotation|scale)\\.set\\s*\\(([^)]*)\\)', 'g');
  let m;
  while ((m = setRe.exec(html)) !== null) {
    out[m[1]] = splitTopLevelArgs(m[2]).map(v => stripQuotes(v));
  }
  return out;
}

function collectLoaderVars(html) {
  const out = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:THREE\.)?([A-Za-z0-9_]+Loader)\s*\(/g;
  let m;
  while ((m = re.exec(html)) !== null) out[m[1]] = m[2];
  return out;
}

function inferEntityBinding(variable, entityNames) {
  const v = normalizeKey(variable);
  if (!v) return null;
  let best = null;
  for (const entity of entityNames) {
    const e = normalizeKey(entity);
    if (!e) continue;
    let confidence = 0;
    if (v === e) confidence = 1;
    else if (v.indexOf(e) >= 0) confidence = 0.9;
    else if (e.indexOf(v) >= 0 && v.length >= 3) confidence = 0.75;
    if (confidence && (!best || confidence > best.confidence)) {
      best = { entityName: entity, confidence, evidence: 'variable_name' };
    }
  }
  return best;
}

function primaryPlayableEntity(entityNames, entityStyles) {
  const names = safeArray(entityNames);
  const styles = entityStyles || {};
  const preferred = ['Player', 'PlayerCharacter', 'Hero', 'Avatar', 'Character'];
  for (const name of preferred) {
    if (names.indexOf(name) >= 0 || styles[name]) return name;
  }
  const candidates = names.map(name => {
    const style = styles[name] || {};
    const text = [name, style.kind, style.label].filter(Boolean).join(' ');
    let score = 0;
    if (/player|hero|character|avatar|玩家|角色/i.test(text)) score += 100;
    if (/astronaut|宇航员/i.test(text)) score += 80;
    if (/soldier|士兵/i.test(text)) score += 35;
    if (/rocket|火箭/i.test(text)) score -= 10;
    return { name, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0] && candidates[0].name || null;
}

function inferSemanticEntityBinding(variable, entityNames, entityStyles) {
  const direct = inferEntityBinding(variable, entityNames);
  if (direct) return direct;
  const v = normalizeKey(variable);
  if (/player|hero|character|avatar|astronaut/.test(v)) {
    const player = primaryPlayableEntity(entityNames, entityStyles);
    if (player) return { entityName: player, confidence: 0.82, evidence: 'semantic_player_group' };
  }
  return null;
}

function buildAsset(variable, index, expr, html, geometryVars, materialVars, entityNames, context) {
  const args = splitTopLevelArgs(expr.slice(1, -1));
  const geometry = parseGeometryExpression(args[0], geometryVars);
  const material = parseMaterialExpression(args[1], materialVars, context);
  const unsupported = [];
  let fidelityTarget = 'geometry_color_material';
  let visualFallback = null;
  if (geometry.type === 'BufferGeometry') {
    unsupported.push('custom_buffer_geometry');
    fidelityTarget = 'geometry_color_only';
    visualFallback = 'primitive_approximation';
  }
  if (!MATERIAL_KIND.test(material.type || '') && material.type !== 'UnknownMaterial') {
    unsupported.push('unsupported_material:' + material.type);
    fidelityTarget = 'geometry_color_only';
  }
  const entityBinding = inferEntityBinding(variable, entityNames);
  return {
    assetId: stableAssetId(variable || ('mesh_' + index)),
    kind: 'procedural_primitive',
    ...assetLicenseFields(),
    source: {
      type: 'inline_procedural',
      variable: variable || null,
      line: findLine(html, index),
    },
    unityImport: {
      mode: 'runtime-generate',
      supported: unsupported.length === 0,
      generator: 'GFM_Create.Obj',
    },
    geometry,
    material,
    transform: variable ? collectTransform(html, variable) : {},
    entityBinding: entityBinding || { entityName: null, confidence: 0, evidence: 'unbound' },
    fidelityTarget,
    visualFallback,
    unsupported,
  };
}

function collectMeshAssets(html, geometryVars, materialVars, entityNames) {
  const assets = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.Mesh\s*\(/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (curlyDepthAt(html, m.index) > 0) continue;
    const callStart = html.indexOf('(', m.index);
    const call = sliceBalanced(html, callStart, '(', ')');
    if (!call) continue;
    assets.push(buildAsset(m[1], m.index, call, html, geometryVars, materialVars, entityNames));
  }
  return assets;
}

function collectBuildEntityFunction(html) {
  const re = /\bfunction\s+buildEntity\s*\(([^)]*)\)\s*\{/g;
  const m = re.exec(html);
  if (!m) return null;
  const bodyStart = html.indexOf('{', m.index + m[0].length - 1);
  const body = sliceBalanced(html, bodyStart, '{', '}');
  if (!body) return null;
  return { args: m[1], body, index: m.index, bodyStart };
}

function collectBuildEntityBranches(fn) {
  const branches = {};
  const branchRe = /(?:^|[\s;}]|else\s+)if\s*\(\s*(?:style\.kind|kind)\s*===\s*['"`]([^'"`]+)['"`]\s*\)\s*\{/g;
  let m;
  while ((m = branchRe.exec(fn.body)) !== null) {
    const open = fn.body.indexOf('{', m.index + m[0].length - 1);
    const block = sliceBalanced(fn.body, open, '{', '}');
    if (block) branches[m[1]] = { block, offset: fn.bodyStart + open };
  }
  const elseRe = /\belse\s*\{/g;
  while ((m = elseRe.exec(fn.body)) !== null) {
    const open = fn.body.indexOf('{', m.index + m[0].length - 1);
    const block = sliceBalanced(fn.body, open, '{', '}');
    if (block) branches.__default = { block, offset: fn.bodyStart + open };
  }
  return branches;
}

function meshCallFromExpression(expr) {
  const text = String(expr || '').trim();
  const mesh = text.match(/new\s+THREE\.Mesh\s*\(/);
  if (!mesh) return null;
  const open = text.indexOf('(', mesh.index);
  return sliceBalanced(text, open, '(', ')');
}

function collectLocalMeshDecls(block) {
  const out = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.Mesh\s*\(/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const open = block.indexOf('(', m.index + m[0].length - 1);
    const call = sliceBalanced(block, open, '(', ')');
    if (call) out[m[1]] = { call, offset: m.index };
  }
  return out;
}

function collectAddCalls(block) {
  const calls = [];
  const re = /\b(?:([A-Za-z_$][\w$]*)\s*\.\s*)?(addMesh|add)\s*\(/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const open = block.indexOf('(', m.index);
    const call = sliceBalanced(block, open, '(', ')');
    if (!call) {
      re.lastIndex = m.index + 4;
      continue;
    }
    const receiver = m[1] || null;
    calls.push({
      call,
      callee: m[2],
      receiver,
      offset: m.index,
      endOffset: open + call.length,
    });
    re.lastIndex = open + call.length;
  }
  return calls;
}

function transformFromMeshOpLiteral(opLiteral) {
  const text = String(opLiteral || '').trim();
  if (!text || text[0] !== '{') return {};
  const op = parseObjectLiteralEntries(text);
  const out = {};
  if (op.position) out.position = meshOpArray(op.position, [0, 0, 0]);
  if (op.rotation) out.rotation = meshOpArray(op.rotation, [0, 0, 0]);
  if (op.scale) out.scale = meshOpArray(op.scale, [1, 1, 1]);
  return out;
}

function collectTrailingTransform(block, addCall, meshExpr) {
  const out = {};
  const end = addCall.endOffset || (addCall.offset + 3 + addCall.call.length);
  const segment = block.slice(end, end + 180);
  const axisMap = { x: 0, y: 1, z: 2 };
  const rotation = [null, null, null];
  const chain = segment.match(/^\s*\.rotation\.([xyz])\s*=\s*([^;]+)/);
  if (chain) {
    rotation[axisMap[chain[1]]] = stripQuotes(chain[2]);
  }
  if (meshExpr && /^[A-Za-z_$][\w$]*$/.test(meshExpr)) {
    const esc = meshExpr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const setRe = new RegExp('\\b' + esc + '\\.rotation\\.set\\s*\\(([^)]*)\\)');
    const set = segment.match(setRe);
    if (set) out.rotation = splitTopLevelArgs(set[1]).map(value => stripQuotes(value));
  }
  if (!out.rotation && rotation.some(value => value != null)) {
    out.rotation = rotation.map(value => value == null ? '0' : value);
  }
  const scaleSet = segment.match(/\.scale\.set\s*\(([^)]*)\)/);
  if (scaleSet) out.scale = splitTopLevelArgs(scaleSet[1]).map(value => stripQuotes(value));
  const scalarSet = segment.match(/\.scale\.setScalar\s*\(([^)]*)\)/);
  if (scalarSet) {
    const s = stripQuotes(splitTopLevelArgs(scalarSet[1])[0] || '1');
    out.scale = [s, s, s];
  }
  return out;
}

function buildEntityMeshAsset(entityName, meshName, index, meshCall, html, geometryVars, materialVars, entityStyle, positionArgs, sourceKind, extraTransform) {
  const variable = sanitizeId(entityName + '_' + meshName + '_' + index);
  const asset = buildAsset(variable, index, meshCall, html, geometryVars, materialVars, [entityName], {
    styleColor: entityStyle && entityStyle.color,
    materialAliases: entityBuilderMaterialAliases(entityStyle),
  });
  asset.entityBinding = {
    entityName,
    confidence: 1,
    evidence: 'buildEntity:ENTITY_STYLE',
  };
  asset.source.variable = variable;
  asset.source.entityName = entityName;
  asset.source.entityKind = entityStyle && entityStyle.kind || null;
  asset.source.pattern = sourceKind || 'buildEntity';
  if (positionArgs && positionArgs.length) {
    asset.transform = Object.assign({}, asset.transform, {
      position: positionArgs.map(value => stripQuotes(value)),
    });
  }
  if (extraTransform && Object.keys(extraTransform).length) {
    asset.transform = Object.assign({}, asset.transform, extraTransform);
  }
  return asset;
}

function meshOpArray(value, fallback) {
  const text = String(value || '').trim();
  if (!text || text[0] !== '[') return fallback || [];
  const parsed = splitTopLevelArgs(text.slice(1, text[text.length - 1] === ']' ? -1 : undefined)).map(stripQuotes);
  return parsed.length ? parsed : (fallback || []);
}

function meshOpGeometry(kind, size) {
  const k = String(kind || '').toLowerCase();
  const s = size && size.length ? size : [1, 1, 1];
  if (k === 'sphere') return { type: 'SphereGeometry', argsRaw: [s[0] || 1, 20, 16].join(','), source: 'meshOps' };
  if (k === 'cylinder') return { type: 'CylinderGeometry', argsRaw: [s[0] || 1, s[1] || s[0] || 1, s[2] || 1, 24].join(','), source: 'meshOps' };
  if (k === 'cone') return { type: 'ConeGeometry', argsRaw: [s[1] || s[0] || 1, s[2] || 1, 24].join(','), source: 'meshOps' };
  if (k === 'plane') return { type: 'PlaneGeometry', argsRaw: [s[0] || 1, s[1] || 1].join(','), source: 'meshOps' };
  if (k === 'torus') return { type: 'TorusGeometry', argsRaw: [s[0] || 1, s[1] || 0.1, 8, 48].join(','), source: 'meshOps' };
  if (k === 'icosahedron') return { type: 'IcosahedronGeometry', argsRaw: [s[0] || 1, 0].join(','), source: 'meshOps' };
  return { type: 'BoxGeometry', argsRaw: [s[0] || 1, s[1] || 1, s[2] || 1].join(','), source: 'meshOps' };
}

function collectMeshOpsAssets(html, entityStyles) {
  const found = findObjectAssignmentLiteral(html, 'meshOps');
  if (!found) return [];
  const meshOpsEntries = parseObjectLiteralEntries(found.literal);
  const assets = [];
  const compositeAssets = [];
  Object.keys(meshOpsEntries).forEach(entityName => {
    const entityStyle = entityStyles[entityName] || { name: entityName };
    const ops = splitTopLevelObjects(meshOpsEntries[entityName]);
    const childIds = [];
    ops.forEach((opLiteral, index) => {
      const op = parseObjectLiteralEntries(opLiteral);
      const opIndex = html.indexOf(opLiteral, found.index);
      const size = meshOpArray(op.size, [1, 1, 1]);
      const opacity = readNumber(op.opacity);
      const assetId = stableAssetId(entityName + '_meshop_' + (index + 1));
      const asset = {
        assetId,
        kind: 'procedural_primitive',
        ...assetLicenseFields(),
        source: {
          type: 'inline_procedural',
          variable: 'meshOps[' + JSON.stringify(entityName) + '][' + index + ']',
          entityName,
          entityKind: entityStyle.kind || null,
          line: findLine(html, opIndex >= 0 ? opIndex : found.index),
          pattern: 'meshOps',
        },
        unityImport: {
          mode: 'runtime-generate',
          supported: true,
          generator: 'GFM_Create.Obj',
        },
        geometry: meshOpGeometry(stripQuotes(op.kind), size),
        material: {
          type: 'MeshStandardMaterial',
          source: 'meshOps',
          diffuseColor: normalizeColor(op.color || entityStyle.color || '0xffffff'),
          emissiveColor: normalizeColor(op.emissive),
          opacity: opacity == null ? null : opacity,
          transparent: opacity == null ? undefined : opacity < 1,
          roughness: readNumber(op.roughness),
          metalness: readNumber(op.metalness),
        },
        transform: {
          position: meshOpArray(op.position, [0, 0, 0]),
          rotation: meshOpArray(op.rotation, [0, 0, 0]),
          scale: meshOpArray(op.scale, [1, 1, 1]),
        },
        entityBinding: { entityName, confidence: 1, evidence: 'meshOps' },
        fidelityTarget: 'geometry_color_material',
        visualFallback: null,
        unsupported: [],
      };
      assets.push(asset);
      childIds.push(assetId);
    });
    if (childIds.length) {
      const position = entityStyle.position || null;
      compositeAssets.push({
        assetId: stableAssetId(entityName + '_meshop_composite'),
        kind: 'procedural_composite',
        ...assetLicenseFields(),
        source: {
          type: 'inline_procedural',
          variable: 'meshOps[' + JSON.stringify(entityName) + ']',
          entityName,
          entityKind: entityStyle.kind || null,
          line: findLine(html, found.index),
          pattern: 'meshOps:entity-composite',
        },
        unityImport: {
          mode: 'runtime-generate',
          supported: true,
          generator: 'GFM_Create composite',
        },
        children: uniq(childIds),
        childVariables: uniq(childIds),
        transform: position ? { position: [String(position.x || 0), String(position.y || 0), String(position.z || 0)] } : {},
        entityBinding: { entityName, confidence: 1, evidence: 'meshOps' },
        fidelityTarget: 'geometry_color_material',
        visualFallback: null,
        unsupported: [],
      });
    }
  });
  return assets.concat(compositeAssets);
}

function collectBuildEntityAssets(html, geometryVars, materialVars, entityNames, entityStyles) {
  const fn = collectBuildEntityFunction(html);
  if (!fn) return [];
  const branches = collectBuildEntityBranches(fn);
  const assets = [];
  const compositeAssets = [];
  entityNames.forEach(entityName => {
    const entityStyle = entityStyles[entityName] || { name: entityName };
    const branch = branches[entityStyle.kind] || branches.__default;
    if (!branch || !branch.block) return;
    const localMeshes = collectLocalMeshDecls(branch.block);
    const childIds = [];
    let meshIndex = 0;
    collectAddCalls(branch.block).forEach(addCall => {
      const args = splitTopLevelArgs(addCall.call.slice(1, -1));
      if (!args.length) return;
      let meshExpr;
      let positionArgs = [];
      let opTransform = {};
      if (addCall.callee === 'addMesh') {
        if (addCall.receiver || args[0] !== 'g') return;
        meshExpr = String(args[2] || '').trim();
        opTransform = transformFromMeshOpLiteral(args[3]);
      } else if (addCall.receiver) {
        if (addCall.receiver !== 'g') return;
      } else if (args[0] !== 'g') {
        return;
      }
      if (!meshExpr) {
        meshExpr = String(addCall.receiver ? args[0] : (args[1] || '')).trim();
        positionArgs = addCall.receiver ? [] : args.slice(2, 5);
      }
      const inlineCall = meshCallFromExpression(meshExpr);
      const local = localMeshes[meshExpr];
      const meshCall = inlineCall || (local && local.call);
      if (!meshCall) return;
      meshIndex++;
      const sourceOffset = branch.offset + addCall.offset;
      const asset = buildEntityMeshAsset(
        entityName,
        inlineCall ? 'mesh' : meshExpr,
        sourceOffset + meshIndex,
        meshCall,
        html,
        geometryVars,
        materialVars,
        entityStyle,
        positionArgs,
        inlineCall
          ? (addCall.callee === 'addMesh' ? 'buildEntity:addMesh-inline-mesh' : (addCall.receiver ? 'buildEntity:group.add-inline-mesh' : 'buildEntity:add-inline-mesh'))
          : (addCall.callee === 'addMesh' ? 'buildEntity:addMesh-local-mesh' : (addCall.receiver ? 'buildEntity:group.add-local-mesh' : 'buildEntity:add-local-mesh')),
        Object.assign({}, opTransform, collectTrailingTransform(branch.block, addCall, meshExpr))
      );
      assets.push(asset);
      childIds.push(asset.assetId);
    });
    if (childIds.length) {
      const position = entityStyle.position || null;
      const degraded = childIds.length >= 8;
      compositeAssets.push({
        assetId: stableAssetId(entityName),
        kind: 'procedural_composite',
        ...assetLicenseFields(),
        source: {
          type: 'inline_procedural',
          variable: 'models[' + JSON.stringify(entityName) + ']',
          entityName,
          entityKind: entityStyle.kind || null,
          line: findLine(html, branch.offset),
          pattern: 'buildEntity:models[name]=g',
        },
        unityImport: {
          mode: 'runtime-generate',
          supported: true,
          generator: 'GFM_Create composite',
        },
        children: uniq(childIds),
        childVariables: uniq(childIds),
        transform: position ? { position: [String(position.x || 0), String(position.y || 0), String(position.z || 0)] } : {},
        entityBinding: { entityName, confidence: 1, evidence: 'buildEntity:models[name]=g' },
        fidelityTarget: degraded ? 'geometry_color_only' : 'geometry_color_material',
        visualFallback: degraded ? 'degraded_composite' : null,
        unsupported: [],
      });
    }
  });
  return assets.concat(compositeAssets);
}

function collectGroupAssets(html, primitiveAssets, entityNames, entityStyles) {
  const assetsByVariable = {};
  primitiveAssets.forEach(asset => {
    if (asset.source && asset.source.variable) assetsByVariable[asset.source.variable] = asset;
  });
  const groups = {};
  const groupRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.Group\s*\(\s*\)/g;
  let m;
  while ((m = groupRe.exec(html)) !== null) {
    if (curlyDepthAt(html, m.index) > 0) continue;
    groups[m[1]] = { variable: m[1], line: findLine(html, m.index), childVariables: [] };
  }
  Object.keys(groups).forEach(groupName => {
    const esc = groupName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const addRe = new RegExp('\\b' + esc + '\\.add\\s*\\(([^)]*)\\)', 'g');
    let add;
    while ((add = addRe.exec(html)) !== null) {
      groups[groupName].childVariables.push(...splitTopLevelArgs(add[1]).map(s => s.replace(/[^A-Za-z0-9_$]/g, '')).filter(Boolean));
    }
  });
  return Object.keys(groups).map(groupName => {
    const group = groups[groupName];
    const childAssetIds = uniq(group.childVariables.map(name => assetsByVariable[name] && assetsByVariable[name].assetId));
    const degraded = childAssetIds.length >= 5;
    const entityBinding = inferSemanticEntityBinding(groupName, entityNames, entityStyles) || { entityName: null, confidence: 0, evidence: 'unbound' };
    if (entityBinding.entityName) {
      group.childVariables.forEach(childName => {
        const child = assetsByVariable[childName];
        if (child && !(child.entityBinding && child.entityBinding.entityName)) {
          child.entityBinding = {
            entityName: entityBinding.entityName,
            confidence: Math.min(entityBinding.confidence || 0.75, 0.8),
            evidence: entityBinding.evidence + ':child'
          };
        }
      });
    }
    return {
      assetId: stableAssetId(groupName),
      kind: 'procedural_composite',
      ...assetLicenseFields(),
      source: { type: 'inline_procedural', variable: groupName, line: group.line },
      unityImport: {
        mode: 'runtime-generate',
        supported: true,
        generator: 'GFM_Create composite',
      },
      children: childAssetIds,
      childVariables: uniq(group.childVariables),
      entityBinding,
      fidelityTarget: degraded ? 'geometry_color_only' : 'geometry_color_material',
      visualFallback: degraded ? 'degraded_composite' : null,
      unsupported: [],
    };
  }).filter(asset => asset.children.length > 0 || asset.childVariables.length > 0);
}

function collectExternalAssets(html, entityNames, options) {
  options = options || {};
  const loaderVars = collectLoaderVars(html);
  const assets = [];
  const directRe = /\bnew\s+(?:THREE\.)?([A-Za-z0-9_]+Loader)\s*\(\s*\)\s*\.load\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = directRe.exec(html)) !== null) {
    assets.push(buildExternalAsset(m[1], m[2], m.index, html, entityNames, options));
  }
  const varRe = /\b([A-Za-z_$][\w$]*)\.load\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = varRe.exec(html)) !== null) {
    const loader = loaderVars[m[1]];
    if (!loader) continue;
    assets.push(buildExternalAsset(loader, m[2], m.index, html, entityNames, options));
  }
  const seen = new Set();
  return assets.filter(asset => {
    const key = asset.kind + ':' + asset.source.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildExternalAsset(loader, url, index, html, entityNames, options) {
  const cleanUrl = stripQuotes(url);
  const base = path.basename(cleanUrl).replace(/\.[^.]+$/, '') || loader;
  const isTexture = loader === 'TextureLoader';
  const isModel = MODEL_LOADER_KIND.test(loader);
  const metaEntry = lookupAssetMeta(options && options.assetMetaIndex, cleanUrl);
  const sourceAsset = buildSourceAssetFields(cleanUrl, metaEntry, options);
  return {
    assetId: stableAssetId(base),
    kind: isTexture ? 'texture' : isModel ? 'external_model' : 'external_asset',
    license: sourceAsset.license,
    attribution: sourceAsset.attribution,
    source: {
      type: /^data:/i.test(cleanUrl) ? 'data-uri' : 'url',
      loader,
      url: cleanUrl,
      line: findLine(html, index),
    },
    sourceAsset,
    unityImport: {
      mode: isTexture ? 'texture-import-required' : isModel ? 'external-import-required' : 'unsupported-loader',
      supported: isTexture || isModel,
    },
    entityBinding: inferEntityBinding(base, entityNames) || { entityName: null, confidence: 0, evidence: 'unbound' },
    fidelityTarget: isTexture ? 'geometry_color_material' : 'full_visual',
    visualFallback: isTexture || isModel ? null : 'theme_pool_or_primitive',
    unsupported: isTexture || isModel ? [] : ['unsupported_loader:' + loader],
  };
}

function collectUnsupported(html) {
  const out = [];
  function add(reason, re) {
    let m;
    while ((m = re.exec(html)) !== null) out.push({ reason, line: findLine(html, m.index), sample: m[0].slice(0, 120) });
  }
  add('custom_shader', /\bTHREE\.(?:RawShaderMaterial|ShaderMaterial)\b/g);
  add('custom_buffer_geometry', /\bTHREE\.BufferGeometry\b/g);
  add('runtime_procedural_animation', /\brequestAnimationFrame\s*\(/g);
  add('points_particle_system', /\bnew\s+THREE\.Points\s*\(/g);
  add('instanced_mesh', /\bnew\s+THREE\.InstancedMesh\s*\(/g);
  return out;
}

function buildEntityBindings(assets, entityNames) {
  const bindings = {};
  function emptyBinding(entity) {
    return {
      entityName: entity,
      assetIds: [],
      textureAssetIds: [],
      primaryAssetId: null,
      visualFallback: 'theme_pool_or_primitive',
      visualFallbacks: [],
      fidelityTarget: 'geometry_color_only',
    };
  }
  entityNames.forEach(entity => {
    bindings[entity] = emptyBinding(entity);
  });
  assets.forEach(asset => {
    const entity = asset.entityBinding && asset.entityBinding.entityName;
    if (!entity) return;
    if (!bindings[entity]) bindings[entity] = emptyBinding(entity);
    bindings[entity].assetIds.push(asset.assetId);
    if (asset.kind === 'texture') bindings[entity].textureAssetIds.push(asset.assetId);
    if (asset.visualFallback) bindings[entity].visualFallbacks.push(asset.visualFallback);
  });
  const byId = {};
  assets.forEach(asset => { byId[asset.assetId] = asset; });
  function priority(assetId) {
    const asset = byId[assetId] || {};
    if (asset.kind === 'external_model') return 100;
    if (asset.kind === 'procedural_composite') return 80;
    if (asset.kind === 'procedural_primitive') return 60;
    return 0;
  }
  function chooseFallback(binding) {
    if (!binding.assetIds.length) return 'theme_pool_or_primitive';
    if (!binding.primaryAssetId) return 'theme_pool_or_primitive';
    return uniq(binding.visualFallbacks)
      .sort((a, b) => (FALLBACK_RANK[b] || 50) - (FALLBACK_RANK[a] || 50) || a.localeCompare(b))[0] || null;
  }
  function chooseFidelity(binding) {
    const primary = byId[binding.primaryAssetId];
    if (primary && primary.fidelityTarget) return primary.fidelityTarget;
    return binding.assetIds
      .map(assetId => byId[assetId] && byId[assetId].fidelityTarget)
      .filter(Boolean)
      .sort((a, b) => (FIDELITY_RANK[b] || 0) - (FIDELITY_RANK[a] || 0) || a.localeCompare(b))[0] || 'geometry_color_only';
  }
  Object.keys(bindings).forEach(entity => {
    bindings[entity].assetIds = uniq(bindings[entity].assetIds);
    bindings[entity].textureAssetIds = uniq(bindings[entity].textureAssetIds);
    bindings[entity].visualFallbacks = uniq(bindings[entity].visualFallbacks);
    bindings[entity].primaryAssetId = bindings[entity].assetIds
      .slice()
      .filter(assetId => priority(assetId) > 0)
      .sort((a, b) => priority(b) - priority(a) || a.localeCompare(b))[0] || null;
    bindings[entity].visualFallback = chooseFallback(bindings[entity]);
    bindings[entity].fidelityTarget = chooseFidelity(bindings[entity]);
  });
  return bindings;
}

function summarize(html, assets, entityNames, unsupported, assetMeta) {
  const meshConstructorCount = (html.match(/\bnew\s+THREE\.Mesh\s*\(/g) || []).length;
  const bindableAssets = assets.filter(asset => /primitive|composite|external_model/.test(asset.kind));
  const boundAssets = bindableAssets.filter(asset => asset.entityBinding && asset.entityBinding.entityName);
  const entitiesWithBinding = entityNames.filter(entity => bindableAssets.some(asset => asset.entityBinding && asset.entityBinding.entityName === entity));
  const externalAssets = assets.filter(asset => asset.kind === 'external_model' || asset.kind === 'texture');
  const extractedMeshRate = meshConstructorCount
    ? Math.min(1, Number((assets.filter(asset => asset.kind === 'procedural_primitive').length / meshConstructorCount).toFixed(4)))
    : 1;
  return {
    meshConstructorCount,
    assetCount: assets.length,
    proceduralAssetCount: assets.filter(asset => /^procedural_/.test(asset.kind)).length,
    externalAssetCount: externalAssets.length,
    unsupportedCount: unsupported.length + assets.reduce((sum, asset) => sum + safeArray(asset.unsupported).length, 0),
    extractedMeshRate,
    assetBindingRate: bindableAssets.length ? Number((boundAssets.length / bindableAssets.length).toFixed(4)) : 1,
    entityBindingRate: entityNames.length ? Number((entitiesWithBinding.length / entityNames.length).toFixed(4)) : 1,
    assetMetaEntryCount: Object.keys(assetMeta && assetMeta.entries || {}).length,
    assetMetaInvalidCount: safeArray(assetMeta && assetMeta.diagnostics).length,
    assetMetaMatchedCount: externalAssets.filter(asset => asset.sourceAsset && asset.sourceAsset.metadataStatus === 'matched').length,
    sourceAssetFetchReadyCount: externalAssets.filter(asset => asset.sourceAsset && asset.sourceAsset.readyForFetch).length,
    sourceAssetLocalReadyCount: externalAssets.filter(asset => asset.sourceAsset && asset.sourceAsset.readyForImport).length,
    unknownLicenseCount: assets.filter(asset => asset.license === DEFAULT_ASSET_LICENSE).length,
  };
}

function expressionHasLoopIndex(value) {
  return /\bi\b/.test(String(value || ''));
}

function evaluateNumericExpression(value, loopIndex) {
  if (value == null) return null;
  let expr = stripQuotes(value).trim();
  if (!expr) return null;
  expr = expr.replace(/\bMath\.random\s*\(\s*\)/g, '0.5');
  if (!/^[0-9iIMathPIabs\s+\-*/%().,]+$/.test(expr)) return null;
  if (/\bMath\.(?!abs\b|PI\b)/.test(expr)) return null;
  try {
    const n = Function('i', 'Math', '"use strict"; return Number(' + expr + ');')(loopIndex || 0, Math);
    return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
  } catch (error) {
    return null;
  }
}

function numericList(values, fallback, loopIndex) {
  const list = Array.isArray(values) ? values : splitTopLevelArgs(String(values || ''));
  const out = list.map(value => evaluateNumericExpression(value, loopIndex));
  if (!out.length || out.some(value => value == null)) return fallback || [];
  return out;
}

function materialContract(material) {
  material = material || {};
  return {
    type: material.type || 'MeshStandardMaterial',
    diffuseColor: material.diffuseColor || '#FFFFFF',
    emissiveColor: material.emissiveColor || null,
    opacity: material.opacity == null ? null : material.opacity,
    transparent: material.transparent === undefined ? null : material.transparent,
    roughness: material.roughness == null ? null : material.roughness,
    metalness: material.metalness == null ? null : material.metalness,
    doubleSided: material.doubleSided === undefined ? null : material.doubleSided,
  };
}

function geometryContract(geometry, loopIndex) {
  geometry = geometry || {};
  return {
    type: geometry.type || 'UnknownGeometry',
    argsRaw: geometry.argsRaw || '',
    args: numericList(splitTopLevelArgs(geometry.argsRaw || ''), [], loopIndex),
    source: geometry.source || null,
  };
}

function transformContract(transform, loopIndex) {
  transform = transform || {};
  return {
    position: numericList(transform.position || [], [0, 0, 0], loopIndex).slice(0, 3),
    rotation: numericList(transform.rotation || [], [0, 0, 0], loopIndex).slice(0, 3),
    scale: numericList(transform.scale || [], [1, 1, 1], loopIndex).slice(0, 3),
  };
}

function primitiveNeedsLoopExpansion(asset) {
  const transform = asset && asset.transform || {};
  const geometry = asset && asset.geometry || {};
  return expressionHasLoopIndex(geometry.argsRaw)
    || safeArray(transform.position).some(expressionHasLoopIndex)
    || safeArray(transform.rotation).some(expressionHasLoopIndex)
    || safeArray(transform.scale).some(expressionHasLoopIndex);
}

function primitiveContract(asset, loopIndex) {
  return {
    assetId: asset.assetId,
    sourceVariable: asset.source && asset.source.variable || null,
    sourcePattern: asset.source && asset.source.pattern || null,
    geometry: geometryContract(asset.geometry, loopIndex),
    material: materialContract(asset.material),
    transform: transformContract(asset.transform, loopIndex),
    fidelityTarget: asset.fidelityTarget || null,
    visualFallback: asset.visualFallback || null,
  };
}

function buildEntityComposites(assets, entityBindings, entityStyles) {
  const byId = {};
  assets.forEach(asset => { byId[asset.assetId] = asset; });
  const out = {};
  Object.keys(entityBindings || {}).sort().forEach(entityName => {
    const binding = entityBindings[entityName] || {};
    const style = entityStyles[entityName] || {};
    const composite = byId[binding.primaryAssetId]
      && byId[binding.primaryAssetId].kind === 'procedural_composite'
      ? byId[binding.primaryAssetId]
      : safeArray(binding.assetIds).map(assetId => byId[assetId]).find(asset => asset && asset.kind === 'procedural_composite');
    const childIds = composite ? safeArray(composite.children) : safeArray(binding.assetIds).filter(assetId => byId[assetId] && byId[assetId].kind === 'procedural_primitive');
    const primitives = [];
    childIds.forEach(assetId => {
      const asset = byId[assetId];
      if (!asset || asset.kind !== 'procedural_primitive') return;
      if (primitiveNeedsLoopExpansion(asset)) {
        for (let i = 0; i < 5; i++) primitives.push(Object.assign(primitiveContract(asset, i), { instanceIndex: i }));
      } else {
        primitives.push(primitiveContract(asset, 0));
      }
    });
    out[entityName] = {
      entityName,
      kind: style.kind || null,
      label: style.label || entityName,
      color: style.color || null,
      position: style.position || null,
      primaryAssetId: binding.primaryAssetId || null,
      compositeAssetId: composite ? composite.assetId : null,
      compositeSource: composite && composite.source || null,
      primitiveCount: primitives.length,
      primitives,
      fidelityTarget: binding.fidelityTarget || null,
      visualFallback: binding.visualFallback || null,
    };
  });
  return out;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function contractEntityStyle(style) {
  style = objectValue(style);
  return {
    label: style.label || null,
    kind: style.kind || null,
    color: style.color || null,
    position: style.position || null,
  };
}

function addUniqueString(out, value) {
  const text = String(value || '').trim();
  if (text && out.indexOf(text) < 0) out.push(text);
}

function phaseTriggerTargets(trigger, out) {
  if (!trigger || typeof trigger !== 'object') return;
  if (trigger.type === 'compound') return safeArray(trigger.triggers).forEach(item => phaseTriggerTargets(item, out));
  addUniqueString(out, trigger.entity || trigger.target);
}

function phaseTargetAffordances(phase) {
  phase = objectValue(phase);
  const out = [];
  const seen = {};
  function add(entity, source, stepIndex, label) {
    entity = String(entity || '').trim();
    if (!entity || seen[entity]) return;
    seen[entity] = true;
    out.push({
      entity,
      source,
      stepIndex: Number.isFinite(stepIndex) ? stepIndex : null,
      label: label || null,
      input: 'joystick_proximity',
      arrivalGated: true,
      evidence: ['player_input_joystick', 'move_to_target', 'proximity_trigger'],
    });
  }
  safeArray(phase.steps).forEach((step, stepIndex) => {
    if (!step) return;
    add(step.target, 'PHASES.steps', stepIndex, step.label || null);
  });
  const hud = objectValue(phase.hudText);
  add(hud.targetEntity, 'phase.hudText.targetEntity', null, hud.targetLabel || null);
  const triggerTargets = [];
  phaseTriggerTargets(phase.trigger, triggerTargets);
  triggerTargets.forEach(entity => add(entity, 'PHASES.trigger', null, null));
  return out;
}

function expectedEvidenceForPhase(phase) {
  const out = ['guide_text_visible', 'player_input_joystick', 'move_to_target', 'proximity_trigger', 'phase_advanced'];
  safeArray(phase && phase.steps).forEach(step => {
    if (!step) return;
    if (step.gain) {
      ['resource_incremented', 'score_text_changed', 'source_hidden_or_moved'].forEach(item => addUniqueString(out, item));
    }
    if (step.spend) addUniqueString(out, 'resource_decremented');
    if (step.setEntity || step.shipLevel || step.tool) {
      ['entity_state_changed', 'visual_variant_changed', 'entity_state_equals_built'].forEach(item => addUniqueString(out, item));
    }
    if (step.damage) {
      ['target_acquire', 'projectile_emit', 'target_hp_decreased_or_target_dead', 'target_removed_or_hidden'].forEach(item => addUniqueString(out, item));
    }
    const targetText = [step.target, step.label].filter(Boolean).join(' ');
    if (/cta|download|install|button|下载|安装|按钮/i.test(targetText)) addUniqueString(out, 'cta_finish');
  });
  return out;
}

function buildVisualRuntimeContract(manifest, options) {
  manifest = objectValue(manifest);
  options = options || {};
  const entityContract = objectValue(manifest.sourceEntityContract);
  const sceneContract = objectValue(manifest.sourceSceneContract);
  const phaseContract = objectValue(manifest.sourcePhaseContract);
  const entityBindings = objectValue(manifest.entityBindings);
  const phases = safeArray(phaseContract.phases);
  const styles = objectValue(entityContract.entityStyles);
  const composites = objectValue(entityContract.entityComposites);
  const entities = safeArray(entityContract.entities).map(name => {
    const binding = objectValue(entityBindings[name]);
    return {
      name,
      style: contractEntityStyle(styles[name]),
      binding: {
        primaryAssetId: binding.primaryAssetId || null,
        assetIds: safeArray(binding.assetIds),
        fidelityTarget: binding.fidelityTarget || null,
        visualFallback: binding.visualFallback || null,
      },
      composite: composites[name] || null,
      visibleInPhases: phases.filter(phase => {
        const visible = safeArray(phase.runtimeVisibleEntities).length ? phase.runtimeVisibleEntities : phase.showEntities;
        return safeArray(visible).indexOf(name) >= 0;
      }).map(phase => phase.id),
    };
  });
  return {
    schemaVersion: VISUAL_RUNTIME_CONTRACT_VERSION,
    kind: VISUAL_RUNTIME_CONTRACT_KIND,
    generatedAt: options.generatedAt || manifest.generatedAt || new Date().toISOString(),
    source: manifest.sourceHtmlPath || manifest.source || null,
    sourceHtmlSha256: manifest.sourceHtmlSha256 || null,
    playableSceneIrHash: manifest.playableSceneIrHash || null,
    project: manifest.project || null,
    phaseDriver: {
      sourceFunction: '__driveToSourcePhase',
      webglFunction: '__driveToPhase',
      phaseCount: Number(phaseContract.phaseCount || phases.length) || phases.length,
      selectedBy: 'phaseNumber',
    },
    scene: {
      camera: sceneContract.camera || null,
      grid: sceneContract.grid || null,
      ground: sceneContract.ground || null,
      decor: sceneContract.decor || null,
      guidance: sceneContract.guidance || null,
    },
    dom: {
      hud: entityContract.domHudContract || null,
      uiOverlay: entityContract.uiOverlayContract || null,
      worldLabels: entityContract.worldLabelContract || null,
    },
    entities,
    phases: phases.map(phase => ({
      index: phase.index,
      id: phase.id,
      name: phase.name || '',
      guideText: phase.guideText || '',
      goalText: phase.goalText || '',
      showEntities: safeArray(phase.showEntities),
      runtimeVisibleEntities: safeArray(phase.runtimeVisibleEntities),
      runtimeResources: objectValue(phase.runtimeResources),
      targetSequence: safeArray(phase.targetSequence),
      targetAffordances: phaseTargetAffordances(phase),
      plannedModuleIds: safeArray(phase.plannedModuleIds),
      expectedEvidence: expectedEvidenceForPhase(phase),
      trigger: phase.trigger || null,
    })),
    summary: {
      entityCount: entities.length,
      boundEntityCount: entities.filter(entity => safeArray(entity.binding && entity.binding.assetIds).length > 0).length,
      phaseCount: phases.length,
      hasCamera: !!(sceneContract.camera && sceneContract.camera.present),
      hasDomHud: !!(entityContract.domHudContract && entityContract.domHudContract.present),
      hasGuidance: !!(sceneContract.guidance && sceneContract.guidance.present),
      phasesWithTargets: phases.filter(phase => phaseTargetAffordances(phase).length > 0).length,
    },
  };
}

function validateVisualRuntimeContract(doc, options) {
  options = options || {};
  const violations = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { passed: false, violations: [{ code: 'visual_runtime_contract_missing' }], summary: {} };
  }
  if (doc.kind !== VISUAL_RUNTIME_CONTRACT_KIND) violations.push({ code: 'visual_runtime_contract_kind_invalid', actual: doc.kind });
  if (doc.schemaVersion !== VISUAL_RUNTIME_CONTRACT_VERSION) violations.push({ code: 'visual_runtime_contract_version_invalid', actual: doc.schemaVersion });
  const phaseDriver = objectValue(doc.phaseDriver);
  if (phaseDriver.sourceFunction !== '__driveToSourcePhase') violations.push({ code: 'visual_runtime_source_phase_driver_missing', expected: '__driveToSourcePhase', actual: phaseDriver.sourceFunction || null });
  if (phaseDriver.webglFunction !== '__driveToPhase') violations.push({ code: 'visual_runtime_webgl_phase_driver_missing', expected: '__driveToPhase', actual: phaseDriver.webglFunction || null });
  const entities = safeArray(doc.entities);
  const phases = safeArray(doc.phases);
  if (!entities.length) violations.push({ code: 'visual_runtime_entities_missing' });
  if (!phases.length) violations.push({ code: 'visual_runtime_phases_missing' });
  const boundEntityCount = entities.filter(entity => safeArray(entity && entity.binding && entity.binding.assetIds).length > 0).length;
  if (options.requireEntityAssetBindings === true && entities.length && boundEntityCount <= 0) {
    violations.push({ code: 'visual_runtime_entity_bindings_missing' });
  }
  const camera = objectValue(doc.scene && doc.scene.camera);
  if (options.requireCamera !== false && !(camera.present && Array.isArray(camera.position) && Array.isArray(camera.lookAt))) {
    violations.push({ code: 'visual_runtime_camera_contract_incomplete' });
  }
  if (options.requireDomHud !== false && !(doc.dom && doc.dom.hud && doc.dom.hud.present)) {
    violations.push({ code: 'visual_runtime_dom_hud_contract_missing' });
  }
  const phasesWithoutTargets = phases
    .filter(phase => !safeArray(phase && phase.targetAffordances).length)
    .map(phase => phase && phase.id || '<unknown>');
  if (options.requirePhaseTargets !== false && phasesWithoutTargets.length) {
    violations.push({ code: 'visual_runtime_phase_targets_missing', phases: phasesWithoutTargets });
  }
  return {
    passed: violations.length === 0,
    violations,
    summary: {
      entityCount: entities.length,
      boundEntityCount,
      phaseCount: phases.length,
      phasesWithTargets: phases.length - phasesWithoutTargets.length,
      hasCamera: !!(camera && camera.present),
      hasDomHud: !!(doc.dom && doc.dom.hud && doc.dom.hud.present),
    },
  };
}

function extractVisualAssetManifest(html, options) {
  options = options || {};
  const entityStyles = parseEntityStyleMap(html);
  const sourceSceneContract = parseSceneConfig(html);
  const sourcePhaseContract = parseSourcePhaseContract(html, { entityStyles });
  const sourceEntityNames = collectEntityNamesFromHtml(html);
  const entityNames = uniq(safeArray(options.entityNames).concat(sourceEntityNames));
  const assetMeta = extractAssetMetaMap(html);
  const geometryVars = collectGeometryVars(html);
  const materialVars = collectMaterialVars(html);
  const primitiveAssets = collectMeshAssets(html, geometryVars, materialVars, entityNames);
  const entityBuilderAssets = collectBuildEntityAssets(html, geometryVars, materialVars, Object.keys(entityStyles), entityStyles);
  const meshOpsAssets = collectMeshOpsAssets(html, entityStyles);
  const allPrimitiveAssets = primitiveAssets
    .concat(entityBuilderAssets.filter(asset => asset.kind === 'procedural_primitive'))
    .concat(meshOpsAssets.filter(asset => asset.kind === 'procedural_primitive'));
  const compositeAssets = collectGroupAssets(html, allPrimitiveAssets, entityNames, entityStyles);
  const entityBuilderComposites = entityBuilderAssets.filter(asset => asset.kind === 'procedural_composite')
    .concat(meshOpsAssets.filter(asset => asset.kind === 'procedural_composite'));
  const externalAssets = collectExternalAssets(html, entityNames, {
    source: options.source,
    assetMetaIndex: assetMeta.index,
  });
  const assets = primitiveAssets.concat(entityBuilderAssets, meshOpsAssets, compositeAssets, externalAssets);
  const unsupported = collectUnsupported(html);
  const entityBindings = buildEntityBindings(assets, entityNames);
  const entityComposites = buildEntityComposites(assets, entityBindings, serializableEntityStyles(entityStyles));
  const extractionSummary = summarize(html, assets, entityNames, unsupported, assetMeta);
  const manifest = {
    visualAssetsSchemaVersion: VISUAL_ASSET_SCHEMA_VERSION,
    kind: VISUAL_ASSET_KIND,
    assetLicenseContractVersion: ASSET_LICENSE_CONTRACT_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: options.source || null,
    project: options.project || null,
    fidelityTarget: extractionSummary.unsupportedCount > 0 ? 'geometry_color_only' : 'geometry_color_material',
    assetMetadata: {
      contractVersion: assetMeta.contractVersion,
      carrier: assetMeta.carrier,
      entryCount: Object.keys(assetMeta.entries || {}).length,
      diagnostics: assetMeta.diagnostics,
    },
    sourceEntityContract: {
      styleEntityCount: Object.keys(entityStyles).length,
      sourceEntityCount: sourceEntityNames.length,
      entities: sourceEntityNames,
      entityStyles: serializableEntityStyles(entityStyles),
      entityComposites,
      domHudContract: parseSourceDomHudContract(html),
      uiOverlayContract: parseSourceUiOverlayContract(html, entityStyles),
      worldLabelContract: parseSourceWorldLabelContract(html),
    },
    sourceSceneContract,
    sourcePhaseContract,
    fidelityContract: options.fidelityContract || null,
    extractionSummary,
    assets,
    entityBindings,
    unsupported,
  };
  manifest.visualRuntimeContract = buildVisualRuntimeContract(manifest, {
    generatedAt: manifest.generatedAt,
  });
  return manifest;
}

function validateVisualAssetManifest(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('visual asset manifest must be an object');
  if (doc.visualAssetsSchemaVersion !== VISUAL_ASSET_SCHEMA_VERSION) {
    throw new Error('unsupported visual asset manifest version: ' + doc.visualAssetsSchemaVersion);
  }
  if (doc.kind !== VISUAL_ASSET_KIND) throw new Error('invalid visual asset manifest kind: ' + doc.kind);
  if (!Array.isArray(doc.assets)) throw new Error('visual asset manifest missing assets[]');
  if (!doc.extractionSummary || typeof doc.extractionSummary !== 'object') throw new Error('visual asset manifest missing extractionSummary');
  doc.assets.forEach(asset => {
    if (!asset || typeof asset !== 'object') throw new Error('visual asset manifest has invalid asset entry');
    if (typeof asset.license !== 'string' || !asset.license) throw new Error('visual asset missing license: ' + asset.assetId);
    if (!Object.prototype.hasOwnProperty.call(asset, 'attribution')) throw new Error('visual asset missing attribution: ' + asset.assetId);
    if ((asset.kind === 'external_model' || asset.kind === 'texture') && (!asset.sourceAsset || typeof asset.sourceAsset !== 'object')) {
      throw new Error('external visual asset missing sourceAsset: ' + asset.assetId);
    }
  });
  return true;
}

function validateVisualAssetReadiness(doc, options) {
  validateVisualAssetManifest(doc);
  options = options || {};
  const minExtractedMeshRate = options.minExtractedMeshRate == null ? 0.9 : Number(options.minExtractedMeshRate);
  const minAssetBindingRate = options.minAssetBindingRate == null ? 1.0 : Number(options.minAssetBindingRate);
  const minEntityBindingRate = options.minEntityBindingRate == null ? null : Number(options.minEntityBindingRate);
  const minExpectedEntityCoverageRate = options.minExpectedEntityCoverageRate == null ? null : Number(options.minExpectedEntityCoverageRate);
  const expectedEntities = uniq(options.expectedEntities || []);
  const allowUnsupported = options.allowUnsupported !== false;
  const requireExternalSourceMetadata = options.requireExternalSourceMetadata === true;
  const requireKnownExternalLicense = options.requireKnownExternalLicense === true;
  const requireFetchableExternalSource = options.requireFetchableExternalSource === true;
  const requireVisualRuntimeContract = options.requireVisualRuntimeContract === true;
  const summary = doc.extractionSummary || {};
  const violations = [];
  if ((summary.extractedMeshRate == null ? 1 : Number(summary.extractedMeshRate)) < minExtractedMeshRate) {
    violations.push({
      code: 'visual_asset_extract_rate_low',
      expected: minExtractedMeshRate,
      actual: summary.extractedMeshRate,
    });
  }
  if ((summary.assetBindingRate == null ? 1 : Number(summary.assetBindingRate)) < minAssetBindingRate) {
    violations.push({
      code: 'visual_asset_binding_rate_low',
      expected: minAssetBindingRate,
      actual: summary.assetBindingRate,
    });
  }
  if (minEntityBindingRate != null && (summary.entityBindingRate == null ? 1 : Number(summary.entityBindingRate)) < minEntityBindingRate) {
    violations.push({
      code: 'visual_entity_binding_rate_low',
      expected: minEntityBindingRate,
      actual: summary.entityBindingRate,
    });
  }
  if (expectedEntities.length && minExpectedEntityCoverageRate != null) {
    const bindings = doc.entityBindings || {};
    const covered = expectedEntities.filter(entity => {
      const binding = bindings[entity];
      return binding && Array.isArray(binding.assetIds) && binding.assetIds.length > 0;
    });
    const missing = expectedEntities.filter(entity => covered.indexOf(entity) < 0);
    const actual = Number((covered.length / expectedEntities.length).toFixed(4));
    if (actual < minExpectedEntityCoverageRate) {
      violations.push({
        code: 'visual_expected_entity_coverage_low',
        expected: minExpectedEntityCoverageRate,
        actual,
        missing,
      });
    }
  }
  if (!allowUnsupported && Number(summary.unsupportedCount || 0) > 0) {
    violations.push({
      code: 'visual_asset_unsupported_present',
      expected: 0,
      actual: summary.unsupportedCount,
    });
  }
  safeArray(doc.assets).forEach(asset => {
    if (asset.kind !== 'external_model' && asset.kind !== 'texture') return;
    const sourceAsset = asset.sourceAsset || {};
    if (requireExternalSourceMetadata && sourceAsset.metadataStatus === 'invalid') {
      violations.push({ code: 'external_asset_metadata_invalid', assetId: asset.assetId, url: asset.source && asset.source.url, metadataViolations: sourceAsset.metadataViolations || [] });
    } else if (requireExternalSourceMetadata && sourceAsset.metadataStatus !== 'matched') {
      violations.push({ code: 'external_asset_metadata_missing', assetId: asset.assetId, url: asset.source && asset.source.url });
    }
    if (requireKnownExternalLicense && asset.license === DEFAULT_ASSET_LICENSE) {
      violations.push({ code: 'external_asset_license_unknown', assetId: asset.assetId, url: asset.source && asset.source.url });
    }
    if (requireFetchableExternalSource && !sourceAsset.readyForFetch && !sourceAsset.readyForImport) {
      violations.push({ code: 'external_asset_source_not_fetchable', assetId: asset.assetId, url: asset.source && asset.source.url });
    }
  });
  if (requireVisualRuntimeContract) {
    const runtimeGate = validateVisualRuntimeContract(doc.visualRuntimeContract, options.visualRuntimeContractOptions || {});
    if (!runtimeGate.passed) {
      runtimeGate.violations.forEach(violation => violations.push(Object.assign({ source: 'visualRuntimeContract' }, violation)));
    }
  }
  return {
    passed: violations.length === 0,
    violations,
    summary,
  };
}

function writeVisualRuntimeContract(outPath, contract) {
  const result = validateVisualRuntimeContract(contract, {
    requireCamera: false,
    requireDomHud: false,
    requirePhaseTargets: false,
  });
  if (!result.passed) {
    throw new Error('invalid visual runtime contract: ' + result.violations.map(item => item.code).join(', '));
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(contract, null, 2));
  return contract;
}

function writeVisualAssetManifest(outPath, manifest) {
  validateVisualAssetManifest(manifest);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

function loadVisualAssetManifest(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validateVisualAssetManifest(doc);
  return doc;
}

function resolveManifestPathForSpec(specPath, spec) {
  const dir = specPath ? path.dirname(specPath) : process.cwd();
  const rel = spec && spec.meta && spec.meta.assetManifestPath;
  return path.join(dir, rel || 'asset-manifest.json');
}

module.exports = {
  VISUAL_ASSET_SCHEMA_VERSION,
  VISUAL_ASSET_KIND,
  VISUAL_RUNTIME_CONTRACT_VERSION,
  VISUAL_RUNTIME_CONTRACT_KIND,
  ASSET_LICENSE_CONTRACT_VERSION,
  extractVisualAssetManifest,
  extractAssetMetaMap,
  normalizeAssetUrl,
  validateVisualAssetManifest,
  buildVisualRuntimeContract,
  validateVisualRuntimeContract,
  writeVisualRuntimeContract,
  writeVisualAssetManifest,
  loadVisualAssetManifest,
  resolveManifestPathForSpec,
  validateVisualAssetReadiness,
  collectEntityNamesFromHtml,
  parseSceneConfig,
  parseSourceDomHudContract,
  parseSourcePhaseContract,
  parseSourceWorldLabelContract,
  parseGridHelperContract,
  parseSourceThreeCameraContract,
};
