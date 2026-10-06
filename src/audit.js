'use strict';
// 审计日志：只记录"谁、何时、对哪个实体、做了什么"以及少量标量元数据
// （状态、版本号、字数、哈希）。从机制上拒绝正文入日志：
//   - 元数据值必须是标量（string/number/boolean/null）
//   - 字符串值超过 120 字符直接抛错（正文必然超长）
function audit(db, actor, action, entity, entityId, meta = {}) {
  for (const [k, v] of Object.entries(meta)) {
    if (v !== null && typeof v === 'object') {
      throw new Error(`audit meta "${k}" 必须是标量，禁止记录结构化内容`);
    }
    if (typeof v === 'string' && v.length > 120) {
      throw new Error(`audit meta "${k}" 超长，疑似正文，拒绝写入日志`);
    }
  }
  db.run(
    'INSERT INTO audit_log (actor, action, entity, entity_id, meta_json, created_at) VALUES (?,?,?,?,?,?)',
    [String(actor), action, entity, entityId == null ? null : String(entityId),
     JSON.stringify(meta), new Date().toISOString()]
  );
}
module.exports = { audit };
