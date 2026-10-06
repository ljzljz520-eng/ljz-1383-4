'use strict';
// 审计日志：只记录行为与元数据，绝不写正文。
// 通过拒绝键名 + 标量化 + 截断三道防线保证“日志不写正文”。
const fs = require('fs');

const DENY_KEYS = new Set(['content', 'text', 'summary', 'source', 'translation', 'body', 'payload', 'file', 'attachment']);

function sanitizeMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (DENY_KEYS.has(String(k).toLowerCase())) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 64);
  }
  return out;
}

class AuditLog {
  constructor(file) { this.file = file || null; }
  record(actor, action, objectType, objectId, meta) {
    const entry = {
      ts: new Date().toISOString(),
      actor, action, objectType, objectId,
      meta: sanitizeMeta(meta),
    };
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }
}
module.exports = { AuditLog };
