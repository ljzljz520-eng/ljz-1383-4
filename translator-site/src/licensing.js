'use strict';
// 许可模型：案例的 源文 / 译文 / 对照批注 三类素材分别持有许可。
// public     —— 可进入公开页、搜索索引与下载包
// restricted —— 仅摘要公开；素材本身绝不进入搜索索引与下载包

function publicCard(c) {
  return { slug: c.slug, title: c.title, domain: c.domain, langPair: c.langPair, summary: c.summary };
}

function listPublished(store) {
  return store.data.cases.filter(c => c.status === 'published');
}

// 公开详情：受限素材只回许可标记，不回内容
function casePublicView(store, c) {
  const assets = store.data.assets
    .filter(a => a.caseId === c.id)
    .map(a => a.license === 'public'
      ? { kind: a.kind, license: a.license, content: a.content }
      : { kind: a.kind, license: a.license, locked: true });
  return {
    slug: c.slug, title: c.title, domain: c.domain, langPair: c.langPair,
    summary: c.summary, role: c.role, challenges: c.challenges, assets,
  };
}

// 搜索索引只由“公开字段 + public 许可素材”构成；检索结果也只回公开卡片
function search(store, q) {
  const query = String(q || '').trim().toLowerCase();
  const docs = listPublished(store).map(c => {
    const parts = [c.title, c.summary, c.domain, c.langPair, c.role, c.challenges];
    for (const a of store.data.assets) {
      if (a.caseId === c.id && a.license === 'public') parts.push(a.content);
    }
    return { card: publicCard(c), haystack: parts.join('\n').toLowerCase() };
  });
  if (!query) return docs.map(d => d.card);
  return docs.filter(d => d.haystack.includes(query)).map(d => d.card);
}

module.exports = { publicCard, listPublished, casePublicView, search };
