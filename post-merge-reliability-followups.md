# Post-Merge Reliability Follow-ups

## Active Goal Contract (Reset 2026-07-21)

### Objective

完成 `fix/post-merge-reliability-followups` 相对基线
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 的全部可靠性、兼容性、数据正确性、客户端运行、
D1 migration、质量安全、独立复核、私人 Cloudflare 验证、原子提交、推送和中文 PR 收尾。
只有当前候选在本机、已配对 collector 和用户私人 Cloudflare 上都有可复验的成功证据时，才可
提交、推送和宣告完成。

本节为本轮唯一、完整且可审计的 Goal。工具层已有未完成 Goal，API 不支持安全改写其 objective；
不得通过错误标记完成或阻断来重置它。本文件取代旧 objective 中已过期的工作树计数、扫描和
通过描述，下方 T01 至 T10 是此 Goal 的逐项验收台账。工具层 objective 与本节不一致时，以本节
的最新事实、依赖顺序、验收证据和停止条件为准；它们共同约束同一个 active Goal，而不是两个
可以并行完成的目标。

### Reset Snapshot (2026-07-21)

- `T01` 至 `T06` 已完成；`T07`、`T08`、`T09`、`T10` 尚未完成，绝不能因历史 preview、旧部署
  或旧 review 结果提前标记完成。
- 2026-07-22 对 Codex hook 的多 profile cursor 新增了独立 hash cursor、legacy 双向恢复、
  duplicate snapshot 抑制和 CLI ACK/warm 对齐。这些源码及直接支持测试变更使先前完整 workspace
  门禁和最终 security scan 失效；冻结后必须从零重跑，不能引用旧通过结果。
- 用户明确禁止使用 `codex-security` 插件，因此 T08 采用最终 diff 的人工安全审阅而不是插件扫描。
  Web/D1、collector、hook/skill 和包依赖边界均已复核，且没有确认 security finding；范围、候选
  排除理由与验证结果见 `docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md`。Windows `tasklist`
  绝对路径经默认、驱动器相对及自定义
  `SystemRoot` 的生成-handler 回归验证为真实绝对 `System32\\tasklist.exe`，属于已排除的
  reviewer false positive，不得为了回应旧意见再次改变生产逻辑。
- 2026-07-23 的本机 Codex 预检确认真实 child session 可超过旧 8 MiB 上限，因而将总文件上限调整
  为 4 GiB，并新增字节级流式单行上限和回归。随后发现 canonical Codex attribution 可将 bounded
  session 改写到 `--until` 窗口外，现已改为仅在 canonical 日期仍位于请求窗口内时替换日期；该运行
  时代码及直接支持测试变动使此前 T08 的完整门禁和人工安全审阅失效。必须从零重跑门禁和审阅，之后
  才能恢复 T07 的最小补偿及 hash 复核，再执行 T09 的只读外部复核；只有所有 confirmed finding 已闭环并重新验证后，
  才可执行 T10 的私人 Cloudflare migration/deploy/rollback 验证和中文 PR 收尾。

### Authority, Baseline And Preservation

- 目标分支固定为 `fix/post-merge-reliability-followups`，比较基线固定为
  `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`。本次重设时 `HEAD`、`master`、`origin/master`
  与 `upstream/master` 均指向该基线；后续每个阶段开始前必须重新 `git fetch --all --prune` 并
  检查相对关系，不能假设该事实持续成立。
- 重设时工作树为 76 个已跟踪改动和 19 个未跟踪本轮工件。此计数只是快照，后续以实时
  `git status --short --branch` 和 `git diff --name-status <base>` 为准。必须完整保留所有现有
  改动及未跟踪文件；禁止 `git reset`、`git checkout`、`git clean`、覆盖或删除已有工作。
- `package.json` 和 `pnpm-lock.yaml` 的 `brace-expansion` override 属于当前候选的一部分，必须
  保留并由最终 `pnpm audit --audit-level=high` 重新验证，不得为了缩小 diff 回退。
- 仅处理本分支相对基线的可靠性、兼容性、性能、隐私、安全、迁移、文档和发布准备。不得启用
  Cloudflare Workers Builds、GitHub Actions 或其他自动 CI/CD，不得向上游生产环境部署；只有
  用户私人 Cloudflare 可以在 T10 的受 guard 保护流程中人工验证。
- 全程中文沟通。代码和文档编辑仅使用 `apply_patch`。不得写入、打印或在 PR 中泄露 upload
  token、pairing/install claim、device ID、配置内容、device-link、原始会话、原始 usage、私有
  URL、私有路径或其他敏感信息。

### Current Evidence And Non-Evidence

- T01 至 T06 的实现和定向回归已在当前工作树中完成，但这些历史或局部结果只说明可进入最终
  门禁，不能替代冻结后的完整测试、安全扫描、外部复核或部署验收。
- T07 已完成非侵入式预检：hook、计划任务、锁和五来源隔离 preview 曾被检查，且服务端 hash
  对账确认仍有待补偿范围。它不是已完成验收；受控补偿和复核必须在 T08 通过后重新执行。
- T08 因当前 Codex bounded attribution 源码及直接支持测试变更重新打开；此前全量质量、安全和文档
  门禁仅为历史证据。T07 暂停在无状态核验阶段，补偿同步不得开始，也不修改生产 cursor。
- 本轮 Codex 多 profile cursor 定向验证通过：后置 profile、相同相对路径、profile 顺序变化、
  legacy pending 恢复、profile 缩减、ACK/warm 和删除副本 retry 均有确定性回归。后续有界采集
  fallback 也已验证：live `CODEX_HOME` 只做 session discovery，daily、bounded session 和
  canonical attribution 只读冻结 scope；discovery 为空但可冻结本地范围时保留 daily usage 并将
  session 计为零，完全无法冻结时显式失败而不静默漏记。该定向回归为 `7` 个文件、`50` 条用例；
  collector 全量为 `51` 个文件、`482` 条用例且 typecheck 通过。这些结果已纳入 T08 更新后的
  完整门禁，但不替代 T07 的真实客户端核验。
- 旧安全扫描目录、旧私人部署、旧上线日志、旧 CodeRabbit/Claude/OMP 输出以及历史 review finding
  都只可作排查线索。最终安全扫描必须在源码及直接支持测试冻结后从零建立完整工件，最终部署和
  独立审查也必须针对冻结后的相同 diff。
- 普通 Antigravity 本机 language-server 曾不可用。它不是可忽略的空数据；T07 必须记录当前
  可复现根因或修复后的成功证据，不能把 partial diagnostic 写成全部正常。

### Required Work, Dependency Order And Acceptance

1. T01 Baseline and worktree protection: 固定基线、分支、未跟踪工件和不可破坏边界。验收为
   基线关系、实时状态和差异清单均可复现，且没有把上游合并历史、本机缓存或旧部署当成候选证据。
2. T02 Antigravity CLI metering and cursor correctness: SQLite history 是唯一上传计量权威；
   statusline 仅本地脱敏诊断；`--since all` 是 canonical rebuild；压缩、alias/tombstone、
   pending upload、模型规范化、跨来源匹配、删除 cascade 回收及 bounded state 都不得重复累计
   token、session 或 snapshot。验收为真实 cursor 生命周期、90 天/64,000 边界、全量重扫、
   缺失来源和失败重试的确定性回归均通过。
3. T03 Five-source ranges and GUI/IDE reliability: Claude Code、Codex、Antigravity CLI、
   Antigravity、Antigravity IDE 必须使用相同 `--since` 语义；preview 不依赖 upload endpoint；
   GUI/IDE 的空候选、公用语言服务器 readiness、8 MiB response 上界、严格 ISO 日期、损坏
   protobuf timestamp、原始 metadata 不落盘均须显式且可诊断。验收为五来源和 parser/client
   定向回归及 typecheck 通过。
4. T04 Hook, statusline, lock and multi-server recovery: Windows 绝对系统二进制路径、PID
   liveness、heartbeat release race、taskkill 非零、stdin/stdout/EPIPE、checkpoint evidence、
   profile/device-link 多 server、卸载恢复与 schedule 继承均不能静默丢失状态。验收为 Windows、
   hook、coordinator、notify、lock 和 profile 回归通过，且生成 handler 的 Windows fallback
   明确为绝对路径。
5. T05 Web, D1 and legacy-client compatibility: reconnect pairing 的并发失效必须稳定映射错误；
   AJAX 导航不能被旧响应覆盖；设备命令可访问复制；Antigravity cost availability 逐模型进入
   dashboard、details、通知、public、SVG、leaderboard 和 CSV；`0028` seed cleanup、`0029`
   index、Drizzle schema、critical schema verification 与部署顺序必须一致。验收为 repository、
   service、route、migration、CSV/public/notification、navigation 和 schema 契约测试通过。
6. T06 Code, test and documentation governance: 删除被替换的 statusline upload/index/scan
   实现及孤立引用；治理过大测试和高复杂度文件但不机械拆分；文档只陈述当前代码事实和已取得
   证据。验收为 import/search、相关测试、`git diff --check` 通过，且尺寸豁免文档有范围和
   解除条件。
7. T08 Full quality, migration and security gate: 在代码冻结后先执行完整本地门禁和最终 diff
   security scan。全部通过之前不得执行有状态的补偿同步、部署、提交或 PR。完整门禁包括：
   `pnpm test`、`pnpm typecheck`、`node --test skills/tokenboard/scripts/*.test.mjs`、
   `pnpm build`、`pnpm audit --audit-level=high`、关键 collector/Web/D1 migration/schema
   定向回归，以及 `git diff --check <base>`。安全扫描必须涵盖全部已跟踪 diff 和本轮直接支持
   的未跟踪源码/测试，保存 threat model、worklist、逐文件 candidate receipt、coverage、
   validation、attack path、findings、manifest 和最终 `report.md`。任何失败、high audit finding、
   schema 不一致或确认安全 finding 都阻断后续步骤；任何随后源码或直接支持测试变动都会使该
   扫描和受影响门禁失效。
8. T07 Local client and one-month data verification: 仅在 T08 成功且 diff 未变后，检查现有
   TokenBoard status、Codex/Claude hooks、Antigravity CLI opt-in statusline、LaunchAgent、
   logs、进程和锁；用一次性 `TOKENBOARD_STATE_DIR` 运行最近一个月五来源 preview，确认不
   上传、不改生产 cursor、性能可接受且失败可诊断。以既有上传配置调用 `/api/v1/ingest/check`
   仅核对 snapshot key/hash，不输出 usage 内容。只有 hash 确认有缺口时才按最小范围补偿：
   Antigravity CLI 一次 `--since all` SQLite canonical rebuild、Claude Code 自 `20260621`、
   Codex 自 `20260703`；禁止重配对、删 cursor、删配置或把恢复失败改作新设备安装。补偿后
   必须重新 preview、hash 对账、检查无残留锁及同步退出状态，并定位普通 Antigravity
   language-server 成功或可复现根因。
9. T09 Independent read-only review: 仅在 T08/T07 成功、diff 冻结后，Claude Code 使用用户
   现有配置进行相对基线只读审查，不限制时间或 token 预算；OMP 当前按用户明确指示跳过，不等待、
   不重试、不修改用户配置，也不计为通过。CodeRabbit 仅在服务可用时运行，429、初始化失败、空输出
   或无最终结果明确记为未覆盖。每个 finding 必须
   回到精确调用链和确定性测试确认；confirmed finding 触发最小修复、受影响门禁重跑和复核。
10. T10 Private Cloudflare validation, commit and PR: 仅当前九项通过后，使用私有 Wrangler
    配置和 guarded deploy helper 建立 D1 Time Travel restore point，执行待迁移 migration 和
    `verify-critical-schema.sql`，核验 schema。发布后验证 health、匿名边界、认证后的
    `/dashboard/details` 与 `/settings/devices`、静态资源、AJAX navigation、复制控件、真实已
    配对 collector ingest 和 D1 `last_synced_at`/`last_used_at` 推进。任一失败立即停止，按
    restore point 和 Worker version 回滚，绝不把本地通过写成部署成功。最后检查每个未跟踪文件
    归属，按逻辑拆原子 Conventional Commit、推送分支、创建或更新中文 PR；PR 必须含问题、
    范围、迁移前置条件、逐步部署、验证结果、回滚、风险、旧 client 兼容性和真实 UI/浏览器
    证据，且不含秘密。

### Execution Discipline And Final Stop Conditions

- 每次只处理一个原子任务。流程固定为读取现状、必要时先写失败的确定性回归、最小修复、
  最小充分验证、`git diff`/`git status` 自审、回写台账，然后才取下一项。
- 禁止静默降级、吞错继续、伪造成功、为测试硬编码、以 mock 宣称真实 Cloudflare/collector
  成功。外部服务、language-server、审查器或部署不可用必须明确记录为未覆盖或阻断。
- 未处理的 P1/P2 行为、数据、迁移、隐私、安全或兼容性 finding；任何未解释失败；或任何
  门禁/部署证据过期，均阻止提交、推送和完成。
- 最终完成仅在 T01 至 T10 全部实际验收完成、当前 diff 通过全量质量门禁和最终安全扫描、
  外部复核无未处理 confirmed finding、私人 Cloudflare 的迁移/认证/ingest 有真实证据、分支
  已推送且中文 PR 完整可执行时成立。

