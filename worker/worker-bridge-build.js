// Luna build via jake pipeline + MSBuild Rebuild for code injection
// Does NOT require Unity Bridge (port 18801) or AssetDatabase.Refresh
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LUNA_DIR = 'D:\\Luna';
const PIPELINE_DIR = path.join(LUNA_DIR, 'pipeline');
const MSBUILD_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe';
const CSPROJ_DIR = path.join(LUNA_DIR, 'pipeline', 'templates', 'LunaCompiler', 'Scripts');
const CSPROJ_PATH = path.join(CSPROJ_DIR, 'Scripts.csproj');
const BRIDGE_JS_OUTPUT = path.join(LUNA_DIR, 'pipeline', 'templates', 'LunaCompiler', 'bin', 'UnityScriptsCompiler.js');

/**
 * Run Luna build with AI code injection via MSBuild Rebuild
 * Flow:
 *   1. jake project:build (Stage1-4, template code, ~30s)
 *   2. Clean MSBuild obj cache
 *   3. MSBuild Rebuild Scripts.csproj (compiles .cs from disk → JS via Bridge.NET, ~8s)
 *   4. Copy new UnityScriptsCompiler.js to stage3+stage4 output
 *
 * @param {string} clientDir - Unity project Client directory
 * @param {function} log - Logger
 * @param {string} taskId - Task ID
 * @returns {object} { ok, output, error, buildTime, outputDir }
 */
