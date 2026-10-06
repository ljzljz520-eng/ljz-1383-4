'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function makeApp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trsite-'));
  const app = createApp({ storeFile: path.join(dir, 'store.json'), auditFile: path.join(dir, 'audit.log') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.server.close(r)));
  return { app, dir, base: `http://127.0.0.1:${app.server.address().port}` };
}

async function api(base, method, p, { body, token, admin } = {}) {
  const url = new URL(base + p);
  if (token) url.searchParams.set('token', token);
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (admin) headers.authorization = 'Bearer dev-admin-token';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data };
}

const makeInquiry = async (base, over = {}) => {
  const r = await api(base, 'POST', '/api/inquiries', {
    body: { contact: 'c@example.com', summary: '摘要', domain: '法律', langPair: 'en>zh', declaredWords: 1000, confidentiality: 'confidential', materialLicense: 'review_only', ...over },
  });
  assert.equal(r.status, 201);
  return r.data;
};
const upload = (base, id, token, filename, content) =>
  api(base, 'POST', `/api/inquiries/${id}/attachments`, { token, body: { filename, content } });

// ── 1. 素材许可分离：仅摘要公开时，搜索索引与下载包不得暴露原文 ──
test('许可分离：受限源文不进公开视图 / 搜索索引 / 下载包', async (t) => {
  const { base } = await makeApp(t);
  const SECRET = 'CONFIDENTIAL_SOURCE_XYZ_001';
  const PUB = 'PUBLIC_TRANSLATION_ABC_002';
  const r = await api(base, 'POST', '/api/admin/cases', { admin: true, body: {
    slug: 'c1', title: '测试案例', domain: '法律', langPair: 'en>zh', summary: '公开摘要',
    role: '独立译者', challenges: '术语一致性',
    assets: [
      { kind: 'source', license: 'restricted', content: SECRET },
      { kind: 'translation', license: 'public', content: PUB },
      { kind: 'annotations', license: 'restricted', content: 'SECRET_NOTE_003' },
    ] } });
  assert.equal(r.status, 201);

  const view = await api(base, 'GET', '/api/cases/c1');
  assert.equal(view.status, 200);
  const src = view.data.assets.find(a => a.kind === 'source');
  assert.equal(src.locked, true);
  assert.equal(src.content, undefined);
  assert.equal(JSON.stringify(view.data).includes(SECRET), false);

  const s1 = await api(base, 'GET', '/api/search?q=' + SECRET);
  assert.equal(s1.data.results.length, 0);
  const s2 = await api(base, 'GET', '/api/search?q=' + PUB);
  assert.equal(s2.data.results.length, 1);

  const dl = await api(base, 'GET', '/api/cases/c1/download');
  assert.equal(dl.status, 200);
  assert.equal(dl.data.includes(Buffer.from(SECRET)), false);
  assert.equal(dl.data.includes(Buffer.from('SECRET_NOTE_003')), false);
  assert.equal(dl.data.includes(Buffer.from(PUB)), true);
  assert.equal(dl.data.includes(Buffer.from('MANIFEST.json')), true);
});

// ── 2. 字数统计：固定格式解析 + 双语文档不重复计数 + 重复段去重 ──
test('字数统计：固定格式、双语只计 SRC、重复段只计一次', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base);
  const aligned = ['# 对照文件', 'SRC> 你好世界', 'TGT> hello world', 'SRC> 你好世界', 'SRC> 独立句子', 'TGT> independent sentence'].join('\n');
  const r = await upload(base, inq.inquiryId, inq.clientToken, 'doc.align.txt', aligned);
  assert.equal(r.status, 201);
  const s = r.data.stats;
  assert.equal(s.format, 'aligned');
  assert.equal(s.totalSegments, 3);        // 只数 SRC 行
  assert.equal(s.uniqueSegments, 2);
  assert.equal(s.repeatedSegments, 1);
  assert.equal(s.totalUnits, 12);          // 4+4+4，TGT 的英文词不计
  assert.equal(s.repeatedUnits, 4);
  assert.equal(s.billableUnits, 8);

  const plain = await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', 'Hello world 你好');
  assert.equal(plain.data.stats.billableUnits, 4); // Hello / world / 你 / 好

  const bad = await upload(base, inq.inquiryId, inq.clientToken, 'a.docx', 'whatever');
  assert.equal(bad.status, 415);           // 非固定格式一律拒绝
  const badline = await upload(base, inq.inquiryId, inq.clientToken, 'b.align.txt', 'SRC> ok\n自由行');
  assert.equal(badline.status, 422);       // 违反固定行格式
});

