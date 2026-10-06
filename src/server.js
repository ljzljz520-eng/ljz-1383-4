'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { createDb } = require('./db');
const svc = require('./services');
const { audit } = require('./audit');

const QUOTE_STAGES = {
  estimate: {
    name: '预估询价（阶段一）',
    input: '仅项目摘要 + 客户自报字数，不接收原文',
    accuracy: '±35%',
    confidentiality: '最高：原文不离开客户环境，服务端零正文存储',
    storage_cost: '仅元数据（KB 级），无附件存储成本',
  },
  formal: {
    name: '正式评估（阶段二）',
    input: '受限附件（固定格式 UTF-8 文本），按实际解析字数计费',
    accuracy: '±5%',
    confidentiality: '附件按保密级别限定参与者（译者+委托客户），可发限时授权链接；委托取消后留存期到期可验证删除',
    storage_cost: '附件大小 × 修订版本数；取消委托后留存 30 天即清除，成本有界',
  },
};

async function startServer(opts = {}) {
  const dbPath = ('dbPath' in opts) ? opts.dbPath : path.join(__dirname, '..', 'data', 'app.db');
  const storageDir = ('storageDir' in opts) ? opts.storageDir : path.join(__dirname, '..', 'data', 'files');
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? 'dev-admin-token';
  const db = await createDb(dbPath);
  fs.mkdirSync(storageDir, { recursive: true });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const isAdmin = req => req.get('x-admin-token') === adminToken;
  const principalOf = req => ({ admin: isAdmin(req), clientToken: req.get('x-client-token') || null });
  const actorOf = req => isAdmin(req) ? 'translator' :
    (req.get('x-client-token') ? 'client:' + req.get('x-client-token').slice(0, 8) : 'anon');

  const requireAdmin = (req, res, next) => isAdmin(req) ? next()
    : res.status(403).json({ error: 'forbidden', message: '需要译者(管理员)身份' });

  // 客户身份：token 匹配该委托，或管理员
  const requireParticipant = (req, res, next) => {
    const iq = db.get('SELECT * FROM inquiries WHERE id=?', [req.params.id]);
    if (!iq) return res.status(404).json({ error: 'inquiry_not_found' });
    if (isAdmin(req) || req.get('x-client-token') === iq.client_token) {
      req.inquiry = iq; return next();
    }
    return res.status(403).json({ error: 'forbidden', message: '仅该委托的参与者可访问' });
  };

  const H = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /* ---------- 公开接口 ---------- */
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/quote-stages', (req, res) => res.json(QUOTE_STAGES));
  app.get('/api/billing-policy', (req, res) => res.json({
    unit: 'CJK 每字 1 单位；拉丁字母/数字连续串每词 1 单位；标点空白不计；双语文档只计源文侧',
    formats: ['plain-v1 (.txt UTF-8)', 'bilingual-v1 (#format: bilingual-v1, SRC>/TGT> 行)'],
    rates_per_1k_cny: svc.RATES_PER_1K, domain_multiplier: svc.DOMAIN_MULT, confidentiality_multiplier: svc.CONF_MULT,
  }));

  app.get('/api/cases', H((req, res) => res.json(svc.listCases(db, { lang: req.query.lang, domain: req.query.domain }))));
  app.get('/api/cases/:id', H((req, res) => res.json(svc.getPublicCase(db, +req.params.id))));
  app.get('/api/cases/:id/package', H((req, res) => {
    const pkg = svc.buildPackage(db, +req.params.id);
    audit(db, actorOf(req), 'case.package', 'case', req.params.id, {});
    res.setHeader('Content-Disposition', `attachment; filename="case-${req.params.id}-public.json"`);
    res.json(pkg);
  }));
  app.get('/api/search', H((req, res) => res.json({ q: req.query.q || '', results: svc.searchCases(db, req.query.q || '') })));
  app.get('/api/share/:token', H((req, res) => res.json(svc.accessShareLink(db, req.params.token))));

  /* ---------- 客户接口 ---------- */
  app.post('/api/inquiries', H((req, res) => {
    const iq = svc.createInquiry(db, actorOf(req), req.body || {});
    res.status(201).json(iq);
  }));
  app.get('/api/inquiries/:id', requireParticipant, H((req, res) => {
    const quotes = db.all('SELECT id,version,type,attachment_version,units,amount,currency,accuracy_band,status,created_at,approved_at FROM quotes WHERE inquiry_id=? ORDER BY version', [req.inquiry.id]);
    const atts = db.all('SELECT id,version,filename,format,billable_units,size_bytes,status,created_at FROM attachments WHERE inquiry_id=? ORDER BY version', [req.inquiry.id]);
    const storageBytes = atts.filter(a => a.status !== 'deleted').reduce((s, a) => s + a.size_bytes, 0);
    const { client_token, ...pub } = req.inquiry;
    res.json({ ...pub, quotes, attachments: atts, storage_bytes: storageBytes });
  }));
  app.post('/api/inquiries/:id/estimate', requireParticipant, H((req, res) =>
    res.status(201).json(svc.issueEstimate(db, actorOf(req), req.inquiry.id))));
  app.post('/api/inquiries/:id/attachments', requireParticipant, H((req, res) => {
    const { filename, content } = req.body || {};
    if (!filename || content == null) return res.status(400).json({ error: 'missing_field', message: '需要 filename 与 content' });
    res.status(201).json(svc.uploadAttachment(db, actorOf(req), req.inquiry.id, filename, content, storageDir));
  }));
  app.post('/api/inquiries/:id/cancel', requireParticipant, H((req, res) =>
    res.json(svc.cancelInquiry(db, actorOf(req), req.inquiry.id, req.body?.retention_days))));
  app.post('/api/quotes/:id/approve', H((req, res) => {
    const q = db.get('SELECT * FROM quotes WHERE id=?', [+req.params.id]);
    if (!q) return res.status(404).json({ error: 'quote_not_found' });
    const iq = db.get('SELECT * FROM inquiries WHERE id=?', [q.inquiry_id]);
    if (!isAdmin(req) && req.get('x-client-token') !== iq.client_token) {
      return res.status(403).json({ error: 'forbidden', message: '仅该委托客户可确认报价' });
    }
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) return res.status(400).json({ error: 'missing_field', message: '必须明确指定确认的报价版本 version' });
    res.json(svc.approveQuote(db, actorOf(req), q.id, version));
  }));
  app.get('/api/attachments/:id/download', H((req, res) =>
    res.json(svc.readAttachment(db, actorOf(req), +req.params.id, principalOf(req)))));

  /* ---------- 译者(后台)接口 ---------- */
  app.post('/api/admin/cases', requireAdmin, H((req, res) => res.status(201).json(svc.createCase(db, actorOf(req), req.body || {}))));
  app.post('/api/admin/cases/:id/materials', requireAdmin, H((req, res) => res.status(201).json(svc.addMaterial(db, actorOf(req), +req.params.id, req.body || {}))));
  app.post('/api/admin/cases/:id/withdraw', requireAdmin, H((req, res) => res.json(svc.withdrawCase(db, actorOf(req), +req.params.id))));
  app.post('/api/admin/inquiries/:id/formal-quote', requireAdmin, H((req, res) => res.status(201).json(svc.issueFormalQuote(db, actorOf(req), +req.params.id))));
  app.post('/api/admin/share-links', requireAdmin, H((req, res) => res.status(201).json(svc.createShareLink(db, actorOf(req), req.body || {}))));
  app.post('/api/admin/share-links/:token/revoke', requireAdmin, H((req, res) => res.json(svc.revokeShareLink(db, actorOf(req), req.params.token))));
  app.post('/api/admin/retention/run', requireAdmin, H((req, res) => res.json({ purged: svc.runRetention(db, actorOf(req)) })));
  app.get('/api/admin/retention/verify', requireAdmin, H((req, res) => res.json(svc.verifyRetention(db))));
  app.get('/api/admin/audit', requireAdmin, H((req, res) => res.json(db.all('SELECT * FROM audit_log ORDER BY id'))));

  // 统一错误处理
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.code || 'internal_error', message: err.message });
  });

  // 种子数据：真实角色与难点的示例案例（仅空库时）
  if (db.get('SELECT COUNT(*) AS n FROM cases').n === 0 && opts.seed !== false) {
    const seed = (c, mats) => {
      const kase = svc.createCase(db, 'seed', c);
      for (const m of mats) svc.addMaterial(db, 'seed', kase.id, m);
    };
    seed(
      { title: '监护仪说明书本地化（中→英）', lang_pair: 'zh-en', domain: 'medical',
        summary: '3.2 万字监护仪英文说明书，配套 FDA 申报材料。',
        role: '独立译者：全文翻译 + 术语表维护，直接对接客户法规事务部。',
        challenges: '报警句式须与 IEC 62366 可用性文件一致；客户中途更换产品型号，源文件替换后约 12% 内容重译。' },
      [ { kind: 'annotation', license: 'public', content: '术语处理说明：alarm 系列术语按 IEC 60601-1-8 分级译出。' },
        { kind: 'source', license: 'private', content: '（源文节选，客户保密，不公开）' },
        { kind: 'translation', license: 'client-authorized', content: '（译文节选，经客户书面授权，仅线下提供）' } ]
    );
    seed(
      { title: 'SaaS 营销站点创译（英→中）', lang_pair: 'en-zh', domain: 'marketing',
        summary: '官网 40 页创译 + 品牌口号候选 3 版。',
        role: '译审 + 创译，与甲方增长团队每周同步迭代。',
        challenges: '品牌口号双关不可直译；产出 3 版候选并附对照批注说明取舍。' },
      [ { kind: 'annotation', license: 'public', content: '口号候选对照：直译/意译/重写三版及取舍理由。' },
        { kind: 'source', license: 'private', content: '（源文节选，不公开）' } ]
    );
    seed(
      { title: '专利交底书（日→中）', lang_pair: 'ja-zh', domain: 'legal',
        summary: '机械领域专利交底书 1.8 万字，仅摘要经授权公开。',
        role: '主导翻译，另聘专利代理人复核权利要求书。',
        challenges: '权利要求长句拆分策略；与客户约定仅摘要公开，全文保密。' },
      [ { kind: 'source', license: 'private', content: '（源文，保密）' },
        { kind: 'translation', license: 'private', content: '（译文，保密）' },
        { kind: 'annotation', license: 'client-authorized', content: '（批注，经授权仅向委托方提供）' } ]
    );
  }

  return { app, db, storageDir, adminToken };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  startServer().then(({ app }) => {
    app.listen(port, () => console.log(`译者作品站已启动: http://localhost:${port}  (管理 token: 见 ADMIN_TOKEN，默认 dev-admin-token)`));
  });
}

module.exports = { startServer };