## T01 Baseline And Worktree Protection

状态：已完成

内容：固定分支 `fix/post-merge-reliability-followups`、比较基线、当前差异和未跟踪工件；
确认不存在可安全丢弃的既有改动，并将本文件设为本轮唯一任务来源。

验收标准：`git merge-base HEAD c43b67c` 为基线；`git status --short --branch` 可列出
所有既有改动；本轮不执行任何破坏性 Git 命令；后续每个任务结束后重新检查差异边界。

审查要求：确认没有将上游已合并提交、旧私人部署、历史 review 结果或本机缓存误当作
当前未提交补丁的完成证据。

## T02 Antigravity CLI Metering And Cursor Correctness

状态：已完成

内容：完成并复核以下 Antigravity CLI 正确性边界。

- SQLite history 是唯一上传计量权威；statusline 只保留本地脱敏诊断、稳定本地 capture
  identity、限长解析和原命令 stdin/stdout 透传，不再作为 snapshot/upload 计量来源。
- `--since all` 必须执行 canonical rebuild；有界窗口只能复用可证明兼容的游标，过期或
  压缩后的游标不得悄然把全量重扫叠加到 aggregate。
- acknowledged event 的压缩、别名、tombstone、history high-water、statusline generation
  lineage 和 pending upload 必须同时正确；全量重扫、缺失来源恢复、延迟匹配及上传失败重试
  均不得重复累计 token、session 或 snapshot。
- 不能依靠永久保留每个 event identity 控制重复；cursor `files`、aliases、session markers
  和 snapshots 必须有上界，并保留可证明的 full-rebuild/replay 协议。
- history/statusline 模型名可能分别为显示名和内部 ID；跨来源匹配不得因展示名不同而重复
  计量。SQLite history 解析、statusline 同一会话多次相同 token 的本地记录、SQLite 不可用
  时的稳定 per-call identity 都必须有明确行为。
- `--since all`、90 天压缩、64,000 alias 裁剪和重新 setup 的组合必须有确定性回归，覆盖
  已 ACK 历史事件在 retention 后被重新扫描时仍不重复累计。
- SQLite conversations 目录成功完整枚举后，已被本机删除的 cascade 的 `db-row` 游标必须从
  `all` 与全部有界 scope 回收，避免状态按历史 cascade 数永久增长；读取上限、mtime/since
  过滤、空数据库、stat race 或自定义 reader 未声明完整目录时不得把“本轮未读取”误判为删除。

验收标准：定向覆盖 `session-cursor`、`antigravity-cli-cursor`、`antigravity-cli`、
`antigravity-cli-full-rebuild`、history authority、replay compaction、CLI Antigravity 及
collector typecheck；以真实 cursor 状态流证明一次全量重扫得到 replace/rebuild 语义，
不是 aggregate 叠加。

审查要求：审查 pending upload 的确认时机、跨来源去重键、alias 过期、压缩 frontier、
statusline log generation/lineage、模型规范化及大历史状态的时间和空间复杂度。

完成证据（2026-07-20）：SQLite `gen_metadata.data` 现为唯一 snapshot/upload 计量权威；
statusline 仅保留本地脱敏诊断和原命令透传，不再进入 collector snapshot。`--since all` 清空
可重建状态并执行无上限 SQLite canonical rebuild，有限 `maxDbFiles` 被显式拒绝；重建失败前
不写入半成品 cursor。压缩后的未知旧事件、保留 session marker 和时区边界都会显式要求
`--since all`，不会叠加 aggregate；重建后每日模型快照由 SQLite 重新生成。已增加完整目录
事实 `knownCascadeIds`，仅成功完成目录枚举时才跨全部 history scope 删除已消失 cascade 的
`db-row` 游标，空 DB、有界 read、stat race 和未声明完整目录的自定义 reader 均不会误删。
已复读 pending upload 确认、跨来源边界、压缩 frontier、row high-water 及状态空间路径，并确认
历史 event/session identity 在 90 天 retention 后删除、无 statusline alias/occurrence 状态进入
上传计量路径。验证通过：`pnpm --filter @tokenboard/collector test`（44 文件、404 用例）、
`pnpm --filter @tokenboard/collector typecheck`、
`git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`。

补充复核（2026-07-23）：新增 3,000 条已 ACK 旧 SQLite history event 的真实 cursor 状态流回归。
90 天 retention 后 cursor 仅保留一个 per-cascade `db-row`，不保留 event、session 或 aggregate
identity；随后两次 `--since all` canonical rebuild 均生成同一 daily-model `30,000` token、1 session，
证明重扫是替换式重建而非累计。另以 64,000 项合法 legacy alias map 验证成功的 canonical rebuild
与 ACK 压缩会清除旧 alias、aggregate 和 history identity。验证通过：
`pnpm --filter @tokenboard/collector test -- src/providers/antigravity-cli-full-rebuild.test.ts src/providers/antigravity-cli-replay-compaction.test.ts src/providers/antigravity-cli-history-authority.test.ts src/providers/antigravity-cli-cursor.test.ts src/providers/session-cursor.test.ts src/providers/antigravity-cli.test.ts src/cli-antigravity.test.ts`（47 文件、450 用例）和
`pnpm --filter @tokenboard/collector typecheck`。

## T03 Five-Source Since Windows And GUI/IDE Reliability

状态：已完成

内容：完成并复核五个来源的采集窗口和 Antigravity GUI/IDE 可靠性边界。

- collector CLI 的 `--since` 必须显式传给 Claude Code、Codex、Antigravity CLI、
  Antigravity 和 Antigravity IDE；`preview` 不应因无关的错误 upload endpoint 提前失败。
- ISO 日期必须拒绝不存在的日历日期；所有 provider 以相同 lower bound 过滤本地记录，
  默认窗口和 `all` sentinel 行为可预测。
- GUI/IDE 候选 cascade 对空或不可用 metadata 必须轮换或退避，不能反复卡在最近同一批。
- language-server metadata 响应严格限制累计大小，禁止无限 buffer；只投影 usage metadata，
  原始内容不能进入 cursor、日志、snapshot 或上传 payload。
- language-server 启动只能接受文档化 marker 或真实 TLS/HTTP readiness probe；任何只是
  含端口号的诊断输出不得被当作 ready。
- SQLite/protobuf 内嵌 timestamp 字段存在但内容损坏时必须显式失败，不能伪装为字段缺失
  后使用 mtime；真实字段缺失才可走定义的 fallback。

验收标准：运行 CLI、Claude、Codex、GUI、IDE、history protobuf/db、GUI client 和 since
定向测试及 collector typecheck；测试覆盖 malformed date、oversized response、readiness
竞态、空候选轮换、受限时间窗口和原始内容不落盘。

审查要求：检查所有时间筛选点，避免只有文件数量 cap 而没有事件时间过滤；检查 response
错误、取消、超时和不完整 metadata 是否仍可诊断且不污染游标。

完成证据（2026-07-20）：`preview` 仅在 `sync` 路径解析 endpoint，错误的环境或命令
endpoint 不会阻断本地预览。CLI 的显式、默认和 `all` 三种 `--since` 均传递给 Claude Code、
Codex、Antigravity CLI、Antigravity 和 Antigravity IDE；各来源在 provider 内执行相同范围
过滤。GUI/IDE 对空 metadata 写入持久尝试 frontier，后续选择会推进到较旧 cascade；语言服务器
只在精确启动 marker 出现后执行 TLS readiness probe，metadata response 在 8 MiB 时中止请求。
严格 ISO parser 同时拒绝非 ISO 与格式合法但日历不存在的日期，protobuf 内嵌 timestamp 损坏会
显式失败而不回退 mtime，原始 metadata 内容未进入 cursor 或 snapshot。验证通过：
`pnpm --filter @tokenboard/collector test`（44 文件、406 用例）、
`pnpm --filter @tokenboard/collector typecheck`、
`git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`。

## T04 Hooks Statusline Locks And Multi-Server Recovery

状态：已完成

内容：完成并已运行定向回归的本地脚本可靠性修复。

- 旧 Windows Node 的 signal-zero 不可靠时，使用 `%SystemRoot%\\System32\\tasklist.exe`，
  不依赖可能被劫持或缺失的 PATH；无法确认 owner 存活时不删除锁，充分过期且确认 dead
  时才回收崩溃锁。
- cursor lock 和 coordinator/notify lock 释放前等待在途 heartbeat；同 owner 的 mtime 更新
  不得被错判为新 owner，锁替换、竞态恢复和 token ownership 必须保持原子性。
- Windows `taskkill` 启动但非零退出时必须 fallback 或显式终止失败；超时的原 statusline
  命令和子进程树不得遗留。
- 采集限长时仍原样转发 stdin；原命令成功输出即使遇到转发 EPIPE 也必须输出，原命令失败
  时不泄漏部分输出。
- 成功 sync 之后 checkpoint 写入失败时，`last-run` 保留 cycles 和 follow-up evidence，再额外
  记录 checkpoint 错误；不能把已完成的同步写成空结果。
- legacy root config 在首次加入第二个 server profile 前必须迁移；setup 切回已保存 profile
  时继承 repo URL/ref、package manager 和 schedule，显式 flag 才覆盖保存值。
- device-link 恢复状态按 server origin 存储；轮换非 active server token 不覆盖 active
  server 的恢复凭证；卸载时若 Antigravity 恢复未完成，不得删除 configDir 或原 statusline
  restore artifact。

验收标准：已通过 `cursor-process-liveness` 和 `session-cursor` 34 个测试、collector
typecheck、完整 skill scripts `349/349`、hook handler `55/55`、Windows statusline/
coordinator/notify lock `24/24` 及基线 `git diff --check`。T08 仍会在冻结差异后重新运行
完整 workspace tests、typecheck 和 build。

审查要求：确认 Windows PATH、PID reuse、权限不足、tasklist 超时、锁替换、EPIPE、子进程
树、双 server config/device-link、显式恢复和异常卸载均有失败路径并且不会悄然破坏状态。

## T05 Web D1 And Legacy Client Compatibility

状态：已完成

内容：完成并复核 Web、D1 migration 和旧 client 的可恢复兼容性。

- reconnect pairing code 创建和设备重新配对必须以 `INSERT ... SELECT ... WHERE` 或等价
  零行写入表达并发撤销/claim 变化，不能把 NULL user ID constraint 变成 HTTP 500；service
  必须稳定映射 stale pairing 为 401、失效 target/source installation 为 404。
- AJAX document/leaderboard navigation 必须取消或 generation-guard 前一请求；先发请求后到达
  的陈旧响应不能覆盖较新的 DOM、history、title 或 busy 状态。
- 设备页面的轮换凭证提示需有稳定 copy controls、可访问 label、一次性敏感状态说明及
  macOS/Linux/PowerShell 命令；不改变 token 只显示一次的安全边界。
- `config.mjs`、`setup.mjs`、`rotate-token.mjs`、`device-link.mjs` 的 legacy root config、
  active/inactive server profile、并发写、恢复 credential 和安装参数继承均必须保持。
- `0028_remove_development_seed.sql` 仅删除未被真实认领的开发 seed 及固定 pairing
  credential；已经真实认领的 account/profile/usage 不能被删除。`0029` 只删除冗余 named
  index，保留 `pairing_codes.code_hash` 的 uniqueness。
- `verify-critical-schema.sql`、Drizzle schema 和 deploy script 必须与 migration 顺序一致，
  并在部署前检测关键设备身份和 legacy upload token schema。
- Antigravity 三来源的费用不可用语义必须逐模型传播：dashboard、details、通知、public JSON、
  SVG、排行榜和 CSV 不能把占位 `0` 当作真实价格；CSV 需输出空 `cost_usd` 和
  `cost_available=false`。混合来源通知不能因为 report 有一个 Antigravity source 就误标所有
  top model 为费用不可用。
- 修复上游合并后的认证详情、设备页和旧 collector 兼容问题必须在私人部署与真实 collector
  验证中再次确认，不能仅以页面源码或 local D1 结论代替。

验收标准：运行 navigation、device repository/service/route、install command、usage CSV、
通知/public usage、迁移、deploy config 和 critical schema 的定向测试；当前首批 11 个 Web
测试文件的 118 个测试已通过。T08 运行完整 Web/workspace test、typecheck、build；T10 在
私有 D1 上执行迁移和认证页面/collector ingest 验证。

审查要求：检查所有 batch 的 statement order、D1 零行 meta changes、事务失败传播、route
`jsonError`、active profile 切换、迁移幂等性、foreign key 行为、CSV header/blank 字段和
mixed-source model-level availability。

