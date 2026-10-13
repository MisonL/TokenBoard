# 设备身份与重连机制验收记录 - 2026-06-30, updated 2026-07-20

（2026-10-13 精简版：两次复核补充合并为关键修复结论；设计全文见 `docs/architecture/device-identity-reconnect-plan.md`。）

## 范围

本记录覆盖 PR #19 中与设备身份、重新连接、多 server client profile、device-link 恢复、Antigravity 三类来源适配相关的验收结论。

## 关键修复结论

- pairing code 消费、设备/安装实例创建、upload token 创建和审计日志写入合并为同一个 D1 batch，任一语句失败整体回滚；device revoke 与 installation revoke 同样单 batch 原子化。已补 SQLite 真实事务契约测试（凭据创建前进程崩溃、审计插入失败、撤销回滚），纯 Fake 测试不作为 D1 原子性证据。
- pairing code 被并发消费时通过有条件 `INSERT ... SELECT` 产生零行写入，service 稳定返回 401，不把 `NULL user_id` constraint 映射为 500。
- Antigravity CLI status line 锁增加目录 identity 校验、缺失/损坏 PID grace period、陈旧 lease 回收和旧版 Windows Node 兼容判断；statusline 仅保留本地脱敏诊断日志与透传，不参与上传计量。
- 日报 `topModels` 携带模型自身 source 列表：纯 Codex/Claude 模型在 mixed-source 日报中保留有效费用，含 Antigravity 的模型标注费用不可用；旧历史缺字段时保守回退 report-wide source split。
- `0028_remove_development_seed.sql` 只移除未认证的默认 seed user；`0029_drop_redundant_pairing_code_hash_index.sql` 只删冗余 named index，表级 UNIQUE 保持 hash 唯一。

## 交付要点

- `devices` 是用户视角的逻辑设备；`device_installations` 是其安装实例；`upload_tokens` 绑定两者，旧 token 兼容。
- pairing code 区分 `new_device` 与 `reconnect_device`；reconnect code 消费前重新确认目标设备和安装实例仍有效。
- `device-link.json` 只作本机敏感恢复状态，恢复必须显式 opt-in；claim 换取 reconnect code 后保留到消费或过期，pair 成功时再轮换新 claim。
- client config 按 server origin 保存 profile，避免正式/私人环境 token 覆盖。
- Antigravity CLI、Antigravity、Antigravity IDE 三类来源接入采集与 Web 展示；TokenBoard skill 各脚本已适配。

## 不变量

- 服务端不保存明文 upload token，也不提供查看历史 token 的能力。
- 不使用硬件指纹、MAC、磁盘序列号、IP、hostname 自动合并设备。
- `device-link.json` 不上传 usage，不打印 install claim，不进入公开 artifact。
- Antigravity collectors 只上传 token、model、timestamp、source、去重 hash 和 cost placeholder；prompt、completion、本地路径、原始 blob、原始 conversation/response id 不进入上传 payload。
- Antigravity 费用不可用，`costUsd` 只能作 `0` 占位，UI、日报、Webhook、公开 JSON/SVG 必须标注费用不可用。
- Antigravity CLI status line capture 显式 opt-in，不包含在默认 hook `--source all` 安装中。
- reconnect pairing code 生成不能先失效旧 claim 再写 pairing code；claim rotation 必须在 code 消费路径完成。
- settings 页面生成 reconnect code 前必须校验目标设备和安装实例仍处于 active 状态。

## 复杂度豁免

以下文件超过全局 800 行强制治理阈值，明确豁免（解除条件出现时先拆再扩）：

- `apps/web/app/features/device/service.ts`：设备查询/凭据轮换/撤销/pairing 共享同一组事务断言与错误语义。解除条件：按 `queries`、`credentials`、`pairing` 三个领域模块拆分并保持兼容导出。
- `apps/web/app/routes/settings/devices.tsx`：同一路由提供列表、详情 fragment 和表单响应。解除条件：先稳定 details fragment 契约，再拆为 `device-list`、`device-details`、`device-actions` 三组组件。
- `apps/web/app/features/device/repository.ts`：主体为 D1 参数化 SQL statement builder。解除条件：新增 repository 职责或文件继续增长时，分离 reconnect 与 new-device statements。

豁免不覆盖安全、事务原子性、外部输入校验、Schema 契约和测试要求。

## 验证与真实环境 gate

本地验证（2026-07-20 时点）：device/API/settings 定向测试、Antigravity 三来源 provider 测试、skill 脚本、workspace 全量（usage-core 7、collector 256、Web 548，共 811）、typecheck、build、`pnpm audit --audit-level low`、`git diff --check` 全部通过；已知 Node `DEP0205 module.register()` 弃用 warning 不影响退出码。

合并前后仍应按发布流程验证：目标环境 D1 migration 应用、Worker 部署后各路由可用、本机与远程 client 经 skill 完成 setup/status/sync、device-link reconnect 在响应丢失/code 过期/设备或安装实例撤销场景返回稳定错误、多 server profile 切换不覆盖其他凭证、旧 client bearer token 仍可 ingest、移动端与桌面端页面不溢出。
