# D1 读量优化调研（issue #29）

日期：2026-11-25。范围：`evepupil/TokenBoard` issue #29（D1 免费额度 500 万行读/天；11-24 实测 4,744,617 行 = **94.9%**；issue 里的 91% 是当天告警时刻的瞬时值，与日终总量不是同一口径）。
本文是调研 + 方案设计，不含代码改动。所有社区/官方出处附在文末。

## 一、计费与平台事实（决定方案边界）

1. **按扫描行计费，不按返回行**：`SELECT * FROM t WHERE unindexed_col = ?` 返回 1 行也可能算 5000 行读（官方 Pricing「Definitions」第 1 条）。
2. **索引是主杠杆**：官方明确「filtering on an indexed field 只读子集」；写路径每个索引多 1 行写，读收益远大于写成本（Pricing 第 5/6 条）。
3. **`batch()` 是单事务**：D1 文档原文 "Batched statements are SQL transactions. If a statement in the sequence fails ... aborts or rolls back the entire sequence."。可用它做「summary + totals」的原子增量更新，无需应用层补偿。
4. **`CREATE TRIGGER` 在 D1 上实际存在但不建议依赖**：2024 年社区反馈「建得成但不确定生效」；2024-05 官方仓库 issue #42 的复现步骤直接用了 `AFTER UPDATE OF val ON test FOR EACH ROW`，说明后来确实会触发——但它是未文档化的边缘能力（那个 issue 报的正是触发器绕过类型校验的 bug）。主线方案不依赖触发器。
5. **只读副本不改变计费**：read replication 改善延迟与吞吐，行读仍照算；且要求全部查询走 Sessions API。对本问题（绝对量过大）无直接帮助，不采纳。
6. **免费额度超限即报错**：不是降级而是查询失败（FAQ）。所以必须留余量，不能贴着 5M 设计。
7. **`EXPLAIN QUERY PLAN` 可在本地 node:sqlite 上预演**，官方也把 EQP 列为验证索引的标准手段；`PRAGMA optimize`（ANALYZE）建索引后应跑一次。

## 二、issue 归因的代码级复核（本地实测）

用 3780 行合成数据（60 天 × 21 源 × 3 模型）跑 EQP，三处结论：

| 查询                                                                                                               | issue 说法                  | 实测                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快照核对（655k 行/427 次）                                                                                         | 「不像走索引」              | **确认**：`SEARCH ... USING INDEX daily_usage_user_device_date_idx (user_id=? AND device_id=?)`，读该设备全部日期再过滤。改成行值 `(source,usage_date,model) IN (VALUES ...)` 后 → `SEARCH ... USING INDEX daily_usage_logical_key_device_idx`（每 key 恰好 1 行），**无需新索引**（生产分块值为 32 key；本轮 Codex 复验 30/32 key 均走完整逻辑键索引，「33」是合成样本数）                                                                                                                                                                     |
| 看板去重 CTE（661k 行/天）                                                                                         | 「全表自连接」              | 部分修正：外层是 `user_id + usage_date 范围` seek，内层 NOT EXISTS 走 covering index，**已是索引最优**；贵在读 `daily_usage` 设备粒度原始行而非已维护的 summary                                                                                                                                                                                                                                                                                                                                                                                 |
| totals 核对（2.63M 行/506 次，单项占 11-24 的 55.5%；issue 的 57% 是「totals + 伴随 INSERT 14.8 万」的**组口径**） | 「cron 每 15 分钟全量重算」 | 修正：cron 的 backfill 在 `completed_at` 置位后立刻返回（`backfill.ts:36`）；放量来自 **ingest 每批**（`upsert.ts:39`）与 **check 端点**（`snapshot-hashes.ts:58`）。机制要更精确：`listUserIdsNeedingTotalRefresh` 只对「本批没有 summary 刷新 key」的 unchanged 用户跑（`upsert.ts:37-43`），同一用户连续批次里只有第一批触发它；但被改变的 key 会进 `knownSummaryRefreshUserIds`，随后以 `prepareUserTotalFromSummaryRefresh` 每批一次整用户 summary 全扫。确切降幅以上线后 GraphQL 复测为准，文中的 2.63M→~60k 是按「每请求一次」建模的上界 |

## 三、社区/官方主流方案盘点

