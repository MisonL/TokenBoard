# Collector Since Window Verification - 2026-07-16

## 范围

本记录覆盖 collector 的 `--since` 跨来源传递、环境变量优先级、hook 增量窗口和 Codex session 预筛选日期边界。

## 修复结论

- 显式 `--since` 同时传递给 Claude Code、Codex 和三类 Antigravity collector。
- 空的 `TOKENBOARD_SINCE` 在 CLI 和直接 provider 调用中都不再遮蔽 `TOKENBOARD_DEFAULT_SINCE`。
- 显式 `since: all` 保持全量扫描语义，不作为 ccusage 的日期参数下传。
- Claude Code 和 Codex hook 模式忽略外部全量窗口，继续按变化事件日期执行窄范围 reconciliation。
- Codex session scope 仅作为时区无关的保守预筛选，日期边界前后各保留一个 UTC 日，由 ccusage 执行最终本地日期过滤。
- Codex 和三类 Antigravity 日期过滤器都接受 `YYYYMMDD` 或 `YYYY-MM-DD`，并拒绝畸形格式和不存在的日历日期。

## 验证命令

```bash
pnpm --filter @tokenboard/collector exec vitest run src/cli-antigravity.test.ts src/providers/claude-code.test.ts src/providers/claude-hook-sync.test.ts src/providers/hook-sync.test.ts
pnpm --filter @tokenboard/collector exec vitest run src/providers/codex-session-scope.test.ts src/providers/codex.test.ts
pnpm --filter @tokenboard/collector exec vitest run src/providers/antigravity-since.test.ts src/cli-antigravity.test.ts
pnpm --filter @tokenboard/collector test
pnpm --filter @tokenboard/web test
node --test skills/tokenboard/scripts/*.test.mjs
pnpm test
pnpm typecheck
pnpm build
git diff HEAD --check
```

## 结果

- Antigravity 日期格式、默认窗口与跨来源传递目标测试：46 个通过。
- Codex scope 与 provider 目标测试：18 个通过。
- `packages/usage-core`：9 个测试通过。
- `packages/collector`：364 个测试通过。
- `apps/web`：567 个测试通过。
- Skill scripts：310 个测试通过。
- Workspace typecheck：通过。
- Web production build：通过。
- Git whitespace 检查：通过。

## 边界

本记录验证本地代码、自动化测试和构建，不代表已执行生产上传、Cloudflare 部署或真实 ccusage 历史重放。