// ── 3. 两阶段：预估（无原文）与正式评估（受限附件）──
test('两阶段询价：预估给区间且不存附件，正式评估给精确价', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base, { declaredWords: 1000, langPair: 'en>zh' });
  assert.equal(inq.phase, 1);
  assert.equal(inq.estimate.amountLow, 720);    // 1000*0.8*0.9
  assert.equal(inq.estimate.amountHigh, 1125);  // 1000*1.25*0.9
  assert.match(inq.estimate.accuracy, /±/);
  let detail = await api(base, 'GET', `/api/inquiries/${inq.inquiryId}`, { token: inq.clientToken });
  assert.equal(detail.data.attachments.length, 0); // 第一阶段零素材存储

  const link = await api(base, 'POST', `/api/inquiries/${inq.inquiryId}/upload-link`, { token: inq.clientToken });
  assert.equal(link.status, 201);
  assert.ok(new Date(link.data.expiresAt) > new Date());
  const up = await upload(base, inq.inquiryId, link.data.token, 'a.txt', '你好世界');
  assert.equal(up.status, 201);
  assert.equal(up.data.quote.amount, 3.6);       // 4 * 0.9，精确价
  assert.equal(up.data.quote.version, 1);
});

// ── 4. 源文件替换 / 附件修订：原报价不能自动适用，确认对象必须是明确版本 ──
test('附件修订使原报价失效；客户只能确认明确的当前版本', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base);
  const up1 = await upload(base, inq.inquiryId, inq.clientToken, 'v1.txt', '你好世界');
  const q1 = up1.data.quote;
  assert.equal(q1.amount, 3.6);

  // 源文件替换 => 新修订、新报价，旧报价 stale
  const up2 = await upload(base, inq.inquiryId, inq.clientToken, 'v2.txt', '你好世界 你好世界 独立');
  const q2 = up2.data.quote;
  assert.equal(q2.version, 2);
  assert.equal(q2.revision, 2);
  assert.equal(q2.amount, 9); // 10 单位 * 0.9

  const old = await api(base, 'POST', `/api/quotes/${q1.id}/approve`, { token: inq.clientToken, body: { version: 1 } });
  assert.equal(old.status, 409);                 // 旧报价不可再批准
  assert.equal(old.data.error, 'QUOTE_NOT_APPROVABLE');

  const noVer = await api(base, 'POST', `/api/quotes/${q2.id}/approve`, { token: inq.clientToken, body: {} });
  assert.equal(noVer.status, 400);               // 必须指定明确版本
  assert.equal(noVer.data.error, 'VERSION_REQUIRED');

  const wrongVer = await api(base, 'POST', `/api/quotes/${q2.id}/approve`, { token: inq.clientToken, body: { version: 1 } });
  assert.equal(wrongVer.status, 409);
  assert.equal(wrongVer.data.error, 'VERSION_MISMATCH');

  const ok = await api(base, 'POST', `/api/quotes/${q2.id}/approve`, { token: inq.clientToken, body: { version: 2 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.handoff.phase, 'materials_transferred'); // 两阶段交接·第一阶段
});

