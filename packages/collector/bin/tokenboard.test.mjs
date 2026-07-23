import { expect, test } from 'vitest'
import { buildInvocation } from './tokenboard.mjs'

test('builds bun invocation with bun x tsx', () => {
  expect(
    buildInvocation({ packageManager: 'bun', platform: 'darwin', passthroughArgs: ['preview'] }),
  ).toEqual({
    command: 'bun',
    args: ['x', 'tsx', 'src/cli.ts', 'preview']
  })
})

test('uses bun.exe on Windows', () => {
  expect(
    buildInvocation({ packageManager: 'bun', platform: 'win32', passthroughArgs: ['sync'] }),
  ).toEqual({
    command: 'bun.exe',
    args: ['x', 'tsx', 'src/cli.ts', 'sync']
  })
})