按「对本问题适用度」排序。行业共识可概括为：**不要在每个请求路径上让数据库重新推导同一答案；把推导结果物化，并把读路径切到物化结果上。**

### 方案 A：物化派生值 + 读路径切换（社区案例的主力）

- 案例：Elvis Onunwa 的 98.8% 削减（344k→4k 行/小时）：①「cache before D1」；② 昂贵派生视图预计算成快照；③ 刷新去重防雪崩；④ 全局排名查询拆成有界 top-N 批量。其 Step 6 的原话与我们的诊断一致：检查 EQP 里的「broad OR / EXISTS conditions」。
- 对本项目：我们的 `daily_usage_summary` 已经是半成品物化层，缺的是 (1) `user_usage_totals` 的**增量**维护、(2) 读路径从去重 CTE 切到 summary。
- **安全网比看上去弱（codex 复核确认）**：`summary-parity.sqlite.test.ts` 走真实 ingest 后再比 strict 与 fallback，但 fallback 只对「summary 里缺失的行」回退去算 `daily_usage`（`fallback_daily_usage_summary` 的 `NOT EXISTS`），一旦 summary 行存在，两种模式读的是**同一张表**——所以该测试证明的是「缺失行回退一致」，不是「去重 CTE 与 summary 聚合一致」。切 strict 前需要补一组对照组：手工写入错误的 summary 行，断言 fallback=summary 与 strict 的差异，以及「自愈核对能修回错误行」。另外错误已存在 summary 行不会被回退路径修正，切 strict 也不会——只能靠每日自愈核对（`summaryRefreshCheckSql` 比对 expected 与 stored 后刷新）。

### 方案 B：缓存优先（Cache API / Worker cache）

- **公开卡片已经缓存了**（更正我先前的判断）：`server.ts` 的 `handlePublicApiRequest` 对 `/api/public/:slug.{json,svg}` 有 300 秒 Worker cache（`PUBLIC_API_WORKER_CACHE_CONTROL`），命中在限流之前直接返回；隐私校验（`assertPublicUsageVisible`）先于 cache key，key 里哈希了 `summaryUpdatedAt`，所以每次 ingest 刷新 summary 都会使该用户的卡片缓存失效。issue 里 661k 行的去重聚合正是**缓存失效后的 miss 路径**（139 次/天），不是每请求都跑。
- 因此缓存层不是缺口；缺口是 miss 路径本身在扫描 `daily_usage` 设备粒度原始行——二期切 `strict` 正好让 miss 走 summary。
- **真正 `no-store` 的是看板/排行榜页面**（`routes/leaderboards/index.tsx:16`、`fragment.tsx:15`，每个匿名请求都达 D1，已有限流兜底）。给它们加缓存需要处理「当前用户排名高亮」之类的个性化部分，可与二期并行评估，但不是本 issue 的主因。
- 判断：缓存不作为一期，但「卡片 miss 因 ingest 而失效」说明一期的增量维护会直接减少卡片 miss 的代价（miss 的 visibility 读本来就是 1 行 MAX，0039 索引）。

### 方案 C：触发器维护聚合（SQLite 原生）

- 标准做法（计数器表 + AFTER INSERT/UPDATE/DELETE 触发器）；D1 上语义可用但未文档化（见 §1.4），且 issue #42 显示类型校验有洞。
- 判断：**不采纳**。我们的应用层已能拿到旧值/新值（refresh key 的 summary 旧行 → 新行），差值更新在 batch 事务里完成即可，语义同等且不依赖边缘能力。

### 方案 D：限流/节流（社区主流算法）

- 四种算法（固定窗口/滑动日志/漏桶/令牌桶）的取舍已在社区与官方文档充分讨论：
  - **固定窗口**：最简单，但有边界突刺（跨窗前后的 2× 峰值）；本项目 `api_rate_limits` 当前就是固定窗口（`reset_at` 计数），突刺风险已有（120/60s）。
  - **滑动窗口日志**：精确但存储 O(N)。
  - **漏桶**：整流输出，适合「把请求变成恒定速率」。
  - **令牌桶**：允许突发、长期平均受限，是 API 网关的主流默认。
