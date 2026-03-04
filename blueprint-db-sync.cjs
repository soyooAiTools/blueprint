#!/usr/bin/env node
/**
 * Blueprint 本地数据库备份同步工具
 * 
 * 功能：
 *   - 定时从 playcools.top API 拉取项目数据，存入本地 SQLite
 *   - 只存有效数据（nodes 非空），防止空数据覆盖
 *   - 自动清理 15 天前的快照
 *   - 支持恢复：node blueprint-db-sync.cjs restore <project_id>
 *   - 支持查看历史：node blueprint-db-sync.cjs history <project_id>
 * 
 * 用法：
 *   node blueprint-db-sync.cjs              # 执行一次同步
 *   node blueprint-db-sync.cjs daemon       # 每小时自动同步
 *   node blueprint-db-sync.cjs restore <id> # 恢复项目数据
 *   node blueprint-db-sync.cjs history <id> # 查看快照历史
 *   node blueprint-db-sync.cjs list         # 列出所有项目最新快照
 */

const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const http = require('http');

// ============ 配置 ============
const DB_PATH = 'D:\\blueprint-backup.db';
const API_BASE = 'https://playcools.top/api';
const RETENTION_DAYS = 15;
const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ============ 数据库初始化 ============
function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      project_name TEXT,
      snapshot_time TEXT NOT NULL DEFAULT (datetime('now')),
      node_count INTEGER NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      blueprint_json TEXT,
      project_json TEXT,
      UNIQUE(project_id, snapshot_time)
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON blueprint_snapshots(project_id, snapshot_time DESC);
    CREATE INDEX IF NOT EXISTS idx_snapshots_time ON blueprint_snapshots(snapshot_time);
  `);
  return db;
}

// ============ HTTP 请求 ============
function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
        }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'PUT',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = mod.request(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ============ 同步逻辑 ============
async function sync() {
  const db = initDB();
  const now = new Date().toISOString();
  console.log(`\n[${now}] 🔄 开始同步...`);

  try {
    // 1. 获取项目列表
    const projects = await fetch(`${API_BASE}/projects`);
    console.log(`  找到 ${projects.length} 个项目`);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO blueprint_snapshots 
        (project_id, project_name, snapshot_time, node_count, edge_count, blueprint_json, project_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const getLatest = db.prepare(`
      SELECT node_count, blueprint_json FROM blueprint_snapshots 
      WHERE project_id = ? ORDER BY snapshot_time DESC LIMIT 1
    `);

    let saved = 0, skipped = 0;

    for (const proj of projects) {
      try {
        // 获取完整项目数据
        const full = await fetch(`${API_BASE}/projects/${proj.id}`);
        const nodes = (full.blueprint && full.blueprint.nodes) || [];
        const edges = (full.blueprint && full.blueprint.edges) || [];

        if (nodes.length === 0) {
          // 空数据，检查是否有历史快照
          const latest = getLatest.get(proj.id);
          if (latest && latest.node_count > 0) {
            console.log(`  ⚠️  ${proj.name} (${proj.id}): nodes=0 但数据库有 ${latest.node_count} 个节点的历史，跳过（保护已有数据）`);
          } else {
            console.log(`  ⏭️  ${proj.name} (${proj.id}): nodes=0，无历史数据，跳过`);
          }
          skipped++;
          continue;
        }

        // 检查是否和最新快照相同（避免重复存储）
        const latest = getLatest.get(proj.id);
        if (latest && latest.node_count === nodes.length) {
          const latestBlueprint = JSON.parse(latest.blueprint_json);
          if (JSON.stringify(latestBlueprint) === JSON.stringify(full.blueprint)) {
            console.log(`  ✅ ${proj.name}: ${nodes.length} nodes，与最新快照相同，跳过`);
            skipped++;
            continue;
          }
        }

        // 存入
        insertStmt.run(
          proj.id,
          proj.name || full.name,
          now,
          nodes.length,
          edges.length,
          JSON.stringify(full.blueprint),
          JSON.stringify(full)
        );
        console.log(`  💾 ${proj.name}: 保存快照，${nodes.length} nodes, ${edges.length} edges`);
        saved++;
      } catch (e) {
        console.error(`  ❌ ${proj.name} (${proj.id}): ${e.message}`);
      }
    }

    // 2. 清理过期数据
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const deleted = db.prepare(`DELETE FROM blueprint_snapshots WHERE snapshot_time < ?`).run(cutoff);
    if (deleted.changes > 0) {
      console.log(`  🗑️  清理了 ${deleted.changes} 条过期快照`);
    }

    console.log(`  完成：保存 ${saved}，跳过 ${skipped}`);
  } catch (e) {
    console.error(`  ❌ 同步失败: ${e.message}`);
  } finally {
    db.close();
  }
}

// ============ 恢复功能 ============
async function restore(projectId) {
  const db = initDB();
  const snapshot = db.prepare(`
    SELECT * FROM blueprint_snapshots 
    WHERE project_id = ? AND node_count > 0
    ORDER BY snapshot_time DESC LIMIT 1
  `).get(projectId);

  if (!snapshot) {
    console.error(`❌ 没有找到项目 ${projectId} 的有效快照`);
    db.close();
    process.exit(1);
  }

  console.log(`📦 找到快照:`);
  console.log(`   项目: ${snapshot.project_name}`);
  console.log(`   时间: ${snapshot.snapshot_time}`);
  console.log(`   Nodes: ${snapshot.node_count}`);
  console.log(`   Edges: ${snapshot.edge_count}`);

  const blueprint = JSON.parse(snapshot.blueprint_json);
  console.log(`\n🔄 正在恢复到服务器...`);

  try {
    const result = await postJSON(
      `${API_BASE}/projects/${projectId}/blueprint`,
      blueprint
    );
    if (result.status === 200) {
      console.log(`✅ 恢复成功！`);
    } else {
      console.error(`❌ 恢复失败: HTTP ${result.status} - ${result.body}`);
    }
  } catch (e) {
    console.error(`❌ 恢复失败: ${e.message}`);
  }

  db.close();
}

// ============ 查看历史 ============
function history(projectId) {
  const db = initDB();
  const rows = db.prepare(`
    SELECT id, project_name, snapshot_time, node_count, edge_count
    FROM blueprint_snapshots 
    WHERE project_id = ?
    ORDER BY snapshot_time DESC
    LIMIT 50
  `).all(projectId);

  if (rows.length === 0) {
    console.log(`没有找到项目 ${projectId} 的快照记录`);
  } else {
    console.log(`\n📋 ${rows[0].project_name} (${projectId}) 快照历史:\n`);
    console.log('  ID   | 时间                      | Nodes | Edges');
    console.log('  -----|---------------------------|-------|------');
    for (const r of rows) {
      console.log(`  ${String(r.id).padEnd(4)} | ${r.snapshot_time.padEnd(25)} | ${String(r.node_count).padEnd(5)} | ${r.edge_count}`);
    }
  }
  db.close();
}

// ============ 列出所有项目 ============
function listAll() {
  const db = initDB();
  const rows = db.prepare(`
    SELECT project_id, project_name, MAX(snapshot_time) as latest, MAX(node_count) as max_nodes,
           COUNT(*) as snapshots
    FROM blueprint_snapshots
    GROUP BY project_id
    ORDER BY latest DESC
  `).all();

  if (rows.length === 0) {
    console.log('数据库为空');
  } else {
    console.log('\n📋 所有项目快照概览:\n');
    for (const r of rows) {
      console.log(`  ${r.project_name} (${r.project_id})`);
      console.log(`    最新快照: ${r.latest} | 最大节点数: ${r.max_nodes} | 共 ${r.snapshots} 个快照`);
    }
  }
  db.close();
}

// ============ 守护模式 ============
async function daemon() {
  console.log(`🔁 守护模式启动，每 ${SYNC_INTERVAL_MS / 60000} 分钟同步一次`);
  console.log(`   数据库: ${DB_PATH}`);
  console.log(`   保留天数: ${RETENTION_DAYS}`);
  await sync();
  setInterval(sync, SYNC_INTERVAL_MS);
}

// ============ 主入口 ============
const cmd = process.argv[2];
const arg = process.argv[3];

switch (cmd) {
  case 'restore':
    if (!arg) { console.error('用法: node blueprint-db-sync.cjs restore <project_id>'); process.exit(1); }
    restore(arg);
    break;
  case 'history':
    if (!arg) { console.error('用法: node blueprint-db-sync.cjs history <project_id>'); process.exit(1); }
    history(arg);
    break;
  case 'list':
    listAll();
    break;
  case 'daemon':
    daemon();
    break;
  default:
    sync();
    break;
}