完成证据（2026-07-20）：`0028_remove_development_seed.sql` 现始终清除固定开发
pairing credential，但仅在默认 seed user 没有认证 account 时删除其 profile、usage 及关联
状态；已认证用户的 account/profile/usage 均保留。`0029` 删除冗余 named index 后仍由
`pairing_codes.code_hash` 的 UNIQUE constraint 拒绝重复 credential。新设备与 reconnect
batch 均采用有条件 `INSERT ... SELECT`，并发消费 pairing code 返回稳定 `401`，inactive
reconnect target/source 返回 `404`，不会以 NULL user ID 触发 SQLite/D1 constraint error。
AJAX navigation 使用 abort controller 和 generation guard，旧响应不能覆盖新页面；token
轮换提示使用可访问 copy controls。Antigravity 费用可用性已逐模型传递到 CSV、通知和
public-card，CSV 输出空 `cost_usd` 与 `cost_available=false`。验证通过：Web 定向/完整
Vitest `79` 文件、`576` 用例；`pnpm --filter @tokenboard/web typecheck`；skill profile、
setup、device-link、rotate-token 回归 `66/66`；
`git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`。私有 D1 migration、认证页
和真实 collector ingest 的运行证据明确留待 T10，不以本地测试替代。

## T06 Code Test And Documentation Governance

状态：已完成

内容：清理本次替换后不再使用的实现、孤立测试 helper 和无用文件；统一格式；审查生产
文件职责与函数复杂度；处理过大的测试文件。

- 审查 `antigravity-cli.test.ts`、`hook-sync.test.ts`、`codex-subagent-usage.test.ts`、
  `session-cursor.test.ts`、`cli-antigravity.test.ts` 的职责。超过 1,000 行应按 fixture、
  cursor lifecycle、CLI contract、source parsing 等清晰边界拆分；无法安全拆分时在
  `docs/reviews/CR-TEST-FILE-SIZE-2026-07-20.md` 记录具体豁免和理由。
- 同样审查 `hooks.test.mjs`、`deploy-config.test.ts` 的 800 行级边界，以及本补丁超过
  500 行的生产文件；不得为行数制造循环依赖、重复类型或难以追踪的跳转。
- 删除已废弃的 statusline upload/index/scan 实现后，确认没有无效 import、文档、测试计数
  或用户可见说明仍声称 statusline 是上传计量来源。
- 更新 README、`skills/tokenboard/SKILL.md`、部署恢复说明和 review 文档，说明本轮实际
  兼容边界、验证命令、迁移/回滚前置条件；不得记录秘密、私有 URL、设备信息或把旧部署
  表述成当前候选已部署。

验收标准：每个删除或拆分有 import/search 检查、相关测试和 format/lint 等价验证；审查文档
反映当前 snapshot，且 `git diff --check` 通过。

审查要求：区分无用代码和仍被旧 client/upgrade path 使用的兼容代码；文档中的测试计数、
部署状态和 source 行为必须由当前命令或代码证明。

完成证据（2026-07-20）：已删除的 `antigravity-cli-history-index`、
`antigravity-cli-occurrence-index`、`antigravity-cli-scan-cursor` 与 collector statusline upload
实现无 import、文档或用户可见行为残留；statusline 当前只保留私有本地诊断。旧
`statusline-*` cursor 字段只用于识别和迁移历史本地状态，完整 SQLite rebuild 成功后会删除，
因此不是可直接移除的 dead code。`CR-TEST-FILE-SIZE-2026-07-20.md` 已按当前行数补全
超过阈值的测试、device service/repository 和 production 文件职责、豁免及解除条件，避免
机械拆分影响共享事务、cursor 与 fixture 生命周期。README、skill 和恢复文档已明确区分
当前代码事实、历史验证快照与未完成的私有部署 gate。验证通过：collector 定向测试
`44` 文件、`406` 用例，collector typecheck，skill 定向回归 `116/116`，Web 定向/完整
Vitest `79` 文件、`576` 用例，以及基线 `git diff --check`。

补充复核（2026-07-23）：以当前工作树重新枚举全部测试和生产源码文件，发现原 review 文档的
`codex-subagent-usage.test.ts`、`hooks.test.mjs` 与 `cli-antigravity.test.ts` 行数已过期，且遗漏
通知、ingest summary cache、upgrade、ingest repository、Codex provider 测试，以及 `codex.ts` 和
`cli.ts` 的职责记录。`CR-TEST-FILE-SIZE-2026-07-20.md` 现覆盖当前全部 `13` 个达到 800 行的
测试文件和 `10` 个超过 500 行的生产文件，并为每项记录当前职责、非机械拆分理由与解除条件。
本补充只更新治理文档，不改变运行时代码；完整质量门禁仍留在 T08，不能引用旧测试结果替代。

## T07 Local Client And One-Month Data Verification

状态：已完成

2026-07-28 当前候选重启后复验：公开 status 确认当前 server、collector、device identity、四个
每日时段和 Codex/Claude Code/Antigravity hooks 均已配置；活动 server scope 的 Antigravity CLI
cursor 为 metering version 3、全历史完成且没有 pending upload。所有 preview 使用一次性 state
directory，结束后清理，不上传、不修改正式 cursor，也只向 `/api/v1/ingest/check` 发送 snapshot key。
Claude Code 在 `20260628` 起生成 38 个快照、覆盖 30 天，38 个 hash 全部匹配；Codex 生成 96 个
快照、覆盖 31 天，94 个匹配、无缺失，2 个差异均为当天仍在写入的活跃会话，所有已结束历史日期均
匹配。Antigravity CLI 用 `--since all` 生成 25 个快照、覆盖 20 天，25 个 hash 全部匹配；普通
Antigravity 和 Antigravity IDE 在该窗口均为 0 个快照且无诊断，表示当前没有可采集事件而非 source
failure。

实际 Codex hook 的最新协调记录为 success 且无 follow-up。手工在已有同步持锁时触发 LaunchAgent
验证了 60 秒并发等待的显式失败和锁的自然释放；随后在三把锁均空闲时重新触发，LaunchAgent 以
exit 0 结束，协调器为 success、无 follow-up，`sync.lock`、`collector-run.lock` 和
`trailing.lock` 均不存在。该复验不读取、输出或修改配对凭证、生产 cursor 或原始 usage。

### T07-R1 Antigravity Language-Server Readiness Compatibility

状态：已完成

内容：本机 Antigravity 2.2.1 已证明 language server 能在 collector 分配的本地端口完成 TLS 握手，
但不再输出旧版 `fixed port at <port> for HTTPS` 文本。将启动就绪判断改为以实际本地 TLS
readiness probe 为准，不能仅因任意包含端口的输出判定成功；保留启动输出不进入错误、退出和超时
可诊断、子进程关闭的现有边界。

验收标准：新增无旧版 marker 但 TLS probe 成功的确定性回归；现有无 TLS 的端口诊断、启动退出、
超时和隐私输出回归继续通过；在本机以隔离 state preview 重新验证普通 Antigravity 能跨越启动阶段，
然后再验证 metadata 请求与最终采集结果。

审查要求：不得把端口文本、stdout/stderr 内容或任意 TCP 可达性当作成功；必须只接受 collector
刚启动子进程对应端口上的 TLS handshake，且失败路径不能泄露 language server 原始输出。

完成证据（2026-07-24）：本机已签名 Antigravity 2.2.1 language server 在没有旧 marker 的情况下
完成 TLS handshake。定向 collector 回归（51 文件、488 用例）和 collector typecheck 通过；一次性
state directory 的真实 provider preview 已跨越启动阶段，后续失败明确收敛为 metadata response
size limit，不再是 language-server-unavailable startup failure。临时 state 在每次验证后已清理。

### T07-R2 Bounded Antigravity Metadata Projection

状态：已完成

内容：普通 Antigravity 本机 `.pb`-only cascade 的 language-server metadata response 超过当前
8 MiB buffer 上限。先以不保留响应内容的流式字节计数确定实际边界，再实现或选择能保留严格内存
上界、只保留 usage projection、不会把 prompt/completion/raw metadata 写入 cursor、日志、snapshot
或上传 payload 的最小方案。

验收标准：响应超限仍有确定性错误和测试；真实 Antigravity 2.2.1 的 `.pb` metadata 可在明确资源
预算内完成投影，或给出可复现且不丢失诊断的外部阻断；定向 parser/client/provider/CLI 回归、typecheck
和一次性 state preview 均通过。

审查要求：不得以删除上限、将完整 JSON 写临时文件、吞掉超限或把 SQLite partial 伪装成完整采集来
解决；必须检查单响应、单字段、单数组项和总事件数量上界，以及原始文本不落盘。

完成证据（2026-07-24）：本机 Antigravity 2.2.1 的 12 个默认 `.pb`-only 候选中，8 个响应小于
1 MiB、3 个介于 1 MiB 与 8 MiB、1 个为约 22.4 MiB，均在单次 64 MiB诊断硬限内结束；没有
content-length 可在请求前可靠使用。将 collector 的完整 response 硬上限从 8 MiB 调整为 32 MiB，
仍在超限时清空已缓冲 chunk、销毁 response 并返回稳定错误。定向 collector 回归（51 文件、488
用例）、typecheck 和普通 Antigravity 一次性 state preview 均通过；真实 preview 在约 34 秒内以
exit 0 完成 2 个聚合快照、无 source failure，临时 state 已清理。响应仅在内存中解析，未写入临时
文件、cursor、日志、snapshot 或上传 payload。

补充复核（2026-07-24）：metadata response byte limit、generator metadata item limit 和总
usage-event limit 均归类为 `metadata-limit-exceeded`；language-server 返回 invalid JSON 归类为
`invalid-metadata`。这些资源或格式异常不再被默认 `--source all` 当作可选 language-server
unavailable。若 SQLite 已产生可确认的快照，collector 仍会上传这些 partial DB snapshots，但同步
最终以 exit 1 结束。相关 collector 回归通过（52 文件、506 用例）且 typecheck 通过；最新一次
临时 state 的真实 Antigravity preview 以 exit 0 返回 31 个聚合快照、无诊断类别，临时 state 已清理。
本次验证不上传数据，也不修改生产 cursor。

### T07-R3 Dirty Collector Checkout Upgrade Guard

状态：已完成

内容：本机 LaunchAgent 的 collector 指向当前开发 checkout，而定时同步默认会先运行升级流程。现有
升级计划会在任何工作树检查前修改 remote、fetch 并可能执行 checkout；当 checkout 含未提交改动时，
这会威胁本地候选并且会产生难以诊断的 Git lock/checkout 失败。为已有 Git collector 增加只读的
dirty-worktree preflight，在任何会改变 checkout 的步骤前显式拒绝升级；同步必须记录升级被跳过的
错误并继续执行 collector，不能静默覆盖本地代码或伪造升级成功。

验收标准：脏 Git checkout 的确定性回归证明第一个且唯一的 Git 调用是只读 status，且没有 remote、
fetch、checkout、copy、install 或配置写入；干净 checkout 的既有升级回归保持通过；真实本机在不修改
当前工作树的前提下能以 `TOKENBOARD_SKIP_UPGRADE=1` 完成受控同步。

审查要求：检查 preflight 覆盖所有已有 Git checkout，不把 Git 状态查询失败误当作干净；错误消息不
包含敏感配置或本地会话信息；此运行时代码及直接支持测试变更会重新打开 T08 全量门禁和人工安全审阅。

完成证据（2026-07-25）：`upgrade.test.mjs` 的 `31/31` 回归覆盖脏 checkout 和无法读取 Git status
两条拒绝路径，并证明二者都在任何 remote、fetch、checkout 或配置写入前停止；`sync-runner.test.mjs`
与 `sync.test.mjs` 的 `18/18` 回归继续通过。真实本机以一次性 state directory 运行不带
`TOKENBOARD_SKIP_UPGRADE` 的 Antigravity IDE preview：升级明确记录为因未提交 checkout 被跳过，
collector 仍以 exit 0 完成；IDE 在最近一个月返回 0 个快照且不是 unavailable 或 source failure。
临时状态已清理，未上传 usage 或改变正式 cursor。

前置核验已记录在本节；受控补偿同步和最终验收必须等待重新打开的 T08 质量与安全门禁通过后才可开始。

2026-07-24 重启后复核：顺序执行 Antigravity CLI `--since all` 与 `--since 20260624` 的一次性
state preview，排除了上一轮并发 SQLite 读取导致的 `database is locked`。完整扫描返回 `25` 个
快照，日期 `2026-06-02` 至 `2026-07-02`；有界单轮返回 `5` 个快照，日期 `2026-06-30` 至
`2026-07-02`；stderr 均为空且没有 SQLite lock。哈希对比显示 `3` 个同 key 一致、`2` 个同 key
不同，且差异字段均为 full greater，证明有界路径仍可能低估近月 Antigravity CLI daily-model。
定位结果：有界 SQLite 扫描先按 DB/WAL mtime 过滤，再按 metadata 内真实事件时间过滤；未处理过的
旧 mtime 数据库会被永久跳过，即使其中存在 `--since` 窗口内事件。已将候选选择改为：无 row cursor
的数据库不受 mtime 过滤限制，仍由事件时间决定是否纳入快照；已有 row cursor 的已处理数据库继续
使用 mtime 过滤以保持有界性能。新增回归覆盖旧 mtime 未处理数据库仍会被读取并推进 row cursor。
定向验证通过：`antigravity-history-db.test.ts`、`antigravity-cli.test.ts`、
`antigravity-cli-since.test.ts`、`antigravity-cli-full-rebuild.test.ts` 共 `35/35`；collector
typecheck 通过。真实本机 sweep 使用同一临时 state 连续执行 `15` 次有界 preview，快照数
`5,5,5,7,7,7,8,9,9,12,13,13,13,13,13`，最终 `13` 个近月快照与 full scan 同 key 全部一致，
`0` 个 changed，`12` 个 full-only 均为窗口前历史；全程无 stderr、无 SQLite lock、无正式 cursor
或上传改动。该源码和直接支持测试变更使 T08 最新完整门禁及人工安全审阅失效；必须重新执行 T08
后才能继续有状态补偿、最终 hash 对账、T09 或 T10。

