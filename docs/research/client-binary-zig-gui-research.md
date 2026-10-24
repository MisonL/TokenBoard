# Client 独立 + 二进制交付 + 语言迁移 + GUI 调研与实施方案（终稿）

调研日期：2026-10-15。三路 agent（工具链实测 / 仓库现状 / ccusage 深调）+ Go 方案设计 agent，关键结论均经本机/npm/gh 独立抽核。

## 结论（一页版）

1. **语言：Go**（Web 端留 TS）。单二进制 + 5 平台交叉编译零工具链、无语言税、SQLite/zstd/HTTP 全标准库或一线纯 Go 库。
2. **二进制交付完全可行且比原以为的更干净**：ccusage 自 20.0.0（2026-05-19）起就是 **Rust 静态二进制**（npm optionalDeps 分发，linux 为 musl 静态链接、无 install 脚本、registry 提供 sha512 integrity）——Go client 直接捆绑/下载平台二进制，**彻底摆脱 Node/npm 依赖**，此前「ccusage 是 JS 包的结构性硬伤」结论作废。
3. **Zig 不采用**：无 1.0 时间表、年度破坏性升级税，且其 C 互操作优势在本场景用不上；「Go 用不上 Zig 强项，Zig 要吃 Zig 全部代价」。
4. **性能/资源预期**：冷启动 300ms→10ms 级（hook/CLI 响应性 20×）、同步峰值内存 150MB→30MB、常驻组件 50MB→5MB；同步总耗时大头在会话扫描本身（实测 ccusage Rust 二进制单次 daily 仍要 23–33s），**迁移不改变它**——迁移的收益是交付形态与稳态，不是扫描速度。
5. **总工作量：约 10–11 周单人**（agent 蓝图 M0–M7），最大单项是 codex provider（含 context-pricing 对账，约占 1/3）；核心安全网是「双实现影子验证 + per-source 灰度」，前提是 cursor 状态文件与 snapshotHash 序列化的字节级双向兼容。
6. **前置沟通**：client 拆分改变交付模式，动手前需与上游作者对齐（skill 机制是上游核心资产）。

## 一、已核实事实

### 1.1 ccusage Rust 化（全部实测，含本机 20.0.31 解包 + npm registry API + gh API）
- `ccusage` 主包 = 5 文件 npm 壳，唯一 bin 是 `src/cli.js` Node 启动器：resolve `@ccusage/ccusage-<platform>-<arch>` → spawn。**找不到原生二进制直接报错退出，无 JS 回退**。
- 六个平台包（darwin/linux/win32 × x64/arm64）各 3.6–5MB：linux = **musl 静态 PIE**（一个包通吃 glibc/musl）；darwin 仅依赖系统 libSystem；win32-arm64 存在。无 install 脚本，tarball 解包即可执行——**脱离 npm 生态已实测可行**（curl registry tarball → 解包 → chmod → 直接跑）。
- registry `dist.integrity`（sha512）可 pin；GitHub Releases 无 assets（8 个 release 实测）；无 brew/cargo install。
- Rust workspace：`rust/adapters/*`（claude/codex/gemini/antigravity/pi/grok/goose/copilot/kimi/droid 等 20 个）+ `crates/*`（ccusage 二进制 crate，fat LTO）。license MIT（主包与平台包均实测）。
- **上游收缩信号**：`@ccusage/codex`、`ccusage-amp`、`ccusage-opencode`、`ccusage-pi` 独立包已移除且 AGENTS.md 明文禁止恢复。**TokenBoard 采集器调用的是 `ccusage claude daily/session`（claude-code.ts:146-170）与 `ccusage codex daily/session` canonical 形式——不受影响**，但任何「依赖独立包装包」的假设都要清除。
- JSON 输出无 schemaVersion、仓库无 CHANGELOG；「stable --json output」是 AGENTS.md 承诺但无机器可校验契约 → **pin 版本 + 升级前 JSON diff 是唯一防线**。
- 20.0.33 对 codex 新增 zstd rollout 读取（PR #1890）——若 Codex 本地 rollout 转 zstd，升级 pin 反而变为必需。

