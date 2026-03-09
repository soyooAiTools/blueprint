/**
 * Luna WebGL Runtime Compatibility Patches
 * 
 * Fixes known issues that prevent Luna builds from running in headless Chromium:
 * 
 * 1. new Event() incompatibility - Playwright/headless Chromium sometimes rejects
 *    `new Event("name")` in dispatchEvent. Replace with document.createEvent().
 * 
 * 2. isActiveAndEnabled null reference - Scene components can have null internal
 *    references during loading, causing `Cannot read properties of null (reading 'enabled')`.
 */

const fs = require('fs');
const path = require('path');

/**
 * Patch all files in stage4 build output for Luna WebGL runtime compatibility
 * 
 * @param {string} stage4Dir - Path to stage4/develop/ directory
 * @param {function} log - Logging function
 * @param {string} taskId - Task ID for logging
 * @returns {object} { patched: boolean, details: string[] }
 */
function patchLunaBuild(stage4Dir, log, taskId) {
  const details = [];

  if (!fs.existsSync(stage4Dir)) {
    log('[LUNA-PATCH] stage4 dir not found: ' + stage4Dir, taskId);
    return { patched: false, details: ['stage4 dir not found'] };
  }

  // === Patch 1: Replace new Event() in iframe.html ===
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (fs.existsSync(iframePath)) {
    let html = fs.readFileSync(iframePath, 'utf8');
    let eventCount = 0;

    // Replace all `new Event("xxx")` with document.createEvent pattern
    html = html.replace(/new Event\("([^"]+)"\)/g, (match, name) => {
      eventCount++;
      return '(function(){var _e=document.createEvent("Event");_e.initEvent("' + name + '",true,true);return _e;})()';
    });

    if (eventCount > 0) {
      fs.writeFileSync(iframePath, html, 'utf8');
      const msg = 'iframe.html: replaced ' + eventCount + ' new Event() calls';
      details.push(msg);
      log('[LUNA-PATCH] ' + msg, taskId);
    }
  }

  // === Patch 2: Replace new Event() in Luna engine scripts ===
  const engineDirs = [
    path.join(stage4Dir, 'engine', 'luna'),
    path.join(stage4Dir, 'engine', 'unity', 'bin'),
    path.join(stage4Dir, 'js')
  ];

  for (const dir of engineDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      let content = fs.readFileSync(filePath, 'utf8');
      let changed = false;

      // Replace new Event("xxx")
      let evtCount = 0;
      const newContent = content.replace(/new Event\("([^"]+)"\)/g, (match, name) => {
        evtCount++;
        return '(function(){var _e=document.createEvent("Event");_e.initEvent("' + name + '",true,true);return _e;})()';
      });
      if (evtCount > 0) {
        content = newContent;
        changed = true;
        details.push(file + ': ' + evtCount + ' Event() fixes');
      }

      // === Patch 3: Fix isActiveAndEnabled null reference in UnityEngine.js ===
      if (file === 'UnityEngine.js' || file.startsWith('UnityEngine')) {
        // Find the exact isActiveAndEnabled getter pattern:
        // return this.XXX$.enabled&&this.YYY$.ZZZ$
        // This is inside Behaviour$1 definition
        const iaaPattern = /return this\.(\w+)\$\.enabled&&this\.(\w+)\$\.(\w+)\$/g;
        let iaaCount = 0;
        content = content.replace(iaaPattern, (match, a, b, c) => {
          iaaCount++;
          return 'return (this.' + a + '$?this.' + a + '$.enabled:false)&&(this.' + b + '$?this.' + b + '$.' + c + '$:false)';
        });
        if (iaaCount > 0) {
          changed = true;
          details.push(file + ': ' + iaaCount + ' isActiveAndEnabled null-check fixes');
        }
      }

      if (changed) {
        fs.writeFileSync(filePath, content, 'utf8');
        log('[LUNA-PATCH] ' + file + ': patched', taskId);
      }
    }
  }

  const patched = details.length > 0;
  if (patched) {
    log('[LUNA-PATCH] Applied ' + details.length + ' patches total', taskId);
  } else {
    log('[LUNA-PATCH] No patches needed', taskId);
  }

  return { patched, details };
}

module.exports = { patchLunaBuild };