- 对本项目的价值分两类：
  1. **写侧节流**（collector 的上传节奏）：这是 issue 的真实放大器——一次 hook 全量收集后，`upsert` 的**每个 30 条批次**都触发一次 totals 全扫。把它看成「写放大的读」：最有效的节流不是限制请求数，而是**合并/去重**（每个请求只做一次 totals 增量，而不是每批一次）——这正是社区案例 Step 3 的 "dedupe refresh work"。
  2. **读侧匿名限流**：现有 `api_rate_limits` 是固定窗口（`lib/rate-limit.ts` 的 `reset_at` 计数）。升级为令牌桶可平滑跨窗突刺，但对本 issue 非主因；且 Workers 的 `ratelimits` binding 是「近似、分地域」（官方明确 counts 最终一致），若要严格限速需 Durable Objects，成本高于收益。列为三期按需。

### 方案 E：查询形状优化（零迁移）

- 快照核对（3 元键 + 绑定 `user_id, device_id`）改行值 IN 有实测收益：33 key 的 `OR` 链被规划成 `daily_usage_user_device_date_idx (user_id, device_id)` 全设备扫，行值 IN 改成 `daily_usage_logical_key_device_idx` 每 key 1 行。
- **但 4 元键的 `summaryRefreshCheckSql` 不能套用同一结论**（codex 复核 + 本机复测）：它的 `OR` 形式已被规划成 `MULTI-INDEX OR`，每个 key 都是 covering index 点查（`user_id, usage_date, source, model`），**本来就是最优**；改行值 IN 反而在无统计信息时退化成 `user_id` 前缀扫，`ANALYZE` 后也只到 3 列前缀 + Bloom filter。结论：这一条保持现状，不动。
- 社区共识补充：批量单往返（`batch()`）+ 有界 top-N + 用 EQP 验证，是「零成本胜利」的标准组合；但每条都要单独验证计划，不能从一条查询外推到另一条。

## 四、推荐方案（分三期，按风险/收益）

### 一期（P0，零迁移或单迁移，收益 ≈ 69%）

1. **快照核对改行值 IN**（`snapshot-hashes.ts`）。预计 655k → ~40k 行/天（净值收窄 61.5 万）（`summaryRefreshCheckSql` 维持原样，见方案 E）。
   - 替换后每 key 仍是 3 个绑定，`snapshotHashQueryChunkSize` 公式不变；index 命中从 `(user_id, device_id)` 前缀变成 `daily_usage_logical_key_device_idx` 的完整四元键。
