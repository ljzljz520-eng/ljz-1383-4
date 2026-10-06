# 林译 · 自由译者作品站 + 两阶段委托估价平台

零依赖 Node.js（≥18）实现：公开作品展示、按语言/领域浏览、客户网页提交项目摘要、
服务 API 持久保存保密级别 / 素材授权 / 报价版本，并覆盖全部验收场景。

## 运行

```bash
npm start          # 启动 http://127.0.0.1:3000（首次自动写入演示数据）
npm test           # 12 项验收测试（node:test，无外部依赖）
PORT=3100 ADMIN_TOKEN=xxx DATA_DIR=/var/data node src/index.js
```

页面：`/` 案例浏览 · `/case.html?slug=…` 案例详情 · `/submit.html` 两阶段委托 ·
`/quote.html` 报价确认 · `/admin.html` 译者后台（默认开发令牌 `dev-admin-token`，生产用 `ADMIN_TOKEN` 覆盖）。

## 架构

```
src/server.js     HTTP 路由 + 访问控制 + 报价状态机 + 两阶段交接
src/store.js      JSON 文件持久层（tmp+rename 原子写，写串行化）
src/licensing.js  素材许可过滤：公开视图 / 搜索索引 / 下载包共用同一过滤口径
src/wordcount.js  固定格式解析 + 计费口径
src/quotes.js     预估（区间）与正式评估（精确）定价
src/retention.js  取消后的附件保留/清除/墓碑核验
src/audit.js      审计日志（拒绝键 + 标量化 + 截断，绝不写正文）
src/tar.js        最小 ustar 打包器（下载包）
```

## 素材许可模型（案例）

每个案例的三类素材**分别持有许可**：`source`（源文）/ `translation`（译文）/ `annotations`（对照批注）。
`public` 才进入公开页、搜索索引与下载包；`restricted` 只回 `locked` 标记。
搜索索引由「公开字段 + public 素材」构成，检索结果只回公开卡片；
下载包为 tar，内含 `MANIFEST.json` 明示包含项与排除项及原因。
公开页展示译者的**真实角色**与**难点**（`role` / `challenges` 字段）。

## 两阶段询价对比

| | 第一阶段 · 预估询价 | 第二阶段 · 正式评估 |
|---|---|---|
| 输入 | 项目摘要 + 申报字数（**不接收原文**） | 固定格式附件（限时授权链接上传） |
| 估算准确度 | ±20%~25%，无法识别重复段/格式噪声 | 精确：按计费口径解析，重复句段只计一次 |
| 保密 | 最高：原文不离开客户，服务器零素材存储 | 受限可控：链接限时、范围限定、仅必要参与者可见、日志无正文、取消后按期清除可验证 |
| 存储成本 | ≈0（仅摘要元数据） | 附件全量 + 保留期（取消后默认 30 天）备份与清除核验 |

`GET /api/flow-comparison` 返回该说明，前台提交页同步展示。

## 字数统计：固定格式 + 计费口径

**固定格式**（其余一律拒绝：`.docx` 等 → 415，格式违例行 → 422）：
- `*.txt` / `*.md`：UTF-8 纯文本，全文为源文；
- `*.align.txt`：`SRC> 源文句段` / `TGT> 译文句段` / `#` 注释 / 空行。

**计费口径**：CJK 每字 1 单位；拉丁/数字连续串 1 单位；标点不计；
双语文件**只计 SRC 句段**（TGT 不计，避免双语文档重复计数）；
规范化后相同的源文句段**只计一次**（重复段去重并出具统计）。

## 报价版本与确认

- 每次附件上传产生新 `revision` 与新报价 `version`；**附件修订后既有 sent 报价立即 stale，不能自动适用**；
- 客户确认必须携带**明确版本号**（缺省 400，不符 409），且报价须为 `sent` 且基于当前修订；
- 批准采用同步临界区（检查与置位间无 await）：**并发批准只有一个成功**，每委托仅一次有效批准；
- 批准后进入**两阶段交接**：① `materials_transferred`（物料交接）→ ② `delivered`（交付）→ `accepted`（验收），顺序受控（越序 409）。

## 权限、日志与保留策略

- 材料后台仅向必要参与者开放：译者（Bearer）、委托客户（client 链接）、持限时 `materials` 授权链接者；访客 401、跨委托 403、链接过期 410；
- 审计日志只记 actor/action/对象 id/标量元数据，拒绝 content/summary 等键并截断字符串——**日志不写正文**；
- 委托取消 → 附件 `pending_purge`（保留 30 天，含 `purgeAfter`）→ 到期清除内容并留存
  **sha256 墓碑**（`GET /api/admin/retention/verify` 可核验 contentPresent 与墓碑），不是只删列表项。

## 验收测试映射（test/acceptance.test.js）

| # | 验收点 | 测试 |
|---|---|---|
| 1 | 仅摘要公开时搜索索引/下载包不暴露原文 | 许可分离：受限源文不进公开视图/搜索/下载包 |
| 2 | 双语文档重复计数、固定格式解析、计费口径 | 字数统计：固定格式、双语只计 SRC、重复段去重 |
| 3 | 预估 vs 正式评估（准确度/保密/存储成本） | 两阶段询价 + flow-comparison |
| 4 | 源文件替换后原报价不能自动适用；确认对象为明确版本 | 附件修订使原报价失效 |
| 5 | 并发批准旧报价 | 并发批准仅一个成功 |
| 6 | 两阶段交接 | 物料交接→交付→验收顺序受控 |
| 7 | 译者撤下案例 | 公开页/搜索/下载立即 404 |
| 8 | 授权链接过期 | 过期 410 |
| 9 | 后台仅向必要参与者开放材料 | 401/403/200 矩阵 |
| 10 | 日志不写正文 | 审计日志扫描唯一标记 |
| 11 | 取消后附件保留策略可验证 | 保留期→清除→sha256 墓碑→磁盘无正文 |

## 主要 API

```
GET  /api/cases?langPair=&domain=&q=        公开案例（过滤/搜索）
GET  /api/cases/:slug                       公开详情（受限素材 locked）
GET  /api/cases/:slug/download              公开素材 tar 包 + MANIFEST
POST /api/inquiries                         第一阶段：摘要→预估（持久保存保密级别/素材授权）
POST /api/inquiries/:id/upload-link         生成 30 分钟受限上传链接
POST /api/inquiries/:id/attachments         上传固定格式附件→正式报价新版本
POST /api/quotes/:id/approve {version}      确认明确版本（并发安全）
GET  /api/inquiries/:id/materials           材料后台（必要参与者）
POST /api/inquiries/:id/cancel              取消→附件保留期
POST /api/handoffs/:id/deliver|accept       两阶段交接·第二阶段
GET  /api/admin/retention/verify            保留策略核验
POST /api/admin/retention/sweep {asOf}      到期清除（留墓碑）
POST /api/admin/cases | /:slug/unpublish    案例管理
```
