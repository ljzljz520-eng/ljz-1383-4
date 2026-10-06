'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { AuditLog } = require('./audit');
const { parseFixedFormat, billableStats } = require('./wordcount');
const { estimate, formalQuoteAmount, FLOW_COMPARISON } = require('./quotes');
const { publicCard, listPublished, casePublicView, search } = require('./licensing');
const { tarBall } = require('./tar');
const retention = require('./retention');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin-token';
const UPLOAD_LINK_TTL_MS = 30 * 60 * 1000;          // 上传链接 30 分钟
const CLIENT_LINK_TTL_MS = 7 * 24 * 3600 * 1000;    // 客户链接 7 天
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function createApp(opts = {}) {
  const store = opts.store || new Store(opts.storeFile === undefined ? null : opts.storeFile);
  const audit = new AuditLog(opts.auditFile || null);
  const now = opts.now || (() => new Date());
  const publicDir = path.resolve(opts.publicDir || path.join(__dirname, '..', 'public'));

  function send(res, code, obj, headers = {}) {
    const isBuf = Buffer.isBuffer(obj);
    res.writeHead(code, {
      'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8',
      ...headers,
    });
    res.end(isBuf ? obj : JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' })); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  // ---------- 授权链接 ----------
  function makeLink(inquiryId, scope, ttlMs) {
    const l = { token: newToken(), inquiryId, scope, expiresAt: new Date(now().getTime() + ttlMs).toISOString(), createdAt: now().toISOString() };
    store.data.links.push(l);
    return l;
  }
  function getLink(tok) {
    if (!tok) return { error: 401, code: 'NO_TOKEN' };
    const l = store.data.links.find(x => x.token === tok);
    if (!l) return { error: 401, code: 'BAD_TOKEN' };
    if (new Date(l.expiresAt).getTime() <= now().getTime()) return { error: 410, code: 'LINK_EXPIRED' };
    return { link: l };
  }
  function inquiryLink(query, inquiryId, scopes) {
    const r = getLink(query.token);
    if (r.error) return r;
    if (r.link.inquiryId !== inquiryId) return { error: 403, code: 'WRONG_INQUIRY' };
    if (scopes && !scopes.includes(r.link.scope)) return { error: 403, code: 'SCOPE' };
    return r;
  }
  const isAdmin = (req) => req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;

  // ---------- 路由表 ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const rx = new RegExp('^' + pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, rx, keys, handler });
  };

  // ============ 公开作品页 ============
  route('GET', '/api/health', async (req, res) => send(res, 200, { ok: true }));

  route('GET', '/api/cases', async (req, res, p, q) => {
    let items = q.q ? search(store, q.q) : listPublished(store).map(publicCard);
    if (q.langPair) items = items.filter(c => c.langPair === q.langPair);
    if (q.domain) items = items.filter(c => c.domain === q.domain);
    send(res, 200, { cases: items });
  });

  route('GET', '/api/cases/:slug', async (req, res, { slug }) => {
    const c = store.data.cases.find(x => x.slug === slug && x.status === 'published');
    if (!c) return send(res, 404, { error: 'CASE_NOT_FOUND' });
    send(res, 200, casePublicView(store, c));
  });

  route('GET', '/api/search', async (req, res, p, q) => {
    send(res, 200, { results: search(store, q.q || '') });
  });

  // 下载包：只打包 public 许可素材，附 MANIFEST 说明排除项
  route('GET', '/api/cases/:slug/download', async (req, res, { slug }) => {
    const c = store.data.cases.find(x => x.slug === slug && x.status === 'published');
    if (!c) return send(res, 404, { error: 'CASE_NOT_FOUND' });
    const files = [];
    const manifest = { case: c.slug, included: [], excluded: [] };
    for (const a of store.data.assets.filter(x => x.caseId === c.id)) {
      if (a.license === 'public') {
        files.push({ name: `${c.slug}/${a.kind}.txt`, data: a.content });
        manifest.included.push({ kind: a.kind, license: a.license });
      } else {
        manifest.excluded.push({ kind: a.kind, license: a.license, reason: '许可受限，不进入下载包' });
      }
    }
    files.push({ name: `${c.slug}/MANIFEST.json`, data: JSON.stringify(manifest, null, 2) });
    audit.record('visitor', 'case.download', 'case', c.id, { slug: c.slug, included: manifest.included.length });
    send(res, 200, tarBall(files), {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${c.slug}-public.tar"`,
    });
  });

  route('GET', '/api/flow-comparison', async (req, res) => send(res, 200, FLOW_COMPARISON));

  // ============ 第一阶段：预估询价（不接收原文） ============
  const CONF_LEVELS = ['standard', 'confidential', 'strict'];
  const MAT_LICENSES = ['review_only', 'handoff_on_approval'];

  route('POST', '/api/inquiries', async (req, res, p, q, body) => {
    const { contact, summary, domain, langPair, declaredWords, confidentiality, materialLicense } = body || {};
    if (!contact || !summary || !langPair) return send(res, 400, { error: 'MISSING_FIELDS' });
    if (!CONF_LEVELS.includes(confidentiality)) return send(res, 400, { error: 'BAD_CONFIDENTIALITY' });
    if (!MAT_LICENSES.includes(materialLicense)) return send(res, 400, { error: 'BAD_MATERIAL_LICENSE' });
    const words = Number(declaredWords);
    if (!Number.isFinite(words) || words <= 0) return send(res, 400, { error: 'BAD_WORD_COUNT' });
    const inquiry = {
      id: store.nextId('inq'), contact, summary, domain: domain || 'general', langPair,
      declaredWords: words, confidentiality, materialLicense,
      status: 'estimated', currentRevision: 0, approvedQuoteId: null,
      createdAt: now().toISOString(),
    };
    store.data.inquiries.push(inquiry);
    const link = makeLink(inquiry.id, 'client', CLIENT_LINK_TTL_MS);
    audit.record('client', 'inquiry.create', 'inquiry', inquiry.id, { domain: inquiry.domain, confidentiality, declaredWords: words });
    await store.save();
    send(res, 201, { inquiryId: inquiry.id, clientToken: link.token, phase: 1, estimate: estimate(words, langPair) });
  });

  route('GET', '/api/inquiries/:id', async (req, res, { id }, query) => {
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    const auth = inquiryLink(query, id, ['client']);
    if (auth.error) return send(res, auth.error, { error: auth.code });
    send(res, 200, {
      inquiry: {
        id, contact: inquiry.contact, summary: inquiry.summary, domain: inquiry.domain,
        langPair: inquiry.langPair, declaredWords: inquiry.declaredWords,
        confidentiality: inquiry.confidentiality, materialLicense: inquiry.materialLicense,
        status: inquiry.status, currentRevision: inquiry.currentRevision,
        approvedQuoteId: inquiry.approvedQuoteId,
      },
      quotes: store.data.quotes.filter(x => x.inquiryId === id)
        .map(x => ({ id: x.id, version: x.version, revision: x.revision, words: x.words, ratePerUnit: x.ratePerUnit, amount: x.amount, status: x.status, createdAt: x.createdAt })),
      attachments: store.data.attachments.filter(a => a.inquiryId === id)
        .map(a => ({ id: a.id, revision: a.revision, filename: a.filename, sha256: a.sha256, state: a.state, purgeAfter: a.purgeAfter })),
      handoff: store.data.handoffs.find(h => h.inquiryId === id) || null,
    });
  });

  // ============ 第二阶段：受限附件 + 正式评估 ============
  route('POST', '/api/inquiries/:id/upload-link', async (req, res, { id }, query) => {
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    const auth = inquiryLink(query, id, ['client']);
    if (auth.error) return send(res, auth.error, { error: auth.code });
    if (inquiry.status === 'cancelled') return send(res, 409, { error: 'INQUIRY_CANCELLED' });
    const l = makeLink(id, 'upload', UPLOAD_LINK_TTL_MS);
    audit.record('client', 'link.upload.create', 'inquiry', id, { ttlMin: 30 });
    await store.save();
    send(res, 201, { uploadUrl: `/api/inquiries/${id}/attachments?token=${l.token}`, token: l.token, expiresAt: l.expiresAt });
  });

  route('POST', '/api/inquiries/:id/attachments', async (req, res, { id }, query, body) => {
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    const auth = inquiryLink(query, id, ['upload', 'client']);
    if (auth.error) return send(res, auth.error, { error: auth.code });
    if (inquiry.status === 'cancelled') return send(res, 409, { error: 'INQUIRY_CANCELLED' });
    if (inquiry.status === 'approved') return send(res, 409, { error: 'ALREADY_APPROVED_LOCKED' });
    const { filename, content } = body || {};
    if (!filename || typeof content !== 'string') return send(res, 400, { error: 'MISSING_FILE' });
    let parsed;
    try { parsed = parseFixedFormat(filename, content); }
    catch (e) { return send(res, e.code === 'UNSUPPORTED_FORMAT' ? 415 : 422, { error: e.code, message: e.message }); }
    const stats = billableStats(parsed);
    const revision = inquiry.currentRevision + 1;
    inquiry.currentRevision = revision;
    const att = {
      id: store.nextId('att'), inquiryId: id, revision, filename,
      sha256: sha256hex(content), content, stats,
      state: 'active', purgeAfter: null, createdAt: now().toISOString(),
    };
    store.data.attachments.push(att);
    // 附件修订 => 既有“已发出”的报价全部失效，不能自动适用
    for (const qt of store.data.quotes.filter(x => x.inquiryId === id && x.status === 'sent')) qt.status = 'stale';
    const version = Math.max(0, ...store.data.quotes.filter(x => x.inquiryId === id).map(x => x.version)) + 1;
    const { ratePerUnit, amount } = formalQuoteAmount(stats.billableUnits, inquiry.langPair);
    const quote = { id: store.nextId('q'), inquiryId: id, version, revision, words: stats.billableUnits, ratePerUnit, amount, status: 'sent', createdAt: now().toISOString() };
    store.data.quotes.push(quote);
    inquiry.status = 'quoted';
    audit.record('system', 'attachment.upload', 'attachment', att.id, { revision, billableUnits: stats.billableUnits });
    audit.record('system', 'quote.create', 'quote', quote.id, { version, revision, amount });
    await store.save();
    send(res, 201, { attachment: { id: att.id, revision, filename, sha256: att.sha256 }, stats, quote });
  });

  // 客户确认：确认对象必须是“明确版本”，且报价仍处于 sent、基于当前附件修订
  route('POST', '/api/quotes/:id/approve', async (req, res, { id }, query, body) => {
    const quote = store.data.quotes.find(x => x.id === id);
    if (!quote) return send(res, 404, { error: 'QUOTE_NOT_FOUND' });
    const inquiry = store.data.inquiries.find(x => x.id === quote.inquiryId);
    const auth = inquiryLink(query, inquiry.id, ['client']);
    if (auth.error) return send(res, auth.error, { error: auth.code });
    if (!body || body.version === undefined) return send(res, 400, { error: 'VERSION_REQUIRED' });
    // —— 同步临界区：检查与置位之间无 await，保证并发下只有一个批准成功 ——
    // 每个委托只允许一次成功的批准；重复/并发请求一律 409（客户端可 GET 查询当前状态）
    if (inquiry.approvedQuoteId) return send(res, 409, { error: 'ALREADY_APPROVED', approvedQuoteId: inquiry.approvedQuoteId });
    if (body.version !== quote.version) return send(res, 409, { error: 'VERSION_MISMATCH', expected: quote.version });
    if (quote.status !== 'sent') return send(res, 409, { error: 'QUOTE_NOT_APPROVABLE', status: quote.status });
    if (quote.revision !== inquiry.currentRevision) return send(res, 409, { error: 'STALE_REVISION', quoteRevision: quote.revision, currentRevision: inquiry.currentRevision });
    quote.status = 'approved';
    inquiry.approvedQuoteId = quote.id;
    inquiry.status = 'approved';
    // 两阶段交接 · 第一阶段：物料交接
    const handoff = { id: store.nextId('hf'), inquiryId: inquiry.id, phase: 'materials_transferred', events: [{ phase: 'materials_transferred', at: now().toISOString(), actor: 'system' }] };
    store.data.handoffs.push(handoff);
    audit.record('client', 'quote.approve', 'quote', quote.id, { version: quote.version, revision: quote.revision, amount: quote.amount });
    await store.save();
    send(res, 200, { ok: true, quote, handoff });
  });

  // 材料后台：仅必要参与者（译者 / 客户本人 / 持 materials 授权链接者）
  route('GET', '/api/inquiries/:id/materials', async (req, res, { id }, query) => {
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    let actor;
    if (isAdmin(req)) actor = 'translator';
    else {
      const auth = inquiryLink(query, id, ['client', 'materials']);
      if (auth.error) return send(res, auth.error, { error: auth.code });
      actor = auth.link.scope;
    }
    audit.record(actor, 'materials.read', 'inquiry', id, {});
    send(res, 200, {
      materials: store.data.attachments.filter(a => a.inquiryId === id)
        .map(a => ({ id: a.id, revision: a.revision, filename: a.filename, sha256: a.sha256, state: a.state, stats: a.stats, content: a.state === 'active' ? a.content : null })),
    });
  });

  route('POST', '/api/inquiries/:id/cancel', async (req, res, { id }, query) => {
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    const admin = isAdmin(req);
    if (!admin) {
      const auth = inquiryLink(query, id, ['client']);
      if (auth.error) return send(res, auth.error, { error: auth.code });
    }
    if (inquiry.status === 'cancelled') return send(res, 409, { error: 'ALREADY_CANCELLED' });
    inquiry.status = 'cancelled';
    retention.schedulePurge(store, id, now());
    audit.record(admin ? 'translator' : 'client', 'inquiry.cancel', 'inquiry', id, {});
    await store.save();
    send(res, 200, {
      ok: true,
      attachments: store.data.attachments.filter(a => a.inquiryId === id)
        .map(a => ({ id: a.id, state: a.state, purgeAfter: a.purgeAfter })),
    });
  });

  // ============ 两阶段交接 · 第二阶段：交付与验收 ============
  route('POST', '/api/handoffs/:id/deliver', async (req, res, { id }) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const h = store.data.handoffs.find(x => x.id === id);
    if (!h) return send(res, 404, { error: 'HANDOFF_NOT_FOUND' });
    if (h.phase !== 'materials_transferred') return send(res, 409, { error: 'PHASE_ORDER', phase: h.phase });
    h.phase = 'delivered';
    h.events.push({ phase: 'delivered', at: now().toISOString(), actor: 'translator' });
    audit.record('translator', 'handoff.deliver', 'handoff', h.id, {});
    await store.save();
    send(res, 200, { handoff: h });
  });

  route('POST', '/api/handoffs/:id/accept', async (req, res, { id }, query) => {
    const h = store.data.handoffs.find(x => x.id === id);
    if (!h) return send(res, 404, { error: 'HANDOFF_NOT_FOUND' });
    const auth = inquiryLink(query, h.inquiryId, ['client']);
    if (auth.error) return send(res, auth.error, { error: auth.code });
    if (h.phase !== 'delivered') return send(res, 409, { error: 'PHASE_ORDER', phase: h.phase });
    h.phase = 'accepted';
    h.events.push({ phase: 'accepted', at: now().toISOString(), actor: 'client' });
    audit.record('client', 'handoff.accept', 'handoff', h.id, {});
    await store.save();
    send(res, 200, { handoff: h });
  });

  // ============ 译者后台 ============
  route('POST', '/api/admin/cases', async (req, res, p, q, body) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const { slug, title, domain, langPair, summary, role, challenges, assets = [] } = body || {};
    if (!slug || !title || !langPair || !summary) return send(res, 400, { error: 'MISSING_FIELDS' });
    if (store.data.cases.some(c => c.slug === slug)) return send(res, 409, { error: 'SLUG_EXISTS' });
    for (const a of assets) {
      if (!['source', 'translation', 'annotations'].includes(a.kind)) return send(res, 400, { error: 'BAD_ASSET_KIND' });
      if (!['public', 'restricted'].includes(a.license)) return send(res, 400, { error: 'BAD_ASSET_LICENSE' });
    }
    const c = { id: store.nextId('case'), slug, title, domain: domain || 'general', langPair, summary, role: role || '', challenges: challenges || '', status: 'published', createdAt: now().toISOString() };
    store.data.cases.push(c);
    for (const a of assets) store.data.assets.push({ id: store.nextId('asset'), caseId: c.id, kind: a.kind, license: a.license, content: String(a.content || '') });
    audit.record('translator', 'case.create', 'case', c.id, { slug, domain: c.domain });
    await store.save();
    send(res, 201, { case: c });
  });

  route('GET', '/api/admin/cases', async (req, res) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    send(res, 200, { cases: store.data.cases.map(c => ({ ...c, assets: store.data.assets.filter(a => a.caseId === c.id).map(a => ({ kind: a.kind, license: a.license })) })) });
  });

  route('POST', '/api/admin/cases/:slug/unpublish', async (req, res, { slug }) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const c = store.data.cases.find(x => x.slug === slug);
    if (!c) return send(res, 404, { error: 'CASE_NOT_FOUND' });
    c.status = 'unpublished';
    audit.record('translator', 'case.unpublish', 'case', c.id, { slug });
    await store.save();
    send(res, 200, { ok: true });
  });

  route('GET', '/api/admin/inquiries', async (req, res) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    send(res, 200, {
      inquiries: store.data.inquiries.map(i => ({
        ...i,
        quotes: store.data.quotes.filter(x => x.inquiryId === i.id),
        attachments: store.data.attachments.filter(a => a.inquiryId === i.id)
          .map(a => ({ id: a.id, revision: a.revision, filename: a.filename, sha256: a.sha256, state: a.state, purgeAfter: a.purgeAfter, stats: a.stats })),
      })),
    });
  });

  // 译者手工调整报价：产生新版本，旧“已发出”版本作废（superseded）
  route('POST', '/api/admin/inquiries/:id/quotes', async (req, res, { id }, q2, body) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    if (inquiry.currentRevision === 0) return send(res, 409, { error: 'NO_ATTACHMENTS' });
    for (const qt of store.data.quotes.filter(x => x.inquiryId === id && x.status === 'sent')) qt.status = 'superseded';
    const version = Math.max(0, ...store.data.quotes.filter(x => x.inquiryId === id).map(x => x.version)) + 1;
    const last = store.data.attachments.find(a => a.inquiryId === id && a.revision === inquiry.currentRevision);
    const words = Number((body && body.words) ?? (last ? last.stats.billableUnits : 0));
    const ratePerUnit = formalQuoteAmount(1, inquiry.langPair).ratePerUnit;
    const amount = Number((body && body.amount) ?? Math.round(words * ratePerUnit * 100) / 100);
    const quote = { id: store.nextId('q'), inquiryId: id, version, revision: inquiry.currentRevision, words, ratePerUnit, amount, status: 'sent', createdAt: now().toISOString() };
    store.data.quotes.push(quote);
    audit.record('translator', 'quote.create', 'quote', quote.id, { version, revision: quote.revision, amount });
    await store.save();
    send(res, 201, { quote });
  });

  // 为必要参与者签发限时材料授权链接
  route('POST', '/api/admin/inquiries/:id/material-links', async (req, res, { id }, q2, body) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const inquiry = store.data.inquiries.find(x => x.id === id);
    if (!inquiry) return send(res, 404, { error: 'INQUIRY_NOT_FOUND' });
    const ttl = Math.min(Math.max(Number(body && body.ttlMs) || 3600000, 1), CLIENT_LINK_TTL_MS);
    const l = makeLink(id, 'materials', ttl);
    audit.record('translator', 'link.materials.create', 'inquiry', id, { ttlMs: ttl });
    await store.save();
    send(res, 201, { token: l.token, url: `/api/inquiries/${id}/materials?token=${l.token}`, expiresAt: l.expiresAt });
  });

  route('GET', '/api/admin/retention/verify', async (req, res) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    send(res, 200, retention.verify(store));
  });

  route('POST', '/api/admin/retention/sweep', async (req, res, p, q, body) => {
    if (!isAdmin(req)) return send(res, 401, { error: 'ADMIN_REQUIRED' });
    const asOf = body && body.asOf ? new Date(body.asOf) : now();
    const purged = retention.sweep(store, asOf);
    if (purged.length) audit.record('system', 'retention.sweep', 'retention', 'sweep', { purged: purged.length });
    await store.save();
    send(res, 200, { purged });
  });

  // ---------- HTTP 入口 ----------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams.entries());
      if (pathname.startsWith('/api/')) {
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
          const raw = await readBody(req);
          if (raw.length) {
            try { body = JSON.parse(raw.toString('utf8')); }
            catch { return send(res, 400, { error: 'BAD_JSON' }); }
          }
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.rx.exec(pathname);
          if (!m) continue;
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          return await r.handler(req, res, params, query, body || {});
        }
        return send(res, 404, { error: 'NOT_FOUND' });
      }
      // 静态资源
      const p = pathname === '/' ? '/index.html' : pathname;
      const file = path.normalize(path.join(publicDir, p));
      if (!file.startsWith(publicDir)) return send(res, 403, { error: 'FORBIDDEN' });
      fs.readFile(file, (err, data) => {
        if (err) return send(res, 404, { error: 'NOT_FOUND' });
        send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      });
    } catch (e) {
      send(res, e.code === 'TOO_LARGE' ? 413 : 500, { error: e.code || 'INTERNAL', message: e.message });
    }
  });

  return { server, store, audit, now };
}

module.exports = { createApp, ADMIN_TOKEN };
