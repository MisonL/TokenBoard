# 批次 B 实现记录：D1 读写优化（B1–B6）

- 日期：2026-11-27
- 状态：六项全部实现并提交；未部署（部署属 C 批次门槛）
- 分支：`feat/skill-swap-selfheal`
- 方案出处：`docs/research/2026-11-25-optimization-final-plan.md` §二·批次 B
- 依据探针：`docs/research/2026-11-25-d1-write-probe/`（写入成本、索引删除、差值正确性）

## 0. 提交映射

| 项 | 提交 | 内容 |
|----|------|------|
| B1 | `3ed8868` perf(ingest): seek snapshot hashes by the full logical key | 行值 IN 替换 OR 链 + EQP 测试 |
| B3 | `5ba6f00` perf(db): drop the redundant daily_usage_user_date_idx | migration 0041 + schema + 迁移形状测试 |
| B5 | `2724dae` perf(ingest): skip unchanged summary and totals rewrites | 两个聚合 upsert 的 `IS NOT` 值守卫 + sqlite 测试 |
| 时间戳重构 | `a26a8b5` refactor(ingest): bind one monotonic batch timestamp into aggregate writes | B2 前置：批内共享、跨批单调 |
| B6 | `187ed3a` feat(ingest): daily aggregate self-heal pass | 三游标自愈核对 + 接线 |
| B2+B4 | `da90f00` perf(ingest): move user totals by per-key deltas | 差值替换两条在线全量核对 |

## 1. 实现期裁决（方案未写死、或写错方向的部分）

### 1.1 差值在「summary 行缺失」时加全值，不加 0

`totals-delta.ts` 的新值/存量都用 `COALESCE(..., 0)`：summary 行不存在时存量为 0，差值即该 key
的完整聚合。两个方向的行为分别是：

- **首次 summarize（正常路径）**：totals 此前不含该 key，加全值正确。
- **summary 行被删后重传（故障路径）**：totals 仍记着被删行，加全值 = 第二次计入。
 探针 `delta-correctness-probe.mjs` 复现过 125 → 250。

曾评估过 EXISTS 门控的替代写法（summary 行缺失时差值记 0）：它把故障路径变成正确，
代价是把正常的首次 summarize 变成少计（totals 永远不会把该 key 加进来，除非自愈跑过）。
方案 §B6 的裁决是「删除后重传」这类漂移由每日自愈修复，所以选择前者：
**常规路径在线精确，故障路径在一个自愈轮内收敛**。两种写法在自愈跑过后终态相同。

### 1.2 只有「已有 totals 行」的用户走差值

请求开头对刷新用户做一次 PK 点查（`listUsersWithTotalRowsSql`，15 用户/条）；
无行的用户不发明 0 占位（方案明令禁止），而是排在 summary upsert **之后**走既有全量
刷新（创建路径）。差值 UPDATE 与它服务的 summary upsert 在同一个 `runStatementBatches`
调用内：30 行批次最坏 33 条差值+upsert 语句，低于 100 的切分上限，而
`runStatementBatches` 超 100 会拆成**独立事务**——差值与其 upsert 跨切分点会在崩溃时
留下两边不一致，这条不变量写在 `totals-delta.ts` 注释里。

### 1.3 backfill 门控在派生语句内重判

方案要求「totals 行存在性与 `totals_refresh_allowed` 在派生事务内再判一次」：请求开头
探测到行存在后，初始 backfill 可能恰好跨阶段完成。差值 UPDATE 的 WHERE 里带
`EXISTS (SELECT 1 FROM totals_refresh_allowed)`，门控未开时语句静默改 0 行。
`totals-delta.sqlite.test.ts` 的 gate 用例钉住这条（去掉门控的变异只有它失败）。

### 1.4 删除在线核对后留下的一个已知缺口

旧 `listUserIdsNeedingTotalRefresh` 会覆盖「本批完全未变化、但用户根本没有 totals 行」的
场景；差值路径在 `summaryKeysToRefresh` 为空时提前返回，不再创建。该场景由 B6 的
totals sweep 兜底（`selfheal-sql.ts` 的 candidate 空间是 summaries ∪ totals，且显式包含
「有 summary 无 totals」）。接受的理由：要落到这个场景需要「totals 行从未创建 + 客户端
重传完全相同的数据」同时成立，而 totals 行只在首批数据时创建，首批必然有 changed 记录。

### 1.5 测试口径：cost 列用容差比较

差值保持 `stored + (new − stored)`，多行成本下与全量重建的 `SUM` 不是位级相等
（IEEE-754 结合律），`expectTotalsMatchFullDerivation` 因此对 cost 列用
`toBeCloseTo(…, 9)`，整数列仍精确相等。生产语义不变。

### 1.6 B6 的实现细节

- 三 sweep（summaries/orphans/totals）共享 `usage_summary_backfill_state` 表，
  `id='selfheal'`，不碰初始 backfill 的完成标记（后者门控 totals 写入方）。
- orphan 的初始游标用空串：行值比较对 NULL 永假，用 NULL 会把 sweep 静默清空。
- candidate SQL 的 UNION 分支不能内联 ORDER BY（SQLite 语法限制），各自包一层子查询。
- totals 核对用 billable 口径（antigravity 家族自报成本是存量事实，0025/0038 的来由），
  否则每天把这类用户误报为漂移。
- 接线在 `server.ts` 的 dailyMaintenance 内，chunk 上限
  `TOKENBOARD_USAGE_SELFHEAL_LIMIT`（缺省 500，≤2000，非法值 fail-fast）。

## 2. 验证口径

- 定向套件（白天口径，见 memory `no-heavy-tests-during-daytime`）：
  `vitest run app/features/ingest`（10 文件 110 测试）、
  `app/features/usage app/features/public-card app/features/leaderboards app/server.test.ts app/lib`
  （41 文件 359 测试）、`pnpm --filter @tokenboard/web typecheck`、`prettier --check`。
- 性质测试变异核验（TDD 红绿之外的反向确认）：
  去掉 stored 减法 → 7 用例失败；去掉语句内门控 → 门控用例失败；
  差值改用 raw cost替代 billable →成本用例失败（该用例夹具最初用 costUsd:0，
  两种算法同值、变异全绿——夹具改为正成本后才有效，记录以免将来又被改回 0）。
- EQP：`totals-delta.sqlite.test.ts` 钉住差值语句 SEARCH 三个索引
  （totals PK 自动索引、summary PK 自动索引、`daily_usage_logical_key_device_idx`）且无
  对三张表任何一张的 SCAN。B1 的 EQP 正反前提在 `snapshot-hash-query-plan.test.ts`。

## 3. 未覆盖边界

- 全部结论来自本地 SQLite（`node:sqlite`）夹具；D1 侧的语句上限/事务语义按
  wrangler 文档与既有 `runStatementBatches` 注释推定，**未对真实 D1 跑过 B2**
  （部署验证属 C 批次第一道门槛，方案 §二 C 注）。
- 自愈轮在真实 keyspace 下的完成周期未测（本机库小）；`repaired` 计数是 C1 的观测输入。
- B2 的减读量比例沿用调研文档的归因（totals ≈ 读侧 55%），未在真实流量下复测。
