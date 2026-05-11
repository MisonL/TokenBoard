import assert from 'node:assert/strict'
import test from 'node:test'
import { packageManagerCommand } from './config.mjs'

test('uses bun.exe on Windows package manager commands', () => {
  assert.equal(packageManagerCommand('bun', 'win32'), 'bun.exe')
})

test('uses executable package manager commands on Windows when available', () => {
  assert.equal(packageManagerCommand('pnpm', 'win32'), 'pnpm.exe')
  assert.equal(packageManagerCommand('npm', 'win32'), 'npm.cmd')
})
