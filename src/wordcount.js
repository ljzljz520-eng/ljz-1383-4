'use strict';
// 字数统计：固定格式解析 + 明确计费口径
//
// 支持的固定格式（其它一律拒绝，不做猜测性解析）：
//   plain-v1     : UTF-8 .txt 纯文本，全文视为源文
//   bilingual-v1 : UTF-8 .txt，首行必须是 "#format: bilingual-v1"，
//                  之后每个非空行以 "SRC>"（源文）或 "TGT>"（译文）开头
//
// 计费口径（billable units）：
//   - CJK 表意文字 / 日文假名 / 韩文音节：每字 1 单位
//   - 拉丁字母与数字的连续串：每词 1 单位
//   - 标点与空白：不计
//   - 双语文档只计源文侧（SRC>），译文侧不重复计费

function isCJK(cp) {
  return (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK 统一表意文字
         (cp >= 0x3400 && cp <= 0x4dbf) ||   // 扩展 A
         (cp >= 0xf900 && cp <= 0xfaff) ||   // 兼容表意文字
         (cp >= 0x3040 && cp <= 0x30ff) ||   // 平/片假名
         (cp >= 0xac00 && cp <= 0xd7af);     // 韩文音节
}
function isWordChar(ch) { return /[A-Za-z0-9']/.test(ch); }

function countUnits(text) {
  let units = 0, inWord = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isCJK(cp)) { units++; inWord = false; }
    else if (isWordChar(ch)) { if (!inWord) { units++; inWord = true; } }
    else { inWord = false; }
  }
  return units;
}

function httpError(status, code, message) {
  const e = new Error(message); e.status = status; e.code = code; return e;
}

// 解析附件。返回 { format, segments, sourceUnits, targetUnits, billableUnits }
function parseAttachment(filename, content) {
  if (!/\.txt$/i.test(filename || '')) {
    throw httpError(415, 'unsupported_format',
      '仅接受固定格式 UTF-8 .txt（plain-v1 或 bilingual-v1）；请将 docx/pdf 另存为纯文本后上传');
  }
  if (typeof content !== 'string') {
    throw httpError(415, 'unsupported_encoding', '附件必须是 UTF-8 文本');
  }
  if (content.includes('�')) {
    throw httpError(415, 'invalid_utf8', '文件不是有效的 UTF-8 编码');
  }
  const lines = content.split(/\r?\n/);

  if (lines[0] && lines[0].trim() === '#format: bilingual-v1') {
    let sourceUnits = 0, targetUnits = 0, segments = 0;
    lines.slice(1).forEach((line, i) => {
      if (!line.trim()) return;
      const m = line.match(/^(SRC|TGT)>\s?(.*)$/);
      if (!m) {
        throw httpError(422, 'bad_segment',
          `bilingual-v1 第 ${i + 2} 行须以 SRC> 或 TGT> 开头: "${line.slice(0, 30)}..."`);
      }
      segments++;
      if (m[1] === 'SRC') sourceUnits += countUnits(m[2]);
      else targetUnits += countUnits(m[2]);
    });
    // 计费口径：双语文档只按源文侧计费，译文侧不重复计数
    return { format: 'bilingual-v1', segments, sourceUnits, targetUnits, billableUnits: sourceUnits };
  }

  const units = countUnits(content);
  return { format: 'plain-v1', segments: lines.filter(l => l.trim()).length,
           sourceUnits: units, targetUnits: 0, billableUnits: units };
}

module.exports = { countUnits, parseAttachment };
