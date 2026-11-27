# 批次 B 实现记录：D1 读写优化（B1–B6）

- 日期：2026-11-27
- 状态：六项全部实现并提交；已部署私人 CF（`tokenboard-independent` / tokenboard.431695.xyz，版本 `3695fb4b`），真实 D1 端到端验证通过；生产 chaosyn 未部署
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

### 2.1 本地


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

### 2.2 私人 CF 真实部署验证（2026-11-27）

`TOKENBOARD_WRANGLER_CONFIG=wrangler.production.private.jsonc pnpm run deploy` 全链绿
（migrations 0040/0041 已 apply、五道 schema 门、发布版本 `3695fb4b`、health 200）。
`daily_usage` 索引清单核对 `daily_usage_user_date_idx` 已从真实 D1 删除。
真实 HTTP 端到端（一次性探针用户，跑完删除并核对 0 残留）：

| 场景 | 结果 |
|------|------|
| 首传 30 新 key（无 totals 行） | `upserted:30`，totals 创建且 == 全量推导（3435/3435/0.3/30） |
| 1/30 变化 | `upserted:1`，totals == 推导（3485） |
| 全命中重试 | `upserted:0`，totals 行**逐列含 updated_at 不变**（B2 无差值 + B5 守卫在真实数据上生效） |
| `/check` 30 键 | 全部报告已投递——在线 totals 核对删除后，陈旧 totals 不再逼客户端重传 |
| 删 summary 行后重传（§1.1 故障路径） | 线上复现过计（3588 vs 推导 3485），随后用 B6 同一 SQL 文本（`totalRepairCheckSql` 检出 + `prepareUserTotalFromSummaryRefresh` 修复）在真实 D1 收敛回 3485——**自愈通道在线上闭环**，非本地模拟 |

写量（复跑归档探针 `docs/research/2026-11-25-d1-write-probe/write-probe.mts` 对 B2 后代码，
本地逻辑行写口径）：首传 64（totals 为 1 次 INSERT 创建，非差值）、1/30 变化 6、
全命中重试 3（只剩心跳）、check 0。方案预警的「W2 可能比现状多一次 totals 更新」
实测确认其成立条件是**单批变化 key 跨多个 15 键 chunk**（30 键全变 = 2 条差值 UPDATE，
基线全量刷新 = 1 次）；1/30 变化场景与基线持平。写额度 10 万行/天，量级可忽略。
真实 D1 的逐请求 rowsRead/rowsWritten（含索引写的 `meta.rows_written`）本机 wrangler 不返回，
未覆盖——发布后可用 D1 Observability（`events.d1Queries`）复查。

## 3. 未覆盖边界

- 真实 D1 的语句上限/事务语义已由私人 CF 部署走通（batch/差值/backfill 门控均为线上执行
  结果），但 **rowsRead/rowsWritten 的线上配额曲线尚未观测**（发布后用 D1 Observability
  复查，这也是 C1 strict 的观测输入之一）。
- 自愈轮在真实 keyspace 下的完成周期未测（本机库小）；`repaired` 计数是 C1 的观测输入。
- **单次 HTTP 请求内的部分提交是接受的边界**（2026-11-27 审查确认，非本轮引入）：服务端每
  30 条一个事务，200 条请求最多跨 7 个事务；中途失败返回 500 时，前面已提交的块留在库里。
  客户端不 ack、不推进水位，下一轮 `/check` 跳过已提交行只补剩余（审查用内存 SQLite 注入
  故障复现：380 跳过 + 21 补齐，汇总总数一致）。原始行已提交而派生事务失败的窗口由 B6
  自愈收敛，与 30 条时代 raw/derived 两事务的边界同性质。
- B2 的减读量比例沿用调研文档的归因（totals ≈ 读侧 55%），未在真实流量下复测。
- 发布分工（2026-11-27 用户裁决）：生产 chaosyn 上线走**上游的自动化构建发布机制**，
  本侧不再手动部署 chaosyn；本侧验收口径 = 私人 CF（`tokenboard-independent`）测试通过
  （已完成，见 §2.2）。批次 C 各项在本分支实现并以私人 CF 验证，进入上游后由其流水线
  承载生产上线与观察窗口。

## 4. 批次 C 实施记录

### 4.1 C3 客户端批 30→200

- 私人 Worker 实测（`tokenboard-independent`，`3695fb4b` 之后的候选；同一请求内
  `check + ingest` 两跳合计墙钟）：200 条全变化 1.7 s、200 条全命中 1.1 s、
  100 条混合 2.1 s——均远低于 30 s 请求超时，未触发 Plan B（退 100）。
  （测量发生于 C3 实现期，原始记录在提交 `55f2633` 的提交说明中；本表为转录。）
- 请求数：501 条快照从 ceil(501/30)=17 块 × 2 跳 = 34 次降到 ceil(501/200)=3 块 × 2 = 6 次
  （全变化最坏口径；全命中时为 3 次 check + 1 次 keep-alive 空 ingest）。
