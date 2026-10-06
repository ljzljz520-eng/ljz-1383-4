'use strict';
// 委托取消后的附件保留策略：
//   取消 => 附件进入 pending_purge，保留 RETENTION_DAYS 天（可核验的 purgeAfter 时间）
//   到期清除 => 内容置空，但保留“墓碑”记录（sha256 + 清除时间 + 策略），供第三方核验
//   —— 不是只删列表项，而是可验证的生命周期。

const RETENTION_DAYS = 30;

function schedulePurge(store, inquiryId, now) {
  const until = new Date(now.getTime() + RETENTION_DAYS * 24 * 3600 * 1000).toISOString();
  const scheduled = [];
  for (const a of store.data.attachments) {
    if (a.inquiryId === inquiryId && a.state === 'active') {
      a.state = 'pending_purge';
      a.purgeAfter = until;
      scheduled.push(a.id);
    }
  }
  return scheduled;
}

function sweep(store, asOf) {
  const t = asOf.getTime();
  const purged = [];
  for (const a of store.data.attachments) {
    if (a.state === 'pending_purge' && a.purgeAfter && new Date(a.purgeAfter).getTime() <= t) {
      store.data.retention.push({
        attachmentId: a.id, inquiryId: a.inquiryId, filename: a.filename,
        sha256: a.sha256, purgedAt: asOf.toISOString(), policy: `cancel+${RETENTION_DAYS}d`,
      });
      a.content = null;
      a.state = 'purged';
      purged.push(a.id);
    }
  }
  return purged;
}

function verify(store) {
  return {
    policy: `委托取消后附件保留 ${RETENTION_DAYS} 天，到期清除内容并留存 sha256 墓碑`,
    attachments: store.data.attachments.map(a => ({
      id: a.id, inquiryId: a.inquiryId, revision: a.revision, filename: a.filename,
      sha256: a.sha256, state: a.state, purgeAfter: a.purgeAfter,
      contentPresent: a.content !== null && a.content !== undefined,
    })),
    tombstones: store.data.retention,
  };
}

module.exports = { RETENTION_DAYS, schedulePurge, sweep, verify };
