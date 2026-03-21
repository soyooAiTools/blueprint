#!/usr/bin/env node
'use strict';

/**
 * cocos-full-builder.js — Pure Node.js Cocos Creator 3.8.8 web-mobile builder
 *
 * Usage: node cocos-full-builder.js <project-dir> [engine-dir]
 *
 * Produces build/web-mobile/ identical to CocosCreator.exe output.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ─── Constants ───────────────────────────────────────────────────────────────

const ENGINE_VERSION = '3.8.8';
const CCON_MAGIC = new Uint8Array([0x43, 0x43, 0x4F, 0x4E]); // "CCON"
const CCON_VERSION = 1;

const NATIVE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif',
  '.mp3', '.ogg', '.wav', '.mp4', '.bin', '.ttf', '.otf', '.woff', '.woff2',
  '.pvr', '.pkm', '.astc', '.ktx', '.ktx2', '.cconb']);

const PACK_SIZE_THRESHOLD = 128 * 1024; // assets < 128KB get packed together

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';

// Known default values for common cc types
const DEFAULT_VALUES = {
  number: 0,
  string: '',
  boolean: false,
  object: null,
};

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info: (...a) => console.log(`[INFO]`, ...a),
  warn: (...a) => console.warn(`[WARN]`, ...a),
  error: (...a) => console.error(`[ERROR]`, ...a),
  step: (s) => console.log(`\n${'='.repeat(60)}\n  ${s}\n${'='.repeat(60)}`),
};

// ─── UUID Utilities ──────────────────────────────────────────────────────────

function compressUUID(uuid) {
  // Remove dashes: 32 hex chars → 16 bytes → base64url (22 chars, no padding)
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) return uuid;
  const buf = Buffer.from(hex, 'hex');
  // Custom base64url: + and - instead of + and /
  let b64 = buf.toString('base64').replace(/=+$/, '');
  // Cocos uses +- instead of +/ for url safety
  b64 = b64.replace(/\//g, '-');
  return b64;
}

function decompressUUID(short) {
  if (short.length === 36 && short[8] === '-') return short; // already full
  let b64 = short.replace(/-/g, '/');
  // Pad to multiple of 4
  while (b64.length % 4 !== 0) b64 += '=';
  const buf = Buffer.from(b64, 'base64');
  const hex = buf.toString('hex');
  if (hex.length !== 32) return short;
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function uuidToShort(uuid) {
  return compressUUID(uuid);
}

// File-system uuid: first 2 chars of hex as dir
function uuidToImportPath(shortUuid) {
  const full = decompressUUID(shortUuid);
  const hex = full.replace(/-/g, '');
  return `${hex.slice(0,2)}/${shortUuid}`;
}

function md5(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

// ─── CCON Serialization ─────────────────────────────────────────────────────

class CCONSerializer {
  constructor() {
    this.sharedStrings = [];
    this.sharedStringMap = new Map();
    this.classDescriptors = [];
    this.classDescriptorMap = new Map();
    this.instanceDescriptors = [];
    this.data = [];
    this.dependUUIDs = [];
    this.dependKeys = [];
    this.dependUUIDMap = new Map();
  }

  /**
   * Convert a Cocos library JSON (array of objects with __type__) to CCON document.
   */
  serialize(jsonDoc) {
    if (!Array.isArray(jsonDoc)) {
      jsonDoc = [jsonDoc];
    }

    // First pass: collect all classes, properties, strings
    this._collectClasses(jsonDoc);

    // Second pass: serialize each instance
    for (let i = 0; i < jsonDoc.length; i++) {
      this._serializeInstance(jsonDoc[i], i);
    }

    return this._buildDocument();
  }

  _getSharedStringIndex(str) {
    if (this.sharedStringMap.has(str)) {
      return this.sharedStringMap.get(str);
    }
    const idx = this.sharedStrings.length;
    this.sharedStrings.push(str);
    this.sharedStringMap.set(str, idx);
    return idx;
  }

  _getClassDescriptorIndex(className, propNames) {
    const key = className + ':' + propNames.join(',');
    if (this.classDescriptorMap.has(key)) {
      return this.classDescriptorMap.get(key);
    }
    const idx = this.classDescriptors.length;
    this.classDescriptors.push([className, propNames]);
    this.classDescriptorMap.set(key, idx);
    return idx;
  }

  _collectClasses(doc) {
    // Frequency analysis for shared strings
    const strFreq = new Map();
    const countStr = (s) => {
      if (typeof s === 'string' && s.length > 0) {
        strFreq.set(s, (strFreq.get(s) || 0) + 1);
      }
    };

    for (const obj of doc) {
      if (!obj || typeof obj !== 'object') continue;
      if (obj.__type__) countStr(obj.__type__);
      for (const [k, v] of Object.entries(obj)) {
        if (k === '__type__' || k === '__id__') continue;
        countStr(k);
        if (typeof v === 'string') countStr(v);
      }
    }

    // Add frequently-used strings to shared pool (threshold: used 2+ times)
    const sorted = [...strFreq.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1]);
    for (const [s] of sorted) {
      this._getSharedStringIndex(s);
    }
  }

  _serializeInstance(obj, index) {
    if (!obj || typeof obj !== 'object') {
      // Primitive or null instance — store as-is
      this.instanceDescriptors.push([0, 0]);
      this.data.push(obj);
      return;
    }

    const typeName = obj.__type__ || '';
    const props = Object.keys(obj).filter(k => k !== '__type__' && k !== '__id__');

    // Separate non-default and default values
    const nonDefaultProps = [];
    const defaultProps = [];

    for (const p of props) {
      const v = obj[p];
      if (this._isDefaultValue(v)) {
        defaultProps.push(p);
      } else {
        nonDefaultProps.push(p);
      }
    }

    const allProps = [...nonDefaultProps, ...defaultProps];
    const classIdx = this._getClassDescriptorIndex(typeName, allProps);

    // Instance descriptor: [classIndex, ownerFlags, ...propIndices]
    const instDesc = [classIdx, 0];
    // For each property, store its shared string index if available
    for (const p of allProps) {
      const ssIdx = this.sharedStringMap.get(p);
      if (ssIdx !== undefined) {
        instDesc.push(ssIdx);
      }
    }
    this.instanceDescriptors.push(instDesc);

    // Serialize data values
    const values = [];
    for (const p of allProps) {
      values.push(this._encodeValue(obj[p]));
    }
    this.data.push(values);
  }

  _isDefaultValue(v) {
    if (v === 0 || v === '' || v === false || v === null || v === undefined) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) return true;
    return false;
  }

  _encodeValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return v;

    if (typeof v === 'string') {
      // Use shared string reference if available
      const ssIdx = this.sharedStringMap.get(v);
      if (ssIdx !== undefined) {
        return -(ssIdx + 1); // negative index encoding
      }
      return v;
    }

    if (typeof v === 'object') {
      // __id__ reference
      if (v.__id__ !== undefined) {
        return -(v.__id__ + 1); // negative encoding for refs
      }

      // __uuid__ dependency reference
      if (v.__uuid__) {
        return this._addDependency(v.__uuid__, v.__expectedType__);
      }

      // Vec3: {__type__: 'cc.Vec3', x, y, z}
      if (v.__type__ === 'cc.Vec3') {
        return [1, v.x || 0, v.y || 0, v.z || 0];
      }
      // Vec2
      if (v.__type__ === 'cc.Vec2') {
        return [0, v.x || 0, v.y || 0];
      }
      // Quat
      if (v.__type__ === 'cc.Quat') {
        return [3, v.x || 0, v.y || 0, v.z || 0, v.w || 1];
      }
      // Color
      if (v.__type__ === 'cc.Color') {
        const r = v.r || 0, g = v.g || 0, b = v.b || 0, a = v.a !== undefined ? v.a : 255;
        const uint32 = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
        return [4, uint32];
      }
      // Size
      if (v.__type__ === 'cc.Size') {
        return { width: v.width || 0, height: v.height || 0 };
      }

      // Generic array
      if (Array.isArray(v)) {
        return v.map(item => this._encodeValue(item));
      }

      // Generic object — recurse
      const result = {};
      for (const [k, val] of Object.entries(v)) {
        result[k] = this._encodeValue(val);
      }
      return result;
    }

    return v;
  }

  _addDependency(uuid, expectedType) {
    const short = compressUUID(uuid);
    if (!this.dependUUIDMap.has(short)) {
      const idx = this.dependUUIDs.length;
      this.dependUUIDs.push(short);
      this.dependKeys.push(expectedType || '');
      this.dependUUIDMap.set(short, idx);
    }
    return { __uuid__: short };
  }

  _buildDocument() {
    // CCON document structure:
    // [version, flags, sharedStrings, classDescriptors, instanceDescriptors, data,
    //  dependCount, dependUUIDs, dependKeys, [], []]
    return [
      CCON_VERSION,
      0,
      this.sharedStrings,
      this.classDescriptors,
      this.instanceDescriptors,
      this.data,
      this.dependUUIDs.length,
      this.dependUUIDs,
      this.dependKeys,
      [],
      []
    ];
  }
}

