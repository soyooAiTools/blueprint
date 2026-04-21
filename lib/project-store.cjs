/**
 * ProjectStore — CRUD for project JSON files
 * Extracted from server.cjs readProject/writeProject/listProjects/generateId
 */
const fs = require('fs');
const path = require('path');
const config = require('./config.cjs');

const PROJECTS_DIR = config.PROJECTS_DIR;
const BACKUP_DIR = '/opt/blueprint-backups';

// Ensure dirs exist
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

function readProject(id) {
  var filePath = path.join(PROJECTS_DIR, id + '.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeProject(project) {
  var filePath = path.join(PROJECTS_DIR, project.id + '.json');
  // Auto-backup: keep last version before overwrite
  if (fs.existsSync(filePath)) {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var backupPath = path.join(BACKUP_DIR, project.id + '.' + ts + '.json');
    try { fs.copyFileSync(filePath, backupPath); } catch(e) { console.error('[backup] Failed:', e.message); }
    // Keep max 20 backups per project
    try {
      var prefix = project.id + '.';
      var backups = fs.readdirSync(BACKUP_DIR).filter(function(f) { return f.startsWith(prefix); }).sort();
      while (backups.length > 20) {
        fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
      }
    } catch(e) { /* ignore prune errors */ }
  }
  fs.writeFileSync(filePath, JSON.stringify(project, null, 2), 'utf-8');
}

function listProjects() {
  var files = fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); });
  var results = [];
  files.forEach(function(f) {
    try {
      var data = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || !data.id) {
        console.error('[listProjects] Skipping malformed file (not a project object): ' + f);
        return;
      }
      var blueprint = data.blueprint;
      var summary = Object.assign({}, data);
      delete summary.blueprint;
      summary.entityCount = (blueprint && blueprint.entities ? blueprint.entities.length : 0);
      summary.phaseCount = (blueprint && blueprint.phases ? blueprint.phases.length : 0);
      results.push(summary);
    } catch(e) {
      console.error('[listProjects] Skipping corrupt file: ' + f + ' — ' + e.message);
    }
  });
  return results;
}

function generateId() {
  return 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function deleteProject(id) {
  var filePath = path.join(PROJECTS_DIR, id + '.json');
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

module.exports = {
  readProject: readProject,
  writeProject: writeProject,
  listProjects: listProjects,
  generateId: generateId,
  deleteProject: deleteProject,
  PROJECTS_DIR: PROJECTS_DIR,
};
