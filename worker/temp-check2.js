// Deeper diagnostic: run bridge.js in isolation and see what happens
const fs = require('fs');
const path = require('path');
const dir = 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop\\engine\\unity\\bin';

// Check bridge.js for error-prone patterns
const bridgeJs = fs.readFileSync(path.join(dir, 'bridge.js'), 'utf8');

// Find Bridge.assembly calls
const assemblyMatches = bridgeJs.match(/Bridge\.assembly\([^)]+\)/g);
console.log('Bridge.assembly calls:', assemblyMatches);

// Find where Luna namespace is defined
const lunaDefines = [];
const lines = bridgeJs.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Luna') && (lines[i].includes('define') || lines[i].includes('assembly') || lines[i].includes('namespace'))) {
    lunaDefines.push('L' + (i+1) + ': ' + lines[i].substring(0, 200));
  }
}
console.log('\nLuna definitions in bridge.js:');
lunaDefines.forEach(l => console.log(l));

// Check if "Class extends value undefined" could be from bridge.js
// Search for "extends" pattern
const extendsCount = (bridgeJs.match(/extends\s/g) || []).length;
console.log('\nextends count in bridge.js:', extendsCount);

// Check UnityEngine.js first 500 chars
const ueJs = fs.readFileSync(path.join(dir, 'UnityEngine.js'), 'utf8');
console.log('\nUnityEngine.js first 300 chars:', ueJs.substring(0, 300));
console.log('\nUnityEngine.js "UnityEngine" first occurrence at char:', ueJs.indexOf('UnityEngine'));