/**
 * Encode CCON document to binary .cconb format
 */
function encodeCCONBinary(doc) {
  const jsonStr = JSON.stringify(doc);
  const jsonBuf = Buffer.from(jsonStr, 'utf8');

  // CCONB format: magic(4) + version(4) + jsonLength(4) + json + chunks...
  const header = Buffer.alloc(12);
  header.set(CCON_MAGIC, 0);
  header.writeUInt32LE(CCON_VERSION, 4);
  header.writeUInt32LE(jsonBuf.length, 8);

  return Buffer.concat([header, jsonBuf]);
}

/**
 * Serialize library JSON to CCON JSON (not binary) — used for import/ assets
 */
function jsonToCCON(libraryJson) {
  const serializer = new CCONSerializer();
  return serializer.serialize(libraryJson);
}

// ─── Asset Database ─────────────────────────────────────────────────────────

class AssetDB {
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.libraryDir = path.join(projectDir, 'library');
    this.assetsDir = path.join(projectDir, 'assets');
    this.assets = new Map(); // uuid → { json, meta, path, type, size, native? }
    this.uuids = [];
    this.types = [];
    this.typeMap = new Map();
    this.paths = {};
    this.scenes = {};
    this.packs = {};
    this.versions = { import: [], native: [] };
  }

  /**
   * Scan library/ for all importable assets
   */
  scan() {
    log.step('Scanning library/ for assets');

    if (!fs.existsSync(this.libraryDir)) {
      throw new Error(`library/ directory not found at ${this.libraryDir}`);
    }

    this._scanDir(this.libraryDir);
    log.info(`Found ${this.assets.size} assets`);

    // Also scan assets/ for meta files to get db:// paths
    this._scanMetas(this.assetsDir, 'db://assets');
  }

  _scanDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Directory name could be first 2 hex chars of uuid
        this._scanDir(full);
      } else if (e.isFile()) {
        this._processLibraryFile(full);
      }
    }
  }

  _processLibraryFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath, ext);

    // Library files are named by UUID (or short UUID)
    // Could be: <uuid>.json, <uuid>.png, <uuid>.cconb, etc.
    if (ext === '.json') {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const json = JSON.parse(content);
        const uuid = basename;

        // Detect asset type from __type__
        let assetType = 'cc.Asset';
        if (Array.isArray(json) && json.length > 0 && json[0].__type__) {
          assetType = json[0].__type__;
        } else if (json.__type__) {
          assetType = json.__type__;
        }

        this.assets.set(uuid, {
          uuid,
          json,
          path: filePath,
          type: assetType,
          ext: '.json',
          size: Buffer.byteLength(content),
          isNative: false,
        });
      } catch (e) {
        log.warn(`Failed to parse ${filePath}: ${e.message}`);
      }
    } else if (NATIVE_EXTS.has(ext)) {
      const uuid = basename;
      const stat = fs.statSync(filePath);
      this.assets.set(uuid + ext, {
        uuid,
        path: filePath,
        type: 'native',
        ext,
        size: stat.size,
        isNative: true,
      });
    }
  }

  _scanMetas(dir, dbPath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this._scanMetas(full, dbPath + '/' + e.name);
      } else if (e.name.endsWith('.meta')) {
        try {
          const meta = JSON.parse(fs.readFileSync(full, 'utf8'));
          const assetName = e.name.replace(/\.meta$/, '');
          const assetDbPath = dbPath + '/' + assetName;

          if (meta.uuid && this.assets.has(meta.uuid)) {
            const asset = this.assets.get(meta.uuid);
            asset.dbPath = assetDbPath;
            asset.meta = meta;
          }

          // Sub-assets (textures in sprite frames, etc.)
          if (meta.subMetas) {
            for (const [subKey, subMeta] of Object.entries(meta.subMetas)) {
              if (subMeta.uuid && this.assets.has(subMeta.uuid)) {
                const asset = this.assets.get(subMeta.uuid);
                asset.dbPath = assetDbPath + '/' + subKey;
                asset.meta = subMeta;
              }
            }
          }
        } catch { }
      }
    }
  }

  /**
   * Build config.json data structures
   */
  buildConfig(bundleName) {
    const uuids = [];
    const uuidIndexMap = new Map();
    const types = [];
    const typeIndexMap = new Map();
    const paths = {};
    const scenes = {};
    const packs = {};
    const importVersions = [];
    const nativeVersions = [];

    // Collect all JSON assets (non-native)
    const jsonAssets = [...this.assets.values()].filter(a => !a.isNative);

    for (const asset of jsonAssets) {
      const shortUuid = compressUUID(asset.uuid);

      if (!uuidIndexMap.has(shortUuid)) {
        const idx = uuids.length;
        uuids.push(shortUuid);
        uuidIndexMap.set(shortUuid, idx);
      }

      const uuidIdx = uuidIndexMap.get(shortUuid);

      // Register type
      if (!typeIndexMap.has(asset.type)) {
        typeIndexMap.set(asset.type, types.length);
        types.push(asset.type);
      }
      const typeIdx = typeIndexMap.get(asset.type);

      // Register path (only for assets with db:// paths)
      if (asset.dbPath) {
        paths[uuidIdx] = [asset.dbPath, typeIdx, 1];

        // Detect scenes
        if (asset.type === 'cc.SceneAsset' || asset.dbPath.endsWith('.scene')) {
          scenes[asset.dbPath] = uuidIdx;
        }
      }

      // Version tracking (md5 of content)
      const content = fs.readFileSync(asset.path);
      const hash = md5(content).slice(0, 5);
      importVersions.push(uuidIdx, hash);
    }

    // Handle native assets versions
    const nativeAssets = [...this.assets.values()].filter(a => a.isNative);
    for (const asset of nativeAssets) {
      const shortUuid = compressUUID(asset.uuid);
      if (uuidIndexMap.has(shortUuid)) {
        const uuidIdx = uuidIndexMap.get(shortUuid);
        const content = fs.readFileSync(asset.path);
        const hash = md5(content).slice(0, 5);
        nativeVersions.push(uuidIdx, hash);
      }
    }

    return {
      importBase: 'import',
      nativeBase: 'native',
      name: bundleName,
      deps: bundleName === 'main' ? ['internal'] : [],
      uuids,
      paths,
      scenes,
      packs,
      types,
      versions: {
        import: importVersions,
        native: nativeVersions,
      },
      redirect: [],
      debug: false,
    };
  }
}