- 服务端未改动：上限仍 500（`maxIngestSnapshotBatchSize`），内部仍按 30 条/D1 事务切
  （`snapshotUpsertBatchSize`）。行隔离预算改为按批宽推导（`ceil(200/32)=7` 轮，
  审查后修订）：2 轮 × 32 在 30条批下覆盖整批、在 200 条批下不覆盖——超预算抛错会
  中断本轮后续批次（殃及其他来源投递）并累计 backoff，而 7 轮保证「服务端具名拒收的
  整批」总能排干；超出即视为病态服务端，仍按旧语义失败。服务端 400 明细同时改为
 每坏行只占一个名额（`1dee835`），使「32 条」名副其实按行计。
- 两侧同步：TS `packages/collector/src/upload.ts` 与 Go
  `clients/go/internal/upload/upload.go` 的 `snapshotBatchSize = 200`，
  测试分别钉 501→6 请求与 450→[200,200,50] 分块。

### 4.2 C2 行级投递结果

- 服务端 ingest 响应从 `{ upserted }` 扩为 `{ upserted, outcomes }`：`outcomes` 只列
  **未写入**的行，按提交数组的绝对下标寻址（跨服务端 30 行内部块、跨客户端 200 行批均
  一致；实现见 `apps/web/app/features/ingest/repository/outcomes.ts`）。四态：
  `same`（存量同 hash）、`protected`（Codex 全零守护保住更富的存量行）、`stale`（存量
  `synced_at` 严格更新——时钟回拨）、`unknown`（无解释，fail-closed）。分类发生在 upsert
  语句执行之后、派生刷新之前，以同一批语句结果为准。
- 语义裁决：`same`/`protected` 计为已投递（服务端持有的就是这条测量或更富超集）；
  `stale`/`unknown` **不计投递**——客户端不 ack、pending 保留，下一轮重试；`stale` 另打
  时钟告警（正常时钟下不可能发生）。`session_count > 0` 的 Codex 会话报告走 CASE 守护，
  仍**写入**（hash/session_count 落库），计入 `upserted`，不进入 `outcomes`。
- 客户端（TS `packages/collector/src/upload.ts` 与 Go
  `clients/go/internal/upload/upload.go` 同步实现）：解析 `outcomes`，交付集 = 可上行行
  − blocked − withheld；`withheld` 与 blocked 同等对待——不进 ack 组、Codex 文件级确认
  退让（文件列表无法指向被扣行的来源）、投递水位不前进；`stale` 在 stderr 聚合告警并提示
  检查本机时钟/时区。旧服务端无 `outcomes` 字段 → 全部按已投递处理（现行为不变）；旧客户端
  只读 `upserted` 不受影响。未识别的未来状态一律 withhold（ack 一条服务端没写的行会永久
  丢弃该测量）。
- 契约镜像：客户端「计入投递的状态集」由 `packages/collector/src/upload-batches.test.ts`
  （读服务端 `outcomes.ts` 源文本）与 `clients/go/internal/upload/outcomes_test.go`
  （同法向上查找源文件）双向钉住；服务端每坏行一个错误名额（`1dee835`）使 32 条按行计。
- 验证面：服务端 `outcomes.sqlite.test.ts`（12 例，真 SQLite：四态、混合批绝对下标、
  同批同 key、40 行跨 upsert 批与 40 键跨查询分块、毫秒相等报 stale、身份键含设备、
  单位缺失 fail-closed；分类分支改动均经变异核验）；TS/Go 各覆盖同批好坏混合、隔离重发
  后的下发下标、旧服务端降级、畸形/矛盾/`null` outcomes、Codex 文件确认退让、水位跳过
  （delivered 与 pending 同源夹具，删过滤循环即变红）；Go 侧另有源文本镜像用例。部署
  顺序：先服务端（旧服务端下新客户端按旧行为工作），服务端随本分支发布即满足。
