const fs = require('fs');
const logPath = 'C:/Users/Administrator/AppData/Local/Unity/Editor/Editor.log';
try {
  const log = fs.readFileSync(logPath, 'utf-8');
  const lines = log.split('\n');
  // Show last 80 lines
  console.log('=== Last 80 lines ===');
  console.log(lines.slice(-80).join('\n'));
  // Search for key terms
  console.log('\n=== Key matches ===');
  const keywords = /error|safe mode|luna|bridge|18801|fatal|exception|license/i;
  lines.forEach((l, i) => {
    if (keywords.test(l)) console.log(`L${i}: ${l.substring(0, 200)}`);
  });
} catch (e) {
  console.log('Cannot read log: ' + e.message);
}
