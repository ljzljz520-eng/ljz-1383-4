# 自由译者作品站

访客按语言/领域浏览翻译案例；客户在线提交项目摘要；服务 API 持久化保密级别、素材授权与报价版本，支持「预估询价 → 受限附件正式评估」两阶段交接。

## 运行

```bash
npm install
npm start          # http://localhost:3000  (ADMIN_TOKEN 环境变量可覆盖默认 dev-admin-token)
npm test           # 25 项验收测试
```

- `/` 公开作品页：按语言对、领域筛选，搜索公开内容，查看案例详情与公开素材，下载公开资料包
- `/submit.html` 客户端：提交摘要 → 预估 → 上传附件 → 正式报价 → 确认明确版本 → （可）取消委托

## 核心设计

### 1. 素材许可分离（源文 / 译文 / 对照批注）
`case_materials.license ∈ {public, client-authorized, private}`，三种素材各自独立授权。
**仅摘要公开的案例，其原文不会进入搜索索引，也不会出现在下载包中**——公开详情、搜索、打包三个出口共用同一过滤口径（`license='public'` 且案例未撤下），并有测试保证。

### 2. 两阶段报价对比

| | 预估询价（阶段一） | 正式评估（阶段二） |
|---|---|---|
| 输入 | 摘要 + 客户自报字数，**不接收原文** | 受限附件（固定格式 UTF-8 文本） |
| 估算准确度 | ±35% | ±5%（按实际解析计费字数） |
| 保密性 | 最高：原文不离开客户环境，服务端零正文 | 附件按保密级别限定参与者；限时授权链接可分享给校对等必要人员；取消后留存期到期可验证删除 |
| 存储成本 | 仅元数据（KB 级） | 附件大小 × 修订版本数；取消后留存 30 天即清除，成本有界 |

交接规则：上传附件后旧正式报价自动 `stale`；正式报价必须基于当前有效附件出具；客户确认的对象是**明确的报价版本**（quote id + version）。

### 3. 字数统计：固定格式解析 + 计费口径
- 仅接受 UTF-8 `.txt`：`plain-v1`（纯文本）与 `bilingual-v1`（首行 `#format: bilingual-v1`，段行 `SRC>`/`TGT>`）；其它格式一律 415/422，不做猜测性解析
- 计费口径：CJK/假名/韩文每字 1 单位；拉丁字母与数字连续串每词 1 单位；标点空白不计
- **双语文档只计源文侧**，译文侧不重复计费
- 计价 = 计费单位/1000 × 语言对基准价 × 领域系数 × 保密系数（`GET /api/billing-policy`）

### 4. 报价版本与并发
- 报价按委托递增版本号；新报价出具时旧报价 `superseded`；附件修订时旧正式报价 `stale`
- 批准走条件更新（CAS）：`UPDATE ... WHERE id=? AND version=? AND status='sent'`，并发下恰好一次成功；重复/过期/版本不符一律 409
- 源文件替换产生新附件版本，**原报价不能自动适用**，须重新评估

### 5. 保密与留存
- 后台材料仅必要参与者可见：译者（admin token）+ 委托客户（client token）+ 有效分享链接持有者
- 授权链接有过期时间，过期/撤销 → 410
- 审计日志只记录动作、版本、字数、哈希等标量元数据；超长字符串在写入处即被拒绝，**正文不进日志**
- 委托取消后附件进入留存期（默认 30 天，可配置）；到期清除任务**真实删除文件字节**并写入 tombstone（内容 sha256 + 策略版本），`GET /api/admin/retention/verify` 可验证「文件已删、哈希一致、无逾期滞留」

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/cases?lang=&domain=` | 公开案例列表（按语言/领域） |
| GET | `/api/cases/:id` · `/api/cases/:id/package` | 公开详情 / 公开资料包（仅 public 素材） |
| GET | `/api/search?q=` | 搜索（索引仅含公开内容） |
| POST | `/api/inquiries` | 客户提交项目摘要（持久化保密级别） |
| POST | `/api/inquiries/:id/estimate` | 阶段一：预估询价 |
| POST | `/api/inquiries/:id/attachments` | 阶段二：上传受限附件（固定格式） |
| POST | `/api/admin/inquiries/:id/formal-quote` | 译者出具正式报价 |
| POST | `/api/quotes/:id/approve` `{version}` | 客户确认明确版本（CAS） |
| POST | `/api/inquiries/:id/cancel` | 取消委托 → 留存策略 |
| GET | `/api/attachments/:id/download` | 参与者方可下载 |
| POST | `/api/admin/share-links` · GET `/api/share/:token` | 限时授权链接 |
| POST | `/api/admin/retention/run` · GET `/api/admin/retention/verify` | 留存清除 / 验证 |
| GET | `/api/admin/audit` | 审计日志（无正文） |

## 验收测试（`npm test`，25 项）
源文件替换使旧报价失效、双语文档不重复计数、并发批准旧报价（恰好一次成功）、译者撤下案例（详情/搜索/下载包同步失效）、授权链接过期与撤销、仅摘要公开时索引与下载包不泄露原文、参与者隔离、取消后留存策略可验证（tombstone 哈希 + 文件真实删除）、日志不含正文、固定格式解析与计费口径、数据库落盘持久化。
