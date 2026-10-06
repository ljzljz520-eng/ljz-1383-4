'use strict';
// 报价：第一阶段预估（不见原文，按申报字数给区间）
//       第二阶段正式评估（解析附件后按计费字数给精确价）

const RATES = { 'en>zh': 0.9, 'zh>en': 1.1, 'ja>zh': 0.8, 'en>ja': 1.2, default: 1.0 };
const rateFor = (langPair) => RATES[langPair] || RATES.default;

function estimate(declaredWords, langPair) {
  const rate = rateFor(langPair);
  const w = Math.max(0, Number(declaredWords) || 0);
  return {
    basis: 'declared_word_count',
    accuracy: '±20%~25%（仅依据客户申报字数，未见原文）',
    wordsDeclared: w,
    ratePerUnit: rate,
    amountLow: Math.round(w * 0.8 * rate * 100) / 100,
    amountHigh: Math.round(w * 1.25 * rate * 100) / 100,
  };
}

function formalQuoteAmount(billableUnits, langPair) {
  const rate = rateFor(langPair);
  return { ratePerUnit: rate, amount: Math.round(billableUnits * rate * 100) / 100 };
}

// 两阶段对比说明（前台展示用）
const FLOW_COMPARISON = {
  phase1_estimate: {
    name: '第一阶段 · 预估询价（不接收原文）',
    input: '项目摘要 + 客户申报字数',
    accuracy: '±20%~25%：依赖申报字数，无法识别重复段、格式噪声与不可译内容',
    confidentiality: '最高：原文不离开客户，服务器零素材存储',
    storageCost: '≈0：仅保存摘要与元数据（KB 级）',
  },
  phase2_formal: {
    name: '第二阶段 · 正式评估（受限附件）',
    input: '固定格式附件，经限时授权链接上传',
    accuracy: '精确：按计费口径解析实际可计费字数，重复句段只计一次',
    confidentiality: '受限可控：链接限时、范围限定、仅必要参与者可见、日志不含正文、取消后按期清除且可验证',
    storageCost: '附件全量存储 + 保留期（取消后默认 30 天）内的备份与清除核验成本',
  },
};

module.exports = { estimate, formalQuoteAmount, rateFor, FLOW_COMPARISON };