2. **totals 增量维护**：
   - **并发正确性的关键**：不能「先在上一往返读出旧值、JS 算差值、再发 UPDATE」——两个并发上传会各自算出同一个差值并各加一次。D1 的 batch 只保证**批内**顺序执行与原子回滚（官方原文 "each statement ... sequentially, non-concurrently"），不保护跨往返的读-改-写。差值必须在语句内用子查询读取，与批内其它语句串行。
   - **正确性前提（必须写进注释并用测试钉住）**：
     1. 不变量：`user_usage_totals` == 该用户全部 `daily_usage_summary` 行之和。级联删除（`users` → 两表都是 `ON DELETE CASCADE`）同时删两边，所以该不变量只在「手工删过 summary」时会破，由第 3 条的自愈核对修复。
     2. **totals 行必须已存在**。本机探针复现了两种错法：`INSERT OR IGNORE … VALUES(0)` 后做差值，会把「summary 已有其它 key 的行」整体漏算（实测应为 500 实得 200）；反之「summary 行缺失但 totals 仍含它」时 `COALESCE(旧值,0)` 会重复累加（实测应为 100 实得 200）。因此**创建行不能靠 0 值占位**。
   - **推荐形状**（沿用现有每 30 条快照一批的循环）：
     1. **请求开头**一次 PK 点查 `SELECT 1 FROM user_usage_totals WHERE user_id = ?`；不存在时跑**现有的**全量 totals 刷新（`refreshUserTotalsFromSummarySql`）。这是新用户首次上传的罕见路径，一次全扫可接受，也是自愈入口。日常成本 = 1 行读/请求。
     2. **每个 30 条批次**：先放各 key 的**差值 UPDATE**（每 key 一条），再放现有的 `refreshSummarySql` upsert（每 key 一条）。D1 batch 顺序执行且同事务，所以每条差值 UPDATE 读到的「旧 summary 行」都还是 upsert 之前的值——顺序与符号绑定，颠倒就错。单批语句数 30 + 30 = 60，在 100 条批上限内。
        ```sql
        UPDATE user_usage_totals SET
          total_tokens = total_tokens + (新聚合子查询) - COALESCE((旧 summary 行子查询), 0),
          ...（其余四列同理）,
          updated_at = ?
        WHERE user_id = ?
        ```
        「新值」= 对 `daily_usage` 的既有去重聚合，「旧值」= 尚未被本批 upsert 覆盖的 summary 行。
        - 为什么是逐 key 而不是每批一条聚合 UPDATE：每 key 需要 4 个新值参数 + 4 个旧值参数 = 8 个绑定，30 key 合成一条要 240 个，超 D1 的 100 参数上限；按 12 key 切块可压到每批 3 条，但 SQL 复杂度和「12 个标量子查询拼一条 UPDATE」的可读性不划算，留作写量真正吃紧时的备选。
        - 写量代价：每批最多 30 次对同一行的 totals 写（当前每批 30 次 summary 写），即 ingest 写量约翻倍。免费额度写 10 万行/天，按现状余量充足；复测时一并看 `rowsWritten`。
        - 本地 EQP 已确认三处全是点查：去重聚合走 `daily_usage_logical_key_device_idx (user_id, usage_date, source, model)`、旧 summary 与 totals 走主键，无新增索引。
   - **时间戳不要用 SQL 的 `strftime('now')`，也不要一次请求共用一个**：本机探针确认同一事务里两条 `strftime('now')` 相等但不能当不变量；而按「每请求一个戳」绑定，会让公开卡片缓存 key（`server.ts` 的 `publicApiCacheKey` 哈希了 `usageUpdatedAt`/`summaryUpdatedAt`）在整个请求内保持不变——本机（codex 探针）复现：30 批之后与 31 批之后的 totals 不同但 cache subject 完全相同，中途缓存的卡片会以旧 body 留在 300 秒 TTL 里。**按批生成一次** `new Date().toISOString()`（格式与 summary 的 `%Y-%m-%dT%H:%M:%fZ` 逐字节可比），同批的差值 UPDATE 与 summary upsert 共用它：批间时间戳推进使 cache key 在下一批立刻失效，批内两者相等满足 `public-card/service/totals.ts` 的 `updated_at >` 新鲜度判断（相等即不回退）。
   - 既有门控必须延续：`totals_refresh_allowed` 要挂在新路径的**全量刷新与差值 UPDATE** 上；backfill 未完成时两者都不写（`summary-cache.integration.test.ts` 的「ingest does not write partial totals while summary backfill is incomplete」守这条）。
   - 删除 `upsert.ts:39` 与 `snapshot-hashes.ts:58` 的全量核对调用。
   - 预计 totals 项 2.63M → ~60k 行（**净值收窄 257 万**；§6.3 汇总按毛额 263 万计，属口径性高估约 6 万）。注意交互侧有一条互补项：客户端上传批 30→200 会把「多个请求各自 <30 条的变化」合进同一内部批，直接减少 ingest 侧 totals 刷新次数（详见 `2026-11-25-client-server-throttle-audit.md` §4.1）；该项需先过 Worker 预算实测。成本模型：每请求 1 行 PK 读；每刷新 key 的差值 UPDATE 要再算一次去重聚合（device 行通常 1–3 行）+ 读 1 行旧 summary，即每 key 约 3–5 行读，30 key/批 ≈ 100–150 行/批。为什么不能省掉这次重复聚合：D1 的 batch 是「先构造全部语句、整批发回结果」，JS 拿不到批内中间值来拼后续语句；若改成两个往返（先读旧值、JS 算差值、再 UPDATE），并发 ingest 会在这个窗口里丢更新（两方各按同一旧值算差值）。所以差值必须自包含在语句内，重复聚合是换取正确性的代价。
3. **每日一次的自愈全量核对**（保留现有 backfill 形状，挪到 `isDailyMaintenanceWindow`，加 limit 游标）。预计 ~50k 行/天。

- 风险与护栏：`summary-cache.integration.test.ts` + `summary-parity.sqlite.test.ts` 全绿；新增「增量后 totals == 全量重算」性质测试（新用户、legacy 去重、correction、codex session-only）；新增 EQP 断言（`runSql('EXPLAIN QUERY PLAN ...')` 断字串含 `daily_usage_logical_key_device_idx`）。

### 二期（P1，配置切换，收益 ≈ 14%）

