# 设备身份与重连机制验收记录 - 2026-06-30, updated 2026-07-09

## 范围

本记录覆盖 PR #19 中与设备身份、重新连接、多 server client profile、device-link 恢复、Antigravity 三类来源适配相关的验收结论。

主要交付项：

- `devices` 表示用户视角的逻辑设备。
- `device_installations` 表示同一逻辑设备下的安装实例。
- `upload_tokens` 绑定 `device_id` 和 `installation_id`，旧 token 保持兼容。
- pairing code 区分 `new_device` 和 `reconnect_device`。
- Web UI 支持重新连接旧设备、token 轮换、不同层级撤销和审计日志展示。
- client config 按 server origin 保存 profile，避免正式环境和私人环境 token 覆盖。
- `device-link.json` 只作为本机敏感恢复状态，恢复必须显式 opt-in。
- `device-link` claim 换取 reconnect pairing code 后保留到 code 被消费或过期，避免响应丢失后客户端被卡死；pair 成功消费 code 时再轮换新 claim。
- reconnect code 消费前重新确认目标设备和安装实例仍有效；已撤销设备或安装实例不能用 stale code 重新换取 token。
- TokenBoard skill、安装提示、setup、status、uninstall、rotate-token 脚本已适配。
- Antigravity CLI、Antigravity、Antigravity IDE 三类来源已接入采集和 Web 展示。

## 不变量

- 服务端不保存明文 upload token，也不提供查看历史 token 的能力。
- 不使用硬件指纹、MAC、磁盘序列号、IP、hostname 自动合并设备。
- `device-link.json` 不上传 usage，不打印 install claim，不进入公开 artifact。
- Antigravity collectors 只上传 token、model、timestamp、source、去重 hash 和 cost placeholder。
- Antigravity prompt、completion、本地路径、原始历史 blob、原始 conversation id、原始 response id 不进入上传 payload。
- Antigravity 费用不可用，`costUsd` 只能作为 `0` 占位，UI、日报、Webhook、公开 JSON / SVG 必须标注费用不可用。
- Antigravity CLI status line capture 保持显式 opt-in，不包含在默认 hook `--source all` 安装中。
- reconnect pairing code 生成不能先失效旧 claim 再写 pairing code；claim rotation 必须在 code 消费路径完成。
- settings 页面生成 reconnect code 前必须校验目标设备和安装实例仍处于 active 状态。

## 代码证据

- D1 migration:
  - `apps/web/db/migrations/0022_device_installations.sql`
  - `apps/web/db/migrations/0023_device_install_claim.sql`
  - `apps/web/db/migrations/0024_upload_token_active_successor.sql`
  - `apps/web/db/migrations/0025_antigravity_costs_unavailable.sql`
- Web / API:
  - `apps/web/app/features/device/service.ts`
  - `apps/web/app/features/device/repository.ts`
  - `apps/web/app/features/device/device-details-client.ts`
  - `apps/web/app/features/device/components/install-command-commands.ts`
  - `apps/web/app/routes/api/v1/device/pair.ts`
  - `apps/web/app/routes/api/v1/device/pairing-codes.ts`
  - `apps/web/app/routes/api/v1/device/reconnect-pairing-codes.ts`
  - `apps/web/app/routes/settings/devices.tsx`
  - `apps/web/app/routes/settings/devices/details.tsx`
  - `apps/web/app/routes/settings/install.tsx`
- Client / skill:
  - `skills/tokenboard/scripts/config.mjs`
  - `skills/tokenboard/scripts/setup.mjs`
  - `skills/tokenboard/scripts/setup-options.mjs`
  - `skills/tokenboard/scripts/device-link.mjs`
  - `skills/tokenboard/scripts/install-collector.mjs`
  - `skills/tokenboard/scripts/upgrade-utils.mjs`
  - `skills/tokenboard/scripts/upgrade.mjs`
  - `skills/tokenboard/scripts/rotate-token.mjs`
  - `skills/tokenboard/scripts/uninstall.mjs`
  - `skills/tokenboard/SKILL.md`
- Antigravity:
  - `packages/collector/src/providers/antigravity-cli.ts`
  - `packages/collector/src/providers/antigravity-gui.ts`
  - `packages/collector/src/providers/antigravity-history-db.ts`
  - `packages/collector/src/providers/antigravity-history-protobuf.ts`

## 验证命令

以下命令均在本分支本地执行通过：

```bash
pnpm --filter @tokenboard/web exec vitest run app/features/device app/routes/api/v1/device app/routes/settings/devices.post.test.tsx app/routes/settings/devices.test.tsx app/routes/settings/devices/details.test.tsx app/routes/settings/install.post.test.tsx
pnpm --filter @tokenboard/collector test -- src/providers/antigravity-cli.test.ts src/providers/antigravity-gui.test.ts src/providers/antigravity-gui-client.test.ts src/providers/antigravity-history-db.test.ts src/providers/antigravity-history-protobuf.test.ts src/cli-antigravity.test.ts
node --test skills/tokenboard/scripts/*.test.mjs
pnpm test
pnpm typecheck
pnpm build
git diff --check HEAD
```

结果摘要：

- Web device/API/settings 相关测试覆盖新设备 pairing、device-link reconnect、stale code 拒绝、安装命令生成、详情页和撤销路径。
- TokenBoard skill 脚本测试：235 个测试通过。
- Workspace 测试：`packages/usage-core` 7 个、`packages/collector` 236 个、`apps/web` 516 个测试通过。
- Workspace typecheck：全部通过。
- Web build：通过。
- `git diff --check HEAD`：无 whitespace 错误。

已知 warning：

- Web 测试和构建中仍会出现 Node `DEP0205 module.register()` deprecation warning；当前不影响命令退出码，未在本 PR 中处理。

## 真实环境 gate

本记录证明代码、测试和构建已收敛，不等同于生产环境已发布。

合并前后仍应按实际发布流程验证：

- Cloudflare D1 migration 能在目标环境应用成功。
- Worker 部署后 `/api/v1/me`、pairing、ingest、summary、devices 页面可用。
- 本机和目标远程 client 可通过最新 skill 完成 setup / status / sync。
- device-link reconnect 在响应丢失重试、pairing code 过期、设备撤销、安装实例撤销场景下返回稳定错误，不产生新 token。
- macOS/Linux/Windows 生成安装命令在默认分支、显式分支、all-hex 分支名和 raw ref 场景下行为一致。
- 多 server profile 切换不会覆盖其它 server credential。
- 旧 client bearer upload token 仍可 ingest。
- Web UI 移动端和桌面端设备页、安装页、dashboard、日报、公开 SVG / JSON 展示不溢出。
