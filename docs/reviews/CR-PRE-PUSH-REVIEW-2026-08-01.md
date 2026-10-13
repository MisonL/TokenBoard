# TokenBoard 发布前复核记录

日期：2026-08-05（2026-10-13 精简版：2026-08-02 至 2026-08-05 的 10 轮逐项修复快照已折叠为缺陷清单与最终门禁；完整记录见 git 历史）

## 范围

- 分支：`fix/post-merge-reliability-followups-ui`
- 基线：`upstream/master`
- 2026-08-01 首次快照：15 个跟踪代码/测试文件未提交修改 + 1 个未跟踪审查记录；未提交、未推送、未部署

## 本轮修复（汇总）

scheduled retry 锁与状态：

- 保留按 source 隔离的 scheduled retry 锁和状态文件；旧版固定路径活动锁增加兼容保护，避免升级期间并发运行。
- 修复不同 Node 进程争抢同一 legacy 锁导致第二来源被跳过：固定 legacy 路径改为目录栅栏，目录内按进程写独立 marker（PID + 进程启动身份），过渡锁保护 marker 增删，最后一个 marker 释放后恢复固定文件路径兼容旧版本。
- 进程启动身份按平台绑定：Linux 用 `/proc` boot ID + 启动 tick，macOS 用 `libproc` 微秒级 `proc_pidinfo`，Windows 用 PowerShell 进程创建时间（`-ErrorAction Stop`，仅明确的进程不存在错误映射为 dead）；身份探测失败保持占用，不生成可比较的 fallback 值，损坏 marker 保留原位报 `TOKENBOARD_LEGACY_RETRY_FENCE_CORRUPTED`，不误删活动 marker。
- marker 清理竞争修复：transition 锁竞争失败时保留可重试的待清理状态；已退出进程的 marker 在下一次准备阶段回收。
- status 状态优先级：来源专属状态文件损坏时保持 `invalid` 为权威结果，不被有效的 legacy 状态覆盖；仅在不存在或来源不匹配时回退；直接区分「不存在」与「读取异常」。
- 修复同 PID 无身份 marker 误判陈旧、Windows 路径分隔符断言遗漏嵌套 marker、活动 legacy-lock 回归未真正进入 legacy fence 分支等问题。

notifier 与 hook：

- notifier 的 trailing/dispatch 锁清理失败影响最终退出码；生成 hook 在主 dispatch 锁释放异常时继续清理 token 级 worker 标记。
- 生成 `notify.cjs` 固定安装时 Node 路径的问题：Unix 运行时改用当前 `process.execPath`，Windows 保留安装时绝对路径。
- 生成 hook 的错误日志统一脱敏执行路径，避免本地诊断文件暴露命令路径。

依赖：

- `brace-expansion` override 5.0.8→5.0.9、`miniflare` 的 `undici` 7.28.0→7.29.0、Hono 提升到已修复 ReDoS 的 4.13.0 并在 Web manifest 固定最低版本 `^4.13.0`。

Codex：

- 修复 bounded Codex canonical attribution 的 live/frozen 文件竞态：canonical 子批次改从同一批已冻结的临时 `CODEX_HOME` 派生并显式映射回原始 source file，不再重读 live 文件。

## 外部复核

- OMP `17.1.8`（`grok-4.5`）多轮只读复核：`NO_FINDINGS`。
- Claude Code `2.1.220`（`deepseek-v4-flash`）只读复核：`NO_FINDINGS`。
- CodeRabbit CLI `0.7.1`：首轮相对基线 `c160d455` 发现 1 个 Windows 进程身份探测缺陷（PowerShell `SilentlyContinue` 把查询错误误判为 PID 不存在），已修复；复核后同基线 `findings: 0`。另一次全量复核 `review_completed`、`findings: 0`。期间多次 `rate_limit` 与无输出均未计为通过证据。

## 最终本地门禁（2026-08-05）

- workspace 测试 usage-core 9、Web 582、collector 655，共 1246/1246 通过。
- skill 脚本测试 460/460 通过；关键脚本 `node --check` 通过。
- `pnpm typecheck`、`pnpm build`、`pnpm audit --audit-level=moderate`（未报告已知中危及以上漏洞）、`pnpm install --frozen-lockfile --offline` 和 `git diff --check` 均通过。
- 本机当前 Node PID 实测 Darwin 原生身份格式为 `darwin:<seconds>:<microseconds>`。

## 复杂度豁免

- `hooks.mjs`（782 行）：`notifyHandlerHelpers` 是生成自包含 CJS hook 的声明式模板，再拆会增加跨模板拼接风险。
- `notify.mjs`（542 行）、`scheduled-retry.mjs`、`upgrade.mjs`：各自覆盖单一锁/状态机/升级事务，拆分会分散原子边界。
- 测试文件豁免：`hooks.test.mjs`（957 行）、`notify.test.mjs`（894 行）、`scheduled-retry.test.mjs`（853 行）为同一模块的跨平台状态机契约测试；`upgrade.test.mjs`（1353 行）超 1000 行强制阈值，明确豁免本次，后续扩展 upgrade 行为时应将 archive fallback 场景迁至独立测试文件。

## 未覆盖边界

- 未证明上游 PR 合并后的生产 Cloudflare、D1、OAuth 和真实多用户数据链路健康。
- 未证明 Windows 实机 tasklist、计划任务和 Node 版本组合的运行结果；相关行为由离线测试覆盖。
- 记录收口时修复与本记录已作为本地独立提交保存，未推送、未部署。
