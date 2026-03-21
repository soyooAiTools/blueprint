// Linux replacement for worker-cocos-build.js
// Uses cocos-full-builder.js for complete build (no Windows/CocosCreator needed)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENGINE_CACHE = '/data/cocos-engine-cache';
const BUILDER_SCRIPT = path.join(__dirname, 'cocos-full-builder.js');

async function runCocosBuild(projectDir, log, taskId) {
  log = log || console.log;
  const startTime = Date.now();
  const buildDir = path.join(projectDir, 'build', 'web-mobile');

  log(`[cocos-build] Starting full Linux build for ${projectDir}`);

  // Check engine cache
  if (!fs.existsSync(ENGINE_CACHE)) {
    return { ok: false, error: 'Engine cache not found at ' + ENGINE_CACHE };
  }

  // Check builder script
  if (!fs.existsSync(BUILDER_SCRIPT)) {
    return { ok: false, error: 'cocos-full-builder.js not found at ' + BUILDER_SCRIPT };
  }

  // Check project has library/ (required for CCON conversion)
  if (!fs.existsSync(path.join(projectDir, 'library'))) {
    return { ok: false, error: 'Project missing library/ directory. Need a Cocos project with pre-processed library.' };
  }

  try {
    // Clean old build
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }

    // Run full builder
    const output = execSync(
      `node "${BUILDER_SCRIPT}" "${projectDir}" "${ENGINE_CACHE}"`,
      { timeout: 120000, stdio: 'pipe', cwd: path.dirname(BUILDER_SCRIPT) }
    ).toString();

    log(`[cocos-build] Builder output:\n${output}`);

    // Verify output
    if (!fs.existsSync(path.join(buildDir, 'index.html'))) {
      return { ok: false, error: 'Build failed - no index.html generated' };
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const fileCount = execSync(`find "${buildDir}" -type f | wc -l`).toString().trim();

    log(`[cocos-build] SUCCESS in ${elapsed}s - ${fileCount} files`);

    return {
      ok: true,
      buildTime: parseFloat(elapsed),
      outputDir: buildDir,
      fileCount: parseInt(fileCount),
    };
  } catch (e) {
    return { ok: false, error: 'Build error: ' + e.message.slice(0, 500) };
  }
}

module.exports = { runCocosBuild };
