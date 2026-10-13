# Private model pricing deployment verification

文件名中的 `2026-08-07` 为原始创建日期；本记录的验证期间为 2026-08-09 至 2026-08-16（Asia/Shanghai）。

（2026-10-13 精简版：原文 183 行保留了 4 轮逐日部署复核与外部复核明细；此处保留结论、证据分类与当前写路径备注，逐轮记录见 git 历史。）

验证日期：2026-08-09 至 2026-08-16（Asia/Shanghai）

## 范围

- Worker：`<private-worker-origin>`；D1：`<private-d1-database>`（均已脱敏）
- 价格源：`https://models.dev/api.json`
- 同步方式：Worker Cron 每 15 分钟触发，D1 状态行限制实际同步间隔为 24 小时；另有受保护的手动同步接口

## 本地门禁（收口时点，2026-08-16）

- `pnpm test`：usage-core 9/9、Web 646/646、collector 751 通过，3 个既有平台测试跳过；`pnpm typecheck`、`pnpm build`、`node --test skills/tokenboard/scripts/*.test.mjs`（482/482）、`pnpm audit --audit-level=high`、`git diff --check` 均通过；未发现 UTF-8 BOM 或 CRLF。
- 三端覆盖：Linux 与 Windows 远程测试主机完成 workspace 测试、类型检查、生产构建与 skill 脚本测试（Windows 早期夹具失败为 POSIX 路径模拟问题，修正宿主边界后复跑 466/470 通过、0 失败）；后期两台远程主机仅做只读连通性探针，未计为全量通过证据。
- models.dev 探针（2026-08-14）：185 provider、6,319 模型记录；经 Worker normalizer 接受 175 provider、5,900 模型，最新更新 `2026-08-14`。
- 部署期间修复：Cloudflare Workers 不接受 `fetch` 的 `redirect: "error"`，价格源请求改为 `redirect: "manual"` 并对所有 3xx 显式失败；另有输入边界加固（模型 ID/displayName 拒绝控制与代理字符、Codex 日期后缀仅在真实 `YYYYMMDD` 时归一化、分页游标同等 Unicode fail-closed 校验），均有回归覆盖。
- 外部复核：Claude `2.1.232` 发现 displayName 字符边界与日期后缀测试覆盖建议，已修复并由 84 个定向用例验证；OMP `17.3.3` 返回 `NO_ACTIONABLE_FINDINGS`。早期多轮 Claude/OMP 因网络、渠道不可用或空输出未产生结果，均未计为通过证据。

## 私人 Worker 部署与运行验证

- D1 migration `0030_model_pricing.sql` 和 `0031_model_pricing_staging.sql` 已应用；`0032`–`0034` 同期落地；关键 schema 校验通过。
- Cron 真实执行价格同步：模型数量从 58 增至 5816，最终记录 `model_count=5946`、`last_source_updated_at=2026-08-14`、`last_error=null`，active generation 已设置；后续由 Cron 按 24 小时间隔刷新。
- 接口验证均通过：`/api/v1/health` HTTP 200；`/api/public/model-pricing` 与 `/api/v1/model-pricing` 兼容别名只返回 `models` 和 `nextCursor`，不泄露同步状态、错误或锁信息；provider 过滤、`includeInactive` 历史分页、游标翻页与伪造游标 400、ETag `If-None-Match` 304 全部验证。
- 价格语义抽查：`gpt-5.6-sol` 输入 `$5/M`、输出 `$30/M`、context `1,050,000`，272K 上下文分层价格保留在 `pricingJson`，未误写成 128K；国产模型目录随全量同步保留。
- 费用语义复核：Antigravity 三类来源 `costUsd: 0` 不被当作免费价格；dashboard、详情、CSV、日报、webhook、public JSON、SVG、排行榜均保留费用不可用标记，混入 Antigravity 的周期费用列标记不可用。
- 部署证据分类：发布来自当时的 dirty worktree（指纹 `sha256:e597fa41…`），属于私人环境验证证据，不是可复现的 release artifact；正式 release 必须从固定 commit 或不可变 artifact 部署。

## 结论与当前写路径备注

价格源抓取、D1 staging 原子替换、Cron 自动同步、手动刷新鉴权、分页公开接口和所有已核对的费用消费者均已完成本地及私人 Worker 验证。`models.dev` 是维护型机器注册表，不是厂商自有 API；系统同时保存官方文档链接，后续价格变化由 Worker 直接更新 D1，不需要提交 PR。

> 2026-10-13 备注：本文记录的「staging 原子替换」是当时（2026-08）的全量重建写路径。该路径已在
> `feat/model-pricing-maintenance` 分支改为增量 diff 发布（只 stage 变化行、显式停用删除行，
> 无变化日只写 1 行状态），见 `docs/model-pricing.md` 的当前描述。本文其余内容为历史验证快照，不随代码更新。