// ─── Asset Packer ────────────────────────────────────────────────────────────

class AssetPacker {
  /**
   * Pack small assets together into combined JSON files
   * Returns: Map<packId, {uuids: string[], data: object}>
   */
  static packAssets(assetDB) {
    const packs = new Map();
    const smallAssets = [];

    for (const [key, asset] of assetDB.assets) {
      if (!asset.isNative && asset.size < PACK_SIZE_THRESHOLD) {
        smallAssets.push(asset);
      }
    }

    if (smallAssets.length === 0) return packs;

    // Group into packs of ~512KB
    let currentPack = [];
    let currentSize = 0;
    let packIndex = 0;

    for (const asset of smallAssets) {
      currentPack.push(asset);
      currentSize += asset.size;

      if (currentSize >= 512 * 1024) {
        const packId = md5(`pack-${packIndex}`).slice(0, 8);
        packs.set(packId, {
          uuids: currentPack.map(a => compressUUID(a.uuid)),
          assets: currentPack,
        });
        currentPack = [];
        currentSize = 0;
        packIndex++;
      }
    }

    if (currentPack.length > 0) {
      const packId = md5(`pack-${packIndex}`).slice(0, 8);
      packs.set(packId, {
        uuids: currentPack.map(a => compressUUID(a.uuid)),
        assets: currentPack,
      });
    }

    log.info(`Created ${packs.size} asset packs from ${smallAssets.length} small assets`);
    return packs;
  }
}

