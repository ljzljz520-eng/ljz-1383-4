'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseAttachment } = require('./wordcount');
const { audit } = require('./audit');

const POLICY_VERSION = 'retention-v1';
const DEFAULT_RETENTION_DAYS = 30;

// 计价模型：每千单位基准价 × 领域系数 × 保密系数
const RATES_PER_1K = { 'zh-en': 320, 'en-zh': 300, 'ja-zh': 350, 'en-ja': 380, 'default': 280 };
const DOMAIN_MULT = { legal: 1.3, medical: 1.4, marketing: 1.1, tech: 1.15, general: 1.0 };
const CONF_MULT = { public: 1.0, confidential: 1.15, secret: 1.4 };
const ESTIMATE_BAND = 0.35;  // 预估询价 ±35%（不看原文，准确度低）
const FORMAL_BAND = 0.05;    // 正式评估 ±5%（按实际解析字数）

function httpError(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}
const now = () => new Date().toISOString();

function price(langPair, domain, confidentiality, units) {
  const rate = RATES_PER_1K[langPair] ?? RATES_PER_1K.default;
  const dm = DOMAIN_MULT[domain] ?? 1.0;
  const cm = CONF_MULT[confidentiality] ?? 1.0;
  return Math.round((units / 1000) * rate * dm * cm * 100) / 100;
}

/* ================= 案例与素材许可 ================= */

function createCase(db, actor, d) {
  for (const f of ['title', 'lang_pair', 'domain', 'summary', 'role', 'challenges']) {
    if (!d[f]) throw httpError(400, 'missing_field', `缺少字段 ${f}`);
  }
  const id = db.run('INSERT INTO cases (title,lang_pair,domain,summary,role,challenges,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [d.title, d.lang_pair, d.domain, d.summary, d.role, d.challenges, 'published', now()]);
  audit(db, actor, 'case.create', 'case', id, { domain: d.domain, lang_pair: d.lang_pair });
  return db.get('SELECT * FROM cases WHERE id=?', [id]);
}

// 源文 / 译文 / 对照批注 各自独立许可
function addMaterial(db, actor, caseId, { kind, license, content }) {
  if (!['source', 'translation', 'annotation'].includes(kind)) throw httpError(400, 'bad_kind', 'kind 须为 source|translation|annotation');
  if (!['public', 'client-authorized', 'private'].includes(license)) throw httpError(400, 'bad_license', 'license 须为 public|client-authorized|private');
  if (!db.get('SELECT id FROM cases WHERE id=?', [caseId])) throw httpError(404, 'case_not_found', '案例不存在');
  const id = db.run('INSERT INTO case_materials (case_id,kind,license,content,updated_at) VALUES (?,?,?,?,?)',
    [caseId, kind, license, content, now()]);
  audit(db, actor, 'case.material.add', 'case_material', id, { case_id: caseId, kind, license });
  return db.get('SELECT * FROM case_materials WHERE id=?', [id]);
}

function withdrawCase(db, actor, caseId) {
  const n = db.runCas("UPDATE cases SET status='withdrawn' WHERE id=? AND status='published'", [caseId]);
  if (!n) throw httpError(404, 'case_not_found', '案例不存在或已撤下');
  audit(db, actor, 'case.withdraw', 'case', caseId, {});
  return db.get('SELECT * FROM cases WHERE id=?', [caseId]);
}

const publicCaseFields = c => ({ id: c.id, title: c.title, lang_pair: c.lang_pair, domain: c.domain,
  summary: c.summary, role: c.role, challenges: c.challenges });

function listCases(db, { lang, domain } = {}) {
  let rows = db.all("SELECT * FROM cases WHERE status='published' ORDER BY id");
  if (lang) rows = rows.filter(r => r.lang_pair === lang);
  if (domain) rows = rows.filter(r => r.domain === domain);
  return rows.map(publicCaseFields);
}

// 公开详情：只放行 license='public' 的素材；摘要公开 ≠ 原文公开
function getPublicCase(db, caseId) {
  const c = db.get("SELECT * FROM cases WHERE id=? AND status='published'", [caseId]);
  if (!c) throw httpError(404, 'case_not_found', '案例不存在或已撤下');
  const materials = db.all(
    "SELECT id,kind,license,content FROM case_materials WHERE case_id=? AND license='public'", [caseId]);
  return { ...publicCaseFields(c), materials };
}

// 搜索索引只覆盖公开内容：标题/摘要/角色/难点 + public 素材。
// 仅摘要公开的案例，其源文/译文/批注不会进入索引。
function searchCases(db, q) {
  if (!q || !q.trim()) return [];
  const needle = q.trim().toLowerCase();
  const results = [];
  for (const c of db.all("SELECT * FROM cases WHERE status='published'")) {
    const publicMats = db.all(
      "SELECT kind,content FROM case_materials WHERE case_id=? AND license='public'", [c.id]);
    const hay = [c.title, c.summary, c.role, c.challenges, ...publicMats.map(m => m.content)]
      .join('\n').toLowerCase();
    if (hay.includes(needle)) results.push(publicCaseFields(c));
  }
  return results;
}

// 下载包：与公开详情同一过滤口径，保证不泄露受限素材
function buildPackage(db, caseId) {
  const view = getPublicCase(db, caseId);
  return {
    package: `case-${caseId}-public`,
    generated_at: now(),
    license_note: '本包仅含 license=public 的素材；源文/译文/批注许可各自独立，受限素材不包含在内。',
    ...view,
  };
}

/* ================= 委托与两阶段报价 ================= */

function createInquiry(db, actor, d) {
  for (const f of ['client_email', 'lang_pair', 'domain', 'confidentiality', 'summary']) {
    if (!d[f]) throw httpError(400, 'missing_field', `缺少字段 ${f}`);
  }
  if (!['public', 'confidential', 'secret'].includes(d.confidentiality)) {
    throw httpError(400, 'bad_confidentiality', '保密级别须为 public|confidential|secret');
  }
  const token = crypto.randomUUID();
  const id = db.run('INSERT INTO inquiries (client_email,client_token,lang_pair,domain,confidentiality,summary,declared_units,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.client_email, token, d.lang_pair, d.domain, d.confidentiality, d.summary,
     d.declared_units ?? null, 'open', now()]);
  // 日志只记元数据；摘要正文不进日志
  audit(db, actor, 'inquiry.create', 'inquiry', id,
    { domain: d.domain, lang_pair: d.lang_pair, confidentiality: d.confidentiality });
  return { ...db.get('SELECT * FROM inquiries WHERE id=?', [id]), client_token: token };
}

