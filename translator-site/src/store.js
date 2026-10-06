'use strict';
// 极简 JSON 文件持久层：原子写（tmp+rename），写操作串行化。
const fs = require('fs');

const DEFAULTS = () => ({
  seq: 1,
  cases: [],       // {id, slug, title, domain, langPair, summary, role, challenges, status, createdAt}
  assets: [],      // {id, caseId, kind: source|translation|annotations, license: public|restricted, content}
  inquiries: [],   // {id, contact, summary, domain, langPair, declaredWords, confidentiality, materialLicense, status, currentRevision, approvedQuoteId, createdAt}
  attachments: [], // {id, inquiryId, revision, filename, sha256, content, stats, state: active|pending_purge|purged, purgeAfter, createdAt}
  quotes: [],      // {id, inquiryId, version, revision, words, ratePerUnit, amount, status: sent|stale|superseded|approved, createdAt}
  links: [],       // {token, inquiryId, scope: client|upload|materials, expiresAt, createdAt}
  handoffs: [],    // {id, inquiryId, phase: materials_transferred|delivered|accepted, events:[...]}
  retention: [],   // 清除墓碑 {attachmentId, inquiryId, filename, sha256, purgedAt, policy}
});

class Store {
  constructor(file) {
    this.file = file || null;
    this.data = DEFAULTS();
    if (this.file && fs.existsSync(this.file)) {
      this.data = Object.assign(DEFAULTS(), JSON.parse(fs.readFileSync(this.file, 'utf8')));
    }
    this._chain = Promise.resolve();
  }
  nextId(prefix) { return `${prefix}_${this.data.seq++}`; }
  save() {
    if (!this.file) return Promise.resolve();
    const payload = JSON.stringify(this.data, null, 2);
    const tmp = this.file + '.tmp';
    this._chain = this._chain
      .then(() => fs.promises.writeFile(tmp, payload))
      .then(() => fs.promises.rename(tmp, this.file));
    return this._chain;
  }
}
module.exports = { Store };