// ── 5. 并发批准：同一报价只有一个批准成功 ──
test('并发批准旧报价：仅一个成功，其余 409', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base);
  const up = await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', '你好世界');
  const q = up.data.quote;
  const [r1, r2] = await Promise.all([
    api(base, 'POST', `/api/quotes/${q.id}/approve`, { token: inq.clientToken, body: { version: 1 } }),
    api(base, 'POST', `/api/quotes/${q.id}/approve`, { token: inq.clientToken, body: { version: 1 } }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const detail = await api(base, 'GET', `/api/inquiries/${inq.inquiryId}`, { token: inq.clientToken });
  assert.equal(detail.data.inquiry.approvedQuoteId, q.id);
  assert.equal(detail.data.quotes.filter(x => x.status === 'approved').length, 1);
});

// ── 6. 两阶段交接顺序：交付后才能验收 ──
test('两阶段交接：物料交接 → 交付 → 验收，顺序受控', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base);
  const up = await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', '你好世界');
  const ap = await api(base, 'POST', `/api/quotes/${up.data.quote.id}/approve`, { token: inq.clientToken, body: { version: 1 } });
  const hf = ap.data.handoff;
  assert.equal(hf.phase, 'materials_transferred');

  const early = await api(base, 'POST', `/api/handoffs/${hf.id}/accept`, { token: inq.clientToken });
  assert.equal(early.status, 409);               // 未交付不能验收
  assert.equal(early.data.error, 'PHASE_ORDER');

  const del = await api(base, 'POST', `/api/handoffs/${hf.id}/deliver`, { admin: true });
  assert.equal(del.status, 200);
  assert.equal(del.data.handoff.phase, 'delivered');

  const acc = await api(base, 'POST', `/api/handoffs/${hf.id}/accept`, { token: inq.clientToken });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.handoff.phase, 'accepted');

  const again = await api(base, 'POST', `/api/handoffs/${hf.id}/deliver`, { admin: true });
  assert.equal(again.status, 409);
});

// ── 7. 译者撤下案例：公开页 / 搜索 / 下载全部失效 ──
test('撤下案例：公开接口立即不可见', async (t) => {
  const { base } = await makeApp(t);
  await api(base, 'POST', '/api/admin/cases', { admin: true, body: {
    slug: 'gone', title: '将被撤下', langPair: 'en>zh', summary: 's',
    assets: [{ kind: 'translation', license: 'public', content: 'TAKEDOWN_MARK_777' }] } });
  assert.equal((await api(base, 'GET', '/api/cases/gone')).status, 200);
  assert.equal((await api(base, 'GET', '/api/search?q=TAKEDOWN_MARK_777')).data.results.length, 1);

  const un = await api(base, 'POST', '/api/admin/cases/gone/unpublish', { admin: true });
  assert.equal(un.status, 200);
  assert.equal((await api(base, 'GET', '/api/cases/gone')).status, 404);
  assert.equal((await api(base, 'GET', '/api/cases/gone/download')).status, 404);
  assert.equal((await api(base, 'GET', '/api/search?q=TAKEDOWN_MARK_777')).data.results.length, 0);
  assert.equal((await api(base, 'GET', '/api/cases')).data.cases.some(c => c.slug === 'gone'), false);
});

// ── 8. 授权链接过期：过期即 410 ──
test('授权链接过期后拒绝访问', async (t) => {
  const { base } = await makeApp(t);
  const inq = await makeInquiry(base);
  await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', '你好');
  const link = await api(base, 'POST', `/api/admin/inquiries/${inq.inquiryId}/material-links`, { admin: true, body: { ttlMs: 60 } });
  assert.equal(link.status, 201);
  const ok = await api(base, 'GET', `/api/inquiries/${inq.inquiryId}/materials`, { token: link.data.token });
  assert.equal(ok.status, 200);
  await sleep(150);
  const expired = await api(base, 'GET', `/api/inquiries/${inq.inquiryId}/materials`, { token: link.data.token });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error, 'LINK_EXPIRED');
});

