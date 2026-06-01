'use strict';

const fs = require('fs');
const path = require('path');

const VISUAL_ASSET_SCHEMA_VERSION = 'va.1.0.0';
const VISUAL_ASSET_KIND = 'demo2spec.visualAssetManifest';
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

function normalizeColor(value, fallbackValue) {
  if (value == null) return null;
  let text = stripQuotes(value).trim();
  if (!text) return null;
  if (text === 'style.color' && fallbackValue != null) return normalizeColor(fallbackValue);
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
  return new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(String(html || ''));
}

function parseGuidanceVisualContract(html) {
  const source = String(html || '');
  const diagnostics = [];
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
      to: 'SpaceShip',
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

function parseSceneConfig(html) {
  const found = findObjectAssignmentLiteral(html, 'SCENE_CONFIG');
  if (!found) {
    return { present: false, carrier: 'SCENE_CONFIG', diagnostics: [{ code: 'scene_config_missing' }] };
  }
  const entries = parseObjectLiteralEntries(found.literal);
  const fogBody = entries.fog && String(entries.fog).trim() !== 'null' ? entries.fog : null;
  const groundBody = entries.ground && String(entries.ground).trim() !== 'null' ? entries.ground : null;
  const decorBody = entries.decor && String(entries.decor).trim() !== 'null' ? entries.decor : null;
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
      color: readHexColorProp(groundBody, 'color'),
      colorRgb01: colorToRgb01(readProp(groundBody, 'color')),
    } : null,
    decor: decorBody ? {
      stars: readNumericProp(decorBody, 'stars'),
      orbitalRings: readNumericProp(decorBody, 'orbitalRings'),
    } : null,
    guidance: parseGuidanceVisualContract(html),
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

function parseSourcePhaseContract(html, options) {
  options = options || {};
  const entityStyles = options.entityStyles || parseEntityStyleMap(html);
  const found = findArrayAssignmentLiteral(html, 'PHASES');
  if (!found) {
    return { present: false, carrier: 'PHASES', phases: [], diagnostics: [{ code: 'phases_missing' }] };
  }
  const phaseLiterals = splitTopLevelObjects(found.literal);
  const phaseCount = phaseLiterals.length;
  const phases = phaseLiterals.map((phaseLiteral, index) => {
    const entries = parseObjectLiteralEntries(phaseLiteral);
    const phase = {
      index,
      id: stripQuotes(entries.id || ('phase' + (index + 1))),
      name: stripQuotes(entries.name || ''),
      guideText: stripQuotes(entries.guideText || ''),
      goalText: stripQuotes(entries.goalText || ''),
      showEntities: parseStringArrayLiteral(entries.showEntities),
      steps: parsePhaseSteps(entries.steps),
    };
    phase.hudText = buildPhaseHudText(phase, index, phaseCount, entityStyles);
    return phase;
  });
  return {
    present: true,
    carrier: 'PHASES',
    phaseCount: phases.length,
    phases,
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
      diffuseColor: normalizeColor(rawColor),
      emissiveColor: null,
      opacity: null,
      roughness: readNumber(args[1]) == null ? 0.55 : readNumber(args[1]),
      metalness: readNumber(args[2]) == null ? 0.08 : readNumber(args[2]),
    };
  }
  const ctor = text.match(/new\s+THREE\.([A-Za-z0-9_]+Material)\s*\(/);
  if (ctor) {
    const callStart = text.indexOf('(', ctor.index);
    const call = sliceBalanced(text, callStart, '(', ')') || '()';
    const args = splitTopLevelArgs(call.slice(1, -1));
    const options = args.find(arg => /^\{/.test(arg)) || '{}';
    return materialFromOptions(ctor[1], options, 'inline');
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

function materialFromOptions(type, optionsBody, source) {
  const body = String(optionsBody || '').replace(/^\{|\}$/g, '');
  const transparent = readBool(readProp(body, 'transparent'));
  return {
    type,
    source,
    diffuseColor: normalizeColor(readProp(body, 'color')),
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
  const branchRe = /(?:^|[\s;}]|else\s+)if\s*\(\s*style\.kind\s*===\s*['"`]([^'"`]+)['"`]\s*\)\s*\{/g;
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
  let cursor = 0;
  while (cursor < block.length) {
    const idx = block.indexOf('add(', cursor);
    if (idx < 0) break;
    const open = block.indexOf('(', idx);
    const call = sliceBalanced(block, open, '(', ')');
    if (!call) {
      cursor = idx + 4;
      continue;
    }
    calls.push({ call, offset: idx });
    cursor = open + call.length;
  }
  return calls;
}

function collectTrailingTransform(block, addCall, meshExpr) {
  const out = {};
  const end = addCall.offset + 3 + addCall.call.length;
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
      if (!args.length || args[0] !== 'g') return;
      const meshExpr = String(args[1] || '').trim();
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
        args.slice(2, 5),
        inlineCall ? 'buildEntity:add-inline-mesh' : 'buildEntity:add-local-mesh',
        collectTrailingTransform(branch.block, addCall, meshExpr)
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

function collectGroupAssets(html, primitiveAssets, entityNames) {
  const assetsByVariable = {};
  primitiveAssets.forEach(asset => {
    if (asset.source && asset.source.variable) assetsByVariable[asset.source.variable] = asset;
  });
  const groups = {};
  const groupRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+THREE\.Group\s*\(\s*\)/g;
  let m;
  while ((m = groupRe.exec(html)) !== null) {
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
      entityBinding: inferEntityBinding(groupName, entityNames) || { entityName: null, confidence: 0, evidence: 'unbound' },
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
  const allPrimitiveAssets = primitiveAssets.concat(entityBuilderAssets.filter(asset => asset.kind === 'procedural_primitive'));
  const compositeAssets = collectGroupAssets(html, allPrimitiveAssets, entityNames);
  const entityBuilderComposites = entityBuilderAssets.filter(asset => asset.kind === 'procedural_composite');
  const externalAssets = collectExternalAssets(html, entityNames, {
    source: options.source,
    assetMetaIndex: assetMeta.index,
  });
  const assets = primitiveAssets.concat(entityBuilderAssets, compositeAssets, externalAssets);
  const unsupported = collectUnsupported(html);
  const entityBindings = buildEntityBindings(assets, entityNames);
  const entityComposites = buildEntityComposites(assets, entityBindings, serializableEntityStyles(entityStyles));
  const extractionSummary = summarize(html, assets, entityNames, unsupported, assetMeta);
  return {
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
      uiOverlayContract: parseSourceUiOverlayContract(html, entityStyles),
    },
    sourceSceneContract,
    sourcePhaseContract,
    fidelityContract: options.fidelityContract || null,
    extractionSummary,
    assets,
    entityBindings,
    unsupported,
  };
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
  return {
    passed: violations.length === 0,
    violations,
    summary,
  };
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
  ASSET_LICENSE_CONTRACT_VERSION,
  extractVisualAssetManifest,
  extractAssetMetaMap,
  normalizeAssetUrl,
  validateVisualAssetManifest,
  writeVisualAssetManifest,
  loadVisualAssetManifest,
  resolveManifestPathForSpec,
  validateVisualAssetReadiness,
  collectEntityNamesFromHtml,
  parseSceneConfig,
};
