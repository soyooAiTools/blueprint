// Test V4 code generation with 取木射箭 blueprint
var path = require('path');
var { generateCode } = require('./worker/worker-coder.js');

var blueprint = require('./docs/qmjs-v4-blueprint.json');
var clientDir = 'D:\\work\\test-luna\\Client';  // Will be overridden — we just want to see the AI output

// Use a temp dir for output
var fs = require('fs');
var tmpDir = path.join(__dirname, 'test-v4-output');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
var assetsDir = path.join(tmpDir, 'Assets', 'Program', 'Script', 'Manager');
fs.mkdirSync(assetsDir, { recursive: true });

// Copy GFM_Tools.cs if exists
var toolsSrc = path.join(__dirname, 'worker', 'GFM_Tools.cs');
if (fs.existsSync(toolsSrc)) {
  fs.copyFileSync(toolsSrc, path.join(assetsDir, 'GFM_Tools.cs'));
}

function log(msg, taskId) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

(async () => {
  try {
    console.log('=== V4 Code Generation Test ===');
    console.log('Entities:', blueprint.entities.length);
    console.log('Phases:', blueprint.phases.length);
    console.log('');
    
    var result = await generateCode(blueprint, tmpDir, log, 'test-v4');
    
    console.log('\n=== Result ===');
    console.log(JSON.stringify(result, null, 2));
    
    // Read generated file
    var mainFile = path.join(assetsDir, 'GameFlowManagerMain.cs');
    if (fs.existsSync(mainFile)) {
      var code = fs.readFileSync(mainFile, 'utf-8');
      console.log('\n=== Generated Code ===');
      console.log('Lines:', code.split('\n').length);
      console.log('Size:', code.length, 'bytes');
      
      // Save to easy-to-read location
      var outputFile = path.join(__dirname, 'output-v4-gfm.cs');
      fs.writeFileSync(outputFile, code, 'utf-8');
      console.log('Saved to:', outputFile);
    }
  } catch(e) {
    console.error('Error:', e.message);
    console.error(e.stack);
  }
})();
