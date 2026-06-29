# 设备身份与重连机制验收记录 - 2026-06-30

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
- `device-link` claim 成功换取 reconnect pairing code 后会失效，防止重复使用。
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

## 代码证据

- D1 migration:
  - `apps/web/db/migrations/0022_device_installations.sql`
  - `apps/web/db/migrations/0023_device_install_claim.sql`
- Web / API:
  - `apps/web/app/features/device/service.ts`
  - `apps/web/app/features/device/repository.ts`
  - `apps/web/app/routes/api/v1/device/reconnect-pairing-codes.ts`
  - `apps/web/app/routes/settings/devices.tsx`
- Client / skill:
  - `skills/tokenboard/scripts/config.mjs`
  - `skills/tokenboard/scripts/setup.mjs`
  - `skills/tokenboard/scripts/setup-options.mjs`
  - `skills/tokenboard/scripts/device-link.mjs`
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
pnpm --filter @tokenboard/web exec vitest run app/features/device/service.test.ts app/features/device/repository.test.ts app/routes/api/v1/device/reconnect-pairing-codes.test.ts
node --test skills/tokenboard/scripts/*.test.mjs
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

结果摘要：

- Web device 相关测试：3 个文件、27 个测试通过。
- TokenBoard skill 脚本测试：185 个测试通过。
- Workspace 测试：`packages/usage-core`、`packages/collector`、`apps/web` 全部通过。
- Workspace typecheck：全部通过。
- Web build：通过。
- `git diff --check`：无 whitespace 错误。

已知 warning：

- Web 测试和构建中仍会出现 Node `DEP0205 module.register()` deprecation warning；当前不影响命令退出码，未在本 PR 中处理。

## PR 状态

- PR: https://github.com/evepupil/TokenBoard/pull/19
- 状态：open，mergeable。
- GitGuardian Security Checks：通过。
- 当前没有 reviewer 评论或阻塞 review。

## 真实环境 gate

本记录证明代码、测试、构建和 PR gate 已收敛，不等同于生产环境已发布。

合并前后仍应按实际发布流程验证：

- Cloudflare D1 migration 能在目标环境应用成功。
- Worker 部署后 `/api/v1/me`、pairing、ingest、summary、devices 页面可用。
- 本机和目标远程 client 可通过最新 skill 完成 setup / status / sync。
- 多 server profile 切换不会覆盖其它 server credential。
- 旧 client bearer upload token 仍可 ingest。
- Web UI 移动端和桌面端设备页、安装页、dashboard、日报、公开 SVG / JSON 展示不溢出。