- 把 `TOKENBOARD_USAGE_SUMMARY_STRICT` 切 `true`，看板/排行榜/公开卡片走 summary-only。
- 前置：一期上线后观察 3 天，summary 写入路径无漂移（用自愈核对的日志计数为证）；**补一组对照测试**证明错误 summary 行会被自愈核对修回（见方案 A 的安全网说明）。
- 回滚：改回 `false` 即回退到去重 CTE 路径，无需迁移。注意回滚**不会**修正已经写错的 summary 行（fallback 只在行缺失时兜底），所以回滚后仍要靠自愈核对收敛。
- 需要与 yeton 协调部署（chaosyn 配置在他手里）。

### 三期（按需，非本期）

- 匿名读的令牌桶限流（平滑固定窗口突刺）；公开卡片的短 TTL 缓存（需解决隐私失效）；`model_pricing` 的 `pricing_json` 拆列以减少行宽（对行读计费无影响，仅存储/传输）。

## 五、写量优化（2026-11-25 追加，实测）

issue #29 只报了读，写量目前没有接近额度；但一期的 totals 增量会吃掉一部分写余量，所以写侧要做配套的三件（并在同一批改动里完成，保持「读大降、写不涨」）。

### 实测方法

用仓库真实 migrations 建临时 SQLite，在每个写入表上挂 `AFTER INSERT/UPDATE/DELETE` 计数触发器，调用真实仓库函数（`upsertUsageSnapshots` / `markIngestSynced` / `findExistingSnapshotHashes`）。复跑脚本已归档在同目录 `2026-11-25-d1-write-probe/`：`write-probe.mts`（写量）、`delta-correctness-probe.mjs`（差值公式两种错法）、`index-drop-plan-probe.mjs`（删索引前后 EQP）。

### 实测结果（逻辑行写；D1 计费还要按索引数放大）

| 事件                     | 逻辑写 | 明细                                            |
| ------------------------ | ------ | ----------------------------------------------- |
| 首次上传 30 个新 key     | 64     | daily_usage 30 + summary 30 + totals 1 + 心跳 3 |
| 重传 30 个内容不变的 key | 3      | 只有心跳；数据行被 `snapshot_hash <>` 守卫跳过  |
| 30 个 key 中 1 个变化    | 6      | daily_usage 1 + summary 1 + totals 1 + 心跳 3   |
| check 端点 30 key        | 0      | 路由层另有 2 次限流计数写                       |

D1 口径：写入索引列时**每个索引各计 1 行写**（官方 Pricing 定义第 6 条）。按现有索引，首传 30 个新 key ≈ **244 行写**（30×(1+4) + 30×(1+2) + 1 totals + 3 心跳；v1 写 245 是取整误差）。写量主体是「当天新出现的 key」，不是每次同步。

### 采纳项

- **W1 删 `daily_usage_user_date_idx`**（零读损失，本机 EQP 已验证）。它是 `daily_usage_logical_key_device_idx(user_id, usage_date, source, model, device_id)` 的严格前缀。逐条对比执行计划：`MAX(usage_date)`、按用户去重范围、设备过滤范围、backfill 全走、快照核对——**代表查询保留原 seek 形状**（Codex 终审复验：`MAX` 与用户日期范围查询改走逻辑键索引、仍是有界查找）；D1 真实计费仍需隔离环境复验。首传批次索引写 −1/行（5→4）。migration 形状参考 0029/0034，同时改 `app/db/schema.ts:62`。
- **W2 totals 增量写成批量语句**：不用「每 key 一条 UPDATE」，用 `WITH newkeys(...) AS (VALUES ...)` 每 15 key 一条（4 列 × 15 = 60 绑定），每 30 条批次 2 条语句，写量每批 ≤2 行。
- **W3 summary upsert 加值相等守卫**（提案，现状未实现）：`refresh.ts:208` 的 `ON CONFLICT DO UPDATE` 目前每次都写；应加 `WHERE` 比较全部值列，让 8 个聚合值全未变时跳过写入。收益双份：少一次写，且不推进 `updated_at` → 公开卡片缓存 key 不失效，连带少读。需新测试钉住「值不变时 updated_at 不动」。
- **W4 心跳三写节流（已撤回，2026-11-25 复核）**：`markIngestSynced` 每次 ingest 写 `upload_tokens`（必写）以及 `devices`/`device_installations`（仅设备/安装 id 非空时，`sync.ts:28,48`）。原提案「距上次写入超过 N 分钟才更新」撤回——用户明确要求 Web 端随时可见及时数据，而两次上传间隔已被 **900s** 冷却限定（`notify.mjs:36`），N ≤ 15 分钟是空操作、N 更大只会让「最近同步」信号滞后（正是时效指标）；且实测心跳写约 150–300 行/天（49 次调用 × 1–2 次 ingest × 3 行），对 10 万写额度可忽略。评估见 `docs/research/2026-11-25-client-server-throttle-audit.md` §4.4。
- **W5 `daily_usage_summary_user_updated_idx` 替代**（可选，中风险）：该索引只服务 `profile.ts` 的 `MAX(updated_at)`。若改读 `user_usage_totals.updated_at`（一期后两者同步推进）可删，summary 新行索引写 2→1。风险：耦合变强，fallback 模式语义需重验。