// ── 9. 材料访问控制：仅必要参与者 ──
test('后台材料仅向必要参与者开放', async (t) => {
  const { base } = await makeApp(t);
  const inqA = await makeInquiry(base);
  const inqB = await makeInquiry(base);
  await upload(base, inqA.inquiryId, inqA.clientToken, 'a.txt', '你好世界');

  assert.equal((await api(base, 'GET', `/api/inquiries/${inqA.inquiryId}/materials`)).status, 401); // 访客
  const wrong = await api(base, 'GET', `/api/inquiries/${inqA.inquiryId}/materials`, { token: inqB.clientToken });
  assert.equal(wrong.status, 403);               // 其他委托的客户
  assert.equal((await api(base, 'GET', `/api/inquiries/${inqA.inquiryId}/materials`, { admin: true })).status, 200); // 译者
  assert.equal((await api(base, 'GET', `/api/inquiries/${inqA.inquiryId}/materials`, { token: inqA.clientToken })).status, 200); // 本人
});

// ── 10. 日志不写正文 ──
test('审计日志不包含任何正文内容', async (t) => {
  const { base, dir } = await makeApp(t);
  const SUM = 'SUMMARY_MARKER_7Q9';
  const BODY = 'BODY_MARKER_3ZP';
  const inq = await makeInquiry(base, { summary: `项目 ${SUM}` });
  const up = await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', `正文 ${BODY}`);
  await api(base, 'POST', `/api/quotes/${up.data.quote.id}/approve`, { token: inq.clientToken, body: { version: 1 } });
  const log = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8');
  assert.ok(log.length > 0);
  assert.equal(log.includes(SUM), false);
  assert.equal(log.includes(BODY), false);
  assert.equal(/"(summary|content|source|translation|body)"\s*:/i.test(log), false);
});

// ── 11. 取消后的附件保留策略：可验证，而非只删列表项 ──
test('取消后附件保留 30 天，到期清除且留存可核验墓碑', async (t) => {
  const { base, dir } = await makeApp(t);
  const MARK = 'ATTACHMENT_BODY_MARK_55';
  const inq = await makeInquiry(base);
  const up = await upload(base, inq.inquiryId, inq.clientToken, 'a.txt', `内容 ${MARK}`);
  const sha = up.data.attachment.sha256;

  const cancel = await api(base, 'POST', `/api/inquiries/${inq.inquiryId}/cancel`, { token: inq.clientToken });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.attachments[0].state, 'pending_purge');
  assert.ok(cancel.data.attachments[0].purgeAfter);

  let v = await api(base, 'GET', '/api/admin/retention/verify', { admin: true });
  assert.equal(v.data.attachments[0].contentPresent, true);   // 保留期内内容仍在
  assert.match(v.data.policy, /30/);

  const future = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
  const sweep = await api(base, 'POST', '/api/admin/retention/sweep', { admin: true, body: { asOf: future } });
  assert.equal(sweep.data.purged.length, 1);

  v = await api(base, 'GET', '/api/admin/retention/verify', { admin: true });
  assert.equal(v.data.attachments[0].state, 'purged');
  assert.equal(v.data.attachments[0].contentPresent, false);  // 内容已清除
  const tomb = v.data.tombstones.find(x => x.attachmentId === up.data.attachment.id);
  assert.ok(tomb, '应留存墓碑记录');
  assert.equal(tomb.sha256, sha);                             // 可用哈希核验被清除对象
  assert.ok(tomb.purgedAt);

  const onDisk = fs.readFileSync(path.join(dir, 'store.json'), 'utf8');
  assert.equal(onDisk.includes(MARK), false);                 // 持久层中正文确已消失
});

// ── 12. 两阶段对比说明可用 ──
test('预估 vs 正式评估的准确度/保密/存储成本说明可获取', async (t) => {
  const { base } = await makeApp(t);
  const r = await api(base, 'GET', '/api/flow-comparison');
  assert.equal(r.status, 200);
  for (const k of ['accuracy', 'confidentiality', 'storageCost']) {
    assert.ok(r.data.phase1_estimate[k]);
    assert.ok(r.data.phase2_formal[k]);
  }
});