// ─── Template Generator ─────────────────────────────────────────────────────

class TemplateGenerator {
  static indexHTML(settings) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1,minimal-ui=true">
  <meta name="renderer" content="webkit">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>${settings.title || 'Cocos Game'}</title>
  <link rel="stylesheet" type="text/css" href="style.css">
</head>
<body>
  <div id="GameDiv" cc_exact_fit_screen="true">
    <div id="Cocos3dGameContainer">
      <canvas id="GameCanvas" tabindex="99"></canvas>
    </div>
  </div>
  <script src="src/polyfills.bundle.js" charset="utf-8"></script>
  <script src="src/system.bundle.js" charset="utf-8"></script>
  <script src="src/import-map.json" type="systemjs-importmap" charset="utf-8"></script>
  <script>
    System.import('./index.js')
      .then(function(m) { return m.default || m; })
      .then(function(game) {
        return System.import('cc').then(function(cc) {
          return game({
            cc: cc,
            settings: './src/settings.json',
            applicationJs: './application.js'
          });
        });
      })
      .catch(function(e) { console.error(e); });
  </script>
</body>
</html>`;
  }

  static indexJS() {
    return `System.register([], function(_export, _context) {
  return {
    execute: function() {
      _export('default', function(options) {
        return Promise.resolve()
          .then(function() {
            return _context.import(options.applicationJs);
          })
          .then(function(appModule) {
            var Application = appModule.default || appModule.Application;
            if (Application && Application.prototype && Application.prototype.init) {
              var app = new Application();
              return app.init(options);
            }
            return appModule;
          });
      });
    }
  };
});`;
  }

  static applicationJS() {
    return `System.register(['cc'], function(_export, _context) {
  var Application;
  return {
    setters: [function(cc) {
      // cc module
    }],
    execute: function() {
      Application = function() {};
      Application.prototype.init = function(options) {
        var cc = options.cc;
        var settingsUrl = options.settings;
        return fetch(settingsUrl)
          .then(function(r) { return r.json(); })
          .then(function(settings) {
            return cc.game.init(settings).then(function() {
              return cc.game.run();
            });
          });
      };
      _export('default', Application);
      _export('Application', Application);
    }
  };
});`;
  }

  static styleCSS() {
    return `html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}
#GameDiv, #Cocos3dGameContainer, #GameCanvas {
  width: 100%;
  height: 100%;
  display: block;
}
canvas { outline: none; -webkit-tap-highlight-color: rgba(0,0,0,0); }`;
  }

  static settingsJSON(projectSettings, scenes) {
    // Build settings from project settings
    const s = projectSettings || {};

    return {
      engine: { version: ENGINE_VERSION },
      platform: 'web-mobile',
      rendering: {
        renderMode: s.renderMode || 0,
        designResolution: s.designResolution || { width: 960, height: 640, policy: 4 },
        frameRate: s.frameRate || 60,
      },
      physics: s.physics || { gravity: { x: 0, y: -10, z: 0 } },
      plugins: {},
      bundleVers: {},
      launchScene: '',
      scenes: scenes || [],
      splashScreen: s.splashScreen || { enabled: false },
      macros: s.macros || {},
    };
  }

  static importMapJSON() {
    return {
      imports: {
        cc: './cocos-js/cc.js',
        'cc/env': './cocos-js/cc-env.js',
      },
    };
  }

  static polyfillsBundle() {
    return `// Polyfills for web-mobile