### 明确不做

- `daily_usage_usage_date_idx`：fallback 排行榜按日期跨用户扫，删了变全表扫描。
- `daily_usage_user_device_date_idx`：设备过滤页与当前快照核对依赖它；一期后可退到 logical_key 前缀，但设备页会从精确 seek 退化为扫该用户窗口所有行——实打实的读损失。
- 限流双计数（token + IP）：安全设计，非冗余。
- `model_pricing` 同步：已只写差异行（见 `repository.ts` 注释），日写量十几行。
- 每日 prune 的 DELETE：必要的清理成本。

## 六、方案全景评估（2026-11-25 追加）

把已讨论和用户提出的全部分支放进同一张表，逐项核对官方计费与平台约束后排序。「读削减」按 11-24 的 474 万行/天为基数。

### 6.1 关键平台事实（先排除一批「看起来能绕开」的方案）

1. **Durable Objects 的 SQLite 存储与 D1 是同一套计费额度**：官方 DO Pricing 页原文——5M rows read/day 免费、100k rows written/day 免费（2026-01 起对 SQLite 存储计费）。把聚合搬进 DO **不会**换来额度，只是换来「每用户单线程串行」这一条能力。
2. **Queues 免费额度 10,000 ops/day，一条消息 3 ops**（写/读/删）→ 每天约 3,300 条消息封顶；且 ingest 必须等落库才能回 200（客户端靠 200 才 ack cursor），write-behind 会把延迟加到请求里而不是省掉。
3. **KV 免费额度：读 100k/day、写 1,000/day**。缓存失效（每次 ingest 使该用户卡片失效）就可能撞上 1k 写/天。
4. **Cache API 不计费**，且本项目公开卡片已经在用（300 秒）。
5. **Worker 内存不能跨请求承载状态**：isolate 会被驱逐，且同一用户的两个请求可能落到不同 isolate（官方 How Workers works 原文）。「内存暂存一天再落库」在读写两侧都不可行：数据会丢、读者会拿到不同数值。
6. **Go 客户端已经是「check 后只传变化」**：`upload.go` 的 `UploadSnapshots` 对每个 30 条批次先调 `/check`、只对本批变化的快照发 ingest。所以「客户端减量」这条已闭合——但它正是每个批次一次 check 的来源（427 次/天）。
7. **免费额度超限即报错**（读/写都是），没有降级缓冲，方案必须留倍数额度。

### 6.2 评估矩阵