function getInquiry(db, id) {
  const iq = db.get('SELECT * FROM inquiries WHERE id=?', [id]);
  if (!iq) throw httpError(404, 'inquiry_not_found', '委托不存在');
  return iq;
}

function nextQuoteVersion(db, inquiryId) {
  const r = db.get('SELECT MAX(version) AS v FROM quotes WHERE inquiry_id=?', [inquiryId]);
  return (r.v || 0) + 1;
}

// 阶段一：预估询价 —— 不接收原文，只按客户自报字数估算
function issueEstimate(db, actor, inquiryId) {
  const iq = getInquiry(db, inquiryId);
  if (iq.status === 'cancelled') throw httpError(409, 'inquiry_cancelled', '委托已取消');
  if (!iq.declared_units || iq.declared_units <= 0) {
    throw httpError(422, 'declared_units_required', '预估询价需要客户自报字数（declared_units）');
  }
  const v = nextQuoteVersion(db, inquiryId);
  db.run("UPDATE quotes SET status='superseded' WHERE inquiry_id=? AND status='sent'", [inquiryId]);
  const amount = price(iq.lang_pair, iq.domain, iq.confidentiality, iq.declared_units);
  const id = db.run('INSERT INTO quotes (inquiry_id,version,type,attachment_id,attachment_version,units,amount,currency,accuracy_band,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [inquiryId, v, 'estimate', null, null, iq.declared_units, amount, 'CNY', ESTIMATE_BAND, 'sent', now()]);
  db.run("UPDATE inquiries SET status='estimated' WHERE id=? AND status='open'", [inquiryId]);
  audit(db, actor, 'quote.estimate', 'quote', id, { inquiry_id: inquiryId, version: v, units: iq.declared_units, amount });
  return db.get('SELECT * FROM quotes WHERE id=?', [id]);
}

// 阶段二：上传受限附件（固定格式），触发旧正式报价失效
function uploadAttachment(db, actor, inquiryId, filename, content, storageDir) {
  const iq = getInquiry(db, inquiryId);
  if (iq.status === 'cancelled') throw httpError(409, 'inquiry_cancelled', '委托已取消');
  const parsed = parseAttachment(filename, content);   // 固定格式解析，不合格即 415/422
  const prev = db.get('SELECT MAX(version) AS v FROM attachments WHERE inquiry_id=?', [inquiryId]);
  const version = (prev.v || 0) + 1;
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const sizeBytes = Buffer.byteLength(content, 'utf8');

  return db.tx(() => {
    // 源文件替换：旧版本标记 replaced
    db.run("UPDATE attachments SET status='replaced' WHERE inquiry_id=? AND status='active'", [inquiryId]);
    // 附件修订后，原正式报价不能自动适用 → 全部置 stale
    db.run("UPDATE quotes SET status='stale' WHERE inquiry_id=? AND type='formal' AND status='sent'", [inquiryId]);
    const dir = path.join(storageDir, `inquiry_${inquiryId}`);
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, `v${version}_${path.basename(filename)}`);
    fs.writeFileSync(storagePath, content, 'utf8');
    const id = db.run('INSERT INTO attachments (inquiry_id,version,filename,format,source_units,target_units,billable_units,size_bytes,sha256,storage_path,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [inquiryId, version, filename, parsed.format, parsed.sourceUnits, parsed.targetUnits,
       parsed.billableUnits, sizeBytes, sha256, storagePath, 'active', now()]);
    db.run("UPDATE inquiries SET status='files_received' WHERE id=? AND status IN ('open','estimated','quoted')", [inquiryId]);
    // 日志只记哈希与计数，不记正文
    audit(db, actor, 'attachment.upload', 'attachment', id,
      { inquiry_id: inquiryId, version, format: parsed.format, billable_units: parsed.billableUnits, sha256 });
    return db.get('SELECT id,inquiry_id,version,filename,format,source_units,target_units,billable_units,size_bytes,sha256,status,created_at FROM attachments WHERE id=?', [id]);
  });
}

