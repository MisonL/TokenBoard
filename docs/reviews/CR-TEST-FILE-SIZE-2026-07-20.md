# 测试与生产文件规模审查

日期：2026-07-25
基线：c43b67c2366e8e842ce21e40d89cdc2aba4e8aea
分支：fix/post-merge-reliability-followups

## 范围

本记录以 2026-07-25 的工作树为准。使用 `wc -l` 统计由 `rg --files` 找到的源码文件：

- 测试文件达到 800 行时进行职责审查；达到 1,000 行时必须拆分或记录明确豁免。
- 非测试生产文件超过 500 行时进行职责审查；超过 800 行时必须拆分或记录明确豁免。
- 构建产物、依赖目录和声明式迁移文件不计入本次源码职责审查。行数是当前 snapshot，不作为行为复杂度或质量的替代指标。

## 结论

本轮不为压低行数机械拆分。测试文件按 provider、服务状态机或部署生命周期组织；其中涉及临时目录、环境变量、D1 migration、ACK cursor、重试状态或外部命令计划的场景，拆分前必须先稳定共享 fixture 或依赖注入边界。豁免不是永久许可：下表的解除条件出现时，后续原子任务必须先抽出边界，再继续追加场景。

| 文件 | 当前行数 | 职责 | 当前豁免与解除条件 |
| --- | ---: | --- | --- |
| `apps/web/app/features/notifications/service.test.ts` | 2251 | Webhook 订阅表单、试发、每日递送、重试、报告历史清理和并发 claim | 同一 service 的 schedule slot、pending retry 和 D1 batch 返回值跨场景相互约束。先抽出可复用的通知 repository/依赖 factory 后，才可按订阅管理与递送状态机拆分；此前不向本文件加入无关 feature 场景。 |
| `apps/web/app/features/device/service.test.ts` | 1759 | 设备配对、轮换、撤销与 reconnect service 契约 | 两个顶级 `describe` 已按配对和设备管理分区。拆分前须抽出共享 repository/deps fixture，并保持 D1 零行错误映射与补偿写入回归。 |
| `packages/collector/src/providers/antigravity-gui.test.ts` | 1646 | Antigravity GUI/IDE SQLite、language-server、cursor、partial result 与时间戳投影 | DB 与 language-server 的 fallback、cursor 前沿和 partial usage 属于同一个 provider 状态机。先稳定 transport contract 和 history fixture，才可按 DB 与 transport 分文件。 |
| `packages/collector/src/providers/codex-subagent-usage.test.ts` | 1599 | Codex child usage 修正、跨 profile、缓存锁、窗口、日期和多模型分摊 | 低层 JSONL、缓存和数学测试已独立；此文件保留 `collectCodexUsage` 端到端修正契约。新增不需要完整 parent/child lifecycle 的用例应进入对应低层测试文件。 |
| `apps/web/app/features/ingest/summary-cache.integration.test.ts` | 1411 | D1 migration、summary backfill、Worker 查询计划和历史数据可见性 | 每个场景都在临时 SQLite D1 上顺序应用 migration，并验证迁移与运行时查询的联动。只有抽出稳定的 migration harness 后，才按 migration family 拆分。 |
| `packages/collector/src/providers/hook-sync.test.ts` | 1375 | Codex hook 增量解析、窄窗口 reconciliation、cursor、pending upload 与 ACK | 同一 session JSONL 变化必须同时验证 cursor 高水位、ccusage reconciliation 和 retry 状态。新增独立 Claude hook 语义时应另建 source 专用测试，而非混入。 |
| `packages/collector/src/cli-antigravity.test.ts` | 1153 | CLI 的 Antigravity 三来源选择、optional/strict 错误、上传 ACK 和 `--since` 传播 | CLI deps、环境和 snapshot group acknowledgement 是单一边界。若命令解析与上传 ACK 获得独立稳定接口，再拆为命令解析和 upload lifecycle 两组。 |
| `skills/tokenboard/scripts/upgrade.test.mjs` | 1110 | collector checkout 升级、Git ref、archive fallback、配置目录安全和跨平台复制计划 | Git/ref/archive 是一次升级流程的连续降级边界，必须共享相同的计划与执行期望。只有 `runUpgrade` 的依赖接口独立稳定后，才将纯 ref/archive 解析移出生命周期回归。 |
| `packages/collector/src/providers/session-cursor.test.ts` | 1195 | JSONL cursor、追加读取、pending upload、ACK、缺失文件和 Antigravity compaction | JSONL 逐行读取和 metadata 扫描已分别提取为低层协议测试；本文件保留文件状态、ACK 和 `CursorState` 的端到端生命周期。新增纯读取或扫描场景必须进入对应低层测试，先抽出稳定 cursor storage contract 并保留 full rebuild/pending-upload 回归后才能继续拆分。 |
| `skills/tokenboard/scripts/hooks.test.mjs` | 913 | Codex/Claude/Antigravity hook 安装、恢复、卸载和生成 notify handler | 多来源卸载与 restore artifact 必须在同一临时 HOME 内验证原子性。先将可注入的安装和卸载状态机与 handler 生成器分离，才可按来源拆分。 |
| `apps/web/app/features/ingest/repository.test.ts` | 903 | ingest upsert、summary cache backfill、snapshot hash 查询和 D1 bind 限制 | 同一 repository 的逻辑 usage key、batch 顺序和 summary freshness 在多个公开方法间复用。仅在 SQL statement builders 成为独立契约后按 public method 拆分。 |
| `packages/collector/src/providers/codex.test.ts` | 912 | Codex ccusage 调用、时间窗口、multi-profile canonical attribution 与 session count | 临时 Codex home、runner 和 canonical session fixture 共同验证一次 provider collection。新的低层 scope/cache 场景应留在已有专用文件；只有 collection input 固定后才拆出单独的 command contract。 |