### 1.2 现行 client 形态（agent 盘点，抽核通过）
- 安装 = git clone + corepack/pnpm；升级 = git fetch + repoRef + 脏树保护（upgrade.mjs:267-280）。本机「安装目录=开发仓库」使自动升级永久跳过。
- 运行两条路径：bin shim（pnpm exec tsx）与 skill 直调（`node --import tsx src/cli.ts`，sync.mjs:460）。无编译产物。
- skill 只 spawn collector 不 import 源码；env 契约（TOKENBOARD_*）是 TS/Go 共用的天然接口。**改动面 = spawn 命令行 + repoDir 派生路径，非逻辑重写**（sync.mjs / install / upgrade / uninstall / status / config 六脚本）。
- collector 运行时 npm 依赖实际只有 usage-core(+zod)；ccusage 在 deps 里只为提供本地 .bin——**Go 化后此依赖自然消失**。
- `ccusage.json`（10KB 静态定价）按 `import.meta.url` 相对路径读——bundle/binary 需改为内嵌资源。
- 无 CI（无 .github/workflows）——发布管线从零建。

### 1.3 关键契约（Go 重写的硬验收项）
- `snapshotHashPayload`：SHA-256 over 规范化 JSON（字段序固定、无空格）——Go 必须手工拼键序，不依赖 encoding/json。
- cursor JSON v1：per-file sha256+mtime+size+offset+pendingUpload、codexHookProfileHash、commit 前校验。**双向兼容（TS 写→Go 读→Go 写→TS 读）是 per-source 灰度的前提**。
- 语义陷阱清单（必须带测试平移）：Pi cacheWrite+cacheWrite1h 双档、Pi entry-id 去重、Grok 面值入账+cachedRead 拆分、DSH 多帧 zstd+尾帧截断容忍+seq 去重、costUnavailable fail-closed、OpenCode json_extract SQL 投影+只读打开、Antigravity 原文不落盘、bounded 扫描深度/symlink/超限跳过。

## 二、方案设计（agent 蓝图，可直接开工）

### 2.1 仓库与契约
- 同仓新目录 `clients/go/` 起步（影子验证期需 TS/Go 同 commit 同 fixture），稳定后拆仓 `tokenboard-client`。
- 契约双端共享 = **A+B 混合**：字段形状用 Zod→JSON Schema 生成 Go 类型；跨字段校验（cacheRead≤total、costUnavailable、上限防溢出）+ snapshotHashPayload 键序用 Go 手写 + **金样本契约测试**锁定（TS 导出接受/拒绝+哈希清单，Go 逐条断言）。

### 2.2 Go 选型
| 领域 | 选型 | 关键理由 |
|---|---|---|
| SQLite | modernc.org/sqlite（纯 Go 免 CGO） | 交叉编译硬要求；需验证 json_extract 与只读模式对齐 |
| zstd | klauspost/compress | 多帧支持好；DSH 帧定界逻辑保留，只换解压原语 |
| HTTP / CLI | net/http；cobra | upload 逻辑简单；子命令树+completion 免费获得 |
| 时区 | time/tzdata **嵌入** | Windows/精简容器无系统 tzdata；金样本覆盖 Intl 边界语义 |
| 锁/调度 | gofrs/flock；launchd plist/systemd unit 纯 Go 生成，schtasks 子进程 | 与现有调度语义对齐 |

### 2.3 ccusage 集成：捆绑 > 探测 > 下载（fail-closed）
1. **主通道（捆绑）**：CI 从 npm registry 下载 pin 版本平台 tarball、验 `dist.integrity` sha512、随 GoReleaser tarball 分发，安装脚本放 `~/.tokenboard/bin/`。MIT 允许再分发（附许可声明）。
2. **回退（探测）**：PATH 中已有 ccusage 可用，版本不匹配 stderr 告警。
3. **兜底（下载）**：`tokenboard doctor` 检测两者皆无时下载 pin 版本到状态目录（sha512 fail-closed）；**hook 模式禁止联网**（对齐现有纪律），只用已有版本否则 unavailable。
- pin 升级 = 显式 PR（改版本 + 换 checksum + JSON 输出 diff 验证）；建议 pin 升至 20.0.33（codex zstd rollout 支持）。