2026-07-24 当前无状态 Codex 核验：本机安装状态确认配置、collector、Codex/Claude hooks、
Antigravity CLI opt-in statusline、四个 LaunchAgent 时段均存在，正式 sync、collector 和凭证锁均
不存在。LaunchAgent plist 可解析，但最近一次退出码为 `1`，仍需在受控补偿和后续运行日志中定位，
不能标为正常。一次性 state 目录下的 Codex preview 在 `2026-06-21` 至 `2026-07-22` 完成，生成
`91` 个快照、`8` 个模型，日期没有越界；过程约十分钟，CPU 密集型本地解析，无上传、网络写入或正式
cursor 改动。`/api/v1/ingest/check` 仅以 snapshot key 对账，HTTP `200`，`2` 个 hash 一致、`89` 个
已有 key hash 不同、`0` 个 key 缺失。这证明需要待 T08 通过后执行 Codex 最小补偿，不构成上传成功。

### T07-R4 Codex Frozen Scope Copy Performance

状态：已完成

内容：本机近月 Codex history 包含约 1,724 个 JSONL 文件和约 49.6 GiB 数据，最大单文件约
2.08 GiB。隔离 preview 原先依赖每个文件单独启动 Ruby 的 `clonefile(2)` 调用，启动开销会放大到
数分钟；Node 的 `COPYFILE_FICLONE_FORCE` 在本机 APFS 上返回 `ENOSYS`，不能作为 macOS 的可靠
CoW 路径。将 macOS 实现改为每个 frozen scope 一个受限、短生命周期的 Ruby JSONL helper，复制结束
后立即关闭；非 macOS 保留强制 reflink，只有 `ENOTSUP`、`EOPNOTSUPP`、`ENOSYS`、`EXDEV` 或 helper
缺失时才有界退回标准复制。权限、协议、目标路径和非源端 `ENOENT` 都必须显式失败，不能伪装为会话
消失。

验收标准：一个 scope 的多个文件只启动一个 helper；成功、明确不支持 fallback、权限拒绝、协议损坏、
helper 关闭、真实源文件消失和目标侧 `ENOENT` 都有确定性回归。真实 macOS clonefile 多文件 scope
必须完成且无残留 helper，不改变生产 cursor 或上传 usage。

审查要求：helper 不得跨 scope 或跨 ccusage 解析存活；stdin/stdout 协议必须有响应大小上界；fallback
只允许已列明的不支持错误；复制后的 path、大小、metadata 和 fingerprint 校验仍必须保留。

完成证据（2026-07-25）：新增 `codex-session-cloner` 的 `10` 条协议/生命周期回归和 scope 复制竞态
回归；相关 scope、bounded scan、retry 与 attribution cache 共 `49/49` 通过，collector 全量
`57` 个文件、`561` 条用例和 collector typecheck 通过。真实 macOS `/usr/bin/ruby` 2.6 helper 对
50 个 JSONL 文件的完整 frozen scope 复制为约 325 ms，副本数为 50；结束后没有残留 helper 或临时
scope 目录。该性能运行不上传数据，不改生产 cursor。由于本条修改了 collector runtime 与直接支持测试，
必须重新完成 T08 全量质量和人工安全门禁后，才能继续 T07 的有状态补偿、T09、T10、提交或 PR。

### T07-R5 Codex Bounded Discovery Performance

状态：已完成

内容：真实七天计划任务仍先在约 49 GiB 的 live `CODEX_HOME` 上运行全局 bounded session discovery，
并在 `DEFAULT_SESSION_TIMEOUT_MS = 900000` 处稳定超时。将 bounded collection 从第一条 `ccusage`
命令开始限制在按事件时间预筛、分批且冻结的本地 scope 内；每个 scope 内继续执行 daily、bounded
session 与 canonical session attribution，保持模型、日期、session count、多 profile、缓存和
subagent correction 语义。

验收标准：确定性回归证明 bounded collection 不再对真实 `CODEX_HOME` 运行任何 `ccusage` 命令，
所有命令只读取冻结批次；批大小、日期边界、canonical attribution、缓存、多 profile、archive
优先级、重试与无可冻结 scope 的显式失败回归继续通过。真实七天计划任务必须在合理时间内 exit 0，
且不再出现全局 session discovery 的 15 分钟超时。

审查要求：不得只提高超时或省略 canonical attribution；不得把无 scope、复制失败或会话变化吞成
空成功；冻结 scope 必须保持资源上界、路径 containment、完整 cleanup 和源文件 fingerprint 校验。
该运行时代码及直接支持测试变更会使 T08 失效，完成后必须重新执行完整门禁和人工安全审阅。

完成证据（2026-07-27）：本机七天窗口 `20260720` 的隔离 Codex preview 冷缓存以 exit `0` 在
`350,177 ms` 内完成，热缓存以 exit `0` 在 `184,139 ms` 内完成；两次均生成 `31` 个快照，
覆盖 `2026-07-20` 至 `2026-07-27`，缓存固定为 `752` 条、`480,886` bytes，且没有临时 frozen
scope 残留。非 Codex 四来源隔离运行也都以 exit `0` 结束：Claude Code `20,835 ms`、Antigravity
CLI `14,474 ms`、Antigravity `1,788 ms`、Antigravity IDE `992 ms`；后三个来源在该七天窗口为
零快照，不能据此替代近月覆盖验收。定向 Codex 范围测试 `12` 个文件、`78/78` 通过，collector
typecheck 和基线 `git diff --check` 通过。2026-07-27 09:00 LaunchAgent 最近一次全来源运行记录为
exit `0`，没有全局 discovery 的 15 分钟超时诊断；其末次 collector 日志写入为 09:04:33。hook
实测中，一个合并 Claude Code/Codex 的延迟通知在 `82,913 ms` 内成功结束，全部 coordinator、
trailing 与 run-log 锁均自然释放。现有 scheduled log 还不记录每次运行的精确开始/结束时间，故
09:00 记录只能证明正常退出和无超时，不能作为精确耗时基准。临时隔离性能工件已在记录本摘要后
清理。本条完成后 T07 的近月 hash 对账与必要补偿仍未完成；T08 必须先重新执行。

内容：使用现有本机配置做不泄露秘密的真实 collector 核验。

- 检查 TokenBoard status、Codex/Claude hooks、Antigravity opt-in statusline、计划任务、
  运行日志、cursor locks 和最近 hook/scheduled sync 的退出状态。
- 对最近一个月分别运行 Claude Code、Codex、Antigravity CLI、Antigravity、Antigravity IDE
  的只读 local preview；确认范围、无解释错误、采集性能、hook 不阻塞前台工具且状态大小
  受控。
- 使用既有 upload 配置请求 `/api/v1/ingest/check` 的 snapshot hash 对账，确认 preview
  和服务端已有数据一致。历史曾有 Claude mismatch、Antigravity CLI missing、普通
  Antigravity 部分可采集和 Codex bounded 失败，必须以当前代码重新关闭或明确复现。
- 若且仅若当前代码与质量门禁已证明安全、而 hash 对账显示确有缺失，用既有已配对 profile
  做最小充分的补偿 sync，再次核验。不重新配对、不删除 config、不打印 config/device-link
  或原始 usage。

验收标准：记录命令退出码、各来源 snapshot 数量/哈希摘要、服务端 check 结果、计划任务
状态和无残留锁；若任何来源不可采集，记录可复现根因而不是把它归为“正常”。

审查要求：确认 preview 不上传、hash check 不暴露 usage 内容、补偿 sync 仅覆盖确有缺口的
窗口，且 hooks/scheduler 的性能与错误日志符合用户可诊断要求。

历史预检记录（2026-07-21，不替代本任务验收）：

- 本机现有配置、`Asia/Shanghai` 时区、`09:00,12:00,18:00,23:00` LaunchAgent、Codex/
  Claude Code hooks、Antigravity CLI opt-in statusline 与多 server device-link 均存在；核验后
  没有残留 `sync.lock` 或 `collector-run.lock`。一次真实 Codex hook sync 在高 CPU 解析期间
  正常持锁并自然释放，未清理或篡改任何在途锁。
- 五来源近 30 天独立 `preview` 均使用一次性 `TOKENBOARD_STATE_DIR`，不上传、不修改生产
  cursor，结束即删除临时状态。Claude Code 为 39 个快照（2026-06-21 至 2026-07-21，约 25 秒）；
  Codex 为 88 个快照（2026-06-20 至 2026-07-21，约 53 秒，使用临时复制的受限子代理缓存）；
  Antigravity CLI 为 5 个快照（2026-06-30 至 2026-07-02，约 3 秒）；Antigravity 为 2 个
  SQLite 快照（2026-06-23 至 2026-06-26）但本机 language server 不可用，单源命令按契约
  返回可诊断失败；Antigravity IDE 为 2 个快照（2026-06-23）。五来源组合 preview 返回 136 个
  快照和 Antigravity partial diagnostic，不存在未分类失败。
- 组合 preview 的 `/api/v1/ingest/check` 只发送 snapshot keys，返回 HTTP 200。118 个键的
  本地/服务端 SHA-256 一致；17 个已有键不同，1 个 Antigravity CLI 键缺失。非一致范围仅为
  Antigravity CLI 2026-06-30 至 2026-07-02、Claude Code 2026-06-21/2026-07-13/
  2026-07-20 至 2026-07-21、Codex 2026-07-03/2026-07-21。不得将这次只读对账当作已上传成功；
  T08 通过后才可按此范围执行最小补偿 sync 并再次核验。
- 当前真实 Antigravity CLI cursor 仍为旧 statusline 计量格式，未设置 SQLite 权威
  `antigravityCliMeteringVersion`，且有旧 pending statusline 记录。当前代码对此显式要求
  `--since all`，避免有界默认任务将旧 statusline totals 与 SQLite totals 混用；T08 后的补偿
  必须包含一次受控的 Antigravity CLI `--since all` canonical rebuild，不能手工删除 cursor。
- 本机近期 Codex 会话规模较大，首次隔离 preview 曾在活动子代理会话写入期间触发
  `Codex child session changed while correcting`。已补充有限稳定重读：首次 fingerprint 变化后
  仅重读一次，连续变化仍明确失败且不写 cache；定向 collector 回归 34/34 与真实 30 天 Codex
  preview 均通过。该修复不复用不稳定 usage，也不改变 hook 前台非阻塞边界。

完成补充（2026-07-28，当前候选）：本节顶部的重启后复验取代此前 Claude Code、Codex、
Antigravity CLI、普通 Antigravity、IDE 和 LaunchAgent 的历史运行证据；当前验收不再依赖旧 preview
或旧补偿同步结果。T07 验收完成，可进入冻结差异的最终只读复核。

## T08 Full Quality Security And Documentation Gate

状态：已完成

2026-07-28 重新打开说明：真实隔离 Codex 双窗口预览确认，相同历史 snapshot 的 token 和 session
完全一致时，`costUsd` 仍会因冻结 scope 的批次组成以及动态定价读取而变化，进而改变上传 hash。
当前原子任务先用离线定价复现实测边界，再将 Codex 每日费用投影移动到所有 frozen batch 合并之后，
使用固定精度、确定性的按 token 分配；完成后必须重新执行定向回归、真实双窗口对账及受影响门禁。

2026-07-28 Codex 费用一致性修复完成：锁定的 `ccusage@20.0.18` 在本机直接离线日汇总的
25 个共同历史日费用差异为零。collector 现在对 daily 和 session 命令固定传递 `--offline`，并在
全部 frozen batch 合并后才按最终 token 权重投影当日模型费用；先累计整日费用、再固定到微美元并
按稳定余数顺序分配，避免逐批或逐模型浮点取整改变 hash。串行、临时 state-dir 的真实双窗口
collector 对账（`20260628` 与 `20260703`）确认 83 个共同历史 key 均在请求窗口内，token、session、
cost 和 hash 的差异均为零，且没有残留本轮临时 scope。新增跨窗口 hash 回归和命令参数断言通过；
本次 runtime 与直接测试变更使此前完整 T08 门禁失效，因此 T08 保持进行中，待主机重启后重跑。

2026-07-28 重启后完成该费用一致性原子任务的 collector 回归：
`pnpm --filter @tokenboard/collector test` 为 `62/62` 文件、`607/607` 用例通过，
`pnpm --filter @tokenboard/collector typecheck` 与相对基线的已跟踪 diff 检查均成功；
无残留本轮费用对账或 `ccusage codex` 进程。该结果只确认本原子任务，T08 的 workspace、skill、
build、安全和运行态门禁仍保持进行中，须按后续顺序重新执行。