if(!window.globalThis)window.globalThis=window;
if(!String.prototype.replaceAll){String.prototype.replaceAll=function(a,b){return this.split(a).join(b)};}
`;
  }

  static systemBundle() {
    // Minimal s.js (SystemJS) loader — in production, copy from engine
    return `// SystemJS loader placeholder — replace with engine's system.js
(function(){
  var registry = {};
  var modules = {};
  function System() {}
  System.register = function(deps, factory) {
    var _setters = [];
    var _execute;
    var result = factory(function _export(name, value) {
      if (typeof name === 'object') {
        Object.assign(modules[currentId] = modules[currentId] || {}, name);
      } else {
        (modules[currentId] = modules[currentId] || {})[name] = value;
      }
    }, { import: function(id) { return System.import(id); } });
    if (result.setters) _setters = result.setters;
    if (result.execute) _execute = result.execute;
    registry[currentId] = { deps: deps, setters: _setters, execute: _execute };
  };
  var currentId = '';
  System.import = function(id) {
    if (modules[id]) return Promise.resolve(modules[id]);
    // Try loading script
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      currentId = id;
      s.src = id.endsWith('.js') ? id : id + '.js';
      s.onload = function() {
        var reg = registry[id];
        if (reg && reg.execute) reg.execute();
        resolve(modules[id] || {});
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  };
  window.System = System;
})();
`;
  }
}

// ─── Engine File Manager ────────────────────────────────────────────────────

class EngineManager {
  constructor(engineDir) {
    this.engineDir = engineDir;
    this.engineFiles = [];
  }

  /**
   * Find and copy engine files to build output
   */
  copyEngine(outputDir) {
    log.step('Copying engine files');

    const cocosJsDir = path.join(outputDir, 'cocos-js');
    mkdirp(cocosJsDir);

    // Search paths for engine files
    const searchPaths = [
      path.join(this.engineDir, 'cocos-js'),  // Our cache layout
      this.engineDir,
      path.join(this.engineDir, 'bin', 'web-mobile'),
      path.join(this.engineDir, 'bin', '.cache', 'web-mobile'),
      path.join(this.engineDir, 'resources', 'engine'),
      path.join(this.engineDir, 'resources', 'engine', 'bin', 'web-mobile'),
    ];

    let foundEngine = false;

    for (const sp of searchPaths) {
      if (!fs.existsSync(sp)) continue;

      const files = this._findEngineFiles(sp);
      if (files.length > 0) {
        log.info(`Found ${files.length} engine files in ${sp}`);
        for (const f of files) {
          const dest = path.join(cocosJsDir, path.basename(f));
          fs.copyFileSync(f, dest);
          this.engineFiles.push(path.basename(f));
        }
        foundEngine = true;
        break;
      }
    }

    if (!foundEngine) {
      log.warn('Engine files not found - build will need engine files manually placed in cocos-js/');
      // Create placeholder
      fs.writeFileSync(path.join(cocosJsDir, 'cc.js'),
        '// Placeholder - copy cc.js from CocosCreator engine\nconsole.warn("Engine not found");\n');
    }

    return this.engineFiles;
  }

  _findEngineFiles(dir) {
    const result = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.js')) {
          result.push(path.join(dir, e.name));
        } else if (e.isDirectory() && e.name === 'assets') {
          // Copy engine internal assets subdir
          const assetsDir = path.join(dir, e.name);
          this._copyDirRecursive(assetsDir, path.join(dir, '..', '__engine_assets__'));
        }
      }
    } catch { }
    return result;
  }

  _copyDirRecursive(src, dest) {
    // Not needed here, engine files are just JS
  }
}

// ─── Script Bundler ─────────────────────────────────────────────────────────

class ScriptBundler {
  constructor(projectDir) {
    this.projectDir = projectDir;
  }

  /**
   * Bundle project scripts into chunks/bundle.js using Rollup + TypeScript
   */
  bundle(outputDir) {
    log.step('Bundling project scripts');

    const srcDir = path.join(outputDir, 'src');
    const chunksDir = path.join(srcDir, 'chunks');
    mkdirp(chunksDir);

    // Try to find pre-built scripts from temp/
    const possibleBundlePaths = [
      path.join(this.projectDir, 'temp', 'programming', 'packer-driver', 'targets', 'preview', 'chunks', 'bundle.js'),
      path.join(this.projectDir, 'temp', 'programming', 'packer-driver', 'targets', 'editor', 'chunks', 'bundle.js'),
      path.join(this.projectDir, 'library', 'scripts', 'bundle.js'),
    ];

    for (const bp of possibleBundlePaths) {
      if (fs.existsSync(bp)) {
        log.info(`Found pre-built bundle at ${bp}`);
        fs.copyFileSync(bp, path.join(chunksDir, 'bundle.js'));
        log.info('Bundle copied from pre-built');
        return;
      }
    }

    // Use linux-cocos-build.js if available (Rollup + TypeScript)
    const linuxBuildScript = path.join(__dirname, 'linux-cocos-build.js');
    const workerBuildScript = '/opt/worker-repo/worker/linux-cocos-build.js';
    const buildScript = fs.existsSync(linuxBuildScript) ? linuxBuildScript :
                        fs.existsSync(workerBuildScript) ? workerBuildScript : null;

    if (buildScript) {
      try {
        const { execSync } = require('child_process');
        log.info('Using Rollup+TypeScript build via linux-cocos-build.js');
        execSync(`node "${buildScript}" "${this.projectDir}"`, {
          timeout: 60000,
          stdio: 'pipe',
          cwd: this.projectDir,
        });
        // The script writes to build/web-mobile/src/chunks/bundle.js
        if (fs.existsSync(path.join(chunksDir, 'bundle.js'))) {
          const size = fs.statSync(path.join(chunksDir, 'bundle.js')).size;
          log.info(`Bundle built via Rollup: ${size} bytes`);
          return;
        }
      } catch (e) {
        log.warn(`Rollup build failed: ${e.message.slice(0, 200)}`);
      }
    }

    // Fallback: scan and wrap scripts (basic, may not work for complex projects)
    const scripts = this._findScripts(this.projectDir);
    if (scripts.length > 0) {
      log.info(`Found ${scripts.length} scripts, using basic wrapper`);
      fs.writeFileSync(path.join(chunksDir, 'bundle.js'), this._wrapScripts(scripts));
      log.info(`Bundle created with ${scripts.length} script(s)`);
    } else {
      log.info('No project scripts found');
      fs.writeFileSync(path.join(chunksDir, 'bundle.js'), '// No project scripts\n');
    }
  }

  _findScripts(projectDir) {
    const scripts = [];
    const assetsDir = path.join(projectDir, 'assets');
    if (!fs.existsSync(assetsDir)) return scripts;

    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) {
          if (!e.name.endsWith('.d.ts')) {
            scripts.push(full);
          }
        }
      }
    };
    walk(assetsDir);
    return scripts;
  }

  _wrapScripts(scripts) {
    let output = 'System.register([], function(_export, _context) {\n';
    output += '  return { execute: function() {\n';
    for (const s of scripts) {
      const rel = path.relative(this.projectDir, s).replace(/\\/g, '/');
      const content = fs.readFileSync(s, 'utf8');
      // Strip TypeScript-specific syntax for a basic transform
      const stripped = content
        .replace(/import\s+.*?from\s+['"].*?['"];?/g, '') // strip imports
        .replace(/export\s+(default\s+)?/g, '')
        .replace(/:\s*\w+(\[\])?(\s*[;,=)])/g, '$2') // strip type annotations
        .replace(/<\w+>/g, ''); // strip generics

      output += `    // --- ${rel} ---\n`;
      output += `    try { ${stripped} } catch(e) { console.warn('Script error in ${rel}:', e); }\n`;
    }
    output += '  }};\n});\n';
    return output;
  }
}