| 方案                                     | 每日读削减           | 每日写变化                      | 延迟/一致性                                   | 复杂度     | 风险                                                            | 结论                       |
| ---------------------------------------- | -------------------- | ------------------------------- | --------------------------------------------- | ---------- | --------------------------------------------------------------- | -------------------------- |
| **P0-a 快照核对改行值 IN**               | ~60 万               | 0                               | 无                                            | 低         | 低（D1 实测兜底）                                               | **采纳**                   |
| **P0-b totals 增量维护**                 | ~270 万              | 每批 +≤2 行                     | 无（同批事务）                                | 中         | 中（差值正确性，已有两种错法复现与对策）                        | **采纳**                   |
| **P1 切 summary strict**                 | ~66 万               | 0                               | 无                                            | 低（配置） | 中（物化漂移，需对照测试）                                      | **采纳（二期）**           |
| **W1 删冗余索引**                        | 0                    | 每新行 −1 索引写                | 无（EQP 已逐条验证）                          | 低         | 低                                                              | **采纳**                   |
| **W3 summary 值守卫**                    | 间接（减少缓存失效） | 少写                            | 无                                            | 低         | 低                                                              | **采纳**                   |
| **W2 totals 差值批量语句**               | —                    | 避免 +30 行/批                  | 无                                            | 低         | 低                                                              | **采纳**                   |
| **W4 心跳节流**                          | 0                    | 约 −2/3（150–300→更少/天）      | 「最近同步」信号滞后，违背时效前提            | 低         | 低                                                              | 撤回（2026-11-25）         |
| **限流迁 Workers Rate Limiting binding** | −1 读/请求（~5k/天） | −2 写/请求（~10k/天）           | 近似、分机房；周期只支持 10/60s               | 低         | 中（近似语义需接受的只有 60s 窗口策略）                         | 三期，逐策略迁移           |
| **Cache API 扩到排行榜**                 | 排行榜重算读         | 0                               | 最多 60s 旧数据                               | 中         | 中（个性化高亮需拆分）                                          | 三期可选                   |
| **KV 当缓存层**                          | 公开卡片 miss 读     | KV 写（免费 1k/天）             | 最终一致                                      | 中         | 中（1k 写/天撞限额）                                            | 不采纳                     |
| **Durable Objects 逐用户聚合**           | 0（额度相同）        | 0（额度相同）                   | 跨区 +延迟                                    | 高         | 高（全量重写聚合层）                                            | 不采纳                     |
| **Queues write-behind**                  | 0                    | 队列 op 计费，~3.3k 消息/天封顶 | ingest 延迟变长                               | 高         | 高                                                              | 不采纳                     |
| **Worker 内存暂存 + 每日落库**           | 0                    | 0                               | **不可行**：驱逐丢数据、跨 isolate 数值不一致 | —          | 破坏正确性                                                      | 不采纳                     |
| **R2 暂存 + cron flush**                 | 0                    | R2 Class A op                   | 读变慢                                        | 高         | 高（读改写竞态）                                                | 不采纳                     |
| **删 90 天前原始行**                     | 存储降               | 删除写                          | 无                                            | 中         | 高（与「重传覆盖历史」「correction」「session-only 保护」冲突） | 不采纳，除非存储告警       |
| **升 Workers Paid（$5/月）**             | 额度 25B/月          | 50M/月                          | —                                             | 无         | 无                                                              | 业务决策，与代码优化不冲突 |

### 6.3 最优解

按「读削减 × 风险 × 复杂度」排序后的组合：**P0-a + P0-b + W1 + W2 + W3 同批实施（一期），P1 观察三天后切换（二期），限流迁移按需（三期）**。W4 已撤回（见 §五）。

理由：

- 一期+二期合计净削减约 **390 万行（82%）**：totals 257 万（净值）+ 快照核对 61.5 万（净值）+ 看板去重 66 万；剩余约 84 万（18%，其中 53 万是 issue 未归因部分，另含 6 万 totals 残余、4 万核对残余、约 5 万 B6 每日自愈），在 500 万免费额度内留约 **5.9 倍**余量。（若「伴随 INSERT」14.8 万也随 P0-b 消失，降幅可到 86%——两种口径二选一，上表按保守口径。）写量因 W1/W2/W3 抵消，基本持平。
- 所有采纳项都在现有 D1 单库内完成，**不引入新服务、不改读路径的语义、不新增一致性模型**；每个改动都有现成测试系（summary-cache.integration、summary-parity、idempotency）或可加的 EQP 断言兜底。
- 被否的方案不是「不好」，而是在**同一套行计费额度**下不解决问题（DO）、或在免费额度下自身就撞限额（KV 写 1k/天、Queues 3.3k 消息/天）、或破坏正确性（Worker 内存、删原始行）。
- 若一年后数据量再翻十倍：优先重估「升 Paid」与「Cache API 扩排行榜」，而不是迁 DO/Queues——因为那两者不改变计费口径。

### 6.4 用户提出模式的适用边界（记录）

「每日定时落库」只对**可重算的派生值**安全，本项目已经有两处这样的先例：模型定价同步（日间隔）与每日自愈核对。对**源数据**（daily_usage 行）用这个模式，会让派生值比源值新，触发公开卡片的回退重算——用写换读，方向相反。

## 七、明确不做