2026-07-28 Antigravity GUI/IDE SQLite row-cursor reset 修复完成：仅在 `--since all` 的完整
本地数据库重建中恢复；有界窗口检测到 reset 会保留原 cursor 并显式失败。恢复前会拒绝无法区分
database 与 language-server 来源的 legacy usage state，或任何未确认的 database usage；恢复读失败
不会写回已在内存中清理的 cursor。已确认的 database daily-model 状态先生成持久化零值 replacement，
重读后的 database 事件和保留的 language-server 状态再合并为完整 replacement snapshot；零值
replacement 在 ACK 前持续重试，在 ACK 后由 cursor compaction 回收。database 与 language-server
aggregate / session state 按来源标记，故 database reset 不会删除已确认的 language-server 状态。
专项回归覆盖重建增量、旧事件删除、pending 拒绝、legacy 拒绝、恢复读失败不落盘、ACK 清理、混合
来源同组以及 database 消失后保留同模型 language-server 的 session 计数。定向组为 `6/6` 文件、
`165/165` 用例；随后 collector 全量为 `63/63` 文件、`616/616` 用例通过，collector typecheck
与 `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 均成功。此 runtime 与直接支持
测试变更使历史 T08 全局门禁仅保留为历史证据；T08 仍为进行中，必须在候选冻结后从零重跑。

2026-07-28 hook 信号 drain 保留修复：人工审阅确认，queued 或 legacy notifier signal 原子改名为
drain 文件后若读取失败，旧实现会在 `finally` 中删除该文件，从而永久丢失本应稍后重试的 hook
通知。现改为只在成功读取后删除，严格识别可恢复的 queue/legacy drain 文件，下一次 coordinator
会先消费该信号且不会误吞同源并发新写入的稳定 queue marker。queued 与 legacy 两种 `EACCES`
读取失败后重试均有确定性回归；coordinator、notify、hook、sync、upgrade、statusline 定向组
`222/222` 通过。该 runtime 和直接测试变动使此前 T08 全量门禁过期，T08 保持进行中，必须重新
完成完整质量、安全、migration/schema 与文档门禁后才能开始任何有状态 T07 补偿。

2026-07-28 重启后最终门禁：在 signal drain 保留和同 PID 遗留锁回收修复后，当前候选相对
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 包含 `109` 个已跟踪路径变更（`105` 个新增或修改、
`4` 个删除）与 `49` 个未跟踪直接支持文件。完整 workspace 门禁重新通过：`pnpm test` 为
usage-core `9/9`、collector `623/623`、Web `580/580`，共 `1,212` 条；`pnpm typecheck`、
`node --test skills/tokenboard/scripts/*.test.mjs`（`360/360`）、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check` 均成功。新增 coordinator、lock、sync
定向回归为 `52/52`，覆盖 drain 读失败保留、多个 drain 中的后续读取失败、cleanup 恢复、同 PID
重用锁和锁所有权释放。

离线 D1 契约将 `0000` 至 `0029` 按名称顺序应用到新的 SQLite 内存数据库，随后执行
`db/verify-critical-schema.sql` 与 `PRAGMA foreign_key_check`；两项均无输出并以
`migration-schema-contract=passed` 结束。人工差异审阅覆盖 D1 条件写与 migration、collector 的
有界文件、JSONL、缓存、worker 与 cursor 路径、Antigravity 三类来源、hook、statusline、lock、
upgrade 的失败传播、依赖覆盖和直接支持测试。CLI 时区已由 `assertValidTimeZone` 校验，Windows
`.cmd` 调用也会拒绝 shell 元字符，因此外部审阅提出的 hook timezone 命令注入路径不成立。已跟踪
新增或修改文件和所有未跟踪支持文件的无内容高置信凭证标记扫描为零命中；用户禁止
`codex-security` 插件，故未调用。

该门禁仅解除 T07 当前运行态与数据核验前置条件，不构成部署、真实 ingest、认证页面、提交、推送
或 PR 成功证据。后续任何运行时代码或直接支持测试变更都必须重新打开 T08。

2026-07-28 当前冻结结果：相对
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 的候选包含 `107` 个已跟踪路径变更和
`43` 个直接支持的未跟踪路径。当前完整门禁均通过：`pnpm test` 为 usage-core `9/9`、
collector `604/604`、Web `580/580`，共 `1,193` 条；`pnpm typecheck`、
`node --test skills/tokenboard/scripts/*.test.mjs`（`354/354`）、`pnpm build`、
`pnpm audit --audit-level=high` 及基线 `git diff --check` 均成功。Web/D1 migration、
critical schema、seed cleanup immediate/deferred foreign-key 和 pairing-code index 定向回归为
`35/35`；无内容高置信凭证标记扫描覆盖 tracked 新增/修改与所有未跟踪支持文件，结果为零。

人工复核重新确认了设备配对条件写、D1 migration、Antigravity SQLite 重建/ACK、Codex
scope/cursor、文件与 JSONL 限制、hook/statusline/lock/upgrade 失败传播和依赖覆盖，没有确认
新的安全、数据、兼容性或可靠性 finding。针对多 profile Codex pending snapshot 合并，在隔离
临时目录使用锁定的 `ccusage@20.0.18` 运行两份字节相同且会话身份相同的 synthetic history：
每个 home 单独均为 `15` tokens，两个 home 合并仍为 `15` tokens。因此当前按文件身份合并该
精确复制场景与本机 ccusage 聚合一致；该验证不外推为不同会话身份的去重规则。用户禁止
`codex-security` 插件，因此未调用；OMP 按用户最新指示明确跳过，不等待、不重试、不改配置，
也不计为审查通过。T08 只解除 T07 当前本机运行态和数据对账前置条件，不构成部署或真实 ingest
成功证据。

2026-07-27 最终重验：此前 root-symlink 读取竞态修复改变了 collector runtime 与直接支持测试，
故本节从零重新执行，历史计数只保留溯源价值。当前候选相对
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 包含 `104` 个 tracked path changes（`5` 个新增、
`95` 个修改、`4` 个删除）以及 `43` 个直接支持的未跟踪路径。人工差异审阅重新覆盖 Web/D1
条件写和 migration、collector 的文件/JSONL/cursor/clone-helper 边界、Antigravity 三类来源、
hook/statusline/lock/upgrade 的失败传播、依赖变更和文档。独立审查收据中的 root-symlink、
超长 JSON key、clone-helper deadline 与异步 `ENOENT`、stream 总字节上限、Antigravity ACK
timezone、安全整数 offset、comma-home 编码、Windows cursor key、D1 immediate/deferred FK
清理和文档漂移均已回到当前调用链与确定性回归核验；没有留下 confirmed finding。

历史门禁均通过：`pnpm test` 为 usage-core `9/9`、collector `599/599`、Web `580/580`，
共 `1,188` 条；`pnpm typecheck`、`node --test skills/tokenboard/scripts/*.test.mjs`
（`354/354`）、`pnpm build`、`pnpm audit --audit-level=high` 和
`git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 均成功。全部 migration 按名称顺序
应用到临时 SQLite 后，`db/verify-critical-schema.sql` 与 `PRAGMA foreign_key_check` 均无输出。
对 tracked 新增/修改内容和全部未跟踪支持文件执行的无内容高置信凭证标记检查为零命中。用户明确
禁止 `codex-security` 插件，因此未调用；OMP 按用户最新指示跳过，不等待、不重试、不修改配置，
也不将其记为通过。本节的该次结果已被后续源码和直接支持测试变更取代，不构成当前候选的部署或
ingest 成功证据。

2026-07-28 重新打开说明：多 Codex profile 的 pending snapshot 合并曾临时按 profile scope
区分相同内容。本机锁定的 `ccusage@20.0.18` 安装包仅提供可读 wrapper 与 README，不含 Rust
解析源码；因此不能声称已验证官方最终 dedupe key，也不能将当前跨 profile 同内容合并语义定性为
已确认缺陷。当前保留既有语义，profile cursor 隔离与 legacy cursor 迁移不变。定向 collector
测试 `61` 个文件、`600` 条用例和 collector
typecheck 均通过；完整 T08 门禁、T07 本机运行态核验和 T09 Claude 只读复核必须在新的候选冻结后
重跑。OMP 按用户当前指示跳过，不等待、不重试、不改配置，也不记为通过。

2026-07-27 当前补充：在冻结前的人工 collector 边界复核中，发现 append-only cursor 仅把 LF
当作 JSONL 行结束符，CR-only 文件会无必要地退回全量重读。现已将 CR 与 LF 都识别为有效行
结束符，并增加 CR-only append-only 回归。同时，若旧扫描恰好止于 CR、随后追加先补写同一
分隔符的 LF，新读取会跳过这个 LF，避免产出空记录；该情形也有确定性回归。JSONL metadata
scanner 对合法的超长无关 key 现在保持 JSON 结构验证但不把 key 当作语义字段，后续真实 usage
metadata 仍会触发显式 oversized 错误。相关 collector 测试 `61` 个文件、`598` 条用例和
collector typecheck 均通过。上述运行时代码及直接支持测试变更使此前 T08/T07/T09 历史证据
失效，必须从本节重新执行完整门禁、T07 运行态核验和最终 Claude 只读复核后才可进入 T10。

2026-07-27 上游整合后重新锁定：当前分支已安全快进整合 `upstream/master` 的 4 个提交，
其中包含 Windows/hook 运行时变更；此前冻结候选的完整门禁和人工审阅不能直接沿用。整合后
定向回归发现并修复了三处测试层冲突：重复 `join` 导入、四个 SQLite shell fixture 改为
`readSqlite` 注入、以及新增 Windows 隐藏进程调用后的断言计数。collector 定向回归为
`96/96`，skill coordinator/notify/hooks/lock 定向回归为 `94/94`；当前开始重新执行本节
全部 workspace、skill、build、audit、migration/schema 和人工审阅门禁。OMP 按用户指示跳过，
未修改任何 OMP 配置；这不替代本地门禁或最终部署验证。

2026-07-27 上游整合后 T08 完成证据：当前候选相对固定基线包含 `102` 个 tracked path
changes 和 `45` 个 supporting untracked paths。`pnpm test` 的 usage-core、collector 和 Web
包分别通过 `9`、`595`、`580` 条用例；Web 包随后单独重跑仍为 `580/580`。`pnpm typecheck`、
`node --test skills/tokenboard/scripts/*.test.mjs`（`354/354`）、`pnpm build`、
`pnpm audit --audit-level=high` 和 `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`
均通过。Web/D1 定向回归为 `35/35`；全部 `0000` 至 `0029` migration 在 SQLite `:memory:`
按名称顺序应用后，`db/verify-critical-schema.sql` 与 `PRAGMA foreign_key_check` 均无输出。
人工 diff 审阅覆盖 Web/D1、collector、skill、依赖、migration、测试和文档边界；高置信凭证
标记扫描为零命中，未确认 security finding。上游整合造成的三处测试冲突已修复并纳入暂存区。
OMP 按用户指示跳过，Claude/OMP 外部结果不被伪称为通过；T07 本机当前运行态、T09 最终复核
和 T10 私人 Cloudflare 验证仍是后续独立 gate。

2026-07-27 T09 confirmed-finding repair: the independent review receipts were checked against the
exact call paths and deterministic regressions. The candidate now rejects ambiguous legacy
comma-containing `CODEX_HOME` values while supporting an explicit JSON homes array and frozen
scope reconciliation; requires an explicit Antigravity ACK timezone; bounds JSONL and clone-helper
work; permits only a caller-supplied session-root symlink while rejecting every nested symlink;
and expands the seed cleanup migration fixture to immediate and deferred foreign-key modes with
`foreign_key_check`. Supporting Codex-only tests now fail fast if Claude collection is reached;
the skill, README, Antigravity verification, and size-review documentation match these behaviors.
These runtime and direct-test changes invalidate the preceding full-gate and local-client evidence.
They are retained below as historical records only. T08 must rerun from scratch, followed by T07,
before T09 can obtain final external review results or T10 can start.

2026-07-27 current freeze evidence: the repaired candidate passed `pnpm test` with 9 usage-core,
593 collector, and 578 Web tests; `pnpm typecheck`; 353 skill-script tests; `pnpm build`; and
`pnpm audit --audit-level=high` with no known vulnerabilities. The complete D1 migration sequence
applied to SQLite `:memory:` and both `verify-critical-schema.sql` and `PRAGMA foreign_key_check`
produced no output. The focused Web/D1 run passed 35 tests, including immediate and deferred
foreign-key seed cleanup. Focused collector clone, scope, cursor, CLI, and profile-hook regressions
passed, as did collector typecheck. `git diff --check` against the fixed baseline passed. The
manual diff review addendum records the root-symlink trust boundary, comma-home encoding, and
credential-marker result; no confirmed finding remains. This only unlocks current T07 verification.

重新打开说明（2026-07-27）：`T07-R5` 在上一轮完整门禁后修改了 collector runtime 和直接支持
测试；因此以下历史门禁仅作证据留存，不能用于当前候选。必须在 diff 冻结后从零重新执行本节所列
workspace、skill、build、audit、migration/schema 和人工安全审阅，才可开始 T07 有状态补偿、T09、
T10、部署、提交、推送或 PR。

完成证据（2026-07-26，当前冻结候选）：相对基线
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 的当前候选包含 `97` 个已跟踪路径变更
（`93` 个修改、`4` 个删除）及 `39` 个直接支持的未跟踪文件。最后一次运行时代码和直接支持
测试变更后，重新完整执行并通过以下门禁：`pnpm test`（usage-core `9`、collector `567`、Web
`578`，共 `1,154` 条用例）、`pnpm typecheck`、`node --test skills/tokenboard/scripts/*.test.mjs`
（`353/353`）、`pnpm build`、`pnpm audit --audit-level=high`（无已知漏洞）和
`git diff --check <base>`。Web/D1 定向回归为 `8` 个文件、`123` 条用例；collector 定向回归为
`10` 个文件、`52` 条用例，覆盖 device reconnect 条件写、两份新 migration、critical schema、
Codex hook 活跃 child-session 重试、上传 request/JSON deadline、Antigravity canonical rebuild、
cursor compaction 与 GUI/IDE 限制。全部 migration `0000` 至 `0029` 已按顺序应用到 SQLite
`:memory:`，随后执行 `verify-critical-schema.sql` 和 `PRAGMA foreign_key_check` 均无输出。

最终人工 diff 审阅重新检查了 Web/D1 条件事务和 migration、collector 的有界文件读取/游标/
上传重试、hook/statusline/lock/upgrade 的所有权和失败传播、依赖覆盖、未跟踪直接支持文件及文档。
高置信凭证标记扫描未发现可报告匹配；未确认安全、数据正确性、兼容性或可靠性 finding。用户明确
禁止使用 `codex-security` 插件，因此未调用该插件。Web 测试加载配置时仍会输出既有
`@tailwindcss/node` 的 `module.register()` 弃用提示；它不影响测试、类型检查、构建、审计或迁移
结果，不能作为发布成功依据。此完成只解除 T07 的受控本机核验前置条件；T09、T10、部署、提交、
推送和 PR 仍未完成。

2026-07-26 重新打开原因：真实 Codex hook 在活跃 child session 的读取期间可能收到
`Codex child session changed while reading; retry the sync`。有界手动 collection 已有一次完整
重试，但 hook reconciliation 未覆盖该精确 race，导致 signal 保留但当前 hook run 直接失败。现已将
hook 仅对 child-session fingerprint/read/correction race 执行一次完整窄范围 reconciliation 重试；第二次
仍变化或任何非 race 错误保持显式失败，cursor 维持 `pendingUpload`。新增独立回归覆盖一次恢复、连续
失败不 ACK、非 race 不重试。该 collector runtime 和直接支持测试变更使此前完整门禁与人工安全审阅
失效，必须从零完成本节后才能进行 T07 有状态补偿、T09、T10、提交或 PR。

2026-07-26 重新打开原因：T07 的真实 `/api/v1/ingest/check` 对账遇到 TLS
`ECONNRESET`，并观察到后台 hook 在 HTTPS 请求阶段可持续持有同步锁。collector 上传层此前有
重试但没有单请求 deadline，无法在半开连接或无响应 JSON body 下保证释放锁。已新增请求与
response JSON parsing 均受 deadline 约束的确定性回归，并将超时接入现有三次重试；这改变了
collector runtime 和直接支持测试，故此前门禁与人工审阅仅为历史证据。当前已重新通过 workspace
测试、typecheck、skill scripts、production build、high-severity audit 以及离线 D1 schema
契约；最终 diff 人工安全审阅已完成，未确认 security finding，详见
`docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md` 的 2026-07-26 addendum。当前可恢复
T07 的有状态补偿；T09、T10、提交和 PR 仍未完成。

本轮先收集并核验 Web/D1 审计结论；如确认问题，先完成最小修复和定向回归，再冻结 diff 并重新
执行本节全部门禁。

2026-07-22 状态更新：Codex hook 多 profile cursor 的源码和直接支持测试在上一轮完整门禁后
发生变更，因此 2026-07-21 的完整门禁与 security scan 仅保留为历史证据，不可用于当前候选。
本轮已通过 collector `47` 文件、`448` 用例、collector typecheck 和基线 diff check；待当前
diff 冻结后，仍须完整执行本节列出的 workspace、skill、build、audit、migration/schema 和
diff-scoped security 门禁。

2026-07-23 历史门禁：全量 `pnpm test` 通过（usage-core `9`、collector `476`、Web `576`，
共 `1,061`）；`pnpm typecheck`、skill scripts `350/350`、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check` 均通过。Web/D1 定向回归为 `8` 个
文件、`121` 条用例，collector 关键回归为 `12` 个文件、`171` 条用例，Codex scoped session
边界回归为 `3` 个文件、`35` 条用例，新增 bounded fallback 回归为 `7` 个文件、`50` 条用例。
用户明确禁止使用 `codex-security` 插件，因此未调用该插件；已完成最终 diff 的人工安全审阅，
对该 fallback 确认其不新增网络、权限或未受限路径读取，且无 scope 时显式失败，未确认 security
finding，记录见
`docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md`。此记录只说明本机门禁，不构成
部署、迁移、认证页面或真实 collector ingest 的成功证据；随后发生的 Codex JSONL 运行时代码和
直接支持测试变动已使本记录失效，必须从零重跑本节全部门禁及人工安全审阅；T07、T09 与 T10
仍未完成。

2026-07-23 当前冻结候选门禁：本机 Codex 预检暴露了超过旧 8 MiB 上限的 child session 后，
`codex-subagent-usage-json.ts` 改为字节级流式切行，`codex-subagent-usage-child.ts` 使用 4 GiB
总文件上限、1 MiB 单行上限与明确 event 上限。全量 `pnpm test` 通过（usage-core `9`、collector
`482`、Web `576`，共 `1,067`）；`pnpm typecheck`、skill scripts `350/350`、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check` 均通过。Web/D1 定向回归为 `8` 文件、
`121` 用例；collector 定向回归为 `10` 文件、`163` 用例。用户禁止 `codex-security` 插件，
因此按当前 83 个已跟踪差异及 29 个未跟踪直接支持文件完成手工 diff 审阅；未确认 security
finding，威胁模型、攻击路径、范围、验证和失效条件均记录于
`docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md`。该证据只允许进入 T07；任何后续源码
或直接支持测试变动都会再次使 T08 失效。

2026-07-24 重新打开原因：T07 的真实 Codex `--until` preview 复现了 canonical attribution 将有界
session 归属到窗口外日期的风险。已新增失败回归并修复为“canonical 日期仅在请求 window 内才覆盖
bounded 行日期”，定向 Codex 13 文件、132 用例及 collector typecheck 通过。该源码和直接支持测试
变化使上段所有完整门禁与人工安全审阅失效；在重新执行本节全部命令和最终人工审阅前，不得运行任何
有状态补偿、部署、提交或 PR。

2026-07-24 当前冻结候选门禁：重新运行 `pnpm test`，usage-core `9`、collector `488`、Web
`576`，共 `1,073` 用例通过；`pnpm typecheck`、skill scripts `350/350`、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check` 均通过。文件级 Web/D1 定向回归为
`16` 文件、`195` 用例，覆盖 migration、critical schema、device reconnect、CSV 和费用可用性；
将全部 migration 应用到内存 SQLite 后，`verify-critical-schema.sql` 通过。文件级 collector
定向回归为 Codex `11` 文件、`121` 用例和 Antigravity `11` 文件、`118` 用例。一次把两个
package-level collector test 命令并行启动的试验因两个完整测试池竞争 CPU 导致大规模 JSONL
边界用例超过默认 5 秒；随后同一用例单独约 `1.1` 秒通过，且上述文件级顺序执行通过，因此不构成
运行时代码失败。已对当前 `83` 个 tracked changes 和 `29` 个 untracked supporting files 完成人工
安全审阅，特别复查 Codex 有界 canonical 日期窗口、路径 containment、JSONL 内存边界、D1 条件写、
hook/statusline 子进程和无秘密输出；未确认 security finding，记录已更新至
`docs/reviews/CR-T08-MANUAL-DIFF-SECURITY-2026-07-23.md`。用户禁止 `codex-security` 插件，
未调用该插件。此完成仅解除 T07 的受控本机核验，不构成部署、迁移、认证页面或 ingest 已成功。

2026-07-24 重新打开原因：T07-R1/R2 修改了 Antigravity language-server readiness 和 response
size boundary，并补充直接支持测试；此前完整门禁和人工安全审阅只保留为历史证据。必须在当前
diff 冻结后重新运行本节全部命令和手工 diff 安全审阅，才能继续 T07 的有状态补偿、最终 hash 对账、
真实 scheduled run、T09 或 T10。

2026-07-24 最新变更：复核发现 metadata response size limit 和 invalid JSON 曾被错误归为可选
language-server unavailable。现已改为 fatal metadata failure，并增加 byte/item/total-event 三类
limit 与 invalid JSON 的 provider/CLI 回归；partial DB snapshots 上传后仍返回 exit 1。该源码和
直接支持测试变更再次使先前完整门禁与人工安全审阅失效，必须在当前 diff 冻结后从零执行本节门禁和
手工审阅。

2026-07-24 重新打开原因：Codex 与 Claude 共用的 hook session JSONL 读取器此前会在单行超过
1 MiB 时直接失败，即使该行只含不参与计量的大内容。现已改为有界字节流和 JSON 结构扫描：仅已知
非计量记录可在未发现解析器实际使用的 token/usage metric 路径时跳过；真实 token、cost 或 usage
metric 仍显式失败且不提交 cursor。Codex 和 Claude 端到端回归覆盖跳过后的 cursor 推进、后段
metric、未知记录类型、64 MiB 丢弃上限以及内容字符串伪装 metric。结构扫描器还拒绝超限行中的
尾逗号等无效 JSON，而不会将损坏记录当作可跳过内容。定向 `6` 个 collector 测试文件、`83` 条
用例、collector typecheck 和基线 diff check 已通过；这些证据不能替代下列完整门禁。

内容：在所有代码变更冻结前执行当前 worktree 的完整质量、迁移和安全门禁。

- 运行 `pnpm test`、`pnpm typecheck`、`node --test skills/tokenboard/scripts/*.test.mjs`、
  `pnpm build`、`pnpm audit --audit-level=high`、
  `git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`。
- 针对 collector、D1 migration、critical schema、device reconnect、CSV/public/notification
  cost availability 和本轮新增文件运行最小充分的定向回归。
- 用户明确禁止使用 `codex-security` 插件，改为对最终源码、直接支持测试和迁移执行人工
  diff-scoped security review，记录范围、候选、排除证据和限制。任何确认 security finding 必须
  修复并重新审阅；历史插件扫描不能作为本轮 final result。
- 复核所有文档与 task 状态，确认“已完成”只表示对应验收已实际执行，最终发布证据仅在 T10
  后记录。

验收标准：所有命令退出码为零，或有明确的环境外阻断和不发布结论；无未解释 warning、
format error、类型错误、high audit finding、迁移契约失败或安全 finding。

审查要求：检查测试没有跳过关键路径、audit 无被临时 ignore 的高危依赖、人工审阅范围包含本轮
最后一次源码/支持测试变更，并明确记录未使用插件的限制。

历史完成证据（2026-07-21，已因 2026-07-22 源码和测试变更失效）：冻结 worktree 的完整门禁全部通过：`pnpm test`（usage-core
9/9、collector 409/409、web 576/576）、`pnpm typecheck`、skill scripts `350/350`、
`pnpm build`、`pnpm audit --audit-level=high`、`git diff --check <base>`。collector 的
full-rebuild、replay compaction、history authority、cursor 以及 Web device/migration 定向回归
也均通过。diff-scoped Codex Security scan 对 86 个 worklist 文件逐项完整读取并校验 receipt
SHA-256，冻结摘要为 `codex-security-snapshot/v1:sha256:331ce9b676083f43444f7f452bf9d3100666bc33f16bc9188fe9d0bb64580694`；
0 个 reportable finding，canonical manifest、coverage、findings 和生成的 `report.md` 均已封存于
临时扫描目录。门禁结束后重新计算的 worktree 摘要仍完全相同，故可以进入 T07 的只读本机核验。

上一轮完成证据（2026-07-24，已因随后 Antigravity SQLite 修复失效）：在 `89` 个 tracked path changes
与 `31` 个 untracked supporting files 的冻结候选上，workspace、skill、build、audit、migration/schema
和人工审阅门禁均已通过；其测试计数和定向范围仅作历史记录，不得用来证明当前候选。

2026-07-24 重新打开原因：T07 重启后真实 Antigravity CLI full/bounded 对照发现有界 SQLite
扫描会因旧 DB/WAL mtime 跳过未处理数据库，从而低估近月 daily-model。已修改
`antigravity-history-db.ts` 的候选过滤，并新增直接支持测试；该运行时代码和测试变更使上段完整
门禁、人工安全审阅和后续补偿前置条件再次失效。当前仅有定向 collector 验证和真实 preview sweep
证据；必须在 diff 冻结后从零重跑本节完整门禁和最终人工审阅。

当前完成证据（2026-07-24）：在当前 `89` 个 tracked path changes 与 `31` 个 untracked supporting
files 的冻结候选上，修复了 SQLite metadata row index 的宽松前缀解析，并新增其失败回归；同时保留了
旧 mtime 但未处理数据库仍可进入 bounded scan 的回归。完整 `pnpm test` 通过，usage-core `9`、
collector `515`、Web `578`，共 `1,102` 条用例；`pnpm typecheck`、skill scripts `350/350`、
`pnpm build`、`pnpm audit --audit-level=high` 和基线 `git diff --check` 均通过。Web/D1 定向回归为
`14` 个文件、`165` 条用例，collector 定向回归为 `31` 个文件、`389` 条用例，覆盖 D1 migration、
critical schema、reconnect pairing、费用可用性，以及 Codex scoped/bounded 路径和 Antigravity CLI
rebuild、bounded old-mtime discovery、strict row parsing、GUI/IDE limits。所有 migration 按顺序应用到
SQLite `:memory:` 后，`verify-critical-schema.sql` 与 `PRAGMA foreign_key_check` 均无输出。最终人工
diff 安全审阅已按 Web/D1、collector、skill、dependency、migration、测试和文档边界完成，并对最新
SQLite candidate/filter/parser 路径复读；未确认 security finding。用户明确禁止 `codex-security`
插件，因此未调用；额外高置信凭证标记检查只输出状态且通过。上述门禁完成后仅更新本审阅记录和
台账，未再改变运行时代码或直接支持测试。T07 可恢复为受控本机核验，但补偿 sync、T09 和 T10
仍未完成。

2026-07-25 重新打开原因：T07-R3 新增了 collector Git worktree 的升级前置检查及直接支持测试。
此前的全量门禁和人工安全审阅只保留为历史证据；在冻结当前 diff 后必须从零重跑本节全部命令并
重新审阅，之后才可继续有状态的 scheduled sync 验证、T09、T10、提交或 PR。

2026-07-25 补充修复：Hook session JSONL 扫描先记录文件 fingerprint、稍后才由 parser 打开路径；
若路径在两者之间被同尺寸替换、改为 symbolic link，或 consumer 在完整验证前停止读取，旧实现可能
把未证明的扫描状态提交为 cursor。现在读取使用同一已验证 file descriptor，对扫描时固定 byte range
重新计算完整 hash，并在任何 identity/content/read-completion 失败后拒绝 cursor commit；同 inode 的
追加仍只读取扫描时捕获的范围，留给后续增量扫描处理。新增确定性回归覆盖同尺寸 replace、symbolic
link replace、提前停止消费和无 cursor 落盘。验证通过：collector `56` 文件、`545` 用例，collector
typecheck，以及基线 `git diff --check`。该运行时代码和直接支持测试变更使此前 T08 全量门禁、手工
diff security review、T07 有状态同步、T09、T10、提交和 PR 再次失效；必须在当前 diff 冻结后从零完成
后续 gate，不能将本条定向验证表述为最终发布证据。

历史完成证据（2026-07-24，已因后续 JSONL 文件身份验证修复失效）：在 T07-R3 的 dirty-worktree upgrade preflight、`ccusage` 20.0.18
和高危依赖 override 均已纳入当前候选后，重新顺序运行完整门禁：`pnpm test` 通过（usage-core
`9`、collector `515`、Web `578`，共 `1,102` 条）；`pnpm typecheck` 通过；skill scripts
`352/352` 通过；`pnpm build` 通过；`pnpm audit --audit-level=high` 报告无已知漏洞；
`git diff --check <base>` 通过。Web/D1 定向回归为 `8` 个文件、`123` 条用例，覆盖两份 migration、
critical schema、reconnect pairing 和设备页；collector 定向回归为 `17` 个文件、`174` 条用例，覆盖
Antigravity rebuild/history/limits 和 Codex bounded attribution、路径、cache、multi-profile。
所有 migration 按名称顺序应用到临时 SQLite 数据库后，`verify-critical-schema.sql` 和
`PRAGMA foreign_key_check` 均无输出。当前 manual diff review 覆盖 `91` 个 tracked path changes
和 `31` 个 untracked supporting files；高置信凭证标记检查为零命中，未确认 security finding。用户
明确禁止 `codex-security` 插件，未调用该插件。Node 24 对 `@tailwindcss/node` 4.2.4 的
`module.register()` 输出弃用警告；trace 已定位为 Vite 测试配置加载链，非本次业务代码、无失败或
静默降级，且不作为部署成功证据。此完成仅允许恢复 T07 的受控本机核验；T09、T10、提交和 PR
仍未完成。

当前完成证据（2026-07-25）：在最后一处 Codex child-session JSONL 文件身份验证修复及其直接
支持回归后，顺序执行完整本地门禁：`pnpm test` 通过（usage-core `9`、collector `548`、Web
`578`，共 `1,135` 条）；`pnpm typecheck` 通过；skill scripts `352/352` 通过；`pnpm build`
通过；`pnpm audit --audit-level=high` 报告无已知漏洞；基线
`git diff --check c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 通过。Web/D1 定向回归为 `8` 个文件、
`123` 条用例，覆盖 `0028`、`0029`、critical schema、条件 reconnect 写入、pair route 与设备页。
最终人工 diff 安全审阅覆盖 `92` 个 tracked path changes 和 `36` 个 untracked supporting files；
高置信凭证标记检查为零命中，未确认 security finding。用户明确禁止 `codex-security` 插件，
因此未调用。最终 JSONL 回归覆盖同尺寸原子替换、符号链接替换、提前消费停止、非法 UTF-8、超大
文件、超大行和事件上限；任何读取不完整或身份变化都会拒绝 cursor/cache commit。上述证据只解除
T07 的受控本机核验，不构成私人 Cloudflare 部署、认证页面或真实 ingest 成功证据。

2026-07-25 重新打开原因：本机 status CLI 检查发现 `hookStatus()` 的内部 `notifyPath` 会随嵌套
hook 状态原样输出。现已将 status 输出改为固定 hook 状态白名单，并增加路径与未知字段均不能进入
JSON 的回归。该脚本源码和直接支持测试变更使上述完整门禁及人工安全审阅失效；必须在当前候选冻结后
重新执行本节全部门禁和人工审阅，才能继续 T07 的有状态补偿、T09、T10、提交或 PR。

2026-07-25 补充修复：status hook 白名单初版遗漏了 Antigravity GUI/IDE 合法的
`installed-local-history` 状态，导致实际本机状态被错误显示为 `unknown`。现已新增失败回归并将该
固定状态纳入白名单，路径和未知嵌套字段仍不进入公开 JSON。该运行时代码和直接支持测试变化再次使
上述完整门禁与人工审阅失效；必须在当前候选冻结后重新执行本节全部门禁和人工审阅，之后才可继续
T07、T09、T10、提交或 PR。

2026-07-25 当前完成证据：对 trailing notifier 的 `trailing.lock` PID 发布竞态新增了完整文件
临时写入后原子 rename 的协议。取得锁仍使用 `wx` 父进程占位，child PID 只通过完整 JSON 的原子
替换发布；无 PID、发布或清理失败均显式报错并沿用 ownership-checked cleanup。内存并发回归证明
发布期间不会把半写 JSON 暴露给读取者，真实 detached handler 回归在锁交接窗口连续解析锁文件，
每次均得到有效 PID。最终顺序执行 `pnpm test`（usage-core `9`、collector `552`、Web `578`，
共 `1,139`）、`pnpm typecheck`、skill scripts `353/353`、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check`，均通过。全部 `0000` 至 `0029`
migration 已按名称顺序应用到 SQLite `:memory:`，`verify-critical-schema.sql` 与
`PRAGMA foreign_key_check` 均无输出。最终人工 diff 安全审阅覆盖当前 `94` 个 tracked path
changes 与 `36` 个 untracked supporting files；无内容凭证标记检查为 clear，未确认 security finding。
用户明确禁止 `codex-security` 插件，因此未调用。该完成仅解除 T07 的受控本机核验；T09、T10、
上游整合、部署、提交和 PR 仍未完成。

2026-07-25 重新打开原因：本机近月 Codex preview 的 frozen scope 在 APFS 上需要使用原生
`clonefile(2)`，以避免对每个 history 文件启动一次 Ruby。新增受限的 scope-local helper、明确 fallback
边界和 source disappearance 回归后，之前的完整门禁和人工安全审阅均只保留为历史证据。当前必须在
diff 冻结后从零运行本节全部命令和人工审阅，才能继续 T07 的有状态补偿、T09、T10、提交或 PR。

2026-07-25 当前完成证据：macOS Codex frozen scope 现每个 scope 只运行一个短生命周期的
`/usr/bin/ruby` `clonefile(2)` helper；请求和响应是有上界的 JSONL 协议，helper 仅在复制期间存活。
人工复核发现并修复了 helper 已异常退出但 cleanup 曾静默返回的失败路径，现会完成关闭并返回原始诊断；
直接 regression 覆盖 malformed response、晚到异常退出、helper close、权限拒绝、明确不支持的 fallback、
源端消失与目标端 `ENOENT`。完整 `pnpm test` 通过（usage-core `9`、collector `562`、Web `578`，
共 `1,149`）；`pnpm typecheck`、skill scripts `353/353`、`pnpm build`、
`pnpm audit --audit-level=high` 和基线 `git diff --check` 均通过。Web/D1 重点回归为 `8` 文件、
`123` 用例；所有 `0000` 至 `0029` migration 按名称顺序应用到 SQLite `:memory:` 后，critical schema
与 `PRAGMA foreign_key_check` 均无输出。人工 diff-scoped security review 覆盖 `95` 个 tracked path
changes（含 `4` 个删除）和 `38` 个 untracked supporting files；tracked/untracked 无内容凭证标记检查均为
clear，未确认 security finding。用户明确禁止 `codex-security` 插件，未调用。Web focused test 的
`module.register()` 弃用提示来自既有 Vite/Tailwind 工具链，未构成代码或门禁失败。上述证据解除 T07
受控本机核验前置条件，但不构成已部署、认证页面或真实 ingest 成功证据。

2026-07-27 当前冻结候选完成证据：在上一轮完整门禁后，Codex 单 profile 从旧
`CODEX_HOME` 切换到新 profile 且相对 session 路径相同时，legacy pending cursor 原本可能被新
profile 覆盖并在 ACK 后永久丢失。现以不可逆 profile hash 标记 hook cursor；同 profile 保留 legacy
cursor，未标记、profile 不匹配或多 profile 情况进入显式迁移，不能归属的 pending entry 独立保留并
上传/ACK。该 P1 已先以失败回归复现并修复。最终冻结候选相对
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 包含 `97` 个 tracked path changes（`93` 个修改、
`4` 个删除）和 `44` 个 untracked supporting paths。完整 `pnpm test` 通过（usage-core `9`、
collector `578`、Web `578`，共 `1,165` 条）；`pnpm typecheck`、skill scripts `353/353`、
`pnpm build`、`pnpm audit --audit-level=high` 与基线 `git diff --check` 均通过。Web/D1 定向回归为
`8` 文件、`123` 条用例；collector 定向回归为 `10` 文件、`162` 条用例，覆盖新的 Codex profile
迁移/ACK、hook pending、Antigravity rebuild/compaction/limits 与 upload deadline。全部 migration
`0000` 至 `0029` 已按名称顺序应用到临时 SQLite；`verify-critical-schema.sql` 与
`PRAGMA foreign_key_check` 均无输出。最终人工 diff 审阅覆盖 Web/D1 条件写和 migration、collector
的有界文件读取/游标/上传路径、Antigravity 三类来源、hook/statusline/lock/upgrade 失败传播、依赖
覆盖和所有直接支持文件；未确认 security、数据正确性、兼容性或可靠性 finding。无内容高置信凭证
标记扫描覆盖 `137` 个路径，零命中。用户明确禁止 `codex-security` 插件，因此未调用该插件。本条只
解除 T07 的受控本机核验前置条件；T09、T10、部署、提交、推送和 PR 仍未完成。

2026-07-27 T07 最终运行态与对账证据：前述五来源隔离 preview、服务端 key/hash 对账、最小补偿
同步和 LaunchAgent 手工触发均已在当前冻结候选上完成。补偿后共 `174` 个 key 中 `172` 个一致、
`2` 个不一致、`0` 个缺失；仅剩两个均属于当天仍在写入的 Codex 活跃会话，单日对账的
`nonTodayDifference=0`，所有已关闭历史日期一致。补偿动作分别为 Antigravity CLI
`0 upsert/25 skipped`、Claude Code `1 upsert/38 skipped`、Codex `103 upsert/3 skipped`，均以
exit `0` 返回。

随后真实 LaunchAgent/notify 触发完成 `3` 次，最新一次 Codex hook 运行于
`2026-07-27T13:33:49+08:00` 至 `13:35:11+08:00`，`last-run.json` 状态为 `success`、exit `0`，
无 follow-up；本次结束后正式 `trailing.lock`、`sync.lock` 和 TokenBoard 后台同步进程均为 `0`。
错误日志保留了更早一次并发 `sync.lock` 等待超时，以及 Codex 子代理校正超过 session 行的既有
非致命诊断；这些记录不属于最新运行，最新运行的末尾没有新增 timeout/source failure。T07 的
客户端、hook、计划任务、锁释放、最近一个月数据覆盖和 hash 一致性验收全部完成；普通
Antigravity 与 Antigravity IDE 的 bounded language-server 路径已在 R1/R2 记录真实成功证据。
本条只解除 T09 的只读复核前置条件；T10、部署、提交、推送和 PR 仍未完成。

补充运行证据（2026-07-27）：在当前冻结候选上手工触发
`com.tokenboard.daily-sync` 的全来源 LaunchAgent。运行结束后 `launchctl print` 显示 job 已停止、
`runs = 5`、`last exit code = 0`；正式 `sync.lock`、`collector-run.lock` 与 `trailing.lock` 均不存在。
该计划任务证据与 hook 的 `last-run.json` 分开核验，未输出配置、凭证或原始 usage 内容。

2026-07-28 当前重新打开说明：上述 T07 运行态与 hash 对账保留为历史证据，但其后 collector 又修复了
严格 `TOKENBOARD_FAIL_ON_SOURCE_ERROR` 语义、Codex attribution cache 的可选预热写入竞态、bounded
canonical attribution 短暂缺行重试，以及 Antigravity SQLite 全量扫描目录变化的显式失败路径。由于这些
运行时代码和直接支持测试均在此前本机验收后变化，T07 必须用当前冻结候选重新检查 status、hook、
LaunchAgent、锁、五来源 preview 和近月服务端 hash 对账；在该验证完成前，不将历史补偿同步或计划任务
结果视为当前候选成功证据。

2026-07-28 当前 T08 重新门禁：相对
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 的候选仍为 `109` 个已跟踪路径变更和 `49` 个未跟踪直接
支持文件。本次完整 workspace 门禁通过：`pnpm test` 为 usage-core `9/9`、collector `628/628`、Web
`580/580`，共 `1,217` 条；`pnpm typecheck`、`node --test skills/tokenboard/scripts/*.test.mjs`
（`362/362`）、`pnpm build`、`pnpm audit --audit-level=high` 及基线 `git diff --check` 均成功。Web/D1
focused migration/schema 契约为 `35/35`，包括 seed cleanup 的 immediate/deferred foreign-key、
pairing-code index 和 critical schema。高置信凭证标记扫描仅检查当前存在的 tracked 新增/修改路径及
未跟踪支持文件，结果为零命中；四个删除路径不参与内容扫描。

人工复核重新检查了 CLI/Windows command shim、Codex cache 与 bounded attribution、Antigravity SQLite
scan/error mapping，以及 token rotation 成功提示的 live-region 边界。hook timezone Windows 命令注入
观察不成立：CLI 在读取 flag/env 后校验 IANA timezone，默认 runner 对 `.cmd`/`.bat` 还会拒绝任意
shell 元字符；对应 CLI 与 command 回归及 collector 全量回归均通过。用户禁止 `codex-security` 插件，
故未调用。CodeRabbit 的历史 agent 调用没有产生当前候选的最终文本结果，不能计作审查覆盖；OMP 按用户
指示跳过。此文档更新不改变运行时代码；T08 当前门禁完成，T07 重新执行后才能开始 T09 最终只读复核。

## T09 Independent Read-Only Review

状态：已完成

内容：差异冻结后进行独立 reviewer 复核。

- Claude Code 使用用户现有默认配置，仅只读审查相对基线的差异，不修改其配置、不限制用户
  指定的时间或 token 预算。
- OMP 当前按用户明确指示暂不可用，本轮跳过，不等待、不重试、不修改用户 CLI 配置或默认模型；
  该审查面明确记为未覆盖，不能作为通过证据。
- CodeRabbit 只在服务可用时运行；429、初始化失败、空输出或无最终结果明确记录为不可用，
  不能无限等待或当作通过。
- 每条 finding 必须回到精确文件、调用链和确定性测试确认；confirmed finding 进入新的原子
  修复，之后重新运行受影响门禁与必要的独立复核。

验收标准：Claude 有最终文本结果；OMP 有明确的用户指示跳过记录且不计为通过；所有 confirmed
finding 已修复且重新验证，没有未决 P1/P2 行为、安全、数据或兼容性问题。

审查要求：外部 reviewer 结论只作为线索，不能凭模型结论修改代码或标记完成；需排除过期
finding、基线外代码和测试 fixture 假阳性。

2026-07-27 T09 本地核验收据：review finding 中的 macOS clone helper timeout 和异步 `ENOENT`
fallback 已由 `codex-session-cloner` 与 scope race 回归覆盖；Codex cache、stream max-bytes、ACK
timezone、metadata scanner、bounded attribution 和 comma-home 兼容性均已有定向回归。本轮确认并修复
caller-supplied session-root symlink 兼容性、D1 seed cleanup 的 FK ON immediate/deferred 契约、
Codex-only fail-fast mock、Windows-safe cursor key 断言和文档漂移。所有本轮定向测试均通过，但当前
diff 尚未重新冻结，因此 T09 保持进行中，等待 T08/T07 重验后再执行最终 Claude/OMP 只读复核。

2026-07-27 补充：Claude 的上一轮只读收据已逐项回到 D1 transaction、collector 调用链和现有
回归核验。其关于 D1 `batch()` 非原子性的判断与 Cloudflare D1 transaction contract 和现有
rollback contract 测试不符；其余未确认项要么不在生产调用链、要么由已验证的安全整数、范围或
cursor 约束覆盖，均未形成新的 confirmed finding。OMP 按用户明确指示暂不可用而跳过，不等待、
不修改 OMP 配置，也不将其缺席表述为通过。当前差异重新冻结并完成 T08/T07 后，仅需重新取得
Claude 的最终只读结果；OMP 保留为明确未覆盖记录。

2026-07-27 历史独立审查：使用本机既有 Claude Code `2.1.216` 配置，以
`c43b67c2366e8e842ce21e40d89cdc2aba4e8aea` 为基线对当前 tracked、unstaged 与直接支持的
untracked diff 做只读审查；未发现可确认的 P1/P2 行为、数据正确性、安全、隐私、兼容性、D1
migration、collector、hook、schedule 或 deploy regression。审查明确保留的外部边界是私人 D1
migration、更新后 Worker 的真实 ingest、认证页面和本机文件系统/语言服务器运行态，均由 T10
实际验证。OMP 按用户最新指示跳过，未等待、未重试、未改配置，也不记为通过。CodeRabbit 本轮
`--agent` 审查已连接服务但持续无最终输出，主动停止后 `findings` 仅返回旧缓存，故记录为未覆盖；
未将缓存 finding 当作当前结论。该结果在 2026-07-28 当前候选变更后仅保留为历史证据；新的
Claude 只读复核须在 T08/T07 当前证据完成后重新执行。OMP 按用户指示跳过，明确记录为未覆盖。

2026-07-28 collector 审阅补充：审阅器提出 hook 模式下 timezone 可能进入 Windows `.cmd` shell
参数。沿生产调用链复核后未确认：CLI 在读取 flag/env 后先执行 IANA timezone 校验，只有该 CLI
调用 collector provider；即使未来有未校验值进入默认 command runner，Windows `.cmd`/`.bat` 路径
还会拒绝 command 和全部参数中的 shell 元字符。`command.test.ts` 与 `cli-timezone.test.ts` 以及
当前 collector 全量 `623` 条回归均通过，因此不引入重复的 provider 分支或无依据的兼容性改动。

2026-07-28 最终复核：Claude Code `2.1.216` 使用用户现有默认配置和只读 plan 模式，对相对基线的
tracked、unstaged 与直接支持的 untracked 差异完成审阅，最终输出 `NO_FINDINGS`，没有可复现的 P1/P2。
Claude 结论后的两处 packages 测试维护不改变运行时代码：CodeRabbit 的首次 packages 审查确认两处
Codex session scope 测试在断言失败时没有释放临时 scope，已改为 `try/finally`；第二次 packages
审查确认 Antigravity history DB 回归应显式断言 `Map.size`，已修正。两项修复后
`pnpm --filter @tokenboard/collector test -- src/providers/codex-session-scope.test.ts
src/providers/antigravity-history-db.test.ts` 完整 collector suite 为 `65/65` 文件、`628/628` 用例通过。
CodeRabbit 仅覆盖 packages 分目录，不能替代 Claude 的全量只读结论；OMP 继续按用户明确指示跳过，
作为未覆盖面记录而非通过证据。当前没有未处理的独立复核 finding。

## T10 Private Cloudflare Deployment Commit And PR

状态：进行中

内容：仅在 T01 至 T09 完成后，对用户私人 Cloudflare 执行 guarded deploy，随后提交、
推送并建立或更新中文 PR。

- 使用私有 Wrangler 配置和 guarded deploy helper；部署前创建 D1 Time Travel restore point，
  记录 restore/version 标识但不输出秘密。
- 只允许该次人工、受 guard 保护的私人 Cloudflare 验证；不得启用、恢复或修改 Cloudflare
  Workers Builds、GitHub Actions 或其他自动 CI/CD，也不得向上游生产环境部署。
- 执行全部待处理 D1 migration 与 `verify-critical-schema.sql`，验证 migration 次序、关键
  identity/device/upload-token schema 和 seed cleanup 行为。
- 发布 Worker 后验证 `/api/v1/health`、匿名边界、认证后的 `/dashboard/details` 和
  `/settings/devices`、静态资源、AJAX navigation、页面复制控件、真实已配对 collector ingest，
  以及 D1 `last_synced_at`/`last_used_at` 的推进。
- 任何 migration、deploy、health、认证、ingest 或数据验证失败时停止发布，使用 D1 restore
  point 和 Worker version 回滚；本地 build/test 不能代替真实部署通过。
- 最后检查差异边界，按逻辑拆分原子 Conventional Commit 风格提交，推送当前分支，创建或更新
  中文 PR。PR 必须说明问题、改动范围、迁移前置条件、逐步部署顺序、验证命令和结果、回滚、
  风险边界、旧 client 兼容性，以及 UI 截图或真实浏览器证据；不得含任何秘密。

验收标准：私人 Cloudflare 的真实 D1 migration、critical schema、health、认证页面、collector
上传和同步字段均通过；所有提交已推送；PR 中文描述完整且可由维护者按步骤安全执行和回滚。

审查要求：部署前后核对所用 Worker/D1 环境、迁移状态和 collector server origin；确保不会把
上游生产环境或历史私有部署误认作当前候选的验证对象。

2026-07-27 当前 T10 远端实证：仅使用用户私人 Wrangler 配置执行了配置检查、远端 D1 migration
列表、critical schema 与 `PRAGMA foreign_key_check` 查询。migration 列表明确为无待执行项，schema
与 FK 查询均成功且没有返回违例。当前 Worker health、首页和 HTML 引用的两份 JS/CSS 资源均返回
成功；匿名 `/api/v1/me` 与 `/api/v1/ingest/check` 保持 `UNAUTHORIZED`，受保护的详情和设备页面
均重定向至登录页。未操作上游生产、Workers Builds、GitHub Actions 或任何自动部署。

使用一份已保存但未激活的旧兼容 profile，以临时 `TOKENBOARD_STATE_DIR` 运行
`antigravity-cli --since all` 的真实上传。collector 正常退出，服务端幂等跳过既有快照，同时该
profile 对应 upload token 的最近使用时间和设备最近同步时间均在上传后推进；临时状态目录已删除，
没有重配对、改动 active profile 或输出凭据、设备标识、原始 usage。当前 Chrome 尚未有该私人站点
的登录态，认证后的 `/dashboard/details`、`/settings/devices`、页面复制控件与 AJAX navigation
验收仍待用户完成 GitHub 登录后继续；在此之前 T10 和最终提交/PR 保持进行中。

2026-07-28 认证浏览器验收完成：维护者在隔离的可见浏览器会话中自行完成 GitHub OAuth，未导出
账号、cookie、设备标识、凭证、命令内容或剪贴板数据。认证后控制台显示已登录导航；
`/dashboard/details` 与 `/settings/devices` 在桌面和 390 px 宽度均正常渲染、无错误状态且没有横向
溢出。设备页的可见详情入口发起认证 fragment 请求并收到 HTTP 200，随后成功填充可关闭的详情对话框。
`/settings/install` 显示六个具名复制控件；未生成一次性配对提示词时，复制非敏感 notifier-hook
命令得到“已复制”状态和可访问的成功提示。匿名首页和排行榜的桌面及移动布局也无横向溢出，排行榜
切换到月度 token 使用 fragment 请求并同步更新 URL 和标题。

私人 D1/schema、匿名边界、认证页面、client navigation、复制控件和真实 collector ingest 的部署
验收现已齐全。T10 仍为进行中，仅因尚需完成差异复核、原子提交、推送分支和中文 PR；不得将本段
浏览器证据误写为已提交或已发布 PR。

## Final Acceptance

- `T01` 至 `T10` 的状态全部为“已完成”，且每项验收结果来自当前 worktree 与当前环境。
- 不存在已确认但未修复的行为、安全、迁移、兼容性、性能或数据正确性问题。
- 当前分支通过全量质量门禁、安全扫描和两套独立复核；不可用的外部审查明确标为未覆盖。
- 私人 Cloudflare 的真实部署、D1 migration 和现有 collector 数据上传已验证；失败时有已验证
  的 restore point/Worker version 回滚路径。
- 最终差异边界干净，原子提交已推送，中文 PR 具备完整执行与回滚说明且不含秘密。