- 已知边界（审查裁决，接受不修）：
  - **hook pending 重放会改投 model `all`**：Codex hook 扣留行在下一轮重放时经
    `codex-hook-pending-merge` 归并到 `model: 'all'` 摘要行。C2 之前该行在第一轮就被
    ack 丢弃（更差），重放机制本身是既有设计；C2 只是让它更常发生，不构成回归。
  - **非 hook 来源只有 7 天重试窗口**：全量同步后即使有 withheld 行，投递水位仍按既有
    行为推进（blocked 行同样不阻断）；`sync --since all` 也会推进该源的 hook 扫描高水位
    （`warmHookCursors`，同样不因 blocked/withheld 跳过，A1 起既有）。被扣留行由后续定时
    全量的自动窗口重试，窗口下界是 `max(today-30, …)`——超过 30 天的日期不再被重扫，这
    是有界扫描的固有边界；对 `stale` 行无影响（服务端本就持有更新的测量，重试不会改变
    结果）。要区分三种进度：滚动扫描窗口、投递水位（`delivered-watermark.json`）、hook
    扫描高水位（hook cursor），只有第一个决定重试机会。
  - **Codex 分组确认的既有暴露面**：出现 blocked/withheld 行时回退到按组确认（`(source,
    usageDate, timezone, model)` 组键），该机制自 A1 起存在，C2 只把 withheld 并入触发
    条件（`git diff` 可见仅新增 `|| withheld`）。组键正是 `mergeSnapshots` 的折叠键，同批
    同组行必被合并为一条快照，故 delivered/withheld 在同一组内非此即彼；残余场景需 cursor
    条目保留旧的 `model: 'all'` 标签而重采以具名模型上报，属上面第一条 hook 重放边界的
    变体。
  - **毫秒相等报 `stale`**：upsert 与分类查询分开执行，若同一 key 的两行落在同一 POST
    （上一条边界，生产不可达）或并发写改变了行，分类会把哈希不同但毫秒时间相等的行报成
    `stale`（附带时钟告警）。方向保守（withhold 不丢数据），接受。
  - **同 key 重复行的状态依赖 30 行分块**：同一 POST 内同 key 的两行，其 same/stale
    分类取决于两行是否落在同一服务端块。客户端上传前按五元键聚合
    （`mergeSnapshots`），生产不可达；若出现只会多报时钟告警并让 pending 往复，不丢数据。

### 4.3 C4 计划窗口内被跳过的信号续跑

- **前置（方案列为硬门槛）**：「计划同步是否已覆盖该信号」按来源判定，不能只看计划任务的
  退出码（上传暂停时计划任务同样记 success），也不能只按墙钟算延迟（`12:05` 的信号在
  `12:19` 唤醒仍被窗口拦下）。实现为 `skills/tokenboard/scripts/scheduled-coverage.mjs`
  `sourceCoveredByScheduledRun`：读取计划同步自己写的
  `scheduled-sync-state.json`（`all`）或 `scheduled-sync-state.<source>.json`，要求
  ① 终态为 `success`（`running`/`deferred`/`failed`/`invalid` 都不算）② `completedAt`
  不早于信号请求时间、不晚于当前时刻、且距当前不超过 24 小时（文件每次运行覆盖，过老的
  完成记录不构成证据）③ 该文件描述的是 `all` 或正是该来源。任一不确定（无文件、不可读、
  时间不可解析、请求时间不可解析）一律判「未覆盖」——方向保守：最多多扫一次，而不是少传。
- 信号请求时间来自 `coordinator-signal.mjs` 的 `readSignalRequestTimes`（只读活跃队列
  entry，不读 in-flight 的 `.drain` 文件）；同一来源多次请求取**最新**的一次——更早的请求
  可能已被某次计划运行覆盖，最新的一次仍需判定。
- 协调器（`coordinator.mjs`）在合并信号来源后先过覆盖门控：被计划运行覆盖的来源从本轮
  全部集合中剔除并 ack 信号队列，全部被覆盖时返回 `skippedReason: 'scheduled-covered'`
  且不排任何续跑。未被覆盖的进入原有分支：
  - 窗口内：跳过（`scheduled-window`），并为这些来源排一次 trailing 续跑，**唤醒时刻 = 当
    前所处窗口的结束时间**（12:05 被 12:00 窗口拦下 → 12:30），复用既有
    `scheduleTrailing`/`runtime.scheduleTrailing` 通道（notify 的 trailing worker 在延迟
    后复跑协调器）。worker 醒来时窗口已结束，若计划运行已成功覆盖则由上面的门控放行并
    跳过，否则正常采集——这就是「带截止时间的续跑」，不需要另起计时器。
  - 冷却/锁超时：现状不改（冷却本身会排 trailing）；覆盖门控已在它们之前剔除被覆盖来源。
- 验证面：`scheduled-coverage.test.mjs`（成功晚于请求覆盖、早于请求不覆盖、failed/
  deferred/running 不覆盖、部分来源运行不覆盖别的来源、per-source 覆盖、无状态/损坏/
  时间不可解析不覆盖、12:05→12:31 已覆盖不重扫、未来/过旧完成不覆盖）；`coordinator-
  scheduled-coverage.test.mjs`（合成时钟：窗口内未覆盖排 25 分钟续跑、12:31 未覆盖则采
  集、已覆盖则 `scheduled-covered` 不采集、混合来源只续未覆盖来源、failed/deferred 不
  覆盖、完成早于请求不覆盖、无请求时间按未覆盖）。覆盖门控与续跑 deadline 均经变异核验
  （删门控 → 2 例变红）。
- 未覆盖：真实 launchd/systemd/Windows 计划任务的完成时间与 `scheduled-sync-state` 写入
  时序只经合成时钟验证；计划同步在外部系统被杀死（无任何状态文件写入）的场景等价于
  「文件停在 running/旧值」——按未覆盖处理，下次 hook 触发会重采。