## 复核动作

- 上表覆盖当前全部达到 800 行的非生成测试文件，而非只覆盖本分支修改过的测试文件。
- 新增回归优先放在已有状态机文件旁；独立的低层协议、cache、JSONL 或纯解析契约优先使用已有专用文件。
- `packages/collector/src/providers/antigravity-cli.test.ts` 已降至 337 行；SQLite history authority、full rebuild、cursor 和 replay compaction 已拆到独立协议测试，避免继续扩大主 provider 文件。
- 每个列出的测试文件仍可由 Vitest 或 Node test runner 独立执行。拆分前必须先保留测试的清理、时钟、环境变量和临时目录隔离语义。

当前全部超过 500 行的非测试生产文件也完成职责审查：

| 文件 | 当前行数 | 本轮职责 | 结论与后续条件 |
| --- | ---: | --- | --- |
| `apps/web/app/routes/settings/devices.tsx` | 1510 | 设备列表、详情、凭证轮换和安装状态页面 | 沿用既有路由边界；本轮改动集中于凭证提示并复用 `CopyableCommandBlock`。拆分必须作为独立 UI 重构，保持 route-level tests。 |
| `apps/web/app/features/device/repository.ts` | 894 | D1 pairing、reconnect 和设备凭证原子 batch | 本轮新增的是同一 pairing transaction 内的零行写入条件，不能拆开 creation、installation、token 与 audit statement，否则会削弱同 batch 断言。解除条件：先为 statement builders 建立独立的 transaction input contract。 |
| `apps/web/app/features/device/service.ts` | 1603 | 设备查询、撤销、轮换、pairing code 和 reconnect service 流程 | 该文件早已超过阈值；本轮只增加新设备竞态错误映射。按生命周期拆分需要单独迁移共享 repository/deps type，并保持所有 route/service tests。 |
| `packages/collector/src/providers/session-cursor.ts` | 921 | JSONL cursor、ACK、重扫和 Antigravity compaction | 超过 800 行强制治理阈值。已将逐行读取和 metadata 扫描提取为独立模块；本文件仍负责同一 `CursorState` 下的文件证明、pending upload、ACK 和 CLI history rebuild 协议。解除条件：先抽出稳定的 CLI history cursor contract，并用全量重扫与 pending-upload 回归保护后再拆分。 |
| `packages/collector/src/providers/codex.ts` | 821 | Codex full/bounded/hook collection 与 multi-profile canonical attribution 编排 | 超过 800 行强制治理阈值。session scope、cache 和 subagent 低层协议已独立；此文件只编排 provider 输入与跨 home attribution。解除条件：为 canonical attribution 建立稳定的 public input/output contract 后，再提取 orchestration module。 |
| `packages/collector/src/providers/codex-session-scope.ts` | 921 | Codex session discovery、冻结 scope、有界窗口和 canonical attribution 候选选择 | 超过 800 行强制治理阈值。文件统一证明本地 session、冻结范围和日期窗口的对应关系；拆分后若 scope 选择与 canonical 过滤分离，会削弱同一窗口的可验证性。解除条件：先将 canonical-selection 提取为纯策略接口，并保留 scope/window 回归。 |
| `packages/collector/src/providers/codex-subagent-usage.ts` | 558 | 依据 child JSONL 对 Codex parent snapshot 做跨 profile 去重、日期/模型调整、缓存校正和受限诊断汇总 | 超过提醒阈值但未到强制拆分阈值。校正数学、缓存生命周期和跨 profile 聚合共享同一 child-event identity；本轮仅增加兼容性判断与受限 oversized-row 诊断，未混入采集或上传职责。解除条件：若新增独立的 correction source、诊断后端或第四种 cache 表示，先提取纯 correction policy 并保留多 profile、legacy/additive counter 和 diagnostic aggregation 回归。 |
| `skills/tokenboard/scripts/hooks.mjs` | 681 | hook 安装、恢复、卸载和通知 handler 生成 | 仍是同一临时 HOME 和恢复状态原子性边界；只有在安装与卸载状态机可独立注入后再拆分。 |
| `packages/collector/src/providers/antigravity-gui-client.ts` | 539 | Antigravity GUI/IDE language-server 启动、探针和响应投影 | 启动与响应上限共享同一请求生命周期；拆分前必须先抽出稳定 transport contract。 |
| `packages/collector/src/providers/session-jsonl-metadata-scanner.ts` | 535 | 受限 JSONL metadata 识别、usage 字段检测与超长行诊断 | 超过提醒阈值但未到强制拆分阈值。扫描器需要维持跨 chunk 的 JSON 状态，拆分前应先建立可独立验证的 tokenizer 契约，避免令敏感 usage 行被误判为可丢弃。 |
| `packages/collector/src/cli.ts` | 537 | collector 命令解析、五来源调度、上传 ACK 和诊断格式化 | 刚超过提醒阈值，仍是 CLI application boundary。只有 source dispatch 与 upload lifecycle 具有独立依赖接口后再拆分，避免改变 preview/sync 错误策略。 |