async function runBridgeBuild(clientDir, log, taskId) {
  log = log || console.log;
  const startTime = Date.now();

  // 1. Clean old LunaTemp (preserve stage1 cache - asset export is slow/broken on cold start)
  const lunaTempDir = path.join(clientDir, 'LunaTemp');
  if (fs.existsSync(lunaTempDir)) {
    log('[luna-build] Cleaning LunaTemp (preserving stage1 cache)...', taskId);
    for (const sub of ['stage2', 'stage3', 'stage4']) {
      const subDir = path.join(lunaTempDir, sub);
      if (fs.existsSync(subDir)) {
        try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (e) {
          log('[luna-build] Warning cleaning ' + sub + ': ' + e.message, taskId);
        }
      }
    }
  }

  // 2. Run jake project:build (Stage1-4 with template/cached code)
  log('[luna-build] Running jake project:build...', taskId);

  const jakeResult = await new Promise((resolve) => {
    const env = { ...process.env, PROJECT_PATH: clientDir };
    // Remove proxy vars — Worker proxy may not exist, causes TLS failures in jake
    delete env.http_proxy; delete env.https_proxy;
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
    // Remove proxy vars — Worker proxy may not exist, causes TLS failures in jake license check
    delete env.http_proxy; delete env.https_proxy;
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
    const child = spawn('node', [
      '--max-old-space-size=8192',
      'jake.js', '-f', 'Jakefile.js', '--quiet', 'project:build'
    ], {
      cwd: PIPELINE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastLog = Date.now();

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (text.includes('Stage')) {
        text.split('\n').filter(l => l.includes('Stage')).forEach(l => {
          log('[luna-build] ' + l.trim(), taskId);
        });
      }
      if (Date.now() - lastLog > 30000 && text.includes('.')) {
        log('[luna-build] Still running... (' + Math.floor((Date.now() - startTime) / 1000) + 's)', taskId);
        lastLog = Date.now();
      }
    });

    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    setTimeout(() => { child.kill(); resolve({ code: -1, stdout, stderr: 'Timeout' }); }, 300000);
  });

  if (jakeResult.code !== 0) {
    // Jake C# compilation may fail because processed-scripts are empty stubs.
    // If stage1 cache exists and stage4 has assets (from previous successful build),
    // fall back to MSBuild-only mode which compiles from original .cs sources.
    const stage1Exists = fs.existsSync(path.join(lunaTempDir, 'stage1'));
    const stage4HasAssets = fs.existsSync(path.join(lunaTempDir, 'stage4', 'develop', 'engine'));
    
    if (stage1Exists && stage4HasAssets) {
      log('[luna-build] Jake C# compilation failed but stage1 cache + stage4 assets exist — falling back to MSBuild-only mode', taskId);
    } else if (stage1Exists && fs.existsSync(path.join(lunaTempDir, 'stage3'))) {
      // Jake Stage3 C# failed but stage1-3 exist — manually assemble stage4 from templates + stage3 assets
      log('[luna-build] Jake Stage3 C# failed. Assembling stage4 manually from Luna engine + stage3 assets...', taskId);
      const s4Dir = path.join(lunaTempDir, 'stage4', 'develop');
      fs.mkdirSync(s4Dir, { recursive: true });
      
      // Copy Luna engine
      const lunaEngineDir = path.join(LUNA_DIR, 'engine', 'luna');
      if (fs.existsSync(lunaEngineDir)) {
        const cpDir = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir(a,b);else fs.copyFileSync(a,b);} };
        cpDir(lunaEngineDir, path.join(s4Dir, 'engine', 'luna'));
      }
      // Copy compiled JS (bridge, UnityEngine, etc.)
      const binDir = path.join(CSPROJ_DIR, '..', 'bin');
      const unityBin = path.join(s4Dir, 'engine', 'unity', 'bin');
      fs.mkdirSync(unityBin, { recursive: true });
      if (fs.existsSync(binDir)) {
        for (const f of fs.readdirSync(binDir)) {
          if (f.endsWith('.js')) fs.copyFileSync(path.join(binDir, f), path.join(unityBin, f));
        }
      }
      // Copy stage3 assets + js
      const s3Dir = path.join(lunaTempDir, 'stage3');
      if (fs.existsSync(path.join(s3Dir, 'assets'))) {
        const cpDir2 = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir2(a,b);else fs.copyFileSync(a,b);} };
        cpDir2(path.join(s3Dir, 'assets'), path.join(s4Dir, 'assets'));
      }
      if (fs.existsSync(path.join(s3Dir, 'js'))) {
        const cpDir3 = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir3(a,b);else fs.copyFileSync(a,b);} };
        cpDir3(path.join(s3Dir, 'js'), path.join(s4Dir, 'js'));
      }
      // Copy luna.json
      if (fs.existsSync(path.join(clientDir, 'luna.json'))) {
        fs.copyFileSync(path.join(clientDir, 'luna.json'), path.join(s4Dir, 'luna.json'));
      }
      // Use original iframe.html from luna-copy or generate minimal one
      const lunaCopyIframe = path.join(path.dirname(clientDir), 'luna-copy', 'iframe.html');
      if (fs.existsSync(lunaCopyIframe)) {
        let ihtml = fs.readFileSync(lunaCopyIframe, 'utf-8');
        ihtml = ihtml.replace(/(src|href)="([^"]+)"/g, (m, attr, p) => attr + '="' + p.replace(/\\/g, '/') + '"');
        fs.writeFileSync(path.join(s4Dir, 'iframe.html'), ihtml);
        log('[luna-build] Used luna-copy iframe.html as base', taskId);
      }
      log('[luna-build] Stage4 manually assembled (' + (fs.readdirSync(s4Dir).length) + ' items)', taskId);
    } else {
      const errorLines = jakeResult.stdout.split('\n').filter(l => /fail|error/i.test(l)).slice(-5);
      return { ok: false, error: `Jake build failed (code ${jakeResult.code}): ${errorLines.join('; ') || jakeResult.stderr.slice(-500)}` };
    }
  }

  // Verify stage4 output
  const stage4Dir = path.join(lunaTempDir, 'stage4', 'develop');
  if (!fs.existsSync(stage4Dir) || !fs.existsSync(path.join(stage4Dir, 'engine'))) {
    return { ok: false, error: 'No stage4/develop output (jake failed and no cache available)' };
  }

  const jakeBuildTime = Math.floor((Date.now() - startTime) / 1000);
  log(`[luna-build] Jake build done in ${jakeBuildTime}s, starting MSBuild Rebuild...`, taskId);

  // 3. Clean MSBuild obj cache to force recompilation
  const objDir = path.join(CSPROJ_DIR, 'obj');
  if (fs.existsSync(objDir)) {
    try { fs.rmSync(objDir, { recursive: true, force: true }); } catch (e) {
      log('[luna-build] Warning cleaning obj: ' + e.message, taskId);
    }
  }

  // 4. MSBuild Rebuild (compiles .cs from disk via Bridge.NET → JS)
  const msbuildStart = Date.now();
  try {
    const msbuildResult = execSync(
      `"${MSBUILD_PATH}" "${CSPROJ_PATH}" /t:Rebuild /p:Configuration=Debug /v:minimal 2>&1`,
      {
        cwd: CSPROJ_DIR,
        timeout: 120000,
        encoding: 'utf-8',
        env: { ...process.env, PROJECT_PATH: clientDir }
      }
    );
    const msbuildTime = Math.floor((Date.now() - msbuildStart) / 1000);
    log(`[luna-build] MSBuild Rebuild done in ${msbuildTime}s`, taskId);

    // Check for compilation errors
    if (msbuildResult.includes('个错误') || msbuildResult.includes(' error ')) {
      const errorMatch = msbuildResult.match(/(\d+) 个错误/);
      const errorCount = errorMatch ? parseInt(errorMatch[1]) : 0;
      if (errorCount > 0) {
        const errorLines = msbuildResult.split('\n').filter(l => /error CS/i.test(l)).slice(0, 10);
        return { ok: false, error: `MSBuild: ${errorCount} compilation errors: ${errorLines.join('; ')}` };
      }
    }
  } catch (e) {
    return { ok: false, error: `MSBuild failed: ${(e.stdout || e.message).slice(-500)}` };
  }

  // 5. Copy new UnityScriptsCompiler.js to stage3 and stage4
  if (!fs.existsSync(BRIDGE_JS_OUTPUT)) {
    return { ok: false, error: 'MSBuild succeeded but UnityScriptsCompiler.js not found at ' + BRIDGE_JS_OUTPUT };
  }

  const newJs = fs.readFileSync(BRIDGE_JS_OUTPUT);
  const stage3JsDir = path.join(lunaTempDir, 'stage3', 'engine', 'unity', 'bin');
  const stage4JsDir = path.join(stage4Dir, 'engine', 'unity', 'bin');

  const copyTargets = [stage3JsDir, stage4JsDir];
  for (const dir of copyTargets) {
    const target = path.join(dir, 'UnityScriptsCompiler.js');
    if (fs.existsSync(dir)) {
      fs.writeFileSync(target, newJs);
      log(`[luna-build] Copied new JS to ${target} (${newJs.length} bytes)`, taskId);
    }
  }

  // 6. Inject GameFlowManagerMain component into iframe.html
  // Luna scene data doesn't include GameManager object (not in SVN scene),
  // so we inject JS that creates it at runtime after Luna starts
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (fs.existsSync(iframePath)) {
    let html = fs.readFileSync(iframePath, 'utf-8');
    const injectionScript = `<script>
// Polyfill Resources.GetBuiltinResource for Luna (not implemented natively)
window.addEventListener("luna:starting", function() {
  try {
    var origGetBuiltin = UnityEngine.Resources.GetBuiltinResource;
    UnityEngine.Resources.GetBuiltinResource = function(type, name) {
      // Font request
      if (name && name.indexOf(".ttf") >= 0) {
        try { return Font.CreateDynamicFontFromOSFont("Arial", 14); } catch(e) {}
        return null;
      }
      // Mesh request (for CreatePrimitive)
      if (type && type.$$name === "Mesh") {
        var mesh = new UnityEngine.Mesh.ctor();
        if (name === "Cube.fbx") {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        } else if (name === "Sphere.fbx" || name === "Capsule.fbx" || name === "Cylinder.fbx") {
          // Use cube mesh as fallback for all primitives
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        } else if (name === "Plane.fbx") {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-5,0,-5), new UnityEngine.Vector3.ctor$1(5,0,-5), new UnityEngine.Vector3.ctor$1(5,0,5), new UnityEngine.Vector3.ctor$1(-5,0,5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2], System.Int32);
          mesh.RecalculateNormals();
        }
        return mesh;
      }
      // Material request
      if (type && type.$$name === "Material") {
        var sh = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("UI/Default") || UnityEngine.Shader.Find("Sprites/Default");
        if (sh) return new UnityEngine.Material.ctor(sh);
        return null;
      }
      if (origGetBuiltin) try { return origGetBuiltin.apply(this, arguments); } catch(e) {}
      return null;
    };
    // Also patch Shader.Find to fallback when shader not found
    var origShaderFind = UnityEngine.Shader.Find;
    UnityEngine.Shader.Find = function(name) {
      var s = origShaderFind(name);
      if (!s) s = origShaderFind("UI/Default");
      return s;
    };
    // Patch MeshRenderer.material to auto-create default material if null
    var mrProto = UnityEngine.MeshRenderer.prototype;
    if (mrProto) {
      var origMatGetter = Object.getOwnPropertyDescriptor(mrProto, "material") || 
                          Object.getOwnPropertyDescriptor(UnityEngine.Renderer.prototype, "material");
      if (origMatGetter && origMatGetter.get) {
        var origGet = origMatGetter.get;
        var origSet = origMatGetter.set;
        Object.defineProperty(UnityEngine.Renderer.prototype, "material", {
          get: function() {
            var m = origGet.call(this);
            if (!m) {
              var sh = UnityEngine.Shader.Find("Universal Render Pipeline/Lit");
              m = new UnityEngine.Material.ctor(sh);
              if (origSet) origSet.call(this, m);
            }
            return m;
          },
          set: origSet,
          configurable: true
        });
      }
    }
    console.log("[AI] Resources.GetBuiltinResource + Shader.Find + Material polyfill installed");
  } catch(e) { console.error("[AI] Polyfill error:", e); }
});
// Inject GameFlowManagerMain component after Luna fully started
window.addEventListener("luna:started", function() {
  try {
    var go = new UnityEngine.GameObject.ctor("GameManager");
    var comp = go.AddComponent(GameFlowManagerMain);
    if (comp && comp.Start) { try { comp.Start(); } catch(se) { console.error("[AI] Start() error:", se); } }
    // Fix null shaders: Luna's __MaterialSource sharedMaterial has null shader after serialization
    // GFM_Create copies _baseMat from it, so all pool objects get null shader = invisible
    // Fix: recreate materials with URP/Lit shader, preserving original colors
    // MUST be delayed — PlayCanvas render pipeline needs a few seconds to stabilize before material reassignment triggers dirty flags
    function fixNullShaders() {
      try {
        var fixShader = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("Standard");
        if (fixShader) {
          if (GFM_Create && GFM_Create._baseMat && !GFM_Create._baseMat.shader) {
            GFM_Create._baseMat = new UnityEngine.Material.$ctor2(fixShader);
            GFM_Create._baseMat.color = new pc.Color(1, 1, 1, 1);
          }
          var allRoots = UnityEngine.SceneManagement.SceneManager.GetActiveScene().getRootGameObjects();
          var shaderFixed = 0;
          for (var ri = 0; ri < allRoots.length; ri++) {
            var rObj = allRoots[ri];
            var rr = rObj.GetComponent(UnityEngine.MeshRenderer);
            if (rr && UnityEngine.Component.op_Inequality(rr, null) && rr.material) {
              var origColor = rr.material.color || new pc.Color(1, 1, 1, 1);
              var fixMat = new UnityEngine.Material.$ctor2(fixShader);
              fixMat.color = new pc.Color(origColor.r, origColor.g, origColor.b, origColor.a || 1);
              rr.material = fixMat;
              shaderFixed++;
            }
          }
          if (shaderFixed > 0) console.log("[AI] Fixed " + shaderFixed + " materials with URP/Lit shader");
        }
      } catch(shErr) { console.error("[AI] Shader fix error:", shErr); }
    }
    // Run shader fix after delay (PlayCanvas needs render loop running before material dirty flags work)
    setTimeout(fixNullShaders, 2000);
    // Also run again at 5s for safety (some objects may be created by Update loop after initial delay)
    setTimeout(fixNullShaders, 5000);
    // Luna injection: Update() is NOT called automatically by Unity runtime
    // Must manually drive the game loop via requestAnimationFrame
    if (comp && comp.Update) {
      var lastTime = performance.now();
      function gameLoop() {
        var now = performance.now();
        var dt = (now - lastTime) / 1000.0;
        lastTime = now;
        // Set Time.deltaTime for the frame (Luna exposes this)
        try { if (UnityEngine.Time) UnityEngine.Time.deltaTime = dt; } catch(e) {}
        try { comp.Update(); } catch(e) { /* silent — Update errors are common during transitions */ }
        requestAnimationFrame(gameLoop);
      }
      requestAnimationFrame(gameLoop);
      console.log("[AI] Update() loop started via requestAnimationFrame");
    }
    console.log("[AI] GameFlowManagerMain injected successfully");
  } catch(e) { console.error("[AI] Failed to inject GameFlowManagerMain:", e); }
});
<\/script>`;
    // Insert before closing </body> or </html>
    if (html.includes('</body>')) {
      html = html.replace('</body>', injectionScript + '</body>');
    } else {
      html = html.replace('</html>', injectionScript + '</html>');
    }
    fs.writeFileSync(iframePath, html);
    log('[luna-build] Injected GameFlowManagerMain component into iframe.html', taskId);
  }

  // 7. Verify AI code is in the build output (prevent template-only builds)
  const finalJsPath = path.join(stage4Dir, 'engine', 'unity', 'bin', 'UnityScriptsCompiler.js');
  if (fs.existsSync(finalJsPath)) {
    const finalJs = fs.readFileSync(finalJsPath, 'utf-8');
    if (!finalJs.includes('GameFlowManagerMain')) {
      log('[luna-build] ⚠️ WARNING: UnityScriptsCompiler.js does NOT contain GameFlowManagerMain — AI code may not be compiled in!', taskId);
      return { ok: false, error: 'Build verification failed: AI code (GameFlowManagerMain) not found in compiled JS. The build output may be template-only.' };
    }
    log(`[luna-build] ✅ Build verified: GameFlowManagerMain found in compiled JS (${(finalJs.length / 1024).toFixed(0)} KB)`, taskId);
  } else {
    log('[luna-build] ⚠️ UnityScriptsCompiler.js not found in stage4, skipping verification', taskId);
  }

  const totalTime = Math.floor((Date.now() - startTime) / 1000);
  log(`[luna-build] Build completed in ${totalTime}s (jake: ${jakeBuildTime}s + msbuild: ${totalTime - jakeBuildTime}s)`, taskId);

  return {
    ok: true,
    output: `Build completed in ${totalTime}s`,
    buildTime: totalTime,
    outputDir: stage4Dir
  };
}

// Legacy compatibility
async function checkBridge() { return true; }
function bridgeRequest() { return Promise.resolve({}); }

module.exports = { runBridgeBuild, checkBridge, bridgeRequest };

if (require.main === module) {
  (async () => {
    const clientDir = process.argv[2] || 'D:\\work\\test-luna\\Client';
    const result = await runBridgeBuild(clientDir, console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}
