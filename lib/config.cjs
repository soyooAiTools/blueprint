/**
 * Centralized configuration — all paths, ports, constants
 */
const path = require('path');

const __dir = path.join(__dirname, '..');

const config = {
  PORT: process.env.PORT || 3901,
  LUNA_VERSION: '7.1.0',

  // Directories
  DATA_DIR:       path.join(__dir, 'server-data'),
  PROJECTS_DIR:   path.join(__dir, 'server-data', 'projects'),
  WEBGL_DIR:      path.join(__dir, 'server-data', 'webgl'),
  DIST_DIR:       path.join(__dir, 'dist'),
  AUTOCODING_DIR: path.join(__dir, '..', 'autoCoding-tasks'),

  // Wake signal for OpenClaw
  WAKE_SIGNAL_FILE: path.join(__dir, '..', 'autoCoding-tasks', 'wake-signal.json'),

  // Parse stats
  PARSE_STATS_FILE: path.join(__dir, 'server-data', 'parse-stats.json'),

  // MIME types
  MIME: {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.wasm': 'application/wasm',
  },
};

module.exports = config;
