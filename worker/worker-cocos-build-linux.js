// Linux replacement for worker-cocos-build.js
// Instead of calling CocosCreator.exe, rebuilds bundle.js from TypeScript sources
// Requires a baseline build (build/web-mobile/) to exist in the project

const fs = require('fs');
const path = require('path');

async function runCocosBuild(projectDir, log, taskId) {
  log = log || console.log;
  const startTime = Date.now();
  const buildDir = path.join(projectDir, 'build', 'web-mobile');
  const bundleOut = path.join(buildDir, 'src', 'chunks', 'bundle.js');
  const scriptsDir = path.join(projectDir, 'assets', 'scripts');

  // Check for baseline build
  if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
    return { ok: false, error: 'No baseline build found. Run initial build on Windows first.' };
  }

  // Ensure cc stub module exists
  const ccModDir = path.join(projectDir, 'node_modules', 'cc');
  if (!fs.existsSync(ccModDir)) {
    fs.mkdirSync(ccModDir, { recursive: true });
  }
  fs.writeFileSync(path.join(ccModDir, 'package.json'), JSON.stringify({
    name: 'cc', version: '3.8.8', main: 'index.js', types: 'index.d.ts'
  }));
  fs.writeFileSync(path.join(ccModDir, 'index.js'), '// cc engine stub\nmodule.exports = {};');

  // Copy type stubs if available
  const stubPath = path.join(__dirname, 'cocos-cc-stub.d.ts');
  if (fs.existsSync(stubPath)) {
    fs.copyFileSync(stubPath, path.join(ccModDir, 'index.d.ts'));
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
  
  if (!fs.existsSync(scriptsDir)) {
    return { ok: false, error: 'No assets/scripts directory found' };
  }
  findScripts(scriptsDir);
  log('[cocos-build-linux] Found ' + scripts.length + ' TypeScript files', taskId);

  // Ensure rollup dependencies are installed
  try {
    require.resolve('rollup');
  } catch (e) {
    log('[cocos-build-linux] Installing rollup dependencies...', taskId);
    const { execSync } = require('child_process');
    try {
      execSync('npm install rollup @rollup/plugin-typescript @rollup/plugin-node-resolve typescript tslib', {
        cwd: path.dirname(__dirname), // worker root
        timeout: 60000,
        stdio: 'pipe',
        env: { ...process.env, https_proxy: process.env.https_proxy || 'http://127.0.0.1:7890' }
      });
    } catch (installErr) {
      return { ok: false, error: 'Failed to install build dependencies: ' + installErr.message.slice(0, 200) };
    }
  }

  // Create entry file
  const entryPath = path.join(projectDir, '_cocos_entry.ts');
  const entryLines = scripts.map(s => {
    const rel = path.relative(projectDir, s).replace(/\\/g, '/').replace(/\.ts$/, '');
    return "import './" + rel + "';";
  });
  fs.writeFileSync(entryPath, entryLines.join('\n'));

  // Save original cwd and change to project dir for rollup
  const origCwd = process.cwd();
  process.chdir(projectDir);

  try {
    const rollup = require('rollup');
    const typescript = require('@rollup/plugin-typescript');
    const resolve = require('@rollup/plugin-node-resolve');

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
            declaration: false,
          },
          include: ['assets/scripts/**/*.ts', '_cocos_entry.ts'],
        })
      ],
      onwarn() {} // Suppress all warnings
    });

    const { output } = await bundle.generate({
      format: 'system',
      name: 'bundle',
      globals: { cc: 'cc' },
    });

    const code = output[0].code;
    const wrappedCode = "System.register([], function(_export, _context) { return { execute: function () {\n" + code + "\n} }; });";

    // Backup original bundle
    if (fs.existsSync(bundleOut)) {
      const backupPath = bundleOut + '.original';
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(bundleOut, backupPath);
      }
    }

    fs.writeFileSync(bundleOut, wrappedCode);
    const buildTime = Math.floor((Date.now() - startTime) / 1000);
    log('[cocos-build-linux] SUCCESS: bundle.js rebuilt (' + wrappedCode.length + ' bytes) in ' + buildTime + 's', taskId);

    return { ok: true, buildTime, outputDir: buildDir };

  } catch (err) {
    return { ok: false, error: 'Rollup build failed: ' + err.message.slice(0, 300) };
  } finally {
    if (fs.existsSync(entryPath)) fs.unlinkSync(entryPath);
    process.chdir(origCwd);
  }
}

function findCocosCreator() {
  return 'linux-rollup-build'; // Not using CocosCreator.exe on Linux
}

module.exports = { runCocosBuild, findCocosCreator };

if (require.main === module) {
  (async function() {
    var result = await runCocosBuild(process.argv[2] || '/data/Client_cocos', console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}