- **触发器**：未文档化、有已知 bug（#42），且应用层能拿到旧新值。
- **只读副本**：不改变行读计费。
- **给 `model_pricing` 加覆盖索引**：行宽大，索引复制不划算；其 1.2% 占比非头号。
- **无脑缓存 SQL**：ingest 是写路径，缓存帮不上。公开卡片已按 300 秒 Worker cache 处理（见方案 B），看板/排行榜是 `no-store` 且含个性化高亮，不在本期范围。

## 八、验证与上线口径

1. 本地：node:sqlite EQP 断言（已在本机验证行值 IN 可用）；vite 测试套件（web）全量。
2. 隔离环境：私人 CF（`tokenboard-independent`）实测行值 IN 语法与「差值 UPDATE + summary upsert」同批是否被 D1 接受；用 `wrangler d1 insights --sort-by=reads` 前后对比。
3. **降级路径**（若 D1 拒绝行值 IN）：回退成单列 `source IN (...)` + `usage_date IN (...)` + `model IN (...)` 的笛卡尔积式 IN 列表——仍然命中 `daily_usage_logical_key_device_idx` 的前缀，代价是可能多读同日期其它 source/model 的行。上线前在私人环境实测 EQP 即可确定选哪条。
4. 线上：issue 里同一套 GraphQL（`d1QueriesAdaptiveGroups`）对比次均行读与日总量。按 11-24 的 474 万行做算术（归因合计 422 万，占 89%；**53 万未归因**，复测时要重新按查询拆分）：
   - 一期省约 200–342 万（43%–72%，取决于 ingest 批次放大倍数——精确值要复测；本表按「每请求一次」上界建模）；
   - 二期再省 ≈ 66 万（14%）；
   - 剩下的主要是 53 万未归因读 + 自愈核对 ~5 万，复测时重排归因再定三期。
     分阶段验收，不要指望单次上线直达个位数。
5. 兜底：一期在线增量路径只读写既有行（写量按 §五 W1–W3 配套压减后不增加），失败面小于二期；如二期上线后发现漂移，可当日切回 `false`。

## 九、来源

- Cloudflare D1 Pricing（计费定义、索引与行读写关系）：https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1「Find slow and expensive queries」（`events.d1Queries`、rowsRead/queryEfficiency）：https://developers.cloudflare.com/d1/observability/find-expensive-queries/
- Cloudflare D1「Use indexes」（EQP、PRAGMA optimize）：https://developers.cloudflare.com/d1/best-practices/use-indexes/
- Cloudflare D1 Database `batch()`（单事务语义原文）：https://developers.cloudflare.com/d1/worker-api/d1-database/
- Cloudflare D1 FAQ（超限即报错、dashboard/qw 查询也计费）：https://developers.cloudflare.com/d1/reference/faq/
- Cloudflare D1「Global read replication」（不改变行读计费）：https://developers.cloudflare.com/d1/best-practices/read-replication/
- Cloudflare Workers Rate Limiting binding（近似、分地域、10/60s 周期）：https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- D1 CREATE TRIGGER 社区反馈（建得成但不确定生效）：https://www.answeroverflow.com/m/1179125069440626790
- cloudflare/developer-platform issue #42（触发器复现，证明后来会触发，但类型校验有洞）：https://github.com/cloudflare/developer-platform/issues/42
- 社区案例：D1 row reads 98.8% 削减（cache-first SSR + query snapshots + EQP）：https://elvisonunwa.com/no-code-tools/reduce-cloudflare-d1-row-reads-cache-ssr
- 限流算法全景（固定窗口/滑动日志/漏桶/令牌桶取舍）：https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices
- D1 事务取舍（event-driven.io）：https://event-driven.io/en/cloudflare_d1_transactions_and_tradeoffs/
- Cloudflare Durable Objects Pricing（SQLite 存储与 D1 同额度）：https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare Queues Pricing（10k ops/day 免费、单消息 3 ops）：https://developers.cloudflare.com/workers/platform/pricing/#queues
- Cloudflare Workers KV Pricing（读 100k/天、写 1k/天免费）：https://developers.cloudflare.com/kv/platform/pricing/
- Cloudflare R2 Pricing（Class A/B 操作计费）：https://developers.cloudflare.com/r2/pricing/
- Cloudflare Workers「How Workers works」（isolate 驱逐、禁止跨请求全局状态）：https://developers.cloudflare.com/workers/reference/how-workers-works/