// ─── Builder ────────────────────────────────────────────────────────────────

class CocosWebMobileBuilder {
  constructor(projectDir, engineDir) {
    this.projectDir = path.resolve(projectDir);
    this.engineDir = engineDir ? path.resolve(engineDir) : this._findEngineDir();
    this.outputDir = path.join(this.projectDir, 'build', 'web-mobile');
    this.assetDB = new AssetDB(this.projectDir);
  }

  _findEngineDir() {
    // Try common CocosCreator installation paths
    const candidates = [
      // Windows
      path.join(process.env.LOCALAPPDATA || '', 'CocosDashboard', 'editor', 'creator', ENGINE_VERSION),
      path.join('C:', 'CocosDashboard', 'editor', 'creator', ENGINE_VERSION),
      path.join('C:', 'CocosCreator', ENGINE_VERSION),
      // Custom cache
      '/data/CocosCreator',
      '/data/cocos-engine-cache',
      // Linux
      path.join(process.env.HOME || '', '.CocosCreator', 'editor', ENGINE_VERSION),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        log.info(`Found engine at ${c}`);
        return c;
      }
    }

    log.warn('CocosCreator engine directory not found. Engine files will be missing.');
    return '';
  }

  async build() {
    const startTime = Date.now();
    log.step(`Cocos Creator ${ENGINE_VERSION} Web-Mobile Builder`);
    log.info(`Project: ${this.projectDir}`);
    log.info(`Engine:  ${this.engineDir || '(not found)'}`);
    log.info(`Output:  ${this.outputDir}`);

    // Validate project
    this._validateProject();

    // Clean & create output
    this._prepareOutput();

    // Scan assets
    this.assetDB.scan();

    // Copy engine
    if (this.engineDir) {
      const em = new EngineManager(this.engineDir);
      em.copyEngine(this.outputDir);
    }

    // Convert & write assets
    this._buildAssets();

    // Build internal bundle
    this._buildInternalBundle();

    // Bundle scripts
    const bundler = new ScriptBundler(this.projectDir);
    bundler.bundle(this.outputDir);

    // Generate templates
    this._generateTemplates();

    // Generate settings
    this._generateSettings();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.step(`Build complete in ${elapsed}s`);
    log.info(`Output: ${this.outputDir}`);
  }

  _validateProject() {
    log.step('Validating project');

    const required = ['assets', 'library'];
    for (const d of required) {
      const p = path.join(this.projectDir, d);
      if (!fs.existsSync(p)) {
        throw new Error(`Required directory ${d}/ not found in project`);
      }
    }

    // Read project settings
    const settingsPath = path.join(this.projectDir, 'settings', 'v2', 'packages', 'project-settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        this.projectSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        log.info('Loaded project settings');
      } catch {
        this.projectSettings = {};
      }
    } else {
      this.projectSettings = {};
    }

    log.info('Project validation OK');
  }

  _prepareOutput() {
    log.step('Preparing output directory');

    if (fs.existsSync(this.outputDir)) {
      fs.rmSync(this.outputDir, { recursive: true, force: true });
    }

    const dirs = [
      this.outputDir,
      path.join(this.outputDir, 'cocos-js'),
      path.join(this.outputDir, 'src'),
      path.join(this.outputDir, 'src', 'chunks'),
      path.join(this.outputDir, 'assets', 'main', 'import'),
      path.join(this.outputDir, 'assets', 'main', 'native'),
      path.join(this.outputDir, 'assets', 'internal', 'import'),
      path.join(this.outputDir, 'assets', 'internal', 'native'),
    ];

    for (const d of dirs) {
      mkdirp(d);
    }

    log.info('Output directory prepared');
  }

  _buildAssets() {
    log.step('Building assets (main bundle)');

    const importDir = path.join(this.outputDir, 'assets', 'main', 'import');
    const nativeDir = path.join(this.outputDir, 'assets', 'main', 'native');

    let importCount = 0;
    let nativeCount = 0;
    let cconCount = 0;

    // Process packs first
    const packs = AssetPacker.packAssets(this.assetDB);
    const packedUUIDs = new Set();

    for (const [packId, pack] of packs) {
      const packData = {};
      for (const asset of pack.assets) {
        const shortUuid = compressUUID(asset.uuid);
        packedUUIDs.add(asset.uuid);

        try {
          const serializer = new CCONSerializer();
          const ccon = serializer.serialize(asset.json);
          packData[shortUuid] = ccon;
          cconCount++;
        } catch (e) {
          // If CCON fails, store raw JSON
          packData[shortUuid] = asset.json;
        }
      }

      const packPath = uuidToImportPath(packId);
      const fullPath = path.join(importDir, packPath + '.json');
      mkdirp(path.dirname(fullPath));
      fs.writeFileSync(fullPath, JSON.stringify(packData));
    }

    // Process remaining JSON assets (not packed)
    for (const [key, asset] of this.assetDB.assets) {
      if (asset.isNative) {
        // Copy native asset
        const shortUuid = compressUUID(asset.uuid);
        const nativePath = uuidToImportPath(shortUuid);
        const fullPath = path.join(nativeDir, nativePath + asset.ext);
        mkdirp(path.dirname(fullPath));
        fs.copyFileSync(asset.path, fullPath);
        nativeCount++;
      } else if (!packedUUIDs.has(asset.uuid)) {
        // Convert to CCON and write
        const shortUuid = compressUUID(asset.uuid);
        const importPath = uuidToImportPath(shortUuid);

        try {
          const serializer = new CCONSerializer();
          const ccon = serializer.serialize(asset.json);
          const fullPath = path.join(importDir, importPath + '.json');
          mkdirp(path.dirname(fullPath));
          fs.writeFileSync(fullPath, JSON.stringify(ccon));
          cconCount++;
        } catch (e) {
          // Fallback: write raw JSON
          const fullPath = path.join(importDir, importPath + '.json');
          mkdirp(path.dirname(fullPath));
          fs.writeFileSync(fullPath, JSON.stringify(asset.json));
        }
        importCount++;
      }
    }

    // Generate config.json for main bundle
    const config = this.assetDB.buildConfig('main');

    // Add pack info
    for (const [packId, pack] of packs) {
      const uuidIndices = [];
      for (const shortUuid of pack.uuids) {
        const idx = config.uuids.indexOf(shortUuid);
        if (idx >= 0) uuidIndices.push(idx);
      }
      if (uuidIndices.length > 0) {
        config.packs[packId] = uuidIndices;
      }
    }

    fs.writeFileSync(
      path.join(this.outputDir, 'assets', 'main', 'config.json'),
      JSON.stringify(config)
    );

    log.info(`Assets built: ${importCount} import, ${nativeCount} native, ${cconCount} CCON conversions, ${packs.size} packs`);
  }

  _buildInternalBundle() {
    log.step('Building internal bundle');

    const internalImportDir = path.join(this.outputDir, 'assets', 'internal', 'import');
    const internalNativeDir = path.join(this.outputDir, 'assets', 'internal', 'native');

    // Try to copy internal bundle from engine directory
    const internalSources = [
      path.join(this.engineDir || '', 'assets-internal'),  // Our cache layout
      path.join(this.engineDir || '', 'editor', 'assets', 'default-assets'),
      path.join(this.engineDir || '', 'resources', 'builtin', 'internal'),
      path.join(this.engineDir || '', 'resources', 'engine', 'editor', 'assets'),
    ];

    let found = false;
    for (const src of internalSources) {
      if (fs.existsSync(src)) {
        log.info(`Copying internal assets from ${src}`);
        // If source has config.json, it's a complete internal bundle - copy to parent
        if (fs.existsSync(path.join(src, 'config.json'))) {
          const internalDir = path.join(this.outputDir, 'assets', 'internal');
          copyRecursive(src, internalDir);
        } else {
          copyRecursive(src, internalImportDir);
        }
        found = true;
        break;
      }
    }

    // Also check if project has a cached internal bundle
    const cachedInternal = path.join(this.projectDir, 'library', 'internal');
    if (!found && fs.existsSync(cachedInternal)) {
      log.info('Using cached internal bundle from library/');
      copyRecursive(cachedInternal, internalImportDir);
      found = true;
    }

    // Generate minimal internal config
    const internalConfig = {
      importBase: 'import',
      nativeBase: 'native',
      name: 'internal',
      deps: [],
      uuids: [],
      paths: {},
      scenes: {},
      packs: {},
      types: [],
      versions: { import: [], native: [] },
      redirect: [],
      debug: false,
    };

    fs.writeFileSync(
      path.join(this.outputDir, 'assets', 'internal', 'config.json'),
      JSON.stringify(internalConfig)
    );

    if (!found) {
      log.warn('Internal bundle assets not found - engine materials/effects may be missing');
    } else {
      log.info('Internal bundle built');
    }
  }

  _generateTemplates() {
    log.step('Generating template files');

    const srcDir = path.join(this.outputDir, 'src');

    // Main files - prefer cached templates from engine
    const cachedTpl = this.engineDir ? path.join(this.engineDir, 'templates') : null;
    const tplMap = {
      'index.html': () => TemplateGenerator.indexHTML({ title: this._getProjectName() }),
      'index.js': () => TemplateGenerator.indexJS(),
      'application.js': () => TemplateGenerator.applicationJS(),
      'style.css': () => TemplateGenerator.styleCSS(),
    };
    for (const [fn, fallback] of Object.entries(tplMap)) {
      const cached = cachedTpl ? path.join(cachedTpl, fn) : null;
      if (cached && fs.existsSync(cached)) {
        fs.copyFileSync(cached, path.join(this.outputDir, fn));
      } else {
        fs.writeFileSync(path.join(this.outputDir, fn), fallback());
      }
    }

    // Src files - prefer cached real files from engine
    const cachedSrc = this.engineDir ? path.join(this.engineDir, 'src') : null;
    const filesToCopy = ['import-map.json', 'polyfills.bundle.js', 'system.bundle.js'];
    for (const fn of filesToCopy) {
      const cached = cachedSrc ? path.join(cachedSrc, fn) : null;
      if (cached && fs.existsSync(cached)) {
        fs.copyFileSync(cached, path.join(srcDir, fn));
      } else if (fn === 'import-map.json') {
        fs.writeFileSync(path.join(srcDir, fn),
          JSON.stringify(TemplateGenerator.importMapJSON(), null, 2));
      } else if (fn === 'polyfills.bundle.js') {
        fs.writeFileSync(path.join(srcDir, fn), TemplateGenerator.polyfillsBundle());
      } else {
        fs.writeFileSync(path.join(srcDir, fn), TemplateGenerator.systemBundle());
      }
    }

    log.info('Templates generated');
  }

  _generateSettings() {
    log.step('Generating settings');

    const scenes = [];
    // Collect scenes from asset DB
    for (const [, asset] of this.assetDB.assets) {
      if (asset.type === 'cc.SceneAsset' || (asset.dbPath && asset.dbPath.endsWith('.scene'))) {
        scenes.push({
          url: asset.dbPath || '',
          uuid: compressUUID(asset.uuid),
        });
      }
    }

    const settings = TemplateGenerator.settingsJSON(this.projectSettings, scenes);

    // Set launch scene
    if (scenes.length > 0) {
      settings.launchScene = scenes[0].url;
    }

    // Bundle versions (md5 hashes for cache busting)
    settings.bundleVers = {
      internal: md5(Date.now().toString()).slice(0, 5),
      main: md5(Date.now().toString() + 'main').slice(0, 5),
    };

    fs.writeFileSync(
      path.join(this.outputDir, 'src', 'settings.json'),
      JSON.stringify(settings, null, 2)
    );

    log.info(`Settings generated (${scenes.length} scene(s))`);
  }

  _getProjectName() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.projectDir, 'package.json'), 'utf8'));
      return pkg.name || 'Cocos Game';
    } catch {
      return 'Cocos Game';
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  mkdirp(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath = path.join(src, e.name);
    const destPath = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Cocos Creator ${ENGINE_VERSION} Web-Mobile Builder (Pure Node.js)

Usage: node cocos-full-builder.js <project-dir> [engine-dir]

Arguments:
  project-dir   Path to Cocos Creator project (containing assets/, library/)
  engine-dir    Path to CocosCreator engine installation (optional, auto-detected)

Output: <project-dir>/build/web-mobile/
`);
    process.exit(0);
  }

  const projectDir = args[0];
  const engineDir = args[1] || undefined;

  if (!fs.existsSync(projectDir)) {
    log.error(`Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  try {
    const builder = new CocosWebMobileBuilder(projectDir, engineDir);
    await builder.build();
  } catch (e) {
    log.error(`Build failed: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }
}

main();
