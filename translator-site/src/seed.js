'use strict';
// 演示种子数据：四类案例覆盖不同语言对、领域与素材许可组合。
function seed(store) {
  if (store.data.cases.length) return false;
  const add = (c, assets) => {
    const id = store.nextId('case');
    store.data.cases.push({ id, status: 'published', createdAt: new Date().toISOString(), ...c });
    for (const a of assets) store.data.assets.push({ id: store.nextId('asset'), caseId: id, ...a });
  };

  add({
    slug: 'contract-en-zh', title: '跨境供货合同（英译中）', domain: '法律', langPair: 'en>zh',
    summary: '2.3 万词跨境供货合同翻译，含违约条款、不可抗力与仲裁条款的体系化处理。',
    role: '独立译者：全文翻译 + 双语术语表维护，与对方法务直接对齐 3 轮。',
    challenges: 'shall / should / may 的义务层级在中文里如何区分；英美法概念与《民法典》体系的对齐。',
  }, [
    { kind: 'source', license: 'restricted', content: 'Clause 14.2: The Supplier shall indemnify...（源文受保密约束，仅摘要公开）' },
    { kind: 'translation', license: 'restricted', content: '第 14.2 条：供应方应赔偿……（译文受保密约束）' },
    { kind: 'annotations', license: 'public', content: '术语对照批注（已脱敏）：indemnify → 赔偿（非“补偿”）；consequential loss → 间接损失，按合同语境限定范围。' },
  ]);

  add({
    slug: 'patient-guide-zh-en', title: '患者教育手册（中译英）', domain: '医疗', langPair: 'zh>en',
    summary: '术后康复患者教育手册，1.1 万字，面向英语读者改写剂量与复诊说明。',
    role: '独立译者 + 医学审校协调：翻译后组织执业护士审读一轮。',
    challenges: '剂量表述的零容错；把“遵医嘱”类模糊表述改写为可执行的英文指令句。',
  }, [
    { kind: 'source', license: 'public', content: '源文样段：术后 48 小时内避免伤口沾水，如出现红肿热痛请及时复诊。' },
    { kind: 'translation', license: 'public', content: 'Translation sample: Keep the wound dry for 48 hours after surgery. Return to the clinic promptly if redness, swelling, warmth, or pain occurs.' },
    { kind: 'annotations', license: 'public', content: '批注：避免直译“沾水”为 touch water，用 keep ... dry 符合英文医嘱习惯。' },
  ]);

  add({
    slug: 'game-loc-ja-zh', title: '手游剧情本地化（日译中）', domain: '游戏', langPair: 'ja>zh',
    summary: '某二次元手游主线剧情第 4 章本地化，约 8 万字，含角色口癖与梗的再创作。',
    role: '主译者：负责第 4 章全部剧情文本，与另两名译者统一术语与角色语气。',
    challenges: '角色口癖（语尾、自称）在中文里的稳定再现；日文梗的中文等效替换而非直译。',
  }, [
    { kind: 'source', license: 'restricted', content: '（未公开剧情源文，版权方保密要求）' },
    { kind: 'translation', license: 'restricted', content: '（未公开剧情译文，版权方保密要求）' },
    { kind: 'annotations', license: 'restricted', content: '（内部对照批注）' },
  ]);

  add({
    slug: 'short-story-en-zh', title: '短篇小说试译样章（英译中）', domain: '文学', langPair: 'en>zh',
    summary: '当代英语短篇小说试译样章 3000 词，重点处理叙事声音与留白。',
    role: '独立译者：试译样章，译文经原作者代理人授权公开，原文受版权限制。',
    challenges: '保留原文短句节奏；方言对白的中文“去方言化”处理与可读性平衡。',
  }, [
    { kind: 'source', license: 'restricted', content: '（原文受版权保护，不公开）' },
    { kind: 'translation', license: 'public', content: '译文样段：雨停了。他没有回头，也没有说再见。站台上只剩下行李箱轮子碾过积水的声音。' },
    { kind: 'annotations', license: 'public', content: '批注：原文三个短句并列，译文保留同样的停顿节奏，不增补连接词。' },
  ]);
  return true;
}

if (require.main === module) {
  const path = require('path');
  const fs = require('fs');
  const { Store } = require('./store');
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, 'store.json'));
  const changed = seed(store);
  store.save().then(() => console.log(changed ? 'seeded' : 'already seeded'));
}

module.exports = { seed };
