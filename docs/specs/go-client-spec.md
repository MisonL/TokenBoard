# TokenBoard Go 客户端（clients/go）实施规格

状态：**实施中**（2026-10-15 用户确认方向；M0 契约层与 M1 上传/锁/CLI 已实现并合入 `feat/model-pricing-maintenance`，见 §11）。上游依据：`docs/research/client-binary-zig-gui-research.md`（调研终稿）。
本 spec 是实施契约：实施过程中偏离此处必须先更新本文件。

## 0. 已批准的决策（用户拍板，不重开）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 语言 | **Go**，Web 端（apps/web）留 TS 不动 |
| D2 | 仓库 | **不拆库**：Go client 长期住在 `clients/go/`，无拆仓里程碑 |
| D3 | 依赖策略 | **能用最新就用最新**：依赖跟随 latest，靠「升级门禁」（见 §5）兜底，不做长期 pin |
| D4 | 交付形态 | 单二进制，GoReleaser × 5 平台（darwin/linux/win32 × x64/arm64），免 CGO |
| D5 | ccusage | 捆绑 > 探测 > 下载（fail-closed）；ccusage 是 Rust 静态二进制（npm 平台包分发，MIT，sha512 可 pin） |
| D6 | GUI | 与 CLI 解耦另行立项，不进本 spec |
| D7 | Zig | 不采用 |
| D8 | 前置沟通 | 开工前与上游作者对齐（skill 是上游核心资产，client Go 化改变交付模式） |

## 1. 目标与非目标

**目标**
- `clients/go/` 提供 `tokenboard` 二进制，行为与现有 TS collector（`packages/collector`）等价：preview / sync / warm-hooks / hook 模式，同一 env 契约（`TOKENBOARD_*`）。
- 迁移完成后 TS collector 进入 deprecated，skill 脚本默认 spawn Go 二进制；`perSource` 开关支持逐来源回滚。
- 升级通道从 git-clone 换成 GitHub Releases + `tokenboard self-update`（rename-swap 保留回滚）。

**非目标**
- 不改服务端（Worker/API/D1 schema）；不改上传协议。
- 不替换 ccusage 的解析职责（继续 spawn 其二进制读 Claude Code/Codex 等来源）。
- 不做 GUI；不做自建定价源；不改 hook 语义（含「hook 模式禁联网」纪律）。
- 迁移期不改 TS collector 的行为语义（冻结只收 bugfix，避免影子基线移动）。

## 2. 仓库布局

```
clients/go/
  cmd/tokenboard/main.go            # 入口，极薄
  internal/
    cli/                            # preview/sync/warm-hooks/hook/self-update 子命令（cobra）
    collect/                        # 编排：source 分类、失败语义、exit 75 瞬态契约
      providers/                    # grokbuild/ deepseekharness/ pi/ opencode/
                                    # antigravitycli/ antigravity/ antigravityide/
                                    # claudecode/ codex/
      sessioncursor/                # cursor JSON v1 读写、增量读取（对应 session-cursor*.ts）
      jsonl/ sqlite/ zstd/          # 共享底层
    upload/                         # ingest/check/重试/退避 pause
    pricing/                        # 定价目录 fetch/cache/静态、ccusage override 生成
    contract/                       # UsageSnapshot + 全部 fail-closed 校验（对应 usage-core）
      contract.json                 # 由 packages/usage-core 导出的 JSON Schema（生成类型）
      goldens/                      # 金样本：TS 导出的接受/拒绝+哈希清单
    state/                          # 状态目录、renameAtomic、flock
    platform/                       # launchd/systemd/schtasks、symlink 守卫
    ccusage/                        # 捆绑/探测/下载三层获取器（见 §4）
  testdata/                         # 与 packages/collector 共用语义的 fixture（影子验证输入）
```

## 3. 硬契约（每条都要有专门测试，违反即 bug）