// 阶段二：正式评估 —— 必须基于当前有效附件的实际计费字数
function issueFormalQuote(db, actor, inquiryId) {
  const iq = getInquiry(db, inquiryId);
  if (iq.status === 'cancelled') throw httpError(409, 'inquiry_cancelled', '委托已取消');
  const att = db.get("SELECT * FROM attachments WHERE inquiry_id=? AND status='active'", [inquiryId]);
  if (!att) throw httpError(422, 'attachment_required', '正式评估需要先上传有效附件');
  const v = nextQuoteVersion(db, inquiryId);
  return db.tx(() => {
    db.run("UPDATE quotes SET status='superseded' WHERE inquiry_id=? AND status='sent'", [inquiryId]);
    const amount = price(iq.lang_pair, iq.domain, iq.confidentiality, att.billable_units);
    const id = db.run('INSERT INTO quotes (inquiry_id,version,type,attachment_id,attachment_version,units,amount,currency,accuracy_band,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [inquiryId, v, 'formal', att.id, att.version, att.billable_units, amount, 'CNY', FORMAL_BAND, 'sent', now()]);
    db.run("UPDATE inquiries SET status='quoted' WHERE id=?", [inquiryId]);
    audit(db, actor, 'quote.formal', 'quote', id,
      { inquiry_id: inquiryId, version: v, attachment_version: att.version, units: att.billable_units, amount });
    return db.get('SELECT * FROM quotes WHERE id=?', [id]);
  });
}

// 客户确认：对象是明确的报价版本（quote id + version）。
// CAS 保证并发下只有一份报价能被批准；旧版本/失效版本一律 409。
function approveQuote(db, actor, quoteId, version) {
  return db.tx(() => {
    const q = db.get('SELECT * FROM quotes WHERE id=?', [quoteId]);
    if (!q) throw httpError(404, 'quote_not_found', '报价不存在');
    if (q.version !== version) {
      throw httpError(409, 'version_mismatch', `确认的版本 v${version} 与报价当前版本 v${q.version} 不一致`);
    }
    if (q.status !== 'sent') {
      const why = { superseded: '已被更新报价取代', stale: '附件已修订，原报价不能自动适用', approved: '已被批准' }[q.status] || q.status;
      throw httpError(409, 'quote_not_approvable', `报价状态 ${q.status}：${why}`);
    }
    if (q.type === 'formal') {
      const att = db.get("SELECT * FROM attachments WHERE id=? AND status='active'", [q.attachment_id]);
      if (!att || att.version !== q.attachment_version) {
        throw httpError(409, 'attachment_revised', '报价所基于的附件已被修订，须重新出具正式报价');
      }
    }
    const dup = db.get("SELECT id FROM quotes WHERE inquiry_id=? AND status='approved'", [q.inquiry_id]);
    if (dup) throw httpError(409, 'already_approved', `委托已批准报价 #${dup.id}，不能重复批准`);
    const n = db.runCas("UPDATE quotes SET status='approved', approved_at=? WHERE id=? AND version=? AND status='sent'",
      [now(), quoteId, version]);
    if (!n) throw httpError(409, 'concurrent_modification', '报价已被并发修改，请刷新后重试');
    db.run("UPDATE inquiries SET status='approved' WHERE id=?", [q.inquiry_id]);
    audit(db, actor, 'quote.approve', 'quote', quoteId, { inquiry_id: q.inquiry_id, version, amount: q.amount });
    return db.get('SELECT * FROM quotes WHERE id=?', [quoteId]);
  });
}

// 委托取消 → 附件进入留存期（默认 30 天），到期可验证删除，而不是只删列表项
function cancelInquiry(db, actor, inquiryId, retentionDays = DEFAULT_RETENTION_DAYS) {
  const iq = getInquiry(db, inquiryId);
  if (iq.status === 'approved') throw httpError(409, 'already_approved', '已批准的委托不能取消');
  return db.tx(() => {
    db.run("UPDATE inquiries SET status='cancelled' WHERE id=?", [inquiryId]);
    const deleteAfter = Date.now() + retentionDays * 24 * 3600 * 1000;
    db.run("UPDATE attachments SET status='pending_deletion', delete_after=? WHERE inquiry_id=? AND status IN ('active','replaced')",
      [deleteAfter, inquiryId]);
    db.run("UPDATE quotes SET status='superseded' WHERE inquiry_id=? AND status='sent'", [inquiryId]);
    audit(db, actor, 'inquiry.cancel', 'inquiry', inquiryId, { retention_days: retentionDays, policy: POLICY_VERSION });
    return db.get('SELECT * FROM inquiries WHERE id=?', [inquiryId]);
  });
}

/* ================= 留存策略：可验证删除 ================= */

// 到期清除：真实删除文件字节，并留下 tombstone（内容哈希 + 策略版本）作为可验证凭证
function runRetention(db, actor, nowMs = Date.now()) {
  const due = db.all("SELECT * FROM attachments WHERE status='pending_deletion' AND delete_after<=?", [nowMs]);
  const purged = [];
  for (const att of due) {
    db.tx(() => {
      if (att.storage_path && fs.existsSync(att.storage_path)) fs.unlinkSync(att.storage_path);
      db.run('INSERT INTO tombstones (attachment_id,inquiry_id,sha256,size_bytes,reason,policy_version,deleted_at) VALUES (?,?,?,?,?,?,?)',
        [att.id, att.inquiry_id, att.sha256, att.size_bytes, 'commission_cancelled', POLICY_VERSION, now()]);
      db.run("UPDATE attachments SET status='deleted', storage_path=NULL WHERE id=?", [att.id]);
      audit(db, actor, 'attachment.purge', 'attachment', att.id,
        { inquiry_id: att.inquiry_id, sha256: att.sha256, policy: POLICY_VERSION });
    });
    purged.push({ attachment_id: att.id, sha256: att.sha256 });
  }
  return purged;
}

// 验证：tombstone 记录的哈希与上传时一致、文件确实不存在、无逾期未清附件
function verifyRetention(db) {
  const items = [];
  let ok = true;
  for (const t of db.all('SELECT * FROM tombstones ORDER BY id')) {
    const att = db.get('SELECT * FROM attachments WHERE id=?', [t.attachment_id]);
    const fileGone = !att.storage_path && att.status === 'deleted';
    const hashMatches = att.sha256 === t.sha256;
    if (!fileGone || !hashMatches) ok = false;
    items.push({ tombstone_id: t.id, attachment_id: t.attachment_id, sha256: t.sha256,
      file_removed: fileGone, hash_matches: hashMatches, deleted_at: t.deleted_at, policy: t.policy_version });
  }
  const overdue = db.all("SELECT id FROM attachments WHERE status='pending_deletion' AND delete_after<=?", [Date.now()]);
  if (overdue.length) ok = false;
  const retained = db.all("SELECT id,inquiry_id,delete_after FROM attachments WHERE status='pending_deletion'")
    .map(a => ({ attachment_id: a.id, inquiry_id: a.inquiry_id, delete_after: new Date(a.delete_after).toISOString() }));
  return { verified: ok, deleted: items, retained_pending: retained, overdue };
}

/* ================= 限时授权链接 ================= */

function createShareLink(db, actor, { scope, target_id, ttl_seconds }) {
  if (!['attachment', 'case-material'].includes(scope)) throw httpError(400, 'bad_scope', 'scope 须为 attachment|case-material');
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + (ttl_seconds ?? 3600) * 1000;
  db.run('INSERT INTO share_links (token,scope,target_id,expires_at,revoked,created_at) VALUES (?,?,?,?,0,?)',
    [token, scope, target_id, expiresAt, now()]);
  audit(db, actor, 'share.create', 'share_link', token.slice(0, 8), { scope, target_id, ttl_seconds: ttl_seconds ?? 3600 });
  return { token, scope, target_id, expires_at: new Date(expiresAt).toISOString() };
}

function accessShareLink(db, token, nowMs = Date.now()) {
  const link = db.get('SELECT * FROM share_links WHERE token=?', [token]);
  if (!link) throw httpError(404, 'link_not_found', '授权链接不存在');
  if (link.revoked) throw httpError(410, 'link_revoked', '授权链接已被撤销');
  if (link.expires_at <= nowMs) throw httpError(410, 'link_expired', '授权链接已过期');
  if (link.scope === 'attachment') {
    const att = db.get('SELECT * FROM attachments WHERE id=?', [link.target_id]);
    if (!att || att.status === 'deleted') throw httpError(410, 'attachment_gone', '附件已按留存策略删除');
    const content = fs.readFileSync(att.storage_path, 'utf8');
    audit(db, 'share:' + token.slice(0, 8), 'share.access', 'attachment', att.id, { inquiry_id: att.inquiry_id });
    return { scope: 'attachment', filename: att.filename, version: att.version, content };
  }
  const m = db.get('SELECT * FROM case_materials WHERE id=?', [link.target_id]);
  if (!m) throw httpError(404, 'material_not_found', '素材不存在');
  audit(db, 'share:' + token.slice(0, 8), 'share.access', 'case_material', m.id, { case_id: m.case_id, kind: m.kind });
  return { scope: 'case-material', kind: m.kind, license: m.license, content: m.content };
}

function revokeShareLink(db, actor, token) {
  const n = db.runCas('UPDATE share_links SET revoked=1 WHERE token=? AND revoked=0', [token]);
  if (!n) throw httpError(404, 'link_not_found', '授权链接不存在或已撤销');
  audit(db, actor, 'share.revoke', 'share_link', token.slice(0, 8), {});
  return { revoked: true };
}

/* ================= 参与者可见性 ================= */

// 后台材料仅向必要参与者开放：译者(admin) + 该委托客户本人 + 有效分享链接持有者
function canAccessAttachment(db, att, principal) {
  if (principal.admin) return true;
  if (principal.clientToken) {
    const iq = db.get('SELECT client_token FROM inquiries WHERE id=?', [att.inquiry_id]);
    if (iq && iq.client_token === principal.clientToken) return true;
  }
  return false;
}

function readAttachment(db, actor, attId, principal) {
  const att = db.get('SELECT * FROM attachments WHERE id=?', [attId]);
  if (!att) throw httpError(404, 'attachment_not_found', '附件不存在');
  if (!canAccessAttachment(db, att, principal)) {
    throw httpError(403, 'forbidden', '仅委托参与者可访问该材料');
  }
  if (att.status === 'deleted') throw httpError(410, 'attachment_purged', '附件已按留存策略删除');
  audit(db, actor, 'attachment.read', 'attachment', attId, { inquiry_id: att.inquiry_id, version: att.version });
  return { filename: att.filename, version: att.version, format: att.format, content: fs.readFileSync(att.storage_path, 'utf8') };
}

module.exports = {
  POLICY_VERSION, DEFAULT_RETENTION_DAYS, ESTIMATE_BAND, FORMAL_BAND, RATES_PER_1K, DOMAIN_MULT, CONF_MULT,
  httpError, price,
  createCase, addMaterial, withdrawCase, listCases, getPublicCase, searchCases, buildPackage,
  createInquiry, getInquiry, issueEstimate, uploadAttachment, issueFormalQuote, approveQuote, cancelInquiry,
  runRetention, verifyRetention,
  createShareLink, accessShareLink, revokeShareLink,
  readAttachment,
};
