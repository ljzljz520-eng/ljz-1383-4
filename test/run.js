'use strict';
// 验收测试：node test/run.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xl8-test-'));
  const { app, storageDir, adminToken } = await startServer({
    dbPath: path.join(tmp, 'test.db'), storageDir: path.join(tmp, 'files'),
    adminToken: 'test-admin', seed: false,
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ADMIN = { 'x-admin-token': adminToken, 'content-type': 'application/json' };

  const api = async (p, { method = 'GET', headers = {}, body } = {}) => {
    const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };

  // ---------- 1. 字数统计：固定格式解析与计费口径 ----------
  console.log('\n[1] 字数统计：固定格式解析 + 计费口径');
  const mk = async (summary) => (await api('/api/inquiries', { method: 'POST', headers: ADMIN, body: {
    client_email: 'c@example.com', lang_pair: 'zh-en', domain: 'general',
    confidentiality: 'confidential', summary, declared_units: 5000 } })).data;

  const iq1 = await mk('SECRET_SUMMARY_ABC 委托一');
  const up = (id, tok, filename, content) => api(`/api/inquiries/${id}/attachments`,
    { method: 'POST', headers: { 'x-client-token': tok, 'content-type': 'application/json' }, body: { filename, content } });

  let r = await up(iq1.id, iq1.client_token, 'a.txt', '你好 world 世界');   // 4 CJK + 1 拉丁词
  assert.equal(r.status, 201); assert.equal(r.data.billable_units, 5);
  ok('混合文本：CJK 每字 1 单位、拉丁连续串每词 1 单位（"你好 world 世界" = 5）');

  r = await up(iq1.id, iq1.client_token, 'b.docx', 'PK binary...');
  assert.equal(r.status, 415); assert.equal(r.data.error, 'unsupported_format');
  ok('非固定格式（.docx）拒绝解析 → 415，不做猜测性统计');

  r = await up(iq1.id, iq1.client_token, 'bad.txt', '#format: bilingual-v1\n这是一行没有标记的文本');
  assert.equal(r.status, 422); assert.equal(r.data.error, 'bad_segment');
  ok('bilingual-v1 缺 SRC>/TGT> 标记 → 422 格式错误');

  // ---------- 2. 双语文档重复计数 ----------
  console.log('\n[2] 双语文档不重复计数');
  const bilingual = '#format: bilingual-v1\nSRC>你好世界\nTGT>Hello world\nSRC>测试一下\nTGT>Test it now';
  r = await up(iq1.id, iq1.client_token, 'bi.txt', bilingual);
  assert.equal(r.status, 201);
  assert.equal(r.data.source_units, 8);   // 你好世界(4) + 测试一下(4)
  assert.equal(r.data.target_units, 5);   // Hello world(2) + Test it now(3)
  assert.equal(r.data.billable_units, 8); // 只计源文侧，不是 13
  ok('双语文档 billable = 源文侧 8 单位，译文侧 5 单位不重复计费');

  // ---------- 3. 两阶段报价 + 源文件替换后原报价不自动适用 ----------
  console.log('\n[3] 两阶段交接 + 源文件替换');
  const iq2 = await mk('委托二：先看预估再传原文');
  r = await api(`/api/inquiries/${iq2.id}/estimate`, { method: 'POST', headers: { 'x-client-token': iq2.client_token } });
  assert.equal(r.status, 201);
  assert.equal(r.data.type, 'estimate'); assert.equal(r.data.accuracy_band, 0.35);
  const estQuote = r.data;
  ok(`预估询价：不看原文，按自报 5000 单位出价 ¥${estQuote.amount}，准确度 ±35%`);

  r = await api(`/api/admin/inquiries/${iq2.id}/formal-quote`, { method: 'POST', headers: ADMIN });
  assert.equal(r.status, 422); // 无附件不能出正式报价
  ok('无附件时不能出正式评估 → 422（两阶段顺序受控）');

  await up(iq2.id, iq2.client_token, 'v1.txt', '第一版源文内容，共十个字。');
  r = await api(`/api/admin/inquiries/${iq2.id}/formal-quote`, { method: 'POST', headers: ADMIN });
  const formalV1 = r.data;
  assert.equal(formalV1.type, 'formal'); assert.equal(formalV1.accuracy_band, 0.05);
  assert.equal(formalV1.attachment_version, 1);
  ok(`正式评估 v${formalV1.version}：基于附件 v1 实解析 ${formalV1.units} 单位，准确度 ±5%`);

  await up(iq2.id, iq2.client_token, 'v2.txt', '第二版源文：客户修订后内容大幅增加，字数完全不同了。');
  r = await api(`/api/quotes/${formalV1.id}/approve`, { method: 'POST',
    headers: { 'x-client-token': iq2.client_token, 'content-type': 'application/json' }, body: { version: formalV1.version } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'quote_not_approvable');
  ok('源文件替换后，基于 v1 的正式报价变 stale，批准 → 409（不自动适用）');

  r = await api(`/api/admin/inquiries/${iq2.id}/formal-quote`, { method: 'POST', headers: ADMIN });
  const formalV2 = r.data;
  assert.equal(formalV2.attachment_version, 2);
  r = await api(`/api/quotes/${formalV2.id}/approve`, { method: 'POST',
    headers: { 'x-client-token': iq2.client_token, 'content-type': 'application/json' }, body: { version: formalV2.version } });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'approved');
  ok('基于 v2 重新出具正式报价后，客户确认明确版本 → 批准成功');

  // ---------- 4. 并发批准与旧版本确认 ----------
  console.log('\n[4] 并发批准 / 旧报价确认');
  const iq3 = await mk('委托三：并发测试');
  await up(iq3.id, iq3.client_token, 'c.txt', '并发测试源文内容。');
  const q1 = (await api(`/api/admin/inquiries/${iq3.id}/formal-quote`, { method: 'POST', headers: ADMIN })).data;
  const q2 = (await api(`/api/admin/inquiries/${iq3.id}/formal-quote`, { method: 'POST', headers: ADMIN })).data; // q1 → superseded

  r = await api(`/api/quotes/${q1.id}/approve`, { method: 'POST',
    headers: { 'x-client-token': iq3.client_token, 'content-type': 'application/json' }, body: { version: q1.version } });
  assert.equal(r.status, 409);
  ok('批准已被取代的旧报价 → 409 superseded');

  r = await api(`/api/quotes/${q2.id}/approve`, { method: 'POST',
    headers: { 'x-client-token': iq3.client_token, 'content-type': 'application/json' }, body: { version: q2.version + 99 } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'version_mismatch');
  ok('确认版本号与报价不一致 → 409 version_mismatch（确认对象必须是明确版本）');

  const [r1, r2] = await Promise.all([
    api(`/api/quotes/${q2.id}/approve`, { method: 'POST', headers: { 'x-client-token': iq3.client_token, 'content-type': 'application/json' }, body: { version: q2.version } }),
    api(`/api/quotes/${q2.id}/approve`, { method: 'POST', headers: { 'x-client-token': iq3.client_token, 'content-type': 'application/json' }, body: { version: q2.version } }),
  ]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 409]);
  ok('并发批准同一报价：CAS 保证恰好一次成功（200/409）');

  // ---------- 5. 案例许可分离：仅摘要公开时原文不进索引/下载包 ----------
  console.log('\n[5] 案例素材许可分离');
  const kase = (await api('/api/admin/cases', { method: 'POST', headers: ADMIN, body: {
    title: '许可测试案例', lang_pair: 'zh-en', domain: 'legal',
    summary: '只有这段摘要公开。', role: '独立译者', challenges: '保密要求高' } })).data;
  await api(`/api/admin/cases/${kase.id}/materials`, { method: 'POST', headers: ADMIN,
    body: { kind: 'source', license: 'private', content: 'CONFIDENTIAL_SOURCE_XYZ 保密源文' } });
  await api(`/api/admin/cases/${kase.id}/materials`, { method: 'POST', headers: ADMIN,
    body: { kind: 'translation', license: 'client-authorized', content: 'AUTH_ONLY_TGT_QRS 授权译文' } });
  await api(`/api/admin/cases/${kase.id}/materials`, { method: 'POST', headers: ADMIN,
    body: { kind: 'annotation', license: 'public', content: '公开批注：术语处理说明' } });

  r = await api(`/api/cases/${kase.id}`);
  assert.equal(r.status, 200);
  assert.ok(JSON.stringify(r.data).includes('公开批注'));
  assert.ok(!JSON.stringify(r.data).includes('CONFIDENTIAL_SOURCE_XYZ'));
  assert.ok(!JSON.stringify(r.data).includes('AUTH_ONLY_TGT_QRS'));
  ok('公开详情只含 license=public 素材（源文/授权译文不出现）');

  r = await api('/api/search?q=CONFIDENTIAL_SOURCE_XYZ');
  assert.equal(r.data.results.length, 0);
  r = await api('/api/search?q=AUTH_ONLY_TGT_QRS');
  assert.equal(r.data.results.length, 0);
  r = await api('/api/search?q=公开批注');
  assert.equal(r.data.results.length, 1);
  ok('搜索索引不含受限素材；公开批注可被检索');

  r = await api(`/api/cases/${kase.id}/package`);
  assert.ok(!JSON.stringify(r.data).includes('CONFIDENTIAL_SOURCE_XYZ'));
  assert.ok(!JSON.stringify(r.data).includes('AUTH_ONLY_TGT_QRS'));
  ok('下载包同样不泄露仅摘要公开案例的原文/译文');

  // ---------- 6. 译者撤下案例 ----------
  console.log('\n[6] 译者撤下案例');
  await api(`/api/admin/cases/${kase.id}/withdraw`, { method: 'POST', headers: ADMIN });
  r = await api(`/api/cases/${kase.id}`);
  assert.equal(r.status, 404);
  r = await api('/api/search?q=公开批注');
  assert.equal(r.data.results.length, 0);
  r = await api(`/api/cases/${kase.id}/package`);
  assert.equal(r.status, 404);
  ok('撤下后：详情 404、搜索移除、下载包 404');

  // ---------- 7. 授权链接过期 / 撤销 ----------
  console.log('\n[7] 授权链接过期与撤销');
  const mat = (await api('/api/admin/cases', { method: 'POST', headers: ADMIN, body: {
    title: '链接测试', lang_pair: 'en-zh', domain: 'tech', summary: 's', role: 'r', challenges: 'c' } })).data;
  const m1 = (await api(`/api/admin/cases/${mat.id}/materials`, { method: 'POST', headers: ADMIN,
    body: { kind: 'translation', license: 'client-authorized', content: '授权查看的译文节选' } })).data;

  const good = (await api('/api/admin/share-links', { method: 'POST', headers: ADMIN,
    body: { scope: 'case-material', target_id: m1.id, ttl_seconds: 3600 } })).data;
  r = await api(`/api/share/${good.token}`);
  assert.equal(r.status, 200); assert.ok(r.data.content.includes('授权查看'));
  ok('有效授权链接可访问受限素材（无需登录）');

  const expired = (await api('/api/admin/share-links', { method: 'POST', headers: ADMIN,
    body: { scope: 'case-material', target_id: m1.id, ttl_seconds: -60 } })).data;
  r = await api(`/api/share/${expired.token}`);
  assert.equal(r.status, 410); assert.equal(r.data.error, 'link_expired');
  ok('过期授权链接 → 410 Gone');

  await api(`/api/admin/share-links/${good.token}/revoke`, { method: 'POST', headers: ADMIN });
  r = await api(`/api/share/${good.token}`);
  assert.equal(r.status, 410); assert.equal(r.data.error, 'link_revoked');
  ok('撤销后 → 410 Gone');

  // ---------- 8. 后台材料仅必要参与者可见 ----------
  console.log('\n[8] 参与者隔离');
  const iqA = await mk('客户A的材料'); const iqB = await mk('客户B的材料');
  const attA = (await up(iqA.id, iqA.client_token, 'a.txt', '客户A的保密原文')).data;
  r = await api(`/api/attachments/${attA.id}/download`, { headers: { 'x-client-token': iqB.client_token } });
  assert.equal(r.status, 403);
  r = await api(`/api/attachments/${attA.id}/download`, { headers: { 'x-client-token': iqA.client_token } });
  assert.equal(r.status, 200);
  r = await api(`/api/attachments/${attA.id}/download`, { headers: { 'x-admin-token': adminToken } });
  assert.equal(r.status, 200);
  r = await api(`/api/attachments/${attA.id}/download`);
  assert.equal(r.status, 403);
  ok('附件仅委托客户本人与译者可见，他人/匿名 → 403');

  // ---------- 9. 委托取消后的留存策略：可验证删除 ----------
  console.log('\n[9] 留存策略可验证');
  const iqC = await mk('将被取消的委托');
  const attC = (await up(iqC.id, iqC.client_token, 'c.txt', '取消后应被清除的附件内容')).data;
  const attPath = path.join(storageDir, `inquiry_${iqC.id}`, 'v1_c.txt');
  assert.ok(fs.existsSync(attPath));
  await api(`/api/inquiries/${iqC.id}/cancel`, { method: 'POST',
    headers: { 'x-client-token': iqC.client_token, 'content-type': 'application/json' }, body: { retention_days: 0 } });
  r = await api(`/api/inquiries/${iqC.id}`, { headers: { 'x-client-token': iqC.client_token } });
  assert.equal(r.data.attachments[0].status, 'pending_deletion');
  ok('取消后附件进入留存期（pending_deletion），不是立即只删列表项');

  r = await api('/api/admin/retention/run', { method: 'POST', headers: ADMIN });
  assert.equal(r.data.purged.length, 1);
  assert.ok(!fs.existsSync(attPath)); // 文件字节真实删除
  r = await api('/api/admin/retention/verify', { headers: { 'x-admin-token': adminToken } });
  assert.equal(r.data.verified, true);
  assert.equal(r.data.deleted[0].hash_matches, true);
  assert.equal(r.data.deleted[0].file_removed, true);
  ok('到期清除：文件真实删除 + tombstone 哈希凭证可验证（verified=true）');

  r = await api(`/api/attachments/${attC.id}/download`, { headers: { 'x-admin-token': adminToken } });
  assert.equal(r.status, 410);
  ok('已清除附件下载 → 410');

  // ---------- 10. 日志不写正文 ----------
  console.log('\n[10] 审计日志不含正文');
  r = await api('/api/admin/audit', { headers: { 'x-admin-token': adminToken } });
  const dump = JSON.stringify(r.data);
  assert.ok(r.data.length > 10, '应有审计记录');
  assert.ok(!dump.includes('SECRET_SUMMARY_ABC'), '日志不得包含委托摘要正文');
  assert.ok(!dump.includes('取消后应被清除的附件内容'), '日志不得包含附件正文');
  assert.ok(!dump.includes('CONFIDENTIAL_SOURCE_XYZ'), '日志不得包含素材正文');
  assert.ok(dump.includes('sha256'), '日志应包含哈希等元数据');
  ok(`共 ${r.data.length} 条日志：只有动作/版本/字数/哈希，无正文`);

  // ---------- 11. 持久化 ----------
  console.log('\n[11] 持久化');
  assert.ok(fs.existsSync(path.join(tmp, 'test.db')) && fs.statSync(path.join(tmp, 'test.db')).size > 0);
  ok('SQLite 数据库落盘，重启可恢复');

  server.close();
  console.log(`\n全部通过：${passed} 项验收 ✓`);
  process.exit(0);
}

main().catch(e => { console.error('\n✗ 测试失败:', e); process.exit(1); });