1. **snapshotHashPayload 字节级一致**：SHA-256 输入是键序固定、无空格的规范化 JSON。Go 侧**手工拼键序**，禁止依赖 `encoding/json` 的 map 序列化。金样本覆盖：全字段/缺字段/costUnavailable 来源/unicode 模型名。
2. **cursor JSON v1 双向兼容**：TS 写 → Go 读 → Go 写 → TS 读，内容零差异（含 sha256+mtime+size+offset+pendingUpload、codexHookProfileHash、commit 前校验、缺失文件清理）。这是 per-source 灰度的前提。
3. **usage-core 全部校验语义**：cacheRead≤total、costUnavailable 来源 costUsd 必须 0、token/cost 上限、时区校验（嵌入 `time/tzdata`；金样本覆盖 Intl 边界，如 `Etc/GMT+5` 反号）。
4. **env 契约不变**：`TOKENBOARD_ENDPOINT/UPLOAD_TOKEN/TIMEZONE/SOURCE/SINCE/UNTIL/HOOK_MODE/STATE_DIR/FAIL_ON_SOURCE_ERROR/CCUSAGE_CONFIG/CODEX_SYMLINK_ROOTS_JSON/…` 与 TS 逐一同名同义；`transientSyncExitCode=75` 保留。
5. **stderr 行为契约**：skill 脚本按行解析 stderr（脱敏、进度、跳过形态），Go 输出格式对齐。
6. **providers 语义陷阱清单**（平移时逐条带 fixture 测试）：Pi cacheWrite+cacheWrite1h 双档与 entry-id 去重；Grok 面值入账+cachedRead 拆 fresh；DSH 多帧 zstd+尾帧截断容忍+seq 去重；OpenCode SQL 投影+只读打开；Antigravity 原文不落盘+bounded 扫描+cursor 上限；Codex 混合模型对账+重试消息前缀耦合+symlink 策略；costUnavailable fail-closed。

## 4. ccusage 集成（三层，fail-closed）

优先级：**捆绑 > 探测 > 下载**。
1. **捆绑**：CI 从 npm registry 下载 `@ccusage/ccusage-<platform>-<arch>@<version>` tarball，验 `dist.integrity`（sha512），随 GoReleaser tarball 分发；安装脚本放 `~/.tokenboard/bin/`。MIT 再分发需附许可声明。
2. **探测**：PATH 上已有 ccusage 可用；版本与 client 期望不符 → stderr 告警（不拒绝）。
3. **下载**：`tokenboard doctor` / sync 时检测两者皆无 → 下载期望版本到 `~/.tokenboard/bin/`，sha512 不符即拒用。**hook 模式禁止下载**（禁联网纪律），只用已有版本否则该 source unavailable。
- 版本策略（D3）：`clients/go/internal/ccusage/version.go` 记录期望版本；升级依赖时跑 §5 门禁。期望版本一般等于 TS 侧 package.json 的版本（升级同 PR 双改）。

## 5. 依赖升级门禁（D3 的兜底机制）

`clients/go/scripts/check-deps.sh`（CI 跑；已实现，金样本在 `clients/go/testdata/ccusage-golden/`）：
1. 对 ccusage：取固定 fixture 会话树，用二进制跑 `claude daily --json --breakdown` / `claude session --json`（含 `--config packages/collector/ccusage.json`，与原采集调用同形），键序规范化后与金样本 diff；shape 变化 → 退出码 1，人工审后 `--update` 重铸。版本闸门：二进制版本必须等于 TS 侧 `packages/collector/package.json` 的 pin，否则直接拒绝。旧/新双版本对照留给 CI 传入 `CCUSAGE_BIN` 两次调用。
2. 对 Go 依赖：常规 `go build`+ 全量测试即为门禁；`go.mod` 无 pin 压力，常规 dependabot/手动升级。
- JSON 输出上游无 schemaVersion、无 CHANGELOG —— 此门禁是唯一防线，不可省。

## 6. 影子验证（语义等价的保证，三层）

1. **fixture 测试平移**：TS 测试的输入文件树（JSONL/SQLite）直接复用为 Go golden 输入，期望值提取为 golden JSON；按 provider 分批。
2. **`tokenboard shadow` 命令**：同 env 下运行 TS `preview` 与 Go 采集（`TOKENBOARD_SHADOW=1`：cursor commit 变 no-op、不网络上传），两组快照按 snapshotKey 排序规范化 diff（剔除 collectedAt），非空即 exit 1 输出结构化差异。CI 中全部 home/工具目录 env 指向 fixture（`XDG_DATA_HOME/CODEX_HOME/DSH_HOME/GROK_HOME/PI_CODING_AGENT_DIR/…`），不依赖真实用户数据。
3. **生产双跑**：本机 crontab TS 上传 + Go shadow 7 天，人审无 diff 后切换。
- 限制：影子只覆盖全量 preview 语义；hook 增量路径靠单测 + 切换后小流量观察。

## 7. 灰度切换（per-source）

