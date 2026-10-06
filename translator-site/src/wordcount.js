'use strict';
// 字数统计：固定格式解析 + 明确计费口径。
//
// 固定格式（除此之外一律拒绝）：
//   *.txt / *.md        纯文本 UTF-8，全文视为源文
//   *.align.txt         双语对照格式，逐行解析：
//                         SRC> 源文句段（计费）
//                         TGT> 译文句段（不计费）
//                         # 开头为注释，空行忽略；其余行 => FORMAT_ERROR
//
// 计费口径：
//   1) CJK 字符（中/日/韩）每字 = 1 计费单位；
//   2) 拉丁字母/数字连续串（允许内部 - ' . ,）= 1 单位；
//   3) 标点符号不计费；
//   4) 双语文件只计 SRC 句段，TGT 句段不计费（避免双语文档重复计数）；
//   5) 规范化后完全相同的源文句段只计一次（重复段去重），并给出重复统计。

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af';
const TOKEN_RE = new RegExp(`[${CJK}]|[A-Za-z0-9]+(?:[-'’.,][A-Za-z0-9]+)*`, 'g');

function countUnits(text) {
  const m = String(text).match(TOKEN_RE);
  return m ? m.length : 0;
}

function parseFixedFormat(filename, text) {
  const name = String(filename || '');
  if (/\.align\.txt$/i.test(name)) {
    const segments = [];
    String(text).split(/\r?\n/).forEach((line, idx) => {
      const t = line.replace(/\s+$/, '');
      if (!t.trim() || t.startsWith('#')) return;
      if (t.startsWith('SRC> ')) segments.push({ type: 'src', text: t.slice(5) });
      else if (t.startsWith('TGT> ')) segments.push({ type: 'tgt', text: t.slice(5) });
      else {
        const err = new Error(`fixed-format violation at line ${idx + 1}: ${t.slice(0, 20)}`);
        err.code = 'FORMAT_ERROR';
        throw err;
      }
    });
    return { format: 'aligned', segments };
  }
  if (/\.(txt|md)$/i.test(name)) {
    return { format: 'plain', segments: [{ type: 'src', text: String(text) }] };
  }
  const err = new Error('unsupported format: only .txt / .md / .align.txt are accepted');
  err.code = 'UNSUPPORTED_FORMAT';
  throw err;
}

const normalizeSeg = (s) => s.replace(/\s+/g, ' ').trim();

function billableStats(parsed) {
  const srcTexts = parsed.segments.filter(s => s.type === 'src').map(s => s.text);
  const seen = new Set();
  let totalUnits = 0, repeatedUnits = 0, repeatedSegments = 0;
  for (const raw of srcTexts) {
    const units = countUnits(raw);
    totalUnits += units;
    if (seen.has(normalizeSeg(raw))) { repeatedUnits += units; repeatedSegments += 1; }
    else seen.add(normalizeSeg(raw));
  }
  return {
    format: parsed.format,
    totalSegments: srcTexts.length,
    uniqueSegments: seen.size,
    repeatedSegments,
    totalUnits,
    repeatedUnits,
    billableUnits: totalUnits - repeatedUnits,
  };
}

module.exports = { countUnits, parseFixedFormat, billableStats };
