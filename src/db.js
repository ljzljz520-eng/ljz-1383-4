'use strict';
// 持久化层：sql.js (WASM SQLite)，每次写操作后落盘，重启可恢复。
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  lang_pair TEXT NOT NULL,
  domain TEXT NOT NULL,
  summary TEXT NOT NULL,          -- 公开摘要
  role TEXT NOT NULL,             -- 译者在项目中的真实角色
  challenges TEXT NOT NULL,       -- 项目难点
  status TEXT NOT NULL DEFAULT 'published',  -- published | withdrawn
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL CHECK (kind IN ('source','translation','annotation')), -- 源文/译文/对照批注
  license TEXT NOT NULL CHECK (license IN ('public','client-authorized','private')), -- 分开管理许可
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_email TEXT NOT NULL,
  client_token TEXT NOT NULL,     -- 客户访问自己委托的凭证
  lang_pair TEXT NOT NULL,
  domain TEXT NOT NULL,
  confidentiality TEXT NOT NULL CHECK (confidentiality IN ('public','confidential','secret')),
  summary TEXT NOT NULL,
  declared_units INTEGER,         -- 客户自报字数（预估阶段用）
  status TEXT NOT NULL DEFAULT 'open', -- open|estimated|files_received|quoted|approved|cancelled
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  version INTEGER NOT NULL,       -- 同一委托内的附件修订版本
  filename TEXT NOT NULL,
  format TEXT NOT NULL,           -- plain-v1 | bilingual-v1
  source_units INTEGER NOT NULL,
  target_units INTEGER NOT NULL,
  billable_units INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,           -- 内容哈希，留存验证用
  storage_path TEXT,              -- 删除后置 NULL
  status TEXT NOT NULL DEFAULT 'active', -- active|replaced|pending_deletion|deleted
  delete_after INTEGER,           -- epoch ms，留存到期时间
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id),
  version INTEGER NOT NULL,       -- 报价版本（客户确认的对象）
  type TEXT NOT NULL CHECK (type IN ('estimate','formal')),
  attachment_id INTEGER,          -- 正式报价绑定的附件
  attachment_version INTEGER,
  units INTEGER NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  accuracy_band REAL NOT NULL,    -- 估算准确度区间
  status TEXT NOT NULL DEFAULT 'sent', -- sent|superseded|stale|approved
  created_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('attachment','case-material')),
  target_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,    -- epoch ms
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',  -- 只允许标量短值，绝不写正文
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id INTEGER NOT NULL,
  inquiry_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,           -- 被删内容的哈希，删除可验证
  size_bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);
`;

async function createDb(dbPath = null) {
  const SQL = await initSqlJs();
  const db = (dbPath && fs.existsSync(dbPath))
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();
  db.run(SCHEMA);

  const persist = () => {
    if (!dbPath) return;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  };

  // 注意：db.export() 会重置 last_insert_rowid()，因此必须在 persist 之前捕获。
  let inTx = false;
  // 执行写操作；返回 last_insert_rowid（INSERT 时为自增 id）
  const run = (sql, params = []) => {
    db.run(sql, params);
    const r = db.exec('SELECT last_insert_rowid() AS id');
    const insertId = r.length ? r[0].values[0][0] : 0;
    if (!inTx) persist();
    return insertId;
  };
  // 条件更新（CAS）：返回受影响行数，用于并发控制
  const runCas = (sql, params = []) => {
    db.run(sql, params);
    const n = db.getRowsModified();
    if (!inTx) persist();
    return n;
  };
  const get = (sql, params = []) => {
    const stmt = db.prepare(sql); stmt.bind(params);
    const row = stmt.step() ? stmt.getAsObject() : null; stmt.free(); return row;
  };
  const all = (sql, params = []) => {
    const stmt = db.prepare(sql); stmt.bind(params);
    const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
  };
  const tx = (fn) => {
    db.run('BEGIN'); inTx = true;
    try { const r = fn(); db.run('COMMIT'); inTx = false; persist(); return r; }
    catch (e) { inTx = false; db.run('ROLLBACK'); throw e; }
  };
  return { db, run, runCas, get, all, tx, persist };
}

module.exports = { createDb };