- config 增 `perSource: {"pi":"go","codex":"ts",...}`（缺省全 `ts`）；`sync.mjs buildSyncInvocation` 据此 spawn TS（`node --import tsx …`）或 Go 二进制；env 构造代码两端共用不复制。
- 回滚 = 字段改回 `ts`。**未通过 §3.2 双向兼容测试的 source 不许切**。
- 全部 source 走 Go 且稳定 2 周 → 默认值翻转为 `go`，TS collector 标记 deprecated。

## 8. 升级通道

- GoReleaser：5 平台 tarball + checksums.txt；`tokenboard self-update`：查 Releases → 比较 → 下载 → 验 checksum → rename-swap（新版先 `.new` 落地、`--version` 验证后替换、旧版留 backup）。
- 定时升级路径改调 `self-update --scheduled`，**解耦 git 工作树状态**（消解「安装目录=开发仓库→脏树→升级永久跳过」死结）。
- 现存 git-clone 用户：upgrade.mjs 迁移分支——装二进制 + `config.clientType:'binary'`，不删旧 checkout；`clientType` 缺省 `'git'` 保持兼容。
- 包管理器（brew/scoop/winget）：二期，检测到包管理器安装时 self-update 提示改用之，避免双头更新。

## 9. 里程碑（出口可验证）

| 阶段 | 内容 | 人日 | 出口 |
|---|---|---|---|
| M0 | 骨架 + 契约层（JSON Schema 生成、金样本、cursor 双向兼容） | 5–6 | §3.1/3.2 测试全绿 |
| M1 | upload/编排/state/锁 | 5 | fixture sync dry-run 与 TS 对照一致 |
| M2 | grok/dsh/pi/opencode + zstd 分帧 | 7 | 影子 diff=0（该批） |
| M3 | antigravity 三源 + 不落盘专项 | 10 | 同上 |
| M4 | claude-code + ccusage 集成层 | 7 | hook 离线行为验证 |
| M5 | codex 全家（context-pricing 对账最大项） | 12–14 | codex 影子 diff=0 |
| M6 | GoReleaser/self-update/skill 改造 | 6 | 干净机 install→sync→self-update 端到端 |
| M7 | per-source 灰度 + 双跑 + 切换 | 6–7 | 全 source 走 Go，TS deprecated |

合计 ~10–11 周单人；providers 批次可并行压缩。**每批出口标准统一：Go 测试数 ≥ 对应 TS 测试数、影子 diff=0、该批 per-source 切换可用。**

## 10. 风险与缓解（top5，完整 11 项见调研报告）

1. codex 对账语义走样（高×高）→ M5 单列、逐测试平移、禁止「Go 里更好写」式语义优化
2. cursor 兼容破坏→全量重扫/漏传（中×高）→ M0 双向契约测试 + 真实数据双读验证后才许切
3. snapshotHash 漂移→check 去重失效烧 D1 配额（中×高）→ 手工拼键序 + 字节级金样本
4. 迁移期 TS 变更→影子基线移动（高×中）→ **迁移期 TS collector 冻结只收 bugfix**（硬纪律）
5. modernc/sqlite 行为差异（中×中）→ SQL 输出对照测试；硬伤再评估分平台 CGO

## 11. 当前状态与下一步

- [x] 调研完成（见 research 报告）；ccusage 已升 20.0.33（2cc5249，PR #24）
- [ ] **前置：与上游作者对齐（D8）** —— 开工条件

**M4 状态（claude-code + ccusage 集成层）**：