### 2.4 影子验证与灰度（语义不丢的保证）
- 三层：fixture 测试平移（~70% 直接复用 testdata）→ **`tokenboard shadow` 命令**（同 env 下 TS preview 与 Go dry-run 采集，快照规范化 diff，CI 全 HOME 指向 fixture 避免真实数据依赖）→ 本机 crontab 双跑 7 天人审。
- 限制：影子只验证全量 preview 语义；hook 路径靠单测 + 小流量灰度。
- **per-source 切换**：config 加 `perSource: {pi: go, codex: ts, ...}`；sync.mjs 按它 spawn TS 或 Go；游标双向兼容未验证前不许切。
- 平移顺序：grok/dsh/pi/opencode → antigravity 三源 → claude-code（引入 ccusage 层）→ **codex 最后**（context-pricing 对账占总量 1/3，逐测试平移不许语义「顺手优化」）。

### 2.5 升级通道
- GoReleaser + GitHub Releases + checksums + `tokenboard self-update`（rename-swap 保留 rollback）；定时路径改调 `self-update --scheduled` ——**顺手解掉「安装目录=开发仓库→脏树→升级永久跳过」的死结**。
- 包管理器（brew/scoop/winget）第二阶段；双头更新冲突要检测。
- 现存 git-clone 用户：upgrade.mjs 加迁移分支（装二进制 + config `clientType: 'binary'`，不删旧 checkout）。

### 2.6 里程碑（单人 ~10–11 周，可两人并行压到 ~7 周）
| 阶段 | 内容 | 人日 | 出口 |
|---|---|---|---|
| M0 | 仓库骨架 + 契约层（JSON Schema 生成、金样本、cursor 双向兼容） | 5–6 | Go 能读 TS cursor 且反之 |
| M1 | upload/编排/state | 5 | fixture sync dry-run 与 TS 对照一致 |
| M2 | grok/dsh/pi/opencode + zstd 分帧 | 7 | 影子 diff=0 |
| M3 | antigravity 三源 + 不落盘专项 | 10 | 同上 |
| M4 | claude-code + ccusage 集成层 | 7 | hook 离线行为验证 |
| M5 | codex 全家（对账最大项） | 12–14 | codex 影子 diff=0 |
| M6 | GoReleaser/self-update/skill 改造 | 6 | 干净机端到端 install→sync→self-update |
| M7 | per-source 灰度 + 双跑 + 切换 | 6–7 | 全 source 走 Go，TS collector deprecated |

### 2.7 风险 top5（完整 11 项见 agent 原稿，要点）
1. codex 对账语义走样（高×高）：单列 M5、逐测试平移、禁止顺手改语义
2. cursor 兼容破坏→全量重扫（中×高）：M0 双向契约测试 + 真实数据双读验证
3. snapshotHash 序列化漂移→check 失效烧 D1 配额（中×高）：手工拼键序+字节级金样本
4. 迁移期 TS 侧持续变更→基线移动（高×中）：迁移期 TS collector 冻结只收 bugfix
5. modernc/sqlite 行为差异（中×中）：SQL 输出对照测试；硬伤再评估分平台 CGO

## 三、GUI（保留上轮结论，与 CLI 解耦）
Tauri 起步（复用 dashboard 组件）；「真 native」等 dvui 成熟或转 Go 后用 Wails/Fyne——**Go 化让 GUI 后路反而更宽**。

## 四、与上轮报告的差异（更新记录）
- ❌ 作废：「ccusage 是 JS 包，Zig/Go 无法内嵌，结构性硬伤」→ 20.0.0 起即 Rust 静态二进制，Go/Zig 均可无 Node 集成。
- ❌ 作废：「同步耗时 80% 在 ccusage 的 node 进程」→ 实测 Rust 二进制单次扫描 23–33s 是解析工作本身，语言胶水只占 0.24s。
- ✅ 不变：Go 推荐、Zig no-go、资源收益估算、升级机制是工作量大头、影子验证方法论。
- 新增：client 拆分前与上游作者对齐（skill 是上游核心资产）；pin 建议升 20.0.33。
