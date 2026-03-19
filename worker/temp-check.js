// Quick check: where is Luna defined?
const fs = require('fs');
const dir = 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop\\engine\\unity\\bin';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
for (const f of files) {
  const c = fs.readFileSync(dir + '\\' + f, 'utf8');
  const lunaCount = (c.match(/\bLuna\b/g) || []).length;
  const unityEngineCount = (c.match(/\bUnityEngine\b/g) || []).length;
  if (lunaCount > 0 || unityEngineCount > 0) {
    console.log(f + ': Luna=' + lunaCount + ' UnityEngine=' + unityEngineCount + ' size=' + Math.round(c.length/1024) + 'KB');
  }
  // Check if file defines Luna namespace
  if (c.includes('Bridge.define("Luna.')) console.log('  ^ defines Luna.* classes');
  if (c.includes('Bridge.define("UnityEngine.')) console.log('  ^ defines UnityEngine.* classes');
}
// Also check if bridge.js has Bridge.define
const bridgeJs = fs.readFileSync(dir + '\\bridge.js', 'utf8');
console.log('\nbridge.js Bridge.define count:', (bridgeJs.match(/Bridge\.define/g) || []).length);
console.log('bridge.js Bridge.assembly count:', (bridgeJs.match(/Bridge\.assembly/g) || []).length);
// Check if Bridge.define is a function after load
