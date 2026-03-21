#!/usr/bin/env node
// Linux Cocos Build - Rebuild bundle.js from TypeScript sources without Cocos Creator
// Usage: node linux-cocos-build.js <project-dir>
// Requires: npm install rollup @rollup/plugin-typescript @rollup/plugin-node-resolve typescript tslib

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.argv[2] || '/data/Client_cocos';
const BUILD_DIR = path.join(PROJECT_DIR, 'build', 'web-mobile');
const SCRIPTS_DIR = path.join(PROJECT_DIR, 'assets', 'scripts');
const BUNDLE_OUT = path.join(BUILD_DIR, 'src', 'chunks', 'bundle.js');
const CC_STUB = path.join(PROJECT_DIR, 'node_modules', 'cc', 'index.d.ts');

function log(msg) { console.log('[cocos-build] ' + msg); }

async function build() {
  const start = Date.now();

  // Verify project structure
  if (!fs.existsSync(path.join(PROJECT_DIR, 'package.json'))) {
    log('ERROR: No package.json found in ' + PROJECT_DIR);
    process.exit(1);
  }
  if (!fs.existsSync(BUILD_DIR)) {
    log('ERROR: No build/web-mobile found - need a baseline build first');
    process.exit(1);
  }

  // Ensure cc stub module exists
  const ccModDir = path.join(PROJECT_DIR, 'node_modules', 'cc');
  if (!fs.existsSync(ccModDir)) {
    fs.mkdirSync(ccModDir, { recursive: true });
  }
  // Create cc stub package.json
  fs.writeFileSync(path.join(ccModDir, 'package.json'), JSON.stringify({
    name: 'cc', version: '3.8.8', main: 'index.js', types: 'index.d.ts'
  }));
  // Create cc stub JS (empty re-export - rollup treats as external anyway)
  fs.writeFileSync(path.join(ccModDir, 'index.js'), '// cc engine stub\nmodule.exports = {};');
  
  // Copy the type declarations if available
  const stubSrc = path.join(__dirname, 'cocos-cc-stub.d.ts');
  if (fs.existsSync(stubSrc)) {
    fs.copyFileSync(stubSrc, CC_STUB);
  }

  // Find all TS scripts
  const scripts = [];
  function findScripts(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) findScripts(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) scripts.push(full);
    }
  }
  findScripts(SCRIPTS_DIR);
  log('Found ' + scripts.length + ' TypeScript files');

  // Create entry file
  const entryPath = path.join(PROJECT_DIR, '_cocos_entry.ts');
  const entryLines = scripts.map(s => {
    const rel = path.relative(PROJECT_DIR, s).replace(/\\/g, '/').replace(/\.ts$/, '');
    const name = path.basename(s, '.ts');
    // Use dynamic import to avoid name conflicts
    return `import './${rel}';`;
  });
  fs.writeFileSync(entryPath, entryLines.join('\n'));

  // Rollup build
  const rollup = require('rollup');
  const typescript = require('@rollup/plugin-typescript');
  const resolve = require('@rollup/plugin-node-resolve');

  try {
    const bundle = await rollup.rollup({
      input: entryPath,
      external: ['cc'],
      plugins: [
        resolve.default(),
        typescript.default({
          tsconfig: false,
          compilerOptions: {
            target: 'ES2017',
            module: 'ESNext',
            lib: ['ES2017', 'DOM'],
            strict: false,
            experimentalDecorators: true,
            emitDecoratorMetadata: false,
            moduleResolution: 'node',
            skipLibCheck: true,
            allowImportingTsExtensions: false,
            noEmit: false,
            declaration: false,
          },
          include: ['assets/scripts/**/*.ts', '_cocos_entry.ts'],
        })
      ],
      onwarn(warning, warn) {
        // Suppress known warnings
        if (warning.code === 'THIS_IS_UNDEFINED') return;
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        if (warning.message && warning.message.includes('cc')) return;
        warn(warning);
      }
    });

    const { output } = await bundle.generate({
      format: 'system',
      name: 'bundle',
      globals: { cc: 'cc' },
    });

    const code = output[0].code;

    // Wrap in outer System.register like Cocos does
    const wrappedCode = `System.register([], function(_export, _context) { return { execute: function () {\n${code}\n} }; });`;

    // Backup original
    if (fs.existsSync(BUNDLE_OUT)) {
      const backupPath = BUNDLE_OUT + '.original';
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(BUNDLE_OUT, backupPath);
        log('Backed up original bundle.js');
      }
    }

    // Write new bundle
    fs.writeFileSync(BUNDLE_OUT, wrappedCode);
    const elapsed = Math.floor((Date.now() - start) / 1000);
    log('SUCCESS! Rebuilt bundle.js (' + wrappedCode.length + ' bytes) in ' + elapsed + 's');

    return { ok: true, size: wrappedCode.length, elapsed };

  } catch (err) {
    log('ERROR: ' + err.message);
    if (err.frame) log(err.frame);
    return { ok: false, error: err.message };
  } finally {
    // Cleanup
    if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath);
  }
}

if (require.main === module) {
  build().then(result => {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = { build };