## 函数复杂度复核

对上表中本分支相关的生产文件进行 TypeScript AST 静态扫描后，以下函数超过 80 行。它们均有
明确的事务、状态机或生成边界；本轮不以无意义的 wrapper 拆分。后续修改这些函数时，必须先满足
对应解除条件，再增加新分支或职责。

| 函数 | 当前行数 | 当前职责 | 豁免与解除条件 |
| --- | ---: | --- | --- |
| `listUserDevices` in `device/service.ts` | 113 | 并发查询设备、安装实例和 token，并以 device 为键组装返回视图模型 | 三个查询和分组结果共同定义列表一致性。若增加第四类关联数据，先提取 query result 到 view-model mapper 并补 repository contract 测试。 |
| `rotateUploadToken` in `device/service.ts` | 85 | 创建替代凭证、原子撤销旧凭证、轮换 install claim 与失败补偿 | 这是单一补偿事务，不能把 prepare、assert 和 cleanup 拆成隐式顺序。若支持新的 credential type，先抽出显式 rotation transaction input。 |
| `pairDevice` in `device/service.ts` | 91 | 校验 pairing code、生成新凭证、选择新设备或 reconnect 写入，并映射可恢复错误 | pairing type 决定 repository 写入与错误契约。若再增加 pairing type，先为共享 credential input 建立类型化 builder，再拆分分支。 |
| `DeviceInstallations` in `settings/devices.tsx` | 83 | 以 compact 和详情两种布局渲染同一 installation 列表与撤销操作 | 两种布局共享身份、时间和撤销语义。若第三种展示模式出现，先提取 installation view model 和纯展示子组件。 |
| `notifyHandlerHelpers` in `hooks.mjs` | 299 | 生成独立 notify handler 的锁、进程探测、文件恢复和错误记录函数文本 | 宿主函数长是因为它承载生成脚本的完整 helper section；运行时职责已经是多个独立生成函数。只有生成 handler 改为独立可测试模块或 template asset 时才拆分字符串片段，避免改变生成顺序或作用域。 |
| `collectSessionFile` in `session-cursor.ts` | 83 | 证明文件元数据、判断 append-only、读取增量 JSONL 并写入下一代 cursor | 文件 hash、offset 和 pending upload 是同一一致性证明。若增加新的读取后端，先提取显式 file-proof value object 并用 append/full reread 回归保护。 |
| `compactAcknowledgedCliHistory` in `session-cursor.ts` | 95 | 按 ACK frontier 合并 CLI history identity、alias、aggregate 与 replay protection | 压缩与可重扫 identity 的关系是同一事务。若引入新的 history source，先抽出压缩计划和应用阶段，并保留 full rebuild/retention 回归。 |

Antigravity CLI 的 SQLite history authority 已拆到
`antigravity-cli-history-authority.ts`；`antigravity-cli-cursor.ts` 当前为 240 行，不再需要
生产文件长度豁免。statusline 仅写入私有本地诊断日志，不再进入 collector cursor、snapshot
或上传计量。

本轮静态审查未确认与当前职责无关的生产代码混入；若后续继续增长或出现跨域 helper，必须先补独立模块和回归测试再扩展。

## 验收

本记录不改变运行时代码。拆分豁免须在后续新增职责或测试文件继续增长时重新审查；新增独立协议应优先新建测试文件，而不是继续向上述文件追加不相关 fixture。完成本记录后，仍需在 T08 的冻结质量门禁中运行完整测试、类型检查、build、审计和 diff 检查。
