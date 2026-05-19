import { renderToString } from 'hono/jsx/dom/server'
import { describe, expect, test } from 'vitest'
import { createInstallPrompt, InstallCommand } from './install-command'

describe('InstallCommand', () => {
  test('renders a copy action for the generated install prompt', async () => {
    const html = await renderToString(
      <InstallCommand
        baseUrl="https://tokenboard.example"
        timezone="Asia/Shanghai"
        pairingCode="pair_123"
        expiresAt="2026-04-29T18:00:00.000Z"
      />
    )

    expect(html).toContain('data-copy-target="install-prompt-text"')
    expect(html).toContain('aria-label="复制安装提示词"')
    expect(html).toContain('skills/tokenboard/scripts/setup.mjs')
  })

  test('generates a direct shell-oriented prompt that discourages browser detours', () => {
    const prompt = createInstallPrompt(
      'https://tokenboard.example',
      'Asia/Shanghai',
      'pair_123'
    )

    expect(prompt).toContain('不要使用浏览器、Playwright、网页抓取、fetch 或 curl')
    expect(prompt).toContain('首次安装默认执行全量同步')
    expect(prompt).toContain('不要擅自改成最近 7 天窗口')
    expect(prompt).toContain('TOKENBOARD_CODEX_BATCH_SIZE=200')
    expect(prompt).toContain('$env:TOKENBOARD_CODEX_BATCH_SIZE = "200"')
    expect(prompt).toContain('只有用户明确要求跳过首次同步')
    expect(prompt).toContain("git clone 'https://github.com/evepupil/TokenBoard.git'")
    expect(prompt).toContain('git -C "$repo" pull --ff-only')
    expect(prompt).toContain('skills/tokenboard/scripts/setup.mjs')
    expect(prompt).toContain("--pairing-code 'pair_123'")
    expect(prompt).toContain("--base-url 'https://tokenboard.example'")
    expect(prompt).toContain("--timezone 'Asia/Shanghai'")
    expect(prompt).not.toContain('从这个 GitHub repo 路径安装')
    expect(prompt).not.toContain('node scripts/setup.mjs')
  })

  test('escapes install prompt command arguments for shells', () => {
    const prompt = createInstallPrompt(
      'https://tokenboard.example/a b',
      'Asia/Shanghai";Write-Host $env:USER',
      "pair_'123"
    )

    expect(prompt).toContain("--pairing-code 'pair_'\\''123'")
    expect(prompt).toContain("--base-url 'https://tokenboard.example/a b'")
    expect(prompt).toContain('--timezone \'Asia/Shanghai";Write-Host $env:USER\'')
    expect(prompt).toContain('--pairing-code "pair_\'123"')
    expect(prompt).toContain('--timezone "Asia/Shanghai`";Write-Host `$env:USER"')
  })
})