- [x] `internal/ccusage`：`Resolve` 三层获取（`TOKENBOARD_CCUSAGE_BIN` → `~/.tokenboard/bin/ccusage` → PATH 探测 → npm 下载 + sha512 完整性校验），**hook 模式在下载层之前返回错误**（不联网）；`RunJSON` 命令层（超时具名、瞬态重试、Windows `.cmd`/`.bat` shell 引号与元字符拒绝、128MiB 输出上限）；`PackageRunner`（bunx/npm exec/pnpm dlx/npx，`--config` 拼接）；`NormalizeCcusageDailyJSON`（ordered record 保序、pro-rata 成本分摊、session 计数按报告时区、codex 总量重算）。
- [x] `internal/pricing`：模型定价目录（网络分页 + 游标环检测、24h 缓存 + ETag/304、陈旧缓存与 bundled 静态回退、hook 模式离线）、动态 ccusage 配置生成与显式配置优先级、context tier 校验。
- [x] `internal/collect/providers/claudecode`：range 与 hook 两条路径；hook 走 `sessioncursor.CollectHookIncremental` + 窄窗口 reconcile + 对账断言；`TOKENBOARD_FORCE_PACKAGE_RUNNER` 跳过二进制获取；非 hook 获取失败回退 package runner（保留 TS 无捆绑二进制的行为），hook 模式 fail-closed。
- [x] CLI 接线：`warmHookCursors`（仅无界非 hook 的 claude-code 预热高水位）、`pricingDiagnosticSink`（未定价模型按 provider 聚合，20 个上限）、`acknowledgeUploadCursors` 补上 `shouldAckCursor` 的非 Antigravity 分支（hook 模式按已上传分组清 `pendingUpload`，range 模式不动）。
- 已修复的移植缺陷（有测试钉住）：
  - `sessioncursor` 的 `ReadLines` 闭包原本删除 `scanState.unreadChangedFiles`，而 `ScanResult` 的副本在扫描结束时已拷好，导致 `Commit` 永远拒绝（「cannot commit before all changed files are read」）；改为直接写 `result`，与 TS `readChangedSessionJsonlLines` 一致。
  - cursor 条目校验曾强制 `sha256` 为 64 位 hex，而内容哈希早已切到 blake2b512（128 hex），Go 读不回自己写的 cursor；改为只要求字符串，与 TS `isValidCursorEntry` 一致。
  - `NormalizeCcusageDailyJSON` 曾把 daily 输入当 sessions 传，session 计数全错；stub 传入的普通 map 也未转 ordered record。
  - `parseJSDate` 不支持 ccusage 的显示日期（`Apr 28, 2026`），TS 的 `Date.parse(value + ' UTC')` 支持。
  - `internal/pricing` 曾用 RE2 不支持的前瞻正则做 model ID 校验，包初始化即 panic；改为等价函数。
- 与 TS 的已知边界：
  - Go 侧捆绑二进制是 spec §4 的第一层，TS 没有；非 hook 获取失败仍回退 package runner 以保持 skill 安装兼容。
  - bundled 静态配置在 Go 侧是嵌入文件，运行时落盘到 `<stateDir>/ccusage.bundled.json`；TS 从 checkout 读 `ccusage.json`。
  - Windows 的 dev/ino 由 `identity_windows.go` 给出平台回退，不与 Node 的 stat 逐位对齐。
- M4 出口（hook 离线行为）：`TestHookModeNeverDownloadsCcusage`（无二进制时 hook 失败且 runner 不运行）、`TestResolveHookModeFailsClosedWithoutABinary`、`TestResolvePrefersTheBundledBinaryOverPATH`、`TestDownloadVerifiesIntegrityAndInstallsTheBinary` 覆盖获取层；`TestHookModeUsesChangedFilesToNarrowReconciliation` 等 6 条覆盖 hook 对账语义。

**M3 调研要点（2026-10-16，未写入实现）**：antigravity 三源在 TS 侧共 ~11.5k 行（含测试），分四层：

