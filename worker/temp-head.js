const fs = require('fs');
const f = 'D:/work/test-luna/LunaTemp/stage4/develop/engine/luna/script1.js';
const c = fs.readFileSync(f, 'utf8');
console.log('First 200 chars:');
console.log(c.substring(0, 200));
console.log('\nChar at pos 26:', JSON.stringify(c.charAt(25)), '(code:', c.charCodeAt(25), ')');
console.log('Chars 20-35:', JSON.stringify(c.substring(19, 35)));