- 纯/无依赖（可直接平移，对应 Go 侧新包 `antigravityscan`）：`antigravity-file-scan.ts`（173 行，SHA-256 键 + 热/冷混合选择 + 从两端取样）、`antigravity-since.ts`（87 行，`since@时区` scope 解析 + `includesTimestamp/includesFileMtime` 谓词）。两者测试仅 3 条，但逻辑密集。
- 数据层：`antigravity-history-db.ts`（632 行，SQLite `gen_metadata.data` 投影 + cursor 高水位 + 完整目录扫描断言）、`antigravity-history-protobuf.ts`（298 行，`.pb` 解析，M0 硬约束禁止直接作上传来源）。
- Cursor 层：`antigravity-cli-cursor.ts`(543)、`antigravity-gui-cursor.ts`(543)、`antigravity-cli-db-cursor.ts`(154)、`antigravity-cli-history-authority.ts`(266)——legacy 迁移/重建/回滚。
- Provider：`antigravity-cli.ts`(250，含 CLI 源 + status line 侧约束)、`antigravity-gui.ts`(529)、language server client `antigravity-gui-client.ts`(555，JSON-RPC over stdio)。
- 注意：TS 侧 provider 把 cursor 读写内联进 `session-cursor-store.ts`，Go 侧 M0 已有 `internal/collect/sessioncursor`，三源 provider 须复用而非另写。
- 风险：protobuf 层（298 行 + 529 行测试）和 language-server 层是 M3 主体工作量；「不落盘专项」= 硬约束「raw content 不得进 cursor/snapshot/日志/payload」需逐层测试覆盖（TS 已有 antigravity-gui-parser 66 行测试 + client 631 行测试可对照）。
- [x] 数据层：`antigravityscan`（f0d7f5a + 6f478b7 目录列表 helper）、`antigravitymeta`（51b2426 parser + protobuf + 金样本级 blob 解析）、`antigravityhistory`（6f478b7），影子 diff 见下
- [x] Cursor 层（CLI 侧）：`antigravity-cli-db-cursor`（62616f9，scope 复用/迁移/剪枝 + 无锚检测逐位对齐 TS 比较）、`antigravity-cli-cursor` + `antigravity-cli-history-authority`（83c6963，event/session/aggregate 三族键 + pending 重发 + 压缩边界 fail-closed + metering version 迁移 + 全量重建 prepare/restore + 零 correction）；`antigravity-gui-cursor` 待做
- [x] 共享层：`sessioncursor.SelectPendingCursorSnapshotGroups` / `ShouldIncludeCursorSnapshot`（dcf2b51，pending 重试轮转 + 分组过滤）
- [x] **antigravity-cli 源完成、可切换**（e6a221e + f6bf049）：provider 编排（range → migration → rebuild → 读库 → push → mark → restore → 重发 → 校验 → 写 cursor，全程 fail-closed）、`collect.Options.StateDir/HomeDir` 贯通、optional-source 分类补齐三条 Antigravity unavailable 消息、`clearPendingUploadCursors` 的 Go 版（分组确认 + session marker 匹配 + 90 天保留期压缩进 daily aggregate + compacted frontier 持久化）、CLI 上传成功后确认 cursor；集成测试覆盖真实 SQLite fixture 的首跑/重发/确认/增量追加（重发**完整日总量**而非增量）/bounded 扫描 fail-closed/目录缺失 unavailable
- [x] Cursor 层（GUI 侧）：`antigravity-gui-cursor`（bb5baba，event/session/aggregate 三族键 + antigravityOrigin 标记 + bounded scope 迁移 + language-server cascade cursor/empty frontier + db 重置双重 fail-closed + 零 correction）
- [x] Provider 层（GUI）：`antigravity-gui-local-db`（e4a1086）、`antigravity-gui-environment`（unavailable 分类：DB 侧在 support.go，language-server 匹配器在 `antigravitymeta/ls_unavailable.go` 以便 CLI 复用）、`antigravity-gui` 编排 + db-reset 恢复 + partial-usage 契约（226176f）、`antigravity-gui-client`（96af34c，语言服务器进程单次 Wait 所有权 + 32MiB 限流中读）、`antigravity`/`antigravity-ide` 注册 + GUI 侧 ack（per-origin 聚合 + compacted 重放标识）
- [x] 「不落盘专项」测试覆盖（07d4e9e + 86 项 GUI 包测试）：raw content（prompt/completion/promptSections/conversationHistory/path/email）贯穿 GUI 全链后逐层断言其不存在——解析后 event、snapshot、cursor 文件、stderr 诊断、序列化 payload；SQLite 路径在 blob 层同口径钉住（prompt/path protobuf 字段与 usage 块同排）。另 `TestCollectGuiNeverPersistsRawIdentifiers` 覆盖原始 conversation/response/execution/session id 不进 cursor
- [x] 六 agent 复核修复（f372645..ecf6395）：cascade 列表只认 `.pb`/`.db` 且 stat 非 ENOENT 错误上抛（f372645）；`--since all` 下 DB 读失败先于完整性断言上抛（d28f6ba）；CLI source-failure/exit-code 契约对齐 TS（fatal 标志、concrete-source partial 上传后 exit 1、all-source fatal 失败、零 snapshot partial 仍算 collected、`ignoreLanguageServerUnavailable`）+ Antigravity 失败按 category 脱敏进调度日志（8aedd83）；partial 快照上传前逐条 Validate（805a45f）；metadata 字符串按 UTF-16 code unit 限长 + nil Env 回落进程环境（6ae34d5）；db-reset 恢复链/跨轮日总量重发/未变日不重传三条集成测试（ecf6395）；语言服务器请求门控 4 场景 + db-reset 修正语义 3 场景端到端覆盖（84dfa36、86bab96、0260ce2）；cascade 平局按原始 id（901a3c9）、PATH 查找 spawn ENOENT（a8b1a1b）、partial 路径保留扫描状态（91a91b2）、拒绝重定向 + SIGTERM 宽限关闭（c4b1ba9）

**M3 数据层影子 diff 口径（6f478b7）**：`clients/go/scripts/antigravity-fixture.mts` 生成 5 个 cascade DB（含 placeholder model、稀疏 usage、空 blob/NULL、损坏 blob、别名）；`antigravity-shadow-ts.mts` / `antigravity-shadow-incremental.mts` 跑 TS 侧，`cmd/tb-shadow-antigravity` 跑 Go 侧。六个场景全部一致（canonical 化后逐字段）：无界直读、有界直读（maxDbFiles=2）、三段携带状态增量（每段向 TS 自己写出的 state 追加一行到最热已处理库，另有未读库参与竞争）、删除已确认行后的 fail-closed（两侧抛同一 "metadata cursor reset detected …; rerun with --since all" 错误）。mtimeMs 必须与 Node `fs.Stats#mtimeMs` 逐位一致（写入共享 cursor 文件），故 `internal/collect/mtime` 复刻 Node 的先秒后纳秒算术；`UnixNano()/1e6` 单步除法末位差一 ulp（实测 1792153999246.4922 vs …492）。
- [x] M0 契约层（6cca203；金样本 `clients/go/internal/contract/goldens/snapshot-hash.json`，由 `scripts/clients-go-gen-goldens.mjs` 从 TS 侧再生成；cursor 双向兼容验证在 50c4157）
- [x] 确认 Go 工具链版本基线：`clients/go/go.mod` 声明 `go 1.27`，依赖为 `golang.org/x/sys` 与 `github.com/klauspost/compress`（M2 引入，Go 标准库的 `internal/zstd` 不可导入）
- [x] M1 上传/运行锁/瞬态分类/sync CLI（9286438 + 9d6f6c4 + 50c4157；provider registry 尚为空，M2 起填充）
- [x] M2 grok/dsh/pi/opencode + zstd 分帧 —— 完成：
  - [x] grok-build provider + 共用 scan/aggregate 层（bb22885）
  - [x] deepseek-harness provider + zstd 分帧（37e0aa1）
  - [x] pi provider
  - [x] opencode provider + 嵌入式 SQLite 读写（modernc.org/sqlite）
  - [x] `clients/go/scripts/check-deps.sh`（§5 依赖闸门；**本属 M4**，提前完成——金样本是 M4 编写解析器时的契约，先钉上游形状再写解析器是正确顺序）

**M2 影子 diff 口径**：每来源一个 fixture（grok：真实 `updates.jsonl` 事件形状；DSH：同目录 plain+zstd 双编码去重 + 跨帧 UTF-8 + 尾部撕裂帧 + cache read/write + 跨日期；Pi：fork 同 id 去重 + toolResult/compaction/branch_summary 三类 carrier + 跨日期；opencode：真实 `opencode.db` 行 + `gpt-4o`/`GPT-4o` 大小写排序陷阱）分别跑 `tsx src/cli.ts preview --source <s>` 与 Go `tokenboard preview --source <s>`，除 `collectedAt`（墙钟）外逐字段、逐序一致。

**M2 新增的共享层**（TS 侧分散在 `session-cursor.ts` 等文件中，Go 归入独立包）：

- `internal/collect/collate`：镜像 JS 默认 `localeCompare`。ICU 主级比较忽略大小写、次级小写在前，且标点自带主级权重（`_` 在 `-` 之前），与字节序不同；`Aggregate.Snapshots()` 与 `MergeSnapshots` 的排序若与 TS 分叉，同一批 snapshot 会以不同顺序输出，而 cursor 契约是按字节比较的。可打印 ASCII 的排序表由 Node 实测导出（见包注释），非 ASCII 退化为码点序并在注释中声明该边界。
- `internal/collect/sqlite`：移植 `sqlite-reader.ts`。嵌入式 modernc 驱动对应 `node:sqlite`，外部 `sqlite3` 二进制仍由 `TOKENBOARD_SQLITE_BIN` 强制（保持 TS 的环境契约：该变量选读法，不改变行为）。两条路径均只读，且有 `-json` 输出上限对齐的字节预算检查与「两读法结果一致」的实测测试。


**与 §2 布局的已发生偏离（回写于此）**：

- cli 未用 cobra：`internal/cli/cli.go` 手写子命令分发，零第三方依赖。
- §4 的 ccusage 三层集成（捆绑/探测/下载）与 §8 的 GoReleaser/self-update 通道归 M4/M6；本轮仅提前落地了 §5 的 check-deps 闸门。
- `contract/contract.json`（JSON Schema 生成类型）未采用：契约以手写 Go 结构 + TS 生成的金样本（`goldens/`）钉住，等价性由字节级测试保证。
